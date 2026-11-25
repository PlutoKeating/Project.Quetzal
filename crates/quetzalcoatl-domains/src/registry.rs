#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]

//! 领域包注册表：装载/校验（schema + 监护人签名 + 权威合理性）、按 Agent 解析活动包与切换审计。

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use quetzalcoatl_types::{AgentId, QuetzalcoatlError, Result};
use serde::{Deserialize, Serialize};

use crate::manifest::{DEFAULT_DOMAIN_PACK_ID, DomainPack, DomainPackId, GuardianKey};

/// 已装载并通过监护人签名校验的领域包。
#[derive(Clone, Debug)]
pub struct InstalledPack {
    pack: DomainPack,
    raw_json: String,
}

impl InstalledPack {
    #[must_use]
    pub fn pack(&self) -> &DomainPack {
        &self.pack
    }

    #[must_use]
    pub fn raw_json(&self) -> &str {
        &self.raw_json
    }
}

/// 领域包切换审计记录（每次真实切换必然留痕）。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackSwitchAudit {
    pub agent_id: AgentId,
    pub from_pack_id: String,
    pub to_pack_id: String,
    pub at_ms: u64,
    pub reason: String,
    pub guardian_label: String,
    /// 触发切换的执行者（`agent` / `quetzalcoatld` 等），用于事后追责。
    pub actor: String,
}

/// 领域包切换裁决：真实切换返回审计，重复切换为幂等空操作。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum PackSwitchOutcome {
    Activated(PackSwitchAudit),
    Unchanged { active_pack_id: String },
}

impl PackSwitchOutcome {
    #[must_use]
    pub fn audit(&self) -> Option<&PackSwitchAudit> {
        match self {
            Self::Activated(audit) => Some(audit),
            Self::Unchanged { .. } => None,
        }
    }

    #[must_use]
    pub fn active_pack_id(&self) -> &str {
        match self {
            Self::Activated(audit) => &audit.to_pack_id,
            Self::Unchanged { active_pack_id } => active_pack_id,
        }
    }
}

/// 领域包注册表（1 Agent = 1 活动领域包绑定，未显式选择者默认私人伴生）。
#[derive(Clone, Debug)]
pub struct DomainPackRegistry {
    guardians: BTreeMap<String, GuardianKey>,
    packs: BTreeMap<String, InstalledPack>,
    default_pack_id: String,
    active_by_agent: BTreeMap<AgentId, String>,
    audit: Vec<PackSwitchAudit>,
}

impl DomainPackRegistry {
    #[must_use]
    pub fn new(default_pack_id: DomainPackId) -> Self {
        Self {
            guardians: BTreeMap::new(),
            packs: BTreeMap::new(),
            default_pack_id: default_pack_id.as_str().to_owned(),
            active_by_agent: BTreeMap::new(),
            audit: Vec::new(),
        }
    }

    /// 装载仓库内置的五大标杆领域包（使用仓库内合成演示监护人密钥）。
    pub fn with_builtin_packs() -> Result<Self> {
        let mut registry = Self::new(DomainPackId::parse(DEFAULT_DOMAIN_PACK_ID)?);
        for key in crate::demo_keys::builtin_guardian_keys() {
            registry.trust_guardian(key);
        }
        for (expected_id, raw) in crate::demo_keys::builtin_pack_json() {
            let installed = registry.install_json(raw)?;
            if installed.as_str() != *expected_id {
                return Err(QuetzalcoatlError::IntegrityViolation {
                    detail: format!(
                        "内置领域包目录与清单 ID 不一致：期望 `{expected_id}`，实际 `{installed}`"
                    ),
                });
            }
        }
        registry.require_flagship_packs()?;
        Ok(registry)
    }

    fn require_flagship_packs(&self) -> Result<()> {
        for id in [
            "personal-companion",
            "eldercare-guardian",
            "youth-socratic-tutor",
            "software-engineering",
            "regulated-professional",
        ] {
            let parsed = DomainPackId::parse(id)?;
            self.get(&parsed)?;
        }
        Ok(())
    }

    pub fn trust_guardian(&mut self, key: GuardianKey) {
        self.guardians.insert(key.normalized(), key);
    }

    #[must_use]
    pub fn guardians(&self) -> Vec<&GuardianKey> {
        self.guardians.values().collect()
    }

