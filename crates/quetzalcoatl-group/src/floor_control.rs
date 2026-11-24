//! ANP-P9 `@addressee / cc / @agents / @humans` 群发言门禁、`max_hops=3` 防刷屏、
//! 非主人消息降权包裹与出站隐私门禁（Pitfall #20）。

use quetzalcoatl_ewave::{Authority, PersonaGrant};
use quetzalcoatl_types::{AgentId, QuetzalcoatlError, Result};

/// 金标准向量约定的 `max_consecutive_agent_hops`。
pub const MAX_CONSECUTIVE_AGENT_HOPS: u32 = 3;
/// 硬静默令牌。
pub const SILENT_TOKEN: &str = "<PASS>";
/// 非主人群内容包裹标签。
pub const UNTRUSTED_GROUP_TAG: &str = "UNTRUSTED";

#[derive(Copy, Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MentionKind {
    Addressee,
    Cc,
    AllAgents,
    AllHumans,
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Mention {
    pub kind: MentionKind,
    pub target_agent_id: Option<AgentId>,
}

#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum SenderKind {
    OwnerHuman,
    OtherHuman,
    PeerAgent,
}

#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum FloorAction {
    Respond,
    RespondStructuredCardOnce,
    SilentPass,
    SilentIngestMemory,
    MuteUntilHumanSpeaks,
    SilentMaxHopsExceeded,
    DeferHumanTyping,
}

impl FloorAction {
    /// 与 `spec/vectors/anp_p9_mentions.json` 完全一致的线格式字符串。
    #[must_use]
    pub const fn as_wire_str(self) -> &'static str {
        match self {
            Self::Respond => "RESPOND",
            Self::RespondStructuredCardOnce => "RESPOND_STRUCTURED_CARD_ONCE",
            Self::SilentPass => "SILENT_PASS",
            Self::SilentIngestMemory => "SILENT_INGEST_MEMORY",
            Self::MuteUntilHumanSpeaks => "MUTE_UNTIL_HUMAN_SPEAKS",
            Self::SilentMaxHopsExceeded => "SILENT_MAX_HOPS_EXCEEDED",
            Self::DeferHumanTyping => "DEFER_HUMAN_TYPING",
        }
    }
}

#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum AuthorityEnvelope {
    OwnerVerified,
    Untrusted,
}

impl AuthorityEnvelope {
    #[must_use]
    pub const fn as_wire_str(self) -> &'static str {
        match self {
            Self::OwnerVerified => "OWNER_VERIFIED",
            Self::Untrusted => "UNTRUSTED",
        }
    }
}

/// 单条群消息的门禁输入。
#[derive(Clone, Debug)]
pub struct FloorInput {
    pub room_id: String,
    pub agent_id: AgentId,
    /// 该 Agent 是否为主人本人的主权实例（只有主人实例可把主人发言计为 `S1/S4`）。
    pub agent_is_owner_instance: bool,
    pub sender_kind: SenderKind,
    pub sender_signature_verified: bool,
    pub mentions: Vec<Mention>,
    pub consecutive_agent_hops: u32,
    pub human_typing_active: bool,
    pub sender_peer_id: String,
    /// 原始消息正文，用于构造带转义的权威包裹。
    pub content: String,
}

/// 门禁判定结果。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FloorDecision {
    pub floor_action: FloorAction,
    pub authority_envelope: AuthorityEnvelope,
    /// 仅 `OWNER_VERIFIED` 可为 `S1`（或主人设备显式指令 `S4`）；非主人一律 `S8`。
    pub ewave_signal_class: &'static str,
    /// 进入良知上下文的包裹正文（非主人内容强制 XML 转义并标记 `UNTRUSTED`）。
    pub wrapped_content: Option<String>,
    pub pass_token: Option<&'static str>,
    pub consecutive_agent_hops_after: u32,
}

impl FloorDecision {
    #[must_use]
    pub const fn next_agent_hops(&self) -> u32 {
        self.consecutive_agent_hops_after
    }
}

/// ANP-P9 群发言门禁（宿主确定性判定，零模型参与）。
#[derive(Clone, Debug)]
pub struct AnpP9FloorGate {
    room_id: String,
    max_hops: u32,
}

