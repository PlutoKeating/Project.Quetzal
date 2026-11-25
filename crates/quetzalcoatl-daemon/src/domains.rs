#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]

//! 领域包守护进程运行时：装载内置五大领域包、持久化每 Agent 活动包与切换审计，
//! 默认回落 `personal-companion`，从不改变未选择领域包的 Agent 既有行为。

use std::fs;
use std::path::{Path, PathBuf};

use quetzalcoatl_domains::{
    ConscienceSeed, DomainPack, DomainPackId, DomainPackRegistry, PackSwitchAudit,
    SafetyEnvelopePayload, VerifierRule,
};
use quetzalcoatl_types::{AgentId, QuetzalcoatlError, Result};
use serde::{Deserialize, Serialize};

/// 领域包活动绑定状态文件（相对 `QUETZALCOATL_HOME`）。
pub const DOMAIN_STATE_FILE: &str = "domains/active.json";

/// 领域包摘要（`qz domain list` 的行视图）。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DomainPackSummary {
    pub id: String,
    pub version: String,
    pub display_name: String,
    pub description: String,
    pub locales: Vec<String>,
    pub active: bool,
    pub guardian_label: String,
    pub verifier_rule_kinds: Vec<String>,
}

/// 领域包完整视图（`qz domain show <id>`）。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DomainPackView {
    pub summary: DomainPackSummary,
    pub role_tool_whitelist: Vec<String>,
    pub required_capabilities: Vec<String>,
    pub required_sinks: Vec<String>,
    pub conscience_seed: ConscienceSeed,
    pub verifier_rules: Vec<VerifierRule>,
    pub envelope: SafetyEnvelopePayload,
}

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct PersistedDomainState {
    active_pack_id: Option<String>,
    #[serde(default)]
    audit: Vec<PackSwitchAudit>,
}

/// 领域包运行时（单实例守护进程内唯一权威）。
#[derive(Clone, Debug)]
pub struct DomainRuntime {
    registry: DomainPackRegistry,
    agent_id: AgentId,
    state_path: PathBuf,
}

impl DomainRuntime {
    /// 从 `QUETZALCOATL_HOME/domains/active.json` 恢复或初始化。
    pub fn load_or_init(qz_home: &Path, agent_id: AgentId) -> Result<Self> {
        let dir = qz_home.join("domains");
        fs::create_dir_all(&dir).map_err(|e| QuetzalcoatlError::StorageError {
            detail: format!("创建 domains 目录失败 ({}): {e}", dir.display()),
        })?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&dir, fs::Permissions::from_mode(0o700));
        }

        let mut registry = DomainPackRegistry::with_builtin_packs()?;
        let state_path = dir.join("active.json");
        if let Ok(raw) = fs::read_to_string(&state_path)
            && let Ok(persisted) = serde_json::from_str::<PersistedDomainState>(&raw)
        {
            if let Some(id) = persisted.active_pack_id.as_deref()
                && let Ok(pack_id) = DomainPackId::parse(id)
            {
                // 已下线的领域包静默回落到默认包（不影响守护进程启动）
                let _ = registry.restore_agent_binding(agent_id, &pack_id);
            }
            for entry in persisted.audit {
                registry.restore_audit(entry);
            }
        }

        Ok(Self {
            registry,
            agent_id,
            state_path,
        })
    }

    #[must_use]
    pub fn registry(&self) -> &DomainPackRegistry {
        &self.registry
    }

    #[must_use]
    pub fn agent_id(&self) -> AgentId {
        self.agent_id
    }

    #[must_use]
    pub fn active_pack_id(&self) -> String {
        self.registry.active_pack_id(self.agent_id)
    }

    #[must_use]
    pub fn list(&self) -> Vec<DomainPackSummary> {
        let active = self.active_pack_id();
        self.registry
            .list()
            .into_iter()
            .map(|pack| summarize(pack, active.as_str()))
            .collect()
    }

    pub fn show(&self, id: &str) -> Result<DomainPackView> {
        let pack_id = DomainPackId::parse(id)?;
        let pack = self.registry.get(&pack_id)?;
        Ok(DomainPackView {
            summary: summarize(pack, self.active_pack_id().as_str()),
            role_tool_whitelist: pack.role_tool_whitelist.clone(),
            required_capabilities: pack.required_capabilities.clone(),
            required_sinks: pack.required_sinks.clone(),
            conscience_seed: pack.conscience_seed.clone(),
            verifier_rules: pack.verifier_rules.clone(),
            envelope: pack.safety_envelope.payload.clone(),
        })
    }

    /// 切换活动领域包：写审计并原子持久化。
    pub fn use_pack(&mut self, id: &str, at_ms: u64, reason: &str) -> Result<PackSwitchAudit> {
        let pack_id = DomainPackId::parse(id)?;
        let audit = self
            .registry
            .use_pack(self.agent_id, &pack_id, at_ms, reason)?;
        self.persist()?;
        Ok(audit)
    }

    #[must_use]
    pub fn audit_log(&self) -> Vec<PackSwitchAudit> {
        self.registry.audit_log().to_vec()
    }

    fn persist(&self) -> Result<()> {
        let state = PersistedDomainState {
            active_pack_id: Some(self.active_pack_id()),
            audit: self.registry.audit_log().to_vec(),
        };
        let body = serde_json::to_vec_pretty(&state).map_err(|e| {
            QuetzalcoatlError::SerializationError {
                detail: format!("序列化领域包活动状态失败: {e}"),
            }
        })?;
        let tmp = self.state_path.with_extension("json.tmp");
        fs::write(&tmp, body).map_err(|e| QuetzalcoatlError::StorageError {
            detail: format!("写入领域包活动状态失败 ({}): {e}", tmp.display()),
        })?;
        fs::rename(&tmp, &self.state_path).map_err(|e| QuetzalcoatlError::StorageError {
            detail: format!(
                "原子替换领域包活动状态失败 ({}): {e}",
                self.state_path.display()
            ),
        })?;
        Ok(())
    }
}

