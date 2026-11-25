#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]

//! `quetzalcoatld` 的 `quetzalcoatl-fabric` 可选接入层：`iroh` 节点、两态围栏租约、密文 Packfile 同步、
//! Hub 认证会话（`OPAQUE` PIN / Bearer 令牌）、抗量子 `X-Wing` 设备配对与跨机 Worker 能力广播。
//!
//! 安全边界：本模块只做**可选**接入，默认完全关闭（不建节点、不写文件、不发任何网络包）；
//! 会话令牌仅以 `0600` 权限落盘（`$QUETZALCOATL_HOME/fabric/hub_session.json`），
//! 任何 `status` / `nodes` 输出与日志都绝不包含令牌、PIN 或私钥材料。

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use std::future::Future;
use std::pin::Pin;

use quetzalcoatl_crypto::{
    AccountRootKey, DeviceIdentity, DevicePublicRecord, EpochKey, EpochKeyRing, SealedPackfile,
    XWING_PK_LEN, hex_decode, hex_decode_fixed, hex_encode,
};
use quetzalcoatl_fabric::{
    FabricNode, FabricNodeConfig, FabricRelaySettings, FabricRpcHandler, FabricRpcRequest,
    FabricRpcResponse, FencedLeaseCoordinator, HubClient, HubClientConfig, LeaseCoordinatorConfig,
    LeaseWitnessBackend, LeaseWitnessRecord, NodeCapabilityAnnouncement, NodeCapabilitySpec,
    OutboxReconcileOutcome, OutboxReconcilePlan, PairHpkeBundle, PeerPathKind, PeerSyncOutcome,
    PeerSyncPlan, RemoteWorkerPool, RouterLeaseState, SpineSyncActor, SpineSyncBackend,
    StdMonotonicClock, WebhookIngressBatch, WebhookIngressStatus,
    enforce_remote_worker_lease_fence, execute_remote_worker_task_locally,
    parse_ca_certs_pem_or_der,
};
use quetzalcoatl_kernel::{LeasePosture, OutboxItem};
use quetzalcoatl_spine::MaterializedStore;
use quetzalcoatl_types::{AgentId, ArtifactId, DeviceId, Epoch, QuetzalcoatlError, Result};
use serde::{Deserialize, Serialize};

use crate::daemon::{SharedDaemonCore, now_unix_ms, write_private_file};

const FABRIC_SESSION_REL_PATH: &str = "fabric/hub_session.json";
const FABRIC_JOINER_REL_PATH: &str = "fabric/pending_joiner.json";
const FABRIC_HUB_CALL_TIMEOUT: Duration = Duration::from_secs(3);
const DEFAULT_QAD_PORT: u16 = 7842;
const FABRIC_PAIRINGS_REL_PATH: &str = "fabric/pairing_sessions.json";
const MAX_TRACKED_PAIRINGS: usize = 16;

pub(crate) type SharedCoreSlot = Arc<Mutex<Option<Weak<SharedDaemonCore>>>>;

/// 守护进程侧 `quetzalcoatl-fabric` 接入配置（默认 `None` 即完全关闭）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DaemonFabricConfig {
    pub hub_url: String,
    pub hub_ca_file: Option<PathBuf>,
    pub relay_url: String,
    pub qad_port: u16,
    pub enable_mdns: bool,
    /// 心跳周期（毫秒），生产默认 5000；测试可调低以缩短收敛等待。
    pub tick_interval_ms: u64,
}

fn env_map(pairs: &[(String, String)]) -> BTreeMap<&str, &str> {
    pairs
        .iter()
        .map(|(k, v)| (k.as_str(), v.as_str()))
        .collect()
}

impl DaemonFabricConfig {
    /// 从 `QUETZALCOATL_FABRIC_*` 环境变量解析（纯函数，便于单元测试且不触碰进程环境）。
    #[must_use]
    pub fn from_env_pairs(pairs: &[(String, String)]) -> Option<Self> {
        let map = env_map(pairs);
        let hub_url = map
            .get("QUETZALCOATL_FABRIC_HUB_URL")
            .map(|v| v.trim())
            .filter(|v| !v.is_empty())?
            .to_owned();
        let relay_url = map
            .get("QUETZALCOATL_FABRIC_RELAY_URL")
            .map(|v| v.trim())
            .filter(|v| !v.is_empty())
            .map_or_else(|| hub_url.clone(), String::from);
        let qad_port = map
            .get("QUETZALCOATL_FABRIC_QAD_PORT")
            .and_then(|v| v.trim().parse::<u16>().ok())
            .filter(|p| *p > 0)
            .unwrap_or(DEFAULT_QAD_PORT);
        let hub_ca_file = map
            .get("QUETZALCOATL_FABRIC_HUB_CA_FILE")
            .map(|v| v.trim())
            .filter(|v| !v.is_empty())
            .map(PathBuf::from);
        let enable_mdns = map
            .get("QUETZALCOATL_FABRIC_MDNS")
            .is_none_or(|v| !matches!(v.trim(), "0" | "false" | "FALSE" | "off"));
        let tick_interval_ms = map
            .get("QUETZALCOATL_FABRIC_TICK_MS")
            .and_then(|v| v.trim().parse::<u64>().ok())
            .filter(|v| *v >= 100)
            .unwrap_or(5_000);
        Some(Self {
            hub_url,
            hub_ca_file,
            relay_url,
            qad_port,
            enable_mdns,
            tick_interval_ms,
        })
    }

    #[must_use]
    pub fn from_env() -> Option<Self> {
        let pairs: Vec<(String, String)> = std::env::vars().collect();
        Self::from_env_pairs(&pairs)
    }

    /// 读取既有 Hub 会话后重建配置（守护进程重启后自动续用同一 Hub，避免重复登录）。
    #[must_use]
    pub fn from_persisted_session(session: &PersistedFabricSession) -> Self {
        Self {
            hub_url: session.hub_url.clone(),
            hub_ca_file: session.hub_ca_file.clone(),
            relay_url: session.relay_url.clone(),
            qad_port: session.qad_port,
            enable_mdns: true,
            tick_interval_ms: 5_000,
        }
    }

    /// 进程启动时优先使用显式环境变量，其次回退到已落盘 Hub 会话。
    #[must_use]
    pub fn resolve(qz_home: &Path) -> Option<Self> {
        Self::from_env()
            .or_else(|| load_persisted_session(qz_home).map(|s| Self::from_persisted_session(&s)))
    }
}

/// 已认证 `quetzalcoatl-hub` 会话（含令牌，文件权限严格 `0600`，绝不出现在 IPC 状态回执中）。
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PersistedFabricSession {
    pub hub_url: String,
    pub hub_ca_file: Option<PathBuf>,
    pub relay_url: String,
    pub qad_port: u16,
    pub session_token: String,
    pub account_id: String,
    pub agent_id: AgentId,
    pub device_id: DeviceId,
}

fn load_json_private<T: for<'de> Deserialize<'de>>(path: &Path) -> Option<T> {
    let raw = fs::read(path).ok()?;
    serde_json::from_slice(&raw).ok()
}

#[must_use]
pub fn load_persisted_session(qz_home: &Path) -> Option<PersistedFabricSession> {
    load_json_private(&qz_home.join(FABRIC_SESSION_REL_PATH))
}

fn save_persisted_session(qz_home: &Path, session: &PersistedFabricSession) -> Result<()> {
    let bytes =
        serde_json::to_vec_pretty(session).map_err(|e| QuetzalcoatlError::SerializationError {
            detail: format!("编码 fabric Hub 会话失败: {e}"),
        })?;
    write_private_file(&qz_home.join(FABRIC_SESSION_REL_PATH), &bytes)
}

#[derive(Default, Serialize, Deserialize)]
struct PersistedMembershipState {
    #[serde(default)]
    extra_epoch_keys: Vec<(u64, String)>,
    #[serde(default)]
    peer_devices: Vec<DevicePublicRecord>,
}

const FABRIC_MEMBERSHIP_REL_PATH: &str = "fabric/membership_state.json";

/// 把损坏/被篡改的成员状态文件移出原路径并留下 `<file>.corrupt-<unix_ms>` 隔离副本。
/// 仅记录路径与原因分类，绝不打印文件内容（其中可能含纪元密钥）。
fn quarantine_membership_state(qz_home: &Path, reason: &str) {
    let source = qz_home.join(FABRIC_MEMBERSHIP_REL_PATH);
    let dest = qz_home.join(format!(
        "{FABRIC_MEMBERSHIP_REL_PATH}.corrupt-{}",
        now_unix_ms()
    ));
    match fs::rename(&source, &dest) {
        Ok(()) => eprintln!(
            "quetzalcoatld WARN fabric_membership_quarantined path={} reason={reason}",
            dest.display()
        ),
        Err(e) => eprintln!(
            "quetzalcoatld WARN fabric_membership_quarantine_failed path={} reason={reason} io={e}",
            source.display()
        ),
    }
}

fn decode_membership_state(qz_home: &Path) -> Option<PersistedMembershipState> {
    let path = qz_home.join(FABRIC_MEMBERSHIP_REL_PATH);
    let raw = match fs::read(&path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return None,
        Err(_) => {
            quarantine_membership_state(qz_home, "unreadable");
            return None;
        }
    };
    match serde_json::from_slice::<PersistedMembershipState>(&raw) {
        Ok(state) => Some(state),
        Err(_) => {
            quarantine_membership_state(qz_home, "decode_error");
            None
        }
    }
}

