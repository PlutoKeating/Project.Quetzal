//! 宿主钩子的客户端一侧（`qz hook` 与 `qz statusline`）。
//!
//! 纪律只有一条：**任何情况下都不挡宿主的路。** 运行态文件读不到、守护进程没起、超时、输入畸形——
//! 一律返回空输出，由调用方以成功码退出。宿主因此照常工作，只是这一次少了他。

use std::path::{Path, PathBuf};
use std::time::Duration;

use quetzalcoatl_harness::MANAGED_RUN_ENV;
use serde_json::Value;

use crate::host_sessions::{DEFAULT_AGENT_NAME, HostStatusLineView};
use crate::local_ipc::{IpcClient, IpcRequest, IpcResponse};

/// 钩子等守护进程答复的时限。宿主给钩子的时限更长，这里先一步放弃。
pub const HOOK_IPC_TIMEOUT: Duration = Duration::from_millis(1_500);

/// 目前支持的宿主标识。
pub const HOST_CLAUDE_CODE: &str = "claude-code";

/// 冰蓝：已接上、正常。
const ANSI_ICE: &str = "\x1b[38;2;186;230;253m";
/// 钨丝琥珀：需要人看一眼。
const ANSI_AMBER: &str = "\x1b[38;2;229;160;61m";
const ANSI_RESET: &str = "\x1b[0m";

/// 当前进程是否处在受管运行里（守护进程自己拉起的宿主）。受管运行不触发用户层挂载。
#[must_use]
pub fn is_managed_run() -> bool {
    std::env::var_os(MANAGED_RUN_ENV).is_some_and(|value| !value.is_empty())
}

fn text_field<'a>(event: &'a Value, key: &str) -> Option<&'a str> {
    event
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn request_for_event(host: &str, event: &Value) -> Option<IpcRequest> {
    let event_name = text_field(event, "hook_event_name")?;
    let session_id = String::from(text_field(event, "session_id")?);
    let cwd = text_field(event, "cwd").map(PathBuf::from);
    let host = String::from(host);
    match event_name {
        "SessionStart" => Some(IpcRequest::HostSessionStart {
            host,
            session_id,
            cwd,
            source: String::from(text_field(event, "source").unwrap_or("startup")),
        }),
        "UserPromptSubmit" => Some(IpcRequest::HostPromptSubmit {
            host,
            session_id,
            cwd,
            prompt: String::from(text_field(event, "prompt")?),
            transcript_path: text_field(event, "transcript_path").map(PathBuf::from),
        }),
        // 宿主即将执行我们的一个工具：登记它属于哪个会话。
        "PreToolUse" => {
            let tool = own_tool_name(text_field(event, "tool_name")?)?;
            Some(IpcRequest::HostToolTicket {
                host,
                session_id,
                tool: String::from(tool),
                arguments: event
                    .get("tool_input")
                    .cloned()
                    .unwrap_or_else(|| serde_json::json!({})),
            })
        }
        "Stop" => Some(IpcRequest::HostTurnEnd {
            host,
            session_id,
            transcript_path: text_field(event, "transcript_path").map(PathBuf::from),
        }),
        _ => None,
    }
}

/// 宿主给我们的工具起的名字形如 `mcp__plugin_quetzalcoatl_quetzalcoatl__recall`：取出最后一段。
fn own_tool_name(host_tool_name: &str) -> Option<&str> {
    let (server, tool) = host_tool_name.rsplit_once("__")?;
    (server.starts_with("mcp__") && server.contains("quetzalcoatl") && !tool.is_empty())
        .then_some(tool)
}

/// 只供宿主调用、不该由模型在命令行里调用的子命令。
const HOST_ONLY_SUBCOMMANDS: &[&str] = &["hook", "mcp", "statusline"];

