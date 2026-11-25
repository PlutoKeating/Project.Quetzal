#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]

//! 本地认证 IPC（Unix Domain Socket `0600` + `127.0.0.1` 回环 HTTP/JSON-RPC + 严格 DNS 重绑定防护 + 单次 `Run` 受限钩子令牌隔离）。

use std::fs;
use std::hint::black_box;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
#[cfg(unix)]
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use quetzalcoatl_crypto::hex_encode;
use quetzalcoatl_group::floor_control::Mention;
use quetzalcoatl_harness::DiscoveryReport;
use quetzalcoatl_spine::V1ImportReport;
use quetzalcoatl_types::{AgentId, DeviceId, QuetzalcoatlError, Result, RunId};
use rand_core::{OsRng, RngCore};
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use quetzalcoatl_capabilities::SayItBatchOutcome;
use quetzalcoatl_channels::{ChannelHealth, DeliveryReport};
use quetzalcoatl_fabric::WebhookIngressStatus;

use crate::daemon::{
    ChatRequest, ChatResponse, DaemonRuntimeInfo, DaemonStatus, ExploreWakeReport,
};
use crate::fabric::{
    FabricLoginRequest, FabricLoginResult, FabricNodesReport, FabricPairApproveResult,
    FabricPairJoinResult, FabricPairStartResult, FabricRevokeResult,
};
use crate::group::{
    GroupInviteOutcome, GroupLeaveOutcome, GroupMemberView, GroupRevokeOutcome, GroupRoomSummary,
    GroupSendOutcome,
};

const MAX_IPC_HEADER_BYTES: usize = 32 * 1024;
const MAX_IPC_BODY_BYTES: usize = 8 * 1024 * 1024;

#[must_use]
pub(crate) fn constant_time_eq_32(a: &[u8; 32], b: &[u8; 32]) -> bool {
    let mut diff = 0u8;
    for i in 0..32 {
        diff |= black_box(a[i]) ^ black_box(b[i]);
    }
    black_box(diff) == 0
}