/// 启动时把已持久化的成员变更（新增设备 + 踢人后的新纪元密钥）重放进本地 `EpochKeyRing`。
/// 每次重放都会用根密钥重新签发成员变更审计记录，因此无需持久化易失效的旧签名。
///
/// 安全失败语义（Fix Round 2 / Item 4）：文件损坏或被篡改时隔离该文件并以"无额外成员"安全回退，
/// 绝不让伪造/半损坏的成员状态阻断守护进程启动；所有条目先整体校验再应用，避免半途污染。
pub(crate) fn apply_persisted_membership(
    qz_home: &Path,
    ring: &mut EpochKeyRing,
    root_key: &AccountRootKey,
) -> Result<()> {
    let Some(state) = decode_membership_state(qz_home) else {
        return Ok(());
    };

    let mut epoch_keys = Vec::new();
    for (epoch, key_hex) in &state.extra_epoch_keys {
        if *epoch <= 1 {
            continue;
        }
        match hex_decode_fixed::<32>("membership.extra_epoch_key", key_hex) {
            Ok(bytes) => epoch_keys.push((*epoch, EpochKey::from_bytes(bytes))),
            Err(_) => {
                quarantine_membership_state(qz_home, "invalid_epoch_key");
                return Ok(());
            }
        }
    }
    let mut peer_devices = Vec::new();
    for record in &state.peer_devices {
        if record.xwing_pubkey.len() != XWING_PK_LEN {
            quarantine_membership_state(qz_home, "invalid_device_record");
            return Ok(());
        }
        peer_devices.push(record.clone());
    }

    for (epoch, key) in epoch_keys {
        ring.insert_epoch_key(Epoch::new(epoch), key);
    }
    for record in peer_devices {
        if !ring.is_device_active(record.device_id) && ring.add_device(root_key, record).is_err() {
            quarantine_membership_state(qz_home, "apply_failed");
            return Ok(());
        }
    }
    Ok(())
}

/// 持久化当前活跃成员设备（不含本机）与踢人轮换后的全部纪元密钥；文件权限严格 `0600`。
pub(crate) fn persist_membership(
    qz_home: &Path,
    ring: &EpochKeyRing,
    local_device: DeviceId,
) -> Result<()> {
    let mut extra_epoch_keys = Vec::new();
    for epoch in 2..=ring.current_epoch().get() {
        if let Some(key) = ring.epoch_key(Epoch::new(epoch)) {
            extra_epoch_keys.push((epoch, hex_encode(key.as_bytes())));
        }
    }
    let peer_devices: Vec<DevicePublicRecord> = ring
        .active_devices()
        .iter()
        .filter(|(id, _)| **id != local_device)
        .map(|(_, rec)| rec.clone())
        .collect();
    let state = PersistedMembershipState {
        extra_epoch_keys,
        peer_devices,
    };
    let bytes =
        serde_json::to_vec_pretty(&state).map_err(|e| QuetzalcoatlError::SerializationError {
            detail: format!("编码 fabric 成员状态失败: {e}"),
        })?;
    write_private_file(&qz_home.join(FABRIC_MEMBERSHIP_REL_PATH), &bytes)
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct PersistedJoinerIdentity {
    agent_id: AgentId,
    device_id: DeviceId,
    ed25519_seed_hex: String,
    xwing_seed_hex: String,
}

fn load_or_create_joiner_identity(qz_home: &Path, agent_id: AgentId) -> Result<DeviceIdentity> {
    let path = qz_home.join(FABRIC_JOINER_REL_PATH);
    if let Some(p) = load_json_private::<PersistedJoinerIdentity>(&path) {
        let ed = hex_decode_fixed::<32>("joiner.ed25519_seed_hex", &p.ed25519_seed_hex)?;
        let xw = hex_decode_fixed::<32>("joiner.xwing_seed_hex", &p.xwing_seed_hex)?;
        return DeviceIdentity::from_seeds(p.device_id, ed, xw);
    }
    let identity = DeviceIdentity::generate(DeviceId::new_v4())?;
    let persisted = PersistedJoinerIdentity {
        agent_id,
        device_id: identity.device_id(),
        ed25519_seed_hex: hex_encode(identity.ed25519_seed()),
        xwing_seed_hex: hex_encode(identity.xwing_seed()),
    };
    let bytes = serde_json::to_vec_pretty(&persisted).map_err(|e| {
        QuetzalcoatlError::SerializationError {
            detail: format!("编码待配对设备身份失败: {e}"),
        }
    })?;
    write_private_file(&path, &bytes)?;
    DeviceIdentity::from_seeds(
        identity.device_id(),
        *identity.ed25519_seed(),
        *identity.xwing_seed(),
    )
}

/// `qz login` 请求载荷。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct FabricLoginRequest {
    pub hub_url: String,
    pub token: Option<String>,
    pub ca_file: Option<PathBuf>,
    pub pin: Option<String>,
    pub agent_id: Option<AgentId>,
    pub device_id: Option<DeviceId>,
}

/// `qz login` 结果（零令牌泄漏）。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct FabricLoginResult {
    pub hub_url: String,
    pub agent_id: AgentId,
    pub device_id: DeviceId,
    pub account_id: String,
    pub auth_mode: String,
    pub lease: String,
    pub witness_epoch: u64,
    pub peer_count: usize,
}

/// `qz pair start` 结果（含 X-Wing 收件人公钥，供二维码承载）。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct FabricPairStartResult {
    pub hub_url: String,
    pub agent_id: AgentId,
    pub pairing_id: String,
    pub short_code: String,
    pub pair_code: String,
    pub expires_at_ms: i64,
    pub xwing_recipient_public_key_hex: String,
}

/// `qz pair join` 结果。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct FabricPairJoinResult {
    pub pairing_id: String,
    pub joiner_device_id: DeviceId,
    pub hub_url: String,
}

/// `qz pair approve` 结果（含 Slot 2 X-Wing HPKE 密文信封）。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct FabricPairApproveResult {
    pub pairing_id: String,
    pub joiner_device_id: DeviceId,
    pub slot2_aad_utf8: String,
    pub slot2_nonce_hex: String,
    pub slot2_ciphertext_hex: String,
    pub slot2_hpke_enc_hex: String,
}

/// `qz pair revoke` 结果（踢人后纪元已前向轮换）。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct FabricRevokeResult {
    pub device_id: DeviceId,
    pub new_epoch: u64,
}

impl From<PairHpkeBundle> for FabricPairApproveResult {
    fn from(b: PairHpkeBundle) -> Self {
        Self {
            pairing_id: b.pairing_id,
            joiner_device_id: b.joiner_device_id,
            slot2_aad_utf8: b.slot2_aad_utf8,
            slot2_nonce_hex: b.slot2_nonce_hex,
            slot2_ciphertext_hex: b.slot2_ciphertext_hex,
            slot2_hpke_enc_hex: b.slot2_hpke_enc_hex,
        }
    }
}

/// `qz status` 中的 fabric 段落。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct FabricStatus {
    pub enabled: bool,
    pub logged_in: bool,
    pub hub_url: Option<String>,
    pub peer_count: usize,
    pub lease: String,
    pub witness_epoch: Option<u64>,
    pub highest_seen_epoch: u64,
    pub last_sync_cursor: u64,
    pub endpoint_id_hex: Option<String>,
    pub qad_port: Option<u16>,
}

impl FabricStatus {
    #[must_use]
    pub fn disabled() -> Self {
        Self {
            enabled: false,
            logged_in: false,
            hub_url: None,
            peer_count: 0,
            lease: String::from("disabled"),
            witness_epoch: None,
            highest_seen_epoch: 0,
            last_sync_cursor: 0,
            endpoint_id_hex: None,
            qad_port: None,
        }
    }
}

/// `qz nodes` 单行节点视图（`direct` / `relay` / `disconnected` / `self`）。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct FabricPeerRow {
    pub device_id: String,
    pub endpoint_id_hex: String,
    pub role: String,
    pub authorized: bool,
    pub path_kind: String,
    pub path_detail: String,
    pub capability_tags: Vec<String>,
    pub available_harnesses: Vec<String>,
    pub os: String,
    pub arch: String,
    pub sandbox_available: bool,
    pub active_workers: u32,
    pub max_workers: u32,
}

/// `qz nodes` 汇总视图。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct FabricNodesReport {
    pub enabled: bool,
    pub hub_url: Option<String>,
    pub local_device_id: Option<DeviceId>,
    pub local_endpoint_id_hex: Option<String>,
    pub router_holder: Option<DeviceId>,
    pub witness_epoch: u64,
    pub lease: String,
    pub last_sync_cursor: u64,
    pub peers: Vec<FabricPeerRow>,
}

impl FabricNodesReport {
    #[must_use]
    pub fn disabled() -> Self {
        Self {
            enabled: false,
            hub_url: None,
            local_device_id: None,
            local_endpoint_id_hex: None,
            router_holder: None,
            witness_epoch: 0,
            lease: String::from("disabled"),
            last_sync_cursor: 0,
            peers: Vec::new(),
        }
    }
}

fn router_holder(state: &RouterLeaseState, local: DeviceId) -> Option<DeviceId> {
    match state {
        RouterLeaseState::ActiveRouter { .. } => Some(local),
        RouterLeaseState::Standby { known_holder, .. } => *known_holder,
        RouterLeaseState::PartitionLocal { .. } => None,
    }
}

