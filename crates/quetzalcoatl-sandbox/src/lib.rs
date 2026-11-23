#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]

//! `quetzalcoatl-sandbox` — 桌面无容器 OS 沙箱、一次性执行票据、洁净室只读 `Verifier` 环境与零凭据代理。

pub mod broker;
pub mod linux;
pub mod macos;
pub mod windows;

pub use broker::{
    BrokerEndpoint, BrokerProxyRequest, BrokerProxyResponse, BrokerServerHandle, CredentialBroker,
    OriginPathRule, ScopedSecretGrant, ScopedSecretRegistration, SecretInjection, StdHttpTransport,
    UpstreamRequest, UpstreamResponse, UpstreamTransport, encode_base64_standard,
    encode_base64_urlsafe_unpadded,
};
pub use windows::{
    WindowsAccessDisposition, WindowsAclEntry, WindowsSandboxPlan, WindowsSandboxTier,
};

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::hint::black_box;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use quetzalcoatl_crypto::{hex_decode_fixed, hex_encode};
use quetzalcoatl_types::{QuetzalcoatlError, Result, RunId};
use rand_core::{OsRng, RngCore};
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use zeroize::Zeroizing;

/// 即使工作区本身以可写模式挂载，也必须强制只读锁定（并拒绝符号链接逃逸）的敏感配置/钩子子路径。
pub const PROTECTED_WORKSPACE_SUBPATHS: &[&str] = &[".git/hooks", ".opencode", ".claude", ".codex"];

const TICKET_MAC_DOMAIN: &[u8] = b"quetzalcoatl/v2/sandbox-ticket-v1\0";
const MAX_TRACKED_TICKETS: usize = 4096;

/// 常量时间 32 字节比较（防止能力令牌与执行票据 MAC 时序侧信道）。
#[must_use]
pub(crate) fn constant_time_eq_32(a: &[u8; 32], b: &[u8; 32]) -> bool {
    let mut acc = 0u8;
    for idx in 0..32 {
        acc |= black_box(a[idx]) ^ black_box(b[idx]);
    }
    black_box(acc) == 0
}

/// 桌面无容器沙箱后端枚举。
#[derive(Copy, Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SandboxBackendKind {
    LinuxBubblewrap,
    MacOsSeatbelt,
    WindowsMxcAppContainer,
    WindowsSrtRestrictedToken,
    Unavailable,
}

/// 宿主沙箱真实可用性探测报告。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SandboxProbeReport {
    pub backend: SandboxBackendKind,
    pub available: bool,
    pub binary_path: Option<PathBuf>,
    pub supports_network_isolation: bool,
    pub supports_readonly_bind: bool,
    pub supports_seccomp_clone3_enosys: bool,
    pub apparmor_userns_restricted: bool,
    pub detail: String,
}

/// 沙箱挂载可写等级。
#[derive(Copy, Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SandboxMode {
    /// 普通任务工作区可写（但 `.git/hooks`、`.opencode`、`.claude`、`.codex` 强制只读，宿主密钥遮蔽）。
    WorkspaceWritable,
    /// 洁净室只读校验模式（候选工作区与校验套件全部只读，仅临时 `/tmp` 可写）。
    CleanRoomReadOnly,
}

/// 沙箱网络策略。
#[derive(Copy, Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NetworkPolicy {
    /// 允许经宿主网络命名空间连接回环网关/代理。
    AllowHostNetwork,
    /// 彻底断网隔离（Linux `--unshare-net`、macOS `(deny network*)`、Windows 零网络能力 SID）。
    Isolated,
}

/// `SandboxManager` 全局配置。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SandboxConfig {
    pub quetzalcoatl_home: PathBuf,
    pub user_home: Option<PathBuf>,
    pub extra_masked_paths: Vec<PathBuf>,
    pub default_ticket_ttl_ms: u64,
}

impl SandboxConfig {
    #[must_use]
    pub fn new(quetzalcoatl_home: impl Into<PathBuf>) -> Self {
        Self {
            quetzalcoatl_home: quetzalcoatl_home.into(),
            user_home: std::env::var_os("HOME")
                .or_else(|| std::env::var_os("USERPROFILE"))
                .map(PathBuf::from),
            extra_masked_paths: Vec::new(),
            default_ticket_ttl_ms: 60_000,
        }
    }