fn summarize(pack: &DomainPack, active_pack_id: &str) -> DomainPackSummary {
    let mut kinds: Vec<String> = pack
        .verifier_rules
        .iter()
        .map(|r| String::from(r.kind_str()))
        .collect();
    kinds.sort();
    kinds.dedup();
    DomainPackSummary {
        id: pack.id.clone(),
        version: pack.version.clone(),
        display_name: pack.display_name.clone(),
        description: pack.description.clone(),
        locales: pack.locales.clone(),
        active: pack.id == active_pack_id,
        guardian_label: pack.safety_envelope.payload.guardian_label.clone(),
        verifier_rule_kinds: kinds,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::error::Error;
    use uuid::Uuid;

    type TestResult = std::result::Result<(), Box<dyn Error>>;

    fn temp_home(tag: &str) -> PathBuf {
        let base = PathBuf::from("/tmp/opencode");
        let parent = if base.is_dir() {
            base
        } else {
            std::env::temp_dir()
        };
        let path = parent.join(format!("qz_domain_rt_{tag}_{}", Uuid::new_v4().simple()));
        let _ = fs::create_dir_all(&path);
        path
    }

    #[test]
    fn defaults_to_personal_companion_and_persists_switch_with_audit() -> TestResult {
        let home = temp_home("persist");
        let agent = AgentId::new_v4();
        let mut runtime = DomainRuntime::load_or_init(&home, agent)?;
        assert_eq!(runtime.active_pack_id(), "personal-companion");
        assert_eq!(runtime.list().len(), 5);
        assert!(runtime.audit_log().is_empty());

        let audit = runtime.use_pack("eldercare-guardian", 1_795_400_000_000, "为长辈启用看护")?;
        assert_eq!(audit.from_pack_id, "personal-companion");
        assert_eq!(audit.to_pack_id, "eldercare-guardian");
        assert!(
            runtime
                .list()
                .iter()
                .any(|p| p.id == "eldercare-guardian" && p.active)
        );

        // 重新加载必须恢复绑定与审计
        let reloaded = DomainRuntime::load_or_init(&home, agent)?;
        assert_eq!(reloaded.active_pack_id(), "eldercare-guardian");
        assert_eq!(reloaded.audit_log().len(), 1);
        assert_eq!(reloaded.audit_log()[0].to_pack_id, "eldercare-guardian");

        // 未知领域包必须类型化报错且不产生副作用
        let unknown = reloaded
            .show("no-such-domain")
            .err()
            .ok_or("未知领域包必须报错")?;
        assert_eq!(unknown.code().as_str(), "INVALID_ID");
        assert_eq!(reloaded.active_pack_id(), "eldercare-guardian");

        let view = reloaded.show("eldercare-guardian")?;
        assert!(view.envelope.emergency.bypass_sleep_inhibition);
        assert!(!view.envelope.immutable_fields.is_empty());
        assert!(view.summary.active);
        assert!(
            view.verifier_rules
                .iter()
                .any(|r| r.kind_str() == "competence_boundary")
        );

        let _ = fs::remove_dir_all(&home);
        Ok(())
    }
}
