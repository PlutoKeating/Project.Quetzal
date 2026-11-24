//! 物理隔离（Pitfall #19 / D-19）与 `StewardGrant` 可吊销托管。
//!
//! 一个共享角色 Agent 实例只能绑定一个群信任域；不同保密等级的群必须孵化独立实例。
//! 协管权限绑定 `openmls` 成员身份，踢出群即刻吊销并强制轮换 `EpochKey[e+1]`。

use std::collections::BTreeMap;

use quetzalcoatl_crypto::hex_encode;
use quetzalcoatl_types::{AgentId, QuetzalcoatlError, Result};

/// 群信任域（物理隔离单位）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GroupTrustDomain {
    pub group_id: String,
    pub secrecy_level: u8,
}

/// 共享角色 Agent 实例的信任域绑定。
#[derive(Clone, Debug)]
pub struct SharedRoleAgentBinding {
    agent_id: AgentId,
    bound_secrecy_level: u8,
    bound_domain: Option<GroupTrustDomain>,
}

impl SharedRoleAgentBinding {
    #[must_use]
    pub fn new(agent_id: AgentId, default_secrecy_level: u8) -> Self {
        Self {
            agent_id,
            bound_secrecy_level: default_secrecy_level,
            bound_domain: None,
        }
    }

    #[must_use]
    pub const fn agent_id(&self) -> AgentId {
        self.agent_id
    }

    #[must_use]
    pub fn bound_domain(&self) -> Option<&GroupTrustDomain> {
        self.bound_domain.as_ref()
    }

    /// 绑定到唯一群信任域；跨群或擅自提升保密等级一律拒绝。
    pub fn bind(&mut self, domain: GroupTrustDomain) -> Result<()> {
        if domain.group_id.trim().is_empty() {
            return Err(QuetzalcoatlError::invalid_id(
                "GroupTrustDomain",
                "群 ID 不能为空",
            ));
        }
        if let Some(current) = &self.bound_domain {
            if current.group_id != domain.group_id {
                return Err(QuetzalcoatlError::PermissionDenied {
                    detail: format!(
                        "D-19: 共享角色实例 {} 已绑定群 {}，禁止再加入第二个群信任域 {}",
                        self.agent_id, current.group_id, domain.group_id
                    ),
                });
            }
            if domain.secrecy_level != self.bound_secrecy_level {
                return Err(QuetzalcoatlError::ConscienceViolation {
                    detail: format!(
                        "D-19: 群 {} 保密等级不得从 {} 变更为 {}",
                        domain.group_id, self.bound_secrecy_level, domain.secrecy_level
                    ),
                });
            }
            return Ok(());
        }
        if domain.secrecy_level != self.bound_secrecy_level {
            return Err(QuetzalcoatlError::ConscienceViolation {
                detail: format!(
                    "D-19: 实例 {} 初始化保密等级为 {}，不能绑定保密等级 {} 的群 {}",
                    self.agent_id, self.bound_secrecy_level, domain.secrecy_level, domain.group_id
                ),
            });
        }
        self.bound_domain = Some(domain);
        Ok(())
    }
}

/// 绑定 `openmls` 成员身份的可吊销协管授权。
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct StewardGrant {
    pub grant_id: String,
    pub group_id: String,
    pub steward_agent_id: AgentId,
    pub mls_identity: Vec<u8>,
    pub granted_by: AgentId,
    pub epoch_at_grant: u64,
    pub granted_at_ms: u64,
    pub revoked_at_ms: Option<u64>,
}

impl StewardGrant {
    pub fn new(
        group_id: impl Into<String>,
        steward_agent_id: AgentId,
        mls_identity: Vec<u8>,
        granted_by: AgentId,
        epoch_at_grant: u64,
        granted_at_ms: u64,
    ) -> Result<Self> {
        let group_id = group_id.into();
        if group_id.trim().is_empty() || mls_identity.is_empty() {
            return Err(QuetzalcoatlError::invalid_id(
                "StewardGrant",
                "群 ID 与 MLS 成员身份均不能为空",
            ));
        }
        Ok(Self {
            grant_id: format!("steward-{}", uuid::Uuid::new_v4()),
            group_id,
            steward_agent_id,
            mls_identity,
            granted_by,
            epoch_at_grant,
            granted_at_ms,
            revoked_at_ms: None,
        })
    }

    #[must_use]
    pub fn is_active(&self) -> bool {
        self.revoked_at_ms.is_none()
    }

    #[must_use]
    pub fn identity_fingerprint(&self) -> String {
        let digest = blake3::hash(&self.mls_identity);
        hex_encode(&digest.as_bytes()[..16])
    }
}

/// 吊销结果：管理权立即失效，并要求轮换至 `EpochKey[e+1]`。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StewardRevocation {
    pub grant_id: String,
    pub revoked_epoch: u64,
    pub rotated_epoch: u64,
    pub dropped_management_rights: bool,
}

/// 协管授权注册表。
#[derive(Clone, Debug, Default)]
pub struct StewardRegistry {
    grants: BTreeMap<String, StewardGrant>,
}

impl StewardRegistry {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    pub fn issue(&mut self, grant: StewardGrant) -> Result<()> {
        if self.grants.contains_key(&grant.grant_id) {
            return Err(QuetzalcoatlError::DeliveryRefused {
                detail: format!("重复的协管授权: {}", grant.grant_id),
            });
        }
        self.grants.insert(grant.grant_id.clone(), grant);
        Ok(())
    }

    #[must_use]
    pub fn get(&self, grant_id: &str) -> Option<&StewardGrant> {
        self.grants.get(grant_id)
    }

    #[must_use]
    pub fn list_all(&self) -> Vec<&StewardGrant> {
        self.grants.values().collect()
    }

    #[must_use]
    pub fn list_for_group(&self, group_id: &str) -> Vec<&StewardGrant> {
        self.grants
            .values()
            .filter(|grant| grant.group_id == group_id)
            .collect()
    }

    /// 判断某 MLS 成员身份当前是否仍持有管理权。
    pub fn has_management_rights(
        &self,
        group_id: &str,
        mls_identity: &[u8],
        now_ms: u64,
    ) -> Result<bool> {
        Ok(self.grants.values().any(|grant| {
            grant.group_id == group_id
                && grant.mls_identity == mls_identity
                && grant.is_active()
                && grant.revoked_at_ms.is_none()
                && now_ms >= grant.granted_at_ms
        }))
    }

    /// 吊销协管授权：立即剥夺管理权，并返回必须轮换到的下一纪元。
    pub fn revoke(
        &mut self,
        grant_id: &str,
        current_epoch: u64,
        now_ms: u64,
    ) -> Result<StewardRevocation> {
        let grant =
            self.grants
                .get_mut(grant_id)
                .ok_or_else(|| QuetzalcoatlError::PermissionDenied {
                    detail: format!("协管授权 {grant_id} 不存在"),
                })?;
        if grant.revoked_at_ms.is_some() {
            return Err(QuetzalcoatlError::PermissionDenied {
                detail: format!("协管授权 {grant_id} 已被吊销"),
            });
        }
        grant.revoked_at_ms = Some(now_ms);
        Ok(StewardRevocation {
            grant_id: grant.grant_id.clone(),
            revoked_epoch: current_epoch,
            rotated_epoch: current_epoch.saturating_add(1),
            dropped_management_rights: true,
        })
    }
}