    #[must_use]
    pub fn from_env() -> Self {
        let home = std::env::var_os("QUETZALCOATL_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(default_quetzalcoatl_home);
        Self::new(home)
    }
}

/// 解析平台默认 `QUETZALCOATL_HOME`（POSIX `~/.quetzalcoatl`，Windows `%LOCALAPPDATA%\Quetzalcoatl`）。
#[must_use]
pub fn default_quetzalcoatl_home() -> PathBuf {
    if cfg!(windows)
        && let Some(local_app_data) = std::env::var_os("LOCALAPPDATA")
    {
        return PathBuf::from(local_app_data).join("Quetzalcoatl");
    }
    if let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) {
        return PathBuf::from(home).join(".quetzalcoatl");
    }
    PathBuf::from(".quetzalcoatl")
}

/// 申请签发一次性执行票据的请求。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TicketRequest {
    pub run_id: RunId,
    pub workspace_dir: PathBuf,
    pub mode: SandboxMode,
    pub network_policy: NetworkPolicy,
    pub ttl_ms: Option<u64>,
    pub now_wall_ms: u64,
}

/// 经密码学认证、绑定有效期且严格一次性消费的沙箱执行票据。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExecutionTicket {
    pub ticket_id: Uuid,
    pub run_id: RunId,
    pub workspace_dir: PathBuf,
    pub mode: SandboxMode,
    pub network_policy: NetworkPolicy,
    pub issued_at_ms: u64,
    pub expires_at_ms: u64,
    pub mac_tag_hex: String,
}

/// 在沙箱中运行的目标进程描述。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SandboxCommand {
    pub program: String,
    pub args: Vec<String>,
    pub current_dir: Option<PathBuf>,
    pub extra_env: BTreeMap<String, String>,
    pub allowlisted_host_env: Vec<String>,
    pub broker_unix_socket: Option<PathBuf>,
    pub extra_ro_mounts: Vec<PathBuf>,
}

impl SandboxCommand {
    #[must_use]
    pub fn new(program: impl Into<String>, args: Vec<String>) -> Self {
        Self {
            program: program.into(),
            args,
            current_dir: None,
            extra_env: BTreeMap::new(),
            allowlisted_host_env: Vec::new(),
            broker_unix_socket: None,
            extra_ro_mounts: Vec::new(),
        }
    }

    #[must_use]
    pub fn shell(script: impl Into<String>) -> Self {
        if cfg!(windows) {
            Self::new(
                "cmd.exe",
                vec![
                    String::from("/d"),
                    String::from("/s"),
                    String::from("/c"),
                    script.into(),
                ],
            )
        } else {
            Self::new("/bin/sh", vec![String::from("-c"), script.into()])
        }
    }
}

/// 断网只读洁净室 `Verifier` 执行规格（供 `quetzalcoatl-kernel` 汇点验收消费，防坑规范 #8）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CleanRoomSpec {
    pub run_id: RunId,
    pub candidate_workspace: PathBuf,
    pub verifier_suite_dir: PathBuf,
    pub command: SandboxCommand,
}

/// 沙箱子进程执行结果。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SandboxExecutionOutput {
    pub exit_code: i32,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

impl SandboxExecutionOutput {
    #[must_use]
    pub const fn success(&self) -> bool {
        self.exit_code == 0
    }

    #[must_use]
    pub fn stdout_lossy(&self) -> String {
        String::from_utf8_lossy(&self.stdout).into_owned()
    }

    #[must_use]
    pub fn stderr_lossy(&self) -> String {
        String::from_utf8_lossy(&self.stderr).into_owned()
    }
}

/// 供 `quetzalcoatl-sandbox-exec` 序列化传递的完整沙箱执行规格。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SandboxExecSpec {
    pub quetzalcoatl_home: PathBuf,
    pub user_home: Option<PathBuf>,
    pub workspace_dir: PathBuf,
    pub mode: SandboxMode,
    pub network_policy: NetworkPolicy,
    pub verifier_suite_dir: Option<PathBuf>,
    pub broker_unix_socket: Option<PathBuf>,
    pub extra_masked_paths: Vec<PathBuf>,
    pub extra_ro_mounts: Vec<PathBuf>,
    pub extra_env: BTreeMap<String, String>,
    pub allowlisted_host_env: Vec<String>,
}

