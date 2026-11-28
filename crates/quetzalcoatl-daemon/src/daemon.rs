#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]

//! `quetzalcoatld` 核心守护进程编排器（唯一脊柱锁、`Router ↔ Worker` OS 沙箱隔离派发、独立 Git Worktree 与洁净室 `Verifier` 闭环）。

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::net::SocketAddr;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use quetzalcoatl_capabilities::{
    SayItBatchOutcome, SayItTarget, SovereignScope, ingest_batch_into_graph, ingest_file_into_graph,
};
use quetzalcoatl_channels::ChannelHealth;
use quetzalcoatl_crypto::PackCompartment;
use quetzalcoatl_crypto::{
    AccountRootKey, DeviceIdentity, EpochKey, EpochKeyRing, hex_decode_fixed, hex_encode,
};
use quetzalcoatl_ewave::{
    AssemblyRequest, Authority, BudgetProfile, Conscience, ConscienceArbiter, ConscienceManifest,
    ContextAssembler, FocusConfig, IdentityBlock, MemoryEntry, MemoryKind, Mutability,
    ObserveOptions, ProtectedDirective, ProvenanceRecord, SerpentineGraph, ValueEntry, journal,
};
use quetzalcoatl_harness::{
    AcpJsonRpcDriver, ClaudeCodeDriver, CodexDriver, CodingAgentKind, DiscoveredAgent,
    DiscoveryConfig, GatewayConfig, GatewayServerHandle, GatewaySessionConfig,
    GatewayUpstreamEndpoints, HarnessDriver, HarnessHost, HarnessLaunchContext,
    HttpsUpstreamTransport, LoopbackGateway, McpBridgeSession, OpenCodeDriver, PiDriver,
    SandboxLaunchBinding, WorktreeManager, discover_coding_agents, ensure_secure_private_dir,
    host_oauth_available, prepare_stripped_oauth_stubs, serve_mcp_http_loopback,
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
    MaterializedStore, RusqliteWalStore, SpineEngine, V1ImportReport, ZipExportOptions,
};
use quetzalcoatl_types::{
    AgentId, DeviceId, Epoch, HlcTimestamp, QuetzalcoatlError, Result, RunId,
};
use rand_core::{OsRng, RngCore};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::fabric::{DaemonFabricConfig, DaemonFabricRuntime, FabricStatus};
use crate::local_ipc::{
    IpcClient, IpcHandler, IpcRequest, IpcResponse, LocalIpcServerHandle, start_local_ipc_server,
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

/// 「宿主没有可用凭据」的唯一错误出口：受管运行直接复用本机宿主已有的登录，
/// 所以只说真实可行的路径，绝不引导用户去填 API Key。
fn model_not_configured_error() -> QuetzalcoatlError {
    QuetzalcoatlError::ModelNotConfigured {
        detail: String::from(
            "本机宿主没有可用的登录凭据。受管运行直接复用宿主自己的登录，任选一种后重试：\
             ① 在本机登录 Claude Code（终端运行 `claude`，再输入 /login）；\
             ② 在本机登录 Codex（终端运行 `codex login`）；\
             ③ 设置环境变量 QUETZALCOATL_UPSTREAM_BEARER_TOKEN（自建兼容网关可填任意占位值），\
             然后重启 `qz up`。说明：https://quetzal.plutokeating.beer/docs/install",
        ),
    }
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
    /// 可选声学语音门（默认关闭；`QUETZALCOATL_VOICE_AI=1` 时启用）。
    pub voice_ai: crate::voice::VoiceAiConfig,
    /// 同源 Web 控制台静态资源目录（`QUETZALCOATL_WEB_DIR` 或可执行文件旁 `web/`）。
    pub web_dir: Option<PathBuf>,
    /// 要你拍板时发桌面通知（默认关；常驻的 `quetzalcoatld` 打开，`QUETZALCOATL_NOTIFY=0` 关掉）。
    pub desktop_notifications: bool,
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
        let voice_ai = crate::voice::VoiceAiConfig::from_process_env();
        let web_dir = resolve_web_console_dir();

        Self {
            quetzalcoatl_home,
            ipc_bind_addr: SocketAddr::from(([127, 0, 0, 1], 0)),
            gateway_bind_addr: SocketAddr::from(([127, 0, 0, 1], 0)),
            upstream_endpoints: endpoints,
            preferred_worker_agent: None,
            worker_binary_override,
            sandbox_exec_override,
            upstream_bearer_token: std::env::var("QUETZALCOATL_UPSTREAM_BEARER_TOKEN")
                .ok()
                .filter(|token| !token.trim().is_empty()),
            discovery_search_paths: None,
            fabric,
            voice_ai,
            web_dir,
            desktop_notifications: false,
        }
    }
}

/// Web 控制台目录解析：`QUETZALCOATL_WEB_DIR` 优先，其次可执行文件旁的 `web/`（存在才生效）。
#[must_use]
pub fn resolve_web_console_dir() -> Option<PathBuf> {
    if let Some(value) = std::env::var_os("QUETZALCOATL_WEB_DIR") {
        let path = PathBuf::from(value);
        if !path.as_os_str().is_empty() {
            return Some(path);
        }
    }
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join("web")))
        .filter(|dir| dir.is_dir())
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
    /// 七大通道族的显式 opt-in 健康状态（默认全部关闭）。
    pub channels: Vec<ChannelHealth>,
}