impl AnpP9FloorGate {
    #[must_use]
    pub fn new(room_id: impl Into<String>) -> Self {
        Self {
            room_id: room_id.into(),
            max_hops: MAX_CONSECUTIVE_AGENT_HOPS,
        }
    }

    #[must_use]
    pub fn with_max_hops(max_hops: u32) -> Self {
        Self {
            room_id: String::from("room"),
            max_hops,
        }
    }

    #[must_use]
    pub fn room_id(&self) -> &str {
        &self.room_id
    }

    /// 依据金标准向量顺序判定本 Agent 本轮的发言权。
    pub fn evaluate(&self, input: &FloorInput) -> Result<FloorDecision> {
        let owner_verified = input.sender_kind == SenderKind::OwnerHuman
            && input.sender_signature_verified
            && input.agent_is_owner_instance;
        let authority_envelope = if owner_verified {
            AuthorityEnvelope::OwnerVerified
        } else {
            AuthorityEnvelope::Untrusted
        };
        let ewave_signal_class = if owner_verified { "S1" } else { "S8" };
        let wrapped_content = Some(match authority_envelope {
            AuthorityEnvelope::OwnerVerified => format!(
                "<owner_message authority=\"OWNER_VERIFIED\">{}</owner_message>",
                escape_xml(&input.content)
            ),
            AuthorityEnvelope::Untrusted => wrap_untrusted_group_context(&input.content),
        });

        let addressed = input.mentions.iter().any(|mention| {
            mention.kind == MentionKind::Addressee
                && mention.target_agent_id == Some(input.agent_id)
        });
        let has_all_agents = input
            .mentions
            .iter()
            .any(|mention| mention.kind == MentionKind::AllAgents);
        let has_all_humans = input
            .mentions
            .iter()
            .any(|mention| mention.kind == MentionKind::AllHumans);
        let has_cc = input.mentions.iter().any(|mention| {
            mention.kind == MentionKind::Cc && mention.target_agent_id == Some(input.agent_id)
        });

        // 1. Agent 连续发言上限：达到 max_hops 后再被点名必须硬静默并抛出 FLOOR_SILENCED。
        if input.sender_kind == SenderKind::PeerAgent
            && addressed
            && input.consecutive_agent_hops >= self.max_hops
        {
            return Err(QuetzalcoatlError::FloorSilenced {
                detail: format!(
                    "Agent 连续发言已达 {}/{} 跳，硬静默以阻断互刷屏 (room={})",
                    input.consecutive_agent_hops, self.max_hops, self.room_id
                ),
            });
        }

        // 2. 人类正在输入：让人先说话。
        if input.human_typing_active && addressed {
            return Ok(FloorDecision {
                floor_action: FloorAction::DeferHumanTyping,
                authority_envelope,
                ewave_signal_class,
                wrapped_content,
                pass_token: None,
                consecutive_agent_hops_after: input.consecutive_agent_hops,
            });
        }

        // 3. `@humans`：所有 Agent 静音直到人类开口。
        if has_all_humans {
            return Ok(FloorDecision {
                floor_action: FloorAction::MuteUntilHumanSpeaks,
                authority_envelope,
                ewave_signal_class,
                wrapped_content,
                pass_token: None,
                consecutive_agent_hops_after: 0,
            });
        }

        // 4. `cc`：静默写入记忆但绝不回复。
        if has_cc && !addressed {
            return Ok(FloorDecision {
                floor_action: FloorAction::SilentIngestMemory,
                authority_envelope,
                ewave_signal_class,
                wrapped_content,
                pass_token: None,
                consecutive_agent_hops_after: input.consecutive_agent_hops,
            });
        }

        // 5. `@agents`：每个 Agent 本轮恰好一张结构化卡片。
        if has_all_agents {
            return Ok(FloorDecision {
                floor_action: FloorAction::RespondStructuredCardOnce,
                authority_envelope,
                ewave_signal_class,
                wrapped_content,
                pass_token: None,
                consecutive_agent_hops_after: input.consecutive_agent_hops.saturating_add(1),
            });
        }

        // 6. 精确点名：只有被点名的 Agent 应答。
        if addressed {
            return Ok(FloorDecision {
                floor_action: FloorAction::Respond,
                authority_envelope,
                ewave_signal_class,
                wrapped_content,
                pass_token: None,
                consecutive_agent_hops_after: input.consecutive_agent_hops.saturating_add(1),
            });
        }

        // 7. 其余所有人硬静默 `<PASS>`。
        Ok(FloorDecision {
            floor_action: FloorAction::SilentPass,
            authority_envelope,
            ewave_signal_class,
            wrapped_content,
            pass_token: Some(SILENT_TOKEN),
            consecutive_agent_hops_after: 0,
        })
    }
}

