#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]

//! `quetzalcoatl-daemon` — 单物理主机独占脊柱守护进程 `quetzalcoatld`、防 DNS 重绑定本地 IPC 与薄客户端协议。

pub mod daemon;
pub mod fabric;
pub mod group;
pub mod local_ipc;
pub mod voice;

pub use daemon::{
    ChatRequest, ChatResponse, DaemonConfig, DaemonHandle, DaemonRuntimeInfo, DaemonStatus,
    ExploreWakeReport, QuetzalcoatlDaemon, export_offline_or_via_ipc, import_v1_offline_or_via_ipc,
    resolve_quetzalcoatl_home,
};
pub use fabric::{
    DaemonFabricConfig, FabricLoginRequest, FabricLoginResult, FabricNodesReport,
    FabricPairApproveResult, FabricPairJoinResult, FabricPairStartResult, FabricPeerRow,
    FabricRevokeResult, FabricStatus, PersistedFabricSession, load_persisted_session,
};
pub use group::{
    GroupHubBinding, GroupInviteOutcome, GroupLeaveOutcome, GroupMemberView, GroupRevokeOutcome,
    GroupRoomRuntime, GroupRoomSummary, GroupSendOutcome, base64_decode, base64_encode,
};
pub use local_ipc::{IpcClient, IpcRequest, IpcResponse, validate_loopback_host_and_origin};
pub use voice::{
    DaemonVoiceEvent, VOICE_AI_ENV, VoiceActivityRuntime, VoiceAiConfig, VoiceTurnReport,
    decode_audio_frame,
};