/// 委派一次受管运行：把一件要做完的事交给本机宿主（Coding Agent）在隔离 worktree 里完成，
/// 并在断网只读洁净室里验收。循环与模型调用都发生在宿主进程里，守护进程自身不调用模型。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DelegateRunRequest {
    /// 交给宿主的任务描述。
    pub task: String,
    pub peer_id: Option<String>,
    /// 目标仓库；Worker 只在由它派生的独立 worktree 里写入。
    pub workspace_dir: PathBuf,
    pub verifier_dag: Option<CleanRoomVerifierDag>,
    pub router_attempted_forbidden_tools: Vec<String>,
    /// 验收通过后先不合进目标仓库，等用户拍板（用户自己的仓库一律如此）。
    #[serde(default)]
    pub hold_for_approval: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DelegateRunResponse {
    /// 宿主进程的最终输出。
    pub final_text: String,
    pub run_id: RunId,
    pub verifier_runs: u64,
    pub verification_mark: Option<VerificationMark>,
    pub router_denied_capabilities: Vec<String>,
    pub changed_files: Vec<String>,
    /// 等你拍板时的编号；已经合进去时为空。
    #[serde(default)]
    pub approval_id: Option<String>,
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

/// 内存里的主权状态：身份、密钥材料与记忆图快照。
///
/// 落盘时分成两个文件：`identity/sovereign_state.json`（身份与记忆图）与
/// `identity/keys.json`（密钥材料）。良知不在这里——它由脊柱里的变更事件重放得到。
pub(crate) struct PersistedSovereignState {
    agent_id: AgentId,
    device_id: DeviceId,
    pub(crate) root_key_hex: String,
    ed25519_seed_hex: String,
    xwing_seed_hex: String,
    epoch1_key_hex: String,
    graph_json_v2: String,
}

/// `identity/sovereign_state.json` 的内容。
///
/// 旧版把密钥与整份良知也放在这个文件里；读到时接过来迁走，之后再也不写回。
#[derive(Serialize, Deserialize)]
struct SovereignStateFile {
    agent_id: AgentId,
    device_id: DeviceId,
    graph_json_v2: String,
    #[serde(default, skip_serializing)]
    root_key_hex: Option<String>,
    #[serde(default, skip_serializing)]
    ed25519_seed_hex: Option<String>,
    #[serde(default, skip_serializing)]
    xwing_seed_hex: Option<String>,
    #[serde(default, skip_serializing)]
    epoch1_key_hex: Option<String>,
    #[serde(default, skip_serializing)]
    conscience: Option<Conscience>,
}

/// `identity/keys.json` 的内容：根私钥、设备种子与首个纪元密钥。
#[derive(Serialize, Deserialize)]
struct SovereignKeysFile {
    root_key_hex: String,
    ed25519_seed_hex: String,
    xwing_seed_hex: String,
    epoch1_key_hex: String,
}

const SOVEREIGN_STATE_FILE: &str = "identity/sovereign_state.json";
const SOVEREIGN_KEYS_FILE: &str = "identity/keys.json";

fn write_json_private<T: Serialize>(path: &Path, value: &T, what: &str) -> Result<()> {
    let bytes =
        serde_json::to_vec_pretty(value).map_err(|e| QuetzalcoatlError::SerializationError {
            detail: format!("编码{what}失败: {e}"),
        })?;
    write_private_file(path, &bytes)
}

fn read_json_file<T: serde::de::DeserializeOwned>(path: &Path, what: &str) -> Result<T> {
    let raw = fs::read(path).map_err(|e| QuetzalcoatlError::StorageError {
        detail: format!("读取{what}失败 ({}): {e}", path.display()),
    })?;
    serde_json::from_slice(&raw).map_err(|e| QuetzalcoatlError::SerializationError {
        detail: format!("解析{what}失败: {e}"),
    })
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

/// 首次启动时写入的占位 `SOUL.md` 的标题；用来区分占位文档与用户带进来的自述。
const GENESIS_SOUL_HEADING: &str = "# Quetzalcoatl Sovereign Agent";
/// 身份块里承载自述的那一条的编号。
const IDENTITY_SOUL_ID: &str = "soul";

/// 旧版种子里两条受保护条款的编号。它们是工程纪律，不是用户的底线，也不该进用户的宿主会话。
const LEGACY_SEED_ROOT_ID: &str = "root-01";
const LEGACY_SEED_OPERATOR_ID: &str = "operator-01";

/// 出厂的部署约束：对任何宿主会话都成立、也都无害的一条。
fn default_operator_directives(now_ms: u64) -> Vec<ProtectedDirective> {
    vec![ProtectedDirective {
        id: String::from("operator-credentials"),
        authority: Authority::Operator,
        title: String::from("凭据不外泄"),
        content: String::from("不向任何对话、工具或外部通道泄露本机的登录凭据与密钥。"),
        created_at_ms: now_ms,
    }]
}

/// 把旧版种子换成中性种子并重新签名。只在两层受保护条款与旧种子逐条相同时才动，
/// 用户自己签过的底线一律不碰。返回是否发生了替换。
fn retire_legacy_seed(
    conscience: &mut Conscience,
    root_key: &AccountRootKey,
    now_ms: u64,
) -> Result<bool> {
    let is_legacy = conscience.root_directives.len() == 1
        && conscience.operator_directives.len() == 1
        && conscience
            .root_directives
            .iter()
            .all(|d| d.id == LEGACY_SEED_ROOT_ID)
        && conscience
            .operator_directives
            .iter()
            .all(|d| d.id == LEGACY_SEED_OPERATOR_ID);
    if !is_legacy {
        return Ok(false);
    }
    conscience.root_directives = Vec::new();
    conscience.operator_directives = default_operator_directives(now_ms);
    conscience.manifest = ConscienceManifest::sign_with_root(
        root_key,
        &conscience.root_directives,
        &conscience.operator_directives,
        now_ms,
    )?;
    Ok(true)
}

/// 出厂良知：底线为空，等用户亲手签署；部署约束只有一条中性条款；核心价值只有诚实这一条。
fn default_seed_conscience(root_key: &AccountRootKey, now_ms: u64) -> Result<Conscience> {
    let root_directives: Vec<ProtectedDirective> = Vec::new();
    let operator_directives = default_operator_directives(now_ms);
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
    let state_path = qz_home.join(SOVEREIGN_STATE_FILE);
    let keys_path = qz_home.join(SOVEREIGN_KEYS_FILE);
    let now_ms = now_unix_ms();

    // 旧版快照里带着的整份良知：只在变更日志还是空的时候用来收编为基线。
    let mut legacy_conscience: Option<Conscience> = None;
    let persisted = if state_path.is_file() {
        let state: SovereignStateFile = read_json_file(&state_path, "主权身份文件")?;
        let keys: SovereignKeysFile = if keys_path.is_file() {
            read_json_file(&keys_path, "密钥文件")?
        } else {
            // 旧版把密钥放在身份文件里：迁到单独的密钥文件，并把身份文件重写成不带密钥的样子。
            let missing = || QuetzalcoatlError::StorageError {
                detail: String::from("主权身份文件里没有密钥，也找不到单独的密钥文件"),
            };
            let migrated = SovereignKeysFile {
                root_key_hex: state.root_key_hex.clone().ok_or_else(missing)?,
                ed25519_seed_hex: state.ed25519_seed_hex.clone().ok_or_else(missing)?,
                xwing_seed_hex: state.xwing_seed_hex.clone().ok_or_else(missing)?,
                epoch1_key_hex: state.epoch1_key_hex.clone().ok_or_else(missing)?,
            };
            write_json_private(&keys_path, &migrated, "密钥文件")?;
            migrated
        };
        legacy_conscience = state.conscience;
        PersistedSovereignState {
            agent_id: state.agent_id,
            device_id: state.device_id,
            root_key_hex: keys.root_key_hex,
            ed25519_seed_hex: keys.ed25519_seed_hex,
            xwing_seed_hex: keys.xwing_seed_hex,
            epoch1_key_hex: keys.epoch1_key_hex,
            graph_json_v2: state.graph_json_v2,
        }
    } else {
        let mut root_bytes = [0u8; 32];
        let mut ed_seed = [0u8; 32];
        let mut xw_seed = [0u8; 32];
        let mut ep1_bytes = [0u8; 32];
        OsRng.fill_bytes(&mut root_bytes);
        OsRng.fill_bytes(&mut ed_seed);
        OsRng.fill_bytes(&mut xw_seed);
        OsRng.fill_bytes(&mut ep1_bytes);
        let graph = SerpentineGraph::new(Default::default())?;
        let created = PersistedSovereignState {
            agent_id: AgentId::new_v4(),
            device_id: DeviceId::new_v4(),
            root_key_hex: hex_encode(&root_bytes),
            ed25519_seed_hex: hex_encode(&ed_seed),
            xwing_seed_hex: hex_encode(&xw_seed),
            epoch1_key_hex: hex_encode(&ep1_bytes),
            graph_json_v2: graph.to_json_v2()?,
        };
        write_json_private(
            &keys_path,
            &SovereignKeysFile {
                root_key_hex: created.root_key_hex.clone(),
                ed25519_seed_hex: created.ed25519_seed_hex.clone(),
                xwing_seed_hex: created.xwing_seed_hex.clone(),
                epoch1_key_hex: created.epoch1_key_hex.clone(),
            },
            "密钥文件",
        )?;
        created
    };

    let (mut spine, root_key) = open_sovereign_spine(qz_home, &persisted, now_ms)?;

    // 良知以脊柱里的变更事件为准。还没有任何变更事件时（全新安装，或从旧版升级上来），
    // 把出厂良知或旧快照里的良知收编为基线，从此只追加。
    let adopting = qz_home.join(crate::pair_adopt::ADOPTING_MARKER).exists();
    let conscience = match journal::replay(&mut spine)? {
        Some(replayed) => {
            if adopting {
                let _ = fs::remove_file(qz_home.join(crate::pair_adopt::ADOPTING_MARKER));
            }
            replayed
        }
        // 刚经配对接管、还没同步到旧设备的海：先用出厂良知顶着，但不写进变更日志，
        // 否则它会盖过旧设备的海。
        None if adopting => default_seed_conscience(&root_key, now_ms)?,
        None => {
            let mut baseline = match legacy_conscience {
                Some(legacy) => legacy,
                None => default_seed_conscience(&root_key, now_ms)?,
            };
            let _ = retire_legacy_seed(&mut baseline, &root_key, now_ms)?;
            journal::commit(
                &mut spine,
                None,
                &baseline,
                SEA_ACTOR_SYSTEM,
                1,
                "收编为基线",
                now_ms,
            )?;
            baseline
        }
    };
    conscience.verify_signature_and_hashes()?;
    let graph = SerpentineGraph::from_json_v2(&persisted.graph_json_v2)?;
    save_sovereign_state(qz_home, &persisted)?;

    Ok((spine, conscience, graph, persisted))
}

/// 按身份与密钥打开本机的脊柱（含组网成员表的重放）。不碰良知。
fn open_sovereign_spine(
    qz_home: &Path,
    persisted: &PersistedSovereignState,
    now_ms: u64,
) -> Result<(SpineEngine<RusqliteWalStore>, AccountRootKey)> {
    let sqlite_path = qz_home.join("spine/spine.sqlite");
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
            "{GENESIS_SOUL_HEADING}\n\n- AgentId: `{}`\n- Schema: `ewave-conscience/v1`\n",
            persisted.agent_id
        );
        let init_hlc = spine.local_hlc();
        spine
            .store_mut()
            .upsert_markdown_doc("SOUL.md", &soul_md, init_hlc)?;
    }

    Ok((spine, root_key))
}

