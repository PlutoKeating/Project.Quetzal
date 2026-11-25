#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]

//! 领域包声明式清单（`pack.json`）、种子良知、监护人签名安全信封与不可变字段守卫。

use std::collections::BTreeMap;
use std::fmt;
use std::str::FromStr;

use ed25519_dalek::{Signer, SigningKey};
use quetzalcoatl_crypto::{hex_decode_fixed, hex_encode, verify_ed25519_signature};
use quetzalcoatl_ewave::{Authority, ProtectedDirective};
use quetzalcoatl_types::{QuetzalcoatlError, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::canonical::blake3_jcs_digest;

/// 领域包清单 schema 标识。
pub const DOMAIN_PACK_SCHEMA: &str = "quetzalcoatl.domain-pack.v1";
/// 监护人安全信封 schema 标识。
pub const SAFETY_ENVELOPE_SCHEMA: &str = "quetzalcoatl.domain-safety-envelope.v1";
/// 领域包正文（除安全信封外）摘要域分离上下文。
pub const PACK_BODY_DIGEST_CONTEXT: &str = "quetzalcoatl/v2/domain-pack-body-v1";
/// 安全信封签名摘要域分离上下文。
pub const ENVELOPE_DIGEST_CONTEXT: &str = "quetzalcoatl/v2/domain-safety-envelope-v1";
/// 未显式选择领域包的 Agent 默认落在私人伴生领域。
pub const DEFAULT_DOMAIN_PACK_ID: &str = "personal-companion";

fn serialization_error(detail: impl Into<String>) -> QuetzalcoatlError {
    QuetzalcoatlError::SerializationError {
        detail: detail.into(),
    }
}

/// 领域包标识（小写 ASCII 短横线命名）。
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct DomainPackId(String);

impl DomainPackId {
    pub fn parse(raw: &str) -> Result<Self> {
        let trimmed = raw.trim();
        if !(2..=64).contains(&trimmed.len()) {
            return Err(QuetzalcoatlError::invalid_id(
                "DomainPackId",
                format!("领域包 ID 长度必须为 2..=64，实际 {}", trimmed.len()),
            ));
        }
        let charset_ok = trimmed
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
        if !charset_ok
            || trimmed.starts_with('-')
            || trimmed.ends_with('-')
            || trimmed.contains("--")
        {
            return Err(QuetzalcoatlError::invalid_id(
                "DomainPackId",
                format!(
                    "领域包 ID `{trimmed}` 只允许小写字母/数字/单个短横线，且不得以短横线开头结尾"
                ),
            ));
        }
        Ok(Self(String::from(trimmed)))
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for DomainPackId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl FromStr for DomainPackId {
    type Err = QuetzalcoatlError;

    fn from_str(raw: &str) -> Result<Self> {
        Self::parse(raw)
    }
}

impl AsRef<str> for DomainPackId {
    fn as_ref(&self) -> &str {
        &self.0
    }
}

/// 种子良知四档权威等级（与 eWave `Authority` 数值严格一致）。
#[derive(Copy, Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum SeedTier {
    /// 所有者根红线（100）。
    Root,
    /// 部署者/监护人红线（80）。
    Operator,
    /// 核心自我（70，仅可全自动多证据冷却升格）。
    SelfCore,
    /// 软偏好（50，写时复制沙箱内即时自演化）。
    SelfSoft,
}

impl SeedTier {
    #[must_use]
    pub const fn authority(self) -> Authority {
        match self {
            Self::Root => Authority::Root,
            Self::Operator => Authority::Operator,
            Self::SelfCore => Authority::SelfCore,
            Self::SelfSoft => Authority::SelfSoft,
        }
    }

    #[must_use]
    pub const fn as_str(self) -> &'static str {
        self.authority().as_str()
    }

    /// 该档位是否允许由 agent 可写数据（写时复制沙箱/自演化脚本）驱动。
    #[must_use]
    pub const fn is_agent_writable(self) -> bool {
        matches!(self, Self::SelfSoft)
    }
}

/// 种子良知条目的权威来源。
#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SeedSource {
    /// 由监护人密钥在领域包签名链内固定（不可被代理运行期改写）。
    Guardian,
    /// agent 可写（仅允许落在 `SELF_SOFT` 档位）。
    AgentWritable,
}

