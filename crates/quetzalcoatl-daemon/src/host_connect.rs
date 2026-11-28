//! 接上宿主（`qz connect`）与按宿主诊断（`qz doctor`）。
//!
//! 接上 = 把钩子、工具通道与状态栏装进用户自己的宿主，让用户照常启动宿主就能用。
//! 三条纪律：
//! - **先备份、可重复、可撤销。** 重复执行不会重复写；撤销后宿主里不留我们的任何东西。
//! - **走宿主自己的安装通道。** 插件由宿主的插件命令装入，我们不手写宿主的插件登记文件。
//! - **不抢用户的东西。** 用户已经有自己的状态栏时不覆盖。

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use quetzalcoatl_types::{QuetzalcoatlError, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::host_hook::{HOST_CLAUDE_CODE, run_hook};
use crate::local_ipc::{IpcClient, IpcRequest, IpcResponse};

/// 本地插件源在 Claude Code 里登记的名字。
pub const CLAUDE_MARKETPLACE: &str = "quetzalcoatl-local";
/// 插件在 Claude Code 里的完整标识。
pub const CLAUDE_PLUGIN_ID: &str = "quetzalcoatl@quetzalcoatl-local";

const TPL_MARKETPLACE: &str = include_str!(
    "../../../packages/harness-enhancers/claude-code-plugin/.claude-plugin/marketplace.json"
);
const TPL_PLUGIN: &str = include_str!(
    "../../../packages/harness-enhancers/claude-code-plugin/plugin/.claude-plugin/plugin.json"
);
const TPL_HOOKS: &str =
    include_str!("../../../packages/harness-enhancers/claude-code-plugin/plugin/hooks/hooks.json");
const TPL_MCP: &str =
    include_str!("../../../packages/harness-enhancers/claude-code-plugin/plugin/.mcp.json");

/// 插件里的斜杠命令：文件名与内容。命令集是显式写死的。
const TPL_COMMANDS: &[(&str, &str)] = &[
    (
        "correct.md",
        include_str!(
            "../../../packages/harness-enhancers/claude-code-plugin/plugin/commands/correct.md"
        ),
    ),
    (
        "delegate.md",
        include_str!(
            "../../../packages/harness-enhancers/claude-code-plugin/plugin/commands/delegate.md"
        ),
    ),
    (
        "delegate-status.md",
        include_str!(
            "../../../packages/harness-enhancers/claude-code-plugin/plugin/commands/delegate-status.md"
        ),
    ),
    (
        "forget.md",
        include_str!(
            "../../../packages/harness-enhancers/claude-code-plugin/plugin/commands/forget.md"
        ),
    ),
    (
        "hush.md",
        include_str!(
            "../../../packages/harness-enhancers/claude-code-plugin/plugin/commands/hush.md"
        ),
    ),
    (
        "learned.md",
        include_str!(
            "../../../packages/harness-enhancers/claude-code-plugin/plugin/commands/learned.md"
        ),
    ),
    (
        "off-record.md",
        include_str!(
            "../../../packages/harness-enhancers/claude-code-plugin/plugin/commands/off-record.md"
        ),
    ),
    (
        "on-record.md",
        include_str!(
            "../../../packages/harness-enhancers/claude-code-plugin/plugin/commands/on-record.md"
        ),
    ),
    (
        "remember.md",
        include_str!(
            "../../../packages/harness-enhancers/claude-code-plugin/plugin/commands/remember.md"
        ),
    ),
    (
        "why.md",
        include_str!(
            "../../../packages/harness-enhancers/claude-code-plugin/plugin/commands/why.md"
        ),
    ),
];

/// 调用宿主命令行的时限。
const HOST_CLI_DEADLINE: Duration = Duration::from_secs(90);

/// 接上 Claude Code 所需的全部位置。
#[derive(Clone, Debug)]
pub struct ClaudeCodeTarget {
    pub qz_home: PathBuf,
    /// 钩子、工具通道与状态栏要调用的 `qz` 可执行文件（绝对路径）。
    pub qz_bin: PathBuf,
    /// Claude Code 的可执行文件。
    pub claude_bin: PathBuf,
    /// Claude Code 的用户配置目录（`CLAUDE_CONFIG_DIR` 或 `~/.claude`）。
    pub claude_config_dir: PathBuf,
}

/// 状态栏这一步的结果。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum StatusLineOutcome {
    /// 用户没有状态栏，已写入我们的。
    Written,
    /// 已经是我们的，没有改动。
    AlreadyOurs,
    /// 用户有自己的状态栏，没有覆盖。
    KeptUserOwn,
    /// 设置文件不是可识别的对象，没有改动。
    SettingsUntouched,
}

