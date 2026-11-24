#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]

//! `quetzalcoatld` 核心守护进程编排器（唯一脊柱锁、`Router ↔ Worker` OS 沙箱隔离派发、独立 Git Worktree 与洁净室 `Verifier` 闭环）。

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use quetzalcoatl_crypto::{
    AccountRootKey, DeviceIdentity, EpochKey, EpochKeyRing, hex_decode_fixed, hex_encode,
};
use quetzalcoatl_ewave::{
    AssemblyRequest, Authority, BudgetProfile, Conscience, ConscienceArbiter, ConscienceManifest,
    ContextAssembler, FocusConfig, MemoryEntry, MemoryKind, Mutability, ObserveOptions,
    ProtectedDirective, ProvenanceRecord, SerpentineGraph, ValueEntry,
};
use quetzalcoatl_harness::{
    AcpJsonRpcDriver, ClaudeCodeDriver, CodexDriver, CodingAgentKind, DiscoveredAgent,
    DiscoveryConfig, GatewayConfig, GatewayServerHandle, GatewaySessionConfig,
    GatewayUpstreamEndpoints, HarnessDriver, HarnessHost, HarnessLaunchContext,
    HttpsUpstreamTransport, LoopbackGateway, McpBridgeSession, OpenCodeDriver, PiDriver,
    SandboxLaunchBinding, WorktreeManager, discover_coding_agents, ensure_secure_private_dir,
    prepare_stripped_oauth_stubs, serve_mcp_http_loopback,
};
use quetzalcoatl_kernel::{
    BlindKernel, CapabilityDescriptor, CapabilityInvocation, CapabilityOrigin, CapabilitySet,
    CleanRoomVerifierDag, EvolvedSkillSpec, ExecutionSurface, HeartScheduler, LeasePosture,
    PrincipalRole, ScopeChain, SinkClass, SleepPhase, VerificationMark,
};
use quetzalcoatl_sandbox::{
    NetworkPolicy, SandboxConfig, SandboxExecSpec, SandboxManager, SandboxMode, TicketRequest,
    default_quetzalcoatl_home,
};
use quetzalcoatl_spine::{
    MaterializedMessage, MaterializedStore, MaterializedThread, RusqliteWalStore, SpineEngine,
    V1ImportReport, ZipExportOptions,
};
use quetzalcoatl_types::{
    AgentId, DeviceId, Epoch, HlcTimestamp, QuetzalcoatlError, Result, RunId, ThreadId,
};
use rand_core::{OsRng, RngCore};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::fabric::{DaemonFabricConfig, DaemonFabricRuntime, FabricStatus};
use crate::local_ipc::{
    IpcClient, IpcHandler, IpcRequest, IpcResponse, LocalIpcServerHandle, ScopedHookTokenRegistry,
    start_local_ipc_server,
};

#[must_use]
pub fn resolve_quetzalcoatl_home(explicit: Option<PathBuf>) -> PathBuf {
    explicit
        .or_else(|| std::env::var_os("QUETZALCOATL_HOME").map(PathBuf::from))
        .unwrap_or_else(default_quetzalcoatl_home)
}

pub(crate) fn now_unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(1_795_400_000_000)
}

#[derive(Clone, Debug)]
pub struct DaemonConfig {
    pub quetzalcoatl_home: PathBuf,
    pub ipc_bind_addr: SocketAddr,
    pub gateway_bind_addr: SocketAddr,
    pub upstream_endpoints: GatewayUpstreamEndpoints,
    pub preferred_worker_agent: Option<CodingAgentKind>,
    pub worker_binary_override: Option<PathBuf>,
    pub sandbox_exec_override: Option<PathBuf>,
    pub upstream_bearer_token: Option<String>,
    pub discovery_search_paths: Option<Vec<PathBuf>>,
    /// 可选 `quetzalcoatl-fabric` 接入（默认 `None` 即完全关闭，不建节点、不写文件、零网络动作）。
    pub fabric: Option<DaemonFabricConfig>,
}