/// 收集所有必须在沙箱内遮蔽的宿主私密目录与长期凭据路径（防坑规范 #1）。
#[must_use]
pub(crate) fn collect_all_masked_paths(spec: &SandboxExecSpec) -> Vec<PathBuf> {
    let mut set = BTreeSet::<PathBuf>::new();
    if !spec.quetzalcoatl_home.as_os_str().is_empty() {
        set.insert(spec.quetzalcoatl_home.clone());
        set.insert(spec.quetzalcoatl_home.join("secrets"));
        set.insert(spec.quetzalcoatl_home.join("spine"));
    }

    let user_home = spec.user_home.clone().or_else(|| {
        std::env::var_os("HOME")
            .or_else(|| std::env::var_os("USERPROFILE"))
            .map(PathBuf::from)
    });
    if let Some(home) = user_home
        && !home.as_os_str().is_empty()
    {
        for dot_rel in [
            ".quetzalcoatl",
            ".ssh",
            ".gnupg",
            ".aws",
            ".kube",
            ".config/gcloud",
            ".claude",
            ".codex",
        ] {
            set.insert(home.join(dot_rel));
        }
    }

    for extra in &spec.extra_masked_paths {
        if !extra.as_os_str().is_empty() {
            set.insert(extra.clone());
        }
    }

    // 若宿主敏感目录本身为符号链接，同时将其规范化后的真实目标路径纳入遮蔽集合，杜绝绕过符号链接直读目标目录
    let snapshot: Vec<PathBuf> = set.iter().cloned().collect();
    for item in snapshot {
        if let Ok(canon) = fs::canonicalize(&item) {
            set.insert(canon);
        }
    }

    set.into_iter().collect()
}

/// 折叠子目录：若父目录已在遮蔽集合中，则无需在已只读遮蔽的父挂载点下重复创建子挂载点。
#[must_use]
pub(crate) fn collect_collapsed_masked_paths(spec: &SandboxExecSpec) -> Vec<PathBuf> {
    let mut all = collect_all_masked_paths(spec);
    all.sort_by(|a, b| {
        a.components()
            .count()
            .cmp(&b.components().count())
            .then_with(|| a.cmp(b))
    });
    let mut collapsed = Vec::<PathBuf>::with_capacity(all.len());
    for candidate in all {
        let covered = collapsed
            .iter()
            .any(|ancestor| candidate != *ancestor && candidate.starts_with(ancestor));
        if !covered {
            collapsed.push(candidate);
        }
    }
    collapsed
}

/// 构造净化后的沙箱子进程环境变量表：默认剥离所有宿主敏感密钥变量（仅保留安全系统基础项与显式白名单）。
#[must_use]
pub(crate) fn build_sanitized_env(
    spec: &SandboxExecSpec,
    command: &SandboxCommand,
) -> BTreeMap<String, String> {
    let mut env_map = BTreeMap::<String, String>::new();

    let default_path = if cfg!(windows) {
        String::from(r"C:\Windows\System32;C:\Windows")
    } else {
        String::from("/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin")
    };
    let host_path = std::env::var("PATH").unwrap_or(default_path);
    env_map.insert(String::from("PATH"), host_path);
    env_map.insert(String::from("LANG"), String::from("C.UTF-8"));
    env_map.insert(String::from("QUETZALCOATL_SANDBOX"), String::from("1"));
    // 防坑规范 #4 & #12：默认禁用项目内配置劫持与 ONNX POSIX 遥测
    env_map.insert(
        String::from("OPENCODE_CONFIG_PROJECT_DISABLE"),
        String::from("1"),
    );
    env_map.insert(String::from("ORT_DISABLE_TELEMETRY"), String::from("1"));

    if !cfg!(windows) {
        env_map.insert(String::from("TMPDIR"), String::from("/tmp"));
        env_map.insert(String::from("TMP"), String::from("/tmp"));
        env_map.insert(String::from("TEMP"), String::from("/tmp"));
    }

    if let Some(home) = spec
        .user_home
        .as_ref()
        .and_then(|p| p.to_str().map(String::from))
        .or_else(|| std::env::var("HOME").ok())
    {
        env_map.insert(String::from("HOME"), home);
    }

    for allow_key in spec
        .allowlisted_host_env
        .iter()
        .chain(command.allowlisted_host_env.iter())
    {
        if let Ok(val) = std::env::var(allow_key) {
            env_map.insert(allow_key.clone(), val);
        }
    }

    for (k, v) in &spec.extra_env {
        env_map.insert(k.clone(), v.clone());
    }
    for (k, v) in &command.extra_env {
        env_map.insert(k.clone(), v.clone());
    }

    env_map
}