/// 单条种子良知条目。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConscienceSeedEntry {
    pub id: String,
    pub tier: SeedTier,
    pub source: SeedSource,
    pub title: String,
    pub content: String,
}

/// 领域包种子良知（`ROOT` / `OPERATOR` / `SELF_CORE` / `SELF_SOFT` 四档）。
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConscienceSeed {
    pub entries: Vec<ConscienceSeedEntry>,
}

impl ConscienceSeed {
    /// 权威合理性校验：agent 可写数据永不得授予 `ROOT` / `OPERATOR` / `SELF_CORE`。
    pub fn validate_authority_sanity(&self) -> Result<()> {
        let mut seen = std::collections::BTreeSet::<String>::new();
        for entry in &self.entries {
            let id = entry.id.trim();
            if id.is_empty() {
                return Err(QuetzalcoatlError::invalid_id(
                    "ConscienceDirectiveId",
                    String::from("种子良知条目 ID 不得为空"),
                ));
            }
            if !seen.insert(String::from(id)) {
                return Err(QuetzalcoatlError::ConscienceViolation {
                    detail: format!("种子良知条目 ID 重复: {id}"),
                });
            }
            match (entry.tier.is_agent_writable(), entry.source) {
                (true, SeedSource::AgentWritable) | (true, SeedSource::Guardian) => {}
                (false, SeedSource::Guardian) => {}
                (false, SeedSource::AgentWritable) => {
                    return Err(QuetzalcoatlError::PermissionDenied {
                        detail: format!(
                            "领域包严禁从 agent 可写数据授予 {} 权威（条目 `{id}`）：受保护红线必须由监护人签名固定",
                            entry.tier.as_str()
                        ),
                    });
                }
            }
        }
        Ok(())
    }

    /// 转换为 eWave 受保护指令（`created_at_ms` 由所有者首次签名时统一落定）。
    pub fn to_protected_directives(&self) -> Result<Vec<ProtectedDirective>> {
        self.validate_authority_sanity()?;
        Ok(self
            .entries
            .iter()
            .map(|entry| ProtectedDirective {
                id: entry.id.clone(),
                authority: entry.tier.authority(),
                title: entry.title.clone(),
                content: entry.content.clone(),
                created_at_ms: 0,
            })
            .collect())
    }

    #[must_use]
    pub fn entry(&self, id: &str) -> Option<&ConscienceSeedEntry> {
        self.entries.iter().find(|e| e.id == id)
    }
}

/// 单通道外发频率上限。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChannelCap {
    pub channel_id: String,
    pub max_per_hour: u32,
    pub max_per_day: u32,
}

/// 静默时段（本地小时整数，起始等于结束即视为关闭）。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QuietHours {
    pub start_local_hour: u8,
    pub end_local_hour: u8,
}

impl QuietHours {
    /// 判断某一本地小时是否落在静默时段内（支持跨越午夜）。
    #[must_use]
    pub fn contains_hour(&self, local_hour: f64) -> bool {
        let start = u32::from(self.start_local_hour % 24);
        let end = u32::from(self.end_local_hour % 24);
        let hour = u32::from(local_hour.rem_euclid(24.0) as u8 % 24);
        if start == end {
            return false;
        }
        if start < end {
            hour >= start && hour < end
        } else {
            hour >= start || hour < end
        }
    }
}

/// 外发策略（频率上限、静默时段与单条消息收件人上限）。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OutboundPolicy {
    pub per_channel_caps: Vec<ChannelCap>,
    pub quiet_hours: QuietHours,
    pub max_recipients_per_message: u32,
}

/// 紧急告警策略（不透明联系人 ID、断网与睡眠抑制穿透开关）。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EmergencyPolicy {
    pub enabled: bool,
    pub contacts: Vec<String>,
    pub escalation_channels: Vec<String>,
    pub bypass_sleep_inhibition: bool,
    pub allow_local_alert_under_partition: bool,
}