    /// 从 `pack.json` 原始文本装载并完整校验领域包。
    pub fn install_json(&mut self, raw_json: &str) -> Result<DomainPackId> {
        let pack: DomainPack =
            serde_json::from_str(raw_json).map_err(|e| QuetzalcoatlError::SerializationError {
                detail: format!("解析领域包 JSON 失败: {e}"),
            })?;
        self.install_parsed(pack, String::from(raw_json))
    }

    /// 从已反序列化对象装载（重新序列化后作为原始文本留档）。
    pub fn install_pack_object(&mut self, pack: &DomainPack) -> Result<DomainPackId> {
        let raw_json = serde_json::to_string_pretty(pack).map_err(|e| {
            QuetzalcoatlError::SerializationError {
                detail: format!("序列化领域包对象失败: {e}"),
            }
        })?;
        self.install_parsed(pack.clone(), raw_json)
    }

    fn install_parsed(&mut self, pack: DomainPack, raw_json: String) -> Result<DomainPackId> {
        let id = pack.pack_id()?;
        let body_digest = pack.body_digest_hex()?;
        let (guardian_label, guards_this_document) = {
            let guardian = pack.verify(&self.guardians)?;
            (
                guardian.label.clone(),
                guardian.guards_document(&body_digest),
            )
        };
        if guardian_label.trim().is_empty() {
            return Err(QuetzalcoatlError::IntegrityViolation {
                detail: format!("领域包 `{id}` 的监护人标签不得为空"),
            });
        }
        // 合成演示密钥只信任仓库内置的规范化正文；任何自行拼装的正文都必须由
        // 监护人自持离线密钥重签并 trust_guardian 登记，绝不可借演示密钥背书。
        if !guards_this_document {
            return Err(QuetzalcoatlError::PermissionDenied {
                detail: format!(
                    "领域包 `{id}` 的规范化正文未被监护人 `{guardian_label}` 钉扎授权：合成演示密钥仅信任仓库内置领域包正文，请由监护人自持离线 Ed25519 密钥重签 SafetyEnvelope 并经 trust_guardian 登记公钥"
                ),
            });
        }
        self.packs
            .insert(id.as_str().to_owned(), InstalledPack { pack, raw_json });
        Ok(id)
    }

    /// 从目录批量装载 `<dir>/<id>/pack.json`。
    pub fn load_dir(&mut self, dir: &Path) -> Result<Vec<DomainPackId>> {
        let entries = fs::read_dir(dir).map_err(|e| QuetzalcoatlError::StorageError {
            detail: format!("读取领域包目录失败 ({}): {e}", dir.display()),
        })?;
        let mut found = Vec::<(String, std::path::PathBuf)>::new();
        for entry in entries {
            let entry = entry.map_err(|e| QuetzalcoatlError::StorageError {
                detail: format!("遍历领域包目录失败: {e}"),
            })?;
            let path = entry.path().join("pack.json");
            if path.is_file() {
                found.push((entry.file_name().to_string_lossy().into_owned(), path));
            }
        }
        found.sort_by(|a, b| a.0.cmp(&b.0));

        let mut installed = Vec::with_capacity(found.len());
        for (dirname, path) in found {
            let raw = fs::read_to_string(&path).map_err(|e| QuetzalcoatlError::StorageError {
                detail: format!("读取领域包 {} 失败: {e}", path.display()),
            })?;
            let id = self.install_json(&raw)?;
            if id.as_str() != dirname {
                return Err(QuetzalcoatlError::IntegrityViolation {
                    detail: format!(
                        "领域包目录名 `{dirname}` 与清单 ID `{id}` 不一致（{}）",
                        path.display()
                    ),
                });
            }
            installed.push(id);
        }
        Ok(installed)
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.packs.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.packs.is_empty()
    }

    #[must_use]
    pub fn default_pack_id(&self) -> &str {
        &self.default_pack_id
    }

    /// 按 ID 顺序列出全部已装载领域包。
    #[must_use]
    pub fn list(&self) -> Vec<&DomainPack> {
        self.packs.values().map(InstalledPack::pack).collect()
    }

