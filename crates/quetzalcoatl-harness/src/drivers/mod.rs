#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]

//! 通用 Coding Agent 驱动协议层、统一 `HarnessEvent` 事件流与每任务独立 Git Worktree 安全管理。

pub mod acp;
pub mod claude;
pub mod codex;
pub mod opencode;
pub mod pi;

use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File};
use std::io;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::sync::Arc;

use quetzalcoatl_sandbox::{ExecutionTicket, PROTECTED_WORKSPACE_SUBPATHS, SandboxManager};
use quetzalcoatl_types::{QuetzalcoatlError, Result, RunId};
use serde::{Deserialize, Serialize};

use crate::discovery::CodingAgentKind;
use crate::gateway::GatewaySessionGrant;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct EwaveCheckTag {
    pub conflict: String,
    pub ids: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum HarnessEvent {
    SessionStarted {
        session_id: String,
        agent: CodingAgentKind,
        pid: Option<u32>,
    },
    TurnStarted {
        turn_id: String,
    },
    Delta {
        text: String,
    },
    ToolCall {
        call_id: String,
        tool_name: String,
        arguments_json: String,
    },
    PermissionRequest {
        request_id: String,
        capability_id: String,
        detail: String,
    },
    DiffProduced {
        workspace_dir: PathBuf,
        changed_files: Vec<String>,
        unified_diff: String,
    },
    TurnCompleted {
        turn_id: String,
        final_text: String,
        ewave_check: Option<EwaveCheckTag>,
    },
}

/// 强制绑定到单次 `Worker` 执行的 OS 沙箱票据与只读存根挂载集合。
#[derive(Clone)]
pub struct SandboxLaunchBinding {
    pub manager: Arc<SandboxManager>,
    pub ticket: ExecutionTicket,
    pub extra_ro_mounts: Vec<PathBuf>,
}

impl std::fmt::Debug for SandboxLaunchBinding {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SandboxLaunchBinding")
            .field("ticket_id", &self.ticket.ticket_id)
            .field("workspace_dir", &self.ticket.workspace_dir)
            .field("extra_ro_mounts", &self.extra_ro_mounts)
            .finish()
    }
}