pub(crate) struct WorkspaceProtectionGuard {
    ro_paths: Vec<PathBuf>,
    created_sentinel_dirs: Vec<PathBuf>,
}

impl WorkspaceProtectionGuard {
    pub(crate) fn ro_paths(&self) -> &[PathBuf] {
        &self.ro_paths
    }
}

impl Drop for WorkspaceProtectionGuard {
    fn drop(&mut self) {
        for dir in &self.created_sentinel_dirs {
            let _ = fs::remove_dir(dir);
        }
    }
}

fn ensure_no_symlinks_in_tree(root: &Path, depth: usize) -> Result<()> {
    if depth > 8 {
        return Ok(());
    }
    let meta = fs::symlink_metadata(root).map_err(|e| QuetzalcoatlError::SandboxViolation {
        detail: format!("读取受保护路径元数据失败 ({}): {e}", root.display()),
    })?;
    if meta.file_type().is_symlink() {
        return Err(QuetzalcoatlError::SandboxViolation {
            detail: format!("检测到受保护路径存在符号链接逃逸风险: {}", root.display()),
        });
    }
    if meta.is_dir() {
        let entries = fs::read_dir(root).map_err(|e| QuetzalcoatlError::SandboxViolation {
            detail: format!("遍历受保护目录失败 ({}): {e}", root.display()),
        })?;
        for entry_res in entries {
            let entry = entry_res.map_err(|e| QuetzalcoatlError::SandboxViolation {
                detail: format!("读取受保护目录项失败 ({}): {e}", root.display()),
            })?;
            let ftype = entry
                .file_type()
                .map_err(|e| QuetzalcoatlError::SandboxViolation {
                    detail: format!("读取受保护目录项类型失败 ({}): {e}", entry.path().display()),
                })?;
            if ftype.is_symlink() {
                return Err(QuetzalcoatlError::SandboxViolation {
                    detail: format!(
                        "受保护配置/钩子目录内禁止包含符号链接: {}",
                        entry.path().display()
                    ),
                });
            }
            if ftype.is_dir() {
                ensure_no_symlinks_in_tree(&entry.path(), depth + 1)?;
            }
        }
    }
    Ok(())
}

