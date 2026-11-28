#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]

//! 接上 Claude Code 的端到端验收。
//!
//! 这里不启动真的 Claude Code，而是用一个「假宿主」按真宿主的方式行事：
//! 读插件的钩子表，取出登记的命令，用 `sh -c` 执行，把事件写进标准输入，读标准输出。
//! 插件由真的 `qz connect` 写出；插件命令行由一个只认得插件子命令的假 `claude` 应答。
//!
//! 验收的是用户能感到的五件事：开场带入核心、提交带上相关往事、压缩后重贴、
//! 我们停机时宿主照常、受管运行里钩子不触发。

mod common;

use std::error::Error;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant};

use quetzalcoatl_daemon::{DaemonConfig, IpcClient, IpcRequest, IpcResponse, QuetzalcoatlDaemon};
use serde_json::{Value, json};

type TestResult = Result<(), Box<dyn Error>>;

struct TempGuard(PathBuf);

impl Drop for TempGuard {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn qz() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_qz"))
}

fn fixture_soul() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../quetzalcoatl-spine/tests/fixtures/v1_soul_v14")
}

/// 一个只认得插件子命令的假 `claude`：把每次调用记进日志，回一行宿主格式的成功结果。
fn write_fake_claude(dir: &Path) -> std::io::Result<PathBuf> {
    let path = dir.join("claude");
    let log = dir.join("claude-calls.log");
    let script = format!(
        "#!/bin/sh\n\
         if [ \"$1\" = \"--version\" ]; then echo '2.1.332 (Claude Code)'; exit 0; fi\n\
         echo \"$*\" >> '{log}'\n\
         case \"$1 $2\" in\n\
           'plugin list') echo '[{{\"id\":\"quetzalcoatl@quetzalcoatl-local\",\"enabled\":true}}]' ;;\n\
           *) echo '{{\"outcome\":\"ok\"}}' ;;\n\
         esac\n",
        log = log.display()
    );
    fs::write(&path, script)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755))?;
    }
    Ok(path)
}

struct Rig {
    _guard: TempGuard,
    root: PathBuf,
    qz_home: PathBuf,
    claude_config: PathBuf,
    fake_claude_dir: PathBuf,
}

impl Rig {
    fn new(tag: &str) -> Result<Self, Box<dyn Error>> {
        let root = common::temp_root(tag)?;
        let qz_home = root.join("h");
        let claude_config = root.join("cc");
        let fake_claude_dir = root.join("bin");
        fs::create_dir_all(&claude_config)?;
        fs::create_dir_all(&fake_claude_dir)?;
        write_fake_claude(&fake_claude_dir)?;
        Ok(Self {
            _guard: TempGuard(root.clone()),
            root,
            qz_home,
            claude_config,
            fake_claude_dir,
        })
    }

    /// 以用户的方式跑一次 `qz`：`PATH` 里只有假 `claude`，宿主配置目录指向测试目录。
    fn qz(
        &self,
        args: &[&str],
        stdin: Option<&str>,
        extra_env: &[(&str, &str)],
    ) -> std::io::Result<Output> {
        let path_env = format!(
            "{}:{}",
            self.fake_claude_dir.display(),
            std::env::var("PATH").unwrap_or_default()
        );
        let mut cmd = Command::new(qz());
        cmd.args(args)
            .env("QUETZALCOATL_HOME", &self.qz_home)
            .env("HOME", &self.root)
            .env("CLAUDE_CONFIG_DIR", &self.claude_config)
            .env("PATH", path_env)
            .env("NO_COLOR", "1")
            .env_remove("QUETZALCOATL_MANAGED_RUN")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        for (key, value) in extra_env {
            cmd.env(key, value);
        }
        let mut child = cmd.spawn()?;
        if let Some(mut pipe) = child.stdin.take()
            && let Some(text) = stdin
        {
            pipe.write_all(text.as_bytes())?;
        }
        child.wait_with_output()
    }

    fn plugin_dir(&self) -> PathBuf {
        self.qz_home.join("hosts/claude-code/marketplace/plugin")
    }

