#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]

//! 通用 ACP / JSON-RPC 子进程事件流驱动。

use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};

use quetzalcoatl_types::{QuetzalcoatlError, Result};
use uuid::Uuid;

use crate::discovery::CodingAgentKind;
use crate::drivers::{
    HarnessDriver, HarnessEvent, HarnessLaunchContext, HarnessLaunchPlan, HarnessRunOutcome,
    build_common_sandbox_env, inspect_git_workspace_diff, parse_ewave_check_tag,
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

    /// 将单行 ACP / JSON-RPC / stream-json 输出映射为标准 `HarnessEvent` 序列。
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
            "session_started" | "session/started" => vec![HarnessEvent::SessionStarted {
                session_id: payload
                    .get("session_id")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("acp-session")
                    .to_owned(),
                agent,
                pid: None,
            }],
            "turn_started" | "turn/started" => vec![HarnessEvent::TurnStarted {
                turn_id: payload
                    .get("turn_id")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("turn-1")
                    .to_owned(),
            }],
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
                let call_id = payload
                    .get("call_id")
                    .or_else(|| payload.get("id"))
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("call-0")
                    .to_owned();
                let tool_name = payload
                    .get("tool_name")
                    .or_else(|| payload.get("name"))
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("unknown")
                    .to_owned();
                let arguments_json = payload
                    .get("arguments")
                    .or_else(|| payload.get("input"))
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
            "turn_completed" | "turn/completed" | "result" => {
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
) -> Result<HarnessRunOutcome> {
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
    let mut events = vec![HarnessEvent::SessionStarted {
        session_id: Uuid::new_v4().to_string(),
        agent,
        pid,
    }];

    let mut accumulated_delta = String::new();
    let mut explicit_final_text: Option<String> = None;

    if let Some(stdout) = child.stdout.take() {
        let reader = BufReader::new(stdout);
        for line_res in reader.lines() {
            let line = line_res.map_err(|e| QuetzalcoatlError::StorageError {
                detail: format!("读取 Harness 标准输出流失败: {e}"),
            })?;
            for ev in AcpJsonRpcDriver::parse_stream_line(agent, &line) {
                match &ev {
                    HarnessEvent::Delta { text } => accumulated_delta.push_str(text),
                    HarnessEvent::TurnCompleted { final_text, .. } => {
                        explicit_final_text = Some(final_text.clone());
                    }
                    _ => {}
                }
                events.push(ev);
            }
        }
    }

    let status = child.wait().map_err(|e| QuetzalcoatlError::StorageError {
        detail: format!("等待 Harness 子进程结束失败: {e}"),
    })?;
    let exit_code = status.code().unwrap_or(1);

    let (changed_files, unified_diff) = inspect_git_workspace_diff(&plan.cwd);
    if !changed_files.is_empty() || !unified_diff.is_empty() {
        events.push(HarnessEvent::DiffProduced {
            workspace_dir: plan.cwd.clone(),
            changed_files: changed_files.clone(),
            unified_diff: unified_diff.clone(),
        });
    }

    let final_text = explicit_final_text.unwrap_or_else(|| accumulated_delta.trim().to_owned());
    if !events
        .iter()
        .any(|e| matches!(e, HarnessEvent::TurnCompleted { .. }))
    {
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
        run_plan_and_collect_events(self.kind, &plan)
    }
}