/// 校验工作区不与敏感密钥目录重叠、拒绝受保护配置/钩子路径上的符号链接，并准备只读锁定挂载列表。
pub(crate) fn prepare_workspace_protections(
    spec: &SandboxExecSpec,
) -> Result<WorkspaceProtectionGuard> {
    let ws = &spec.workspace_dir;
    let ws_meta = fs::symlink_metadata(ws).map_err(|e| QuetzalcoatlError::SandboxViolation {
        detail: format!("工作区路径不存在或不可访问 ({}): {e}", ws.display()),
    })?;
    if ws_meta.file_type().is_symlink() || !ws_meta.is_dir() {
        return Err(QuetzalcoatlError::SandboxViolation {
            detail: format!(
                "工作区根路径必须为真实目录（严禁符号链接）: {}",
                ws.display()
            ),
        });
    }

    let canon_ws = fs::canonicalize(ws).map_err(|e| QuetzalcoatlError::SandboxViolation {
        detail: format!("规范化工作区路径失败 ({}): {e}", ws.display()),
    })?;

    for masked in collect_collapsed_masked_paths(spec) {
        let cmp_masked = fs::canonicalize(&masked).unwrap_or(masked);
        if canon_ws.starts_with(&cmp_masked) {
            return Err(QuetzalcoatlError::SandboxViolation {
                detail: format!(
                    "拒绝将宿主敏感目录作为沙箱工作区挂载: workspace={}, masked={}",
                    canon_ws.display(),
                    cmp_masked.display()
                ),
            });
        }
    }

    if let Some(suite_dir) = &spec.verifier_suite_dir {
        let suite_meta =
            fs::symlink_metadata(suite_dir).map_err(|e| QuetzalcoatlError::SandboxViolation {
                detail: format!("洁净室校验套件目录不可访问 ({}): {e}", suite_dir.display()),
            })?;
        if suite_meta.file_type().is_symlink() || !suite_meta.is_dir() {
            return Err(QuetzalcoatlError::SandboxViolation {
                detail: format!("洁净室校验套件路径必须为真实目录: {}", suite_dir.display()),
            });
        }
        let canon_suite =
            fs::canonicalize(suite_dir).map_err(|e| QuetzalcoatlError::SandboxViolation {
                detail: format!("规范化校验套件路径失败 ({}): {e}", suite_dir.display()),
            })?;
        if canon_suite.starts_with(&canon_ws) || canon_ws.starts_with(&canon_suite) {
            return Err(QuetzalcoatlError::SandboxViolation {
                detail: format!(
                    "洁净室校验套件目录 ({}) 严禁与候选工作区 ({}) 重叠（防奖励作弊）",
                    canon_suite.display(),
                    canon_ws.display()
                ),
            });
        }
    }

    let mut ro_paths = Vec::<PathBuf>::new();
    let mut created_sentinel_dirs = Vec::<PathBuf>::new();

    if spec.mode == SandboxMode::WorkspaceWritable {
        // 1. 保护 .git 与 .git/hooks（兼容普通仓库与 Git Worktree 单文件 .git）
        let dot_git = ws.join(".git");
        let dot_git_hooks = dot_git.join("hooks");
        match fs::symlink_metadata(&dot_git) {
            Ok(git_meta) => {
                if git_meta.file_type().is_symlink() {
                    return Err(QuetzalcoatlError::SandboxViolation {
                        detail: format!("拒绝工作区符号链接 .git: {}", dot_git.display()),
                    });
                }
                if git_meta.is_file() {
                    // Git Worktree 模式下 .git 为普通文件，直接将其只读挂载防篡改 gitdir 指针
                    ro_paths.push(dot_git);
                } else if git_meta.is_dir() {
                    match fs::symlink_metadata(&dot_git_hooks) {
                        Ok(hooks_meta) => {
                            if hooks_meta.file_type().is_symlink() {
                                return Err(QuetzalcoatlError::SandboxViolation {
                                    detail: format!(
                                        "拒绝工作区符号链接 .git/hooks: {}",
                                        dot_git_hooks.display()
                                    ),
                                });
                            }
                            ensure_no_symlinks_in_tree(&dot_git_hooks, 0)?;
                            ro_paths.push(dot_git_hooks);
                        }
                        Err(_) => {
                            fs::create_dir(&dot_git_hooks).map_err(|e| {
                                QuetzalcoatlError::SandboxViolation {
                                    detail: format!(
                                        "创建受保护哨兵目录失败 ({}): {e}",
                                        dot_git_hooks.display()
                                    ),
                                }
                            })?;
                            created_sentinel_dirs.push(dot_git_hooks.clone());
                            ro_paths.push(dot_git_hooks);
                        }
                    }
                }
            }
            Err(_) => {
                fs::create_dir(&dot_git).map_err(|e| QuetzalcoatlError::SandboxViolation {
                    detail: format!("创建受保护哨兵目录失败 ({}): {e}", dot_git.display()),
                })?;
                fs::create_dir(&dot_git_hooks).map_err(|e| {
                    let _ = fs::remove_dir(&dot_git);
                    QuetzalcoatlError::SandboxViolation {
                        detail: format!(
                            "创建受保护哨兵目录失败 ({}): {e}",
                            dot_git_hooks.display()
                        ),
                    }
                })?;
                // 逆序登记以便 Drop 时先删子目录再删父目录
                created_sentinel_dirs.push(dot_git_hooks.clone());
                created_sentinel_dirs.push(dot_git);
                ro_paths.push(dot_git_hooks);
            }
        }

        // 2. 保护 .opencode, .claude, .codex
        for rel in [".opencode", ".claude", ".codex"] {
            let sub = ws.join(rel);
            match fs::symlink_metadata(&sub) {
                Ok(meta) => {
                    if meta.file_type().is_symlink() {
                        return Err(QuetzalcoatlError::SandboxViolation {
                            detail: format!("拒绝工作区受保护目录符号链接逃逸: {}", sub.display()),
                        });
                    }
                    ensure_no_symlinks_in_tree(&sub, 0)?;
                    ro_paths.push(sub);
                }
                Err(_) => {
                    fs::create_dir(&sub).map_err(|e| QuetzalcoatlError::SandboxViolation {
                        detail: format!("创建受保护哨兵目录失败 ({}): {e}", sub.display()),
                    })?;
                    created_sentinel_dirs.push(sub.clone());
                    ro_paths.push(sub);
                }
            }
        }
    }

    Ok(WorkspaceProtectionGuard {
        ro_paths,
        created_sentinel_dirs,
    })
}