#[derive(Clone, Debug)]
pub struct HarnessLaunchContext {
    pub agent_kind: CodingAgentKind,
    pub binary_path: PathBuf,
    pub workspace_dir: PathBuf,
    pub sandbox_exec_path: PathBuf,
    pub sandbox_spec_path: Option<PathBuf>,
    pub sandbox_binding: Option<SandboxLaunchBinding>,
    pub gateway_grant: GatewaySessionGrant,
    pub claude_stub_dir: Option<PathBuf>,
    pub codex_stub_dir: Option<PathBuf>,
    pub active_codex_provider: String,
    pub codex_uses_chatgpt_oauth: bool,
    pub enhancers_root_dir: Option<PathBuf>,
    pub mcp_endpoint_url: Option<String>,
    pub daemon_ipc_url: Option<String>,
    pub daemon_ipc_token: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HarnessLaunchPlan {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    pub env: BTreeMap<String, String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HarnessRunOutcome {
    pub events: Vec<HarnessEvent>,
    pub final_text: String,
    pub changed_files: Vec<String>,
    pub unified_diff: String,
    pub exit_code: i32,
}

pub trait HarnessDriver: Send + Sync {
    fn kind(&self) -> CodingAgentKind;
    fn build_launch_plan(
        &self,
        ctx: &HarnessLaunchContext,
        prompt: &str,
    ) -> Result<HarnessLaunchPlan>;
    fn execute_turn(&self, ctx: &HarnessLaunchContext, prompt: &str) -> Result<HarnessRunOutcome>;
}

pub(crate) fn build_common_sandbox_env(ctx: &HarnessLaunchContext) -> BTreeMap<String, String> {
    let mut env = BTreeMap::new();
    let default_path = if cfg!(windows) {
        String::from(r"C:\Windows\System32;C:\Windows")
    } else {
        String::from("/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin")
    };
    env.insert(
        String::from("PATH"),
        std::env::var("PATH").unwrap_or(default_path),
    );
    if let Ok(home) = std::env::var("HOME") {
        env.insert(String::from("HOME"), home);
    }
    env.insert(String::from("LANG"), String::from("C.UTF-8"));
    env.insert(
        String::from("SHELL"),
        ctx.sandbox_exec_path.to_string_lossy().into_owned(),
    );
    env.insert(
        String::from("QUETZALCOATL_SANDBOX_WORKSPACE"),
        ctx.workspace_dir.to_string_lossy().into_owned(),
    );
    env.insert(
        String::from("QUETZALCOATL_GATEWAY_URL"),
        ctx.gateway_grant.run_base_url.clone(),
    );
    env.insert(
        String::from("QUETZALCOATL_QZ_TOKEN"),
        ctx.gateway_grant.qz_token.clone(),
    );
    env.insert(
        String::from("OPENCODE_CONFIG_PROJECT_DISABLE"),
        String::from("1"),
    );
    env.insert(String::from("ORT_DISABLE_TELEMETRY"), String::from("1"));

    if let Some(spec) = &ctx.sandbox_spec_path {
        env.insert(
            String::from("QUETZALCOATL_SANDBOX_SPEC"),
            spec.to_string_lossy().into_owned(),
        );
    }
    if let Some(claude_stub) = &ctx.claude_stub_dir {
        env.insert(
            String::from("CLAUDE_CONFIG_DIR"),
            claude_stub.to_string_lossy().into_owned(),
        );
    }
    if let Some(codex_stub) = &ctx.codex_stub_dir {
        env.insert(
            String::from("CODEX_HOME"),
            codex_stub.to_string_lossy().into_owned(),
        );
    }
    if let Some(mcp_url) = &ctx.mcp_endpoint_url {
        env.insert(String::from("QUETZALCOATL_MCP_URL"), mcp_url.clone());
    }
    if let Some(daemon_url) = &ctx.daemon_ipc_url {
        env.insert(String::from("QUETZALCOATL_DAEMON_URL"), daemon_url.clone());
    }
    if let Some(ipc_tok) = &ctx.daemon_ipc_token {
        env.insert(String::from("QUETZALCOATL_IPC_TOKEN"), ipc_tok.clone());
    }
    env
}

/// 从输出文本末尾或正文中提取 `<ewave_check conflict="..." ids="..."/>` 结构化自检标签。
#[must_use]
pub fn parse_ewave_check_tag(text: &str) -> Option<EwaveCheckTag> {
    let start_idx = text.rfind("<ewave_check")?;
    let tail = &text[start_idx..];
    let end_rel = tail.find("/>").or_else(|| tail.find('>'))?;
    let tag_slice = &tail[..end_rel];

    let conflict = extract_xml_attr(tag_slice, "conflict")?;
    let ids_raw = extract_xml_attr(tag_slice, "ids").unwrap_or_default();
    let ids = ids_raw
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from)
        .collect();
    Some(EwaveCheckTag { conflict, ids })
}

fn extract_xml_attr(tag: &str, attr_name: &str) -> Option<String> {
    let pattern = format!("{attr_name}=\"");
    let pos = tag.find(&pattern)?;
    let rest = &tag[pos + pattern.len()..];
    let close = rest.find('"')?;
    Some(String::from(&rest[..close]))
}

pub(crate) fn inspect_git_workspace_diff(workspace_dir: &Path) -> (Vec<String>, String) {
    let mut changed = BTreeSet::<String>::new();
    if let Ok(status_out) = Command::new("git")
        .current_dir(workspace_dir)
        .args(["status", "-z", "--porcelain", "-uall"])
        .output()
        && status_out.status.success()
    {
        let entries: Vec<&[u8]> = status_out
            .stdout
            .split(|&b| b == 0)
            .filter(|s| !s.is_empty())
            .collect();
        let mut idx = 0usize;
        while idx < entries.len() {
            let entry = entries[idx];
            if entry.len() > 3 {
                let status_xy = &entry[..2];
                let path_bytes = &entry[3..];
                if let Ok(p_str) = std::str::from_utf8(path_bytes)
                    && !p_str.is_empty()
                {
                    changed.insert(String::from(p_str));
                }
                // 在 `git status -z` 格式中，R/C 重命名或拷贝会紧跟一条旧路径 NUL 记录，需跳过
                if status_xy.starts_with(b"R") || status_xy.starts_with(b"C") {
                    idx += 1;
                }
            }
            idx += 1;
        }
    }

    let unified_diff = Command::new("git")
        .current_dir(workspace_dir)
        .args(["diff", "HEAD"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
        .unwrap_or_default();

    (changed.into_iter().collect(), unified_diff)
}

fn validate_safe_worktree_rel_segments(raw_rel: &str) -> Result<(String, Vec<String>)> {
    if raw_rel.is_empty()
        || raw_rel.starts_with('/')
        || raw_rel.contains('\\')
        || raw_rel.contains('\0')
    {
        return Err(QuetzalcoatlError::SandboxViolation {
            detail: format!("拒绝工作树非法变更路径 `{raw_rel}`"),
        });
    }
    let rel_path = Path::new(raw_rel);
    if rel_path.is_absolute() {
        return Err(QuetzalcoatlError::SandboxViolation {
            detail: format!("拒绝工作树绝对路径 `{raw_rel}`"),
        });
    }

    let mut segs = Vec::<String>::new();
    for comp in rel_path.components() {
        match comp {
            Component::Normal(s) => {
                let utf8 = s
                    .to_str()
                    .ok_or_else(|| QuetzalcoatlError::SandboxViolation {
                        detail: String::from("工作树路径包含非 UTF-8 组件"),
                    })?;
                if utf8.is_empty() || utf8.contains('\0') {
                    return Err(QuetzalcoatlError::SandboxViolation {
                        detail: String::from("工作树路径包含空组件或 NUL"),
                    });
                }
                segs.push(String::from(utf8));
            }
            Component::CurDir
            | Component::ParentDir
            | Component::RootDir
            | Component::Prefix(_) => {
                return Err(QuetzalcoatlError::SandboxViolation {
                    detail: format!("拒绝工作树目录穿越路径 `{raw_rel}`"),
                });
            }
        }
    }
    if segs.is_empty() {
        return Err(QuetzalcoatlError::SandboxViolation {
            detail: String::from("工作树相对路径为空"),
        });
    }

    let norm = segs.join("/");
    if norm == ".git" || norm.starts_with(".git/") {
        return Err(QuetzalcoatlError::SandboxViolation {
            detail: format!("禁止工作树修改 .git 内部路径: `{norm}`"),
        });
    }
    for protected in PROTECTED_WORKSPACE_SUBPATHS {
        if norm == *protected || norm.starts_with(&format!("{protected}/")) {
            return Err(QuetzalcoatlError::SandboxViolation {
                detail: format!("禁止工作树修改受保护配置/钩子子路径: `{norm}`"),
            });
        }
    }

    Ok((norm, segs))
}

fn ensure_no_symlink_along_segments(
    base_dir: &Path,
    segments: &[String],
    allow_missing_tail: bool,
) -> Result<()> {
    let base_meta =
        fs::symlink_metadata(base_dir).map_err(|e| QuetzalcoatlError::SandboxViolation {
            detail: format!("校验根目录元数据失败 ({}): {e}", base_dir.display()),
        })?;
    if base_meta.file_type().is_symlink() || !base_meta.is_dir() {
        return Err(QuetzalcoatlError::SandboxViolation {
            detail: format!("根目录严禁为符号链接: {}", base_dir.display()),
        });
    }

    let mut cursor = base_dir.to_path_buf();
    for (idx, seg) in segments.iter().enumerate() {
        cursor.push(seg);
        let is_last = idx + 1 == segments.len();
        match fs::symlink_metadata(&cursor) {
            Ok(meta) => {
                if meta.file_type().is_symlink() {
                    return Err(QuetzalcoatlError::SandboxViolation {
                        detail: format!(
                            "检测到符号链接逃逸/窃密风险，已硬阻断: {}",
                            cursor.display()
                        ),
                    });
                }
                if !is_last && !meta.is_dir() {
                    return Err(QuetzalcoatlError::SandboxViolation {
                        detail: format!("路径中间节点不是普通目录: {}", cursor.display()),
                    });
                }
                if is_last && !meta.is_file() {
                    return Err(QuetzalcoatlError::SandboxViolation {
                        detail: format!("同步目标不是普通文件: {}", cursor.display()),
                    });
                }
            }
            Err(_) if allow_missing_tail => {}
            Err(e) => {
                return Err(QuetzalcoatlError::SandboxViolation {
                    detail: format!("读取工作树路径元数据失败 ({}): {e}", cursor.display()),
                });
            }
        }
    }
    Ok(())
}

fn scan_worktree_for_forbidden_entries(dir: &Path, rel_prefix: &str) -> Result<()> {
    let entries = fs::read_dir(dir).map_err(|e| QuetzalcoatlError::StorageError {
        detail: format!("扫描工作树目录失败 ({}): {e}", dir.display()),
    })?;
    for entry_res in entries {
        let entry = entry_res.map_err(|e| QuetzalcoatlError::StorageError {
            detail: format!("读取工作树目录项失败: {e}"),
        })?;
        let name_os = entry.file_name();
        let name = name_os
            .to_str()
            .ok_or_else(|| QuetzalcoatlError::SandboxViolation {
                detail: String::from("工作树存在非 UTF-8 文件名"),
            })?;
        if rel_prefix.is_empty() && name == ".git" {
            continue;
        }
        let rel = if rel_prefix.is_empty() {
            String::from(name)
        } else {
            format!("{rel_prefix}/{name}")
        };

        let ftype = entry
            .file_type()
            .map_err(|e| QuetzalcoatlError::SandboxViolation {
                detail: format!("读取工作树目录项类型失败 ({rel}): {e}"),
            })?;
        if ftype.is_symlink() {
            return Err(QuetzalcoatlError::SandboxViolation {
                detail: format!("拒绝工作树中的符号链接文件 `{rel}`（防止解引用泄露宿主敏感文件）"),
            });
        }
        if ftype.is_dir() {
            scan_worktree_for_forbidden_entries(&entry.path(), &rel)?;
        }
    }
    Ok(())
}

/// 独立 `Worker` 隔离 Git Worktree 租约句柄（未通过洁净室验收前绝不触碰原仓库，析构时自动回收工作树）。
pub struct WorktreeLease {
    repo_dir: PathBuf,
    worktree_dir: PathBuf,
    cleaned: bool,
}

impl WorktreeLease {
    #[must_use]
    pub fn repo_dir(&self) -> &Path {
        &self.repo_dir
    }

    #[must_use]
    pub fn worktree_dir(&self) -> &Path {
        &self.worktree_dir
    }

    pub fn capture_diff(&self) -> Result<(Vec<String>, String)> {
        Ok(inspect_git_workspace_diff(&self.worktree_dir))
    }

    /// 仅在断网只读洁净室 `Verifier` 验收通过并签发 `VerificationMark` 后，将工作树改动原子校验并同步回主仓库工作区。
    pub fn apply_verified_to_repo(&self) -> Result<Vec<String>> {
        // 1. 全量扫描工作树，确保不存在任何潜伏符号链接（包含可能被 .gitignore 忽略的符号链接）
        scan_worktree_for_forbidden_entries(&self.worktree_dir, "")?;

        let (changed_files, _) = self.capture_diff()?;
        let mut validated_plan =
            Vec::<(String, Vec<String>, bool)>::with_capacity(changed_files.len());

        // 2. 在触碰主仓库任何字节前执行全量预检（受保护子路径拦截 + 双向全组件 symlink_metadata 核验）
        for raw_rel in changed_files {
            let (norm_rel, segs) = validate_safe_worktree_rel_segments(&raw_rel)?;
            let src_candidate = self.worktree_dir.join(&norm_rel);
            let exists_in_wt = match fs::symlink_metadata(&src_candidate) {
                Ok(meta) => {
                    if meta.file_type().is_symlink() {
                        return Err(QuetzalcoatlError::SandboxViolation {
                            detail: format!("拒绝同步工作树符号链接 `{norm_rel}`"),
                        });
                    }
                    true
                }
                Err(_) => false,
            };

            if exists_in_wt {
                ensure_no_symlink_along_segments(&self.worktree_dir, &segs, false)?;
            } else {
                // 删除操作：校验父链无符号链接
                if segs.len() > 1 {
                    ensure_no_symlink_along_segments(
                        &self.worktree_dir,
                        &segs[..segs.len() - 1],
                        true,
                    )?;
                }
            }
            ensure_no_symlink_along_segments(&self.repo_dir, &segs, true)?;
            validated_plan.push((norm_rel, segs, exists_in_wt));
        }

        // 3. 安全执行非解引用普通文件复制与删除
        let mut applied = Vec::with_capacity(validated_plan.len());
        for (norm_rel, segs, exists_in_wt) in validated_plan {
            let src = self.worktree_dir.join(&norm_rel);
            let dst = self.repo_dir.join(&norm_rel);
            if exists_in_wt {
                let mut dst_cursor = self.repo_dir.clone();
                for seg in &segs[..segs.len() - 1] {
                    dst_cursor.push(seg);
                    match fs::symlink_metadata(&dst_cursor) {
                        Ok(m) => {
                            if m.file_type().is_symlink() || !m.is_dir() {
                                return Err(QuetzalcoatlError::SandboxViolation {
                                    detail: format!(
                                        "目标仓库父目录检测到非法符号链接: {}",
                                        dst_cursor.display()
                                    ),
                                });
                            }
                        }
                        Err(_) => {
                            fs::create_dir(&dst_cursor).map_err(|e| {
                                QuetzalcoatlError::StorageError {
                                    detail: format!(
                                        "创建目标仓库目录失败 ({}): {e}",
                                        dst_cursor.display()
                                    ),
                                }
                            })?;
                        }
                    }
                }

                let src_meta = fs::symlink_metadata(&src).map_err(|e| {
                    QuetzalcoatlError::SandboxViolation {
                        detail: format!("复核源文件元数据失败 ({}): {e}", src.display()),
                    }
                })?;
                if src_meta.file_type().is_symlink() || !src_meta.is_file() {
                    return Err(QuetzalcoatlError::SandboxViolation {
                        detail: format!("拒绝同步非普通文件: {}", src.display()),
                    });
                }
                if let Ok(dst_meta) = fs::symlink_metadata(&dst)
                    && dst_meta.file_type().is_symlink()
                {
                    return Err(QuetzalcoatlError::SandboxViolation {
                        detail: format!("拒绝覆盖目标仓库中的符号链接: {}", dst.display()),
                    });
                }

                let mut src_file =
                    File::open(&src).map_err(|e| QuetzalcoatlError::StorageError {
                        detail: format!("打开工作树源文件失败 ({}): {e}", src.display()),
                    })?;
                let mut dst_file =
                    File::create(&dst).map_err(|e| QuetzalcoatlError::StorageError {
                        detail: format!("写入目标仓库文件失败 ({}): {e}", dst.display()),
                    })?;
                io::copy(&mut src_file, &mut dst_file).map_err(|e| {
                    QuetzalcoatlError::StorageError {
                        detail: format!("复制已验收普通文件内容失败 ({norm_rel}): {e}"),
                    }
                })?;
                #[cfg(unix)]
                {
                    let mode = src_meta.permissions().mode() & 0o777;
                    let _ = fs::set_permissions(&dst, fs::Permissions::from_mode(mode));
                }
            } else if let Ok(dst_meta) = fs::symlink_metadata(&dst)
                && !dst_meta.file_type().is_symlink()
                && dst_meta.is_file()
            {
                let _ = fs::remove_file(&dst);
            }
            applied.push(norm_rel);
        }

        Ok(applied)
    }

    fn remove_worktree_internal(&mut self) -> Result<()> {
        if self.cleaned {
            return Ok(());
        }
        self.cleaned = true;
        let wt_str = self.worktree_dir.to_string_lossy().into_owned();
        let _ = Command::new("git")
            .current_dir(&self.repo_dir)
            .args(["worktree", "remove", "--force", &wt_str])
            .output();
        let _ = Command::new("git")
            .current_dir(&self.repo_dir)
            .args(["worktree", "prune"])
            .output();
        if self.worktree_dir.exists() {
            let _ = fs::remove_dir_all(&self.worktree_dir);
        }
        Ok(())
    }

    pub fn cleanup(mut self) -> Result<()> {
        self.remove_worktree_internal()
    }
}

impl Drop for WorktreeLease {
    fn drop(&mut self) {
        let _ = self.remove_worktree_internal();
    }
}

pub struct WorktreeManager;

impl WorktreeManager {
    pub fn create_detached(
        repo_dir: &Path,
        worktrees_root: &Path,
        run_id: RunId,
    ) -> Result<WorktreeLease> {
        fs::create_dir_all(worktrees_root).map_err(|e| QuetzalcoatlError::StorageError {
            detail: format!(
                "创建 worktrees 根目录失败 ({}): {e}",
                worktrees_root.display()
            ),
        })?;
        let wt_dir = worktrees_root.join(format!("wt-{run_id}"));
        if wt_dir.exists() {
            let _ = fs::remove_dir_all(&wt_dir);
        }
        let out = Command::new("git")
            .current_dir(repo_dir)
            .args([
                "worktree",
                "add",
                "--detach",
                &wt_dir.to_string_lossy(),
                "HEAD",
            ])
            .output()
            .map_err(|e| QuetzalcoatlError::StorageError {
                detail: format!("执行 git worktree add 失败: {e}"),
            })?;
        if !out.status.success() {
            return Err(QuetzalcoatlError::StorageError {
                detail: format!(
                    "git worktree add --detach 失败: {}",
                    String::from_utf8_lossy(&out.stderr).trim()
                ),
            });
        }
        Ok(WorktreeLease {
            repo_dir: repo_dir.to_path_buf(),
            worktree_dir: wt_dir,
            cleaned: false,
        })
    }
}