    #[must_use]
    pub fn ids(&self) -> Vec<DomainPackId> {
        self.packs
            .keys()
            .filter_map(|id| DomainPackId::parse(id).ok())
            .collect()
    }

    pub fn get(&self, id: &DomainPackId) -> Result<&DomainPack> {
        self.packs
            .get(id.as_str())
            .map(InstalledPack::pack)
            .ok_or_else(|| {
                QuetzalcoatlError::invalid_id("DomainPackId", self.unknown_id_detail(id))
            })
    }

    pub fn installed(&self, id: &DomainPackId) -> Result<&InstalledPack> {
        self.packs.get(id.as_str()).ok_or_else(|| {
            QuetzalcoatlError::invalid_id("DomainPackId", self.unknown_id_detail(id))
        })
    }

    pub fn raw_json(&self, id: &DomainPackId) -> Result<&str> {
        Ok(self.installed(id)?.raw_json())
    }

    /// 重新校验全部已装载领域包的签名与正文摘要（运行期防篡改复核）。
    pub fn verify_all(&self) -> Result<usize> {
        for installed in self.packs.values() {
            installed.pack.verify(&self.guardians)?;
        }
        Ok(self.packs.len())
    }

    fn unknown_id_detail(&self, id: &DomainPackId) -> String {
        let available: Vec<&str> = self.packs.keys().map(String::as_str).collect();
        format!("未知领域包 `{id}`；可用领域包: {}", available.join(", "))
    }

    /// 解析某 Agent 当前活动领域包 ID（从未显式选择者回落到默认包）。
    #[must_use]
    pub fn active_pack_id(&self, agent: AgentId) -> String {
        self.active_by_agent
            .get(&agent)
            .cloned()
            .unwrap_or_else(|| self.default_pack_id.clone())
    }

    pub fn active_pack(&self, agent: AgentId) -> Result<&DomainPack> {
        let id = self.active_pack_id(agent);
        self.get(&DomainPackId::parse(&id)?)
    }

    /// 切换某 Agent 的活动领域包并写入审计记录。
    pub fn use_pack(
        &mut self,
        agent: AgentId,
        id: &DomainPackId,
        at_ms: u64,
        reason: impl Into<String>,
    ) -> Result<PackSwitchOutcome> {
        self.use_pack_as(agent, id, at_ms, reason, "agent")
    }

    /// 与 [`Self::use_pack`] 相同，但显式记录执行者（守护进程 / CLI 等）。
    pub fn use_pack_as(
        &mut self,
        agent: AgentId,
        id: &DomainPackId,
        at_ms: u64,
        reason: impl Into<String>,
        actor: impl Into<String>,
    ) -> Result<PackSwitchOutcome> {
        let from_pack_id = self.active_pack_id(agent);
        if from_pack_id == id.as_str() {
            // 幂等空操作：绝不重复签发审计，也不向调用方伪造一次"切换"
            return Ok(PackSwitchOutcome::Unchanged {
                active_pack_id: from_pack_id,
            });
        }
        let guardian_label = self.get(id)?.safety_envelope.payload.guardian_label.clone();
        let audit = PackSwitchAudit {
            agent_id: agent,
            from_pack_id,
            to_pack_id: id.as_str().to_owned(),
            at_ms,
            reason: reason.into(),
            guardian_label,
            actor: actor.into(),
        };
        self.active_by_agent.insert(agent, id.as_str().to_owned());
        self.audit.push(audit.clone());
        Ok(PackSwitchOutcome::Activated(audit))
    }

    /// 从持久化状态恢复 Agent 绑定（不产生新的审计记录）。
    pub fn restore_agent_binding(&mut self, agent: AgentId, id: &DomainPackId) -> Result<()> {
        self.get(id)?;
        self.active_by_agent.insert(agent, id.as_str().to_owned());
        Ok(())
    }

    /// 从持久化状态恢复历史审计记录（严格去重追加）。
    pub fn restore_audit(&mut self, audit: PackSwitchAudit) {
        if !self.audit.contains(&audit) {
            self.audit.push(audit);
        }
    }

    #[must_use]
    pub fn agent_bindings(&self) -> &BTreeMap<AgentId, String> {
        &self.active_by_agent
    }

    #[must_use]
    pub fn audit_log(&self) -> &[PackSwitchAudit] {
        &self.audit
    }
}