fn lock_or_storage<T>(m: &Mutex<T>) -> Result<std::sync::MutexGuard<'_, T>> {
    m.lock().map_err(|_| QuetzalcoatlError::StorageError {
        detail: String::from("fabric 运行时锁异常"),
    })
}

/// 单次心跳阶段 0 的只读快照（内核锁内构造，随后全程零锁使用）。
struct SyncSnapshot {
    agent_id: AgentId,
    local_device: DeviceId,
    local_packs: Vec<SealedPackfile>,
    existing: BTreeSet<ArtifactId>,
    peer_plan: PeerSyncPlan,
}

/// 最近一次租约心跳的只读快照（供 `qz status` / `qz nodes` 非阻塞读取，绝不与心跳线程抢锁）。
#[derive(Clone, Debug, Default)]
struct LeaseView {
    label: String,
    witness_epoch: Option<u64>,
    highest_seen_epoch: u64,
    holder: Option<DeviceId>,
}

fn capture_lease_view(
    coordinator: &FencedLeaseCoordinator<StdMonotonicClock>,
    local_device: DeviceId,
) -> LeaseView {
    let (label, witness_epoch) = match coordinator.state() {
        RouterLeaseState::ActiveRouter { witness_epoch, .. } => {
            (String::from("witnessed"), Some(witness_epoch.get()))
        }
        RouterLeaseState::Standby { .. } => (String::from("standby"), None),
        RouterLeaseState::PartitionLocal { .. } => (String::from("partition_local"), None),
    };
    LeaseView {
        label,
        witness_epoch,
        highest_seen_epoch: coordinator.highest_seen_epoch(),
        holder: router_holder(coordinator.state(), local_device),
    }
}

/// `quetzalcoatl-hub` 调用硬超时垫片：Hub 不可达时最多阻塞 `FABRIC_HUB_CALL_TIMEOUT`，
/// 避免心跳线程在断网时长期霸占守护进程内核锁。
struct BoundedHub {
    hub: HubClient,
}

impl BoundedHub {
    fn new(hub: HubClient) -> Self {
        Self { hub }
    }

    async fn bound<T>(fut: impl Future<Output = Result<T>>) -> Result<T> {
        match tokio::time::timeout(FABRIC_HUB_CALL_TIMEOUT, fut).await {
            Ok(res) => res,
            Err(_) => Err(QuetzalcoatlError::StorageError {
                detail: String::from("quetzalcoatl-hub 调用超时（网络分区或不可达）"),
            }),
        }
    }
}

impl BoundedHub {
    async fn list_fabric_peers(
        &self,
        agent_id: AgentId,
    ) -> Result<Vec<quetzalcoatl_fabric::FabricPeerEndpoint>> {
        Self::bound(self.hub.list_fabric_peers(agent_id)).await
    }
}

impl LeaseWitnessBackend for BoundedHub {
    fn acquire_lease<'a>(
        &'a self,
        agent_id: AgentId,
        device_id: DeviceId,
        expected_epoch: u64,
        ttl_ms: u64,
    ) -> Pin<Box<dyn Future<Output = Result<LeaseWitnessRecord>> + Send + 'a>> {
        Box::pin(Self::bound(HubClient::acquire_lease(
            &self.hub,
            agent_id,
            device_id,
            expected_epoch,
            ttl_ms,
        )))
    }

    fn renew_lease<'a>(
        &'a self,
        agent_id: AgentId,
        device_id: DeviceId,
        witness_epoch: u64,
        ttl_ms: u64,
    ) -> Pin<Box<dyn Future<Output = Result<LeaseWitnessRecord>> + Send + 'a>> {
        Box::pin(Self::bound(HubClient::renew_lease(
            &self.hub,
            agent_id,
            device_id,
            witness_epoch,
            ttl_ms,
        )))
    }

    fn release_lease<'a>(
        &'a self,
        agent_id: AgentId,
        device_id: DeviceId,
        witness_epoch: u64,
    ) -> Pin<Box<dyn Future<Output = Result<LeaseWitnessRecord>> + Send + 'a>> {
        Box::pin(Self::bound(HubClient::release_lease(
            &self.hub,
            agent_id,
            device_id,
            witness_epoch,
        )))
    }
}

impl SpineSyncBackend for BoundedHub {
    fn upload_pack<'a>(
        &'a self,
        agent_id: AgentId,
        _device_id: DeviceId,
        pack: &'a SealedPackfile,
    ) -> Pin<Box<dyn Future<Output = Result<u64>> + Send + 'a>> {
        Box::pin(Self::bound(HubClient::upload_packfile(
            &self.hub, agent_id, pack,
        )))
    }

    fn fetch_packs_after<'a>(
        &'a self,
        agent_id: AgentId,
        _device_id: DeviceId,
        after_seq: u64,
    ) -> Pin<Box<dyn Future<Output = Result<(u64, Vec<SealedPackfile>)>> + Send + 'a>> {
        Box::pin(Self::bound(HubClient::list_and_download_packfiles(
            &self.hub, agent_id, after_seq, 200,
        )))
    }
}

/// `tick_inflight` 原子门闩的 RAII 复位器（任何提前返回都会解除占用）。
struct TickInflightGuard<'a>(&'a AtomicBool);

impl Drop for TickInflightGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

/// 本机发起的配对会话（仅存短码用于本地二次校验，绝不含根密钥材料）。
#[derive(Clone, Debug, Serialize, Deserialize)]
struct PersistedPairingSession {
    pairing_id: String,
    short_code: String,
    expires_at_ms: i64,
}

fn load_tracked_pairings(qz_home: &Path) -> Vec<PersistedPairingSession> {
    load_json_private::<Vec<PersistedPairingSession>>(&qz_home.join(FABRIC_PAIRINGS_REL_PATH))
        .unwrap_or_default()
}

fn track_pairing(qz_home: &Path, new_session: &PersistedPairingSession) -> Result<()> {
    let mut sessions = load_tracked_pairings(qz_home);
    sessions.retain(|s| s.pairing_id != new_session.pairing_id);
    sessions.push(new_session.clone());
    if sessions.len() > MAX_TRACKED_PAIRINGS {
        let excess = sessions.len() - MAX_TRACKED_PAIRINGS;
        sessions.drain(0..excess);
    }
    let bytes = serde_json::to_vec_pretty(&sessions).map_err(|e| {
        QuetzalcoatlError::SerializationError {
            detail: format!("编码本机配对会话索引失败: {e}"),
        }
    })?;
    write_private_file(&qz_home.join(FABRIC_PAIRINGS_REL_PATH), &bytes)
}

fn validate_pair_code_locally(qz_home: &Path, pairing_id: &str, short_code: &str) -> Result<()> {
    let Some(tracked) = load_tracked_pairings(qz_home)
        .into_iter()
        .find(|s| s.pairing_id == pairing_id)
    else {
        return Ok(());
    };
    if tracked.short_code != short_code {
        return Err(QuetzalcoatlError::CredentialRejected {
            detail: String::from("配对短码与本机发起记录不匹配"),
        });
    }
    let now_ms = now_unix_ms();
    #[allow(clippy::cast_possible_wrap)]
    let now_i64 = now_ms as i64;
    if tracked.expires_at_ms <= now_i64 {
        return Err(QuetzalcoatlError::CredentialRejected {
            detail: String::from("配对会话已过期，请重新执行 `qz pair start`"),
        });
    }
    Ok(())
}

/// 守护进程独占的 fabric 运行时（自有 `tokio` 运行时 + `iroh` 节点 + 围栏租约 + 同步器 + 能力池）。
pub(crate) struct DaemonFabricRuntime {
    rt: tokio::runtime::Runtime,
    node: FabricNode,
    config: Mutex<DaemonFabricConfig>,
    ca_certs_der: Mutex<Vec<Vec<u8>>>,
    announcement: NodeCapabilityAnnouncement,
    session: Mutex<Option<PersistedFabricSession>>,
    lease: Mutex<FencedLeaseCoordinator<StdMonotonicClock>>,
    sync: Mutex<SpineSyncActor>,
    pool: Mutex<RemoteWorkerPool>,
    last_sync_cursor: AtomicU64,
    lease_view: Mutex<LeaseView>,
    tick_inflight: AtomicBool,
    core_slot: SharedCoreSlot,
    stop: Arc<AtomicBool>,
    ticker: Mutex<Option<JoinHandle<()>>>,
}

struct FabricBootInput {
    config: DaemonFabricConfig,
    agent_id: AgentId,
    device: DeviceIdentity,
    epoch_ring: EpochKeyRing,
    capability_spec: NodeCapabilitySpec,
    core_slot: SharedCoreSlot,
    persisted_session: Option<PersistedFabricSession>,
}

fn read_ca_certs(config: &DaemonFabricConfig) -> Result<Vec<Vec<u8>>> {
    let Some(path) = &config.hub_ca_file else {
        return Ok(Vec::new());
    };
    let raw = fs::read(path).map_err(|e| QuetzalcoatlError::StorageError {
        detail: format!("读取 Hub CA 证书失败 ({}): {e}", path.display()),
    })?;
    parse_ca_certs_pem_or_der(&raw)
}

