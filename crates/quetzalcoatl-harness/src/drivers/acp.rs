#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]

//! 通用 ACP / JSON-RPC / `codex exec --json` / `opencode run --format json` 子进程事件流驱动（支持强制 OS 沙箱包裹执行）。

use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::{Command, Stdio};

use quetzalcoatl_sandbox::SandboxCommand;
use quetzalcoatl_types::{QuetzalcoatlError, Result};
use uuid::Uuid;

use crate::discovery::CodingAgentKind;
use crate::drivers::{
    HarnessDriver, HarnessEvent, HarnessLaunchContext, HarnessLaunchPlan, HarnessRunOutcome,
    SandboxLaunchBinding, build_common_sandbox_env, inspect_git_workspace_diff,
    parse_ewave_check_tag,
};

#[derive(Clone, Debug)]
pub struct AcpJsonRpcDriver {
    kind: CodingAgentKind,
}

impl AcpJsonRpcDriver {
    #[must_use]
    pub const fn new(kind: CodingAgentKind) -> Self {
        Self { kind }
    }

    /// 将单行 ACP / JSON-RPC / `stream-json` / `codex exec --json` / `opencode run --format json` 输出映射为标准 `HarnessEvent` 序列。
    #[must_use]
    pub fn parse_stream_line(agent: CodingAgentKind, line: &str) -> Vec<HarnessEvent> {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            return Vec::new();
        }
        let Ok(val) = serde_json::from_str::<serde_json::Value>(trimmed) else {
            return vec![HarnessEvent::Delta {
                text: format!("{trimmed}\n"),
            }];
        };

        let payload = val.get("params").unwrap_or(&val);
        let event_type = payload
            .get("type")
            .or_else(|| val.get("method"))
            .and_then(serde_json::Value::as_str)
            .unwrap_or("");

        match event_type {
            "session_started" | "session/started" | "thread.started" => {
                vec![HarnessEvent::SessionStarted {
                    session_id: payload
                        .get("session_id")
                        .or_else(|| payload.get("thread_id"))
                        .or_else(|| payload.get("sessionID"))
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or("acp-session")
                        .to_owned(),
                    agent,
                    pid: None,
                }]
            }
            "turn_started" | "turn/started" | "turn.started" | "step_start" => {
                vec![HarnessEvent::TurnStarted {
                    turn_id: payload
                        .get("turn_id")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or("turn-1")
                        .to_owned(),
                }]
            }
            // OpenCode `run --format json` 文本块 (`{"type":"text","part":{"type":"text","text":"..."}}`)
            "text" => {
                let text = payload
                    .get("part")
                    .and_then(|p| p.get("text"))
                    .or_else(|| payload.get("text"))
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("")
                    .to_owned();
                if text.is_empty() {
                    Vec::new()
                } else {
                    vec![HarnessEvent::Delta { text }]
                }
            }
            // Codex `exec --json` 条目完成帧 (`{"type":"item.completed","item":{"type":"agent_message","text":"..."}}`)
            "item.completed" => {
                let Some(item) = payload.get("item") else {
                    return Vec::new();
                };
                let mut out = Vec::new();
                let item_type = item
                    .get("type")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("");
                if matches!(
                    item_type,
                    "command_execution" | "mcp_tool_call" | "tool_call"
                ) {
                    out.push(HarnessEvent::ToolCall {
                        call_id: item
                            .get("id")
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or("codex-item")
                            .to_owned(),
                        tool_name: item
                            .get("tool")
                            .or_else(|| item.get("command"))
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or(item_type)
                            .to_owned(),
                        arguments_json: item.to_string(),
                    });
                }
                if let Some(txt) = item.get("text").and_then(serde_json::Value::as_str)
                    && !txt.is_empty()
                {
                    out.push(HarnessEvent::Delta {
                        text: String::from(txt),
                    });
                }
                out
            }
            "delta" | "agent_message_chunk" | "content_block_delta" => {
                let text = payload
                    .get("text")
                    .or_else(|| payload.get("delta").and_then(|d| d.get("text")))
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("")
                    .to_owned();
                if text.is_empty() {
                    Vec::new()
                } else {
                    vec![HarnessEvent::Delta { text }]
                }
            }
            "tool_call" | "tool_use" => {
                let part = payload.get("part");
                let call_id = payload
                    .get("call_id")
                    .or_else(|| payload.get("id"))
                    .or_else(|| part.and_then(|p| p.get("callID")))
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("call-0")
                    .to_owned();
                let tool_name = payload
                    .get("tool_name")
                    .or_else(|| payload.get("name"))
                    .or_else(|| part.and_then(|p| p.get("tool")))
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("unknown")
                    .to_owned();
                let arguments_json = payload
                    .get("arguments")
                    .or_else(|| payload.get("input"))
                    .or_else(|| {
                        part.and_then(|p| p.get("state"))
                            .and_then(|s| s.get("input"))
                    })
                    .map(ToString::to_string)
                    .unwrap_or_else(|| String::from("{}"));
                vec![HarnessEvent::ToolCall {
                    call_id,
                    tool_name,
                    arguments_json,
                }]
            }
            "permission_request" | "permission/request" => {
                vec![HarnessEvent::PermissionRequest {
                    request_id: payload
                        .get("request_id")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or("perm-0")
                        .to_owned(),
                    capability_id: payload
                        .get("capability_id")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or("unknown")
                        .to_owned(),
                    detail: payload
                        .get("detail")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or("")
                        .to_owned(),
                }]
            }
            "turn_completed" | "turn/completed" | "turn.completed" | "step_finish" | "result" => {
                let final_text = payload
                    .get("final_text")
                    .or_else(|| payload.get("result"))
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("")
                    .to_owned();
                let ewave_check = parse_ewave_check_tag(&final_text);
                vec![HarnessEvent::TurnCompleted {
                    turn_id: payload
                        .get("turn_id")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or("turn-1")
                        .to_owned(),
                    final_text,
                    ewave_check,
                }]
            }
            _ => Vec::new(),
        }
    }
}