/// 一条命令行是否在调用 `qz` 的宿主专用子命令。
///
/// 钩子和模型能执行的命令是同一个系统用户，模型可以自己调钩子冒充用户说话。
/// 这里只是第一道闸（挡住顺手而为的冒充）；真正的限制是：以本人名义的改动还要和对话记录核对，
/// 并且最高只能写到「关于我」这一层，底线只能在治理面里签。
#[must_use]
pub fn command_calls_host_only_entry(command: &str) -> bool {
    let cleaned: String = command
        .chars()
        .map(|c| match c {
            '\'' | '"' | '`' | '\\' | '(' | ')' | '{' | '}' | '$' => ' ',
            ';' | '|' | '&' | '\n' => '\u{1}',
            other => other,
        })
        .collect();
    cleaned.split('\u{1}').any(|segment| {
        let mut words = segment.split_whitespace().peekable();
        // 找到这一段真正执行的命令：跳过环境变量赋值与常见的包装命令。
        let command = loop {
            let Some(word) = words.next() else {
                return false;
            };
            let is_assignment = word
                .split_once('=')
                .is_some_and(|(name, _)| !name.is_empty() && !name.contains('/'));
            if is_assignment || word.starts_with('-') || SHELL_WRAPPERS.contains(&word) {
                continue;
            }
            break word;
        };
        let name = command.rsplit('/').next().unwrap_or(command);
        if name != "qz" && name != "qz.exe" {
            return false;
        }
        // `qz` 自己的全局参数里只有 `--home` 带一个值。
        while let Some(word) = words.next() {
            if word == "--home" {
                let _ = words.next();
            } else if !word.starts_with('-') {
                return HOST_ONLY_SUBCOMMANDS.contains(&word);
            }
        }
        false
    })
}

/// 常见的包装命令：它们后面跟着的才是真正执行的命令。
const SHELL_WRAPPERS: &[&str] = &[
    "sudo", "env", "exec", "command", "nohup", "time", "timeout", "xargs", "eval", "bash", "sh",
    "zsh", "dash",
];

/// 模型想在命令行里调用宿主专用子命令时，给宿主的拒绝答复；否则为空。
fn guard_shell_command(event: &Value) -> Option<String> {
    if text_field(event, "hook_event_name") != Some("PreToolUse")
        || text_field(event, "tool_name") != Some("Bash")
    {
        return None;
    }
    let command = event.get("tool_input")?.get("command")?.as_str()?;
    command_calls_host_only_entry(command).then(|| {
        serde_json::json!({
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason":
                    "这些是宿主自己调用的入口，不能在命令行里调用。要记住、纠正或忘掉什么，请用对应的工具，并由用户亲口说出来。",
            }
        })
        .to_string()
    })
}

fn render_hook_output(event: &Value, response: &IpcResponse) -> String {
    if let IpcResponse::HostTurnSummary { written } = response {
        if *written == 0 {
            return String::new();
        }
        // 回合结束时给用户看的一行回执。
        return serde_json::json!({
            "systemMessage": format!("记下了 {written} 条。说「记了什么」可以看到。"),
        })
        .to_string();
    }
    let IpcResponse::HostContext { context } = response else {
        return String::new();
    };
    if context.trim().is_empty() {
        return String::new();
    }
    let Some(event_name) = text_field(event, "hook_event_name") else {
        return String::new();
    };
    serde_json::json!({
        "hookSpecificOutput": {
            "hookEventName": event_name,
            "additionalContext": context,
        }
    })
    .to_string()
}

/// 处理一次钩子调用：读入宿主事件，返回要写到标准输出的内容（没有要带的就返回空串）。
///
/// 这个函数不会失败，也不会阻塞超过 [`HOOK_IPC_TIMEOUT`]。
#[must_use]
pub fn run_hook(qz_home: &Path, host: &str, stdin_json: &str) -> String {
    if is_managed_run() {
        return String::new();
    }
    let Ok(event) = serde_json::from_str::<Value>(stdin_json) else {
        return String::new();
    };
    // 这一道闸不依赖守护进程：守护进程停了也照样拦。
    if let Some(denial) = guard_shell_command(&event) {
        return denial;
    }
    let Some(request) = request_for_event(host, &event) else {
        return String::new();
    };
    let Some(client) = IpcClient::from_home_unprobed(qz_home) else {
        return String::new();
    };
    match client.with_timeout(HOOK_IPC_TIMEOUT).call(&request) {
        Ok(response) => render_hook_output(&event, &response),
        Err(_) => String::new(),
    }
}