impl DaemonFabricRuntime {
    fn boot(input: FabricBootInput) -> Result<Arc<Self>> {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .thread_name("quetzalcoatld-fabric")
            .enable_all()
            .build()
            .map_err(|e| QuetzalcoatlError::StorageError {
                detail: format!("创建 fabric tokio 运行时失败: {e}"),
            })?;

        let ca_certs_der = read_ca_certs(&input.config)?;
        let announcement = NodeCapabilityAnnouncement::sign_new(
            input.agent_id,
            &input.device,
            &input.capability_spec,
            0,
            now_unix_ms(),
        )?;

        let handler_slot = Arc::clone(&input.core_slot);
        let handler: Arc<dyn FabricRpcHandler> = Arc::new(DaemonFabricRpcHandler {
            core_slot: handler_slot,
        });

        let node_config = FabricNodeConfig {
            agent_id: input.agent_id,
            device: input.device.clone(),
            epoch_ring: input.epoch_ring,
            bind_ipv4: None,
            enable_mdns: input.config.enable_mdns,
            discover_overlay_interfaces: true,
            relay: Some(FabricRelaySettings {
                relay_url: input.config.relay_url.clone(),
                qad_port: input.config.qad_port,
                auth_token: None,
                custom_ca_certs_der: ca_certs_der.clone(),
            }),
            local_capabilities: Some(input.capability_spec.clone()),
        };
        let node = rt.block_on(FabricNode::bind(node_config, Some(handler)))?;

        let session = input.persisted_session;
        let runtime = Arc::new(Self {
            rt,
            node,
            config: Mutex::new(input.config),
            ca_certs_der: Mutex::new(ca_certs_der),
            announcement,
            session: Mutex::new(session),
            lease: Mutex::new(FencedLeaseCoordinator::new(
                StdMonotonicClock::new(),
                LeaseCoordinatorConfig::default(),
            )),
            sync: Mutex::new(SpineSyncActor::new()),
            pool: Mutex::new(RemoteWorkerPool::new()),
            last_sync_cursor: AtomicU64::new(0),
            lease_view: Mutex::new(LeaseView {
                label: String::from("standby"),
                ..LeaseView::default()
            }),
            tick_inflight: AtomicBool::new(false),
            core_slot: input.core_slot,
            stop: Arc::new(AtomicBool::new(false)),
            ticker: Mutex::new(None),
        });
        Ok(runtime)
    }

    fn core(&self) -> Option<Arc<SharedDaemonCore>> {
        self.core_slot
            .lock()
            .ok()
            .and_then(|g| g.as_ref().and_then(Weak::upgrade))
    }

    pub(crate) fn core_slot(&self) -> SharedCoreSlot {
        Arc::clone(&self.core_slot)
    }

    fn config_snapshot(&self) -> DaemonFabricConfig {
        match self.config.lock() {
            Ok(g) => g.clone(),
            Err(_) => DaemonFabricConfig {
                hub_url: String::new(),
                hub_ca_file: None,
                relay_url: String::new(),
                qad_port: DEFAULT_QAD_PORT,
                enable_mdns: false,
                tick_interval_ms: 5_000,
            },
        }
    }

    fn session_token(&self) -> Option<String> {
        self.session
            .lock()
            .ok()
            .and_then(|g| g.as_ref().map(|s| s.session_token.clone()))
    }

    fn hub_client(&self, token: Option<&str>) -> Result<HubClient> {
        let config = self.config_snapshot();
        let ca = lock_or_storage(&self.ca_certs_der)?.clone();
        HubClient::new(HubClientConfig {
            base_url: config.hub_url,
            session_token: token.map(String::from),
            custom_ca_certs_der: ca,
        })
    }

    fn require_session(&self) -> Result<PersistedFabricSession> {
        lock_or_storage(&self.session)?.clone().ok_or_else(|| {
            QuetzalcoatlError::CredentialRejected {
                detail: String::from("fabric 尚未登录 Hub，请先执行 `qz login --hub <url>`"),
            }
        })
    }

    fn local_identity(&self) -> Result<(AgentId, DeviceId, AccountRootKey, Epoch)> {
        let core = self.core().ok_or_else(|| QuetzalcoatlError::StorageError {
            detail: String::from("fabric 运行时尚未绑定守护进程内核"),
        })?;
        let guard = lock_or_storage(&core.state)?;
        let root_bytes = hex_decode_fixed::<32>("root_key_hex", &guard.persisted.root_key_hex)?;
        Ok((
            guard.kernel.spine().agent_id(),
            guard.kernel.spine().local_device().device_id(),
            AccountRootKey::from_bytes(root_bytes),
            guard.kernel.spine().epoch_ring().current_epoch(),
        ))
    }

    /// 分阶段心跳（Fix Round 1 / Important #3）：**任何 `core.state` 内核锁都绝不跨网络 I/O 持有**。
    /// 阶段 0（短锁）快照 → 阶段 1（零锁）Hub 心跳 + 逐对等节点直连同步 → 阶段 2（短锁）合入 →
    /// 阶段 3（零锁）真实外部投递 → 阶段 4（短锁）写见证记录 → 阶段 5（零锁）上传见证包。
    pub(crate) fn tick_now(&self) -> Result<()> {
        if self.stop.load(Ordering::Relaxed) || self.session_token().is_none() {
            return Ok(());
        }
        if self
            .tick_inflight
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return Ok(());
        }
        let inflight = TickInflightGuard(&self.tick_inflight);
        let Some(core) = self.core() else {
            return Ok(());
        };
        let token = self.session_token().unwrap_or_default();
        let hub = BoundedHub::new(self.hub_client(Some(&token))?);
        let wall = now_unix_ms();

        let mut lease = lock_or_storage(&self.lease)?;
        let mut sync = lock_or_storage(&self.sync)?;

        // 阶段 0：短锁快照（先做合盖时钟跳变门禁 → 同时降级内核姿态，再密封检查点/快照）。
        let (snapshot, expired_in_phase_zero) = {
            let mut state = lock_or_storage(&core.state)?;
            let expired = lease.begin_network_tick(&mut state.kernel);
            let _ = state.kernel.spine_mut().seal_checkpoint(None, wall);
            let all_packs = state.kernel.spine().store().list_packfiles()?;
            let agent_id = state.kernel.spine().agent_id();
            let local_device = state.kernel.spine().local_device().device_id();
            let local_packs: Vec<SealedPackfile> = all_packs
                .iter()
                .filter(|p| p.aad.device_id == local_device)
                .cloned()
                .collect();
            let existing: BTreeSet<ArtifactId> = all_packs.iter().map(|p| p.pack_id).collect();
            let peer_plan = SpineSyncActor::collect_peer_sync_plan(&state.kernel)?;
            (
                SyncSnapshot {
                    agent_id,
                    local_device,
                    local_packs,
                    existing,
                    peer_plan,
                },
                expired,
            )
        };
        if expired_in_phase_zero {
            // 合盖超期后立即把乐观的 Witnessed 快照翻成分区受限，避免 status/nodes 短暂误报全权态。
            if let Ok(mut view) = self.lease_view.lock() {
                *view = capture_lease_view(&lease, snapshot.local_device);
            }
        }

        // 阶段 1a：零内核锁的 Hub 心跳（续租/竞选 + 包上传下载）。
        let report = self.rt.block_on(lease.network_tick(
            snapshot.agent_id,
            snapshot.local_device,
            &mut sync,
            &hub,
            &hub,
            &snapshot.local_packs,
            &snapshot.existing,
        ));

        // 阶段 1b：零内核锁的逐对等节点直连 Packfile 同步（Hub 不可达时仍可收敛）。
        let mut peer_pulled = Vec::new();
        // 1b-0 生产拨号路径：从 Hub 拉取授权设备的 iroh endpoint id + Relay 基址并主动拨号，
        // 让两个互无入站流量的空闲守护进程也能建立 P2P 连接（仅 endpoint id/relay url，零明文）。
        if let Ok(discovered) = self.rt.block_on(hub.list_fabric_peers(snapshot.agent_id)) {
            for peer in discovered {
                if peer.device_id == snapshot.local_device {
                    continue;
                }
                // 对端可能刚退出/不可达：单次直连同步必须有时限，绝不让心跳/退出被 iroh 重连重试拖死。
                let exchange = self.rt.block_on(async {
                    tokio::time::timeout(
                        Duration::from_secs(5),
                        SpineSyncActor::sync_with_peer_by_endpoint(
                            &self.node,
                            &peer.endpoint_id_hex,
                            peer.relay_url.as_deref(),
                            snapshot.agent_id,
                            snapshot.local_device,
                            &snapshot.peer_plan,
                        ),
                    )
                    .await
                });
                if let Ok(Ok(outcome)) = exchange {
                    peer_pulled.extend(outcome.pulled_packs);
                }
            }
        }
        // 1b-1 已连接对端（覆盖 Hub 暂时不可达但直连仍存活的场景）。
        let connected = self.rt.block_on(async {
            tokio::time::timeout(
                Duration::from_secs(5),
                sync.exchange_with_connected_peers(
                    &self.node,
                    snapshot.agent_id,
                    snapshot.local_device,
                    &snapshot.peer_plan,
                ),
            )
            .await
        });
        if let Ok(outcomes) = connected {
            for outcome in outcomes {
                peer_pulled.extend(outcome.pulled_packs);
            }
        }