#[derive(Clone, Debug)]
struct TicketState {
    expires_at_ms: u64,
    consumed: bool,
}

struct TicketMacFields<'a> {
    ticket_id: Uuid,
    run_id: RunId,
    workspace_dir: &'a Path,
    mode: SandboxMode,
    network_policy: NetworkPolicy,
    issued_at_ms: u64,
    expires_at_ms: u64,
}

fn compute_ticket_mac(signing_key: &[u8; 32], fields: &TicketMacFields<'_>) -> [u8; 32] {
    let mut hasher = blake3::Hasher::new_keyed(signing_key);
    hasher.update(TICKET_MAC_DOMAIN);
    hasher.update(fields.ticket_id.as_bytes());
    hasher.update(fields.run_id.as_bytes());
    let ws_bytes = fields.workspace_dir.to_string_lossy();
    let ws_raw = ws_bytes.as_bytes();
    hasher.update(&(ws_raw.len() as u64).to_be_bytes());
    hasher.update(ws_raw);
    hasher.update(&[match fields.mode {
        SandboxMode::WorkspaceWritable => 0,
        SandboxMode::CleanRoomReadOnly => 1,
    }]);
    hasher.update(&[match fields.network_policy {
        NetworkPolicy::AllowHostNetwork => 0,
        NetworkPolicy::Isolated => 1,
    }]);
    hasher.update(&fields.issued_at_ms.to_be_bytes());
    hasher.update(&fields.expires_at_ms.to_be_bytes());
    *hasher.finalize().as_bytes()
}

/// 桌面无容器沙箱管理器。
pub struct SandboxManager {
    config: SandboxConfig,
    signing_key: Zeroizing<[u8; 32]>,
    tickets: Mutex<BTreeMap<Uuid, TicketState>>,
}

impl SandboxManager {
    #[must_use]
    pub fn new(config: SandboxConfig) -> Self {
        let mut key = [0u8; 32];
        OsRng.fill_bytes(&mut key);
        Self::with_signing_key(config, key)
    }

    #[must_use]
    pub fn with_signing_key(config: SandboxConfig, signing_key: [u8; 32]) -> Self {
        Self {
            config,
            signing_key: Zeroizing::new(signing_key),
            tickets: Mutex::new(BTreeMap::new()),
        }
    }

    #[must_use]
    pub const fn config(&self) -> &SandboxConfig {
        &self.config
    }