    /// 假宿主触发一个事件：从插件的钩子表里取出登记的命令，按宿主的方式执行。
    fn fire(
        &self,
        event: &str,
        payload: &Value,
        extra_env: &[(&str, &str)],
    ) -> Result<Output, Box<dyn Error>> {
        let hooks: Value =
            serde_json::from_slice(&fs::read(self.plugin_dir().join("hooks/hooks.json"))?)?;
        let command = hooks["hooks"][event][0]["hooks"][0]["command"]
            .as_str()
            .ok_or_else(|| format!("插件没有登记 {event} 钩子"))?
            .to_owned();
        let mut cmd = Command::new("/bin/sh");
        cmd.arg("-c")
            .arg(&command)
            .env("QUETZALCOATL_HOME", &self.qz_home)
            .env("HOME", &self.root)
            .env_remove("QUETZALCOATL_MANAGED_RUN")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        for (key, value) in extra_env {
            cmd.env(key, value);
        }
        let mut child = cmd.spawn()?;
        if let Some(mut pipe) = child.stdin.take() {
            pipe.write_all(payload.to_string().as_bytes())?;
        }
        Ok(child.wait_with_output()?)
    }
}

fn injected_context(output: &Output) -> Result<String, Box<dyn Error>> {
    let stdout = String::from_utf8_lossy(&output.stdout);
    if stdout.trim().is_empty() {
        return Ok(String::new());
    }
    let parsed: Value = serde_json::from_str(stdout.trim())?;
    Ok(parsed["hookSpecificOutput"]["additionalContext"]
        .as_str()
        .unwrap_or_default()
        .to_owned())
}

fn start_daemon_with_fixture(
    rig: &Rig,
) -> Result<quetzalcoatl_daemon::DaemonHandle, Box<dyn Error>> {
    let daemon = QuetzalcoatlDaemon::start(DaemonConfig::new(rig.qz_home.clone()))?;
    let client = IpcClient::from_runtime_info(daemon.runtime_info(), daemon.ipc_token().to_owned());
    match client.call(&IpcRequest::ImportV1 {
        soul_dir: fixture_soul(),
        db_paths: Vec::new(),
    })? {
        IpcResponse::ImportV1(report) => {
            assert!(
                report.memories_imported >= 5,
                "夹具里的记忆应当导入: {report:?}"
            );
        }
        other => return Err(format!("导入夹具失败: {other:?}").into()),
    }
    Ok(daemon)
}