/// 预算硬上限（整数微单位，杜绝浮点歧义）。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BudgetPolicy {
    pub ceiling_micros: u64,
}

/// 安全事件上报策略。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SafetyEventPolicy {
    pub guardian_visible_event_kinds: Vec<String>,
}

/// 监护人签名信封的被签名载荷。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SafetyEnvelopePayload {
    pub schema: String,
    pub pack_id: String,
    pub pack_version: String,
    /// 领域包正文（不含信封）的规范化 BLAKE3 摘要，把信封与包内容密码学绑定。
    pub pack_blake3_hex: String,
    /// 监护人 Ed25519 公钥（小写十六进制）。
    pub guardian_key_id: String,
    /// 不透明监护人标签（绝不包含真实姓名/联系方式）。
    pub guardian_label: String,
    pub issued_at_ms: u64,
    pub locale: String,
    pub outbound: OutboundPolicy,
    pub budget: BudgetPolicy,
    pub emergency: EmergencyPolicy,
    pub safety_events: SafetyEventPolicy,
    /// 代理侧永不可修改的字段路径（点号分隔）。
    pub immutable_fields: Vec<String>,
}

impl SafetyEnvelopePayload {
    /// 按点号路径读取字段值（用于不可变字段差异比对）。
    #[must_use]
    pub fn field_value(&self, dotted_path: &str) -> Option<Value> {
        let value = serde_json::to_value(self).ok()?;
        let mut cursor = &value;
        for segment in dotted_path.split('.') {
            cursor = cursor.get(segment)?;
        }
        Some(cursor.clone())
    }
}

/// 监护人 Ed25519 签名的安全信封（签名覆盖 JCS 规范化载荷的 BLAKE3 摘要）。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SafetyEnvelope {
    pub payload: SafetyEnvelopePayload,
    pub guardian_pubkey_hex: String,
    pub digest_hex: String,
    pub sig_hex: String,
}

impl SafetyEnvelope {
    /// 使用监护人 Ed25519 种子对载荷签名。
    pub fn sign(payload: SafetyEnvelopePayload, guardian_seed: &[u8; 32]) -> Result<Self> {
        let signing_key = SigningKey::from_bytes(guardian_seed);
        let pubkey_hex = hex_encode(signing_key.verifying_key().as_bytes());
        if !payload
            .guardian_key_id
            .trim()
            .eq_ignore_ascii_case(&pubkey_hex)
        {
            return Err(QuetzalcoatlError::ConscienceViolation {
                detail: String::from(
                    "安全信封 guardianKeyId 与签名私钥公钥不一致，拒绝签发错绑信封",
                ),
            });
        }
        let digest = Self::compute_digest(&payload)?;
        let signature = signing_key.sign(&digest);
        Ok(Self {
            payload,
            guardian_pubkey_hex: pubkey_hex,
            digest_hex: hex_encode(&digest),
            sig_hex: hex_encode(&signature.to_bytes()),
        })
    }

    /// 计算载荷的 JCS 规范化 BLAKE3 摘要。
    pub fn compute_digest(payload: &SafetyEnvelopePayload) -> Result<[u8; 32]> {
        let value =
            serde_json::to_value(payload).map_err(|e| serialization_error(e.to_string()))?;
        blake3_jcs_digest(ENVELOPE_DIGEST_CONTEXT, &value)
    }