    /// 执行当前操作系统宿主的真实沙箱能力探针。
    pub fn probe(&self) -> Result<SandboxProbeReport> {
        if cfg!(target_os = "linux") {
            linux::probe_linux()
        } else if cfg!(target_os = "macos") {
            macos::probe_macos()
        } else if cfg!(target_os = "windows") {
            windows::probe_windows()
        } else {
            Ok(SandboxProbeReport {
                backend: SandboxBackendKind::Unavailable,
                available: false,
                binary_path: None,
                supports_network_isolation: false,
                supports_readonly_bind: false,
                supports_seccomp_clone3_enosys: false,
                apparmor_userns_restricted: false,
                detail: String::from("当前操作系统暂未配置桌面无容器沙箱后端"),
            })
        }
    }

    /// 使用环境变量默认配置探测宿主沙箱。
    pub fn probe_host() -> Result<SandboxProbeReport> {
        Self::new(SandboxConfig::from_env()).probe()
    }

    /// 签发绑定 `RunId`、工作区、读写模式、网络策略与 TTL 的一次性密码学执行票据。
    pub fn mint_ticket(&self, req: TicketRequest) -> Result<ExecutionTicket> {
        if req.workspace_dir.as_os_str().is_empty() {
            return Err(QuetzalcoatlError::SandboxViolation {
                detail: String::from("签发沙箱票据时 workspace_dir 不能为空"),
            });
        }
        let ttl_ms = req.ttl_ms.unwrap_or(self.config.default_ticket_ttl_ms);
        if ttl_ms == 0 {
            return Err(QuetzalcoatlError::SandboxViolation {
                detail: String::from("沙箱票据有效期 ttl_ms 必须大于 0"),
            });
        }
        let expires_at_ms = req.now_wall_ms.checked_add(ttl_ms).ok_or_else(|| {
            QuetzalcoatlError::SandboxViolation {
                detail: String::from("沙箱票据时间戳溢出"),
            }
        })?;

        let ticket_id = Uuid::new_v4();
        let mac = compute_ticket_mac(
            &self.signing_key,
            &TicketMacFields {
                ticket_id,
                run_id: req.run_id,
                workspace_dir: &req.workspace_dir,
                mode: req.mode,
                network_policy: req.network_policy,
                issued_at_ms: req.now_wall_ms,
                expires_at_ms,
            },
        );

        let mut guard = self
            .tickets
            .lock()
            .map_err(|_| QuetzalcoatlError::SandboxViolation {
                detail: String::from("SandboxManager 票据表锁异常"),
            })?;
        if guard.len() >= MAX_TRACKED_TICKETS {
            guard.retain(|_, st| !st.consumed && st.expires_at_ms >= req.now_wall_ms);
        }
        guard.insert(
            ticket_id,
            TicketState {
                expires_at_ms,
                consumed: false,
            },
        );

        Ok(ExecutionTicket {
            ticket_id,
            run_id: req.run_id,
            workspace_dir: req.workspace_dir,
            mode: req.mode,
            network_policy: req.network_policy,
            issued_at_ms: req.now_wall_ms,
            expires_at_ms,
            mac_tag_hex: hex_encode(&mac),
        })
    }

    fn consume_ticket(&self, ticket: &ExecutionTicket, now_wall_ms: u64) -> Result<()> {
        let provided_mac =
            hex_decode_fixed::<32>("ExecutionTicket.mac_tag_hex", &ticket.mac_tag_hex).map_err(
                |_| QuetzalcoatlError::SandboxViolation {
                    detail: String::from("执行票据 MAC 格式非法"),
                },
            )?;
        let expected_mac = compute_ticket_mac(
            &self.signing_key,
            &TicketMacFields {
                ticket_id: ticket.ticket_id,
                run_id: ticket.run_id,
                workspace_dir: &ticket.workspace_dir,
                mode: ticket.mode,
                network_policy: ticket.network_policy,
                issued_at_ms: ticket.issued_at_ms,
                expires_at_ms: ticket.expires_at_ms,
            },
        );
        if !constant_time_eq_32(&provided_mac, &expected_mac) {
            return Err(QuetzalcoatlError::SandboxViolation {
                detail: String::from("执行票据密码学签名校验失败（疑似篡改）"),
            });
        }

        let mut guard = self
            .tickets
            .lock()
            .map_err(|_| QuetzalcoatlError::SandboxViolation {
                detail: String::from("SandboxManager 票据表锁异常"),
            })?;
        let state = guard.get_mut(&ticket.ticket_id).ok_or_else(|| {
            QuetzalcoatlError::SandboxViolation {
                detail: format!("未知的执行票据: {}", ticket.ticket_id),
            }
        })?;

        if state.consumed {
            return Err(QuetzalcoatlError::SandboxViolation {
                detail: format!("执行票据 {} 已被消费，严禁重放", ticket.ticket_id),
            });
        }
        if now_wall_ms > ticket.expires_at_ms || now_wall_ms > state.expires_at_ms {
            state.consumed = true;
            return Err(QuetzalcoatlError::SandboxViolation {
                detail: format!(
                    "执行票据 {} 已过期 (now={now_wall_ms}, expires={})",
                    ticket.ticket_id, ticket.expires_at_ms
                ),
            });
        }
        if now_wall_ms < ticket.issued_at_ms {
            return Err(QuetzalcoatlError::SandboxViolation {
                detail: String::from("当前时间早于执行票据签发时间"),
            });
        }

        state.consumed = true;
        Ok(())
    }