        // 阶段 2：短锁合入远端包、落定姿态并准备 Outbox 投递计划。
        let plan = {
            let mut state = lock_or_storage(&core.state)?;
            let posture =
                lease.apply_network_report(&mut state.kernel, &mut sync, &report, wall)?;
            if !peer_pulled.is_empty() {
                let outcome = PeerSyncOutcome {
                    uploaded_packs: 0,
                    pulled_packs: peer_pulled,
                };
                let _ = SpineSyncActor::apply_peer_sync(&mut state.kernel, &outcome, wall);
            }
            if matches!(posture, LeasePosture::Witnessed { .. }) {
                lease.prepare_outbox_reconcile(&mut state.kernel, wall)?
            } else {
                OutboxReconcilePlan::default()
            }
        };

        // 阶段 2b：MLS 群提交分发 —— 短锁取同步计划 → 零锁拉取 → 短锁按序应用。
        // 成员离线期间落下的 MLS proposal/commit 在此补齐；纪元推进后应用消息才可解。
        let room_ids = match lock_or_storage(&core.state) {
            Ok(state) => state
                .group
                .summaries()
                .into_iter()
                .map(|summary| summary.room_id)
                .collect::<Vec<_>>(),
            Err(_) => Vec::new(),
        };
        for room_id in room_ids {
            let plan = match lock_or_storage(&core.state) {
                Ok(mut state) => match state.group.sync_plan(&room_id) {
                    Ok(plan) => plan,
                    Err(_) => continue,
                },
                Err(_) => continue,
            };
            let Some(plan) = plan else {
                continue;
            };
            let Ok(prepared) = crate::group::GroupRoomRuntime::fetch_sync(&plan) else {
                continue;
            };
            {
                let Ok(mut state) = lock_or_storage(&core.state) else {
                    continue;
                };
                let crate::daemon::DaemonMutableState {
                    ref mut group,
                    ref mut kernel,
                    ..
                } = *state;
                let _ = group.apply_sync(prepared, kernel.spine_mut().store_mut());
            }
            // 阶段 2c：群主提交已暂存提案（如成员离群），同样短锁创建 → 零锁发布 → 短锁合并。
            let owner_plan = match lock_or_storage(&core.state) {
                Ok(mut state) => {
                    let crate::daemon::DaemonMutableState {
                        ref mut group,
                        ref mut kernel,
                        ..
                    } = *state;
                    group
                        .plan_owner_commit(&room_id, kernel.spine_mut().store_mut())
                        .unwrap_or_default()
                }
                Err(_) => None,
            };
            if let Some(owner_plan) = owner_plan {
                let published = crate::group::GroupRoomRuntime::publish_owner_commit(&owner_plan);
                if let Ok(mut state) = lock_or_storage(&core.state) {
                    let crate::daemon::DaemonMutableState {
                        ref mut group,
                        ref mut kernel,
                        ..
                    } = *state;
                    let _ = group.finish_owner_commit(
                        owner_plan,
                        published,
                        kernel.spine_mut().store_mut(),
                    );
                }
            }
        }

        // 阶段 3：零内核锁执行真实外部投递（外部通道尚未启用 → 全部拒收并保持待投递）。
        let mut outcomes = Vec::new();
        for entry in plan.items.clone() {
            let delivered = self
                .deliver_outbox_item(&entry.item, &entry.idempotency_key)
                .is_ok();
            outcomes.push(OutboxReconcileOutcome { entry, delivered });
        }

        // 阶段 4：短锁写真实投递见证记录；阶段 5：零内核锁上传见证 Packfile。
        if !outcomes.is_empty() {
            let packs = {
                let mut state = lock_or_storage(&core.state)?;
                lease.record_outbox_outcomes(&mut state.kernel, &plan, &outcomes, wall)?
            };
            for p in &packs {
                let _ = self.rt.block_on(SpineSyncBackend::upload_pack(
                    &hub,
                    snapshot.agent_id,
                    snapshot.local_device,
                    p,
                ));
            }
        }