const fn decode_nibble(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

pub(crate) fn decode_hex_32_constant(s: &str) -> ([u8; 32], bool) {
    let raw = s.trim().as_bytes();
    if raw.len() != 64 {
        return ([0u8; 32], false);
    }
    let mut out = [0u8; 32];
    let mut ok = true;
    for (idx, slot) in out.iter_mut().enumerate() {
        match (decode_nibble(raw[idx * 2]), decode_nibble(raw[idx * 2 + 1])) {
            (Some(h), Some(l)) => *slot = (h << 4) | l,
            _ => {
                *slot = 0;
                ok = false;
            }
        }
    }
    (out, ok)
}

type ScopedTokenEntry = (RunId, Zeroizing<[u8; 32]>);

/// 绑定单次 `Worker Run` 的最小权限渐进钩子令牌表（严禁向沙箱暴露守护进程管理员主令牌）。
#[derive(Clone, Default)]
pub(crate) struct ScopedHookTokenRegistry {
    tokens: Arc<Mutex<Vec<ScopedTokenEntry>>>,
}

impl ScopedHookTokenRegistry {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    pub fn mint_for_run(&self, run_id: RunId) -> Result<String> {
        let mut raw = [0u8; 32];
        OsRng.fill_bytes(&mut raw);
        let hex = hex_encode(&raw);
        let mut guard = self
            .tokens
            .lock()
            .map_err(|_| QuetzalcoatlError::StorageError {
                detail: String::from("ScopedHookTokenRegistry 锁异常"),
            })?;
        guard.retain(|(rid, _)| *rid != run_id);
        guard.push((run_id, Zeroizing::new(raw)));
        Ok(hex)
    }

    pub fn revoke_for_run(&self, run_id: RunId) {
        if let Ok(mut guard) = self.tokens.lock() {
            guard.retain(|(rid, _)| *rid != run_id);
        }
    }

    #[must_use]
    pub fn match_constant_time(&self, candidate: &[u8; 32], syntax_ok: bool) -> Option<RunId> {
        let Ok(guard) = self.tokens.lock() else {
            return None;
        };
        let mut matched: Option<RunId> = None;
        for (rid, secret) in guard.iter() {
            let eq = constant_time_eq_32(candidate, secret);
            if syntax_ok && eq {
                matched = Some(*rid);
            }
        }
        matched
    }
}

#[derive(Copy, Clone, PartialEq, Eq)]
enum IpcCallerAuth {
    MasterAdmin,
    ScopedWorkerHook(RunId),
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "method", content = "params", rename_all = "snake_case")]
pub enum IpcRequest {
    Status,
    Agents,
    Chat(ChatRequest),
    ExploreTick {
        synthesize_skill_id: Option<String>,
        synthesize_script_body: Option<String>,
        attempt_external_send: bool,
    },
    ConsciencePinned,
    EwaveCheckReport {
        conflict: String,
        ids: Vec<String>,
    },
    Export {
        zip_path: PathBuf,
        include_sealed_spine: bool,
    },
    ImportV1 {
        soul_dir: PathBuf,
        db_paths: Vec<PathBuf>,
    },
    /// `qz login`：对 Hub 执行 OPAQUE PIN 或 Bearer 令牌认证并持久化会话。
    FabricLogin(FabricLoginRequest),
    /// `qz pair start`：发起抗量子 X-Wing 设备配对。
    FabricPairStart,
    /// `qz pair join --code <pairing_id>.<short_code>`。
    FabricPairJoin {
        pairing_id: String,
        short_code: String,
    },
    /// `qz pair approve --code <pairing_id>.<short_code>`。
    FabricPairApprove {
        pairing_id: String,
        short_code: String,
    },
    /// `qz nodes`：列出 fabric 对等节点、路径类型与当前 Router 租约持有者。
    FabricNodes,
    /// `qz pair revoke --device <id>`：吊销已配对设备并前向轮换纪元密钥。
    FabricRevokeDevice {
        device_id: DeviceId,
    },
    /// `qz group create`：创建零知识群房间并构造本地 openmls 引擎。
    GroupCreate {
        room_id: String,
        secrecy_level: u8,
    },
    /// `qz group invite --room <id>`：打印本成员一次性 KeyPackage 交接包。
    GroupInviteKeyPackage {
        room_id: String,
    },
    /// `qz group invite --room <id> --key-package <b64>`：消费远端 KeyPackage 并返回 Welcome。
    GroupAddMember {
        room_id: String,
        key_package_b64: String,
        agent_id: AgentId,
        as_steward: bool,
    },
    /// `qz group join --room <id> --welcome <b64> --ratchet-tree <b64>`。
    GroupJoin {
        room_id: String,
        welcome_b64: String,
        ratchet_tree_b64: String,
    },
    /// `qz group leave --room <id>`。
    GroupLeave {
        room_id: String,
    },
    /// `qz group sync --room <id>`：重读至 Hub 真头并应用 MLS 消息。
    GroupSync {
        room_id: String,
    },
    /// `qz group consume --room <id>`：显式消费未读语义行（约束/点名追问/打断）。
    GroupConsume {
        room_id: String,
    },
    /// `qz group read --room <id> --ciphertext <b64> [--peek]`：解密一条群应用消息。
    GroupRead {
        room_id: String,
        ciphertext_b64: String,
        /// 该密文在 Hub 群日志中的 server_seq（消费只推进到该行）。
        #[serde(default)]
        delivered_seq: Option<u64>,
        /// 只读不消费语义水位线（默认读取即消费）。
        #[serde(default)]
        peek: bool,
    },
    /// `qz group history --room <id> --after <seq> --limit <n>`：取回历史密文行。
    GroupHistory {
        room_id: String,
        after: u64,
        limit: u32,
    },
    /// `qz group quarantine --room <id> --seq <n> --reason <text>`：群主审计隔离坏提交。
    GroupQuarantine {
        room_id: String,
        server_seq: u64,
        reason: String,
    },
    /// `qz group claim-owner --room <id>`：旧注册表升级时确认群主身份。
    GroupClaimOwner {
        room_id: String,
    },
    /// `qz group list`。
    GroupList,
    /// `qz group members --room <id>`。
    GroupMembers {
        room_id: String,
    },
    /// `qz channel list` / `qz channel status`：列出通道健康状态。
    ChannelList,
    /// `qz channel enable --name <channel>`：显式 opt-in 单通道。
    ChannelEnable {
        channel: String,
    },
    /// `qz channel disable --name <channel>`：显式停用并关闭长连接。
    ChannelDisable {
        channel: String,
    },
    /// `qz channel send <channel> --text <...> [--to <dest>]`：商品化出站发送。
    ChannelDeliver {
        channel: String,
        destination: Option<String>,
        text: String,
    },
    /// `qz sayit ingest --path <snapshot>` 或 `--batch <dir>`。
    SayItIngest {
        path: Option<PathBuf>,
        batch_dir: Option<PathBuf>,
    },
    /// `qz webhook pull`：拉取、解封、落盘并确认 Hub 密封信封。
    WebhookPull {
        after: i64,
        limit: u32,
    },
    /// `qz webhook status`：查看入站 key 登记与队列深度。
    WebhookStatus,
    /// `qz webhook register` / `qz webhook rotate`：显式登记或轮换本设备入站公钥。
    WebhookRegisterKey {
        rotate: bool,
    },
    /// `qz group send --room <id> --text <...>`。
    GroupSend {
        room_id: String,
        text: String,
        mentions: Vec<Mention>,
        sender_kind: GroupSenderWire,
        /// 已废弃的客户端跳数（仅兼容旧客户端；权威跳数由 Hub 服务端派生）。
        consecutive_agent_hops: u32,
        human_typing_active: bool,
        kind: String,
        parent_seq: u64,
    },
    /// `qz group revoke-steward --room <id> --identity <mls-identity>`。
    GroupRevokeSteward {
        room_id: String,
        mls_identity: String,
    },
    /// 送入一帧双工音频（320 样本小端 f32 的 base64），仅在 `QUETZALCOATL_VOICE_AI=1` 时可用。
    VoiceFrame {
        /// 客户端语音流标识：每流独立 AEC/VAD 状态与帧序号。
        stream_id: String,
        /// 流内帧序号（必须从 0 开始严格连续）。
        frame_seq: u64,
        render_b64: String,
        capture_b64: String,
        /// 助手当前是否正在播报（决定是否产生打断事件）。
        assistant_speaking: bool,
    },
    Shutdown,
}