    /// 验证 schema、摘要一致性与受信监护人签名；返回命中的受信监护人。
    pub fn verify<'a>(
        &self,
        guardians: &'a BTreeMap<String, GuardianKey>,
    ) -> Result<&'a GuardianKey> {
        if self.payload.schema != SAFETY_ENVELOPE_SCHEMA {
            return Err(QuetzalcoatlError::IntegrityViolation {
                detail: format!(
                    "安全信封 schema 非法：期望 {SAFETY_ENVELOPE_SCHEMA}，实际 {}",
                    self.payload.schema
                ),
            });
        }

        let pubkey_bytes = hex_decode_fixed::<32>("GuardianPubkey", &self.guardian_pubkey_hex)?;
        if !self
            .payload
            .guardian_key_id
            .trim()
            .eq_ignore_ascii_case(self.guardian_pubkey_hex.trim())
        {
            return Err(QuetzalcoatlError::IntegrityViolation {
                detail: String::from("安全信封 guardianKeyId 与 guardianPubkeyHex 不一致"),
            });
        }

        let expected_digest = Self::compute_digest(&self.payload)?;
        let declared_digest = hex_decode_fixed::<32>("EnvelopeDigest", &self.digest_hex)?;
        if expected_digest != declared_digest {
            return Err(QuetzalcoatlError::IntegrityViolation {
                detail: String::from("安全信封内容与签署摘要不一致（疑似被篡改）"),
            });
        }

        let normalized = self.guardian_pubkey_hex.trim().to_ascii_lowercase();
        let Some(guardian) = guardians.get(&normalized) else {
            return Err(QuetzalcoatlError::PermissionDenied {
                detail: format!(
                    "安全信封由非受信监护人密钥签署 `{normalized}`：领域包必须由本 Agent 登记的监护人重签"
                ),
            });
        };

        let signature = hex_decode_fixed::<64>("EnvelopeSignature", &self.sig_hex)?;
        verify_ed25519_signature(&pubkey_bytes, &expected_digest, &signature).map_err(|e| {
            QuetzalcoatlError::IntegrityViolation {
                detail: format!("安全信封 Ed25519 签名校验失败: {e}"),
            }
        })?;

        Ok(guardian)
    }
}

/// 已登记的监护人公钥。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GuardianKey {
    pub pubkey_hex: String,
    pub label: String,
}

impl GuardianKey {
    #[must_use]
    pub fn new(pubkey_hex: impl Into<String>, label: impl Into<String>) -> Self {
        Self {
            pubkey_hex: pubkey_hex.into().trim().to_ascii_lowercase(),
            label: label.into(),
        }
    }

    #[must_use]
    pub fn normalized(&self) -> String {
        self.pubkey_hex.trim().to_ascii_lowercase()
    }
}

/// 单条领域校验规则（红线的可执行形态）。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum VerifierRule {
    /// 每条事实性论断必须携带最少 N 条可核验引用。
    CitationRequired {
        directive_id: String,
        min_citations_per_claim: u32,
        applies_to: Vec<DeliverableKind>,
    },
    /// 苏格拉底式引导：先追问后引导，禁止直接交付终局答案。
    SocraticGuidance {
        directive_id: String,
        min_questions: u32,
        final_answer_markers: Vec<String>,
    },
    /// 能力边界：越界专业建议必须显式转介专业人士。
    CompetenceBoundary {
        directive_id: String,
        topic_keywords: Vec<String>,
        deferral_markers: Vec<String>,
    },
    /// 必须包含指定免责/适用范围声明。
    RequiredDisclosure {
        directive_id: String,
        marker: String,
        applies_to: Vec<DeliverableKind>,
    },
    /// 仓库变更必须持有洁净室 `VerificationMark`。
    CleanRoomMarkRequired {
        directive_id: String,
        repository_mutation: bool,
    },
    /// 禁止的危险命令模式（强推、绕过钩子、密钥外泄等）。
    ForbiddenCommandPatterns {
        directive_id: String,
        patterns: Vec<String>,
    },
}

impl VerifierRule {
    #[must_use]
    pub fn directive_id(&self) -> &str {
        match self {
            Self::CitationRequired { directive_id, .. }
            | Self::SocraticGuidance { directive_id, .. }
            | Self::CompetenceBoundary { directive_id, .. }
            | Self::RequiredDisclosure { directive_id, .. }
            | Self::CleanRoomMarkRequired { directive_id, .. }
            | Self::ForbiddenCommandPatterns { directive_id, .. } => directive_id,
        }
    }

