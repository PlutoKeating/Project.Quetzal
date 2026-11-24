#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]

//! 通用 Coding Agent 驱动协议层、统一 `HarnessEvent` 事件流与每任务独立 Git Worktree 管理。

pub mod acp;
pub mod claude;
pub mod codex;
pub mod opencode;
pub mod pi;

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

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

#[derive(Clone, Debug)]
pub struct HarnessLaunchContext {
    pub agent_kind: CodingAgentKind,
    pub binary_path: PathBuf,
    pub workspace_dir: PathBuf,
    pub sandbox_exec_path: PathBuf,
    pub sandbox_spec_path: Option<PathBuf>,
    pub gateway_grant: GatewaySessionGrant,
    pub claude_stub_dir: Option<PathBuf>,
    pub codex_stub_dir: Option<PathBuf>,
    pub active_codex_provider: String,
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
        .args(["status", "--porcelain", "-uall"])
        .output()
        && status_out.status.success()
    {
        let text = String::from_utf8_lossy(&status_out.stdout);
        for line in text.lines() {
            if line.len() > 3 {
                let raw_path = line[3..].trim();
                let final_path = match raw_path.split_once(" -> ") {
                    Some((_, to)) => to.trim(),
                    None => raw_path,
                };
                if !final_path.is_empty() {
                    changed.insert(String::from(final_path));
                }
            }
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

    /// 仅在断网只读洁净室 `Verifier` 验收通过并签发 `VerificationMark` 后，将工作树改动同步回主仓库工作区。
    pub fn apply_verified_to_repo(&self) -> Result<Vec<String>> {
        let (changed_files, _) = self.capture_diff()?;
        let mut applied = Vec::with_capacity(changed_files.len());
        for rel in changed_files {
            if rel == ".git" || rel.starts_with(".git/") || rel.contains("..") {
                continue;
            }
            let src = self.worktree_dir.join(&rel);
            let dst = self.repo_dir.join(&rel);
            if src.exists() {
                if let Some(parent) = dst.parent() {
                    fs::create_dir_all(parent).map_err(|e| QuetzalcoatlError::StorageError {
                        detail: format!("创建目标文件父目录失败 ({}): {e}", parent.display()),
                    })?;
                }
                fs::copy(&src, &dst).map_err(|e| QuetzalcoatlError::StorageError {
                    detail: format!(
                        "同步已验收文件失败 ({} -> {}): {e}",
                        src.display(),
                        dst.display()
                    ),
                })?;
            } else if dst.exists() {
                let _ = fs::remove_file(&dst);
            }
            applied.push(rel);
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