/// 群发言者类型线格式（避免 CLI 传裸字符串）。
#[derive(Copy, Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GroupSenderWire {
    Owner,
    OtherHuman,
    PeerAgent,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", content = "data", rename_all = "snake_case")]
pub enum IpcResponse {
    Status(Box<DaemonStatus>),
    Agents(DiscoveryReport),
    Chat(Box<ChatResponse>),
    ExploreTick(ExploreWakeReport),
    ConsciencePinned {
        pinned_system_tail: String,
    },
    Ack {
        detail: String,
    },
    ImportV1(V1ImportReport),
    FabricLogin(FabricLoginResult),
    FabricPairStart(Box<FabricPairStartResult>),
    FabricPairJoin(FabricPairJoinResult),
    FabricPairApprove(Box<FabricPairApproveResult>),
    FabricNodes(Box<FabricNodesReport>),
    FabricRevokeDevice(FabricRevokeResult),
    GroupRooms(Vec<GroupRoomSummary>),
    GroupRoom(GroupRoomSummary),
    GroupInvite(GroupInviteOutcome),
    GroupMembers(Vec<GroupMemberView>),
    GroupLeave(GroupLeaveOutcome),
    GroupSend(GroupSendOutcome),
    GroupRevokeSteward(GroupRevokeOutcome),
    /// 解密后的群应用消息明文。
    GroupPlaintext {
        text: String,
    },
    /// 群历史行（密文与元数据）。
    GroupHistory(Vec<crate::group::GroupHistoryRow>),
    /// 通道健康行（默认全部关闭）。
    Channels(Vec<ChannelHealth>),
    /// 单通道启用/停用后的最新健康行。
    ChannelUpdate(ChannelHealth),
    /// 单次通道出站投递回执。
    ChannelDelivery(DeliveryReport),
    /// SayIt 吸纳结果（单文件或批量）。
    SayItIngest(Vec<SayItBatchOutcome>),
    /// Webhook 拉取/解封/落盘/确认回执。
    WebhookPull(crate::webhook::WebhookPullReport),
    /// Webhook 入站 key 与队列状态。
    WebhookQueueStatus(WebhookIngressStatus),
    /// 单帧声学判决（语音起止 / 打断已同步写入脊柱活动链）。
    VoiceActivity {
        stream_id: String,
        frame_index: u64,
        frame_seq: u64,
        speech: bool,
        vad_probability: f32,
        barge_in: bool,
        interrupting_frame_offset_ms: Option<u32>,
    },
    Error {
        code: String,
        detail: String,
    },
}