/// 接上之后留下的记录，撤销时照它还原。
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct ConnectRecord {
    qz_bin: String,
    /// 插入到宿主设置文件里的原文。撤销时删掉完全相同的这一段，设置文件就逐字节还原。
    status_line_inserted: Option<String>,
}

/// 接上的结果。
#[derive(Clone, Debug)]
pub struct ConnectReport {
    pub plugin_source_dir: PathBuf,
    pub status_line: StatusLineOutcome,
}

impl ClaudeCodeTarget {
    fn host_dir(&self) -> PathBuf {
        self.qz_home.join("hosts").join(HOST_CLAUDE_CODE)
    }

    /// 本地插件源目录（由接上命令写出，由宿主就地读取）。
    #[must_use]
    pub fn plugin_source_dir(&self) -> PathBuf {
        self.host_dir().join("marketplace")
    }

    fn record_path(&self) -> PathBuf {
        self.host_dir().join("connect.json")
    }

    fn settings_path(&self) -> PathBuf {
        self.claude_config_dir.join("settings.json")
    }

    fn status_line_command(&self) -> String {
        format!(
            "{} statusline --host {HOST_CLAUDE_CODE}",
            shell_quote(&self.qz_bin)
        )
    }
}

pub(crate) fn storage_error(detail: String) -> QuetzalcoatlError {
    QuetzalcoatlError::StorageError { detail }
}

/// 按 POSIX shell 规则给路径加单引号。
pub(crate) fn shell_quote(path: &Path) -> String {
    format!("'{}'", path.to_string_lossy().replace('\'', r"'\''"))
}

/// 把一段文字写成 JSON 字符串字面量的内部（不含两端的引号），用来填进模板里已有的引号之间。
pub(crate) fn json_string_inner(text: &str) -> String {
    let quoted = Value::String(String::from(text)).to_string();
    quoted[1..quoted.len() - 1].to_owned()
}

pub(crate) fn write_private(path: &Path, content: &str) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| storage_error(format!("创建目录失败 ({}): {e}", parent.display())))?;
    }
    fs::write(path, content)
        .map_err(|e| storage_error(format!("写入文件失败 ({}): {e}", path.display())))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

/// 把内嵌的插件模板写成本地插件源。
fn write_plugin_source(target: &ClaudeCodeTarget) -> Result<()> {
    let root = target.plugin_source_dir();
    let quoted_bin = json_string_inner(&shell_quote(&target.qz_bin));
    let raw_bin = json_string_inner(&target.qz_bin.to_string_lossy());
    let fill = |template: &str| {
        template
            .replace("{{QZ_BIN_RAW}}", &raw_bin)
            .replace("{{QZ_BIN}}", &quoted_bin)
            .replace("{{QZ_VERSION}}", env!("CARGO_PKG_VERSION"))
    };
    write_private(
        &root.join(".claude-plugin/marketplace.json"),
        &fill(TPL_MARKETPLACE),
    )?;
    write_private(
        &root.join("plugin/.claude-plugin/plugin.json"),
        &fill(TPL_PLUGIN),
    )?;
    write_private(&root.join("plugin/hooks/hooks.json"), &fill(TPL_HOOKS))?;
    write_private(&root.join("plugin/.mcp.json"), &fill(TPL_MCP))?;
    for (file_name, body) in TPL_COMMANDS {
        write_private(&root.join("plugin/commands").join(file_name), body)?;
    }
    Ok(())
}