    /// 核销一次性执行票据并在对应 OS 沙箱内运行目标命令。
    pub fn execute_with_ticket(
        &self,
        ticket: &ExecutionTicket,
        command: &SandboxCommand,
        now_wall_ms: u64,
    ) -> Result<SandboxExecutionOutput> {
        self.consume_ticket(ticket, now_wall_ms)?;

        let exec_spec = SandboxExecSpec {
            quetzalcoatl_home: self.config.quetzalcoatl_home.clone(),
            user_home: self.config.user_home.clone(),
            workspace_dir: ticket.workspace_dir.clone(),
            mode: ticket.mode,
            network_policy: ticket.network_policy,
            verifier_suite_dir: None,
            broker_unix_socket: command.broker_unix_socket.clone(),
            extra_masked_paths: self.config.extra_masked_paths.clone(),
            extra_ro_mounts: command.extra_ro_mounts.clone(),
            extra_env: BTreeMap::new(),
            allowlisted_host_env: Vec::new(),
        };

        Self::execute_spec_direct(&exec_spec, command, false)
    }

    /// 拉起断网只读洁净室沙箱运行客观校验套件（供 Task 1.5 `CleanRoomVerifierDag` 消费，防坑规范 #8）。
    pub fn spawn_clean_room(&self, spec: &CleanRoomSpec) -> Result<SandboxExecutionOutput> {
        let exec_spec = SandboxExecSpec {
            quetzalcoatl_home: self.config.quetzalcoatl_home.clone(),
            user_home: self.config.user_home.clone(),
            workspace_dir: spec.candidate_workspace.clone(),
            mode: SandboxMode::CleanRoomReadOnly,
            network_policy: NetworkPolicy::Isolated,
            verifier_suite_dir: Some(spec.verifier_suite_dir.clone()),
            broker_unix_socket: None,
            extra_masked_paths: self.config.extra_masked_paths.clone(),
            extra_ro_mounts: spec.command.extra_ro_mounts.clone(),
            extra_env: BTreeMap::from([(
                String::from("QUETZALCOATL_CLEAN_ROOM_RUN_ID"),
                spec.run_id.to_string(),
            )]),
            allowlisted_host_env: Vec::new(),
        };

        Self::execute_spec_direct(&exec_spec, &spec.command, false)
    }

    /// 直接按序列化规格在当前平台 OS 沙箱内执行（供 `quetzalcoatl-sandbox-exec` 包装器复用）。
    pub fn execute_spec_direct(
        spec: &SandboxExecSpec,
        command: &SandboxCommand,
        inherit_stdio: bool,
    ) -> Result<SandboxExecutionOutput> {
        if cfg!(target_os = "linux") {
            linux::execute_linux(spec, command, inherit_stdio)
        } else if cfg!(target_os = "macos") {
            macos::execute_macos(spec, command, inherit_stdio)
        } else if cfg!(target_os = "windows") {
            windows::execute_windows(spec, command, inherit_stdio)
        } else {
            Err(QuetzalcoatlError::SandboxViolation {
                detail: String::from("当前平台无可用桌面无容器沙箱后端"),
            })
        }
    }
}
