#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]

//! `quetzalcoatl-group` — Super-Group-Agent 物理隔离协同层（`openmls` 群房间 + ANP-P9 控场 +
//! 未读水位线屏障 + A2A 衰减信封 + 异构编队零拷贝交接）。
//!
//! 本 crate 对模型供应商、外部通道与业务工具名保持盲视：只处理密文、签名元数据与结构化门禁判定。

pub mod a2a_mandate;
pub mod commit_barrier;
pub mod facilitator;
pub mod floor_control;
pub mod mls_room;
pub mod squad;
pub mod steward;

pub use a2a_mandate::{
    AgentCard, AttenuatedMandate, EscalationTicket, MandateRequest, SignedAgentCard,
    jcs_canonicalize,
};
pub use commit_barrier::{
    BarrierOutcome, BarrierResolution, EpochCiphertext, GroupHead, InterveningEvent,
    SubmittedCommit, UnreadWatermarkBarrier, decrypt_with_epoch_key, reencrypt_with_new_epoch,
    seal_with_epoch_key,
};
pub use facilitator::{
    FacilitatorHolder, RoomFacilitator, SharedResourceRequest, SharedResourceTicket, TaskRoute,
};
pub use floor_control::{
    AnpP9FloorGate, AuthorityEnvelope, FloorAction, FloorDecision, FloorInput, Mention,
    MentionKind, OutboundGroupDraft, OutboundPrivacyGate, OwnerGroupAuthorization,
    PrivateReference, SenderKind,
};
pub use mls_room::{GroupRoomEngine, JoinHandoff, MlsIdentity, RemovalHandoff, RoomProvider};
pub use squad::{
    ArtifactRef, GitCliSquadWorkspace, HandoffReceipt, HeterogeneousSquadCoordinator, SquadMember,
    SquadRole, SquadWorkspace,
};
pub use steward::{
    GroupTrustDomain, SharedRoleAgentBinding, StewardGrant, StewardRegistry, StewardRevocation,
};