/// 调用宿主命令行并等它结束；超时即杀掉。返回标准输出。
pub(crate) fn run_host_cli(program: &Path, args: &[&str]) -> Result<String> {
    let mut child = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| storage_error(format!("无法启动 {}: {e}", program.display())))?;
    let deadline = Instant::now() + HOST_CLI_DEADLINE;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(storage_error(format!(
                        "{} {} 超时未返回",
                        program.display(),
                        args.join(" ")
                    )));
                }
                std::thread::sleep(Duration::from_millis(40));
            }
            Err(e) => return Err(storage_error(format!("等待宿主命令失败: {e}"))),
        }
    };
    let mut stdout = String::new();
    if let Some(mut pipe) = child.stdout.take() {
        let _ = pipe.read_to_string(&mut stdout);
    }
    let mut stderr = String::new();
    if let Some(mut pipe) = child.stderr.take() {
        let _ = pipe.read_to_string(&mut stderr);
    }
    if status.success() {
        Ok(stdout)
    } else {
        Err(storage_error(format!(
            "{} {} 失败: {}",
            program.display(),
            args.join(" "),
            if stderr.trim().is_empty() {
                stdout.trim()
            } else {
                stderr.trim()
            }
        )))
    }
}

/// 宿主命令带 `--json` 时最后一行是结果；`outcome` 不是 `ok` 就算失败。
fn expect_ok_outcome(stdout: &str, what: &str) -> Result<()> {
    let outcome = stdout
        .lines()
        .rev()
        .find_map(|line| serde_json::from_str::<Value>(line.trim()).ok())
        .and_then(|value| {
            value
                .get("outcome")
                .and_then(Value::as_str)
                .map(str::to_owned)
        });
    match outcome.as_deref() {
        Some("ok") | None => Ok(()),
        Some(other) => Err(storage_error(format!("{what} 没有成功（{other}）"))),
    }
}

fn status_line_value(settings: &Value) -> Option<&Value> {
    settings.as_object().and_then(|map| map.get("statusLine"))
}

fn is_our_status_line(settings: &Value, command: &str) -> bool {
    status_line_value(settings)
        .and_then(|value| value.get("command"))
        .and_then(Value::as_str)
        == Some(command)
}

/// 在设置文件里补上状态栏。只做最小的文本插入，不重排用户原有的内容。
fn install_status_line(
    target: &ClaudeCodeTarget,
    record: &mut ConnectRecord,
) -> Result<StatusLineOutcome> {
    let path = target.settings_path();
    let original = match fs::read_to_string(&path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => {
            return Err(storage_error(format!(
                "读取宿主设置失败 ({}): {e}",
                path.display()
            )));
        }
    };
    let command = target.status_line_command();
    let parsed: Value = if original.trim().is_empty() {
        Value::Object(serde_json::Map::new())
    } else {
        match serde_json::from_str(&original) {
            Ok(value) => value,
            Err(_) => return Ok(StatusLineOutcome::SettingsUntouched),
        }
    };
    let Some(map) = parsed.as_object() else {
        return Ok(StatusLineOutcome::SettingsUntouched);
    };
    if is_our_status_line(&parsed, &command) {
        return Ok(StatusLineOutcome::AlreadyOurs);
    }
    if map.contains_key("statusLine") {
        return Ok(StatusLineOutcome::KeptUserOwn);
    }

    let entry = format!(
        "\"statusLine\": {{\"type\": \"command\", \"command\": {}}}",
        Value::String(command)
    );
    let (updated, inserted) = if original.trim().is_empty() {
        (format!("{{\n  {entry}\n}}\n"), None)
    } else {
        let Some(open) = original.find('{') else {
            return Ok(StatusLineOutcome::SettingsUntouched);
        };
        let inserted = if map.is_empty() {
            format!("\n  {entry}\n")
        } else {
            format!("\n  {entry},")
        };
        let mut updated = String::with_capacity(original.len() + inserted.len());
        updated.push_str(&original[..=open]);
        updated.push_str(&inserted);
        updated.push_str(&original[open + 1..]);
        (updated, Some(inserted))
    };
    // 写之前确认结果仍是合法设置，并且确实带上了我们的状态栏；否则宁可不动。
    match serde_json::from_str::<Value>(&updated) {
        Ok(check) if is_our_status_line(&check, &target.status_line_command()) => {}
        _ => return Ok(StatusLineOutcome::SettingsUntouched),
    }
    if !original.is_empty() {
        write_private(&target.host_dir().join("settings.backup.json"), &original)?;
    }
    fs::write(&path, &updated)
        .map_err(|e| storage_error(format!("写入宿主设置失败 ({}): {e}", path.display())))?;
    record.status_line_inserted = inserted;
    Ok(StatusLineOutcome::Written)
}