        let cursor = sync.hub_cursor_seq();
        let view = capture_lease_view(&lease, snapshot.local_device);
        drop(sync);
        drop(lease);
        drop(inflight);
        self.last_sync_cursor.store(cursor, Ordering::SeqCst);
        *lock_or_storage(&self.lease_view)? = view;
        Ok(())
    }

    /// 对账重放通道外发项：仅在重获 Witnessed 后执行真实投递。
    fn deliver_outbox_item(&self, item: &OutboxItem, idempotency_key: &str) -> Result<()> {
        if item.capability_id != "external.send" {
            return Err(QuetzalcoatlError::DeliveryRefused {
                detail: format!(
                    "能力 {} 不支持 Outbox 重放（{idempotency_key}）",
                    item.capability_id
                ),
            });
        }
        let args: serde_json::Value = serde_json::from_str(&item.arguments_json).map_err(|e| {
            QuetzalcoatlError::SerializationError {
                detail: format!("解析 Outbox 通道外发参数失败: {e}"),
            }
        })?;
        let channel = args
            .get("channel")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| QuetzalcoatlError::SerializationError {
                detail: String::from("Outbox 通道外发缺少 channel"),
            })?;
        let destination = args
            .get("destination")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("");
        let text = args
            .get("text")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| QuetzalcoatlError::SerializationError {
                detail: String::from("Outbox 通道外发缺少正文"),
            })?;
        let core = self.core().ok_or_else(|| QuetzalcoatlError::StorageError {
            detail: String::from("fabric 运行时尚未绑定守护进程内核"),
        })?;
        let local_device = core
            .state
            .lock()
            .map_err(|_| QuetzalcoatlError::StorageError {
                detail: String::from("daemon lock poisoned"),
            })?
            .kernel
            .spine()
            .local_device()
            .device_id();
        let witness_epoch = self
            .lease_view
            .lock()
            .ok()
            .and_then(|view| view.witness_epoch)
            .unwrap_or(0);
        let mut state = core
            .state
            .lock()
            .map_err(|_| QuetzalcoatlError::StorageError {
                detail: String::from("daemon lock poisoned"),
            })?;
        let _ = state.channels.reconcile_lease_for_local(
            witness_epoch,
            &local_device.to_string(),
            &local_device.to_string(),
        );
        state
            .channels
            .deliver_with_idempotency(channel, destination, text, Some(idempotency_key))
            .map(|_| ())
    }

    fn refresh_lease_view(&self) {
        let Ok(lease) = self.lease.lock() else {
            return;
        };
        let Some(core) = self.core() else {
            return;
        };
        let local_device = core
            .state
            .lock()
            .map(|s| s.kernel.spine().local_device().device_id());
        if let Ok(local_device) = local_device
            && let Ok(mut view) = self.lease_view.lock()
        {
            *view = capture_lease_view(&lease, local_device);
        }
    }

    pub(crate) fn start_ticker(self: &Arc<Self>) {
        let Ok(mut slot) = self.ticker.lock() else {
            return;
        };
        if slot.is_some() {
            return;
        }
        let weak = Arc::downgrade(self);
        let stop = Arc::clone(&self.stop);
        let interval = Duration::from_millis(self.config_snapshot().tick_interval_ms.max(100));
        let join = thread::spawn(move || {
            while !stop.load(Ordering::Relaxed) {
                thread::sleep(interval);
                if stop.load(Ordering::Relaxed) {
                    break;
                }
                let Some(runtime) = weak.upgrade() else {
                    break;
                };
                let _ = runtime.tick_now();
            }
        });
        *slot = Some(join);
    }

    /// 合盖 / 优雅退出时 `<100ms` 主动释放 `witness_epoch` 并停止心跳线程。
    /// 任何一步失败都不会阻断后续的节点关闭与弱引用清理。
    pub(crate) fn shutdown(&self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Ok(mut slot) = self.ticker.lock()
            && let Some(join) = slot.take()
        {
            let _ = join.join();
        }
        // Important #5（后半）：先尝试 `<100ms` 主动移交给在线对等节点，失败再回退为 Hub 直接释放。
        if !self.try_voluntary_handoff() {
            self.release_active_lease();
        }
        self.refresh_lease_view();
        // 退出路径必须有时限：Hub/中继不可达时 iroh `endpoint.close()` 可能长时间等待网络超时，
        // 绝不允许守护进程退出被拖住（5s 上限后放弃剩余后台收尾）。
        self.rt.block_on(async {
            let _ = tokio::time::timeout(Duration::from_secs(5), self.node.shutdown()).await;
        });
    }

    /// 优雅退出时把当前 `witness_epoch` 连同最新检查点移交在线对等节点（返回是否移交成功）。
    fn try_voluntary_handoff(&self) -> bool {
        let (Some(token), Some(core)) = (self.session_token(), self.core()) else {
            return false;
        };
        let Ok(hub) = self.hub_client(Some(&token)) else {
            return false;
        };
        let Some(target) = self.node.peer_endpoint_addrs().into_iter().next() else {
            return false;
        };
        let Ok(mut lease) = self.lease.lock() else {
            return false;
        };
        if !matches!(lease.state(), RouterLeaseState::ActiveRouter { .. }) {
            return false;
        }
        let Ok(mut sync) = self.sync.lock() else {
            return false;
        };
        let Ok(mut state) = core.state.lock() else {
            return false;
        };
        let bounded = BoundedHub::new(hub);
        // 移交请求必须有时限：对端可能刚好同时退出/不可达，绝不能让守护进程退出被 iroh
        // 重连重试拖住（超时即回退为 Hub 直接释放）。
        let result = self.rt.block_on(async {
            tokio::time::timeout(
                Duration::from_secs(5),
                lease.voluntary_handoff(
                    &mut state.kernel,
                    &mut sync,
                    &bounded,
                    Some(&bounded),
                    Some((&self.node, target)),
                    now_unix_ms(),
                ),
            )
            .await
        });
        matches!(result, Ok(Ok(_)))
    }

    fn release_active_lease(&self) {
        let (Some(token), Some(core)) = (self.session_token(), self.core()) else {
            return;
        };
        let Ok(hub) = self.hub_client(Some(&token)) else {
            return;
        };
        let active_epoch = {
            let Ok(lease) = self.lease.lock() else {
                return;
            };
            match lease.state() {
                RouterLeaseState::ActiveRouter { witness_epoch, .. } => Some(witness_epoch.get()),
                _ => None,
            }
        };
        let Some(epoch) = active_epoch else {
            return;
        };
        let (agent, dev) = {
            let Ok(state) = core.state.lock() else {
                return;
            };
            (
                state.kernel.spine().agent_id(),
                state.kernel.spine().local_device().device_id(),
            )
        };
        let bounded = BoundedHub::new(hub);
        if self
            .rt
            .block_on(LeaseWitnessBackend::release_lease(
                &bounded, agent, dev, epoch,
            ))
            .is_ok()
            && let Ok(mut state) = core.state.lock()
        {
            state.kernel.set_lease_posture(LeasePosture::PartitionLocal);
        }
    }

    pub(crate) fn login(
        &self,
        qz_home: &Path,
        req: &FabricLoginRequest,
    ) -> Result<FabricLoginResult> {
        let config = self.config_snapshot();
        if req.hub_url.trim_end_matches('/') != config.hub_url.trim_end_matches('/') {
            return Err(QuetzalcoatlError::StorageError {
                detail: format!(
                    "守护进程已绑定 Hub `{}`，与 `{}` 不一致；请以 `QUETZALCOATL_FABRIC_HUB_URL` 重启 quetzalcoatld 后再登录",
                    config.hub_url, req.hub_url
                ),
            });
        }
        if let Some(ca_file) = &req.ca_file {
            let raw = fs::read(ca_file).map_err(|e| QuetzalcoatlError::StorageError {
                detail: format!("读取 --ca-file 失败 ({}): {e}", ca_file.display()),
            })?;
            let der = parse_ca_certs_pem_or_der(&raw)?;
            if !der.is_empty() {
                *lock_or_storage(&self.ca_certs_der)? = der;
            }
            *lock_or_storage(&self.config)? = DaemonFabricConfig {
                hub_ca_file: Some(ca_file.clone()),
                ..config.clone()
            };
        }

        let (agent_id, device_id, local_root, _epoch) = self.local_identity()?;
        if req.agent_id.is_some_and(|a| a != agent_id) {
            return Err(QuetzalcoatlError::PermissionDenied {
                detail: String::from("--agent 与本地主权 Agent 不一致，拒绝登录他人脊柱"),
            });
        }
        if req.device_id.is_some_and(|d| d != device_id) {
            return Err(QuetzalcoatlError::PermissionDenied {
                detail: String::from("--device 与本地设备身份不一致"),
            });
        }

        let (auth_mode, session_token, account_id) = if let Some(token) = &req.token {
            let client = self.hub_client(Some(token))?;
            let devices = self.rt.block_on(client.list_active_devices(agent_id))?;
            if !devices.iter().any(|d| d.device_id == device_id) {
                return Err(QuetzalcoatlError::PermissionDenied {
                    detail: String::from("提供的 Hub 会话令牌未包含本机设备授权"),
                });
            }
            (
                String::from("token"),
                token.clone(),
                String::from("bearer-session"),
            )
        } else if let Some(pin) = &req.pin {
            let anon = self.hub_client(None)?;
            let login_res =
                self.rt
                    .block_on(anon.login_opaque_pin(agent_id, device_id, pin.as_bytes()));
            let (session, recovered_root) = match login_res {
                Ok(pair) => pair,
                // 错误 PIN 会在 OPAQUE Envelope 认证标签处失败：对用户必须呈现为凭据被拒而非存储故障。
                Err(QuetzalcoatlError::IntegrityViolation { detail }) => {
                    return Err(QuetzalcoatlError::CredentialRejected {
                        detail: format!("PIN 不正确或 OPAQUE 凭据不匹配: {detail}"),
                    });
                }
                Err(other) => return Err(other),
            };
            if recovered_root.verifying_key_bytes()? != local_root.verifying_key_bytes()? {
                return Err(QuetzalcoatlError::IntegrityViolation {
                    detail: String::from("OPAQUE 登录解封的根密钥与本地主权根密钥不一致"),
                });
            }
            if session.session_token.is_empty() {
                return Err(QuetzalcoatlError::CredentialRejected {
                    detail: String::from("Hub 返回了空会话令牌"),
                });
            }
            (
                String::from("opaque_pin"),
                session.session_token,
                session.account_id,
            )
        } else {
            return Err(QuetzalcoatlError::CredentialRejected {
                detail: String::from("qz login 需要 --pin 或 --token 之一"),
            });
        };

        let persisted = PersistedFabricSession {
            hub_url: config.hub_url.clone(),
            hub_ca_file: config.hub_ca_file.clone(),
            relay_url: config.relay_url.clone(),
            qad_port: config.qad_port,
            session_token,
            account_id: account_id.clone(),
            agent_id,
            device_id,
        };
        save_persisted_session(qz_home, &persisted)?;
        *lock_or_storage(&self.session)? = Some(persisted);

        self.tick_now()?;
        self.refresh_lease_view();
        let view = lock_or_storage(&self.lease_view)?.clone();
        Ok(FabricLoginResult {
            hub_url: config.hub_url,
            agent_id,
            device_id,
            account_id,
            auth_mode,
            lease: view.label,
            witness_epoch: view.witness_epoch.unwrap_or(0),
            peer_count: self.node.peer_statuses().len(),
        })
    }

    pub(crate) fn pair_start(&self, qz_home: &Path) -> Result<FabricPairStartResult> {
        let session = self.require_session()?;
        let client = self.hub_client(Some(&session.session_token))?;
        let init = self.rt.block_on(client.pair_initiate(session.agent_id))?;
        track_pairing(
            qz_home,
            &PersistedPairingSession {
                pairing_id: init.pairing_id.clone(),
                short_code: init.short_code.clone(),
                expires_at_ms: init.expires_at_ms,
            },
        )?;
        let core = self.core().ok_or_else(|| QuetzalcoatlError::StorageError {
            detail: String::from("fabric 运行时尚未绑定守护进程内核"),
        })?;
        let xwing_pk = {
            let guard = lock_or_storage(&core.state)?;
            hex_encode(guard.kernel.spine().local_device().xwing_public_key())
        };
        Ok(FabricPairStartResult {
            hub_url: session.hub_url,
            agent_id: session.agent_id,
            pair_code: format!("{}.{}", init.pairing_id, init.short_code),
            pairing_id: init.pairing_id,
            short_code: init.short_code,
            expires_at_ms: init.expires_at_ms,
            xwing_recipient_public_key_hex: xwing_pk,
        })
    }

    pub(crate) fn pair_join(
        &self,
        qz_home: &Path,
        pairing_id: &str,
        short_code: &str,
    ) -> Result<FabricPairJoinResult> {
        validate_pair_code_locally(qz_home, pairing_id, short_code)?;
        let session = self.require_session().ok();
        let agent_id = if let Some(s) = &session {
            s.agent_id
        } else {
            self.local_identity()?.0
        };
        let joiner = load_or_create_joiner_identity(qz_home, agent_id)?;
        let client = self.hub_client(None)?;
        self.rt
            .block_on(client.pair_join(pairing_id, short_code, &joiner))?;
        Ok(FabricPairJoinResult {
            pairing_id: String::from(pairing_id),
            joiner_device_id: joiner.device_id(),
            hub_url: self.config_snapshot().hub_url,
        })
    }

    pub(crate) fn pair_approve(
        &self,
        qz_home: &Path,
        pairing_id: &str,
        short_code: &str,
    ) -> Result<FabricPairApproveResult> {
        let session = self.require_session()?;
        if short_code.trim().is_empty() {
            return Err(QuetzalcoatlError::CredentialRejected {
                detail: String::from("qz pair approve 需要配对短码"),
            });
        }
        validate_pair_code_locally(qz_home, pairing_id, short_code)?;
        let (_, _, root_key, epoch) = self.local_identity()?;
        let client = self.hub_client(Some(&session.session_token))?;
        let status = self.rt.block_on(client.pair_get(pairing_id))?;
        if status.agent_id != session.agent_id {
            return Err(QuetzalcoatlError::PermissionDenied {
                detail: String::from("配对会话不属于本地主权 Agent"),
            });
        }
        let bundle = self.rt.block_on(client.pair_approve_with_hpke_bundle(
            pairing_id,
            session.agent_id,
            epoch,
            &root_key,
            &status,
        ))?;

        // Important #4：批准后必须把新设备真实写入本地 EpochKeyRing（含绑定纪元密钥）并让
        // `SovereignAuthHook` 立即放行该 EndpointId，同时 `0600` 持久化以便重启后续用。
        let joiner_record = DevicePublicRecord {
            device_id: bundle.joiner_device_id,
            ed25519_pubkey: hex_decode_fixed::<32>(
                "new_device_ed25519_hex",
                &status.new_device_ed25519_hex,
            )?,
            xwing_pubkey: hex_decode("new_device_xwing_pk_hex", &status.new_device_xwing_pk_hex)?,
        };
        let (ring_snapshot, local_device) = {
            let core = self.core().ok_or_else(|| QuetzalcoatlError::StorageError {
                detail: String::from("fabric 运行时尚未绑定守护进程内核"),
            })?;
            let mut state = lock_or_storage(&core.state)?;
            let local_device = state.kernel.spine().local_device().device_id();
            let root = AccountRootKey::from_bytes(hex_decode_fixed::<32>(
                "root_key_hex",
                &state.persisted.root_key_hex,
            )?);
            {
                let ring = state.kernel.spine_mut().epoch_ring_mut();
                if !ring.is_device_active(joiner_record.device_id) {
                    ring.add_device(&root, joiner_record.clone())?;
                }
            }
            state
                .kernel
                .spine_mut()
                .store_mut()
                .register_device_pubkey(joiner_record.device_id, &joiner_record.ed25519_pubkey)?;
            let ring_snapshot = state.kernel.spine().epoch_ring().clone();
            (ring_snapshot, local_device)
        };
        persist_membership(qz_home, &ring_snapshot, local_device)?;
        self.node.sync_membership(&ring_snapshot);
        Ok(bundle.into())
    }

    /// 吊销一台已配对设备：先在本地轮换 `EpochKey[e+1]` 并写回成员状态，再同步鉴权目录并主动断开在线连接。
    pub(crate) fn revoke_device(
        &self,
        qz_home: &Path,
        device_id: DeviceId,
    ) -> Result<FabricRevokeResult> {
        if self.session_token().is_none() {
            return Err(QuetzalcoatlError::CredentialRejected {
                detail: String::from("fabric 尚未登录 Hub，请先执行 `qz login`"),
            });
        }
        let (new_epoch, ring_snapshot, local_device) = {
            let core = self.core().ok_or_else(|| QuetzalcoatlError::StorageError {
                detail: String::from("fabric 运行时尚未绑定守护进程内核"),
            })?;
            let mut state = lock_or_storage(&core.state)?;
            let local_device = state.kernel.spine().local_device().device_id();
            let root = AccountRootKey::from_bytes(hex_decode_fixed::<32>(
                "root_key_hex",
                &state.persisted.root_key_hex,
            )?);
            let (new_epoch, _change) = state
                .kernel
                .spine_mut()
                .epoch_ring_mut()
                .revoke_device(&root, device_id)?;
            let ring_snapshot = state.kernel.spine().epoch_ring().clone();
            (new_epoch, ring_snapshot, local_device)
        };
        persist_membership(qz_home, &ring_snapshot, local_device)?;
        self.node.sync_membership(&ring_snapshot);
        self.rt
            .block_on(self.node.revoke_peer_and_disconnect(device_id));
        if let Ok(mut pool) = self.pool.lock() {
            pool.remove_device(device_id);
        }
        Ok(FabricRevokeResult {
            device_id,
            new_epoch: new_epoch.get(),
        })
    }

    pub(crate) fn status(&self) -> FabricStatus {
        let config = self.config_snapshot();
        let logged_in = self.session_token().is_some();
        let view = self
            .lease_view
            .lock()
            .map(|g| g.clone())
            .unwrap_or_else(|_| LeaseView {
                label: String::from("partition_local"),
                ..LeaseView::default()
            });
        FabricStatus {
            enabled: true,
            logged_in,
            hub_url: Some(config.hub_url),
            peer_count: self.node.peer_statuses().len(),
            lease: view.label,
            witness_epoch: view.witness_epoch,
            highest_seen_epoch: view.highest_seen_epoch,
            last_sync_cursor: self.last_sync_cursor.load(Ordering::SeqCst),
            endpoint_id_hex: self
                .node
                .endpoint_id()
                .ok()
                .map(|id| hex_encode(id.as_bytes())),
            qad_port: Some(config.qad_port),
        }
    }

    /// 拉取已密封的 Webhook 入站信封（会话令牌只在本机内存使用）。
    pub(crate) fn pull_webhook_ingress(
        &self,
        agent_id: AgentId,
        after: i64,
        limit: u32,
    ) -> Result<WebhookIngressBatch> {
        let session = self.require_session()?;
        let client = self.hub_client(Some(&session.session_token))?;
        self.rt
            .block_on(client.pull_webhook_ingress(agent_id, after, limit))
    }

    /// 确认删除已成功落盘的密封信封。
    pub(crate) fn ack_webhook_ingress(
        &self,
        agent_id: AgentId,
        keys: &[quetzalcoatl_fabric::WebhookIngressAckKey],
    ) -> Result<u64> {
        let session = self.require_session()?;
        let client = self.hub_client(Some(&session.session_token))?;
        self.rt.block_on(client.ack_webhook_ingress(agent_id, keys))
    }

    /// 向 Hub 登记本设备独立的 ChannelIngressKey 公钥。
    pub(crate) fn register_channel_ingress_key(
        &self,
        agent_id: AgentId,
        pubkey: &[u8; XWING_PK_LEN],
        key_id: &str,
        device_id: &str,
    ) -> Result<()> {
        let session = self.require_session()?;
        let client = self.hub_client(Some(&session.session_token))?;
        self.rt
            .block_on(client.register_channel_ingress_key(agent_id, pubkey, key_id, device_id))
    }

    /// 查询 Webhook 入站 key 登记与队列深度。
    pub(crate) fn webhook_ingress_status(&self, agent_id: AgentId) -> Result<WebhookIngressStatus> {
        let session = self.require_session()?;
        let client = self.hub_client(Some(&session.session_token))?;
        self.rt.block_on(client.webhook_ingress_status(agent_id))
    }

    pub(crate) fn nodes_report(&self) -> FabricNodesReport {
        let config = self.config_snapshot();
        let local_device = self.node.device_id();
        let view = self
            .lease_view
            .lock()
            .map(|g| g.clone())
            .unwrap_or_default();
        let lease = if view.label.is_empty() {
            String::from("standby")
        } else {
            view.label
        };
        let witness_epoch = view.witness_epoch.unwrap_or(view.highest_seen_epoch);
        let holder = view.holder;

        let mut peers = Vec::new();
        peers.push(FabricPeerRow {
            device_id: local_device.to_string(),
            endpoint_id_hex: self
                .node
                .endpoint_id()
                .ok()
                .map(|id| hex_encode(id.as_bytes()))
                .unwrap_or_default(),
            role: String::from("self"),
            authorized: true,
            path_kind: String::from("self"),
            path_detail: String::new(),
            capability_tags: self.announcement.capability_tags.iter().cloned().collect(),
            available_harnesses: self.announcement.available_harnesses.clone(),
            os: self.announcement.os.clone(),
            arch: self.announcement.arch.clone(),
            sandbox_available: self.announcement.sandbox_available,
            active_workers: self.announcement.active_workers,
            max_workers: self.announcement.max_workers,
        });

        for peer in self.node.peer_statuses() {
            let (kind, detail) = match &peer.path {
                PeerPathKind::DirectIp { addr, rtt_ms } => {
                    (String::from("direct"), format!("{addr} rtt={rtt_ms}ms"))
                }
                PeerPathKind::Relay { relay_url, rtt_ms } => {
                    (String::from("relay"), format!("{relay_url} rtt={rtt_ms}ms"))
                }
                PeerPathKind::Disconnected => (String::from("disconnected"), String::new()),
            };
            let cap = peer.capabilities.as_ref();
            peers.push(FabricPeerRow {
                device_id: peer.device_id.to_string(),
                endpoint_id_hex: peer.endpoint_id_hex,
                role: String::from("peer"),
                authorized: peer.authorized,
                path_kind: kind,
                path_detail: detail,
                capability_tags: cap
                    .map(|c| c.capability_tags.iter().cloned().collect())
                    .unwrap_or_default(),
                available_harnesses: cap
                    .map(|c| c.available_harnesses.clone())
                    .unwrap_or_default(),
                os: cap.map(|c| c.os.clone()).unwrap_or_default(),
                arch: cap.map(|c| c.arch.clone()).unwrap_or_default(),
                sandbox_available: cap.is_some_and(|c| c.sandbox_available),
                active_workers: cap.map_or(0, |c| c.active_workers),
                max_workers: cap.map_or(0, |c| c.max_workers),
            });
        }

        FabricNodesReport {
            enabled: true,
            hub_url: Some(config.hub_url),
            local_device_id: Some(local_device),
            local_endpoint_id_hex: self
                .node
                .endpoint_id()
                .ok()
                .map(|id| hex_encode(id.as_bytes())),
            router_holder: holder,
            witness_epoch,
            lease,
            last_sync_cursor: self.last_sync_cursor.load(Ordering::SeqCst),
            peers,
        }
    }
}