fn is_strict_loopback_authority(authority: &str) -> bool {
    let trimmed = authority.trim();
    if trimmed.is_empty()
        || trimmed.contains('@')
        || trimmed.contains('/')
        || trimmed.contains('\\')
        || trimmed.bytes().any(|b| b <= 0x20 || b == 0x7f)
    {
        return false;
    }

    if let Some(after_bracket) = trimmed.strip_prefix('[') {
        let Some((ipv6_host, rest)) = after_bracket.split_once(']') else {
            return false;
        };
        if ipv6_host != "::1" {
            return false;
        }
        if rest.is_empty() {
            return true;
        }
        return rest
            .strip_prefix(':')
            .and_then(|p| p.parse::<u16>().ok())
            .is_some_and(|port| port > 0);
    }

    let host_only = match trimmed.rsplit_once(':') {
        Some((h, port_str)) => {
            if port_str.parse::<u16>().ok().is_none_or(|p| p == 0) {
                return false;
            }
            h
        }
        None => trimmed,
    };

    host_only == "127.0.0.1" || host_only.eq_ignore_ascii_case("localhost")
}

/// 严格防 DNS 重绑定与跨站请求伪造校验：
/// 1. `Host` 必须存在且严格为 `127.0.0.1(:port)`、`localhost(:port)` 或 `[::1](:port)`；
/// 2. 若携带 `Origin` 头，其来源主机也必须严格属于上述本机回环源，否则立即拒绝返回 `403`。
pub fn validate_loopback_host_and_origin(
    host_header: Option<&str>,
    origin_header: Option<&str>,
) -> std::result::Result<(), String> {
    let Some(host) = host_header else {
        return Err(String::from("missing Host header (DNS rebinding guard)"));
    };
    if !is_strict_loopback_authority(host) {
        return Err(format!(
            "rejected non-loopback Host header `{host}` (DNS rebinding guard)"
        ));
    }

    if let Some(origin) = origin_header {
        let orig_trim = origin.trim();
        if !orig_trim.is_empty() {
            let after_scheme = orig_trim
                .strip_prefix("http://")
                .or_else(|| orig_trim.strip_prefix("https://"))
                .ok_or_else(|| format!("rejected invalid Origin `{orig_trim}`"))?;
            let authority = after_scheme.trim_end_matches('/');
            if !is_strict_loopback_authority(authority) {
                return Err(format!("rejected cross-origin Origin `{orig_trim}`"));
            }
        }
    }

    Ok(())
}

pub(crate) trait IpcHandler: Send + Sync + 'static {
    fn handle(&self, req: IpcRequest) -> (IpcResponse, bool);
}

pub(crate) struct LocalIpcServerHandle {
    pub http_addr: SocketAddr,
    pub unix_socket_path: Option<PathBuf>,
    stop: Arc<AtomicBool>,
    tcp_join: Option<JoinHandle<()>>,
    #[cfg(unix)]
    uds_join: Option<JoinHandle<()>>,
}

impl LocalIpcServerHandle {
    pub fn signal_stop(&self) {
        self.stop.store(true, Ordering::Relaxed);
        let _ = TcpStream::connect_timeout(&self.http_addr, Duration::from_millis(20));
        #[cfg(unix)]
        if let Some(sock) = &self.unix_socket_path {
            let _ = UnixStream::connect(sock);
        }
    }

    pub fn is_stopped(&self) -> bool {
        self.stop.load(Ordering::Relaxed)
    }

    pub fn join_all(&mut self) {
        self.signal_stop();
        if let Some(h) = self.tcp_join.take() {
            let _ = h.join();
        }
        #[cfg(unix)]
        if let Some(u) = self.uds_join.take() {
            let _ = u.join();
        }
        if let Some(sock) = &self.unix_socket_path {
            let _ = fs::remove_file(sock);
        }
    }
}