/// 把状态栏从设置文件里拿掉。有插入记录时按原文删除（逐字节还原），否则只在确认是我们的才动。
fn remove_status_line(target: &ClaudeCodeTarget, record: &ConnectRecord) -> Result<()> {
    let path = target.settings_path();
    let Ok(current) = fs::read_to_string(&path) else {
        return Ok(());
    };
    let Ok(parsed) = serde_json::from_str::<Value>(&current) else {
        return Ok(());
    };
    if !is_our_status_line(&parsed, &target.status_line_command()) {
        return Ok(());
    }
    let restored = match &record.status_line_inserted {
        Some(inserted) if current.contains(inserted.as_str()) => {
            current.replacen(inserted.as_str(), "", 1)
        }
        _ => {
            // 没有可用的插入记录（设置文件原本不存在，或之后被别人改过格式）：去掉这一个键后重写。
            let mut map = parsed.as_object().cloned().unwrap_or_default();
            map.remove("statusLine");
            if map.is_empty() && record.status_line_inserted.is_none() {
                let _ = fs::remove_file(&path);
                return Ok(());
            }
            let mut text = serde_json::to_string_pretty(&Value::Object(map))
                .map_err(|e| storage_error(format!("序列化宿主设置失败: {e}")))?;
            text.push('\n');
            text
        }
    };
    fs::write(&path, restored)
        .map_err(|e| storage_error(format!("写入宿主设置失败 ({}): {e}", path.display())))
}

fn load_record(target: &ClaudeCodeTarget) -> ConnectRecord {
    fs::read(target.record_path())
        .ok()
        .and_then(|raw| serde_json::from_slice(&raw).ok())
        .unwrap_or_default()
}

/// 把 `qz` 接进 Claude Code。可以重复执行。
pub fn connect_claude_code(target: &ClaudeCodeTarget) -> Result<ConnectReport> {
    write_plugin_source(target)?;
    let source = target.plugin_source_dir();
    let source_arg = source.to_string_lossy().into_owned();
    let claude = target.claude_bin.as_path();

    let added = run_host_cli(
        claude,
        &["plugin", "marketplace", "add", &source_arg, "--json"],
    )?;
    expect_ok_outcome(&added, "登记本地插件源")?;
    let installed = run_host_cli(claude, &["plugin", "install", CLAUDE_PLUGIN_ID, "--json"])?;
    expect_ok_outcome(&installed, "安装插件")?;
    // 版本升级后让宿主重新读一次插件源；首次安装时这两步是空操作。
    let _ = run_host_cli(
        claude,
        &[
            "plugin",
            "marketplace",
            "update",
            CLAUDE_MARKETPLACE,
            "--json",
        ],
    );
    let _ = run_host_cli(claude, &["plugin", "update", CLAUDE_PLUGIN_ID, "--json"]);

    let mut record = load_record(target);
    record.qz_bin = target.qz_bin.to_string_lossy().into_owned();
    let status_line = install_status_line(target, &mut record)?;
    let encoded = serde_json::to_string_pretty(&record)
        .map_err(|e| storage_error(format!("序列化接入记录失败: {e}")))?;
    write_private(&target.record_path(), &encoded)?;

    Ok(ConnectReport {
        plugin_source_dir: source,
        status_line,
    })
}