#[test]
fn a_claude_code_session_gets_his_core_then_relevant_memories_and_survives_compaction() -> TestResult
{
    let rig = Rig::new("attach")?;
    let mut daemon = start_daemon_with_fixture(&rig)?;

    let connect = rig.qz(&["connect"], None, &[])?;
    assert!(
        connect.status.success(),
        "qz connect 失败: {}",
        String::from_utf8_lossy(&connect.stderr)
    );

    // 插件里登记的是 qz 的绝对路径，并且没有任何令牌。
    let hooks_raw = fs::read_to_string(rig.plugin_dir().join("hooks/hooks.json"))?;
    assert!(
        hooks_raw.contains(&qz().to_string_lossy().into_owned()),
        "钩子表里应当是 qz 的绝对路径: {hooks_raw}"
    );
    let token = daemon.ipc_token().to_owned();
    for file in [
        "hooks/hooks.json",
        ".mcp.json",
        ".claude-plugin/plugin.json",
    ] {
        let text = fs::read_to_string(rig.plugin_dir().join(file))?;
        assert!(!text.contains(&token), "{file} 里不得出现守护进程令牌");
        assert!(!text.contains("{{"), "{file} 里的模板占位符必须全部替换");
    }

    // 开场：带入他的核心。
    let start = rig.fire(
        "SessionStart",
        &json!({"hook_event_name": "SessionStart", "session_id": "s-1", "cwd": "/work/repo", "source": "startup"}),
        &[],
    )?;
    assert!(start.status.success());
    let core = injected_context(&start)?;
    assert!(core.contains("<ewave_pinned>"), "开场应带入核心: {core}");
    assert!(core.contains("青羽"), "他的名字来自带进来的灵魂: {core}");
    assert!(
        core.contains("诚实、审慎与好奇心"),
        "自述应在核心里: {core}"
    );
    assert!(
        !core.contains("ewave_check"),
        "用户会话里不得要求可见标签: {core}"
    );
    assert!(
        !core.contains("委派"),
        "旧种子里的工程条款不得进用户会话: {core}"
    );

    // 提交：一句自然的提问带上相关往事。
    let ask = rig.fire(
        "UserPromptSubmit",
        &json!({"hook_event_name": "UserPromptSubmit", "session_id": "s-1", "cwd": "/work/repo",
                "prompt": "整理长期笔记的时候，目录应该怎么组织来着？"}),
        &[],
    )?;
    assert!(ask.status.success());
    let recalled = injected_context(&ask)?;
    assert!(
        recalled.contains("按分类目录树组织"),
        "应带上那条关于整理笔记的往事: {recalled}"
    );
    assert!(
        !recalled.contains("静音勿扰"),
        "不相关的往事不该被带上: {recalled}"
    );

    // 状态栏：名字、已接上、上一轮带入了几条。
    let status = rig.qz(
        &["statusline", "--host", "claude-code"],
        Some(&json!({"session_id": "s-1"}).to_string()),
        &[],
    )?;
    let status_line = String::from_utf8_lossy(&status.stdout).trim().to_owned();
    assert!(
        status_line.starts_with("● 青羽 · 已接上 · 带入 "),
        "状态栏不对: {status_line}"
    );
    assert!(
        !status_line.ends_with("带入 0"),
        "上一轮带入了往事: {status_line}"
    );

    // 提交：与往事无关的话，什么都不带，标准输出为空。
    let unrelated = rig.fire(
        "UserPromptSubmit",
        &json!({"hook_event_name": "UserPromptSubmit", "session_id": "s-1",
                "prompt": "把这段 Rust 的生命周期标注补全"}),
        &[],
    )?;
    assert!(unrelated.status.success());
    assert!(
        String::from_utf8_lossy(&unrelated.stdout).trim().is_empty(),
        "无关的提问不应带入任何东西"
    );

    // 回合结束：不输出任何东西。
    let stop = rig.fire(
        "Stop",
        &json!({"hook_event_name": "Stop", "session_id": "s-1", "transcript_path": "/tmp/t.jsonl"}),
        &[],
    )?;
    assert!(stop.status.success());
    assert!(String::from_utf8_lossy(&stop.stdout).trim().is_empty());

    // 压缩之后：核心重新带入。
    let compact = rig.fire(
        "SessionStart",
        &json!({"hook_event_name": "SessionStart", "session_id": "s-1", "source": "compact"}),
        &[],
    )?;
    assert!(
        injected_context(&compact)?.contains("<ewave_pinned>"),
        "压缩之后要重贴核心"
    );

    // 受管运行：守护进程自己拉起的宿主里，用户层钩子见到标记立即退出。
    let managed = rig.fire(
        "SessionStart",
        &json!({"hook_event_name": "SessionStart", "session_id": "s-managed", "source": "startup"}),
        &[("QUETZALCOATL_MANAGED_RUN", "1")],
    )?;
    assert!(managed.status.success());
    assert!(
        String::from_utf8_lossy(&managed.stdout).trim().is_empty(),
        "受管运行里钩子不得触发"
    );

    // 对话里查往事：工具通道。
    let mcp_in = [
        json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18"}}),
        json!({"jsonrpc": "2.0", "method": "notifications/initialized"}),
        json!({"jsonrpc": "2.0", "id": 2, "method": "tools/list"}),
        json!({"jsonrpc": "2.0", "id": 3, "method": "tools/call",
               "params": {"name": "recall", "arguments": {"query": "跨设备切换会话要注意什么"}}}),
    ]
    .iter()
    .map(Value::to_string)
    .collect::<Vec<_>>()
    .join("\n");
    let mcp = rig.qz(&["mcp"], Some(&format!("{mcp_in}\n")), &[])?;
    assert!(mcp.status.success());
    let replies: Vec<Value> = String::from_utf8_lossy(&mcp.stdout)
        .lines()
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect();
    assert_eq!(replies.len(), 3, "通知不回，其余三条各回一行");
    let tools: Vec<&str> = replies[1]["result"]["tools"]
        .as_array()
        .map(|list| list.iter().filter_map(|t| t["name"].as_str()).collect())
        .unwrap_or_default();
    assert_eq!(tools, vec!["recall"]);
    let found = replies[2]["result"]["content"][0]["text"]
        .as_str()
        .unwrap_or_default();
    assert_eq!(replies[2]["result"]["isError"], false);
    assert!(
        found.contains("未完成目标的步骤状态"),
        "查往事应找到那条关于跨设备切换的记忆: {found}"
    );

    // 诊断：四项全通。
    let doctor = rig.qz(&["doctor"], None, &[])?;
    let report = String::from_utf8_lossy(&doctor.stdout).into_owned();
    for item in [
        "守护进程",
        "插件",
        "送核心",
        "送往事",
        "收信号",
        "压缩后不丢",
    ] {
        assert!(report.contains(item), "诊断缺少「{item}」一行: {report}");
    }
    assert!(!report.contains("○"), "此刻不应有任何一项不通: {report}");

    // 我们停机：宿主照常。钩子以成功码退出、不输出、很快返回。
    daemon.shutdown()?;
    let began = Instant::now();
    let orphan = rig.fire(
        "UserPromptSubmit",
        &json!({"hook_event_name": "UserPromptSubmit", "session_id": "s-1", "prompt": "整理长期笔记"}),
        &[],
    )?;
    assert!(
        orphan.status.success(),
        "守护进程停了，钩子也必须以成功码退出"
    );
    assert!(String::from_utf8_lossy(&orphan.stdout).trim().is_empty());
    assert!(
        String::from_utf8_lossy(&orphan.stderr).trim().is_empty(),
        "钩子不在标准错误上说话，否则宿主会把它显示给用户"
    );
    assert!(
        began.elapsed() < Duration::from_secs(3),
        "停机时钩子必须立刻放行"
    );
    let offline_status = rig.qz(&["statusline"], Some("{}"), &[])?;
    assert_eq!(
        String::from_utf8_lossy(&offline_status.stdout).trim(),
        "○ Quetzalcoatl · 未连接"
    );
    Ok(())
}

