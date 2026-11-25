#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]

//! 领域包守护进程运行时：装载内置五大领域包、持久化每 Agent 活动包与切换审计，
//! 并把每次真实切换同时写入本地状态文件与状态脊柱签名 HLC 事件（可检测篡改/回滚）。
//!
//! 默认回落 `personal-companion`，从不改变未选择领域包的 Agent 既有行为。

use std::fs;
use std::path::{Path, PathBuf};

use quetzalcoatl_crypto::PackCompartment;
use quetzalcoatl_domains::{
    ConscienceSeed, DomainPack, DomainPackId, DomainPackRegistry, PackSwitchAudit,
    PackSwitchOutcome, SafetyEnvelopePayload, VerifierRule,
};
use quetzalcoatl_spine::{MaterializedStore, SpineEngine};
use quetzalcoatl_types::{AgentId, QuetzalcoatlError, Result};
use serde::{Deserialize, Serialize};

/// 领域包活动绑定状态文件（相对 `QUETZALCOATL_HOME`）。
pub const DOMAIN_STATE_FILE: &str = "domains/active.json";
/// 领域包切换审计的脊柱事件 schema。
pub const DOMAIN_AUDIT_SCHEMA: &str = "quetzalcoatl.domain.audit.v1";

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

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct PersistedDomainState {
    active_pack_id: Option<String>,
    #[serde(default)]
    audit: Vec<PackSwitchAudit>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SpineAuditPayload {
    schema: String,
    kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    audit: Option<PackSwitchAudit>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    detail: Option<String>,
}

/// 领域包运行时（单实例守护进程内唯一权威）。
#[derive(Clone, Debug)]
pub struct DomainRuntime {
    registry: DomainPackRegistry,
    agent_id: AgentId,
    state_path: PathBuf,
    repair_report: Option<String>,
}

impl DomainRuntime {
    /// 从 `QUETZALCOATL_HOME/domains/active.json` + 状态脊柱签名事件恢复或初始化。
    ///
    /// 本地文件与脊柱签名事件不一致（篡改 / 回滚 / 删除）时，**以脊柱为准重建**并
    /// 追加一条 `audit_repaired` 签名事件留痕。
    pub fn load_or_init<S: MaterializedStore>(
        qz_home: &Path,
        agent_id: AgentId,
        spine: &mut SpineEngine<S>,
    ) -> Result<Self> {
        let dir = qz_home.join("domains");
        fs::create_dir_all(&dir).map_err(|e| QuetzalcoatlError::StorageError {
            detail: format!("创建 domains 目录失败 ({}): {e}", dir.display()),
        })?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&dir, fs::Permissions::from_mode(0o700));
        }

        let registry = DomainPackRegistry::with_builtin_packs()?;
        let state_path = dir.join("active.json");
        let persisted: Option<PersistedDomainState> = fs::read_to_string(&state_path)
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok());
        let spine_audits = load_switch_audits(spine, agent_id)?;

        let spine_last = spine_audits.last().cloned();
        let expected_active = spine_last
            .as_ref()
            .map(|a| a.to_pack_id.clone())
            .unwrap_or_else(|| String::from(registry.default_pack_id()));
        let file_matches_spine = persisted.as_ref().is_some_and(|state| {
            state.audit.last().cloned() == spine_last
                && state.active_pack_id.as_deref() == Some(expected_active.as_str())
        });

        let mut runtime = Self {
            registry,
            agent_id,
            state_path,
            repair_report: None,
        };

        if file_matches_spine {
            if let Some(state) = persisted {
                if let Some(id) = state.active_pack_id.as_deref()
                    && let Ok(pack_id) = DomainPackId::parse(id)
                {
                    let _ = runtime.registry.restore_agent_binding(agent_id, &pack_id);
                }
                for entry in state.audit {
                    runtime.registry.restore_audit(entry);
                }
            }
            return Ok(runtime);
        }

        // 无本地文件也无脊柱事件：全新 Agent，不产生任何修复噪声
        if persisted.is_none() && spine_last.is_none() {
            return Ok(runtime);
        }

        for entry in &spine_audits {
            runtime.registry.restore_audit(entry.clone());
        }
        if let Ok(pack_id) = DomainPackId::parse(&expected_active) {
            let _ = runtime.registry.restore_agent_binding(agent_id, &pack_id);
        }
        let detail = format!(
            "本地领域包状态与脊柱签名事件不一致，已按脊柱重建（spine_events={}, local_file_present={}）",
            spine_audits.len(),
            persisted.is_some()
        );
        let now_ms = spine.local_hlc().wall_ms();
        append_repair_event(spine, agent_id, &detail, now_ms)?;
        runtime.persist()?;
        runtime.repair_report = Some(detail);
        Ok(runtime)
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

    /// 上次加载时若发生"按脊柱重建"，返回修复说明（供 CLI 显示）。
    #[must_use]
    pub fn repair_report(&self) -> Option<&str> {
        self.repair_report.as_deref()
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

    /// 切换活动领域包：真实切换 → 先写脊柱签名事件再原子落盘；重复切换 → 幂等空操作。
    pub fn use_pack<S: MaterializedStore>(
        &mut self,
        id: &str,
        at_ms: u64,
        reason: &str,
        spine: &mut SpineEngine<S>,
    ) -> Result<PackSwitchOutcome> {
        let pack_id = DomainPackId::parse(id)?;
        let outcome =
            self.registry
                .use_pack_as(self.agent_id, &pack_id, at_ms, reason, "quetzalcoatld")?;
        if let PackSwitchOutcome::Activated(audit) = &outcome {
            append_switch_event(spine, audit)?;
            self.persist()?;
        }
        Ok(outcome)
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

fn append_switch_event<S: MaterializedStore>(
    spine: &mut SpineEngine<S>,
    audit: &PackSwitchAudit,
) -> Result<()> {
    let payload = SpineAuditPayload {
        schema: String::from(DOMAIN_AUDIT_SCHEMA),
        kind: String::from("pack_switched"),
        audit: Some(audit.clone()),
        detail: None,
    };
    let encoded =
        serde_json::to_string(&payload).map_err(|e| QuetzalcoatlError::SerializationError {
            detail: format!("编码领域包切换审计事件失败: {e}"),
        })?;
    let _ = spine.append_event(PackCompartment::Core, &encoded, audit.at_ms)?;
    Ok(())
}

fn append_repair_event<S: MaterializedStore>(
    spine: &mut SpineEngine<S>,
    agent_id: AgentId,
    detail: &str,
    at_ms: u64,
) -> Result<()> {
    let payload = SpineAuditPayload {
        schema: String::from(DOMAIN_AUDIT_SCHEMA),
        kind: String::from("audit_repaired"),
        audit: None,
        detail: Some(format!("{detail} (agent={agent_id})")),
    };
    let encoded =
        serde_json::to_string(&payload).map_err(|e| QuetzalcoatlError::SerializationError {
            detail: format!("编码领域包审计修复事件失败: {e}"),
        })?;
    let _ = spine.append_event(PackCompartment::Core, &encoded, at_ms)?;
    Ok(())
}

fn load_switch_audits<S: MaterializedStore>(
    spine: &SpineEngine<S>,
    agent_id: AgentId,
) -> Result<Vec<PackSwitchAudit>> {
    let events = spine.store().list_all_events()?;
    let mut audits = Vec::new();
    for (event, _) in events {
        let Ok(payload) = serde_json::from_str::<SpineAuditPayload>(&event.payload_utf8) else {
            continue;
        };
        if payload.schema != DOMAIN_AUDIT_SCHEMA {
            continue;
        }
        if let Some(audit) = payload.audit
            && audit.agent_id == agent_id
        {
            audits.push(audit);
        }
    }
    Ok(audits)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::error::Error;

    use quetzalcoatl_crypto::{AccountRootKey, DeviceIdentity, EpochKeyRing};
    use quetzalcoatl_spine::RusqliteWalStore;
    use quetzalcoatl_types::{DeviceId, HlcTimestamp};
    use serde_json::Value;

    type TestResult = std::result::Result<(), Box<dyn Error>>;

    const NOW_MS: u64 = 1_795_400_000_000;

    fn temp_home(tag: &str) -> PathBuf {
        let base = PathBuf::from("/tmp/opencode");
        let parent = if base.is_dir() {
            base
        } else {
            std::env::temp_dir()
        };
        let path = parent.join(format!(
            "qz_domain_rt_{tag}_{}",
            uuid::Uuid::new_v4().simple()
        ));
        let _ = fs::create_dir_all(&path);
        path
    }

    fn temp_spine(
        home: &Path,
    ) -> std::result::Result<SpineEngine<RusqliteWalStore>, Box<dyn Error>> {
        let agent_id = AgentId::new_v4();
        let root_key = AccountRootKey::from_bytes([0x3cu8; 32]);
        let device = DeviceIdentity::from_seeds(DeviceId::new_v4(), [0x11u8; 32], [0x22u8; 32])?;
        let epoch_ring = EpochKeyRing::new_genesis(agent_id, &root_key, device.public_record())?;
        let store = RusqliteWalStore::open(&home.join("spine.sqlite"))?;
        Ok(SpineEngine::new(
            agent_id,
            device,
            epoch_ring,
            HlcTimestamp::from_parts(NOW_MS, 0, 1),
            store,
        )?)
    }

    fn switch_event_count(spine: &SpineEngine<RusqliteWalStore>) -> usize {
        spine
            .store()
            .list_all_events()
            .map(|events| {
                events
                    .iter()
                    .filter(|(ev, _)| ev.payload_utf8.contains("pack_switched"))
                    .count()
            })
            .unwrap_or(0)
    }

    #[test]
    fn defaults_to_personal_companion_and_persists_switch_with_audit() -> TestResult {
        let home = temp_home("persist");
        let agent = AgentId::new_v4();
        let mut spine = temp_spine(&home)?;
        let mut runtime = DomainRuntime::load_or_init(&home, agent, &mut spine)?;
        assert_eq!(runtime.active_pack_id(), "personal-companion");
        assert_eq!(runtime.list().len(), 5);
        assert!(runtime.audit_log().is_empty());
        assert!(runtime.repair_report().is_none());

        let outcome =
            runtime.use_pack("eldercare-guardian", NOW_MS, "为长辈启用看护", &mut spine)?;
        let PackSwitchOutcome::Activated(audit) = outcome else {
            return Err("首次切换必须返回 Activated".into());
        };
        assert_eq!(audit.from_pack_id, "personal-companion");
        assert_eq!(audit.to_pack_id, "eldercare-guardian");
        assert_eq!(audit.actor, "quetzalcoatld");
        assert!(
            runtime
                .list()
                .iter()
                .any(|p| p.id == "eldercare-guardian" && p.active)
        );
        assert_eq!(switch_event_count(&spine), 1);

        // 重复切换：Unchanged，既不加审计也不追加脊柱事件
        let noop = runtime.use_pack("eldercare-guardian", NOW_MS + 1, "重复", &mut spine)?;
        assert!(matches!(noop, PackSwitchOutcome::Unchanged { .. }));
        assert_eq!(runtime.audit_log().len(), 1);
        assert_eq!(switch_event_count(&spine), 1);

        // 重新加载必须恢复绑定与审计
        let reloaded = DomainRuntime::load_or_init(&home, agent, &mut spine)?;
        assert_eq!(reloaded.active_pack_id(), "eldercare-guardian");
        assert_eq!(reloaded.audit_log().len(), 1);
        assert_eq!(reloaded.audit_log()[0].to_pack_id, "eldercare-guardian");
        assert!(reloaded.repair_report().is_none());

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

    #[test]
    fn tampered_audit_file_is_repaired_from_signed_spine_events() -> TestResult {
        let home = temp_home("tamper");
        let agent = AgentId::new_v4();
        let mut spine = temp_spine(&home)?;
        let mut runtime = DomainRuntime::load_or_init(&home, agent, &mut spine)?;
        runtime.use_pack("eldercare-guardian", NOW_MS, "启用看护", &mut spine)?;

        // 本地改造：把活动包与最后一条审计都篡改为 software-engineering
        let state_path = home.join(DOMAIN_STATE_FILE);
        let mut value: Value = serde_json::from_str(&fs::read_to_string(&state_path)?)?;
        value["activePackId"] = Value::String(String::from("software-engineering"));
        if let Some(last) = value["audit"]
            .as_array_mut()
            .and_then(|audits| audits.last_mut())
        {
            last["toPackId"] = Value::String(String::from("software-engineering"));
        }
        fs::write(&state_path, serde_json::to_vec_pretty(&value)?)?;

        let repaired = DomainRuntime::load_or_init(&home, agent, &mut spine)?;
        assert_eq!(
            repaired.active_pack_id(),
            "eldercare-guardian",
            "本地审计被篡改时必须按脊柱签名事件重建，而非采信文件"
        );
        assert_eq!(repaired.audit_log().len(), 1);
        assert_eq!(repaired.audit_log()[0].to_pack_id, "eldercare-guardian");
        let report = repaired.repair_report().ok_or("必须记录审计修复事实")?;
        assert!(report.contains("spine") || report.contains("脊柱"));

        // 修复结果必须落盘：再次加载不再需要修复
        let stable = DomainRuntime::load_or_init(&home, agent, &mut spine)?;
        assert_eq!(stable.active_pack_id(), "eldercare-guardian");
        assert!(stable.repair_report().is_none());

        let _ = fs::remove_dir_all(&home);
        Ok(())
    }

    #[test]
    fn lost_audit_file_is_rebuilt_from_signed_spine_events() -> TestResult {
        let home = temp_home("rollback");
        let agent = AgentId::new_v4();
        let mut spine = temp_spine(&home)?;
        let mut runtime = DomainRuntime::load_or_init(&home, agent, &mut spine)?;
        runtime.use_pack("eldercare-guardian", NOW_MS, "启用看护", &mut spine)?;
        runtime.use_pack(
            "regulated-professional",
            NOW_MS + 1,
            "切换到合规",
            &mut spine,
        )?;
        assert_eq!(switch_event_count(&spine), 2);

        // 回滚：删除本地状态文件（模拟被旧备份覆盖 / 手工删除）
        fs::remove_file(home.join(DOMAIN_STATE_FILE))?;

        let repaired = DomainRuntime::load_or_init(&home, agent, &mut spine)?;
        assert_eq!(
            repaired.active_pack_id(),
            "regulated-professional",
            "本地状态丢失时必须从脊柱恢复最新活动包"
        );
        assert_eq!(repaired.audit_log().len(), 2);
        assert!(repaired.repair_report().is_some());
        assert!(
            home.join(DOMAIN_STATE_FILE).is_file(),
            "修复结果必须重新落盘"
        );

        let _ = fs::remove_dir_all(&home);
        Ok(())
    }
}