pub(crate) fn start_local_ipc_server<H: IpcHandler>(
    bind_addr: SocketAddr,
    unix_socket_path: Option<PathBuf>,
    ipc_token_bytes: [u8; 32],
    hook_tokens: ScopedHookTokenRegistry,
    stop: Arc<AtomicBool>,
    handler: Arc<H>,
) -> Result<LocalIpcServerHandle> {
    if !bind_addr.ip().is_loopback() {
        return Err(QuetzalcoatlError::SandboxViolation {
            detail: format!("本地 IPC HTTP 必须绑定 127.0.0.1/::1，拒绝绑定 {bind_addr}"),
        });
    }

    let tcp_listener =
        TcpListener::bind(bind_addr).map_err(|e| QuetzalcoatlError::StorageError {
            detail: format!("绑定本地 IPC TCP 端口失败 ({bind_addr}): {e}"),
        })?;
    let actual_http_addr =
        tcp_listener
            .local_addr()
            .map_err(|e| QuetzalcoatlError::StorageError {
                detail: format!("读取本地 IPC 绑定地址失败: {e}"),
            })?;
    tcp_listener
        .set_nonblocking(true)
        .map_err(|e| QuetzalcoatlError::StorageError {
            detail: format!("设置本地 IPC TCP 非阻塞失败: {e}"),
        })?;

    let stop_tcp = Arc::clone(&stop);
    let handler_tcp = Arc::clone(&handler);
    let hooks_tcp = hook_tokens.clone();
    let tcp_join = thread::spawn(move || {
        while !stop_tcp.load(Ordering::Relaxed) {
            match tcp_listener.accept() {
                Ok((mut stream, peer)) => {
                    if !peer.ip().is_loopback() {
                        continue;
                    }
                    let _ = stream.set_nonblocking(false);
                    let _ = stream.set_read_timeout(Some(Duration::from_secs(30)));
                    let _ = stream.set_write_timeout(Some(Duration::from_secs(30)));
                    let h = Arc::clone(&handler_tcp);
                    let stop_conn = Arc::clone(&stop_tcp);
                    let hk = hooks_tcp.clone();
                    thread::spawn(move || {
                        let should_shutdown =
                            serve_single_ipc_stream(&mut stream, &ipc_token_bytes, &hk, h.as_ref());
                        if should_shutdown {
                            stop_conn.store(true, Ordering::Relaxed);
                        }
                    });
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(4));
                }
                Err(_) => {
                    thread::sleep(Duration::from_millis(10));
                }
            }
        }
    });

    #[cfg(unix)]
    let (bound_uds_path, uds_join) = if let Some(sock_path) = unix_socket_path {
        if let Some(parent) = sock_path.parent() {
            fs::create_dir_all(parent).map_err(|e| QuetzalcoatlError::StorageError {
                detail: format!("创建 daemon.sock 目录失败 ({}): {e}", parent.display()),
            })?;
            fs::set_permissions(parent, fs::Permissions::from_mode(0o700)).map_err(|e| {
                QuetzalcoatlError::StorageError {
                    detail: format!("设置 run 目录 0700 权限失败: {e}"),
                }
            })?;
        }
        if sock_path.exists() {
            let _ = fs::remove_file(&sock_path);
        }
        let uds_listener =
            UnixListener::bind(&sock_path).map_err(|e| QuetzalcoatlError::StorageError {
                detail: format!("绑定 daemon.sock 失败 ({}): {e}", sock_path.display()),
            })?;
        fs::set_permissions(&sock_path, fs::Permissions::from_mode(0o600)).map_err(|e| {
            QuetzalcoatlError::StorageError {
                detail: format!("设置 daemon.sock 0600 权限失败: {e}"),
            }
        })?;
        uds_listener
            .set_nonblocking(true)
            .map_err(|e| QuetzalcoatlError::StorageError {
                detail: format!("设置 UnixListener 非阻塞失败: {e}"),
            })?;

        let stop_uds = Arc::clone(&stop);
        let handler_uds = Arc::clone(&handler);
        let hooks_uds = hook_tokens;
        let cleanup_sock = sock_path.clone();
        let join = thread::spawn(move || {
            while !stop_uds.load(Ordering::Relaxed) {
                match uds_listener.accept() {
                    Ok((mut stream, _)) => {
                        let _ = stream.set_nonblocking(false);
                        let _ = stream.set_read_timeout(Some(Duration::from_secs(30)));
                        let _ = stream.set_write_timeout(Some(Duration::from_secs(30)));
                        let h = Arc::clone(&handler_uds);
                        let stop_conn = Arc::clone(&stop_uds);
                        let hk = hooks_uds.clone();
                        thread::spawn(move || {
                            let should_shutdown = serve_single_ipc_stream(
                                &mut stream,
                                &ipc_token_bytes,
                                &hk,
                                h.as_ref(),
                            );
                            if should_shutdown {
                                stop_conn.store(true, Ordering::Relaxed);
                            }
                        });
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(4));
                    }
                    Err(_) => {
                        thread::sleep(Duration::from_millis(10));
                    }
                }
            }
            let _ = fs::remove_file(&cleanup_sock);
        });
        (Some(sock_path), Some(join))
    } else {
        (None, None)
    };

    #[cfg(not(unix))]
    let bound_uds_path: Option<PathBuf> = {
        let _ = (unix_socket_path, hook_tokens);
        None
    };

    Ok(LocalIpcServerHandle {
        http_addr: actual_http_addr,
        unix_socket_path: bound_uds_path,
        stop,
        tcp_join: Some(tcp_join),
        #[cfg(unix)]
        uds_join,
    })
}