#[test]
fn connect_is_repeatable_respects_the_users_own_status_line_and_undoes_cleanly() -> TestResult {
    let rig = Rig::new("undo")?;
    let settings_path = rig.claude_config.join("settings.json");
    let original =
        "{\n  \"model\": \"opus\",\n  \"permissions\": {\"allow\": [\"Bash(ls:*)\"]}\n}\n";
    fs::write(&settings_path, original)?;

    for round in 0..2 {
        let out = rig.qz(&["connect"], None, &[])?;
        assert!(
            out.status.success(),
            "第 {round} 次接上失败: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }
    let after: Value = serde_json::from_str(&fs::read_to_string(&settings_path)?)?;
    assert_eq!(after["model"], "opus", "用户原有的设置保持不变");
    let command = after["statusLine"]["command"].as_str().unwrap_or_default();
    assert!(
        command.ends_with("statusline --host claude-code"),
        "状态栏命令不对: {command}"
    );
    assert_eq!(
        fs::read_to_string(&settings_path)?
            .matches("statusLine")
            .count(),
        1,
        "重复接上不得重复写状态栏"
    );
    let calls = fs::read_to_string(rig.fake_claude_dir.join("claude-calls.log"))?;
    assert!(calls.contains("plugin marketplace add"));
    assert!(calls.contains("plugin install quetzalcoatl@quetzalcoatl-local"));

    let undo = rig.qz(&["connect", "--undo"], None, &[])?;
    assert!(undo.status.success());
    assert_eq!(
        fs::read_to_string(&settings_path)?,
        original,
        "撤销后宿主设置逐字节还原"
    );
    assert!(
        !rig.qz_home.join("hosts/claude-code").exists(),
        "本地接入目录应删除"
    );
    let calls = fs::read_to_string(rig.fake_claude_dir.join("claude-calls.log"))?;
    assert!(calls.contains("plugin uninstall quetzalcoatl@quetzalcoatl-local"));
    assert!(calls.contains("plugin marketplace remove quetzalcoatl-local"));

    // 用户已有自己的状态栏：不覆盖。
    let own = "{\n  \"statusLine\": {\"type\": \"command\", \"command\": \"my-own-status\"}\n}\n";
    fs::write(&settings_path, own)?;
    let out = rig.qz(&["connect"], None, &[])?;
    assert!(out.status.success());
    assert_eq!(
        fs::read_to_string(&settings_path)?,
        own,
        "用户自己的状态栏不得被改动"
    );
    let said = String::from_utf8_lossy(&out.stdout).into_owned();
    assert!(
        said.contains("没有改动"),
        "要告诉用户状态栏没有改动: {said}"
    );
    Ok(())
}

#[test]
fn connect_without_the_host_says_what_to_do_next() -> TestResult {
    let rig = Rig::new("nohost")?;
    fs::remove_file(rig.fake_claude_dir.join("claude"))?;
    let out = Command::new(qz())
        .args(["connect"])
        .env("QUETZALCOATL_HOME", &rig.qz_home)
        .env("HOME", &rig.root)
        .env("PATH", rig.fake_claude_dir.display().to_string())
        .output()?;
    assert!(!out.status.success(), "没有宿主时接上应当失败");
    let said = String::from_utf8_lossy(&out.stderr).into_owned();
    assert!(said.contains("Claude Code"), "要说清缺的是哪个宿主: {said}");
    assert!(said.contains("qz connect"), "要说清下一步: {said}");
    Ok(())
}