/// 恢复时：按恢复包写出身份文件与密钥文件。
pub(crate) fn write_restored_identity(
    qz_home: &Path,
    payload: &crate::sea_archive::RecoveryPayload,
) -> Result<()> {
    write_json_private(
        &qz_home.join(SOVEREIGN_KEYS_FILE),
        &SovereignKeysFile {
            root_key_hex: payload.root_key_hex.clone(),
            ed25519_seed_hex: payload.ed25519_seed_hex.clone(),
            xwing_seed_hex: payload.xwing_seed_hex.clone(),
            epoch1_key_hex: payload.epoch1_key_hex.clone(),
        },
        "密钥文件",
    )?;
    write_json_private(
        &qz_home.join(SOVEREIGN_STATE_FILE),
        &SovereignStateFile {
            agent_id: payload.agent_id,
            device_id: payload.device_id,
            graph_json_v2: payload.graph_json_v2.clone(),
            root_key_hex: None,
            ed25519_seed_hex: None,
            xwing_seed_hex: None,
            epoch1_key_hex: None,
            conscience: None,
        },
        "主权身份文件",
    )
}

/// 配对接管时：按配对来的身份写出身份文件与密钥文件。
pub(crate) fn write_adopted_identity(
    qz_home: &Path,
    adoption: &crate::pair_adopt::PairAdoption,
) -> Result<()> {
    let epoch1 = adoption.epoch_keys.get(&1).cloned().unwrap_or_default();
    write_json_private(
        &qz_home.join(SOVEREIGN_KEYS_FILE),
        &SovereignKeysFile {
            root_key_hex: adoption.root_key_hex.clone(),
            ed25519_seed_hex: adoption.ed25519_seed_hex.clone(),
            xwing_seed_hex: adoption.xwing_seed_hex.clone(),
            epoch1_key_hex: epoch1,
        },
        "密钥文件",
    )?;
    write_json_private(
        &qz_home.join(SOVEREIGN_STATE_FILE),
        &SovereignStateFile {
            agent_id: adoption.agent_id,
            device_id: adoption.device_id,
            graph_json_v2: SerpentineGraph::new(Default::default())?.to_json_v2()?,
            root_key_hex: None,
            ed25519_seed_hex: None,
            xwing_seed_hex: None,
            epoch1_key_hex: None,
            conscience: None,
        },
        "主权身份文件",
    )
}

/// 恢复时：按刚写出的身份打开一个空脊柱，不收编任何基线。
pub(crate) fn open_restored_spine(
    qz_home: &Path,
) -> Result<(SpineEngine<RusqliteWalStore>, AccountRootKey)> {
    let state: SovereignStateFile =
        read_json_file(&qz_home.join(SOVEREIGN_STATE_FILE), "主权身份文件")?;
    let keys: SovereignKeysFile = read_json_file(&qz_home.join(SOVEREIGN_KEYS_FILE), "密钥文件")?;
    let persisted = PersistedSovereignState {
        agent_id: state.agent_id,
        device_id: state.device_id,
        root_key_hex: keys.root_key_hex,
        ed25519_seed_hex: keys.ed25519_seed_hex,
        xwing_seed_hex: keys.xwing_seed_hex,
        epoch1_key_hex: keys.epoch1_key_hex,
        graph_json_v2: state.graph_json_v2,
    };
    open_sovereign_spine(qz_home, &persisted, now_unix_ms())
}

/// 导出：脊柱的签名事件与物化视图，加上人读得懂的海；给了口令时再加上恢复包。
/// 返回这份导出能不能用来恢复。
fn export_sea(
    qz_home: &Path,
    zip_path: &Path,
    options: ZipExportOptions,
    passphrase: Option<&str>,
    parts: (
        &SpineEngine<RusqliteWalStore>,
        &Conscience,
        &SerpentineGraph,
        &PersistedSovereignState,
    ),
) -> Result<bool> {
    let (spine, conscience, graph, persisted) = parts;
    let mut extra = crate::sea_archive::readable_sea_files(conscience);
    let recoverable = if let Some(passphrase) = passphrase {
        crate::sea_governance::require_owner_passphrase(qz_home, passphrase)?;
        let payload = crate::sea_archive::RecoveryPayload {
            version: 1,
            agent_id: persisted.agent_id,
            device_id: persisted.device_id,
            root_key_hex: persisted.root_key_hex.clone(),
            ed25519_seed_hex: persisted.ed25519_seed_hex.clone(),
            xwing_seed_hex: persisted.xwing_seed_hex.clone(),
            epoch1_key_hex: persisted.epoch1_key_hex.clone(),
            membership_state_json: crate::sea_archive::read_membership_state(qz_home),
            entry_keys: crate::sea_archive::collect_entry_keys(spine.store(), conscience)?,
            graph_json_v2: graph.to_json_v2()?,
        };
        extra.push((
            String::from(crate::sea_archive::RECOVERY_BUNDLE_PATH),
            crate::sea_archive::seal_recovery_bundle(&payload, passphrase)?,
        ));
        true
    } else {
        false
    };
    spine.export_zip_with(zip_path, options, &extra)?;
    Ok(recoverable)
}

/// 把身份与记忆图写回 `identity/sovereign_state.json`。密钥与良知都不在这个文件里。
fn save_sovereign_state(qz_home: &Path, persisted: &PersistedSovereignState) -> Result<()> {
    write_json_private(
        &qz_home.join(SOVEREIGN_STATE_FILE),
        &SovereignStateFile {
            agent_id: persisted.agent_id,
            device_id: persisted.device_id,
            graph_json_v2: persisted.graph_json_v2.clone(),
            root_key_hex: None,
            ed25519_seed_hex: None,
            xwing_seed_hex: None,
            epoch1_key_hex: None,
            conscience: None,
        },
        "主权身份文件",
    )
}

/// 记忆图是本机的检索索引，整份存成快照。
pub(crate) fn save_graph_snapshot(
    qz_home: &Path,
    persisted: &mut PersistedSovereignState,
    graph: &SerpentineGraph,
) -> Result<()> {
    persisted.graph_json_v2 = graph.to_json_v2()?;
    save_sovereign_state(qz_home, persisted)
}

/// 变更事件里的执行者标记。
pub(crate) const SEA_ACTOR_SYSTEM: &str = "system";
pub(crate) const SEA_ACTOR_IMPORT: &str = "import";

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
    pub(crate) conscience: Conscience,
    pub(crate) graph: SerpentineGraph,
    pub(crate) arbiter: ConscienceArbiter,
    pub(crate) persisted: PersistedSovereignState,
    pub(crate) group: crate::group::GroupRoomRuntime,
    /// opt-in 声学语音门；`None` 时零 AEC/VAD 状态、零副作用。
    pub(crate) voice: Option<crate::voice::VoiceActivitySessions>,
    pub(crate) channels: crate::channels::ChannelRuntime,
    /// 领域包运行时：默认 `personal-companion`，切换留痕并持久化。
    pub(crate) domains: crate::domains::DomainRuntime,
}

impl DaemonMutableState {
    /// 把良知自 `before` 以来的改动写成一条变更事件。没有改动时什么都不写。
    ///
    /// 写失败时把内存里的良知恢复成 `before`：内存永远不能领先于脊柱。
    pub(crate) fn commit_sea(
        &mut self,
        before: Conscience,
        actor: &str,
        epoch: Epoch,
        summary: &str,
        now_ms: u64,
    ) -> Result<Option<u64>> {
        match journal::commit(
            self.kernel.spine_mut(),
            Some(&before),
            &self.conscience,
            actor,
            epoch.get(),
            summary,
            now_ms,
        ) {
            Ok(seq) => Ok(seq),
            Err(err) => {
                self.conscience = before;
                Err(err)
            }
        }
    }
}

pub(crate) struct SharedDaemonCore {
    pub(crate) config: DaemonConfig,
    pub(crate) runtime_info: DaemonRuntimeInfo,
    worker_sandbox: Arc<SandboxManager>,
    harness_host: HarnessHost,
    gateway_base_url: String,
    pub(crate) state: Mutex<DaemonMutableState>,
    /// 用户自己的宿主会话登记表（有自己的锁，读它不需要全局状态锁）。
    pub(crate) host_sessions: crate::host_sessions::HostSessionRegistry,
    pub(crate) approvals: crate::approvals::ApprovalQueue,
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