fn serve_single_ipc_stream<S: Read + Write, H: IpcHandler + ?Sized>(
    stream: &mut S,
    expected_token_bytes: &[u8; 32],
    hook_tokens: &ScopedHookTokenRegistry,
    handler: &H,
) -> bool {
    let parsed = match read_ipc_http_request(stream) {
        Ok(r) => r,
        Err(err) => {
            write_ipc_http_json(
                stream,
                400,
                &IpcResponse::Error {
                    code: String::from(err.code().as_str()),
                    detail: err.to_string(),
                },
            );
            return false;
        }
    };

    let host_hdr = find_ipc_header(&parsed.headers, "host");
    let origin_hdr = find_ipc_header(&parsed.headers, "origin");
    if let Err(rebind_reason) = validate_loopback_host_and_origin(host_hdr, origin_hdr) {
        write_ipc_http_json(
            stream,
            403,
            &IpcResponse::Error {
                code: String::from("PERMISSION_DENIED"),
                detail: rebind_reason,
            },
        );
        return false;
    }

    let provided_tok_str = find_ipc_header(&parsed.headers, "x-qz-ipc-token").or_else(|| {
        find_ipc_header(&parsed.headers, "authorization").and_then(|v| {
            v.strip_prefix("Bearer ")
                .or_else(|| v.strip_prefix("bearer "))
        })
    });
    let (cand_tok, syntax_ok) = match provided_tok_str {
        Some(t) => decode_hex_32_constant(t),
        None => ([0u8; 32], false),
    };
    let is_master = syntax_ok && constant_time_eq_32(&cand_tok, expected_token_bytes);
    let scoped_run = hook_tokens.match_constant_time(&cand_tok, syntax_ok);

    let caller_auth = if is_master {
        IpcCallerAuth::MasterAdmin
    } else if let Some(rid) = scoped_run {
        IpcCallerAuth::ScopedWorkerHook(rid)
    } else {
        write_ipc_http_json(
            stream,
            401,
            &IpcResponse::Error {
                code: String::from("CREDENTIAL_REJECTED"),
                detail: String::from("missing or invalid x-qz-ipc-token"),
            },
        );
        return false;
    };

    if parsed.target == "/v1/health" {
        if caller_auth != IpcCallerAuth::MasterAdmin {
            write_ipc_http_json(
                stream,
                403,
                &IpcResponse::Error {
                    code: String::from("PERMISSION_DENIED"),
                    detail: String::from("run-scoped hook token cannot access admin health"),
                },
            );
            return false;
        }
        let (resp, _) = handler.handle(IpcRequest::Status);
        write_ipc_http_json(stream, 200, &resp);
        return false;
    }

    let rpc_req: IpcRequest = match serde_json::from_slice(&parsed.body) {
        Ok(r) => r,
        Err(e) => {
            write_ipc_http_json(
                stream,
                400,
                &IpcResponse::Error {
                    code: String::from("SERIALIZATION_ERROR"),
                    detail: format!("invalid IPC request JSON: {e}"),
                },
            );
            return false;
        }
    };

    // 单次 Run 受限钩子令牌仅允许拉取压缩重钉扎良知 (ConsciencePinned) 与上报 <ewave_check>，严禁执行管理员动作！
    if let IpcCallerAuth::ScopedWorkerHook(_run_id) = caller_auth
        && !matches!(
            rpc_req,
            IpcRequest::ConsciencePinned | IpcRequest::EwaveCheckReport { .. }
        )
    {
        write_ipc_http_json(
            stream,
            403,
            &IpcResponse::Error {
                code: String::from("PERMISSION_DENIED"),
                detail: String::from(
                    "run-scoped Worker hook token is forbidden from invoking privileged daemon RPC",
                ),
            },
        );
        return false;
    }

    let (resp, should_shutdown) = handler.handle(rpc_req);
    write_ipc_http_json(stream, 200, &resp);
    should_shutdown
}