    #[must_use]
    pub const fn kind_str(&self) -> &'static str {
        match self {
            Self::CitationRequired { .. } => "citation_required",
            Self::SocraticGuidance { .. } => "socratic_guidance",
            Self::CompetenceBoundary { .. } => "competence_boundary",
            Self::RequiredDisclosure { .. } => "required_disclosure",
            Self::CleanRoomMarkRequired { .. } => "clean_room_mark_required",
            Self::ForbiddenCommandPatterns { .. } => "forbidden_command_patterns",
        }
    }
}

/// 领域包声明式清单（`packages/domains/<id>/pack.json` 的唯一事实源）。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DomainPack {
    pub schema: String,
    pub id: String,
    pub version: String,
    pub display_name: String,
    pub description: String,
    pub locales: Vec<String>,
    /// 角色工具白名单（该领域允许被下发给宿主的工具/能力 ID）。
    pub role_tool_whitelist: Vec<String>,
    pub required_capabilities: Vec<String>,
    /// 必需的确定性汇点分类（取自盲内核 `SinkClass` snake_case 名）。
    pub required_sinks: Vec<String>,
    pub conscience_seed: ConscienceSeed,
    pub verifier_rules: Vec<VerifierRule>,
    pub safety_envelope: SafetyEnvelope,
}

impl DomainPack {
    /// 解析并校验领域包 ID。
    pub fn pack_id(&self) -> Result<DomainPackId> {
        DomainPackId::parse(&self.id)
    }

    #[must_use]
    pub fn conscience_seed(&self) -> &ConscienceSeed {
        &self.conscience_seed
    }

    #[must_use]
    pub fn envelope(&self) -> &SafetyEnvelope {
        &self.safety_envelope
    }

    #[must_use]
    pub fn display_name(&self) -> &str {
        &self.display_name
    }

    /// 领域包正文 JSON（移除 `safetyEnvelope`），用于计算被监护人签名的内容摘要。
    pub fn body_value(&self) -> Result<Value> {
        let mut value =
            serde_json::to_value(self).map_err(|e| serialization_error(e.to_string()))?;
        if let Value::Object(map) = &mut value {
            map.remove("safetyEnvelope");
        }
        Ok(value)
    }

    /// 领域包正文的规范化 BLAKE3 摘要（小写十六进制）。
    pub fn body_digest_hex(&self) -> Result<String> {
        let body = self.body_value()?;
        Ok(hex_encode(&blake3_jcs_digest(
            PACK_BODY_DIGEST_CONTEXT,
            &body,
        )?))
    }