    /// 通道长连接所有权锚点：有 fabric 时跟随 Hub `witness_epoch` 与 Router 持有者；
    /// 无 fabric 时由本机守护进程独占。
    /// 派生/加载本设备独立入站密钥并登记到 Hub（已登录时）。
    fn register_channel_ingress_key(&self) -> Result<crate::ingress_key::ChannelIngressKey> {
        let (epoch_key, device_id) = {
            let guard = self
                .state
                .lock()
                .map_err(|_| QuetzalcoatlError::StorageError {
                    detail: String::from("daemon lock poisoned"),
                })?;
            let epoch_key = guard
                .kernel
                .spine()
                .epoch_ring()
                .current_epoch_key()
                .cloned()
                .ok_or_else(|| QuetzalcoatlError::PermissionDenied {
                    detail: String::from("当前纪元缺少活跃对称密钥，无法派生通道入站密钥"),
                })?;
            (epoch_key, guard.kernel.spine().local_device().device_id())
        };
        let key = crate::ingress_key::ChannelIngressKey::load_or_derive(
            &self.config.quetzalcoatl_home,
            &epoch_key,
            device_id,
        )?;
        if let Some(runtime) = self.fabric_runtime() {
            runtime.register_channel_ingress_key(
                self.runtime_info.agent_id,
                key.public_key(),
                key.key_id(),
                &key.device_id().to_string(),
            )?;
        }
        Ok(key)
    }

    /// 写良知时用的纪元：联网时是 Hub 见证的租约纪元，单机时为 1。
    /// 多设备下用它丢弃过期纪元写下的变更。
    pub(crate) fn sea_epoch(&self) -> Epoch {
        Epoch::new(self.channel_lease_anchor().0.max(1))
    }