pub(crate) fn run_plan_and_collect_events(
    agent: CodingAgentKind,
    plan: &HarnessLaunchPlan,
    sandbox_binding: Option<&SandboxLaunchBinding>,
) -> Result<HarnessRunOutcome> {
    if let Some(binding) = sandbox_binding {
        let mut sbx_cmd = SandboxCommand::new(
            plan.program.to_string_lossy().into_owned(),
            plan.args.clone(),
        );
        sbx_cmd.current_dir = Some(plan.cwd.clone());
        sbx_cmd.extra_env = plan.env.clone();

        let mut ro_mounts = binding.extra_ro_mounts.clone();
        if plan.program.starts_with(Path::new("/tmp/"))
            && !plan.program.starts_with(&plan.cwd)
            && plan.program.exists()
            && !ro_mounts.iter().any(|m| plan.program.starts_with(m))
        {
            ro_mounts.push(plan.program.clone());
        }
        sbx_cmd.extra_ro_mounts = ro_mounts;

        let now_ms = binding.ticket.issued_at_ms;
        let out = binding
            .manager
            .execute_with_ticket(&binding.ticket, &sbx_cmd, now_ms)?;
        let stdout_str = out.stdout_lossy();
        let stderr_str = out.stderr_lossy();
        return collect_events_from_output_lines(
            agent,
            None,
            &plan.cwd,
            stdout_str.lines(),
            &stderr_str,
            out.exit_code,
        );
    }

    let mut cmd = Command::new(&plan.program);
    cmd.args(&plan.args)
        .current_dir(&plan.cwd)
        .env_clear()
        .envs(&plan.env)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| QuetzalcoatlError::StorageError {
        detail: format!(
            "拉起底层 Coding Agent 子进程失败 ({}): {e}",
            plan.program.display()
        ),
    })?;

    let pid = Some(child.id());
    let mut stdout_lines = Vec::<String>::new();
    if let Some(stdout) = child.stdout.take() {
        let reader = BufReader::new(stdout);
        for line_res in reader.lines() {
            stdout_lines.push(line_res.map_err(|e| QuetzalcoatlError::StorageError {
                detail: format!("读取 Harness 标准输出流失败: {e}"),
            })?);
        }
    }
    let mut stderr_str = String::new();
    if let Some(mut stderr) = child.stderr.take() {
        use std::io::Read;
        let _ = stderr.read_to_string(&mut stderr_str);
    }

    let status = child.wait().map_err(|e| QuetzalcoatlError::StorageError {
        detail: format!("等待 Harness 子进程结束失败: {e}"),
    })?;
    let exit_code = status.code().unwrap_or(1);

    collect_events_from_output_lines(
        agent,
        pid,
        &plan.cwd,
        stdout_lines.iter().map(String::as_str),
        &stderr_str,
        exit_code,
    )
}