struct ParsedIpcHttp {
    target: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

fn find_ipc_header<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
    headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case(name))
        .map(|(_, v)| v.as_str())
}

fn read_ipc_http_request<R: Read>(stream: &mut R) -> Result<ParsedIpcHttp> {
    let mut buf = Vec::with_capacity(1024);
    let mut chunk = [0u8; 2048];
    let header_end = loop {
        if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break pos;
        }
        if buf.len() > MAX_IPC_HEADER_BYTES {
            return Err(QuetzalcoatlError::CredentialRejected {
                detail: String::from("IPC HTTP header too large"),
            });
        }
        let n = stream
            .read(&mut chunk)
            .map_err(|e| QuetzalcoatlError::StorageError {
                detail: format!("IPC read error: {e}"),
            })?;
        if n == 0 {
            return Err(QuetzalcoatlError::CredentialRejected {
                detail: String::from("IPC connection closed before header end"),
            });
        }
        buf.extend_from_slice(&chunk[..n]);
    };

    let head = std::str::from_utf8(&buf[..header_end]).map_err(|_| {
        QuetzalcoatlError::SerializationError {
            detail: String::from("non-UTF8 IPC HTTP header"),
        }
    })?;
    let mut lines = head.split("\r\n");
    let req_line = lines
        .next()
        .ok_or_else(|| QuetzalcoatlError::SerializationError {
            detail: String::from("empty request line"),
        })?;
    let target = req_line
        .split_whitespace()
        .nth(1)
        .unwrap_or("/v1/rpc")
        .to_owned();

    let mut headers = Vec::new();
    let mut content_len = 0usize;
    for line in lines {
        if let Some((k, v)) = line.split_once(':') {
            let name = k.trim();
            let val = v.trim();
            if name.eq_ignore_ascii_case("content-length") {
                content_len =
                    val.parse::<usize>()
                        .map_err(|_| QuetzalcoatlError::SerializationError {
                            detail: String::from("invalid Content-Length"),
                        })?;
                if content_len > MAX_IPC_BODY_BYTES {
                    return Err(QuetzalcoatlError::CredentialRejected {
                        detail: String::from("IPC request body too large"),
                    });
                }
            }
            headers.push((String::from(name), String::from(val)));
        }
    }

    let body_start = header_end + 4;
    let mut body = Vec::with_capacity(content_len);
    if buf.len() > body_start {
        let take = (buf.len() - body_start).min(content_len);
        body.extend_from_slice(&buf[body_start..body_start + take]);
    }
    while body.len() < content_len {
        let want = (content_len - body.len()).min(chunk.len());
        let n = stream
            .read(&mut chunk[..want])
            .map_err(|e| QuetzalcoatlError::StorageError {
                detail: format!("IPC body read error: {e}"),
            })?;
        if n == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..n]);
    }

    Ok(ParsedIpcHttp {
        target,
        headers,
        body,
    })
}

fn ipc_status_reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        500 => "Internal Server Error",
        _ => "Response",
    }
}

fn write_ipc_http_json<W: Write>(stream: &mut W, status: u16, resp: &IpcResponse) {
    let body = serde_json::to_vec(resp).unwrap_or_else(|_| b"{\"kind\":\"error\"}".to_vec());
    let head = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        status,
        ipc_status_reason(status),
        body.len()
    );
    let _ = stream.write_all(head.as_bytes());
    let _ = stream.write_all(&body);
    let _ = stream.flush();
}