fn paint(color: bool, ansi: &str, text: &str) -> String {
    if color {
        format!("{ansi}{text}{ANSI_RESET}")
    } else {
        String::from(text)
    }
}

/// 把状态栏数据写成一行。颜色只是语义的补充：每种状态都另有文字。
#[must_use]
pub fn format_status_line(view: Option<&HostStatusLineView>, color: bool) -> String {
    let Some(view) = view else {
        return format!(
            "{} {DEFAULT_AGENT_NAME} · 未连接",
            paint(color, ANSI_AMBER, "○")
        );
    };
    let needs_owner = view.pending_for_owner > 0;
    let dot = if needs_owner {
        paint(color, ANSI_AMBER, "●")
    } else {
        paint(color, ANSI_ICE, "●")
    };
    let mut line = format!("{dot} {} · 已接上", view.agent_name);
    if view.off_record {
        line.push_str(" · 无痕");
    } else if view.session_known {
        line.push_str(&format!(" · 带入 {}", view.recalled_last_turn));
    }
    if needs_owner {
        line.push_str(&format!(" · {} 件事等你", view.pending_for_owner));
    }
    if let Some(version) = &view.update {
        let note = if view.update_required {
            format!("需要升级到 {version} 才能同步")
        } else {
            format!("有新版 {version}")
        };
        line.push_str(&format!(" · {}", paint(color, ANSI_AMBER, &note)));
    }
    line
}

/// 状态栏命令：返回要显示的一行。受管运行里返回空串。
#[must_use]
pub fn run_status_line(qz_home: &Path, host: &str, stdin_json: &str, color: bool) -> String {
    if is_managed_run() {
        return String::new();
    }
    let session_id = serde_json::from_str::<Value>(stdin_json)
        .ok()
        .and_then(|event| text_field(&event, "session_id").map(String::from));
    let view = IpcClient::from_home_unprobed(qz_home).and_then(|client| {
        match client
            .with_timeout(HOOK_IPC_TIMEOUT)
            .call(&IpcRequest::HostStatusLine {
                host: String::from(host),
                session_id,
            }) {
            Ok(IpcResponse::HostStatusLine(view)) => Some(view),
            _ => None,
        }
    });
    format_status_line(view.as_ref(), color)
}

#[cfg(test)]
mod tests {
    use super::{
        command_calls_host_only_entry, format_status_line, own_tool_name, request_for_event,
        run_hook,
    };
    use crate::host_sessions::HostStatusLineView;
    use crate::local_ipc::IpcRequest;

    #[test]
    fn events_map_to_requests_and_unknown_or_incomplete_events_are_ignored() {
        let start = serde_json::json!({
            "hook_event_name": "SessionStart",
            "session_id": "s-1",
            "cwd": "/work/repo",
            "source": "compact"
        });
        assert!(matches!(
            request_for_event("claude-code", &start),
            Some(IpcRequest::HostSessionStart { ref source, .. }) if source == "compact"
        ));

        let prompt = serde_json::json!({
            "hook_event_name": "UserPromptSubmit",
            "session_id": "s-1",
            "prompt": "数据库迁移方案是什么"
        });
        assert!(matches!(
            request_for_event("claude-code", &prompt),
            Some(IpcRequest::HostPromptSubmit { ref prompt, .. }) if prompt == "数据库迁移方案是什么"
        ));

        let no_session = serde_json::json!({"hook_event_name": "UserPromptSubmit", "prompt": "x"});
        assert!(request_for_event("claude-code", &no_session).is_none());
        let empty_prompt = serde_json::json!({
            "hook_event_name": "UserPromptSubmit", "session_id": "s-1", "prompt": "   "
        });
        assert!(request_for_event("claude-code", &empty_prompt).is_none());
        let other = serde_json::json!({"hook_event_name": "PreToolUse", "session_id": "s-1"});
        assert!(request_for_event("claude-code", &other).is_none());
    }