fn load_persisted_session_for(
    qz_home: &Path,
    config: &DaemonFabricConfig,
) -> Option<PersistedFabricSession> {
    // 只有 Hub 完全一致才复用既有会话令牌，防止把令牌误发给另一个 Hub。
    load_persisted_session(qz_home)
        .filter(|s| s.hub_url.trim_end_matches('/') == config.hub_url.trim_end_matches('/'))
}

/// 守护进程内 fabric 入站 RPC 处理器（跨机 Packfile 同步、能力广播、远程 Worker 任务与租约接班）。
struct DaemonFabricRpcHandler {
    core_slot: SharedCoreSlot,
}

impl DaemonFabricRpcHandler {
    fn core(&self) -> Option<Arc<SharedDaemonCore>> {
        self.core_slot
            .lock()
            .ok()
            .and_then(|g| g.as_ref().and_then(Weak::upgrade))
    }

    fn error_response(err: &QuetzalcoatlError) -> FabricRpcResponse {
        FabricRpcResponse::Error {
            code: String::from(err.code().as_str()),
            detail: err.to_string(),
        }
    }
}

impl FabricRpcHandler for DaemonFabricRpcHandler {
    fn handle_rpc(
        &self,
        authenticated_peer_device: DeviceId,
        req: FabricRpcRequest,
    ) -> FabricRpcResponse {
        let Some(core) = self.core() else {
            return FabricRpcResponse::Error {
                code: String::from("STORAGE_ERROR"),
                detail: String::from("守护进程内核尚未就绪"),
            };
        };
        let Some(fabric) = core.fabric_runtime() else {
            return FabricRpcResponse::Error {
                code: String::from("PERMISSION_DENIED"),
                detail: String::from("fabric 未启用"),
            };
        };
        match req {
            FabricRpcRequest::Ping { .. } => FabricRpcResponse::Pong {
                responder_device_id: authenticated_peer_device,
                capability: None,
            },
            FabricRpcRequest::PushPackfiles { packs, .. } => {
                let Ok(mut state) = core.state.lock() else {
                    return FabricRpcResponse::Error {
                        code: String::from("STORAGE_ERROR"),
                        detail: String::from("daemon lock poisoned"),
                    };
                };
                match SpineSyncActor::ingest_packfiles_and_rehydrate(
                    &mut state.kernel,
                    &packs,
                    now_unix_ms(),
                ) {
                    Ok((ingested, _)) => FabricRpcResponse::PackfilesAck {
                        ingested_events: ingested,
                    },
                    Err(e) => Self::error_response(&e),
                }
            }
            FabricRpcRequest::PullPackfiles { known_heads, .. } => {
                let Ok(state) = core.state.lock() else {
                    return FabricRpcResponse::Error {
                        code: String::from("STORAGE_ERROR"),
                        detail: String::from("daemon lock poisoned"),
                    };
                };
                let heads: BTreeMap<DeviceId, u64> = known_heads.into_iter().collect();
                let packs = state
                    .kernel
                    .spine()
                    .store()
                    .list_packfiles()
                    .unwrap_or_default()
                    .into_iter()
                    .filter(|p| {
                        let peer_seq = heads.get(&p.aad.device_id).copied().unwrap_or(0);
                        p.aad.last_seq > peer_seq
                    })
                    .collect();
                FabricRpcResponse::PackfilesBatch { packs }
            }
            FabricRpcRequest::VoluntaryLeaseHandoff {
                agent_id,
                released_epoch,
                latest_packs,
                ..
            } => {
                let (local_dev, ingest_err) = {
                    let Ok(mut state) = core.state.lock() else {
                        return FabricRpcResponse::Error {
                            code: String::from("STORAGE_ERROR"),
                            detail: String::from("daemon lock poisoned"),
                        };
                    };
                    let ingest_err = if latest_packs.is_empty() {
                        None
                    } else {
                        SpineSyncActor::ingest_packfiles_and_rehydrate(
                            &mut state.kernel,
                            &latest_packs,
                            now_unix_ms(),
                        )
                        .err()
                    };
                    (state.kernel.spine().local_device().device_id(), ingest_err)
                };
                if let Some(err) = ingest_err {
                    return Self::error_response(&err);
                }

                let acquired = {
                    let token = fabric.session_token();
                    let hub_res = token
                        .ok_or_else(|| QuetzalcoatlError::CredentialRejected {
                            detail: String::from("fabric 尚未登录 Hub，无法接班"),
                        })
                        .and_then(|tok| fabric.hub_client(Some(&tok)));
                    match hub_res {
                        Ok(hub) => thread::spawn(move || {
                            // 接班时 Hub 可能已不可达：必须使用 3s 硬超时垫片，避免把对端的
                            // 优雅退出移交请求拖住 20s。
                            let bounded = BoundedHub::new(hub);
                            tokio::runtime::Builder::new_current_thread()
                                .enable_all()
                                .build()
                                .map_err(|e| QuetzalcoatlError::StorageError {
                                    detail: e.to_string(),
                                })
                                .and_then(|rt| {
                                    rt.block_on(LeaseWitnessBackend::acquire_lease(
                                        &bounded,
                                        agent_id,
                                        local_dev,
                                        released_epoch,
                                        30_000,
                                    ))
                                })
                        })
                        .join()
                        .ok(),
                        Err(e) => return Self::error_response(&e),
                    }
                };

                match acquired {
                    Some(Ok(rec)) => {
                        // 严格保持 "lease -> state" 加锁顺序，与 tick_now / shutdown 一致，杜绝 ABBA 死锁。
                        if let Ok(mut lease) = fabric.lease.lock()
                            && let Ok(mut state) = core.state.lock()
                        {
                            let epoch = Epoch::new(rec.witness_epoch);
                            state.kernel.set_lease_posture(LeasePosture::Witnessed {
                                witness_epoch: epoch,
                            });
                            let _ = lease.observe_remote_epoch(
                                rec.witness_epoch,
                                Some(local_dev),
                                &mut state.kernel,
                            );
                        }
                        FabricRpcResponse::LeaseHandoffAccepted {
                            new_holder_device_id: local_dev,
                            new_witness_epoch: rec.witness_epoch,
                        }
                    }
                    Some(Err(e)) => Self::error_response(&e),
                    None => FabricRpcResponse::Error {
                        code: String::from("STORAGE_ERROR"),
                        detail: String::from("租约接班线程异常退出"),
                    },
                }
            }
            FabricRpcRequest::AnnounceCapabilities { announcement } => {
                let ring = core
                    .state
                    .lock()
                    .map(|s| s.kernel.spine().epoch_ring().clone());
                let Ok(ring) = ring else {
                    return FabricRpcResponse::Error {
                        code: String::from("STORAGE_ERROR"),
                        detail: String::from("daemon lock poisoned"),
                    };
                };
                if let Ok(mut pool) = fabric.pool.lock()
                    && let Err(e) = pool.ingest_announcement(announcement, &ring)
                {
                    return Self::error_response(&e);
                }
                FabricRpcResponse::CapabilityAck
            }
            FabricRpcRequest::ExecuteRemoteWorkerTask {
                witness_epoch,
                task,
                ..
            } => {
                let Ok(mut state) = core.state.lock() else {
                    return FabricRpcResponse::Error {
                        code: String::from("STORAGE_ERROR"),
                        detail: String::from("daemon lock poisoned"),
                    };
                };
                // Critical #1：先做两态围栏门禁（断网 PartitionLocal 或纪元不一致一律硬拒），
                // 再进入内核 + 沙箱 + 洁净室执行路径；围栏失败不得触碰任何脊柱/沙箱状态。
                let expected_epoch = Epoch::new(witness_epoch);
                if let Err(e) = enforce_remote_worker_lease_fence(&state.kernel, expected_epoch) {
                    return Self::error_response(&e);
                }
                match execute_remote_worker_task_locally(
                    &mut state.kernel,
                    &task,
                    expected_epoch,
                    now_unix_ms(),
                ) {
                    Ok(result) => FabricRpcResponse::RemoteWorkerTaskCompleted {
                        result: Box::new(result),
                    },
                    Err(e) => Self::error_response(&e),
                }
            }
        }
    }
}

