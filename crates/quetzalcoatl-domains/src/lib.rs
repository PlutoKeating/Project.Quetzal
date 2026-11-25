#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]

//! `quetzalcoatl-domains` — 五大首发标杆领域包与监护人签名 `SafetyEnvelope`。
//!
//! 本 crate 只承载**声明式数据 + 确定性校验器**，绝不向盲微内核回塞任何业务语义：
//! 1. [`manifest`]：`pack.json` 清单、种子良知四档权威、JCS 规范化监护人签名安全信封；
//! 2. [`verifier`]：引用完备性、苏格拉底引导、能力边界、免责披露、危险命令与洁净室凭证门禁；
//! 3. [`safety`]：外发频率/静默时段/预算门限、紧急告警穿透（越过睡眠抑制与断网分区）与安全审计日志；
//! 4. [`registry`]：装载/校验领域包、按 Agent 解析活动包、切换审计与默认 `personal-companion` 回落。
//!
//! 盲微内核 `quetzalcoatl-kernel` 对本 crate 无任何运行期依赖（仅反向以 dev-dependency 消费，
//! 用于认证测试），`blind_boundary.rs` 依赖白名单保持不变。

pub mod canonical;
pub mod demo_keys;
pub mod manifest;
pub mod registry;
pub mod safety;
pub mod verifier;

pub use canonical::{
    MAX_SAFE_INTEGER, blake3_jcs_digest, blake3_jcs_digest_hex, canonicalize_json_str,
    canonicalize_json_value,
};
pub use demo_keys::{
    BUILTIN_TRUSTED_BODY_DIGESTS, DEMO_GUARDIAN_DERIVE_CONTEXT, FLAGSHIP_DOMAIN_IDS,
    builtin_guardian_keys, builtin_pack_json, demo_guardian_key, demo_guardian_seed,
};
pub use manifest::{
    BudgetPolicy, ChannelCap, ConscienceSeed, ConscienceSeedEntry, DEFAULT_DOMAIN_PACK_ID,
    DOMAIN_PACK_SCHEMA, DeliverableKind, DomainPack, DomainPackId, EmergencyPolicy, GuardianKey,
    GuardianKeySource, OutboundPolicy, QuietHours, SAFETY_ENVELOPE_SCHEMA, SafetyEnvelope,
    SafetyEnvelopePayload, SafetyEventPolicy, SeedSource, SeedTier, VerifierRule, parse_sink_class,
};
pub use registry::{DomainPackRegistry, InstalledPack, PackSwitchAudit, PackSwitchOutcome};
pub use safety::{
    MemorySafetySink, OutboundContext, OutboundDecision, OutboundKind, OutboundOutcome,
    OutboundRequest, SAFETY_STATE_SCHEMA, SafetyEvent, SafetyEventKind, SafetyPersistedState,
    SafetyStateSink, SafetySupervisor, SpineSafetySink, SuppressionReason,
};
pub use verifier::{Citation, Claim, DeliverableCandidate};