/// 撤销接入：卸载插件、移除本地插件源、拿掉我们写的状态栏、删掉本地记录。
pub fn disconnect_claude_code(target: &ClaudeCodeTarget) -> Result<()> {
    let claude = target.claude_bin.as_path();
    // 没装过时这两步会报「不存在」，不算失败。
    let _ = run_host_cli(claude, &["plugin", "uninstall", CLAUDE_PLUGIN_ID, "--json"]);
    let _ = run_host_cli(
        claude,
        &[
            "plugin",
            "marketplace",
            "remove",
            CLAUDE_MARKETPLACE,
            "--json",
        ],
    );
    let record = load_record(target);
    remove_status_line(target, &record)?;
    let host_dir = target.host_dir();
    if host_dir.exists() {
        fs::remove_dir_all(&host_dir).map_err(|e| {
            storage_error(format!("删除接入目录失败 ({}): {e}", host_dir.display()))
        })?;
    }
    Ok(())
}

/// 诊断里的一行。
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct DoctorLine {
    pub ok: bool,
    pub label: String,
    pub detail: String,
}

pub(crate) fn doctor_line(ok: bool, label: &str, detail: impl Into<String>) -> DoctorLine {
    DoctorLine {
        ok,
        label: String::from(label),
        detail: detail.into(),
    }
}

fn hooks_registered(target: &ClaudeCodeTarget, event: &str) -> bool {
    fs::read(target.plugin_source_dir().join("plugin/hooks/hooks.json"))
        .ok()
        .and_then(|raw| serde_json::from_slice::<Value>(&raw).ok())
        .and_then(|value| {
            value
                .get("hooks")
                .and_then(|hooks| hooks.get(event))
                .and_then(Value::as_array)
                .map(|entries| !entries.is_empty())
        })
        .unwrap_or(false)
}

/// 只看本地文件得到的接入状态：治理面每次打开都会读，不能去调宿主的命令行。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct ClaudeCodeLocalState {
    pub installed: bool,
    pub connected: bool,
    pub session_start: bool,
    pub prompt_submit: bool,
    pub stop: bool,
}

pub(crate) fn claude_code_local_state(qz_home: &Path) -> ClaudeCodeLocalState {
    host_local_state(
        qz_home,
        HOST_CLAUDE_CODE,
        "marketplace/plugin/hooks/hooks.json",
        "claude",
    )
}

/// 某个宿主只看本地文件得到的接入状态：插件源里的钩子表、接入记录、命令行在不在 PATH 上。
pub(crate) fn host_local_state(
    qz_home: &Path,
    host: &str,
    hooks_rel: &str,
    binary: &str,
) -> ClaudeCodeLocalState {
    let host_dir = qz_home.join("hosts").join(host);
    let hooks: Option<Value> = fs::read(host_dir.join(hooks_rel))
        .ok()
        .and_then(|raw| serde_json::from_slice(&raw).ok());
    let registered = |event: &str| {
        hooks
            .as_ref()
            .and_then(|h| h.get("hooks"))
            .and_then(|h| h.get(event))
            .and_then(Value::as_array)
            .is_some_and(|entries| !entries.is_empty())
    };
    let on_path = std::env::var_os("PATH")
        .is_some_and(|paths| std::env::split_paths(&paths).any(|dir| dir.join(binary).is_file()));
    let connected = host_dir.join("connect.json").is_file();
    ClaudeCodeLocalState {
        installed: on_path || connected,
        connected,
        session_start: registered("SessionStart"),
        prompt_submit: registered("UserPromptSubmit"),
        stop: registered("Stop"),
    }
}

fn plugin_enabled_in_host(target: &ClaudeCodeTarget) -> Option<bool> {
    let stdout = run_host_cli(&target.claude_bin, &["plugin", "list", "--json"]).ok()?;
    let listed: Value = serde_json::from_str(stdout.trim()).ok()?;
    let entry = listed
        .as_array()?
        .iter()
        .find(|item| item.get("id").and_then(Value::as_str) == Some(CLAUDE_PLUGIN_ID))?;
    Some(
        entry
            .get("enabled")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    )
}