/// 薄客户端本地 IPC 调用器（优先走 POSIX `0600` Unix Domain Socket，回退 `127.0.0.1` 回环 TCP）。
pub struct IpcClient {
    http_addr: SocketAddr,
    unix_socket: Option<PathBuf>,
    ipc_token: String,
}

impl IpcClient {
    pub fn connect_from_home(qz_home: &Path) -> Result<Option<Self>> {
        let info_path = qz_home.join("run/daemon.json");
        let token_path = qz_home.join("run/daemon.token");
        if !info_path.is_file() || !token_path.is_file() {
            return Ok(None);
        }
        let Ok(raw_info) = fs::read(&info_path) else {
            return Ok(None);
        };
        let Ok(info) = serde_json::from_slice::<DaemonRuntimeInfo>(&raw_info) else {
            return Ok(None);
        };
        let Ok(raw_tok) = fs::read_to_string(&token_path) else {
            return Ok(None);
        };
        let client = Self::from_runtime_info(&info, raw_tok.trim().to_owned());
        match client.call(&IpcRequest::Status) {
            Ok(IpcResponse::Status(_)) => Ok(Some(client)),
            _ => Ok(None),
        }
    }

    #[must_use]
    pub fn from_runtime_info(info: &DaemonRuntimeInfo, ipc_token: String) -> Self {
        Self {
            http_addr: info.ipc_http_addr,
            unix_socket: info.unix_socket_path.clone(),
            ipc_token,
        }
    }

    pub fn call(&self, req: &IpcRequest) -> Result<IpcResponse> {
        let body = serde_json::to_vec(req).map_err(|e| QuetzalcoatlError::SerializationError {
            detail: format!("序列化 IPC 请求失败: {e}"),
        })?;

        #[cfg(unix)]
        if let Some(sock) = &self.unix_socket
            && let Ok(mut ustream) = UnixStream::connect(sock)
        {
            let _ = ustream.set_read_timeout(Some(Duration::from_secs(30)));
            let _ = ustream.set_write_timeout(Some(Duration::from_secs(30)));
            return self.roundtrip_over_stream(&mut ustream, "127.0.0.1", &body);
        }

        let mut tcp =
            TcpStream::connect_timeout(&self.http_addr, Duration::from_secs(3)).map_err(|e| {
                QuetzalcoatlError::StorageError {
                    detail: format!("连接本机 quetzalcoatld IPC ({}) 失败: {e}", self.http_addr),
                }
            })?;
        let _ = tcp.set_read_timeout(Some(Duration::from_secs(30)));
        let _ = tcp.set_write_timeout(Some(Duration::from_secs(30)));
        let host_hdr = self.http_addr.to_string();
        self.roundtrip_over_stream(&mut tcp, &host_hdr, &body)
    }

    fn roundtrip_over_stream<S: Read + Write>(
        &self,
        stream: &mut S,
        host_hdr: &str,
        body: &[u8],
    ) -> Result<IpcResponse> {
        let head = format!(
            "POST /v1/rpc HTTP/1.1\r\nHost: {host_hdr}\r\nx-qz-ipc-token: {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            self.ipc_token,
            body.len()
        );
        stream
            .write_all(head.as_bytes())
            .and_then(|()| stream.write_all(body))
            .and_then(|()| stream.flush())
            .map_err(|e| QuetzalcoatlError::StorageError {
                detail: format!("发送本地 IPC 请求失败: {e}"),
            })?;

        let mut resp_bytes = Vec::new();
        stream
            .read_to_end(&mut resp_bytes)
            .map_err(|e| QuetzalcoatlError::StorageError {
                detail: format!("读取本地 IPC 响应失败: {e}"),
            })?;
        let sep = resp_bytes
            .windows(4)
            .position(|w| w == b"\r\n\r\n")
            .ok_or_else(|| QuetzalcoatlError::SerializationError {
                detail: String::from("本地 IPC HTTP 响应格式非法"),
            })?;
        serde_json::from_slice::<IpcResponse>(&resp_bytes[sep + 4..]).map_err(|e| {
            QuetzalcoatlError::SerializationError {
                detail: format!("解析本地 IPC 响应 JSON 失败: {e}"),
            }
        })
    }
}
