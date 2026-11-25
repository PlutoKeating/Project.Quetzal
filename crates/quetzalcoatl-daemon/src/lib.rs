#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]

//! `quetzalcoatl-daemon` — 单物理主机独占脊柱守护进程 `quetzalcoatld`、防 DNS 重绑定本地 IPC 与薄客户端协议。

pub mod channels;
pub mod daemon;
pub mod domains;
pub mod fabric;
pub mod group;
pub mod ingress_key;
pub mod local_ipc;
pub mod platform_crypto;
pub mod voice;
pub mod web_console;
pub mod webhook;

pub use channels::{ChannelRuntime, LocalIntentSpool};
pub use daemon::{
    ChatRequest, ChatResponse, DaemonConfig, DaemonHandle, DaemonRuntimeInfo, DaemonStatus,
    ExploreWakeReport, QuetzalcoatlDaemon, export_offline_or_via_ipc, import_v1_offline_or_via_ipc,
    resolve_quetzalcoatl_home, resolve_web_console_dir,
};
pub use domains::{DomainPackSummary, DomainPackView, DomainRuntime};
pub use fabric::{
    DaemonFabricConfig, FabricLoginRequest, FabricLoginResult, FabricNodesReport,
    FabricPairApproveResult, FabricPairJoinResult, FabricPairStartResult, FabricPeerRow,
    FabricRevokeResult, FabricStatus, PersistedFabricSession, load_persisted_session,
};
pub use group::{
    GroupHubBinding, GroupInviteOutcome, GroupLeaveOutcome, GroupMemberView, GroupRevokeOutcome,
    GroupRoomRuntime, GroupRoomSummary, GroupSendOutcome, base64_decode, base64_encode,
};
pub use ingress_key::{ChannelIngressKey, ingress_and_device_keys_differ};
pub use local_ipc::{
    DesktopRow, IpcClient, IpcRequest, IpcResponse, validate_loopback_host_and_origin,
};
pub use platform_crypto::{decrypt_json_envelope, decrypt_wecom};
pub use voice::{
    DaemonVoiceEvent, MAX_VOICE_STREAMS, VOICE_AI_ENV, VoiceActivityRuntime, VoiceActivitySessions,
    VoiceAiConfig, VoiceStreamError, VoiceTurnReport, decode_audio_frame,
};
pub use webhook::{WebhookPullFailure, WebhookPullReport, WebhookPulledEvent, decrypt_and_persist};