/// 按宿主做一次体检：守护进程、插件，以及四项——送核心、送往事、收信号、压缩后不丢。
///
/// `target` 为 `None` 表示本机没有找到 Claude Code。
#[must_use]
pub fn doctor_claude_code(qz_home: &Path, target: Option<&ClaudeCodeTarget>) -> Vec<DoctorLine> {
    let mut lines = Vec::new();

    let daemon_up = IpcClient::from_home_unprobed(qz_home)
        .map(|client| client.with_timeout(Duration::from_secs(2)))
        .is_some_and(|client| {
            matches!(client.call(&IpcRequest::Status), Ok(IpcResponse::Status(_)))
        });
    lines.push(if daemon_up {
        doctor_line(true, "守护进程", "在运行")
    } else {
        doctor_line(false, "守护进程", "没有在运行。执行 `qz up`")
    });

    let Some(target) = target else {
        lines.push(doctor_line(
            false,
            "Claude Code",
            "本机没有找到。装好并登录后再执行 `qz connect`",
        ));
        return lines;
    };
    lines.push(doctor_line(
        true,
        "Claude Code",
        target.claude_bin.to_string_lossy(),
    ));

    let source_ready = target
        .plugin_source_dir()
        .join("plugin/.claude-plugin/plugin.json")
        .is_file();
    let enabled = plugin_enabled_in_host(target);
    lines.push(match (source_ready, enabled) {
        (true, Some(true)) => doctor_line(true, "插件", "已装入并启用"),
        (true, Some(false)) => doctor_line(
            false,
            "插件",
            "已装入但被停用。在宿主里启用它，或重新执行 `qz connect`",
        ),
        _ => doctor_line(false, "插件", "还没有接上。执行 `qz connect`"),
    });

    let core_sent = hooks_registered(target, "SessionStart") && daemon_up && {
        let probe = serde_json::json!({
            "hook_event_name": "SessionStart",
            "session_id": "qz-doctor",
            "source": "startup",
        })
        .to_string();
        !run_hook(qz_home, HOST_CLAUDE_CODE, &probe).is_empty()
    };
    lines.push(if core_sent {
        doctor_line(true, "送核心", "会话开始时会带入他的核心")
    } else {
        doctor_line(
            false,
            "送核心",
            "这一步走不通：先看上面的守护进程与插件两行",
        )
    });

    let recall_path = hooks_registered(target, "UserPromptSubmit")
        && IpcClient::from_home_unprobed(qz_home)
            .map(|client| client.with_timeout(Duration::from_secs(2)))
            .is_some_and(|client| {
                matches!(
                    client.call(&IpcRequest::HostPromptSubmit {
                        host: String::from(HOST_CLAUDE_CODE),
                        session_id: String::from(crate::host_sessions::PROBE_SESSION_ID),
                        cwd: None,
                        prompt: String::from("qz doctor 通路自检"),
                        transcript_path: None,
                    }),
                    Ok(IpcResponse::HostContext { .. })
                )
            });
    lines.push(if recall_path {
        doctor_line(true, "送往事", "每次提交前会带上相关往事")
    } else {
        doctor_line(
            false,
            "送往事",
            "这一步走不通：先看上面的守护进程与插件两行",
        )
    });

    lines.push(if hooks_registered(target, "Stop") {
        doctor_line(true, "收信号", "回合结束时会向守护进程登记")
    } else {
        doctor_line(
            false,
            "收信号",
            "回合结束的钩子没有登记。重新执行 `qz connect`",
        )
    });
    lines.push(if hooks_registered(target, "SessionStart") {
        doctor_line(true, "压缩后不丢", "宿主压缩对话后会重新带入核心")
    } else {
        doctor_line(
            false,
            "压缩后不丢",
            "会话开始的钩子没有登记。重新执行 `qz connect`",
        )
    });
    lines
}

#[cfg(test)]
mod tests {
    use super::{json_string_inner, shell_quote};
    use std::path::Path;

    #[test]
    fn paths_with_spaces_and_quotes_survive_shell_and_json_quoting() {
        let path = Path::new("/home/someone/My Tools/it's/qz");
        let quoted = shell_quote(path);
        assert_eq!(quoted, r"'/home/someone/My Tools/it'\''s/qz'");
        let inner = json_string_inner(&quoted);
        let decoded: serde_json::Value =
            serde_json::from_str(&format!("\"{inner}\"")).unwrap_or(serde_json::Value::Null);
        assert_eq!(decoded.as_str(), Some(quoted.as_str()));
    }
}