fn collect_events_from_output_lines<'a, I>(
    agent: CodingAgentKind,
    pid: Option<u32>,
    cwd: &Path,
    lines: I,
    stderr_summary: &str,
    exit_code: i32,
) -> Result<HarnessRunOutcome>
where
    I: Iterator<Item = &'a str>,
{
    let mut events = vec![HarnessEvent::SessionStarted {
        session_id: Uuid::new_v4().to_string(),
        agent,
        pid,
    }];

    let mut accumulated_delta = String::new();
    let mut explicit_final_text: Option<String> = None;

    for line in lines {
        for ev in AcpJsonRpcDriver::parse_stream_line(agent, line) {
            match &ev {
                HarnessEvent::Delta { text } => accumulated_delta.push_str(text),
                HarnessEvent::TurnCompleted { final_text, .. } if !final_text.is_empty() => {
                    explicit_final_text = Some(final_text.clone());
                }
                _ => {}
            }
            events.push(ev);
        }
    }

    let (changed_files, unified_diff) = inspect_git_workspace_diff(cwd);
    if !changed_files.is_empty() || !unified_diff.is_empty() {
        events.push(HarnessEvent::DiffProduced {
            workspace_dir: cwd.to_path_buf(),
            changed_files: changed_files.clone(),
            unified_diff: unified_diff.clone(),
        });
    }

    let mut final_text = explicit_final_text.unwrap_or_else(|| accumulated_delta.trim().to_owned());
    if exit_code != 0 && final_text.is_empty() && !stderr_summary.trim().is_empty() {
        final_text = stderr_summary.trim().to_owned();
    }

    // 若协议结束帧（如 codex turn.completed 或 opencode step_finish）自身不含 final_text，则用累积增量回填
    let mut has_completed = false;
    for ev in &mut events {
        if let HarnessEvent::TurnCompleted {
            final_text: ev_text,
            ewave_check,
            ..
        } = ev
        {
            has_completed = true;
            if ev_text.is_empty() && !final_text.is_empty() {
                *ev_text = final_text.clone();
                *ewave_check = parse_ewave_check_tag(&final_text);
            }
        }
    }

    if !has_completed {
        let ewave_check = parse_ewave_check_tag(&final_text);
        events.push(HarnessEvent::TurnCompleted {
            turn_id: String::from("turn-auto"),
            final_text: final_text.clone(),
            ewave_check,
        });
    }

    Ok(HarnessRunOutcome {
        events,
        final_text,
        changed_files,
        unified_diff,
        exit_code,
    })
}

impl HarnessDriver for AcpJsonRpcDriver {
    fn kind(&self) -> CodingAgentKind {
        self.kind
    }

    fn build_launch_plan(
        &self,
        ctx: &HarnessLaunchContext,
        prompt: &str,
    ) -> Result<HarnessLaunchPlan> {
        let mut env = build_common_sandbox_env(ctx);
        env.insert(
            String::from("QUETZALCOATL_TASK_PROMPT"),
            String::from(prompt),
        );
        Ok(HarnessLaunchPlan {
            program: ctx.binary_path.clone(),
            args: vec![
                String::from("acp"),
                String::from("--prompt"),
                String::from(prompt),
            ],
            cwd: ctx.workspace_dir.clone(),
            env,
        })
    }

    fn execute_turn(&self, ctx: &HarnessLaunchContext, prompt: &str) -> Result<HarnessRunOutcome> {
        let plan = self.build_launch_plan(ctx, prompt)?;
        run_plan_and_collect_events(self.kind, &plan, ctx.sandbox_binding.as_ref())
    }
}