/// 依据守护进程内核身份、沙箱可用性与已发现 Harness 广播本机能力，启动真实 `iroh` fabric 节点。
pub(crate) fn start_runtime(
    qz_home: &Path,
    config: DaemonFabricConfig,
    agent_id: AgentId,
    device: DeviceIdentity,
    epoch_ring: EpochKeyRing,
    sandbox_available: bool,
    discovered_harnesses: Vec<String>,
) -> Result<Arc<DaemonFabricRuntime>> {
    let mut tags = BTreeSet::from([
        String::from("quetzalcoatl"),
        String::from(std::env::consts::OS),
        String::from(std::env::consts::ARCH),
    ]);
    if sandbox_available {
        tags.insert(String::from("sandbox"));
    }
    for h in &discovered_harnesses {
        tags.insert(h.to_lowercase());
    }
    let capability_spec = NodeCapabilitySpec {
        os: String::from(std::env::consts::OS),
        arch: String::from(std::env::consts::ARCH),
        available_harnesses: discovered_harnesses,
        capability_tags: tags,
        sandbox_available,
        max_workers: 4,
    };
    let persisted_session = load_persisted_session_for(qz_home, &config);
    let core_slot: SharedCoreSlot = Arc::new(Mutex::new(None));
    let runtime = DaemonFabricRuntime::boot(FabricBootInput {
        config,
        agent_id,
        device,
        epoch_ring,
        capability_spec,
        core_slot,
        persisted_session,
    })?;
    if runtime.session_token().is_some() {
        let _ = runtime.tick_now();
    }
    Ok(runtime)
}