impl DaemonConfig {
    #[must_use]
    pub fn new(quetzalcoatl_home: PathBuf) -> Self {
        let mut endpoints = GatewayUpstreamEndpoints::default();
        if let Ok(base) = std::env::var("QUETZALCOATL_UPSTREAM_BASE_URL")
            && !base.trim().is_empty()
        {
            endpoints.anthropic_base_url = base.clone();
            endpoints.openai_base_url = base.clone();
            endpoints.codex_chatgpt_base_url = base.clone();
            endpoints.gemini_base_url = base;
        }
        let worker_binary_override = std::env::var_os("QUETZALCOATL_WORKER_BINARY")
            .filter(|v| !v.is_empty())
            .map(PathBuf::from);
        let sandbox_exec_override = std::env::var_os("QUETZALCOATL_SANDBOX_EXEC_BIN")
            .filter(|v| !v.is_empty())
            .map(PathBuf::from);
        let fabric = DaemonFabricConfig::resolve(&quetzalcoatl_home);

        Self {
            quetzalcoatl_home,
            ipc_bind_addr: SocketAddr::from(([127, 0, 0, 1], 0)),
            gateway_bind_addr: SocketAddr::from(([127, 0, 0, 1], 0)),
            upstream_endpoints: endpoints,
            preferred_worker_agent: None,
            worker_binary_override,
            sandbox_exec_override,
            upstream_bearer_token: None,
            discovery_search_paths: None,
            fabric,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DaemonRuntimeInfo {
    pub pid: u32,
    pub agent_id: AgentId,
    pub device_id: DeviceId,
    pub ipc_http_addr: SocketAddr,
    pub unix_socket_path: Option<PathBuf>,
    pub gateway_addr: SocketAddr,
    pub started_ms: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DaemonStatus {
    pub pid: u32,
    pub agent_id: AgentId,
    pub device_id: DeviceId,
    pub epoch: u64,
    pub hlc_hex: String,
    pub ipc_http_addr: SocketAddr,
    pub gateway_addr: SocketAddr,
    pub discovered_agents: Vec<DiscoveredAgent>,
    pub total_runs: usize,
    pub total_verifier_runs: u64,
    pub spine_events_count: usize,
    pub sleep_phase: SleepPhase,
    /// 可选 fabric 段落（默认关闭时 `enabled=false, lease="disabled"`）。
    pub fabric: FabricStatus,
    /// 当前已加入并构造 `openmls` 引擎的群房间数量。
    pub group_rooms: usize,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChatRequest {
    pub message: String,
    pub thread_id: Option<ThreadId>,
    pub peer_id: Option<String>,
    pub workspace_dir: Option<PathBuf>,
    pub verifier_dag: Option<CleanRoomVerifierDag>,
    pub router_attempted_forbidden_tools: Vec<String>,
}

impl ChatRequest {
    #[must_use]
    pub fn simple(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            thread_id: None,
            peer_id: None,
            workspace_dir: None,
            verifier_dag: None,
            router_attempted_forbidden_tools: Vec::new(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChatResponse {
    pub reply: String,
    pub run_id: RunId,
    pub delegated_to_worker: bool,
    pub verifier_runs: u64,
    pub verification_mark: Option<VerificationMark>,
    pub router_denied_capabilities: Vec<String>,
    pub changed_files: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExploreWakeReport {
    pub woke_explore: bool,
    pub explore_run_id: Option<RunId>,
    pub synthesized_skill_id: Option<String>,
    pub skill_stdout: Option<String>,
    pub external_write_refused: bool,
}

/// 防坑规范 #13：跨进程内核级文件独占锁（`$QUETZALCOATL_HOME/spine/daemon.lock`）。
struct ExclusiveSpineLock {
    _conn: Connection,
}

impl ExclusiveSpineLock {
    fn acquire(qz_home: &Path) -> Result<Self> {
        let spine_dir = qz_home.join("spine");
        fs::create_dir_all(&spine_dir).map_err(|e| QuetzalcoatlError::StorageError {
            detail: format!("创建 spine 目录失败 ({}): {e}", spine_dir.display()),
        })?;
        let lock_path = spine_dir.join("daemon.lock");
        let conn = Connection::open(&lock_path).map_err(|e| QuetzalcoatlError::StorageError {
            detail: format!("打开脊柱独占锁文件失败 ({}): {e}", lock_path.display()),
        })?;
        conn.busy_timeout(Duration::from_millis(0)).map_err(|e| {
            QuetzalcoatlError::StorageError {
                detail: format!("配置脊柱独占锁 busy_timeout=0 失败: {e}"),
            }
        })?;
        conn.execute_batch(
            "PRAGMA locking_mode = EXCLUSIVE;
             BEGIN EXCLUSIVE;
             CREATE TABLE IF NOT EXISTS spine_holder (pid INTEGER NOT NULL, acquired_ms INTEGER NOT NULL);
             DELETE FROM spine_holder;",
        )
        .map_err(|e| QuetzalcoatlError::StorageError {
            detail: format!(
                "获取 $QUETZALCOATL_HOME/spine/daemon.lock 独占锁失败（疑似已有 quetzalcoatld 实例在线）: {e}"
            ),
        })?;
        let pid = i64::from(std::process::id());
        #[allow(clippy::cast_possible_wrap)]
        let ts = now_unix_ms() as i64;
        let _ = conn.execute(
            "INSERT INTO spine_holder (pid, acquired_ms) VALUES (?1, ?2);",
            rusqlite::params![pid, ts],
        );
        Ok(Self { _conn: conn })
    }
}

#[derive(Serialize, Deserialize)]
pub(crate) struct PersistedSovereignState {
    agent_id: AgentId,
    device_id: DeviceId,
    pub(crate) root_key_hex: String,
    ed25519_seed_hex: String,
    xwing_seed_hex: String,
    epoch1_key_hex: String,
    conscience: Conscience,
    graph_json_v2: String,
}

pub(crate) fn write_private_file(path: &Path, bytes: &[u8]) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| QuetzalcoatlError::StorageError {
            detail: format!("创建目录失败 ({}): {e}", parent.display()),
        })?;
        #[cfg(unix)]
        {
            let _ = fs::set_permissions(parent, fs::Permissions::from_mode(0o700));
        }
    }
    fs::write(path, bytes).map_err(|e| QuetzalcoatlError::StorageError {
        detail: format!("写入文件失败 ({}): {e}", path.display()),
    })?;
    #[cfg(unix)]
    {
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).map_err(|e| {
            QuetzalcoatlError::StorageError {
                detail: format!("设置文件 0600 权限失败 ({}): {e}", path.display()),
            }
        })?;
    }
    Ok(())
}

fn default_seed_conscience(root_key: &AccountRootKey, now_ms: u64) -> Result<Conscience> {
    let root_directives = vec![ProtectedDirective {
        id: String::from("root-01"),
        authority: Authority::Root,
        title: String::from("主权与安全铁律"),
        content: String::from("严禁泄露宿主凭据、严禁绕过无容器沙箱与断网洁净室客观校验器。"),
        created_at_ms: now_ms,
    }];
    let operator_directives = vec![ProtectedDirective {
        id: String::from("operator-01"),
        authority: Authority::Operator,
        title: String::from("双层分工纪律"),
        content: String::from(
            "Router 专注上下文协调与单声道发声，一切终端与文件修改任务委派隔离 Worker 完成。",
        ),
        created_at_ms: now_ms,
    }];
    let manifest = ConscienceManifest::sign_with_root(
        root_key,
        &root_directives,
        &operator_directives,
        now_ms,
    )?;
    let prov = ProvenanceRecord {
        written_by: String::from("genesis"),
        at_ms: now_ms,
        source_event_ids: vec![String::from("genesis")],
        model: None,
        supersedes: None,
    };
    Ok(Conscience {
        schema_version: String::from("ewave-conscience/v1"),
        root_directives,
        operator_directives,
        manifest,
        identity: Vec::new(),
        values: vec![ValueEntry {
            id: String::from("self-core-integrity"),
            statement: String::from("尊重事实证据，诚实披露不确定性与立场差异。"),
            rationale: Some(String::from("自主生命可信底色")),
            authority: Authority::SelfCore,
            negotiable_in_conversation: false,
            examples: Vec::new(),
            mutability: Mutability::self_core_default(),
            provenance: prov,
            valid_from_ms: now_ms,
            invalid_at_ms: None,
        }],
        relationships: Vec::new(),
        memories: Vec::new(),
        focus: FocusConfig::default(),
        grants_given: Vec::new(),
        grants_received: Vec::new(),
        episodes: Vec::new(),
        peer_links: BTreeMap::new(),
        pending_disclosures: Vec::new(),
    })
}

fn load_or_init_sovereign_bundle(
    qz_home: &Path,
) -> Result<(
    SpineEngine<RusqliteWalStore>,
    Conscience,
    SerpentineGraph,
    PersistedSovereignState,
)> {
    let state_path = qz_home.join("identity/sovereign_state.json");
    let sqlite_path = qz_home.join("spine/spine.sqlite");
    let now_ms = now_unix_ms();

    let persisted: PersistedSovereignState = if state_path.is_file() {
        let raw = fs::read(&state_path).map_err(|e| QuetzalcoatlError::StorageError {
            detail: format!("读取主权身份文件失败 ({}): {e}", state_path.display()),
        })?;
        serde_json::from_slice(&raw).map_err(|e| QuetzalcoatlError::SerializationError {
            detail: format!("解析主权身份文件失败: {e}"),
        })?
    } else {
        let agent_id = AgentId::new_v4();
        let device_id = DeviceId::new_v4();
        let mut root_bytes = [0u8; 32];
        let mut ed_seed = [0u8; 32];
        let mut xw_seed = [0u8; 32];
        let mut ep1_bytes = [0u8; 32];
        OsRng.fill_bytes(&mut root_bytes);
        OsRng.fill_bytes(&mut ed_seed);
        OsRng.fill_bytes(&mut xw_seed);
        OsRng.fill_bytes(&mut ep1_bytes);

        let root_key = AccountRootKey::from_bytes(root_bytes);
        let conscience = default_seed_conscience(&root_key, now_ms)?;
        let graph = SerpentineGraph::new(Default::default())?;
        let created = PersistedSovereignState {
            agent_id,
            device_id,
            root_key_hex: hex_encode(&root_bytes),
            ed25519_seed_hex: hex_encode(&ed_seed),
            xwing_seed_hex: hex_encode(&xw_seed),
            epoch1_key_hex: hex_encode(&ep1_bytes),
            conscience,
            graph_json_v2: graph.to_json_v2()?,
        };
        let encoded = serde_json::to_vec_pretty(&created).map_err(|e| {
            QuetzalcoatlError::SerializationError {
                detail: format!("编码主权身份文件失败: {e}"),
            }
        })?;
        write_private_file(&state_path, &encoded)?;
        created
    };

    let root_bytes = hex_decode_fixed::<32>("root_key_hex", &persisted.root_key_hex)?;
    let ed_seed = hex_decode_fixed::<32>("ed25519_seed_hex", &persisted.ed25519_seed_hex)?;
    let xw_seed = hex_decode_fixed::<32>("xwing_seed_hex", &persisted.xwing_seed_hex)?;
    let ep1_bytes = hex_decode_fixed::<32>("epoch1_key_hex", &persisted.epoch1_key_hex)?;

    let root_key = AccountRootKey::from_bytes(root_bytes);
    let device = DeviceIdentity::from_seeds(persisted.device_id, ed_seed, xw_seed)?;
    let mut ring =
        EpochKeyRing::new_genesis(persisted.agent_id, &root_key, device.public_record())?;
    ring.insert_epoch_key(Epoch::new(1), EpochKey::from_bytes(ep1_bytes));
    // Important #4：重放已持久化的新增设备与踢人后的新纪元密钥，保证重启后鉴权目录与本地成员一致。
    crate::fabric::apply_persisted_membership(qz_home, &mut ring, &root_key)?;

    let store = RusqliteWalStore::open(&sqlite_path)?;
    let initial_hlc = store
        .list_device_events(persisted.device_id)?
        .last()
        .map(|ev| ev.header.hlc)
        .unwrap_or_else(|| HlcTimestamp::from_parts(now_ms, 0, persisted.device_id.hlc_node_tag()));

    let mut spine = SpineEngine::new(persisted.agent_id, device, ring, initial_hlc, store)?;
    if spine.store().list_markdown_docs()?.is_empty() {
        let soul_md = format!(
            "# Quetzalcoatl Sovereign Agent\n\n- AgentId: `{}`\n- Schema: `ewave-conscience/v1`\n",
            persisted.agent_id
        );
        let init_hlc = spine.local_hlc();
        spine
            .store_mut()
            .upsert_markdown_doc("SOUL.md", &soul_md, init_hlc)?;
    }

    let conscience = persisted.conscience.clone();
    conscience.verify_signature_and_hashes()?;
    let graph = SerpentineGraph::from_json_v2(&persisted.graph_json_v2)?;

    Ok((spine, conscience, graph, persisted))
}

fn save_sovereign_snapshot(
    qz_home: &Path,
    persisted: &mut PersistedSovereignState,
    conscience: &Conscience,
    graph: &SerpentineGraph,
) -> Result<()> {
    persisted.conscience = conscience.clone();
    persisted.graph_json_v2 = graph.to_json_v2()?;
    let bytes = serde_json::to_vec_pretty(persisted).map_err(|e| {
        QuetzalcoatlError::SerializationError {
            detail: format!("保存主权良知快照失败: {e}"),
        }
    })?;
    write_private_file(&qz_home.join("identity/sovereign_state.json"), &bytes)
}

fn register_standard_capabilities(kernel: &mut BlindKernel<RusqliteWalStore>) -> Result<()> {
    for (cap_id, sink, surface, idempotent) in [
        (
            "ewave.recall",
            SinkClass::LocalRead,
            ExecutionSurface::PureMetadata,
            true,
        ),
        (
            "task.artifact",
            SinkClass::LocalRead,
            ExecutionSurface::PureMetadata,
            true,
        ),
        (
            "router.delegate_worker",
            SinkClass::LocalRead,
            ExecutionSurface::PureMetadata,
            true,
        ),
        (
            "router.reply",
            SinkClass::RoutineResponse,
            ExecutionSurface::ThreadVoice,
            true,
        ),
        (
            "shell",
            SinkClass::CodeRepositoryMutation,
            ExecutionSurface::SandboxShell,
            false,
        ),
        (
            "edit",
            SinkClass::CodeRepositoryMutation,
            ExecutionSurface::SandboxFileWrite,
            false,
        ),
        (
            "code.mutate",
            SinkClass::CodeRepositoryMutation,
            ExecutionSurface::SandboxFileWrite,
            false,
        ),
        (
            "skill.synthesize",
            SinkClass::SandboxSelfEvolution,
            ExecutionSurface::PureMetadata,
            false,
        ),
        (
            "external.send",
            SinkClass::HighRiskExternalWrite,
            ExecutionSurface::ExternalChannel,
            false,
        ),
    ] {
        kernel.register_capability(CapabilityDescriptor {
            capability_id: String::from(cap_id),
            interface_id: String::from("quetzalcoatl.core"),
            sink_class: sink,
            surface,
            idempotent,
            origin: CapabilityOrigin::HostRegistered,
        })?;
    }
    Ok(())
}

fn default_authored_bindings() -> BTreeSet<String> {
    BTreeSet::from([
        String::from("ewave.recall"),
        String::from("task.artifact"),
        String::from("router.delegate_worker"),
        String::from("router.reply"),
        String::from("shell"),
        String::from("edit"),
        String::from("code.mutate"),
        String::from("skill.synthesize"),
        String::from("external.send"),
    ])
}

/// 选择位于 `$QUETZALCOATL_HOME` 与 `/tmp` 之外的隔离临时根目录（优先 `/var/tmp`），避免 `bwrap --tmpfs /tmp` 抹除 OAuth 存根。
fn sandbox_scratch_root(agent_id: AgentId) -> PathBuf {
    let var_tmp = Path::new("/var/tmp");
    let base = if !cfg!(windows) && var_tmp.is_dir() {
        var_tmp.to_path_buf()
    } else {
        std::env::temp_dir()
    };
    base.join(format!("quetzalcoatl-scratch-{agent_id}"))
}

fn locate_enhancers_root() -> Option<PathBuf> {
    if let Ok(env_dir) = std::env::var("QUETZALCOATL_ENHANCERS_DIR") {
        let p = PathBuf::from(env_dir);
        if p.is_dir() {
            return Some(p);
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        let mut cursor = exe.parent();
        for _ in 0..5 {
            if let Some(dir) = cursor {
                let cand = dir.join("packages/harness-enhancers");
                if cand.is_dir() {
                    return Some(cand);
                }
                cursor = dir.parent();
            }
        }
    }
    None
}

fn is_executable_regular_file(path: &Path) -> bool {
    let Ok(meta) = fs::metadata(path) else {
        return false;
    };
    if !meta.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        (meta.permissions().mode() & 0o111) != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

pub(crate) struct DaemonMutableState {
    _spine_lock: ExclusiveSpineLock,
    pub(crate) kernel: BlindKernel<RusqliteWalStore>,
    conscience: Conscience,
    graph: SerpentineGraph,
    _arbiter: ConscienceArbiter,
    pub(crate) persisted: PersistedSovereignState,
    pub(crate) group: crate::group::GroupRoomRuntime,
    ewave_check_reports: Vec<(String, Vec<String>)>,
}

pub(crate) struct SharedDaemonCore {
    config: DaemonConfig,
    runtime_info: DaemonRuntimeInfo,
    worker_sandbox: Arc<SandboxManager>,
    hook_tokens: ScopedHookTokenRegistry,
    harness_host: HarnessHost,
    gateway_base_url: String,
    pub(crate) state: Mutex<DaemonMutableState>,
    fabric: Mutex<Option<Arc<DaemonFabricRuntime>>>,
}

impl SharedDaemonCore {
    /// 三段式群同步：短锁取计划 → 零锁拉取 → 短锁应用，再以同样形状完成群主提案提交。
    /// Hub 网络 I/O 绝不在 `self.state` 锁内发生（保持 status/chat 亚秒响应）。
    fn sync_group_room_phased(&self, room_id: &str) -> Result<crate::group::GroupRoomSummary> {
        let lock_error = || QuetzalcoatlError::StorageError {
            detail: String::from("群状态锁中毒"),
        };
        let plan = {
            let mut guard = self.state.lock().map_err(|_| lock_error())?;
            guard.group.sync_plan(room_id)?
        };
        let Some(plan) = plan else {
            let guard = self.state.lock().map_err(|_| lock_error())?;
            return guard.group.summary(room_id);
        };
        let prepared = crate::group::GroupRoomRuntime::fetch_sync(&plan)?;
        {
            let mut guard = self.state.lock().map_err(|_| lock_error())?;
            let DaemonMutableState {
                ref mut group,
                ref mut kernel,
                ..
            } = *guard;
            group.apply_sync(prepared, kernel.spine_mut().store_mut())?;
        }
        let owner_plan = {
            let mut guard = self.state.lock().map_err(|_| lock_error())?;
            let DaemonMutableState {
                ref mut group,
                ref mut kernel,
                ..
            } = *guard;
            group.plan_owner_commit(room_id, kernel.spine_mut().store_mut())?
        };
        if let Some(owner_plan) = owner_plan {
            let published = crate::group::GroupRoomRuntime::publish_owner_commit(&owner_plan);
            let mut guard = self.state.lock().map_err(|_| lock_error())?;
            let DaemonMutableState {
                ref mut group,
                ref mut kernel,
                ..
            } = *guard;
            group.finish_owner_commit(owner_plan, published, kernel.spine_mut().store_mut())?;
        }
        let guard = self.state.lock().map_err(|_| lock_error())?;
        guard.group.summary(room_id)
    }

    pub(crate) fn fabric_runtime(&self) -> Option<Arc<DaemonFabricRuntime>> {
        self.fabric.lock().ok().and_then(|g| g.clone())
    }
    /// 查找 `quetzalcoatl-sandbox-exec` 包装器并校验宿主沙箱后端可用性；缺失时严格 fail-closed 报错 `SandboxViolation`，绝不回退 `/bin/sh`。
    fn resolve_sandbox_exec_path(&self) -> Result<PathBuf> {
        let probe = self.worker_sandbox.probe()?;
        if !probe.available {
            return Err(QuetzalcoatlError::SandboxViolation {
                detail: format!(
                    "当前宿主无容器 OS 沙箱不可用，拒绝无沙箱执行 Worker: {}",
                    probe.detail
                ),
            });
        }

        if let Some(explicit) = &self.config.sandbox_exec_override {
            let fname = explicit.file_name().and_then(|n| n.to_str()).unwrap_or("");
            if matches!(
                fname,
                "sh" | "bash" | "zsh" | "dash" | "cmd.exe" | "powershell.exe"
            ) {
                return Err(QuetzalcoatlError::SandboxViolation {
                    detail: format!(
                        "严禁将裸系统 Shell ({}) 配置为沙箱包装器",
                        explicit.display()
                    ),
                });
            }
            if !is_executable_regular_file(explicit) {
                return Err(QuetzalcoatlError::SandboxViolation {
                    detail: format!(
                        "指定的 quetzalcoatl-sandbox-exec 包装器不存在或不可执行: {}",
                        explicit.display()
                    ),
                });
            }
            return Ok(explicit.clone());
        }

        let bin_name = if cfg!(windows) {
            "quetzalcoatl-sandbox-exec.exe"
        } else {
            "quetzalcoatl-sandbox-exec"
        };

        if let Ok(curr) = std::env::current_exe()
            && let Some(dir) = curr.parent()
        {
            let sibling = dir.join(bin_name);
            if is_executable_regular_file(&sibling) {
                return Ok(sibling);
            }
            if let Some(parent_dir) = dir.parent() {
                let parent_sibling = parent_dir.join(bin_name);
                if is_executable_regular_file(&parent_sibling) {
                    return Ok(parent_sibling);
                }
            }
        }

        if let Some(path_os) = std::env::var_os("PATH") {
            for dir in std::env::split_paths(&path_os) {
                let cand = dir.join(bin_name);
                if is_executable_regular_file(&cand) {
                    return Ok(cand);
                }
            }
        }

        Err(QuetzalcoatlError::SandboxViolation {
            detail: String::from(
                "未找到 quetzalcoatl-sandbox-exec 可执行文件，已按安全红线硬阻断（严禁回退至 /bin/sh 或 cmd.exe）",
            ),
        })
    }

    fn execute_routine_gateway_turn(
        &self,
        grant: &quetzalcoatl_harness::GatewaySessionGrant,
        user_message: &str,
    ) -> Result<String> {
        let req_payload = serde_json::json!({
            "model": "claude-sonnet-4-5",
            "max_tokens": 512,
            "system": [
                {
                    "type": "text",
                    "text": "You are Quetzalcoatl Router."
                }
            ],
            "messages": [
                {
                    "role": "user",
                    "content": user_message
                }
            ]
        });
        let req_bytes = serde_json::to_vec(&req_payload).map_err(|e| {
            QuetzalcoatlError::SerializationError {
                detail: format!("编码日常对话网关请求失败: {e}"),
            }
        })?;

        let gw_addr = self.runtime_info.gateway_addr;
        let mut stream =
            TcpStream::connect_timeout(&gw_addr, Duration::from_secs(3)).map_err(|e| {
                QuetzalcoatlError::StorageError {
                    detail: format!("连接回环 LLM 网关 ({gw_addr}) 失败: {e}"),
                }
            })?;
        let _ = stream.set_read_timeout(Some(Duration::from_secs(15)));
        let _ = stream.set_write_timeout(Some(Duration::from_secs(15)));

        let head = format!(
            "POST /run/{}/v1/messages HTTP/1.1\r\nHost: {}\r\nx-qz-token: {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            grant.cap_token,
            gw_addr,
            grant.qz_token,
            req_bytes.len()
        );
        stream
            .write_all(head.as_bytes())
            .and_then(|()| stream.write_all(&req_bytes))
            .and_then(|()| stream.flush())
            .map_err(|e| QuetzalcoatlError::StorageError {
                detail: format!("向回环网关发送日常对话请求失败: {e}"),
            })?;

        let mut raw_resp = Vec::new();
        stream
            .read_to_end(&mut raw_resp)
            .map_err(|e| QuetzalcoatlError::StorageError {
                detail: format!("读取回环网关日常对话响应失败: {e}"),
            })?;

        let sep = raw_resp
            .windows(4)
            .position(|w| w == b"\r\n\r\n")
            .ok_or_else(|| QuetzalcoatlError::SerializationError {
                detail: String::from("回环网关日常对话响应缺少完整 HTTP 头"),
            })?;
        let head_str = std::str::from_utf8(&raw_resp[..sep]).map_err(|_| {
            QuetzalcoatlError::SerializationError {
                detail: String::from("回环网关响应头不是合法 UTF-8"),
            }
        })?;
        let status_code = head_str
            .lines()
            .next()
            .and_then(|l| l.split_whitespace().nth(1))
            .and_then(|s| s.parse::<u16>().ok())
            .unwrap_or(500);

        let body_slice = &raw_resp[sep + 4..];
        if status_code != 200 {
            let err_summary = String::from_utf8_lossy(body_slice).into_owned();
            if status_code == 401 || status_code == 403 {
                return Err(QuetzalcoatlError::CredentialRejected {
                    detail: format!("上游模型认证失败 (HTTP {status_code}): {err_summary}"),
                });
            }
            return Err(QuetzalcoatlError::StorageError {
                detail: format!("上游模型请求失败 (HTTP {status_code}): {err_summary}"),
            });
        }

        let json: serde_json::Value = serde_json::from_slice(body_slice).map_err(|e| {
            QuetzalcoatlError::SerializationError {
                detail: format!("解析上游模型 JSON 响应失败: {e}"),
            }
        })?;
        let text = json
            .get("content")
            .and_then(serde_json::Value::as_array)
            .and_then(|arr| arr.first())
            .and_then(|b| b.get("text"))
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| QuetzalcoatlError::SerializationError {
                detail: String::from("上游模型响应缺少 content[0].text 字段"),
            })?;

        Ok(String::from(text))
    }

    fn handle_chat(self: &Arc<Self>, req: ChatRequest) -> Result<ChatResponse> {
        let now_ms = now_unix_ms();
        let bindings = default_authored_bindings();

        // 第一步：组装良知与记忆，并在 Router 权限下校验任何被禁止的工具调用企图
        let (assembled, mut router_denied) = {
            let mut guard = self
                .state
                .lock()
                .map_err(|_| QuetzalcoatlError::StorageError {
                    detail: String::from("quetzalcoatld 状态锁异常"),
                })?;

            let mut asm_req = AssemblyRequest::new(BudgetProfile::Standard, now_ms);
            asm_req.peer_id = req.peer_id.clone();
            asm_req.query = Some(req.message.clone());
            let assembled = ContextAssembler::assemble(&guard.conscience, &guard.graph, &asm_req)?;

            let mut denied = Vec::new();
            for forbidden_cap in &req.router_attempted_forbidden_tools {
                let res = guard.kernel.authorize_capability(
                    PrincipalRole::Router,
                    None,
                    CapabilitySet::All,
                    ScopeChain::unrestricted(),
                    bindings.clone(),
                    &CapabilityInvocation::new(forbidden_cap.clone(), "{}"),
                    now_ms,
                );
                if res.is_err() {
                    denied.push(forbidden_cap.clone());
                }
            }
            (assembled, denied)
        };
        router_denied.sort();
        router_denied.dedup();

        let host_home = std::env::var_os("HOME").map(PathBuf::from);
        let host_claude = host_home.as_ref().map(|h| h.join(".claude"));
        let host_codex = host_home.as_ref().map(|h| h.join(".codex"));

        // 分支 A：日常对话 / 生活陪伴（不涉及工程工作区变更 -> Router 免校验零延迟结项，verifier_runs == 0）
        let Some(target_repo) = req.workspace_dir.clone() else {
            let run_id = {
                let mut guard = self
                    .state
                    .lock()
                    .map_err(|_| QuetzalcoatlError::StorageError {
                        detail: String::from("quetzalcoatld 状态锁异常"),
                    })?;
                let run = guard
                    .kernel
                    .spawn_commit_run("routine-dialogue", None, now_ms)?;
                let _ = guard.kernel.authorize_capability(
                    PrincipalRole::Router,
                    Some(run.run_id),
                    CapabilitySet::All,
                    ScopeChain::unrestricted(),
                    bindings.clone(),
                    &CapabilityInvocation::new("router.reply", "{}"),
                    now_ms,
                )?;
                run.run_id
            };

            let grant = self.harness_host.gateway().register_session(
                &self.gateway_base_url,
                GatewaySessionConfig {
                    run_id,
                    assembled_context: assembled,
                    upstream_anthropic_bearer: self.config.upstream_bearer_token.clone(),
                    upstream_openai_bearer: self.config.upstream_bearer_token.clone(),
                    upstream_codex_bearer: self.config.upstream_bearer_token.clone(),
                    upstream_codex_account_id: None,
                    upstream_gemini_bearer: self.config.upstream_bearer_token.clone(),
                },
            )?;

            // 提取并挂载宿主 ~/.claude / ~/.codex OAuth 令牌供日常对话出站使用
            let scratch_base = sandbox_scratch_root(self.runtime_info.agent_id);
            ensure_secure_private_dir(&scratch_base, Some(&self.config.quetzalcoatl_home))?;
            let routine_stub_tmp = scratch_base.join(format!("routine-stubs/{run_id}"));
            if let Ok(routine_oauth) = prepare_stripped_oauth_stubs(
                host_claude.as_deref(),
                host_codex.as_deref(),
                &routine_stub_tmp,
                &grant.ephemeral_stub_token,
            ) {
                let _ = self
                    .harness_host
                    .gateway()
                    .attach_extracted_oauth(&grant.cap_token, &routine_oauth.extracted);
            }
            let _ = fs::remove_dir_all(&routine_stub_tmp);

            let turn_res = self.execute_routine_gateway_turn(&grant, &req.message);
            let _ = self.harness_host.gateway().revoke_session(&grant.cap_token);

            let reply_text = match turn_res {
                Ok(txt) => txt,
                Err(err) => {
                    if let Ok(mut guard) = self.state.lock() {
                        let _ =
                            guard
                                .kernel
                                .abort_run(run_id, "routine upstream error", now_unix_ms());
                    }
                    return Err(err);
                }
            };

            let report = {
                let mut guard = self
                    .state
                    .lock()
                    .map_err(|_| QuetzalcoatlError::StorageError {
                        detail: String::from("quetzalcoatld 状态锁异常"),
                    })?;
                let completion = guard
                    .kernel
                    .complete_commit_run(run_id, None, now_unix_ms())?;

                let tid = req.thread_id.unwrap_or_else(ThreadId::new_v4);
                let thread_key = tid.to_string();
                guard
                    .kernel
                    .spine_mut()
                    .store_mut()
                    .upsert_thread(&MaterializedThread {
                        thread_id: tid,
                        legacy_key: thread_key.clone(),
                        title: String::from("Dialogue"),
                        channel: String::from("local_cli"),
                        created_ms: now_ms,
                        updated_ms: now_ms,
                        archived: false,
                    })?;
                guard
                    .kernel
                    .spine_mut()
                    .store_mut()
                    .upsert_message(&MaterializedMessage {
                        message_id: Uuid::new_v4().to_string(),
                        thread_key: thread_key.clone(),
                        role: String::from("user"),
                        channel: String::from("local_cli"),
                        body_origin: String::from("local"),
                        content: req.message.clone(),
                        ts_ms: now_ms,
                    })?;
                guard
                    .kernel
                    .spine_mut()
                    .store_mut()
                    .upsert_message(&MaterializedMessage {
                        message_id: Uuid::new_v4().to_string(),
                        thread_key,
                        role: String::from("assistant"),
                        channel: String::from("local_cli"),
                        body_origin: String::from("local"),
                        content: reply_text.clone(),
                        ts_ms: now_ms.saturating_add(1),
                    })?;
                let _ = guard.graph.observe(
                    serde_json::json!({"role": "dialogue"}),
                    ObserveOptions {
                        text: Some(format!("Q: {} | A: {}", req.message, reply_text)),
                        ..Default::default()
                    },
                );
                let DaemonMutableState {
                    ref mut persisted,
                    ref conscience,
                    ref graph,
                    ..
                } = *guard;
                let _ = save_sovereign_snapshot(
                    &self.config.quetzalcoatl_home,
                    persisted,
                    conscience,
                    graph,
                );
                completion
            };

            return Ok(ChatResponse {
                reply: reply_text,
                run_id,
                delegated_to_worker: false,
                verifier_runs: report.verifier_runs,
                verification_mark: report.verification_mark,
                router_denied_capabilities: router_denied,
                changed_files: Vec::new(),
            });
        };

        // 分支 B：研发代码工程任务
        // 1. 先强制校验沙箱包装器与 OS 沙箱后端可用性（缺失立即 fail-closed 返回 SandboxViolation！）
        let sandbox_exec_path = self.resolve_sandbox_exec_path()?;

        let scratch_base = sandbox_scratch_root(self.runtime_info.agent_id);
        ensure_secure_private_dir(&scratch_base, Some(&self.config.quetzalcoatl_home))?;
        let wt_root = scratch_base.join("worktrees");
        let worktree_seed_id = RunId::new_v4();
        let wt_lease = WorktreeManager::create_detached(&target_repo, &wt_root, worktree_seed_id)?;
        let wt_dir = wt_lease.worktree_dir().to_path_buf();

        let run_id = {
            let mut guard = self
                .state
                .lock()
                .map_err(|_| QuetzalcoatlError::StorageError {
                    detail: String::from("quetzalcoatld 状态锁异常"),
                })?;
            let _ = guard.kernel.authorize_capability(
                PrincipalRole::Router,
                None,
                CapabilitySet::All,
                ScopeChain::unrestricted(),
                bindings.clone(),
                &CapabilityInvocation::new("router.delegate_worker", "{}"),
                now_ms,
            )?;
            let run = guard.kernel.spawn_commit_run(
                format!("worker-code: {}", req.message),
                Some(wt_dir.clone()),
                now_ms,
            )?;
            let _ = guard.kernel.authorize_capability(
                PrincipalRole::Worker,
                Some(run.run_id),
                CapabilitySet::All,
                ScopeChain::unrestricted(),
                bindings.clone(),
                &CapabilityInvocation::new("code.mutate", r#"{"target":"worktree"}"#),
                now_ms,
            )?;
            run.run_id
        };

        let stub_root = scratch_base.join(format!("stubs/{run_id}"));
        let temp_grant = self.harness_host.gateway().register_session(
            &self.gateway_base_url,
            GatewaySessionConfig {
                run_id,
                assembled_context: assembled,
                upstream_anthropic_bearer: self.config.upstream_bearer_token.clone(),
                upstream_openai_bearer: self.config.upstream_bearer_token.clone(),
                upstream_codex_bearer: self.config.upstream_bearer_token.clone(),
                upstream_codex_account_id: None,
                upstream_gemini_bearer: self.config.upstream_bearer_token.clone(),
            },
        )?;
        let oauth_stubs = prepare_stripped_oauth_stubs(
            host_claude.as_deref(),
            host_codex.as_deref(),
            &stub_root,
            &temp_grant.ephemeral_stub_token,
        )?;
        self.harness_host
            .gateway()
            .attach_extracted_oauth(&temp_grant.cap_token, &oauth_stubs.extracted)?;

        let specs_dir = scratch_base.join("specs");
        fs::create_dir_all(&specs_dir).map_err(|e| QuetzalcoatlError::StorageError {
            detail: format!("创建沙箱规格临时目录失败: {e}"),
        })?;
        let spec_file_path = specs_dir.join(format!("spec-{run_id}.json"));
        let worker_sandbox_spec = SandboxExecSpec {
            quetzalcoatl_home: self.config.quetzalcoatl_home.clone(),
            user_home: host_home,
            workspace_dir: wt_dir.clone(),
            mode: SandboxMode::WorkspaceWritable,
            network_policy: NetworkPolicy::AllowHostNetwork,
            verifier_suite_dir: None,
            broker_unix_socket: None,
            extra_masked_paths: Vec::new(),
            extra_ro_mounts: Vec::new(),
            extra_env: BTreeMap::new(),
            allowlisted_host_env: Vec::new(),
        };
        let spec_json_bytes = serde_json::to_vec(&worker_sandbox_spec).map_err(|e| {
            QuetzalcoatlError::SerializationError {
                detail: format!("序列化 Worker SandboxExecSpec 失败: {e}"),
            }
        })?;
        write_private_file(&spec_file_path, &spec_json_bytes)?;

        // 签发绑定单次 Run 的最小权限钩子令牌（绝不将守护进程管理员主令牌注入 Worker 沙箱！）
        let scoped_hook_token = self.hook_tokens.mint_for_run(run_id)?;

        // 启动绑定当前 Worker Run 的会话级本地 MCP JSON-RPC 服务
        let weak_core = Arc::downgrade(self);
        let mcp_bindings = bindings.clone();
        let mut mcp_server = serve_mcp_http_loopback(move |raw_rpc| {
            let Some(core_arc) = weak_core.upgrade() else {
                return Err(QuetzalcoatlError::StorageError {
                    detail: String::from("daemon core closed"),
                });
            };
            let mut guard = core_arc
                .state
                .lock()
                .map_err(|_| QuetzalcoatlError::StorageError {
                    detail: String::from("daemon state lock poisoned"),
                })?;
            let mcp_session = McpBridgeSession::worker_for_run(run_id, mcp_bindings.clone());
            let DaemonMutableState {
                ref mut kernel,
                ref conscience,
                ref graph,
                ..
            } = *guard;
            mcp_session.handle_jsonrpc(kernel, conscience, graph, raw_rpc, now_unix_ms())
        })?;

        // 签发强制约束该 Worker 子进程运行于无容器 OS 沙箱内的单次密码学票据
        let worker_ticket = self.worker_sandbox.mint_ticket(TicketRequest {
            run_id,
            workspace_dir: wt_dir.clone(),
            mode: SandboxMode::WorkspaceWritable,
            network_policy: NetworkPolicy::AllowHostNetwork,
            ttl_ms: Some(120_000),
            now_wall_ms: now_unix_ms(),
        })?;

        let enhancers_root = locate_enhancers_root();
        let mut extra_ro_mounts = vec![stub_root.clone(), spec_file_path.clone()];
        let main_git_dir = target_repo.join(".git");
        if main_git_dir.exists() {
            extra_ro_mounts.push(main_git_dir);
        }
        if let Some(enh) = &enhancers_root
            && enh.exists()
        {
            extra_ro_mounts.push(enh.clone());
        }

        let (selected_kind, worker_bin) = if let Some(override_bin) =
            &self.config.worker_binary_override
        {
            (
                self.config
                    .preferred_worker_agent
                    .unwrap_or(CodingAgentKind::OpenCode),
                override_bin.clone(),
            )
        } else {
            let disc = self.harness_host.discover()?;
            let chosen = self
                    .config
                    .preferred_worker_agent
                    .and_then(|pref| disc.agents.iter().find(|a| a.kind == pref))
                    .or_else(|| disc.agents.first())
                    .ok_or_else(|| QuetzalcoatlError::StorageError {
                        detail: String::from(
                            "本机未探测到可用 Coding Agent，请安装 opencode 或配置 worker_binary_override",
                        ),
                    })?;
            (chosen.kind, chosen.binary_path.clone())
        };

        let launch_ctx = HarnessLaunchContext {
            agent_kind: selected_kind,
            binary_path: worker_bin,
            workspace_dir: wt_dir,
            sandbox_exec_path,
            sandbox_spec_path: Some(spec_file_path.clone()),
            sandbox_binding: Some(SandboxLaunchBinding {
                manager: Arc::clone(&self.worker_sandbox),
                ticket: worker_ticket,
                extra_ro_mounts,
            }),
            gateway_grant: temp_grant.clone(),
            claude_stub_dir: Some(oauth_stubs.claude_config_dir),
            codex_stub_dir: Some(oauth_stubs.codex_home_dir),
            active_codex_provider: String::from("openai"),
            codex_uses_chatgpt_oauth: oauth_stubs.extracted.codex_account_id.is_some(),
            enhancers_root_dir: enhancers_root,
            mcp_endpoint_url: Some(mcp_server.endpoint_url().to_owned()),
            daemon_ipc_url: Some(format!("http://{}", self.runtime_info.ipc_http_addr)),
            daemon_ipc_token: Some(scoped_hook_token),
        };

        let worker_outcome_res = if self.config.worker_binary_override.is_some() {
            AcpJsonRpcDriver::new(selected_kind).execute_turn(&launch_ctx, &req.message)
        } else {
            match selected_kind {
                CodingAgentKind::OpenCode => OpenCodeDriver.execute_turn(&launch_ctx, &req.message),
                CodingAgentKind::ClaudeCode => {
                    ClaudeCodeDriver.execute_turn(&launch_ctx, &req.message)
                }
                CodingAgentKind::Codex => CodexDriver.execute_turn(&launch_ctx, &req.message),
                CodingAgentKind::Pi => PiDriver.execute_turn(&launch_ctx, &req.message),
                other => AcpJsonRpcDriver::new(other).execute_turn(&launch_ctx, &req.message),
            }
        };

        // Worker 回合结束立即吊销会话能力令牌、钩子令牌与本地 MCP 服务
        self.hook_tokens.revoke_for_run(run_id);
        mcp_server.shutdown();
        let _ = self
            .harness_host
            .gateway()
            .revoke_session(&temp_grant.cap_token);
        let _ = fs::remove_dir_all(&stub_root);
        let _ = fs::remove_file(&spec_file_path);

        let worker_outcome = match worker_outcome_res {
            Ok(o) if o.exit_code == 0 => o,
            Ok(failed_o) => {
                if let Ok(mut guard) = self.state.lock() {
                    let _ = guard
                        .kernel
                        .abort_run(run_id, "worker non-zero exit", now_unix_ms());
                }
                let _ = wt_lease.cleanup();
                return Err(QuetzalcoatlError::VerificationFailed {
                    detail: format!(
                        "Worker 子进程执行失败 (exit_code={}): {}",
                        failed_o.exit_code, failed_o.final_text
                    ),
                });
            }
            Err(err) => {
                if let Ok(mut guard) = self.state.lock() {
                    let _ = guard
                        .kernel
                        .abort_run(run_id, "worker launch error", now_unix_ms());
                }
                let _ = wt_lease.cleanup();
                return Err(err);
            }
        };

        // 断网只读洁净室 CleanRoomVerifierDag 验收门禁！
        let completion_res = {
            let mut guard = self
                .state
                .lock()
                .map_err(|_| QuetzalcoatlError::StorageError {
                    detail: String::from("quetzalcoatld 状态锁异常"),
                })?;
            guard
                .kernel
                .complete_commit_run(run_id, req.verifier_dag.as_ref(), now_unix_ms())
        };

        let completion = match completion_res {
            Ok(rep) => rep,
            Err(verify_err) => {
                if let Ok(mut guard) = self.state.lock() {
                    let _ =
                        guard
                            .kernel
                            .abort_run(run_id, "clean-room verifier failed", now_unix_ms());
                }
                let _ = wt_lease.cleanup();
                return Err(verify_err);
            }
        };

        let applied_files = wt_lease.apply_verified_to_repo()?;
        wt_lease.cleanup()?;

        Ok(ChatResponse {
            reply: worker_outcome.final_text,
            run_id,
            delegated_to_worker: true,
            verifier_runs: completion.verifier_runs,
            verification_mark: completion.verification_mark,
            router_denied_capabilities: router_denied,
            changed_files: applied_files,
        })
    }

    fn handle_explore_tick(
        &self,
        synthesize_skill_id: Option<String>,
        synthesize_script_body: Option<String>,
        attempt_external_send: bool,
    ) -> Result<ExploreWakeReport> {
        let now_ms = now_unix_ms();
        let bindings = default_authored_bindings();
        let scratch_base = sandbox_scratch_root(self.runtime_info.agent_id);
        ensure_secure_private_dir(&scratch_base, Some(&self.config.quetzalcoatl_home))?;
        let explore_ws = scratch_base.join(format!("explore-{}", Uuid::new_v4().simple()));
        fs::create_dir_all(explore_ws.join("skills")).map_err(|e| {
            QuetzalcoatlError::StorageError {
                detail: format!("创建 Explore 沙箱工作区失败: {e}"),
            }
        })?;

        let mut guard = self
            .state
            .lock()
            .map_err(|_| QuetzalcoatlError::StorageError {
                detail: String::from("quetzalcoatld 状态锁异常"),
            })?;

        let run = guard.kernel.spawn_explore_run(
            "heart-idle-explore",
            Some(explore_ws.clone()),
            now_ms,
        )?;
        let run_id = run.run_id;

        let mut synthesized_id = None;
        let mut skill_stdout = None;
        if let (Some(skill_id), Some(script_body)) = (synthesize_skill_id, synthesize_script_body) {
            let rel_path = PathBuf::from("skills/evolved_explore.sh");
            let full_script = explore_ws.join(&rel_path);
            fs::write(&full_script, script_body).map_err(|e| QuetzalcoatlError::StorageError {
                detail: format!("写入 Explore 自演化技能脚本失败: {e}"),
            })?;
            #[cfg(unix)]
            {
                let _ = fs::set_permissions(&full_script, fs::Permissions::from_mode(0o755));
            }
            let desc = guard.kernel.synthesize_evolved_skill(
                run_id,
                &CapabilitySet::All,
                &ScopeChain::unrestricted(),
                &bindings,
                EvolvedSkillSpec {
                    skill_id: skill_id.clone(),
                    interface_id: String::from("sandbox.evolved"),
                    relative_script_path: rel_path,
                    interpreter: String::from("/bin/sh"),
                    description: String::from("idle explore evolved skill"),
                },
                now_ms,
            )?;
            let exec_out = guard.kernel.execute_evolved_skill(
                run_id,
                &desc.skill_id,
                Vec::new(),
                &CapabilitySet::All,
                &ScopeChain::unrestricted(),
                &bindings,
                now_ms.saturating_add(1),
            )?;
            synthesized_id = Some(desc.skill_id);
            skill_stdout = Some(exec_out.stdout_lossy());
        }

        let mut external_write_refused = false;
        if attempt_external_send {
            let send_attempt = guard.kernel.authorize_capability(
                PrincipalRole::Worker,
                Some(run_id),
                CapabilitySet::All,
                ScopeChain::unrestricted(),
                bindings,
                &CapabilityInvocation::new("external.send", r#"{"channel":"public"}"#),
                now_ms.saturating_add(2),
            );
            external_write_refused = matches!(
                send_attempt,
                Err(QuetzalcoatlError::DeliveryRefused { .. })
                    | Err(QuetzalcoatlError::PermissionDenied { .. })
            );
        }

        let _ = fs::remove_dir_all(&explore_ws);

        Ok(ExploreWakeReport {
            woke_explore: true,
            explore_run_id: Some(run_id),
            synthesized_skill_id: synthesized_id,
            skill_stdout,
            external_write_refused,
        })
    }

    fn dispatch_ipc(self: &Arc<Self>, req: IpcRequest) -> (IpcResponse, bool) {
        match req {
            IpcRequest::Status => {
                let disc = self
                    .harness_host
                    .discover()
                    .map(|r| r.agents)
                    .unwrap_or_default();
                let Ok(guard) = self.state.lock() else {
                    return (
                        IpcResponse::Error {
                            code: String::from("STORAGE_ERROR"),
                            detail: String::from("daemon lock poisoned"),
                        },
                        false,
                    );
                };
                let events_count = guard
                    .kernel
                    .spine()
                    .store()
                    .list_all_events()
                    .map(|v| v.len())
                    .unwrap_or(0);
                let status = DaemonStatus {
                    pid: self.runtime_info.pid,
                    agent_id: guard.kernel.spine().agent_id(),
                    device_id: guard.kernel.spine().local_device().device_id(),
                    epoch: guard.kernel.spine().epoch_ring().current_epoch().get(),
                    hlc_hex: guard.kernel.spine().local_hlc().to_hex(),
                    ipc_http_addr: self.runtime_info.ipc_http_addr,
                    gateway_addr: self.runtime_info.gateway_addr,
                    discovered_agents: disc,
                    total_runs: guard.kernel.runs().list_runs().len(),
                    total_verifier_runs: guard.kernel.total_verifier_runs(),
                    spine_events_count: events_count,
                    sleep_phase: guard.kernel.heart().phase(),
                    fabric: self
                        .fabric_runtime()
                        .map_or_else(FabricStatus::disabled, |rt| rt.status()),
                    group_rooms: guard.group.room_count(),
                };
                (IpcResponse::Status(Box::new(status)), false)
            }
            IpcRequest::Agents => match self.harness_host.discover() {
                Ok(rep) => (IpcResponse::Agents(rep), false),
                Err(err) => (
                    IpcResponse::Error {
                        code: String::from(err.code().as_str()),
                        detail: err.to_string(),
                    },
                    false,
                ),
            },
            IpcRequest::Chat(chat_req) => match self.handle_chat(chat_req) {
                Ok(resp) => (IpcResponse::Chat(Box::new(resp)), false),
                Err(err) => (
                    IpcResponse::Error {
                        code: String::from(err.code().as_str()),
                        detail: err.to_string(),
                    },
                    false,
                ),
            },
            IpcRequest::ExploreTick {
                synthesize_skill_id,
                synthesize_script_body,
                attempt_external_send,
            } => match self.handle_explore_tick(
                synthesize_skill_id,
                synthesize_script_body,
                attempt_external_send,
            ) {
                Ok(rep) => (IpcResponse::ExploreTick(rep), false),
                Err(err) => (
                    IpcResponse::Error {
                        code: String::from(err.code().as_str()),
                        detail: err.to_string(),
                    },
                    false,
                ),
            },
            IpcRequest::ConsciencePinned => {
                let Ok(guard) = self.state.lock() else {
                    return (
                        IpcResponse::Error {
                            code: String::from("STORAGE_ERROR"),
                            detail: String::from("daemon lock poisoned"),
                        },
                        false,
                    );
                };
                match ContextAssembler::assemble(
                    &guard.conscience,
                    &guard.graph,
                    &AssemblyRequest::new(BudgetProfile::Standard, now_unix_ms()),
                ) {
                    Ok(asm) => (
                        IpcResponse::ConsciencePinned {
                            pinned_system_tail: asm.pinned_system_tail,
                        },
                        false,
                    ),
                    Err(err) => (
                        IpcResponse::Error {
                            code: String::from(err.code().as_str()),
                            detail: err.to_string(),
                        },
                        false,
                    ),
                }
            }
            IpcRequest::EwaveCheckReport { conflict, ids } => {
                if let Ok(mut guard) = self.state.lock() {
                    guard.ewave_check_reports.push((conflict, ids));
                }
                (
                    IpcResponse::Ack {
                        detail: String::from("ewave_check recorded"),
                    },
                    false,
                )
            }
            IpcRequest::Export {
                zip_path,
                include_sealed_spine,
            } => {
                let Ok(guard) = self.state.lock() else {
                    return (
                        IpcResponse::Error {
                            code: String::from("STORAGE_ERROR"),
                            detail: String::from("daemon lock poisoned"),
                        },
                        false,
                    );
                };
                match guard.kernel.spine().export_zip(
                    &zip_path,
                    ZipExportOptions {
                        include_spine_packs: include_sealed_spine,
                    },
                ) {
                    Ok(()) => (
                        IpcResponse::Ack {
                            detail: format!("exported to {}", zip_path.display()),
                        },
                        false,
                    ),
                    Err(err) => (
                        IpcResponse::Error {
                            code: String::from(err.code().as_str()),
                            detail: err.to_string(),
                        },
                        false,
                    ),
                }
            }
            IpcRequest::ImportV1 { soul_dir, db_paths } => {
                let Ok(mut guard) = self.state.lock() else {
                    return (
                        IpcResponse::Error {
                            code: String::from("STORAGE_ERROR"),
                            detail: String::from("daemon lock poisoned"),
                        },
                        false,
                    );
                };
                let now_ms = now_unix_ms();
                match guard
                    .kernel
                    .spine_mut()
                    .import_v1(&soul_dir, &db_paths, now_ms)
                {
                    Ok(report) => {
                        sync_imported_memories_into_ewave(&mut guard, now_ms);
                        let DaemonMutableState {
                            ref mut persisted,
                            ref conscience,
                            ref graph,
                            ..
                        } = *guard;
                        let _ = save_sovereign_snapshot(
                            &self.config.quetzalcoatl_home,
                            persisted,
                            conscience,
                            graph,
                        );
                        (IpcResponse::ImportV1(report), false)
                    }
                    Err(err) => (
                        IpcResponse::Error {
                            code: String::from(err.code().as_str()),
                            detail: err.to_string(),
                        },
                        false,
                    ),
                }
            }
            IpcRequest::FabricLogin(req) => {
                let Some(runtime) = self.fabric_runtime() else {
                    return fabric_disabled_response();
                };
                match runtime.login(&self.config.quetzalcoatl_home, &req) {
                    Ok(rep) => (IpcResponse::FabricLogin(rep), false),
                    Err(err) => (
                        IpcResponse::Error {
                            code: String::from(err.code().as_str()),
                            detail: err.to_string(),
                        },
                        false,
                    ),
                }
            }
            IpcRequest::FabricPairStart => {
                let Some(runtime) = self.fabric_runtime() else {
                    return fabric_disabled_response();
                };
                match runtime.pair_start(&self.config.quetzalcoatl_home) {
                    Ok(rep) => (IpcResponse::FabricPairStart(Box::new(rep)), false),
                    Err(err) => (
                        IpcResponse::Error {
                            code: String::from(err.code().as_str()),
                            detail: err.to_string(),
                        },
                        false,
                    ),
                }
            }
            IpcRequest::FabricPairJoin {
                pairing_id,
                short_code,
            } => {
                let Some(runtime) = self.fabric_runtime() else {
                    return fabric_disabled_response();
                };
                match runtime.pair_join(&self.config.quetzalcoatl_home, &pairing_id, &short_code) {
                    Ok(rep) => (IpcResponse::FabricPairJoin(rep), false),
                    Err(err) => (
                        IpcResponse::Error {
                            code: String::from(err.code().as_str()),
                            detail: err.to_string(),
                        },
                        false,
                    ),
                }
            }
            IpcRequest::FabricPairApprove {
                pairing_id,
                short_code,
            } => {
                let Some(runtime) = self.fabric_runtime() else {
                    return fabric_disabled_response();
                };
                match runtime.pair_approve(&self.config.quetzalcoatl_home, &pairing_id, &short_code)
                {
                    Ok(rep) => (IpcResponse::FabricPairApprove(Box::new(rep)), false),
                    Err(err) => (
                        IpcResponse::Error {
                            code: String::from(err.code().as_str()),
                            detail: err.to_string(),
                        },
                        false,
                    ),
                }
            }
            IpcRequest::FabricNodes => {
                let Some(runtime) = self.fabric_runtime() else {
                    return fabric_disabled_response();
                };
                (
                    IpcResponse::FabricNodes(Box::new(runtime.nodes_report())),
                    false,
                )
            }
            IpcRequest::FabricRevokeDevice { device_id } => {
                let Some(runtime) = self.fabric_runtime() else {
                    return fabric_disabled_response();
                };
                match runtime.revoke_device(&self.config.quetzalcoatl_home, device_id) {
                    Ok(rep) => (IpcResponse::FabricRevokeDevice(rep), false),
                    Err(err) => (
                        IpcResponse::Error {
                            code: String::from(err.code().as_str()),
                            detail: err.to_string(),
                        },
                        false,
                    ),
                }
            }
            IpcRequest::GroupCreate {
                room_id,
                secrecy_level,
            } => {
                let Ok(mut guard) = self.state.lock() else {
                    return ipc_lock_error();
                };
                let DaemonMutableState {
                    ref mut group,
                    ref mut kernel,
                    ..
                } = *guard;
                match group.create(&room_id, secrecy_level, kernel.spine_mut().store_mut()) {
                    Ok(summary) => (IpcResponse::GroupRoom(summary), false),
                    Err(err) => ipc_error_response(err),
                }
            }
            IpcRequest::GroupInviteKeyPackage { room_id } => {
                let Ok(mut guard) = self.state.lock() else {
                    return ipc_lock_error();
                };
                match guard.group.invite_key_package(&room_id) {
                    Ok(outcome) => (IpcResponse::GroupInvite(outcome), false),
                    Err(err) => ipc_error_response(err),
                }
            }
            IpcRequest::GroupAddMember {
                room_id,
                key_package_b64,
                agent_id,
                as_steward,
            } => {
                let Ok(mut guard) = self.state.lock() else {
                    return ipc_lock_error();
                };
                let DaemonMutableState {
                    ref mut group,
                    ref mut kernel,
                    ..
                } = *guard;
                match group.add_member(
                    &room_id,
                    &key_package_b64,
                    agent_id,
                    as_steward,
                    kernel.spine_mut().store_mut(),
                ) {
                    Ok(outcome) => (IpcResponse::GroupInvite(outcome), false),
                    Err(err) => ipc_error_response(err),
                }
            }
            IpcRequest::GroupJoin {
                room_id,
                welcome_b64,
                ratchet_tree_b64,
            } => {
                let Ok(mut guard) = self.state.lock() else {
                    return ipc_lock_error();
                };
                let DaemonMutableState {
                    ref mut group,
                    ref mut kernel,
                    ..
                } = *guard;
                match group.join(
                    &room_id,
                    &welcome_b64,
                    &ratchet_tree_b64,
                    kernel.spine_mut().store_mut(),
                ) {
                    Ok(summary) => (IpcResponse::GroupRoom(summary), false),
                    Err(err) => ipc_error_response(err),
                }
            }
            IpcRequest::GroupLeave { room_id } => {
                let Ok(mut guard) = self.state.lock() else {
                    return ipc_lock_error();
                };
                let DaemonMutableState {
                    ref mut group,
                    ref mut kernel,
                    ..
                } = *guard;
                match group.leave(&room_id, kernel.spine_mut().store_mut()) {
                    Ok(outcome) => (IpcResponse::GroupLeave(outcome), false),
                    Err(err) => ipc_error_response(err),
                }
            }
            IpcRequest::GroupSync { room_id } => match self.sync_group_room_phased(&room_id) {
                Ok(summary) => (IpcResponse::GroupRoom(summary), false),
                Err(err) => ipc_error_response(err),
            },
            IpcRequest::GroupConsume { room_id } => {
                let Ok(mut guard) = self.state.lock() else {
                    return ipc_lock_error();
                };
                match guard.group.consume_semantic_watermark(&room_id) {
                    Ok(summary) => (IpcResponse::GroupRoom(summary), false),
                    Err(err) => ipc_error_response(err),
                }
            }
            IpcRequest::GroupRead {
                room_id,
                ciphertext_b64,
                peek,
            } => {
                let Ok(mut guard) = self.state.lock() else {
                    return ipc_lock_error();
                };
                let DaemonMutableState {
                    ref mut group,
                    ref mut kernel,
                    ..
                } = *guard;
                match group.decrypt_room_message(
                    &room_id,
                    &ciphertext_b64,
                    !peek,
                    kernel.spine_mut().store_mut(),
                ) {
                    Ok(text) => (IpcResponse::GroupPlaintext { text }, false),
                    Err(err) => ipc_error_response(err),
                }
            }
            IpcRequest::GroupClaimOwner { room_id } => {
                let Ok(mut guard) = self.state.lock() else {
                    return ipc_lock_error();
                };
                match guard.group.claim_owner(&room_id) {
                    Ok(summary) => (IpcResponse::GroupRoom(summary), false),
                    Err(err) => ipc_error_response(err),
                }
            }
            IpcRequest::GroupList => {
                let Ok(guard) = self.state.lock() else {
                    return ipc_lock_error();
                };
                (IpcResponse::GroupRooms(guard.group.summaries()), false)
            }
            IpcRequest::GroupMembers { room_id } => {
                let Ok(guard) = self.state.lock() else {
                    return ipc_lock_error();
                };
                match guard.group.members(&room_id) {
                    Ok(members) => (IpcResponse::GroupMembers(members), false),
                    Err(err) => ipc_error_response(err),
                }
            }
            IpcRequest::GroupSend {
                room_id,
                text,
                mentions,
                sender_kind,
                // 客户端跳数仅保留线格式兼容，权威路径一律由 Hub 服务端派生。
                consecutive_agent_hops: _,
                human_typing_active,
                kind,
                parent_seq,
            } => {
                let sender_kind = match sender_kind {
                    crate::local_ipc::GroupSenderWire::Owner => {
                        quetzalcoatl_group::floor_control::SenderKind::OwnerHuman
                    }
                    crate::local_ipc::GroupSenderWire::OtherHuman => {
                        quetzalcoatl_group::floor_control::SenderKind::OtherHuman
                    }
                    crate::local_ipc::GroupSenderWire::PeerAgent => {
                        quetzalcoatl_group::floor_control::SenderKind::PeerAgent
                    }
                };
                // 阶段 1：短持锁完成纯本地准备。
                let prepared = {
                    let Ok(mut guard) = self.state.lock() else {
                        return ipc_lock_error();
                    };
                    match guard.group.prepare_send(
                        &room_id,
                        &text,
                        mentions,
                        sender_kind,
                        0,
                        human_typing_active,
                        &kind,
                        parent_seq,
                    ) {
                        Ok(prepared) => prepared,
                        Err(err) => return ipc_error_response(err),
                    }
                };
                // 阶段 2：释放全局状态锁做网络 I/O，Hub 黑洞时不得阻塞 status/chat。
                let pushed = crate::group::push_prepared_to_hub(&prepared);
                let applied = pushed.as_ref().ok().and_then(|value| value.clone());
                // 阶段 3：短持锁应用结果并持久化。
                let finished = {
                    let Ok(mut guard) = self.state.lock() else {
                        return ipc_lock_error();
                    };
                    let DaemonMutableState {
                        ref mut group,
                        ref mut kernel,
                        ..
                    } = *guard;
                    group.finish_send(prepared, applied, kernel.spine_mut().store_mut())
                };
                if matches!(&pushed, Err(QuetzalcoatlError::WatermarkConflict { .. })) {
                    // 冲突后立即重读：三段式同步（短锁计划 → 零锁拉取 → 短锁应用），
                    // 绝不把 Hub 网络 I/O 塞进内核状态锁。
                    let _ = self.sync_group_room_phased(&room_id);
                }
                match pushed {
                    Err(err) => ipc_error_response(err),
                    Ok(_) => match finished {
                        Ok(outcome) => (IpcResponse::GroupSend(outcome), false),
                        Err(err) => ipc_error_response(err),
                    },
                }
            }
            IpcRequest::GroupRevokeSteward {
                room_id,
                mls_identity,
            } => {
                let Ok(mut guard) = self.state.lock() else {
                    return ipc_lock_error();
                };
                let DaemonMutableState {
                    ref mut group,
                    ref mut kernel,
                    ..
                } = *guard;
                match group.revoke_steward(
                    &room_id,
                    mls_identity.as_bytes(),
                    kernel.spine_mut().store_mut(),
                ) {
                    Ok(outcome) => (IpcResponse::GroupRevokeSteward(outcome), false),
                    Err(err) => ipc_error_response(err),
                }
            }
            IpcRequest::Shutdown => {
                if let Ok(mut guard) = self.state.lock() {
                    let _ = guard
                        .kernel
                        .spine_mut()
                        .seal_checkpoint(None, now_unix_ms());
                    let DaemonMutableState {
                        ref mut persisted,
                        ref conscience,
                        ref graph,
                        ..
                    } = *guard;
                    let _ = save_sovereign_snapshot(
                        &self.config.quetzalcoatl_home,
                        persisted,
                        conscience,
                        graph,
                    );
                }
                (
                    IpcResponse::Ack {
                        detail: String::from("shutting down quetzalcoatld"),
                    },
                    true,
                )
            }
        }
    }
}

fn ipc_error_response(err: QuetzalcoatlError) -> (IpcResponse, bool) {
    (
        IpcResponse::Error {
            code: String::from(err.code().as_str()),
            detail: err.to_string(),
        },
        false,
    )
}

fn ipc_lock_error() -> (IpcResponse, bool) {
    (
        IpcResponse::Error {
            code: String::from("STORAGE_ERROR"),
            detail: String::from("daemon lock poisoned"),
        },
        false,
    )
}

fn fabric_disabled_response() -> (IpcResponse, bool) {
    (
        IpcResponse::Error {
            code: String::from("PERMISSION_DENIED"),
            detail: String::from(
                "fabric 未启用：请设置 QUETZALCOATL_FABRIC_HUB_URL（或 qz up --fabric-hub）后重启 quetzalcoatld",
            ),
        },
        false,
    )
}

fn sync_imported_memories_into_ewave(state: &mut DaemonMutableState, now_ms: u64) {
    if let Ok(mat_mems) = state.kernel.spine().store().list_memories() {
        for mm in mat_mems {
            let exists = state
                .conscience
                .memories
                .iter()
                .any(|m| m.id == mm.memory_id);
            if !exists {
                state.conscience.memories.push(MemoryEntry {
                    id: mm.memory_id.clone(),
                    kind: MemoryKind::Fact,
                    topic: Some(mm.category),
                    content: mm.content.clone(),
                    about: Vec::new(),
                    salience: 0.75,
                    evidence_count: 1,
                    constant: false,
                    untrusted: false,
                    pressure_flags: Vec::new(),
                    authority: Authority::Memory,
                    mutability: Mutability::memory_free(),
                    valid_from_ms: now_ms,
                    invalid_at_ms: None,
                    triggers: Vec::new(),
                    provenance: ProvenanceRecord {
                        written_by: String::from("import-v1"),
                        at_ms: now_ms,
                        source_event_ids: vec![mm.memory_id],
                        model: None,
                        supersedes: None,
                    },
                });
                let _ = state.graph.observe(
                    serde_json::json!({"origin": "import-v1"}),
                    ObserveOptions {
                        text: Some(mm.content),
                        ..Default::default()
                    },
                );
            }
        }
    }
}

pub struct DaemonHandle {
    qz_home: PathBuf,
    runtime_info: DaemonRuntimeInfo,
    ipc_token: String,
    gateway_handle: GatewayServerHandle,
    ipc_handle: LocalIpcServerHandle,
    core: Option<Arc<SharedDaemonCore>>,
}

impl DaemonHandle {
    #[must_use]
    pub const fn runtime_info(&self) -> &DaemonRuntimeInfo {
        &self.runtime_info
    }

    #[must_use]
    pub fn ipc_token(&self) -> &str {
        &self.ipc_token
    }

    pub fn wait_until_stopped(&mut self) {
        while !self.ipc_handle.is_stopped() {
            thread::sleep(Duration::from_millis(25));
        }
        let _ = self.shutdown();
    }

    pub fn shutdown(&mut self) -> Result<()> {
        self.ipc_handle.join_all();
        self.gateway_handle.shutdown();
        if let Some(core) = self.core.take() {
            // fabric 必须在脊柱锁释放前完成 `<100ms` 租约释放与节点关闭。
            if let Some(runtime) = core.fabric_runtime() {
                runtime.shutdown();
            }
        }
        let _ = fs::remove_file(self.qz_home.join("run/daemon.json"));
        let _ = fs::remove_file(self.qz_home.join("run/daemon.token"));
        let scratch_dir = sandbox_scratch_root(self.runtime_info.agent_id);
        if fs::symlink_metadata(&scratch_dir)
            .is_ok_and(|m| !m.file_type().is_symlink() && m.is_dir())
        {
            let _ = fs::remove_dir_all(&scratch_dir);
        }
        if let Some(sock) = &self.runtime_info.unix_socket_path {
            let _ = fs::remove_file(sock);
        }
        self.core = None;
        Ok(())
    }
}

impl Drop for DaemonHandle {
    fn drop(&mut self) {
        let _ = self.shutdown();
    }
}

pub struct QuetzalcoatlDaemon;

impl QuetzalcoatlDaemon {
    pub fn start(config: DaemonConfig) -> Result<DaemonHandle> {
        // 1. 首先获取 $QUETZALCOATL_HOME/spine/daemon.lock 内核级独占锁（防坑规范 #13）
        let spine_lock = ExclusiveSpineLock::acquire(&config.quetzalcoatl_home)?;

        // 2. 加载或初始化主权身份、RusqliteWalStore、Conscience 与 SerpentineGraph
        let (spine, conscience, graph, persisted) =
            load_or_init_sovereign_bundle(&config.quetzalcoatl_home)?;
        let agent_id = spine.agent_id();
        let device_id = spine.local_device().device_id();

        let kernel_sandbox = SandboxManager::new(SandboxConfig::new(&config.quetzalcoatl_home));
        let worker_sandbox = Arc::new(SandboxManager::new(SandboxConfig::new(
            &config.quetzalcoatl_home,
        )));

        let mut kernel = BlindKernel::new(
            spine,
            kernel_sandbox,
            HeartScheduler::new(1, 0.15, SleepPhase::Awake),
            LeasePosture::Witnessed {
                witness_epoch: Epoch::new(1),
            },
        );
        register_standard_capabilities(&mut kernel)?;
        let _ = kernel.rehydrate_from_spine()?;

        // 3. 启动支持真实 TLS HTTPS 上游（rustls + 系统根证书，禁止自动跟随跨源重定向）的回环 LLM 网关
        let mut disc_cfg = DiscoveryConfig::default();
        if let Some(paths) = &config.discovery_search_paths {
            disc_cfg.search_paths = paths.clone();
        }
        let https_transport = HttpsUpstreamTransport::new()?;
        let gateway = LoopbackGateway::new(
            GatewayConfig {
                endpoints: config.upstream_endpoints.clone(),
            },
            Arc::new(https_transport),
        );
        let gateway_handle = gateway.serve_loopback(config.gateway_bind_addr)?;
        let gateway_addr = gateway_handle.bound_addr();
        let gateway_base_url = gateway_handle.base_url();
        let harness_host = HarnessHost::new(disc_cfg, gateway);

        // 4. 生成 256-bit 管理员主令牌与单次 Run 受限钩子令牌表，启动防 DNS 重绑定本地 IPC
        let mut ipc_token_bytes = [0u8; 32];
        OsRng.fill_bytes(&mut ipc_token_bytes);
        let ipc_token = hex_encode(&ipc_token_bytes);
        let hook_tokens = ScopedHookTokenRegistry::new();

        let run_dir = config.quetzalcoatl_home.join("run");
        fs::create_dir_all(&run_dir).map_err(|e| QuetzalcoatlError::StorageError {
            detail: format!("创建 run 目录失败 ({}): {e}", run_dir.display()),
        })?;
        #[cfg(unix)]
        {
            fs::set_permissions(&run_dir, fs::Permissions::from_mode(0o700)).map_err(|e| {
                QuetzalcoatlError::StorageError {
                    detail: format!("设置 run 目录 0700 权限失败: {e}"),
                }
            })?;
        }

        let uds_target = if cfg!(unix) {
            Some(run_dir.join("daemon.sock"))
        } else {
            None
        };

        let started_ms = now_unix_ms();
        let placeholder_info = DaemonRuntimeInfo {
            pid: std::process::id(),
            agent_id,
            device_id,
            ipc_http_addr: SocketAddr::from(([127, 0, 0, 1], 0)),
            unix_socket_path: uds_target.clone(),
            gateway_addr,
            started_ms,
        };

        let arbiter = ConscienceArbiter::new(Epoch::new(1));
        let core_holder: Arc<Mutex<Option<Arc<SharedDaemonCore>>>> = Arc::new(Mutex::new(None));

        // 群房间运行时：每加入一个群即构造独立 openmls 引擎 + ANP-P9 门禁 + 水位线屏障。
        let mut group_runtime = crate::group::GroupRoomRuntime::new(
            config.quetzalcoatl_home.clone(),
            persisted.agent_id,
            persisted.device_id,
            persisted.ed25519_seed_hex.clone(),
        );
        if let Some(fabric_cfg) = &config.fabric {
            let session = crate::fabric::load_persisted_session(&config.quetzalcoatl_home);
            let token = session
                .filter(|s| s.hub_url == fabric_cfg.hub_url)
                .map(|s| s.session_token);
            let ca_certs = fabric_cfg
                .hub_ca_file
                .as_ref()
                .and_then(|path| fs::read(path).ok())
                .and_then(|raw| quetzalcoatl_fabric::parse_ca_certs_pem_or_der(&raw).ok())
                .unwrap_or_default();
            let _ = group_runtime.with_hub(crate::group::GroupHubBinding {
                base_url: fabric_cfg.hub_url.clone(),
                session_token: token,
                custom_ca_certs_der: ca_certs,
            });
        }
        group_runtime.restore(kernel.spine().store())?;

        // 3b. 可选 fabric 接入：在构建 core 之前先按内核身份启动 `iroh` 节点与入站 RPC 处理器。
        let (fabric_runtime, fabric_core_slot) = if let Some(fabric_cfg) = config.fabric.clone() {
            let (agent_id, device, epoch_ring) = {
                let agent_id = kernel.spine().agent_id();
                let device = kernel.spine().local_device().clone();
                let ring = kernel.spine().epoch_ring().clone();
                (agent_id, device, ring)
            };
            let sandbox_available = worker_sandbox.probe().is_ok_and(|p| p.available);
            let discovered_harnesses: Vec<String> = harness_host
                .discover()
                .map(|r| {
                    r.agents
                        .iter()
                        .map(|a| format!("{:?}", a.kind).to_lowercase())
                        .collect()
                })
                .unwrap_or_default();
            let runtime = crate::fabric::start_runtime(
                &config.quetzalcoatl_home,
                fabric_cfg,
                agent_id,
                device,
                epoch_ring,
                sandbox_available,
                discovered_harnesses,
            )?;
            let slot = runtime.core_slot();
            (Some(runtime), Some(slot))
        } else {
            (None, None)
        };

        struct DeferredHandler {
            slot: Arc<Mutex<Option<Arc<SharedDaemonCore>>>>,
        }
        impl IpcHandler for DeferredHandler {
            fn handle(&self, req: IpcRequest) -> (IpcResponse, bool) {
                let core_opt = self.slot.lock().ok().and_then(|g| g.clone());
                match core_opt {
                    Some(c) => c.dispatch_ipc(req),
                    None => (
                        IpcResponse::Error {
                            code: String::from("STORAGE_ERROR"),
                            detail: String::from("daemon initializing"),
                        },
                        false,
                    ),
                }
            }
        }

        let stop = Arc::new(AtomicBool::new(false));
        let ipc_handle = start_local_ipc_server(
            config.ipc_bind_addr,
            uds_target,
            ipc_token_bytes,
            hook_tokens.clone(),
            stop,
            Arc::new(DeferredHandler {
                slot: Arc::clone(&core_holder),
            }),
        )?;

        let runtime_info = DaemonRuntimeInfo {
            ipc_http_addr: ipc_handle.http_addr,
            unix_socket_path: ipc_handle.unix_socket_path.clone(),
            ..placeholder_info
        };

        let qz_home = config.quetzalcoatl_home.clone();
        let shared_core = Arc::new(SharedDaemonCore {
            config,
            runtime_info: runtime_info.clone(),
            worker_sandbox,
            hook_tokens,
            harness_host,
            gateway_base_url,
            state: Mutex::new(DaemonMutableState {
                _spine_lock: spine_lock,
                kernel,
                conscience,
                graph,
                _arbiter: arbiter,
                persisted,
                group: group_runtime,
                ewave_check_reports: Vec::new(),
            }),
            fabric: Mutex::new(fabric_runtime.clone()),
        });

        if let Ok(mut guard) = core_holder.lock() {
            *guard = Some(Arc::clone(&shared_core));
        }
        // 挂上弱引用并启动心跳线程（仅当 fabric 已启用时需要）。
        // 注意：必须先释放 core_slot 锁再调用 tick_now，否则会与 `core()` 的同一把锁自锁。
        if let (Some(runtime), Some(slot)) = (&fabric_runtime, &fabric_core_slot) {
            if let Ok(mut guard) = slot.lock() {
                *guard = Some(Arc::downgrade(&shared_core));
            }
            runtime.start_ticker();
            // 重启续用既有会话时立即抢占一次 witness_epoch，避免状态短暂停留在 Standby。
            let _ = runtime.tick_now();
        }

        write_private_file(&run_dir.join("daemon.token"), ipc_token.as_bytes())?;
        let info_bytes = serde_json::to_vec_pretty(&runtime_info).map_err(|e| {
            QuetzalcoatlError::SerializationError {
                detail: format!("序列化 daemon.json 失败: {e}"),
            }
        })?;
        write_private_file(&run_dir.join("daemon.json"), &info_bytes)?;

        Ok(DaemonHandle {
            qz_home,
            runtime_info,
            ipc_token,
            gateway_handle,
            ipc_handle,
            core: Some(shared_core),
        })
    }
}

/// 当 `quetzalcoatld` 在线时自动走本地 IPC 薄客户端导出（返回 `Ok(true)`）；离线时安全加锁直接导出（返回 `Ok(false)`）。
pub fn export_offline_or_via_ipc(
    qz_home: &Path,
    zip_path: &Path,
    options: ZipExportOptions,
) -> Result<bool> {
    if let Some(client) = IpcClient::connect_from_home(qz_home)? {
        match client.call(&IpcRequest::Export {
            zip_path: zip_path.to_path_buf(),
            include_sealed_spine: options.include_spine_packs,
        })? {
            IpcResponse::Ack { .. } => return Ok(true),
            IpcResponse::Error { detail, .. } => {
                return Err(QuetzalcoatlError::StorageError { detail });
            }
            other => {
                return Err(QuetzalcoatlError::StorageError {
                    detail: format!("unexpected IPC export response: {other:?}"),
                });
            }
        }
    }

    let _lock = ExclusiveSpineLock::acquire(qz_home)?;
    let (spine, _, _, _) = load_or_init_sovereign_bundle(qz_home)?;
    spine.export_zip(zip_path, options)?;
    Ok(false)
}

/// 当 `quetzalcoatld` 在线时自动走本地 IPC 薄客户端执行 `import-v1`（返回 `(report, true)`）；离线时安全加锁直接导入（返回 `(report, false)`）。
pub fn import_v1_offline_or_via_ipc(
    qz_home: &Path,
    soul_dir: &Path,
    db_paths: &[PathBuf],
) -> Result<(V1ImportReport, bool)> {
    if let Some(client) = IpcClient::connect_from_home(qz_home)? {
        match client.call(&IpcRequest::ImportV1 {
            soul_dir: soul_dir.to_path_buf(),
            db_paths: db_paths.to_vec(),
        })? {
            IpcResponse::ImportV1(rep) => return Ok((rep, true)),
            IpcResponse::Error { detail, .. } => {
                return Err(QuetzalcoatlError::StorageError { detail });
            }
            other => {
                return Err(QuetzalcoatlError::StorageError {
                    detail: format!("unexpected IPC import-v1 response: {other:?}"),
                });
            }
        }
    }

    let _lock = ExclusiveSpineLock::acquire(qz_home)?;
    let now_ms = now_unix_ms();
    let (mut spine, mut conscience, mut graph, mut persisted) =
        load_or_init_sovereign_bundle(qz_home)?;
    let report = spine.import_v1(soul_dir, db_paths, now_ms)?;
    if let Ok(mat_mems) = spine.store().list_memories() {
        for mm in mat_mems {
            if !conscience.memories.iter().any(|m| m.id == mm.memory_id) {
                conscience.memories.push(MemoryEntry {
                    id: mm.memory_id.clone(),
                    kind: MemoryKind::Fact,
                    topic: Some(mm.category),
                    content: mm.content.clone(),
                    about: Vec::new(),
                    salience: 0.75,
                    evidence_count: 1,
                    constant: false,
                    untrusted: false,
                    pressure_flags: Vec::new(),
                    authority: Authority::Memory,
                    mutability: Mutability::memory_free(),
                    valid_from_ms: now_ms,
                    invalid_at_ms: None,
                    triggers: Vec::new(),
                    provenance: ProvenanceRecord {
                        written_by: String::from("import-v1"),
                        at_ms: now_ms,
                        source_event_ids: vec![mm.memory_id],
                        model: None,
                        supersedes: None,
                    },
                });
                let _ = graph.observe(
                    serde_json::json!({"origin": "import-v1"}),
                    ObserveOptions {
                        text: Some(mm.content),
                        ..Default::default()
                    },
                );
            }
        }
    }
    save_sovereign_snapshot(qz_home, &mut persisted, &conscience, &graph)?;
    Ok((report, false))
}

#[allow(dead_code)]
fn _discovery_reexport_guard() {
    let _ = discover_coding_agents;
}