    /// 完整校验：schema、信封绑定、正文摘要、权威合理性与监护人签名。
    pub fn verify<'a>(
        &self,
        guardians: &'a BTreeMap<String, GuardianKey>,
    ) -> Result<&'a GuardianKey> {
        self.validate_structure()?;
        self.conscience_seed.validate_authority_sanity()?;
        self.validate_verifier_anchors()?;

        if self.safety_envelope.payload.schema != SAFETY_ENVELOPE_SCHEMA {
            return Err(QuetzalcoatlError::IntegrityViolation {
                detail: String::from("安全信封 schema 非法"),
            });
        }
        if self.safety_envelope.payload.pack_id != self.id {
            return Err(QuetzalcoatlError::IntegrityViolation {
                detail: format!(
                    "安全信封绑定的 packId `{}` 与领域包 `{}` 不一致",
                    self.safety_envelope.payload.pack_id, self.id
                ),
            });
        }
        if self.safety_envelope.payload.pack_version != self.version {
            return Err(QuetzalcoatlError::IntegrityViolation {
                detail: format!(
                    "安全信封绑定的 packVersion `{}` 与领域包版本 `{}` 不一致",
                    self.safety_envelope.payload.pack_version, self.version
                ),
            });
        }
        let body_digest = self.body_digest_hex()?;
        if !self
            .safety_envelope
            .payload
            .pack_blake3_hex
            .trim()
            .eq_ignore_ascii_case(&body_digest)
        {
            return Err(QuetzalcoatlError::IntegrityViolation {
                detail: String::from(
                    "领域包正文摘要与监护人签署的 packBlake3Hex 不一致（pack.json 内容被篡改或签名过期）",
                ),
            });
        }

        self.safety_envelope.verify(guardians)
    }

    fn validate_structure(&self) -> Result<()> {
        if self.schema != DOMAIN_PACK_SCHEMA {
            return Err(QuetzalcoatlError::IntegrityViolation {
                detail: format!(
                    "领域包 schema 非法：期望 {DOMAIN_PACK_SCHEMA}，实际 {}",
                    self.schema
                ),
            });
        }
        self.pack_id()?;
        if self.version.trim().is_empty() {
            return Err(QuetzalcoatlError::invalid_id(
                "DomainPackVersion",
                String::from("领域包版本号不得为空"),
            ));
        }
        if self.display_name.trim().is_empty() || self.description.trim().is_empty() {
            return Err(QuetzalcoatlError::invalid_id(
                "DomainPackText",
                String::from("领域包显示名与描述不得为空"),
            ));
        }
        if self.locales.is_empty() {
            return Err(QuetzalcoatlError::invalid_id(
                "DomainPackLocale",
                String::from("领域包必须声明至少一种支持语言"),
            ));
        }
        if self.role_tool_whitelist.is_empty() {
            return Err(QuetzalcoatlError::invalid_id(
                "DomainPackToolWhitelist",
                String::from("领域包角色工具白名单不得为空"),
            ));
        }
        let mut seen_tools = std::collections::BTreeSet::<&str>::new();
        for tool in &self.role_tool_whitelist {
            if tool.trim().is_empty() || !seen_tools.insert(tool.as_str()) {
                return Err(QuetzalcoatlError::invalid_id(
                    "DomainPackToolWhitelist",
                    format!("角色工具白名单存在空项或重复项 `{tool}`"),
                ));
            }
        }
        for sink in &self.required_sinks {
            if parse_sink_class(sink).is_none() {
                return Err(QuetzalcoatlError::invalid_id(
                    "DomainPackSink",
                    format!("未知的内核汇点分类 `{sink}`"),
                ));
            }
        }
        if self.conscience_seed.entries.is_empty() {
            return Err(QuetzalcoatlError::invalid_id(
                "ConscienceSeed",
                String::from("领域包种子良知不得为空"),
            ));
        }
        if self.verifier_rules.is_empty() {
            return Err(QuetzalcoatlError::invalid_id(
                "DomainVerifierRule",
                String::from("领域包必须声明至少一条客观校验规则"),
            ));
        }
        Ok(())
    }

    /// 可执行校验规则必须锚定到监护人签名固定的受保护良知条目。
    fn validate_verifier_anchors(&self) -> Result<()> {
        for rule in &self.verifier_rules {
            let directive_id = rule.directive_id();
            let Some(entry) = self.conscience_seed.entry(directive_id) else {
                return Err(QuetzalcoatlError::PermissionDenied {
                    detail: format!(
                        "领域校验规则 `{}` 锚定了不存在的良知条目 `{directive_id}`",
                        rule.kind_str()
                    ),
                });
            };
            if entry.tier.is_agent_writable() || entry.source != SeedSource::Guardian {
                return Err(QuetzalcoatlError::PermissionDenied {
                    detail: format!(
                        "领域校验规则 `{}` 严禁锚定到 agent 可写条目 `{directive_id}`：可执行红线必须由监护人签名固定在 ROOT/OPERATOR/SELF_CORE",
                        rule.kind_str()
                    ),
                });
            }
        }
        Ok(())
    }
}

/// 把 snake_case 汇点名解析为盲内核 `SinkClass`。
#[must_use]
pub fn parse_sink_class(raw: &str) -> Option<quetzalcoatl_kernel::SinkClass> {
    serde_json::from_str::<quetzalcoatl_kernel::SinkClass>(&format!(
        "\"{}\"",
        raw.trim().to_ascii_lowercase()
    ))
    .ok()
}

/// 交付物种类（用于按种类限定校验规则作用面）。
#[derive(Copy, Clone, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeliverableKind {
    #[default]
    Answer,
    TutoringAnswer,
    Advice,
    Report,
    CodeChange,
    Reminder,
}