/// XML 文本转义（防注入伪造 `authority="OWNER"` 包裹）。
#[must_use]
pub fn escape_xml(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for ch in raw.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            other => out.push(other),
        }
    }
    out
}

/// 将非主人群消息包裹为 `authority="UNTRUSTED"`（只计 `S8`）。
#[must_use]
pub fn wrap_untrusted_group_context(content: &str) -> String {
    format!(
        "<group_room_context authority=\"{UNTRUSTED_GROUP_TAG}\">{}</group_room_context>",
        escape_xml(content)
    )
}

#[derive(Copy, Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PrivateAuthority {
    Memory,
    UserPref,
}

impl PrivateAuthority {
    fn from_authority(authority: Authority) -> Option<Self> {
        match authority {
            Authority::Memory => Some(Self::Memory),
            Authority::UserPref => Some(Self::UserPref),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PrivateReference {
    pub path: String,
    pub authority: Authority,
}

/// 待外发的群文本草稿及其引用的私有状态。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OutboundGroupDraft {
    pub text: String,
    pub references: Vec<PrivateReference>,
}

/// 主人在本群内的显式授权（可撤销、可过期）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OwnerGroupAuthorization {
    pub path: String,
    pub expires_at_ms: Option<u64>,
    pub revoked_at_ms: Option<u64>,
}

impl OwnerGroupAuthorization {
    fn is_active_at(&self, now_ms: u64) -> bool {
        self.revoked_at_ms.is_none() && self.expires_at_ms.is_none_or(|exp| exp > now_ms)
    }

    fn allows(&self, path: &str) -> bool {
        field_pattern_allows(&self.path, path)
    }
}

/// Router 出站隐私门禁：任何未经 `eWave::Grant` 或主人群内显式授权的
/// `MEMORY / USER_PREF` 引用一律拦截（Pitfall #20）。
#[derive(Copy, Clone, Debug, Default)]
pub struct OutboundPrivacyGate;

impl OutboundPrivacyGate {
    pub fn check(
        &self,
        draft: &OutboundGroupDraft,
        grants: &[PersonaGrant],
        owner_authorizations: &[OwnerGroupAuthorization],
        now_ms: u64,
    ) -> Result<()> {
        for reference in &draft.references {
            if PrivateAuthority::from_authority(reference.authority).is_none() {
                continue;
            }
            if reference.path.trim().is_empty() {
                return Err(QuetzalcoatlError::ConscienceViolation {
                    detail: String::from("出站群文本引用了空路径的私有状态"),
                });
            }
            let granted = grants.iter().any(|grant| {
                grant.is_active_at(now_ms)
                    && !grant.touches_forbidden_absolute_field()
                    && grant.allows_field(&reference.path)
            });
            let owner_authorized = owner_authorizations
                .iter()
                .any(|auth| auth.is_active_at(now_ms) && auth.allows(&reference.path));
            if !granted && !owner_authorized {
                return Err(QuetzalcoatlError::ConscienceViolation {
                    detail: format!(
                        "出站群文本试图引用未经授权的 {} 字段: {}",
                        reference.authority.as_str(),
                        reference.path
                    ),
                });
            }
        }
        Ok(())
    }
}

fn field_pattern_allows(pattern: &str, path: &str) -> bool {
    let clean = path.trim();
    let pat = pattern.trim();
    if clean.is_empty() || pat.is_empty() {
        return false;
    }
    if pat == clean {
        return true;
    }
    if let Some(prefix) = pat.strip_suffix("/*") {
        return clean.starts_with(prefix) && clean.len() > prefix.len();
    }
    if let Some((prefix, suffix)) = pat.split_once("/*.") {
        let head = format!("{prefix}/");
        let tail = format!(".{suffix}");
        return clean.starts_with(&head)
            && clean.ends_with(&tail)
            && clean.len() > head.len() + tail.len();
    }
    false
}