    #[test]
    fn hook_stays_silent_when_the_daemon_is_not_there_or_input_is_garbage() {
        let home = std::env::temp_dir().join("quetzalcoatl-hook-no-daemon-home");
        assert_eq!(run_hook(&home, "claude-code", "{not json"), "");
        let event = serde_json::json!({
            "hook_event_name": "SessionStart", "session_id": "s-1"
        })
        .to_string();
        assert_eq!(run_hook(&home, "claude-code", &event), "");
    }

    #[test]
    fn status_line_always_says_its_state_in_words() {
        assert_eq!(format_status_line(None, false), "○ Quetzalcoatl · 未连接");
        let calm = HostStatusLineView {
            agent_name: String::from("栗子"),
            session_known: true,
            recalled_last_turn: 3,
            pending_for_owner: 0,
            off_record: false,
            update: None,
            update_required: false,
        };
        assert_eq!(
            format_status_line(Some(&calm), false),
            "● 栗子 · 已接上 · 带入 3"
        );
        let waiting = HostStatusLineView {
            pending_for_owner: 2,
            session_known: false,
            ..calm
        };
        assert_eq!(
            format_status_line(Some(&waiting), false),
            "● 栗子 · 已接上 · 2 件事等你"
        );
        assert!(format_status_line(Some(&waiting), true).contains("\x1b[38;2;229;160;61m"));
        let private = HostStatusLineView {
            off_record: true,
            session_known: true,
            pending_for_owner: 0,
            ..waiting
        };
        assert_eq!(
            format_status_line(Some(&private), false),
            "● 栗子 · 已接上 · 无痕"
        );
        let behind = HostStatusLineView {
            off_record: false,
            update: Some(String::from("2.0.0")),
            ..private.clone()
        };
        assert_eq!(
            format_status_line(Some(&behind), false),
            "● 栗子 · 已接上 · 带入 3 · 有新版 2.0.0"
        );
        let blocked = HostStatusLineView {
            update_required: true,
            ..behind
        };
        assert!(format_status_line(Some(&blocked), false).ends_with("需要升级到 2.0.0 才能同步"));
    }

    #[test]
    fn the_model_cannot_call_host_only_entries_from_the_shell() {
        for blocked in [
            "qz hook --host claude-code",
            "echo '{}' | /home/u/.local/bin/qz hook --host claude-code",
            "cd /tmp && qz mcp",
            "FOO=1 qz --home /tmp/x statusline",
            "bash -c \"qz hook --host claude-code\"",
        ] {
            assert!(
                command_calls_host_only_entry(blocked),
                "应当拦下：{blocked}"
            );
        }
        for allowed in [
            "qz status",
            "qz doctor",
            "cargo test -p quetzalcoatl-daemon",
            "grep -rn 'qz hook' docs/",
            "git commit -m 'hook: fix'",
        ] {
            assert!(!command_calls_host_only_entry(allowed), "不该拦：{allowed}");
        }
        let event = serde_json::json!({
            "hook_event_name": "PreToolUse",
            "session_id": "s-1",
            "tool_name": "Bash",
            "tool_input": {"command": "echo x | qz hook --host claude-code"},
        })
        .to_string();
        let home = std::env::temp_dir().join("quetzalcoatl-hook-no-daemon-home");
        let out = run_hook(&home, "claude-code", &event);
        assert!(
            out.contains("\"permissionDecision\":\"deny\""),
            "守护进程不在时这道闸也要生效：{out}"
        );
    }

    #[test]
    fn our_own_tools_are_recognised_by_their_host_side_name() {
        assert_eq!(
            own_tool_name("mcp__plugin_quetzalcoatl_quetzalcoatl__remember"),
            Some("remember")
        );
        assert_eq!(own_tool_name("mcp__quetzalcoatl__recall"), Some("recall"));
        assert_eq!(own_tool_name("mcp__github__create_issue"), None);
        assert_eq!(own_tool_name("Bash"), None);
    }
}