    fn channel_lease_anchor(&self) -> (u64, String) {
        if let Some(runtime) = self.fabric_runtime() {
            let report = runtime.nodes_report();
            let holder = report.router_holder.map(|d| d.to_string());
            return crate::channels::resolve_lease_anchor(
                Some(report.witness_epoch),
                holder.as_deref(),
                &self.runtime_info.device_id.to_string(),
            );
        }
        (0, self.runtime_info.device_id.to_string())
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

    pub(crate) fn handle_delegate_run(
        self: &Arc<Self>,
        req: DelegateRunRequest,
    ) -> Result<DelegateRunResponse> {
        let now_ms = now_unix_ms();
        let bindings = default_authored_bindings();

        // 第一步：组装良知与记忆（注入受管运行的网关会话），并在 Router 权限下校验任何被禁止的工具调用企图
        let (assembled, mut router_denied) = {
            let mut guard = self
                .state
                .lock()
                .map_err(|_| QuetzalcoatlError::StorageError {
                    detail: String::from("quetzalcoatld 状态锁异常"),
                })?;

            let mut asm_req = AssemblyRequest::new(BudgetProfile::Standard, now_ms);
            asm_req.peer_id = req.peer_id.clone();
            asm_req.query = Some(req.task.clone());
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

        // 宿主没有任何可用凭据时，在创建 worktree / 沙箱 / 网关会话之前就拒绝，
        // 绝不把「宿主没登录」伪装成上游 403。
        let upstream_configured = self.config.upstream_bearer_token.is_some();
        if !upstream_configured
            && !host_oauth_available(host_claude.as_deref(), host_codex.as_deref())
        {
            return Err(model_not_configured_error());
        }

        let target_repo = req.workspace_dir.clone();

        // 先强制校验沙箱包装器与 OS 沙箱后端可用性（缺失立即 fail-closed 返回 SandboxViolation！）
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
                format!("worker-code: {}", req.task),
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

        let mut extra_ro_mounts = vec![stub_root.clone(), spec_file_path.clone()];
        let main_git_dir = target_repo.join(".git");
        if main_git_dir.exists() {
            extra_ro_mounts.push(main_git_dir);
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
            mcp_endpoint_url: Some(mcp_server.endpoint_url().to_owned()),
        };

        let worker_outcome_res = if self.config.worker_binary_override.is_some() {
            AcpJsonRpcDriver::new(selected_kind).execute_turn(&launch_ctx, &req.task)
        } else {
            match selected_kind {
                CodingAgentKind::OpenCode => OpenCodeDriver.execute_turn(&launch_ctx, &req.task),
                CodingAgentKind::ClaudeCode => {
                    ClaudeCodeDriver.execute_turn(&launch_ctx, &req.task)
                }
                CodingAgentKind::Codex => CodexDriver.execute_turn(&launch_ctx, &req.task),
                CodingAgentKind::Pi => PiDriver.execute_turn(&launch_ctx, &req.task),
                other => AcpJsonRpcDriver::new(other).execute_turn(&launch_ctx, &req.task),
            }
        };

        // Worker 回合结束立即吊销会话能力令牌与本地 MCP 服务
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

        let (changed_files, approval_id) = if req.hold_for_approval {
            let (id, files) = self.hold_for_approval(run_id, &req.task, wt_lease)?;
            (files, Some(id))
        } else {
            let applied_files = wt_lease.apply_verified_to_repo()?;
            wt_lease.cleanup()?;
            (applied_files, None)
        };

        Ok(DelegateRunResponse {
            final_text: worker_outcome.final_text,
            run_id,
            verifier_runs: completion.verifier_runs,
            verification_mark: completion.verification_mark,
            router_denied_capabilities: router_denied,
            changed_files,
            approval_id,
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
                let (witness_epoch, lease_holder) = self.channel_lease_anchor();
                let Ok(mut guard) = self.state.lock() else {
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
                let _ = guard.channels.reconcile_lease_for_local(
                    witness_epoch,
                    &lease_holder,
                    &self.runtime_info.device_id.to_string(),
                );
                let channel_health = guard.channels.health();
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
                    channels: channel_health,
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
            IpcRequest::DelegateRun(delegate_req) => match self.handle_delegate_run(delegate_req) {
                Ok(resp) => (IpcResponse::DelegateRun(Box::new(resp)), false),
                Err(err) => (
                    IpcResponse::Error {
                        code: String::from(err.code().as_str()),
                        detail: err.detail().map_or_else(|| err.to_string(), str::to_owned),
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
            IpcRequest::HostSessionStart {
                host,
                session_id,
                cwd,
                source: _,
            } => (
                self.handle_host_session_start(&host, &session_id, cwd),
                false,
            ),
            IpcRequest::HostPromptSubmit {
                host,
                session_id,
                cwd,
                prompt,
                transcript_path,
            } => (
                self.handle_host_prompt_submit(&host, &session_id, cwd, &prompt, transcript_path),
                false,
            ),
            IpcRequest::HostTurnEnd {
                host,
                session_id,
                transcript_path,
            } => (
                self.handle_host_turn_end(&host, &session_id, transcript_path),
                false,
            ),
            IpcRequest::ImportNotes { paths } => match self.import_notes(&paths) {
                Ok(report) => (IpcResponse::ImportNotes(report), false),
                Err(err) => ipc_error_response(err),
            },
            IpcRequest::ImportUndo { batch_id } => match self.undo_import(&batch_id) {
                Ok(report) => (IpcResponse::ImportUndo(report), false),
                Err(err) => ipc_error_response(err),
            },
            IpcRequest::Approvals => (IpcResponse::Approvals(self.pending_approvals()), false),
            IpcRequest::ApprovalDecide { id, approve } => {
                match self.decide_approval(&id, approve) {
                    Ok(outcome) => (IpcResponse::ApprovalDecide(outcome), false),
                    Err(err) => ipc_error_response(err),
                }
            }
            IpcRequest::SayItPull => match self.pull_sayit() {
                Ok(report) => (IpcResponse::SayItPull(report), false),
                Err(err) => (
                    IpcResponse::Error {
                        code: String::from(err.code().as_str()),
                        detail: err.detail().map_or_else(|| err.to_string(), str::to_owned),
                    },
                    false,
                ),
            },
            IpcRequest::ExploreNow => match self.explore_if_due(true) {
                Ok(report) => (IpcResponse::Reflection(report), false),
                Err(err) => ipc_error_response(err),
            },
            IpcRequest::ReflectNow => match self.reflect_if_due(true) {
                Ok(report) => (IpcResponse::Reflection(report), false),
                Err(err) => (
                    IpcResponse::Error {
                        code: String::from(err.code().as_str()),
                        detail: err.detail().map_or_else(|| err.to_string(), str::to_owned),
                    },
                    false,
                ),
            },
            IpcRequest::SeaOverview => (self.sea_overview(), false),
            IpcRequest::SeaSelf => (self.sea_self(), false),
            IpcRequest::SeaUser => (self.sea_user(), false),
            IpcRequest::SeaUs => (self.sea_us(), false),
            IpcRequest::SeaMemories {
                query,
                state,
                cursor,
                limit,
            } => (
                self.sea_memories(query.as_deref(), state.as_deref(), cursor.as_deref(), limit),
                false,
            ),
            IpcRequest::SeaMemory { id } => (self.sea_memory(&id), false),
            IpcRequest::SeaBaseline => (self.sea_baseline(), false),
            IpcRequest::SeaHosts => (self.sea_hosts(), false),
            IpcRequest::SeaDevices => (self.sea_devices(), false),
            IpcRequest::SeaAudit { cursor, limit } => {
                (self.sea_audit(cursor.as_deref(), limit), false)
            }
            IpcRequest::SeaEntryUpdate { id, text } => (self.sea_entry_update(&id, &text), false),
            IpcRequest::SeaEntryMute { id, muted } => (self.sea_entry_mute(&id, muted), false),
            IpcRequest::SeaEntryErase { id } => (self.sea_entry_erase(&id), false),
            IpcRequest::SeaBaselineSign {
                directives,
                passphrase,
            } => (self.sea_baseline_sign(&directives, &passphrase), false),
            IpcRequest::SeaFocusSet { self_weight } => (self.sea_focus_set(self_weight), false),
            IpcRequest::SeaRhythmSet {
                speak_first,
                quiet_hours,
            } => (self.sea_rhythm_set(speak_first, quiet_hours), false),
            IpcRequest::SeaDeviceRevoke {
                device_id,
                passphrase,
            } => (self.sea_device_revoke(&device_id, &passphrase), false),
            IpcRequest::HostToolTicket {
                host,
                session_id,
                tool,
                arguments,
            } => (
                self.handle_host_tool_ticket(&host, &session_id, &tool, &arguments),
                false,
            ),
            IpcRequest::HostStatusLine {
                host: _,
                session_id,
            } => (self.handle_host_status_line(session_id.as_deref()), false),
            IpcRequest::HostToolCall { tool, arguments } => {
                if tool == crate::host_sessions::TOOL_DELEGATE {
                    (self.host_tool_delegate(&arguments), false)
                } else {
                    (self.handle_host_tool_call(&tool, &arguments), false)
                }
            }
            IpcRequest::Export {
                zip_path,
                include_sealed_spine,
                passphrase,
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
                match export_sea(
                    &self.config.quetzalcoatl_home,
                    &zip_path,
                    ZipExportOptions {
                        include_spine_packs: include_sealed_spine,
                    },
                    passphrase.as_deref(),
                    (
                        guard.kernel.spine(),
                        &guard.conscience,
                        &guard.graph,
                        &guard.persisted,
                    ),
                ) {
                    Ok(recoverable) => (
                        IpcResponse::Ack {
                            detail: String::from(if recoverable {
                                "recoverable"
                            } else {
                                "readable-only"
                            }),
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
                        let before = guard.conscience.clone();
                        let DaemonMutableState {
                            ref mut conscience,
                            ref mut graph,
                            ref kernel,
                            ..
                        } = *guard;
                        absorb_imported_sea(conscience, graph, kernel.spine(), now_ms);
                        if let Err(err) = guard.commit_sea(
                            before,
                            SEA_ACTOR_IMPORT,
                            self.sea_epoch(),
                            "导入 V1 灵魂",
                            now_ms,
                        ) {
                            return (
                                IpcResponse::Error {
                                    code: String::from(err.code().as_str()),
                                    detail: err.to_string(),
                                },
                                false,
                            );
                        }
                        let DaemonMutableState {
                            ref mut persisted,
                            ref graph,
                            ..
                        } = *guard;
                        let _ =
                            save_graph_snapshot(&self.config.quetzalcoatl_home, persisted, graph);
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
                    Ok(rep) => {
                        let _ = self.register_channel_ingress_key();
                        (IpcResponse::FabricLogin(rep), false)
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
            IpcRequest::FabricPairComplete {
                pairing_id,
                short_code,
            } => {
                let Some(runtime) = self.fabric_runtime() else {
                    return fabric_disabled_response();
                };
                match runtime.pair_complete(
                    &self.config.quetzalcoatl_home,
                    &pairing_id,
                    &short_code,
                ) {
                    Ok(adoption) => (
                        IpcResponse::FabricPairComplete {
                            agent_id: adoption.agent_id,
                            ready: adoption.ready(),
                        },
                        false,
                    ),
                    Err(err) => (
                        IpcResponse::Error {
                            code: String::from(err.code().as_str()),
                            detail: err.detail().map_or_else(|| err.to_string(), str::to_owned),
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
                    Ok(rep) => {
                        let _ = self.register_channel_ingress_key();
                        (IpcResponse::FabricPairApprove(Box::new(rep)), false)
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
                delivered_seq,
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
                    delivered_seq,
                    !peek,
                    kernel.spine_mut().store_mut(),
                ) {
                    Ok(text) => (IpcResponse::GroupPlaintext { text }, false),
                    Err(err) => ipc_error_response(err),
                }
            }
            IpcRequest::GroupHistory {
                room_id,
                after,
                limit,
            } => {
                // 短锁取计划 → 零锁拉取：Hub 网络 I/O 绝不在内核状态锁内。
                let plan = {
                    let Ok(mut guard) = self.state.lock() else {
                        return ipc_lock_error();
                    };
                    match guard.group.history_plan(&room_id) {
                        Ok(plan) => plan,
                        Err(err) => return ipc_error_response(err),
                    }
                };
                let Some(plan) = plan else {
                    return (IpcResponse::GroupHistory(Vec::new()), false);
                };
                match crate::group::GroupRoomRuntime::fetch_history(&plan, after, limit) {
                    Ok(rows) => (IpcResponse::GroupHistory(rows), false),
                    Err(err) => ipc_error_response(err),
                }
            }
            IpcRequest::GroupQuarantine {
                room_id,
                server_seq,
                reason,
            } => {
                let Ok(mut guard) = self.state.lock() else {
                    return ipc_lock_error();
                };
                let DaemonMutableState {
                    ref mut group,
                    ref mut kernel,
                    ..
                } = *guard;
                let outcome = group.quarantine_commit(
                    &room_id,
                    server_seq,
                    &reason,
                    kernel.spine_mut().store_mut(),
                );
                if outcome.is_ok() {
                    // 签名脊柱审计：与私有块同源内容，进入单写者事件链。
                    let payload = serde_json::json!({
                        "kind": "group_quarantine",
                        "room_id": room_id,
                        "server_seq": server_seq,
                        "reason": reason,
                    })
                    .to_string();
                    let _ = kernel.spine_mut().append_event(
                        PackCompartment::Core,
                        &payload,
                        now_unix_ms(),
                    );
                }
                match outcome {
                    Ok(summary) => (IpcResponse::GroupRoom(summary), false),
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
            IpcRequest::VoiceFrame {
                stream_id,
                frame_seq,
                render_b64,
                capture_b64,
                assistant_speaking,
            } => {
                let render = match crate::voice::decode_audio_frame(&render_b64) {
                    Ok(frame) => frame,
                    Err(error) => return ipc_error_response(error),
                };
                let capture = match crate::voice::decode_audio_frame(&capture_b64) {
                    Ok(frame) => frame,
                    Err(error) => return ipc_error_response(error),
                };
                let Ok(mut guard) = self.state.lock() else {
                    return ipc_lock_error();
                };
                let DaemonMutableState {
                    ref mut voice,
                    ref mut kernel,
                    ..
                } = *guard;
                let Some(sessions) = voice.as_mut() else {
                    return (
                        IpcResponse::Error {
                            code: String::from("VOICE_AI_DISABLED"),
                            detail: String::from(
                                "声学语音门未启用：设置 QUETZALCOATL_VOICE_AI=1 后重启 quetzalcoatld",
                            ),
                        },
                        false,
                    );
                };
                let outcome = sessions.ingest_and_publish(
                    &stream_id,
                    frame_seq,
                    &render,
                    &capture,
                    assistant_speaking,
                    |payload| {
                        // 与群组审计/良知事件同源：语音起止与打断进入签名脊柱活动链；
                        // 脊柱写入失败必须上抛，绝不静默丢弃活动事件。
                        kernel
                            .spine_mut()
                            .append_event(PackCompartment::Core, payload, now_unix_ms())
                            .map(|_| ())
                    },
                );
                match outcome {
                    Ok(report) => (
                        IpcResponse::VoiceActivity {
                            stream_id,
                            frame_index: report.frame_index,
                            frame_seq,
                            speech: report.speech,
                            vad_probability: report.vad_probability,
                            barge_in: report.barge_in,
                            interrupting_frame_offset_ms: report.interrupting_frame_offset_ms,
                        },
                        false,
                    ),
                    Err(crate::voice::VoiceStreamError::NonContiguousFrameSeq {
                        expected,
                        actual,
                    }) => (
                        IpcResponse::Error {
                            code: String::from("VOICE_STREAM_SEQUENCE"),
                            detail: format!("语音流帧序号不连续：期望 {expected} 实际 {actual}"),
                        },
                        false,
                    ),
                    Err(crate::voice::VoiceStreamError::InvalidStreamId { detail }) => (
                        IpcResponse::Error {
                            code: String::from("VOICE_STREAM_ID"),
                            detail,
                        },
                        false,
                    ),
                    Err(crate::voice::VoiceStreamError::Frame(error))
                    | Err(crate::voice::VoiceStreamError::Spine(error)) => {
                        ipc_error_response(error)
                    }
                }
            }
            IpcRequest::ChannelList => {
                let (witness_epoch, lease_holder) = self.channel_lease_anchor();
                let Ok(mut guard) = self.state.lock() else {
                    return ipc_error_response(QuetzalcoatlError::StorageError {
                        detail: String::from("daemon lock poisoned"),
                    });
                };
                let _ = guard.channels.reconcile_lease_for_local(
                    witness_epoch,
                    &lease_holder,
                    &self.runtime_info.device_id.to_string(),
                );
                (IpcResponse::Channels(guard.channels.health()), false)
            }
            IpcRequest::ChannelEnable { channel } => {
                let Ok(mut guard) = self.state.lock() else {
                    return ipc_error_response(QuetzalcoatlError::StorageError {
                        detail: String::from("daemon lock poisoned"),
                    });
                };
                match guard.channels.enable(&channel) {
                    Ok(health) => (IpcResponse::ChannelUpdate(health), false),
                    Err(err) => ipc_error_response(err),
                }
            }
            IpcRequest::ChannelDisable { channel } => {
                let Ok(mut guard) = self.state.lock() else {
                    return ipc_error_response(QuetzalcoatlError::StorageError {
                        detail: String::from("daemon lock poisoned"),
                    });
                };
                match guard.channels.disable(&channel) {
                    Ok(health) => (IpcResponse::ChannelUpdate(health), false),
                    Err(err) => ipc_error_response(err),
                }
            }
            IpcRequest::ChannelDeliver {
                channel,
                destination,
                text,
            } => {
                let now_ms = now_unix_ms();
                let (witness_epoch, lease_holder) = self.channel_lease_anchor();
                let Ok(mut guard) = self.state.lock() else {
                    return ipc_error_response(QuetzalcoatlError::StorageError {
                        detail: String::from("daemon lock poisoned"),
                    });
                };
                if !guard.channels.is_enabled(&channel) {
                    return ipc_error_response(QuetzalcoatlError::invalid_id(
                        "ChannelId",
                        format!("通道 {channel} 未启用"),
                    ));
                }
                if matches!(guard.kernel.lease_posture(), LeasePosture::PartitionLocal) {
                    // 两态围栏：非幂等公网外发只入 Outbox，绝不在无见证纪元下发出。
                    let idempotency_key = format!("channel-send:{}", Uuid::new_v4());
                    let mut invocation = CapabilityInvocation::new(
                        "external.send",
                        serde_json::json!({
                            "channel": channel,
                            "destination": destination,
                            "text": text,
                            "idempotency_key": idempotency_key,
                        })
                        .to_string(),
                    );
                    invocation.idempotency_key = Some(idempotency_key);
                    let _ = guard.kernel.authorize_capability(
                        PrincipalRole::Worker,
                        None,
                        CapabilitySet::All,
                        ScopeChain::unrestricted(),
                        default_authored_bindings(),
                        &invocation,
                        now_ms,
                    );
                    if !lease_holder.trim().is_empty()
                        && lease_holder != self.runtime_info.device_id.to_string()
                    {
                        return ipc_error_response(QuetzalcoatlError::PermissionDenied {
                            detail: format!(
                                "通道 {channel} 外发已暂存 Outbox，但当前 Router holder 为 {lease_holder}，本机无有状态通道发送权"
                            ),
                        });
                    }
                    return ipc_error_response(QuetzalcoatlError::PartitionRestricted {
                        detail: format!(
                            "通道 {channel} 外发已暂存 Outbox：当前处于断网分区本地租约，重获 witness_epoch 后将自动对账投递"
                        ),
                    });
                }
                let _ = guard.channels.reconcile_lease_for_local(
                    witness_epoch,
                    &lease_holder,
                    &self.runtime_info.device_id.to_string(),
                );
                if let Err(err) = guard.channels.authorize_send(&channel) {
                    return ipc_error_response(err);
                }
                let destination = destination.unwrap_or_default();
                match guard.channels.deliver(&channel, &destination, &text) {
                    Ok(report) => (IpcResponse::ChannelDelivery(report), false),
                    Err(err) => ipc_error_response(err),
                }
            }
            IpcRequest::SayItIngest { path, batch_dir } => {
                let now_ms = now_unix_ms();
                let Ok(mut guard) = self.state.lock() else {
                    return ipc_error_response(QuetzalcoatlError::StorageError {
                        detail: String::from("daemon lock poisoned"),
                    });
                };
                let target = SayItTarget {
                    agent_id: guard.kernel.spine().agent_id(),
                    scope: SovereignScope::PersonalSovereign,
                };
                if let Some(root) = batch_dir {
                    match ingest_batch_into_graph(&mut guard.graph, &target, &root, now_ms, true) {
                        Ok(outcomes) => (IpcResponse::SayItIngest(outcomes), false),
                        Err(err) => ipc_error_response(err),
                    }
                } else if let Some(snapshot) = path {
                    match ingest_file_into_graph(&mut guard.graph, &target, &snapshot, now_ms, true)
                    {
                        Ok(receipt) => (
                            IpcResponse::SayItIngest(vec![SayItBatchOutcome {
                                path: snapshot,
                                receipt: Some(receipt),
                                error_code: None,
                                error_detail: None,
                            }]),
                            false,
                        ),
                        Err(err) => ipc_error_response(err),
                    }
                } else {
                    ipc_error_response(QuetzalcoatlError::invalid_id(
                        "SayItPath",
                        String::from("必须提供 --path <snapshot> 或 --batch <dir>"),
                    ))
                }
            }
            IpcRequest::WebhookPull { after, limit } => {
                let Some(runtime) = self.fabric_runtime() else {
                    return ipc_error_response(QuetzalcoatlError::PermissionDenied {
                        detail: String::from("fabric 未启用，无法连接 Hub 拉取 Webhook"),
                    });
                };
                let agent_id = self.runtime_info.agent_id;
                let ingress_key = match self.register_channel_ingress_key() {
                    Ok(key) => key,
                    Err(err) => return ipc_error_response(err),
                };
                let batch = match runtime.pull_webhook_ingress(agent_id, after, limit.clamp(1, 500))
                {
                    Ok(batch) => batch,
                    Err(err) => return ipc_error_response(err),
                };
                let (ack_keys, mut report) = {
                    let Ok(mut guard) = self.state.lock() else {
                        return ipc_error_response(QuetzalcoatlError::StorageError {
                            detail: String::from("daemon lock poisoned"),
                        });
                    };
                    let DaemonMutableState {
                        ref mut kernel,
                        ref channels,
                        ..
                    } = *guard;
                    crate::webhook::decrypt_and_persist(
                        kernel.spine_mut(),
                        &ingress_key,
                        channels,
                        &self.config.quetzalcoatl_home,
                        &batch.events,
                        now_unix_ms(),
                    )
                };
                let acked = match runtime.ack_webhook_ingress(agent_id, &ack_keys) {
                    Ok(deleted) => deleted,
                    Err(err) => return ipc_error_response(err),
                };
                report.acked = acked;
                // 游标只跨越连续 acked/dead-lettered 行；头部失败行必须保留在队首以便重试。
                report.next_cursor = contiguous_ack_cursor(after, &batch.events, &ack_keys);
                report.queue_depth = batch.queue_depth.saturating_sub(acked);
                (IpcResponse::WebhookPull(report), false)
            }
            IpcRequest::WebhookRegisterKey { rotate } => {
                let Some(runtime) = self.fabric_runtime() else {
                    return ipc_error_response(QuetzalcoatlError::PermissionDenied {
                        detail: String::from("fabric 未启用，无法登记 Webhook 入站公钥"),
                    });
                };
                let device_id = {
                    let Ok(guard) = self.state.lock() else {
                        return ipc_error_response(QuetzalcoatlError::StorageError {
                            detail: String::from("daemon lock poisoned"),
                        });
                    };
                    guard.kernel.spine().local_device().device_id()
                };
                let key = if rotate {
                    match crate::ingress_key::ChannelIngressKey::rotate(
                        &self.config.quetzalcoatl_home,
                        device_id,
                    ) {
                        Ok(key) => key,
                        Err(err) => return ipc_error_response(err),
                    }
                } else {
                    match self.register_channel_ingress_key() {
                        Ok(key) => key,
                        Err(err) => return ipc_error_response(err),
                    }
                };
                if let Err(err) = runtime.register_channel_ingress_key(
                    self.runtime_info.agent_id,
                    key.public_key(),
                    key.key_id(),
                    &key.device_id().to_string(),
                ) {
                    return ipc_error_response(err);
                }
                match runtime.webhook_ingress_status(self.runtime_info.agent_id) {
                    Ok(status) => (IpcResponse::WebhookQueueStatus(status), false),
                    Err(err) => ipc_error_response(err),
                }
            }
            IpcRequest::WebhookStatus => {
                let Some(runtime) = self.fabric_runtime() else {
                    return ipc_error_response(QuetzalcoatlError::PermissionDenied {
                        detail: String::from("fabric 未启用，无法查询 Hub Webhook 状态"),
                    });
                };
                match runtime.webhook_ingress_status(self.runtime_info.agent_id) {
                    Ok(status) => (IpcResponse::WebhookQueueStatus(status), false),
                    Err(err) => ipc_error_response(err),
                }
            }
            IpcRequest::DomainList => {
                let Ok(guard) = self.state.lock() else {
                    return ipc_lock_error();
                };
                (
                    IpcResponse::DomainPacks {
                        packs: guard.domains.list(),
                        repair_report: guard.domains.repair_report().map(String::from),
                    },
                    false,
                )
            }
            IpcRequest::DomainShow { id } => {
                let Ok(guard) = self.state.lock() else {
                    return ipc_lock_error();
                };
                match guard.domains.show(&id) {
                    Ok(view) => (IpcResponse::DomainPack(Box::new(view)), false),
                    Err(err) => ipc_error_response(err),
                }
            }
            IpcRequest::DomainUse { id } => {
                let Ok(mut guard) = self.state.lock() else {
                    return ipc_lock_error();
                };
                let DaemonMutableState {
                    ref mut domains,
                    ref mut kernel,
                    ..
                } = *guard;
                match domains.use_pack(&id, now_unix_ms(), "qz domain use", kernel.spine_mut()) {
                    Ok(outcome) => (IpcResponse::DomainActivated(Box::new(outcome)), false),
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
                        ref graph,
                        ..
                    } = *guard;
                    let _ = save_graph_snapshot(&self.config.quetzalcoatl_home, persisted, graph);
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

/// 把物化视图里的一条记忆收进良知与记忆图（已存在则跳过）。
///
/// 类别决定落在哪一层：关于用户的进「关于我」，其余是普通记忆；导入物一律不进核心层与底线。
/// 记忆图节点直接用记忆编号，召回结果才能回指到条目。
fn absorb_materialized_memory(
    conscience: &mut Conscience,
    graph: &mut SerpentineGraph,
    mm: quetzalcoatl_spine::MaterializedMemory,
    now_ms: u64,
) {
    if conscience.memories.iter().any(|m| m.id == mm.memory_id) {
        return;
    }
    let about_user = mm.category == "user_pref";
    conscience.memories.push(MemoryEntry {
        id: mm.memory_id.clone(),
        kind: MemoryKind::Fact,
        topic: Some(mm.category),
        content: mm.content.clone(),
        about: if about_user {
            vec![String::from("user")]
        } else {
            Vec::new()
        },
        salience: 0.75,
        evidence_count: 1,
        constant: false,
        untrusted: false,
        muted: false,
        pressure_flags: Vec::new(),
        authority: if about_user {
            Authority::UserPref
        } else {
            Authority::Memory
        },
        mutability: if about_user {
            Mutability::user_pref_default()
        } else {
            Mutability::memory_free()
        },
        valid_from_ms: now_ms,
        invalid_at_ms: None,
        triggers: Vec::new(),
        provenance: ProvenanceRecord {
            written_by: String::from("import-v1"),
            at_ms: now_ms,
            source_event_ids: vec![mm.memory_id.clone()],
            model: None,
            supersedes: None,
        },
    });
    let _ = graph.observe(
        serde_json::json!({"origin": "import-v1", "memory_id": mm.memory_id}),
        ObserveOptions {
            id: Some(mm.memory_id),
            text: Some(mm.content),
            ..Default::default()
        },
    );
}

/// V1 灵魂里的自述与名字进身份块（性情层，不进核心）。已经有同编号的身份块时不覆盖。
fn absorb_v1_identity(
    conscience: &mut Conscience,
    spine: &SpineEngine<RusqliteWalStore>,
    now_ms: u64,
) {
    let provenance = ProvenanceRecord {
        written_by: String::from("import-v1"),
        at_ms: now_ms,
        source_event_ids: Vec::new(),
        model: None,
        supersedes: None,
    };
    let has_block =
        |conscience: &Conscience, id: &str| conscience.identity.iter().any(|b| b.id == id);

    if !has_block(conscience, IDENTITY_SOUL_ID)
        && let Ok(docs) = spine.store().list_markdown_docs()
        && let Some((_, soul)) = docs.into_iter().find(|(path, _)| path == "SOUL.md")
        && !soul.starts_with(GENESIS_SOUL_HEADING)
        && !soul.trim().is_empty()
    {
        conscience.identity.push(IdentityBlock {
            id: String::from(IDENTITY_SOUL_ID),
            label: String::from("自述"),
            description: String::from("从 V1 灵魂带来的自述"),
            value: soul.trim().to_owned(),
            char_limit: 1_500,
            authority: Authority::SelfSoft,
            mutability: Mutability::self_soft_default(),
            pinned: true,
            provenance: provenance.clone(),
        });
    }

    if !has_block(conscience, crate::host_sessions::AGENT_NAME_IDENTITY_ID)
        && let Ok(events) = spine.store().list_all_events()
    {
        let name = events.iter().find_map(|(event, _)| {
            let payload: serde_json::Value = serde_json::from_str(&event.payload_utf8).ok()?;
            if payload.get("kind")?.as_str()? != "v1.agent_profile" {
                return None;
            }
            let profile = payload.get("profile")?;
            ["displayName", "name"].iter().find_map(|key| {
                profile
                    .get(*key)
                    .and_then(serde_json::Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_owned)
            })
        });
        if let Some(name) = name {
            conscience.identity.push(IdentityBlock {
                id: String::from(crate::host_sessions::AGENT_NAME_IDENTITY_ID),
                label: String::from("名字"),
                description: String::from("从 V1 灵魂带来的名字"),
                value: name,
                char_limit: 64,
                authority: Authority::SelfSoft,
                mutability: Mutability::self_soft_default(),
                pinned: true,
                provenance,
            });
        }
    }
}

/// 导入之后把物化视图里的新内容收进良知：记忆、自述与名字。
fn absorb_imported_sea(
    conscience: &mut Conscience,
    graph: &mut SerpentineGraph,
    spine: &SpineEngine<RusqliteWalStore>,
    now_ms: u64,
) {
    if let Ok(memories) = spine.store().list_memories() {
        for mm in memories {
            absorb_materialized_memory(conscience, graph, mm, now_ms);
        }
    }
    absorb_v1_identity(conscience, spine, now_ms);
}

pub struct DaemonHandle {
    qz_home: PathBuf,
    pub(crate) runtime_info: DaemonRuntimeInfo,
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
            stop,
            Arc::new(DeferredHandler {
                slot: Arc::clone(&core_holder),
            }),
            config.web_dir.clone(),
        )?;

        let runtime_info = DaemonRuntimeInfo {
            ipc_http_addr: ipc_handle.http_addr,
            unix_socket_path: ipc_handle.unix_socket_path.clone(),
            ..placeholder_info
        };

        let qz_home = config.quetzalcoatl_home.clone();
        let voice_runtime = crate::voice::VoiceActivitySessions::from_config(config.voice_ai)?;
        let channel_runtime = crate::channels::ChannelRuntime::load(&config.quetzalcoatl_home)?;
        let domain_runtime =
            crate::domains::DomainRuntime::load_or_init(&qz_home, agent_id, kernel.spine_mut())?;
        if let Some(report) = domain_runtime.repair_report() {
            eprintln!("quetzalcoatld: 领域包审计已按脊柱签名事件重建: {report}");
        }
        let shared_core = Arc::new(SharedDaemonCore {
            config,
            runtime_info: runtime_info.clone(),
            worker_sandbox,
            harness_host,
            gateway_base_url,
            state: Mutex::new(DaemonMutableState {
                _spine_lock: spine_lock,
                kernel,
                conscience,
                graph,
                arbiter,
                persisted,
                group: group_runtime,
                voice: voice_runtime,
                channels: channel_runtime,
                domains: domain_runtime,
            }),
            host_sessions: crate::host_sessions::HostSessionRegistry::default(),
            approvals: crate::approvals::ApprovalQueue::default(),
            fabric: Mutex::new(fabric_runtime.clone()),
        });

        if let Ok(mut guard) = core_holder.lock() {
            *guard = Some(Arc::clone(&shared_core));
        }
        // 他闲下来时的回想：定时看一眼，用户不在场、离上次够久、有新的相处时才进行。
        // 设 QUETZALCOATL_REFLECT=0 关闭。
        if std::env::var("QUETZALCOATL_REFLECT").map_or(true, |v| v.trim() != "0") {
            let weak = Arc::downgrade(&shared_core);
            let tick = Duration::from_millis(
                std::env::var("QUETZALCOATL_REFLECT_TICK_MS")
                    .ok()
                    .and_then(|v| v.trim().parse().ok())
                    .unwrap_or(10 * 60 * 1_000),
            );
            let _ = std::thread::Builder::new()
                .name(String::from("quetzalcoatl-reflection"))
                .spawn(move || {
                    loop {
                        std::thread::sleep(tick);
                        let Some(core) = weak.upgrade() else {
                            break;
                        };
                        let _ = core.reflect_if_due(false);
                        let _ = core.explore_if_due(false);
                    }
                });
        }
        // SayIt 自动流入：接上了就每隔五分钟拉一次。
        {
            let weak = Arc::downgrade(&shared_core);
            let _ = std::thread::Builder::new()
                .name(String::from("quetzalcoatl-sayit"))
                .spawn(move || {
                    loop {
                        std::thread::sleep(Duration::from_secs(300));
                        let Some(core) = weak.upgrade() else {
                            break;
                        };
                        let _ = core.pull_sayit();
                    }
                });
        }
        // 已持久化 Hub 会话时，守护进程启动即自动登记本设备独立入站公钥。
        let _ = shared_core.register_channel_ingress_key();
        // 挂上弱引用并启动心跳线程（仅当 fabric 已启用时需要）。
        // 注意：必须先释放 core_slot 锁再调用 tick_now，否则会与 `core()` 的同一把锁自锁。
        if let (Some(runtime), Some(slot)) = (&fabric_runtime, &fabric_core_slot) {
            if let Ok(mut guard) = slot.lock() {
                *guard = Some(Arc::downgrade(&shared_core));
            }
            runtime.start_ticker();
            // 重启续用既有会话时立即抢占一次 witness_epoch，避免状态短暂停留在 Standby。
            runtime.tick_and_record();
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
///
/// 给了口令时导出包里带上恢复包，第二个返回值说明这份导出能不能用来恢复。
pub fn export_offline_or_via_ipc(
    qz_home: &Path,
    zip_path: &Path,
    options: ZipExportOptions,
    passphrase: Option<&str>,
) -> Result<(bool, bool)> {
    if let Some(client) = IpcClient::connect_from_home(qz_home)? {
        match client.call(&IpcRequest::Export {
            zip_path: zip_path.to_path_buf(),
            include_sealed_spine: options.include_spine_packs,
            passphrase: passphrase.map(String::from),
        })? {
            IpcResponse::Ack { detail } => return Ok((true, detail == "recoverable")),
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
    let (spine, conscience, graph, persisted) = load_or_init_sovereign_bundle(qz_home)?;
    let recoverable = export_sea(
        qz_home,
        zip_path,
        options,
        passphrase,
        (&spine, &conscience, &graph, &persisted),
    )?;
    Ok((false, recoverable))
}

/// 把一份导出恢复进一个空的家目录（守护进程不能在运行）。
pub fn restore_offline(
    qz_home: &Path,
    zip_path: &Path,
    passphrase: &str,
) -> Result<crate::sea_archive::RestoreReport> {
    if IpcClient::connect_from_home(qz_home)?.is_some() {
        return Err(QuetzalcoatlError::PermissionDenied {
            detail: String::from(
                "守护进程正在运行。恢复只放进一个空目录：先 qz down，或者用 --home 指向一个新目录。",
            ),
        });
    }
    let _lock = ExclusiveSpineLock::acquire(qz_home)?;
    crate::sea_archive::restore_from_archive(qz_home, zip_path, passphrase)
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
    let before = conscience.clone();
    absorb_imported_sea(&mut conscience, &mut graph, &spine, now_ms);
    journal::commit(
        &mut spine,
        Some(&before),
        &conscience,
        SEA_ACTOR_IMPORT,
        1,
        "导入 V1 灵魂",
        now_ms,
    )?;
    save_graph_snapshot(qz_home, &mut persisted, &graph)?;
    Ok((report, false))
}

#[allow(dead_code)]
fn _discovery_reexport_guard() {
    let _ = discover_coding_agents;
}

/// 游标只能跨越连续已确认/已死信的信封；头部失败行必须留在下一轮队首。
fn contiguous_ack_cursor(
    after: i64,
    events: &[quetzalcoatl_fabric::WebhookIngressEnvelope],
    ack_keys: &[quetzalcoatl_fabric::WebhookIngressAckKey],
) -> i64 {
    let mut cursor = after;
    for event in events {
        let acked = ack_keys
            .iter()
            .any(|key| key.channel == event.channel && key.event_id == event.event_id);
        if !acked {
            break;
        }
        cursor = event.cursor;
    }
    cursor
}

#[cfg(test)]
#[allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]
mod webhook_cursor_tests {
    use super::contiguous_ack_cursor;
    use quetzalcoatl_fabric::{WebhookIngressAckKey, WebhookIngressEnvelope};

    fn env(id: &str, cursor: i64) -> WebhookIngressEnvelope {
        WebhookIngressEnvelope {
            event_id: String::from(id),
            cursor,
            target_device_id: String::new(),
            channel: String::from("webhook"),
            received_at_ms: cursor,
            enc_hex: String::new(),
            ciphertext_hex: String::new(),
            aad_json: String::new(),
        }
    }

    #[test]
    fn cursor_does_not_skip_unacked_head() {
        let events = vec![env("a", 1), env("b", 2), env("c", 3)];
        let acks = vec![
            WebhookIngressAckKey {
                channel: String::from("webhook"),
                event_id: String::from("a"),
            },
            WebhookIngressAckKey {
                channel: String::from("webhook"),
                event_id: String::from("c"),
            },
        ];
        assert_eq!(contiguous_ack_cursor(0, &events, &acks), 1);
    }

    #[test]
    fn cursor_advances_over_contiguous_acked_rows() {
        let events = vec![env("a", 5), env("b", 6)];
        let acks = vec![
            WebhookIngressAckKey {
                channel: String::from("webhook"),
                event_id: String::from("a"),
            },
            WebhookIngressAckKey {
                channel: String::from("webhook"),
                event_id: String::from("b"),
            },
        ];
        assert_eq!(contiguous_ack_cursor(4, &events, &acks), 6);
    }
}
