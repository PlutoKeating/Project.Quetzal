#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]

//! `qz` — Quetzalcoatl 唯一简写终端命令行入口（自动本地 IPC 薄客户端切换，杜绝 `SQLITE_BUSY`）。

use std::fs::{self, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use quetzalcoatl_daemon::host_connect::{
    ClaudeCodeTarget, StatusLineOutcome, connect_claude_code, disconnect_claude_code,
    doctor_claude_code,
};
use quetzalcoatl_daemon::host_hook::{HOST_CLAUDE_CODE, run_hook, run_status_line};
use quetzalcoatl_daemon::local_ipc::GroupSenderWire;
use quetzalcoatl_daemon::{
    DaemonConfig, DaemonFabricConfig, DelegateRunRequest, FabricLoginRequest, IpcClient,
    IpcRequest, IpcResponse, QuetzalcoatlDaemon, export_offline_or_via_ipc,
    import_v1_offline_or_via_ipc, resolve_quetzalcoatl_home, restore_offline,
};
use quetzalcoatl_group::floor_control::{Mention, MentionKind};
use quetzalcoatl_harness::{
    CodingAgentKind, DiscoveryConfig, discover_coding_agents, discover_coding_agents_patiently,
};
use quetzalcoatl_kernel::CleanRoomVerifierDag;
use quetzalcoatl_sandbox::SandboxCommand;
use quetzalcoatl_spine::ZipExportOptions;
use quetzalcoatl_types::{AgentId, DeviceId, QuetzalcoatlError, Result};

const VERSION_BANNER: &str = concat!("qz (Quetzalcoatl CLI) ", env!("CARGO_PKG_VERSION"));

const USAGE_TEXT: &str = "\
Usage:
  qz <COMMAND> [OPTIONS]

Commands:
  up          Start local quetzalcoatld daemon and wait until it is ready
  connect     Attach to the hosts on this machine (Claude Code, Codex); --undo detaches cleanly
  doctor      Check, host by host, that his core, memories and signals get through
  down        Gracefully shut down running quetzalcoatld
  open        Open the local governance surface (prints the URL when no desktop is available)
  status      Show daemon, sovereign spine, heart and fabric status
  agents      Discover installed Coding Agents (<10ms parallel probe)
  delegate    Hand one task to a local coding agent in an isolated worktree; verified in the clean room
  export      Export readable Markdown + Spine ZIP; with a passphrase it also carries a recovery bundle
  import      Restore an export into an empty home (asks for the export passphrase)
  reflect     Have him look back on recent sessions now (normally runs by itself while you are away);
              --quiet stops him from bringing things up first, --speak-first turns it back on
  import-v1   Idempotently migrate legacy V1 soul repo and SQLite sessions
  login       Sign in to the official Hub (or --hub <url>); the first sign-in registers this agent
  pair        Quantum-safe X-Wing device pairing (start | join | approve)
  nodes       List fabric peers, path kind, Router holder and witness_epoch
  group       openmls 群组：create | invite | join | leave | list | send | members | revoke-steward
  channel     七大通道族：list | enable <name> | disable <name> | status | send <name> --text <...>
  sayit       SayIt v2.1 子树吸纳：ingest --path <snapshot> | --batch <dir>
  webhook     零知识 Webhook 入站：pull [--limit N] | status | register | rotate
  domain      五大首发领域包：list | show <id> | use <id>
              本版本仅完成领域包的声明、校验与切换审计；
              实机执行（紧急告警、引用强制、答案拦截）随 Runner 接入生效

Host entry points (invoked by the attached host, not by people):
  hook        Host hook entry: reads the host event on stdin, never blocks the host
  mcp         Host tool channel (MCP over stdio)
  statusline  One line for the host status bar
";

fn locate_quetzalcoatld_binary() -> PathBuf {
    if let Some(env_bin) = std::env::var_os("QUETZALCOATL_DAEMON_BIN")
        && !env_bin.is_empty()
    {
        return PathBuf::from(env_bin);
    }
    if let Ok(curr) = std::env::current_exe()
        && let Some(dir) = curr.parent()
    {
        let name = if cfg!(windows) {
            "quetzalcoatld.exe"
        } else {
            "quetzalcoatld"
        };
        let sibling = dir.join(name);
        if sibling.is_file() {
            return sibling;
        }
        if let Some(parent_dir) = dir.parent() {
            let parent_sibling = parent_dir.join(name);
            if parent_sibling.is_file() {
                return parent_sibling;
            }
        }
    }
    PathBuf::from("quetzalcoatld")
}

fn run_up(args: &[String]) -> Result<()> {
    let mut home: Option<PathBuf> = None;
    let mut foreground = false;
    let mut upstream_url: Option<String> = None;
    let mut fabric_hub: Option<String> = None;
    let mut fabric_ca_file: Option<PathBuf> = None;
    let mut fabric_relay_url: Option<String> = None;
    let mut fabric_qad_port: Option<u16> = None;
    let mut fabric_mdns: Option<bool> = None;
    let mut i = 0usize;
    while i < args.len() {
        match args[i].as_str() {
            "--foreground" => foreground = true,
            "--home" => {
                i += 1;
                let v = args.get(i).ok_or_else(|| QuetzalcoatlError::StorageError {
                    detail: String::from("--home 缺少目录参数"),
                })?;
                home = Some(PathBuf::from(v));
            }
            "--upstream-url" => {
                i += 1;
                let v = args.get(i).ok_or_else(|| QuetzalcoatlError::StorageError {
                    detail: String::from("--upstream-url 缺少参数"),
                })?;
                upstream_url = Some(v.clone());
            }
            "--fabric-hub" => {
                i += 1;
                let v = args.get(i).ok_or_else(|| QuetzalcoatlError::StorageError {
                    detail: String::from("--fabric-hub 缺少 URL 参数"),
                })?;
                fabric_hub = Some(v.clone());
            }
            "--fabric-ca-file" => {
                i += 1;
                let v = args.get(i).ok_or_else(|| QuetzalcoatlError::StorageError {
                    detail: String::from("--fabric-ca-file 缺少路径参数"),
                })?;
                fabric_ca_file = Some(PathBuf::from(v));
            }
            "--fabric-relay-url" => {
                i += 1;
                let v = args.get(i).ok_or_else(|| QuetzalcoatlError::StorageError {
                    detail: String::from("--fabric-relay-url 缺少 URL 参数"),
                })?;
                fabric_relay_url = Some(v.clone());
            }
            "--fabric-qad-port" => {
                i += 1;
                let v = args.get(i).ok_or_else(|| QuetzalcoatlError::StorageError {
                    detail: String::from("--fabric-qad-port 缺少端口参数"),
                })?;
                fabric_qad_port =
                    Some(
                        v.parse::<u16>()
                            .map_err(|e| QuetzalcoatlError::StorageError {
                                detail: format!("非法 --fabric-qad-port: {e}"),
                            })?,
                    );
            }
            "--fabric-mdns" => {
                i += 1;
                let v = args.get(i).ok_or_else(|| QuetzalcoatlError::StorageError {
                    detail: String::from("--fabric-mdns 缺省 0|1 参数"),
                })?;
                fabric_mdns = Some(!matches!(v.trim(), "0" | "false" | "off"));
            }
            other => {
                return Err(QuetzalcoatlError::StorageError {
                    detail: format!("qz up 未知参数: {other}"),
                });
            }
        }
        i += 1;
    }

    let qz_home = resolve_quetzalcoatl_home(home);
    if let Some(client) = IpcClient::connect_from_home(&qz_home)?
        && let Ok(IpcResponse::Status(st)) = client.call(&IpcRequest::Status)
    {
        println!(
            "quetzalcoatld already online (pid={}, agent={}, ipc={})",
            st.pid, st.agent_id, st.ipc_http_addr
        );
        println!("打开你的宿主，他在了。还没接上的话执行 `qz connect`；治理面用 `qz open`。");
        return Ok(());
    }

    let explicit_fabric = fabric_hub.map(|hub| DaemonFabricConfig {
        relay_url: fabric_relay_url.clone().unwrap_or_else(|| hub.clone()),
        hub_url: hub,
        hub_ca_file: fabric_ca_file.clone(),
        qad_port: fabric_qad_port.unwrap_or(7842),
        enable_mdns: fabric_mdns.unwrap_or(true),
        tick_interval_ms: 5_000,
    });

    if foreground {
        let mut cfg = DaemonConfig::new(qz_home);
        if let Some(u) = upstream_url {
            cfg.upstream_endpoints.anthropic_base_url = u.clone();
            cfg.upstream_endpoints.openai_base_url = u.clone();
            cfg.upstream_endpoints.codex_chatgpt_base_url = u.clone();
            cfg.upstream_endpoints.gemini_base_url = u;
        }
        if let Some(f) = explicit_fabric {
            cfg.fabric = Some(f);
        }
        let mut handle = QuetzalcoatlDaemon::start(cfg)?;
        println!(
            "quetzalcoatld foreground ready (ipc={})",
            handle.runtime_info().ipc_http_addr
        );
        handle.wait_until_stopped();
        return Ok(());
    }

    let run_dir = qz_home.join("run");
    fs::create_dir_all(&run_dir).map_err(|e| QuetzalcoatlError::StorageError {
        detail: format!("创建 run 目录失败: {e}"),
    })?;
    let log_file_path = run_dir.join("daemon.log");
    let stdout_log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_file_path)
        .map_err(|e| QuetzalcoatlError::StorageError {
            detail: format!("打开 daemon.log 失败: {e}"),
        })?;
    let stderr_log = stdout_log
        .try_clone()
        .map_err(|e| QuetzalcoatlError::StorageError {
            detail: format!("克隆 daemon.log 句柄失败: {e}"),
        })?;

    let daemon_bin = locate_quetzalcoatld_binary();
    let mut cmd = Command::new(&daemon_bin);
    cmd.arg("--home")
        .arg(&qz_home)
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout_log))
        .stderr(Stdio::from(stderr_log));
    if let Some(u) = upstream_url {
        cmd.arg("--upstream-url").arg(u);
    }
    if let Some(f) = &explicit_fabric {
        cmd.arg("--fabric-hub").arg(&f.hub_url);
        cmd.arg("--fabric-relay-url").arg(&f.relay_url);
        cmd.arg("--fabric-qad-port").arg(f.qad_port.to_string());
        if let Some(ca) = &f.hub_ca_file {
            cmd.arg("--fabric-ca-file").arg(ca);
        }
        cmd.arg("--fabric-mdns")
            .arg(if f.enable_mdns { "1" } else { "0" });
    }

    let mut child = cmd.spawn().map_err(|e| QuetzalcoatlError::StorageError {
        detail: format!(
            "启动后台 quetzalcoatld 失败 ({}): {e}",
            daemon_bin.display()
        ),
    })?;

    let deadline = Instant::now() + Duration::from_secs(6);
    while Instant::now() < deadline {
        if let Some(client) = IpcClient::connect_from_home(&qz_home)?
            && let Ok(IpcResponse::Status(st)) = client.call(&IpcRequest::Status)
        {
            println!(
                "quetzalcoatld ready (pid={}, agent={}, ipc={})",
                st.pid, st.agent_id, st.ipc_http_addr
            );
            println!("打开你的宿主，他在了。还没接上的话执行 `qz connect`；治理面用 `qz open`。");
            return Ok(());
        }
        if let Ok(Some(exit_status)) = child.try_wait() {
            let log_tail = fs::read_to_string(&log_file_path).unwrap_or_default();
            return Err(QuetzalcoatlError::StorageError {
                detail: format!("quetzalcoatld 启动后意外退出 (status={exit_status}): {log_tail}"),
            });
        }
        thread::sleep(Duration::from_millis(25));
    }

    Err(QuetzalcoatlError::StorageError {
        detail: String::from("等待 quetzalcoatld 就绪超时 (6s)"),
    })
}

fn console_url(addr: std::net::SocketAddr) -> String {
    format!("http://{addr}/")
}

/// 安装包把治理面的静态资源放在可执行文件旁的 `web/`；源码构建（`target/debug`）默认没有。
/// 只用于在打印治理面地址时给出诚实的说明，绝不阻断。
fn bundled_surface_available() -> bool {
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join("web").join("index.html")))
        .is_some_and(|index| index.is_file())
}

/// 是否存在可用图形会话；无桌面（SSH/容器/CI）时只打印 URL，绝不尝试拉起浏览器。
fn desktop_session_available() -> bool {
    if cfg!(target_os = "linux") {
        std::env::var_os("DISPLAY").is_some_and(|v| !v.is_empty())
            || std::env::var_os("WAYLAND_DISPLAY").is_some_and(|v| !v.is_empty())
    } else {
        true
    }
}

/// 返回平台默认浏览器启动器；`QZ_NO_BROWSER=1` 强制只打印 URL（测试与无头环境）。
fn browser_opener() -> Option<(&'static str, &'static [&'static str])> {
    if std::env::var("QZ_NO_BROWSER").ok().as_deref() == Some("1") || !desktop_session_available() {
        return None;
    }
    #[cfg(target_os = "linux")]
    {
        Some(("xdg-open", &[]))
    }
    #[cfg(target_os = "macos")]
    {
        Some(("open", &[]))
    }
    #[cfg(target_os = "windows")]
    {
        Some(("cmd", &["/C", "start", ""]))
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    {
        None
    }
}

fn run_open(args: &[String]) -> Result<()> {
    let home = parse_optional_home(args)?;
    let qz_home = resolve_quetzalcoatl_home(home);
    let client =
        IpcClient::connect_from_home(&qz_home)?.ok_or_else(|| QuetzalcoatlError::StorageError {
            detail: String::from("quetzalcoatld 尚未启动，请先运行 `qz up`"),
        })?;
    match client.call(&IpcRequest::Status)? {
        IpcResponse::Status(st) => {
            let url = console_url(st.ipc_http_addr);
            if let Some((program, leading)) = browser_opener() {
                // 浏览器启动器会继承并长期持有父进程的标准流：不重定向的话，
                // `qz open | tail`、CI 日志采集或脚本调用都会被挂住（实测可挂 5 分钟以上）。
                let spawned = Command::new(program)
                    .args(leading)
                    .arg(&url)
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .spawn();
                match spawned {
                    Ok(mut child) => {
                        // 启动器可能长时间驻留（例如已运行的浏览器把 URL 转交后退出）；后台线程负责回收，避免僵尸进程。
                        let _ = std::thread::spawn(move || {
                            let _ = child.wait();
                        });
                        println!("opened {url}");
                        return Ok(());
                    }
                    Err(e) => {
                        eprintln!("note: could not launch the browser ({e}); the URL is below")
                    }
                }
            }
            if !bundled_surface_available() {
                eprintln!(
                    "note: this build carries no bundled governance surface assets (installed releases do); the page will not load"
                );
            }
            println!("{url}");
            Ok(())
        }
        IpcResponse::Error { code, detail } => Err(map_ipc_error_code(&code, detail)),
        other => Err(QuetzalcoatlError::StorageError {
            detail: format!("未知的 IPC 响应: {other:?}"),
        }),
    }
}

fn run_down(args: &[String]) -> Result<()> {
    let home = parse_optional_home(args)?;
    let qz_home = resolve_quetzalcoatl_home(home);
    let Some(client) = IpcClient::connect_from_home(&qz_home)? else {
        println!("quetzalcoatld already stopped");
        return Ok(());
    };
    let _ = client.call(&IpcRequest::Shutdown)?;

    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        if IpcClient::connect_from_home(&qz_home)?.is_none()
            && !qz_home.join("run/daemon.json").exists()
        {
            println!("quetzalcoatld stopped");
            return Ok(());
        }
        thread::sleep(Duration::from_millis(20));
    }
    println!("quetzalcoatld shutdown signaled");
    Ok(())
}

fn run_status(args: &[String]) -> Result<()> {
    let (home, json_mode) = parse_home_and_json_flags(args)?;
    let qz_home = resolve_quetzalcoatl_home(home);
    if let Some(client) = IpcClient::connect_from_home(&qz_home)? {
        match client.call(&IpcRequest::Status)? {
            IpcResponse::Status(st) => {
                if json_mode {
                    let s = serde_json::to_string_pretty(&*st).map_err(|e| {
                        QuetzalcoatlError::SerializationError {
                            detail: e.to_string(),
                        }
                    })?;
                    println!("{s}");
                } else {
                    println!(
                        "online: true\npid: {}\nagent_id: {}\ndevice_id: {}\nepoch: {}\nruns: {}\nverifier_runs: {}\nspine_events: {}",
                        st.pid,
                        st.agent_id,
                        st.device_id,
                        st.epoch,
                        st.total_runs,
                        st.total_verifier_runs,
                        st.spine_events_count
                    );
                    print_fabric_status_text(&st.fabric);
                    print_channel_health_text(&st.channels);
                }
                return Ok(());
            }
            IpcResponse::Error { detail, .. } => {
                return Err(QuetzalcoatlError::StorageError { detail });
            }
            _ => {}
        }
    }

    if json_mode {
        println!("{{\"online\":false}}");
    } else {
        println!("online: false");
    }
    Ok(())
}

fn print_fabric_status_text(fabric: &quetzalcoatl_daemon::FabricStatus) {
    if !fabric.enabled {
        println!("fabric: disabled");
        return;
    }
    let hub = fabric.hub_url.as_deref().unwrap_or("(unknown)");
    let lease = match (fabric.lease.as_str(), fabric.witness_epoch) {
        ("witnessed", Some(epoch)) => format!("Witnessed(epoch={epoch})"),
        ("witnessed", None) => String::from("Witnessed"),
        (other, _) => String::from(other),
    };
    println!("fabric: enabled");
    println!("fabric_hub: {hub}");
    println!("fabric_logged_in: {}", fabric.logged_in);
    println!("fabric_peers: {}", fabric.peer_count);
    println!("fabric_lease: {lease}");
    println!("fabric_last_sync_cursor: {}", fabric.last_sync_cursor);
}

fn parse_flag_value<'a>(args: &'a [String], idx: &mut usize, flag: &str) -> Result<&'a String> {
    *idx += 1;
    args.get(*idx)
        .ok_or_else(|| QuetzalcoatlError::StorageError {
            detail: format!("{flag} 缺少参数"),
        })
}

fn parse_pair_code(code: &str) -> Result<(String, String)> {
    let trimmed = code.trim();
    let split = trimmed.split_once('.').or_else(|| trimmed.split_once(':'));
    match split {
        Some((pairing_id, short_code))
            if !pairing_id.trim().is_empty() && !short_code.trim().is_empty() =>
        {
            Ok((
                String::from(pairing_id.trim()),
                String::from(short_code.trim()),
            ))
        }
        _ => Err(QuetzalcoatlError::CredentialRejected {
            detail: String::from(
                "配对码格式应为 `<pairing_id>.<short_code>`（直接复制 `qz pair start` 输出的 pair_code）",
            ),
        }),
    }
}

fn require_daemon(qz_home: &Path) -> Result<IpcClient> {
    IpcClient::connect_from_home(qz_home)?.ok_or_else(|| QuetzalcoatlError::StorageError {
        detail: String::from("quetzalcoatld 尚未启动，请先运行 `qz up`"),
    })
}

fn expect_fabric_hub(client: &IpcClient, hub_flag: Option<&String>) -> Result<()> {
    let Some(expected) = hub_flag else {
        return Ok(());
    };
    let status = client.call(&IpcRequest::Status)?;
    match status {
        IpcResponse::Status(st) => match st.fabric.hub_url.as_deref() {
            Some(actual)
                if actual.trim_end_matches('/') == expected.trim().trim_end_matches('/') =>
            {
                Ok(())
            }
            Some(actual) => Err(QuetzalcoatlError::StorageError {
                detail: format!(
                    "守护进程绑定的 Hub 为 `{actual}`，与 --hub `{expected}` 不一致；请用 `qz up --fabric-hub` 重启"
                ),
            }),
            None => Err(QuetzalcoatlError::PermissionDenied {
                detail: format!(
                    "fabric 未启用，忽略的 --hub `{expected}`；请用 QUETZALCOATL_FABRIC_HUB_URL 或 `qz up --fabric-hub {expected}` 启动"
                ),
            }),
        },
        IpcResponse::Error { detail, .. } => Err(QuetzalcoatlError::StorageError { detail }),
        _ => Err(QuetzalcoatlError::StorageError {
            detail: String::from("无法读取守护进程状态"),
        }),
    }
}

fn run_login(args: &[String]) -> Result<()> {
    let mut home: Option<PathBuf> = None;
    let mut hub_url: Option<String> = None;
    let mut token: Option<String> = None;
    let mut ca_file: Option<PathBuf> = None;
    let mut pin: Option<String> = None;
    let mut agent: Option<AgentId> = None;
    let mut device: Option<DeviceId> = None;
    let mut json_mode = false;
    let mut pin_from_stdin = false;

    let mut i = 0usize;
    while i < args.len() {
        match args[i].as_str() {
            "--json" => json_mode = true,
            "--pin-stdin" => pin_from_stdin = true,
            "--home" => home = Some(PathBuf::from(parse_flag_value(args, &mut i, "--home")?)),
            "--hub" => hub_url = Some(parse_flag_value(args, &mut i, "--hub")?.clone()),
            "--token" => token = Some(parse_flag_value(args, &mut i, "--token")?.clone()),
            "--ca-file" => {
                ca_file = Some(PathBuf::from(parse_flag_value(args, &mut i, "--ca-file")?))
            }
            "--pin" => pin = Some(parse_flag_value(args, &mut i, "--pin")?.clone()),
            "--agent" => {
                let raw = parse_flag_value(args, &mut i, "--agent")?;
                agent = Some(raw.parse::<AgentId>().map_err(|e| {
                    QuetzalcoatlError::SerializationError {
                        detail: format!("非法 --agent: {e}"),
                    }
                })?);
            }
            "--device" => {
                let raw = parse_flag_value(args, &mut i, "--device")?;
                device = Some(raw.parse::<DeviceId>().map_err(|e| {
                    QuetzalcoatlError::SerializationError {
                        detail: format!("非法 --device: {e}"),
                    }
                })?);
            }
            other => {
                return Err(QuetzalcoatlError::StorageError {
                    detail: format!("qz login 未知参数: {other}"),
                });
            }
        }
        i += 1;
    }

    // 不给地址就是官方 Hub；QUETZALCOATL_HUB_URL 可以改成自建的。
    let hub = hub_url
        .or_else(|| {
            std::env::var("QUETZALCOATL_HUB_URL")
                .ok()
                .filter(|v| !v.trim().is_empty())
        })
        .unwrap_or_else(|| String::from(quetzalcoatl_daemon::OFFICIAL_HUB_URL));
    if token.is_none() && pin.is_none() {
        pin = Some(read_passphrase(
            pin_from_stdin,
            "登录口令（第一次登录这台 Hub 时即设定）: ",
        )?);
    }
    let qz_home = resolve_quetzalcoatl_home(home);
    let mut client = require_daemon(&qz_home)?;
    let request = IpcRequest::FabricLogin(FabricLoginRequest {
        hub_url: hub.clone(),
        token,
        ca_file,
        pin,
        agent_id: agent,
        device_id: device,
    });
    let mut resp = client.call(&request)?;
    // 守护进程还没接 Hub：带上这台 Hub 重启它，再登录一次。登录成功后会话落盘，以后启动自动接上。
    if let IpcResponse::Error { detail, .. } = &resp
        && detail.contains("fabric 未启用")
    {
        let me = std::env::current_exe().map_err(|e| QuetzalcoatlError::StorageError {
            detail: format!("无法确定 qz 自身的路径: {e}"),
        })?;
        let home_arg = qz_home.to_string_lossy().into_owned();
        let _ = Command::new(&me)
            .args(["down", "--home", &home_arg])
            .status();
        let up = Command::new(&me)
            .args(["up", "--home", &home_arg, "--fabric-hub", &hub])
            .stdout(Stdio::null())
            .status()
            .map_err(|e| QuetzalcoatlError::StorageError {
                detail: format!("重启守护进程失败: {e}"),
            })?;
        if !up.success() {
            return Err(QuetzalcoatlError::StorageError {
                detail: String::from("带上 Hub 地址重启守护进程失败，看看 qz status。"),
            });
        }
        client = require_daemon(&qz_home)?;
        resp = client.call(&request)?;
    }
    match resp {
        IpcResponse::FabricLogin(res) => {
            if json_mode {
                let s = serde_json::to_string_pretty(&res).map_err(|e| {
                    QuetzalcoatlError::SerializationError {
                        detail: e.to_string(),
                    }
                })?;
                println!("{s}");
            } else {
                println!(
                    "logged in to {} as agent={} device={} (auth={})",
                    res.hub_url, res.agent_id, res.device_id, res.auth_mode
                );
                println!(
                    "lease={} witness_epoch={} peers={}",
                    res.lease, res.witness_epoch, res.peer_count
                );
            }
            Ok(())
        }
        IpcResponse::Error { code, detail } => Err(map_ipc_error_code(&code, detail)),
        other => Err(QuetzalcoatlError::StorageError {
            detail: format!("未知的 IPC 响应: {other:?}"),
        }),
    }
}

fn run_pair(args: &[String]) -> Result<()> {
    let Some((sub, rest)) = args.split_first() else {
        return Err(QuetzalcoatlError::StorageError {
            detail: String::from(
                "用法: qz pair <start|join|approve> [--code <pairing_id>.<short_code>]",
            ),
        });
    };
    match sub.as_str() {
        "start" => run_pair_start(rest),
        "join" => run_pair_join(rest),
        "approve" => run_pair_approve(rest),
        "revoke" => run_pair_revoke(rest),
        other => Err(QuetzalcoatlError::StorageError {
            detail: format!("qz pair 未知子命令: {other}（支持 start / join / approve / revoke）"),
        }),
    }
}

struct PairArgs {
    home: Option<PathBuf>,
    hub: Option<String>,
    code: Option<String>,
    device: Option<DeviceId>,
    json_mode: bool,
}

fn parse_pair_args(args: &[String], allow_code: bool) -> Result<PairArgs> {
    let mut out = PairArgs {
        home: None,
        hub: None,
        code: None,
        device: None,
        json_mode: false,
    };
    let mut i = 0usize;
    while i < args.len() {
        match args[i].as_str() {
            "--json" => out.json_mode = true,
            "--home" => out.home = Some(PathBuf::from(parse_flag_value(args, &mut i, "--home")?)),
            "--hub" => out.hub = Some(parse_flag_value(args, &mut i, "--hub")?.clone()),
            "--code" if allow_code => {
                out.code = Some(parse_flag_value(args, &mut i, "--code")?.clone())
            }
            "--device" => {
                let raw = parse_flag_value(args, &mut i, "--device")?;
                out.device = Some(raw.parse::<DeviceId>().map_err(|e| {
                    QuetzalcoatlError::SerializationError {
                        detail: format!("非法 --device: {e}"),
                    }
                })?);
            }
            other => {
                return Err(QuetzalcoatlError::StorageError {
                    detail: format!("qz pair 未知参数: {other}"),
                });
            }
        }
        i += 1;
    }
    Ok(out)
}

fn run_pair_start(args: &[String]) -> Result<()> {
    let parsed = parse_pair_args(args, false)?;
    let qz_home = resolve_quetzalcoatl_home(parsed.home);
    let client = require_daemon(&qz_home)?;
    expect_fabric_hub(&client, parsed.hub.as_ref())?;
    match client.call(&IpcRequest::FabricPairStart)? {
        IpcResponse::FabricPairStart(res) => {
            if parsed.json_mode {
                print_json(&*res)?;
            } else {
                println!("pairing_id: {}", res.pairing_id);
                println!("short_code: {}", res.short_code);
                println!("pair_code: {}", res.pair_code);
                println!("expires_at_ms: {}", res.expires_at_ms);
                println!(
                    "xwing_hpke_recipient_bundle: {{\"agent_id\":\"{}\",\"hub_url\":\"{}\",\"pairing_id\":\"{}\",\"short_code\":\"{}\",\"xwing_recipient_public_key_hex\":\"{}\"}}",
                    res.agent_id,
                    res.hub_url,
                    res.pairing_id,
                    res.short_code,
                    res.xwing_recipient_public_key_hex
                );
                println!(
                    "提示：把 `pair_code` 整段交给新设备的 `qz pair join --code <pair_code>`；审批用 `qz pair approve --code <pair_code>`"
                );
            }
            Ok(())
        }
        IpcResponse::Error { code, detail } => Err(map_ipc_error_code(&code, detail)),
        other => Err(QuetzalcoatlError::StorageError {
            detail: format!("未知的 IPC 响应: {other:?}"),
        }),
    }
}

fn run_pair_join(args: &[String]) -> Result<()> {
    let parsed = parse_pair_args(args, true)?;
    let code = parsed.code.ok_or_else(|| QuetzalcoatlError::StorageError {
        detail: String::from("用法: qz pair join --code <pairing_id>.<short_code>"),
    })?;
    let (pairing_id, short_code) = parse_pair_code(&code)?;
    let qz_home = resolve_quetzalcoatl_home(parsed.home);
    let client = require_daemon(&qz_home)?;
    expect_fabric_hub(&client, parsed.hub.as_ref())?;
    match client.call(&IpcRequest::FabricPairJoin {
        pairing_id,
        short_code,
    })? {
        IpcResponse::FabricPairJoin(res) => {
            if parsed.json_mode {
                print_json(&res)?;
            } else {
                println!(
                    "paired joiner_device={} pairing_id={} hub={}",
                    res.joiner_device_id, res.pairing_id, res.hub_url
                );
                println!("请回到已授权设备执行 `qz pair approve --code <pair_code>`");
            }
            Ok(())
        }
        IpcResponse::Error { code, detail } => Err(map_ipc_error_code(&code, detail)),
        other => Err(QuetzalcoatlError::StorageError {
            detail: format!("未知的 IPC 响应: {other:?}"),
        }),
    }
}

fn run_pair_approve(args: &[String]) -> Result<()> {
    let parsed = parse_pair_args(args, true)?;
    let code = parsed.code.ok_or_else(|| QuetzalcoatlError::StorageError {
        detail: String::from("用法: qz pair approve --code <pairing_id>.<short_code>"),
    })?;
    let (pairing_id, short_code) = parse_pair_code(&code)?;
    let qz_home = resolve_quetzalcoatl_home(parsed.home);
    let client = require_daemon(&qz_home)?;
    expect_fabric_hub(&client, parsed.hub.as_ref())?;
    match client.call(&IpcRequest::FabricPairApprove {
        pairing_id,
        short_code,
    })? {
        IpcResponse::FabricPairApprove(res) => {
            if parsed.json_mode {
                print_json(&*res)?;
            } else {
                println!("pairing_id: {}", res.pairing_id);
                println!("joiner_device_id: {}", res.joiner_device_id);
                println!(
                    "xwing_hpke_ciphertext_bundle: {{\"aad_utf8\":\"{}\",\"nonce_hex\":\"{}\",\"ciphertext_hex\":\"{}\",\"hpke_enc_hex\":\"{}\"}}",
                    res.slot2_aad_utf8,
                    res.slot2_nonce_hex,
                    res.slot2_ciphertext_hex,
                    res.slot2_hpke_enc_hex
                );
            }
            Ok(())
        }
        IpcResponse::Error { code, detail } => Err(map_ipc_error_code(&code, detail)),
        other => Err(QuetzalcoatlError::StorageError {
            detail: format!("未知的 IPC 响应: {other:?}"),
        }),
    }
}

fn run_pair_revoke(args: &[String]) -> Result<()> {
    let parsed = parse_pair_args(args, false)?;
    let device = parsed
        .device
        .ok_or_else(|| QuetzalcoatlError::StorageError {
            detail: String::from("用法: qz pair revoke --device <device_id>"),
        })?;
    let qz_home = resolve_quetzalcoatl_home(parsed.home);
    let client = require_daemon(&qz_home)?;
    expect_fabric_hub(&client, parsed.hub.as_ref())?;
    match client.call(&IpcRequest::FabricRevokeDevice { device_id: device })? {
        IpcResponse::FabricRevokeDevice(res) => {
            if parsed.json_mode {
                print_json(&res)?;
            } else {
                println!(
                    "revoked device={} (epoch rotated to {})",
                    res.device_id, res.new_epoch
                );
            }
            Ok(())
        }
        IpcResponse::Error { code, detail } => Err(map_ipc_error_code(&code, detail)),
        other => Err(QuetzalcoatlError::StorageError {
            detail: format!("未知的 IPC 响应: {other:?}"),
        }),
    }
}

fn print_json<T: serde::Serialize>(value: &T) -> Result<()> {
    let s =
        serde_json::to_string_pretty(value).map_err(|e| QuetzalcoatlError::SerializationError {
            detail: e.to_string(),
        })?;
    println!("{s}");
    Ok(())
}

fn run_nodes(args: &[String]) -> Result<()> {
    let (home, json_mode) = parse_home_and_json_flags(args)?;
    let qz_home = resolve_quetzalcoatl_home(home);
    let client = require_daemon(&qz_home)?;
    match client.call(&IpcRequest::FabricNodes)? {
        IpcResponse::FabricNodes(report) => {
            if json_mode {
                print_json(&*report)?;
                return Ok(());
            }
            let hub = report.hub_url.as_deref().unwrap_or("(unknown)");
            let holder = report
                .router_holder
                .map(|d| d.to_string())
                .unwrap_or_else(|| String::from("(none)"));
            println!(
                "fabric: enabled\nhub: {hub}\nrouter_holder: {holder}\nwitness_epoch: {}\nlease: {}\nlast_sync_cursor: {}\npeers: {}",
                report.witness_epoch,
                report.lease,
                report.last_sync_cursor,
                report.peers.len()
            );
            for p in &report.peers {
                let path = if p.path_detail.is_empty() {
                    p.path_kind.clone()
                } else {
                    format!("{}({})", p.path_kind, p.path_detail)
                };
                println!(
                    "  - [{}] {} endpoint={} path={} tags=[{}] harnesses=[{}] {}/{} workers",
                    p.role,
                    p.device_id,
                    p.endpoint_id_hex,
                    path,
                    p.capability_tags.join(","),
                    p.available_harnesses.join(","),
                    p.active_workers,
                    p.max_workers
                );
            }
            Ok(())
        }
        IpcResponse::Error { code, detail } => Err(map_ipc_error_code(&code, detail)),
        other => Err(QuetzalcoatlError::StorageError {
            detail: format!("未知的 IPC 响应: {other:?}"),
        }),
    }
}

fn run_agents(args: &[String]) -> Result<()> {
    let (home, json_mode) = parse_home_and_json_flags(args)?;
    let qz_home = resolve_quetzalcoatl_home(home);
    let report = if let Some(client) = IpcClient::connect_from_home(&qz_home)? {
        match client.call(&IpcRequest::Agents)? {
            IpcResponse::Agents(rep) => rep,
            IpcResponse::Error { detail, .. } => {
                return Err(QuetzalcoatlError::StorageError { detail });
            }
            _ => discover_coding_agents(&DiscoveryConfig::default())?,
        }
    } else {
        discover_coding_agents(&DiscoveryConfig::default())?
    };

    if json_mode {
        let s = serde_json::to_string_pretty(&report).map_err(|e| {
            QuetzalcoatlError::SerializationError {
                detail: e.to_string(),
            }
        })?;
        println!("{s}");
    } else {
        println!(
            "Discovered {} Coding Agent(s) in {}us:",
            report.agents.len(),
            report.elapsed_micros
        );
        for a in &report.agents {
            let rec = if a.is_default_recommended {
                " [DEFAULT RECOMMENDED]"
            } else {
                ""
            };
            println!(
                "  - {:?}: {} ({}){}",
                a.kind,
                a.binary_path.display(),
                a.version_banner,
                rec
            );
        }
    }
    Ok(())
}

/// `qz delegate`：把一件要做完的事委派给本机宿主（Coding Agent）。宿主在独立 worktree 里完成，
/// 结果经断网只读洁净室验收后才落回目标仓库。这是无人在场时的入口，不是对话。
fn run_delegate(args: &[String]) -> Result<()> {
    let mut home: Option<PathBuf> = None;
    let mut json_mode = false;
    let mut workspace_dir: Option<PathBuf> = None;
    let mut verifier_suite: Option<PathBuf> = None;
    let mut verifier_cmd: Option<String> = None;
    let mut task_parts = Vec::<String>::new();

    let mut i = 0usize;
    while i < args.len() {
        match args[i].as_str() {
            "--json" => json_mode = true,
            "--home" => {
                i += 1;
                let v = args.get(i).ok_or_else(|| QuetzalcoatlError::StorageError {
                    detail: String::from("--home 缺少目录参数"),
                })?;
                home = Some(PathBuf::from(v));
            }
            "--workspace" => {
                i += 1;
                let v = args.get(i).ok_or_else(|| QuetzalcoatlError::StorageError {
                    detail: String::from("--workspace 缺少目录参数"),
                })?;
                workspace_dir = Some(PathBuf::from(v));
            }
            "--verifier-suite" => {
                i += 1;
                let v = args.get(i).ok_or_else(|| QuetzalcoatlError::StorageError {
                    detail: String::from("--verifier-suite 缺少目录参数"),
                })?;
                verifier_suite = Some(PathBuf::from(v));
            }
            "--verifier-cmd" => {
                i += 1;
                let v = args.get(i).ok_or_else(|| QuetzalcoatlError::StorageError {
                    detail: String::from("--verifier-cmd 缺少命令参数"),
                })?;
                verifier_cmd = Some(v.clone());
            }
            other => task_parts.push(String::from(other)),
        }
        i += 1;
    }

    let workspace_dir = workspace_dir.ok_or_else(|| QuetzalcoatlError::StorageError {
        detail: String::from("qz delegate 需要 --workspace <目标仓库目录>"),
    })?;
    let task = task_parts.join(" ");
    if task.trim().is_empty() {
        return Err(QuetzalcoatlError::StorageError {
            detail: String::from("qz delegate 需要一句任务描述"),
        });
    }

    let qz_home = resolve_quetzalcoatl_home(home);
    let client =
        IpcClient::connect_from_home(&qz_home)?.ok_or_else(|| QuetzalcoatlError::StorageError {
            detail: String::from("quetzalcoatld 尚未启动，请先运行 `qz up`"),
        })?;

    let verifier_dag = match (verifier_suite, verifier_cmd) {
        (Some(suite), Some(cmd_str)) => Some(CleanRoomVerifierDag::single(
            "cli-verifier",
            suite,
            SandboxCommand::shell(cmd_str),
        )),
        _ => None,
    };

    let resp = client.call(&IpcRequest::DelegateRun(DelegateRunRequest {
        task,
        peer_id: None,
        workspace_dir,
        verifier_dag,
        router_attempted_forbidden_tools: Vec::new(),
    }))?;
    match resp {
        IpcResponse::DelegateRun(run) => {
            if json_mode {
                let s = serde_json::to_string_pretty(&*run).map_err(|e| {
                    QuetzalcoatlError::SerializationError {
                        detail: e.to_string(),
                    }
                })?;
                println!("{s}");
            } else {
                println!("{}", run.final_text);
            }
            let _ = io::stdout().flush();
            Ok(())
        }
        IpcResponse::Error { code, detail } => Err(map_ipc_error_code(&code, detail)),
        other => Err(QuetzalcoatlError::StorageError {
            detail: format!("未知的 IPC 响应: {other:?}"),
        }),
    }
}

/// 宿主入口命令的参数解析：宽松处理，任何情况下都不报错（这些命令不能挡宿主的路）。
fn lenient_home_and_host(args: &[String]) -> (Option<PathBuf>, String) {
    let mut home = None;
    let mut host = String::from(HOST_CLAUDE_CODE);
    let mut i = 0usize;
    while i < args.len() {
        match args[i].as_str() {
            "--home" => {
                i += 1;
                home = args.get(i).map(PathBuf::from);
            }
            "--host" => {
                i += 1;
                if let Some(value) = args.get(i) {
                    host.clone_from(value);
                }
            }
            _ => {}
        }
        i += 1;
    }
    (home, host)
}

/// 读入宿主写到标准输入的事件；超出上限的部分丢弃。
fn read_host_event() -> String {
    const HOST_EVENT_LIMIT: u64 = 8 * 1024 * 1024;
    let mut input = String::new();
    let _ = io::stdin()
        .lock()
        .take(HOST_EVENT_LIMIT)
        .read_to_string(&mut input);
    input
}

/// `qz hook`：宿主钩子入口。无论发生什么都以成功码退出，也不在标准错误上说话。
fn run_host_hook(args: &[String]) -> Result<()> {
    let (home, host) = lenient_home_and_host(args);
    let qz_home = resolve_quetzalcoatl_home(home);
    let output = run_hook(&qz_home, &host, &read_host_event());
    if !output.is_empty() {
        print!("{output}");
        let _ = io::stdout().flush();
    }
    Ok(())
}

/// `qz statusline`：宿主状态栏的一行。
fn run_host_status_line(args: &[String]) -> Result<()> {
    let (home, host) = lenient_home_and_host(args);
    let qz_home = resolve_quetzalcoatl_home(home);
    let color = std::env::var_os("NO_COLOR").is_none();
    let line = run_status_line(&qz_home, &host, &read_host_event(), color);
    if !line.is_empty() {
        println!("{line}");
        let _ = io::stdout().flush();
    }
    Ok(())
}

/// `qz mcp`：宿主会话里的工具通道（标准输入输出上的 MCP 服务）。
fn run_host_mcp(args: &[String]) -> Result<()> {
    let (home, _) = lenient_home_and_host(args);
    let qz_home = resolve_quetzalcoatl_home(home);
    let stdin = io::stdin();
    let stdout = io::stdout();
    let _ = quetzalcoatl_daemon::host_mcp::serve_stdio(&qz_home, stdin.lock(), stdout.lock());
    Ok(())
}

/// 找到本机的 Claude Code 并拼出接入所需的全部位置；找不到时返回 `None`。
fn locate_claude_code_target(qz_home: &Path) -> Result<Option<ClaudeCodeTarget>> {
    // 这是用户主动执行的命令，不在热路径上：给宿主的版本探测留足时间。
    let report = discover_coding_agents_patiently(&DiscoveryConfig {
        probe_timeout: Duration::from_secs(3),
        ..DiscoveryConfig::default()
    })?;
    let Some(agent) = report
        .agents
        .iter()
        .find(|agent| agent.kind == CodingAgentKind::ClaudeCode)
    else {
        return Ok(None);
    };
    let qz_bin = std::env::current_exe()
        .and_then(fs::canonicalize)
        .map_err(|e| QuetzalcoatlError::StorageError {
            detail: format!("无法确定 qz 自身的路径: {e}"),
        })?;
    let claude_config_dir = std::env::var_os("CLAUDE_CONFIG_DIR")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".claude")))
        .ok_or_else(|| QuetzalcoatlError::StorageError {
            detail: String::from("无法确定 Claude Code 的配置目录（缺少 HOME）"),
        })?;
    Ok(Some(ClaudeCodeTarget {
        qz_home: qz_home.to_path_buf(),
        qz_bin,
        claude_bin: agent.binary_path.clone(),
        claude_config_dir,
    }))
}

fn locate_codex_target(
    qz_home: &Path,
) -> Result<Option<quetzalcoatl_daemon::host_connect_codex::CodexTarget>> {
    let report = discover_coding_agents_patiently(&DiscoveryConfig {
        probe_timeout: Duration::from_secs(3),
        ..DiscoveryConfig::default()
    })?;
    let Some(agent) = report
        .agents
        .iter()
        .find(|agent| agent.kind == CodingAgentKind::Codex)
    else {
        return Ok(None);
    };
    let qz_bin = std::env::current_exe()
        .and_then(fs::canonicalize)
        .map_err(|e| QuetzalcoatlError::StorageError {
            detail: format!("无法确定 qz 自身的路径: {e}"),
        })?;
    let Some(codex_home) = quetzalcoatl_daemon::host_connect_codex::codex_home_dir() else {
        return Ok(None);
    };
    Ok(Some(quetzalcoatl_daemon::host_connect_codex::CodexTarget {
        qz_home: qz_home.to_path_buf(),
        qz_bin,
        codex_bin: agent.binary_path.clone(),
        codex_home,
    }))
}

/// `qz connect`：把他接进本机已有的宿主。`--undo` 撤下。
fn run_connect(args: &[String]) -> Result<()> {
    let mut home: Option<PathBuf> = None;
    let mut undo = false;
    let mut i = 0usize;
    while i < args.len() {
        match args[i].as_str() {
            "--undo" => undo = true,
            "--home" => home = Some(PathBuf::from(parse_flag_value(args, &mut i, "--home")?)),
            other => {
                return Err(QuetzalcoatlError::StorageError {
                    detail: format!(
                        "qz connect 不认识参数 `{other}`（可用：--undo、--home <目录>）"
                    ),
                });
            }
        }
        i += 1;
    }
    let qz_home = resolve_quetzalcoatl_home(home);
    let claude = locate_claude_code_target(&qz_home)?;
    let codex = locate_codex_target(&qz_home)?;
    if claude.is_none() && codex.is_none() {
        return Err(QuetzalcoatlError::StorageError {
            detail: String::from(
                "本机没有找到 Claude Code，也没有找到 Codex。装好并登录其中一个之后，再执行 `qz connect`。",
            ),
        });
    }

    if undo {
        if let Some(target) = &claude {
            disconnect_claude_code(target)?;
            println!("已从 Claude Code 撤下。它的配置里不再有 Quetzalcoatl 的任何东西。");
        }
        if let Some(target) = &codex {
            quetzalcoatl_daemon::host_connect_codex::disconnect_codex(target)?;
            println!("已从 Codex 撤下。");
        }
        return Ok(());
    }

    if let Some(target) = &codex {
        match quetzalcoatl_daemon::host_connect_codex::connect_codex(target) {
            Ok(()) => {
                println!("已接上 Codex。");
                println!(
                    "  第一次打开 Codex 时，在 /hooks 里信任 Quetzalcoatl 的钩子；工具通道不需要这一步"
                );
            }
            Err(err) => println!(
                "Codex 没有接上：{}",
                err.detail().unwrap_or("宿主的插件命令失败")
            ),
        }
    }
    let Some(target) = claude else {
        println!("打开你的宿主，他在了。想确认每一步都通，执行 `qz doctor`。");
        return Ok(());
    };
    let report = connect_claude_code(&target)?;
    println!("已接上 Claude Code。");
    match report.status_line {
        StatusLineOutcome::Written | StatusLineOutcome::AlreadyOurs => {
            println!("  状态栏  会显示他的名字和这一轮带入了几条往事");
        }
        StatusLineOutcome::KeptUserOwn => {
            println!("  状态栏  你已经有自己的状态栏，没有改动");
        }
        StatusLineOutcome::SettingsUntouched => {
            println!("  状态栏  设置文件读不懂，没有改动");
        }
    }
    println!("打开你的 Claude Code，他在了。想确认每一步都通，执行 `qz doctor`。");
    Ok(())
}

/// `qz doctor`：按宿主体检。
fn run_doctor(args: &[String]) -> Result<()> {
    let (home, json_mode) = parse_home_and_json_flags(args)?;
    let qz_home = resolve_quetzalcoatl_home(home);
    let target = locate_claude_code_target(&qz_home)?;
    let lines = doctor_claude_code(&qz_home, target.as_ref());
    if json_mode {
        let encoded = serde_json::to_string_pretty(&lines).map_err(|e| {
            QuetzalcoatlError::SerializationError {
                detail: e.to_string(),
            }
        })?;
        println!("{encoded}");
        return Ok(());
    }
    println!("Claude Code");
    for item in &lines {
        // 实心点 = 通；空心点 = 需要你看一眼。颜色之外另有文字，不靠颜色区分。
        let mark = if item.ok { "●" } else { "○" };
        println!("  {mark} {}  {}", item.label, item.detail);
    }
    if let Some(codex) = locate_codex_target(&qz_home)?
        && codex.plugin_source_dir().exists()
    {
        println!("Codex");
        for item in quetzalcoatl_daemon::host_connect_codex::doctor_codex(&qz_home, &codex) {
            let mark = if item.ok { "●" } else { "○" };
            println!("  {mark} {}  {}", item.label, item.detail);
        }
    }
    Ok(())
}

fn map_ipc_error_code(code: &str, detail: String) -> QuetzalcoatlError {
    match code {
        "SANDBOX_VIOLATION" => QuetzalcoatlError::SandboxViolation { detail },
        "CREDENTIAL_REJECTED" => QuetzalcoatlError::CredentialRejected { detail },
        "MODEL_NOT_CONFIGURED" => QuetzalcoatlError::ModelNotConfigured { detail },
        "PERMISSION_DENIED" => QuetzalcoatlError::PermissionDenied { detail },
        "VERIFICATION_FAILED" => QuetzalcoatlError::VerificationFailed { detail },
        "CONSCIENCE_VIOLATION" => QuetzalcoatlError::ConscienceViolation { detail },
        "SERIALIZATION_ERROR" => QuetzalcoatlError::SerializationError { detail },
        "INTEGRITY_VIOLATION" => QuetzalcoatlError::IntegrityViolation { detail },
        "STALE_LEASE_EPOCH" => QuetzalcoatlError::StaleLeaseEpoch {
            provided: 0,
            current: 0,
        },
        _ => QuetzalcoatlError::StorageError { detail },
    }
}

fn print_channel_health_text(rows: &[quetzalcoatl_channels::ChannelHealth]) {
    if rows.is_empty() {
        println!("channels: none");
        return;
    }
    println!("channels:");
    for row in rows {
        let state = if row.enabled { "enabled" } else { "disabled" };
        let binding = match (row.bound_witness_epoch, row.holder_device_id.as_deref()) {
            (Some(epoch), Some(holder)) => format!("epoch={epoch} holder={holder}"),
            _ => String::from("unbound"),
        };
        println!(
            "  - {} [{}] transport_local={} credentials={} {}",
            row.channel, state, row.local_only, row.requires_credentials, binding
        );
    }
}

fn run_channel(args: &[String]) -> Result<()> {
    let mut home: Option<PathBuf> = None;
    let mut json_mode = false;
    let mut action: Option<String> = None;
    let mut channel: Option<String> = None;
    let mut text: Option<String> = None;
    let mut destination: Option<String> = None;
    let mut i = 0usize;
    while i < args.len() {
        match args[i].as_str() {
            "--json" => json_mode = true,
            "--text" => {
                i += 1;
                let v = args.get(i).ok_or_else(|| QuetzalcoatlError::StorageError {
                    detail: String::from("--text 缺少正文"),
                })?;
                text = Some(v.clone());
            }
            "--to" => {
                i += 1;
                let v = args.get(i).ok_or_else(|| QuetzalcoatlError::StorageError {
                    detail: String::from("--to 缺少目标"),
                })?;
                destination = Some(v.clone());
            }
            "--home" => {
                i += 1;
                let v = args.get(i).ok_or_else(|| QuetzalcoatlError::StorageError {
                    detail: String::from("--home 缺少目录参数"),
                })?;
                home = Some(PathBuf::from(v));
            }
            "--name" => {
                i += 1;
                let v = args.get(i).ok_or_else(|| QuetzalcoatlError::StorageError {
                    detail: String::from("--name 缺少通道名"),
                })?;
                channel = Some(v.clone());
            }
            other if matches!(other, "list" | "status" | "enable" | "disable" | "send") => {
                action = Some(String::from(other));
            }
            other if !other.starts_with('-') && channel.is_none() => {
                channel = Some(String::from(other));
            }
            other => {
                return Err(QuetzalcoatlError::StorageError {
                    detail: format!("未知选项: {other}"),
                });
            }
        }
        i += 1;
    }
    let qz_home = resolve_quetzalcoatl_home(home);
    let client = require_daemon(&qz_home)?;
    let action = action.unwrap_or_else(|| String::from("list"));
    let response = match action.as_str() {
        "list" | "status" => client.call(&IpcRequest::ChannelList)?,
        "enable" | "disable" => {
            let name = channel.ok_or_else(|| {
                QuetzalcoatlError::invalid_id(
                    "ChannelId",
                    String::from("必须提供通道名，例如 `qz channel enable feishu`"),
                )
            })?;
            if action == "enable" {
                client.call(&IpcRequest::ChannelEnable { channel: name })?
            } else {
                client.call(&IpcRequest::ChannelDisable { channel: name })?
            }
        }
        "send" => {
            let name = channel.ok_or_else(|| {
                QuetzalcoatlError::invalid_id(
                    "ChannelId",
                    String::from(
                        "必须提供通道名，例如 `qz channel send telegram --text hi --to 123`",
                    ),
                )
            })?;
            let text = text.ok_or_else(|| {
                QuetzalcoatlError::invalid_id("ChannelText", String::from("必须提供 --text <正文>"))
            })?;
            client.call(&IpcRequest::ChannelDeliver {
                channel: name,
                destination,
                text,
            })?
        }
        other => {
            return Err(QuetzalcoatlError::StorageError {
                detail: format!("未知 channel 子命令 `{other}`"),
            });
        }
    };
    match response {
        IpcResponse::Channels(rows) => {
            if json_mode {
                print_json(&rows)?;
            } else {
                print_channel_health_text(&rows);
            }
            Ok(())
        }
        IpcResponse::ChannelUpdate(row) => {
            if json_mode {
                print_json(&row)?;
            } else {
                print_channel_health_text(std::slice::from_ref(&row));
            }
            Ok(())
        }
        IpcResponse::ChannelDelivery(report) => {
            if json_mode {
                print_json(&report)?;
            } else {
                println!(
                    "delivered channel={} destination={} parts={} truncated={}",
                    report.channel, report.destination, report.parts, report.truncated
                );
            }
            Ok(())
        }
        IpcResponse::Error { code, detail } => Err(map_ipc_error_code(&code, detail)),
        other => Err(QuetzalcoatlError::StorageError {
            detail: format!("未知的 IPC 响应: {other:?}"),
        }),
    }
}

const DOMAIN_USAGE_TEXT: &str = "\
Usage: qz domain <list | show <id> | use <id>> [--json] [--home <dir>]

本版本仅完成领域包的声明、校验与切换审计；
实机执行（紧急告警、引用强制、答案拦截）随 Runner 接入生效。
";

#[derive(Clone, Debug, PartialEq, Eq)]
enum DomainCommand {
    List,
    Show(String),
    Use(String),
}

/// 严格解析 `qz domain` 参数：`list` 不接受额外位置参数（避免静默忽略用户输入）。
fn parse_domain_command(args: &[String]) -> Result<(DomainCommand, bool, Option<PathBuf>)> {
    let mut home: Option<PathBuf> = None;
    let mut json_mode = false;
    let mut action: Option<String> = None;
    let mut pack: Option<String> = None;
    let mut i = 0usize;
    while i < args.len() {
        match args[i].as_str() {
            "--json" => json_mode = true,
            "--home" => {
                i += 1;
                let value = args.get(i).ok_or_else(|| QuetzalcoatlError::StorageError {
                    detail: String::from("--home 缺少目录参数"),
                })?;
                home = Some(PathBuf::from(value));
            }
            other if matches!(other, "list" | "show" | "use") => {
                action = Some(String::from(other));
            }
            other if !other.starts_with('-') && pack.is_none() => {
                pack = Some(String::from(other));
            }
            other => {
                return Err(QuetzalcoatlError::StorageError {
                    detail: format!("qz domain 未知参数: {other}"),
                });
            }
        }
        i += 1;
    }

    let action = action.unwrap_or_else(|| String::from("list"));
    let command = match action.as_str() {
        "list" => {
            if let Some(extra) = pack {
                return Err(QuetzalcoatlError::invalid_id(
                    "DomainPackId",
                    format!(
                        "qz domain list 不接受额外参数 `{extra}`；查看单个领域包请用 `qz domain show {extra}`"
                    ),
                ));
            }
            DomainCommand::List
        }
        "show" => DomainCommand::Show(pack.ok_or_else(|| {
            QuetzalcoatlError::invalid_id(
                "DomainPackId",
                String::from("必须提供领域包 ID，例如 `qz domain show eldercare-guardian`"),
            )
        })?),
        "use" => DomainCommand::Use(pack.ok_or_else(|| {
            QuetzalcoatlError::invalid_id(
                "DomainPackId",
                String::from("必须提供领域包 ID，例如 `qz domain use eldercare-guardian`"),
            )
        })?),
        other => {
            return Err(QuetzalcoatlError::StorageError {
                detail: format!("qz domain 未知子命令: {other}（支持 list / show / use）"),
            });
        }
    };
    Ok((command, json_mode, home))
}

fn run_domain(args: &[String]) -> Result<()> {
    if args
        .iter()
        .any(|a| matches!(a.as_str(), "-h" | "--help" | "help"))
    {
        print!("{DOMAIN_USAGE_TEXT}");
        return Ok(());
    }

    let (command, json_mode, home) = parse_domain_command(args)?;
    let qz_home = resolve_quetzalcoatl_home(home);
    let client = require_daemon(&qz_home)?;

    let response = match command {
        DomainCommand::List => client.call(&IpcRequest::DomainList)?,
        DomainCommand::Show(id) => client.call(&IpcRequest::DomainShow { id })?,
        DomainCommand::Use(id) => client.call(&IpcRequest::DomainUse { id })?,
    };

    match response {
        IpcResponse::DomainPacks {
            packs,
            repair_report,
        } => {
            if json_mode {
                print_json(&serde_json::json!({
                    "packs": packs,
                    "repairReport": repair_report,
                }))?;
            } else {
                println!("domain packs ({}):", packs.len());
                for row in &packs {
                    println!(
                        "  {} {} v{} {}{}",
                        if row.active { "*" } else { "-" },
                        row.id,
                        row.version,
                        row.display_name,
                        if row.active { "  [active]" } else { "" }
                    );
                    println!(
                        "      guardian={} locales={} verifier={}",
                        row.guardian_label,
                        row.locales.join(","),
                        row.verifier_rule_kinds.join(",")
                    );
                }
                if let Some(report) = repair_report {
                    println!("audit repaired from spine: {report}");
                }
                println!(
                    "note: 本版本仅完成领域包的声明、校验与切换审计；实机执行（紧急告警、引用强制、答案拦截）随 Runner 接入生效"
                );
            }
            Ok(())
        }
        IpcResponse::DomainPack(view) => {
            if json_mode {
                print_json(view.as_ref())?;
            } else {
                let summary = &view.summary;
                println!(
                    "domain {} ({}) v{}",
                    summary.id, summary.display_name, summary.version
                );
                println!("  description: {}", summary.description);
                println!("  guardian: {}", summary.guardian_label);
                println!("  locales: {}", summary.locales.join(","));
                println!("  role tools: {}", view.role_tool_whitelist.join(","));
                println!("  capabilities: {}", view.required_capabilities.join(","));
                println!("  sinks: {}", view.required_sinks.join(","));
                println!("  verifier: {}", summary.verifier_rule_kinds.join(","));
                println!("  conscience seed:");
                for entry in &view.conscience_seed.entries {
                    println!(
                        "    [{}] {} — {}",
                        entry.tier.as_str(),
                        entry.id,
                        entry.title
                    );
                }
                println!(
                    "  quiet hours: {}->{}",
                    view.envelope.outbound.quiet_hours.start_local_hour,
                    view.envelope.outbound.quiet_hours.end_local_hour
                );
                println!(
                    "  budget ceiling (micros): {}",
                    view.envelope.budget.ceiling_micros
                );
                println!(
                    "  emergency: enabled={} contacts={} bypass_sleep={} partition_local={}",
                    view.envelope.emergency.enabled,
                    view.envelope.emergency.contacts.len(),
                    view.envelope.emergency.bypass_sleep_inhibition,
                    view.envelope.emergency.allow_local_alert_under_partition
                );
                println!(
                    "  immutable fields: {}",
                    view.envelope.immutable_fields.join(",")
                );
                println!(
                    "note: 本版本仅完成领域包的声明、校验与切换审计；实机执行（紧急告警、引用强制、答案拦截）随 Runner 接入生效"
                );
            }
            Ok(())
        }
        IpcResponse::DomainActivated(outcome) => {
            if json_mode {
                print_json(outcome.as_ref())?;
            } else {
                match outcome.as_ref() {
                    quetzalcoatl_domains::PackSwitchOutcome::Activated(audit) => println!(
                        "domain activated: {} -> {} (guardian={}, at={})",
                        audit.from_pack_id, audit.to_pack_id, audit.guardian_label, audit.at_ms
                    ),
                    quetzalcoatl_domains::PackSwitchOutcome::Unchanged { active_pack_id } => {
                        println!("domain unchanged: {active_pack_id} (no audit appended)")
                    }
                }
            }
            Ok(())
        }
        IpcResponse::Error { code, detail } => Err(map_ipc_error_code(&code, detail)),
        other => Err(QuetzalcoatlError::StorageError {
            detail: format!("未知的 IPC 响应: {other:?}"),
        }),
    }
}

fn run_sayit(args: &[String]) -> Result<()> {
    let mut home: Option<PathBuf> = None;
    let mut json_mode = false;
    let mut path: Option<PathBuf> = None;
    let mut batch_dir: Option<PathBuf> = None;
    let mut action: Option<String> = None;
    let mut i = 0usize;
    while i < args.len() {
        match args[i].as_str() {
            "--json" => json_mode = true,
            "--home" => {
                i += 1;
                let v = args.get(i).ok_or_else(|| QuetzalcoatlError::StorageError {
                    detail: String::from("--home 缺少目录参数"),
                })?;
                home = Some(PathBuf::from(v));
            }
            "--path" => {
                i += 1;
                let v = args.get(i).ok_or_else(|| QuetzalcoatlError::StorageError {
                    detail: String::from("--path 缺少快照路径"),
                })?;
                path = Some(PathBuf::from(v));
            }
            "--batch" => {
                i += 1;
                let v = args.get(i).ok_or_else(|| QuetzalcoatlError::StorageError {
                    detail: String::from("--batch 缺少目录参数"),
                })?;
                batch_dir = Some(PathBuf::from(v));
            }
            "ingest" => action = Some(String::from("ingest")),
            other => {
                return Err(QuetzalcoatlError::StorageError {
                    detail: format!("未知选项: {other}"),
                });
            }
        }
        i += 1;
    }
    if action.as_deref() != Some("ingest") {
        return Err(QuetzalcoatlError::StorageError {
            detail: String::from("用法: qz sayit ingest --path <snapshot> [--batch <dir>]"),
        });
    }
    if path.is_none() && batch_dir.is_none() {
        return Err(QuetzalcoatlError::invalid_id(
            "SayItPath",
            String::from("必须提供 --path <snapshot> 或 --batch <dir>"),
        ));
    }
    let qz_home = resolve_quetzalcoatl_home(home);
    let client = require_daemon(&qz_home)?;
    match client.call(&IpcRequest::SayItIngest { path, batch_dir })? {
        IpcResponse::SayItIngest(outcomes) => {
            if json_mode {
                print_json(&outcomes)?;
            } else {
                for outcome in &outcomes {
                    if let Some(receipt) = &outcome.receipt {
                        println!(
                            "{}: {} (branches +{}, leaves +{}, reembed_queued={})",
                            outcome.path.display(),
                            receipt.status,
                            receipt.added_branches,
                            receipt.added_leaves,
                            receipt.queued_reembed
                        );
                    } else {
                        println!(
                            "{}: {} {}",
                            outcome.path.display(),
                            outcome.error_code.as_deref().unwrap_or("ERROR"),
                            outcome.error_detail.as_deref().unwrap_or("")
                        );
                    }
                }
            }
            Ok(())
        }
        IpcResponse::Error { code, detail } => Err(map_ipc_error_code(&code, detail)),
        other => Err(QuetzalcoatlError::StorageError {
            detail: format!("未知的 IPC 响应: {other:?}"),
        }),
    }
}

fn run_webhook(args: &[String]) -> Result<()> {
    let mut home: Option<PathBuf> = None;
    let mut json_mode = false;
    let mut action: Option<String> = None;
    let mut after = 0i64;
    let mut limit = 100u32;
    let mut i = 0usize;
    while i < args.len() {
        match args[i].as_str() {
            "--json" => json_mode = true,
            "--home" => {
                i += 1;
                let v = args.get(i).ok_or_else(|| QuetzalcoatlError::StorageError {
                    detail: String::from("--home 缺少目录参数"),
                })?;
                home = Some(PathBuf::from(v));
            }
            "--after" => {
                i += 1;
                let v = args.get(i).ok_or_else(|| QuetzalcoatlError::StorageError {
                    detail: String::from("--after 缺少游标"),
                })?;
                after = v
                    .parse::<i64>()
                    .map_err(|e| QuetzalcoatlError::StorageError {
                        detail: format!("非法 --after: {e}"),
                    })?;
            }
            "--limit" => {
                i += 1;
                let v = args.get(i).ok_or_else(|| QuetzalcoatlError::StorageError {
                    detail: String::from("--limit 缺少数量"),
                })?;
                limit = v
                    .parse::<u32>()
                    .map_err(|e| QuetzalcoatlError::StorageError {
                        detail: format!("非法 --limit: {e}"),
                    })?;
            }
            "pull" | "status" | "register" | "rotate" => {
                action = Some(String::from(args[i].as_str()))
            }
            other => {
                return Err(QuetzalcoatlError::StorageError {
                    detail: format!("未知选项: {other}"),
                });
            }
        }
        i += 1;
    }
    let qz_home = resolve_quetzalcoatl_home(home);
    let client = require_daemon(&qz_home)?;
    match action.as_deref().unwrap_or("status") {
        "pull" => match client.call(&IpcRequest::WebhookPull { after, limit })? {
            IpcResponse::WebhookPull(report) => {
                if json_mode {
                    print_json(&report)?;
                } else {
                    println!(
                        "pulled={} persisted={} acked={} queue_depth={} next_cursor={}",
                        report.pulled,
                        report.persisted,
                        report.acked,
                        report.queue_depth,
                        report.next_cursor
                    );
                    for failure in &report.failures {
                        println!(
                            "  - {} [{}] {}",
                            failure.event_id, failure.error_code, failure.detail
                        );
                    }
                }
                Ok(())
            }
            IpcResponse::Error { code, detail } => Err(map_ipc_error_code(&code, detail)),
            other => Err(QuetzalcoatlError::StorageError {
                detail: format!("未知的 IPC 响应: {other:?}"),
            }),
        },
        "register" | "rotate" => {
            match client.call(&IpcRequest::WebhookRegisterKey {
                rotate: action.as_deref() == Some("rotate"),
            })? {
                IpcResponse::WebhookQueueStatus(status) => {
                    if json_mode {
                        print_json(&status)?;
                    } else {
                        println!(
                            "registered={} key_id={} device_id={} queue_depth={}",
                            status.registered, status.key_id, status.device_id, status.queue_depth
                        );
                    }
                    Ok(())
                }
                IpcResponse::Error { code, detail } => Err(map_ipc_error_code(&code, detail)),
                other => Err(QuetzalcoatlError::StorageError {
                    detail: format!("未知的 IPC 响应: {other:?}"),
                }),
            }
        }
        "status" => match client.call(&IpcRequest::WebhookStatus)? {
            IpcResponse::WebhookQueueStatus(status) => {
                if json_mode {
                    print_json(&status)?;
                } else {
                    println!(
                        "registered={} key_id={} device_id={} queue_depth={} max_queue={}",
                        status.registered,
                        status.key_id,
                        status.device_id,
                        status.queue_depth,
                        status.max_queue
                    );
                }
                Ok(())
            }
            IpcResponse::Error { code, detail } => Err(map_ipc_error_code(&code, detail)),
            other => Err(QuetzalcoatlError::StorageError {
                detail: format!("未知的 IPC 响应: {other:?}"),
            }),
        },
        other => Err(QuetzalcoatlError::StorageError {
            detail: format!("未知 webhook 子命令 `{other}`"),
        }),
    }
}

/// 读口令：`--passphrase-stdin` 时读标准输入的第一行；否则在终端上提示输入（不回显）。
fn read_passphrase(from_stdin: bool, prompt: &str) -> Result<String> {
    use std::io::{BufRead, IsTerminal};
    let stdin = std::io::stdin();
    let interactive = !from_stdin && stdin.is_terminal();
    if interactive {
        eprint!("{prompt}");
        let _ = std::io::stderr().flush();
        let _ = Command::new("stty")
            .arg("-echo")
            .stdin(Stdio::inherit())
            .status();
    }
    let mut line = String::new();
    let read = stdin.lock().read_line(&mut line);
    if interactive {
        let _ = Command::new("stty")
            .arg("echo")
            .stdin(Stdio::inherit())
            .status();
        eprintln!();
    }
    read.map_err(|e| QuetzalcoatlError::StorageError {
        detail: format!("读口令失败: {e}"),
    })?;
    let passphrase = line.trim_end_matches(['\r', '\n']).to_owned();
    if passphrase.is_empty() {
        return Err(QuetzalcoatlError::PermissionDenied {
            detail: String::from("没有输入口令。"),
        });
    }
    Ok(passphrase)
}

/// `qz reflect`：让他现在就回想一次最近的相处（平时在你不在场时自己进行）。
fn run_reflect(args: &[String]) -> Result<()> {
    let quiet = args.iter().any(|a| a == "--quiet");
    let speak = args.iter().any(|a| a == "--speak-first");
    let rest: Vec<String> = args
        .iter()
        .filter(|a| *a != "--quiet" && *a != "--speak-first")
        .cloned()
        .collect();
    let home = parse_optional_home(&rest)?;
    let qz_home = resolve_quetzalcoatl_home(home);
    if quiet || speak {
        quetzalcoatl_daemon::reflection::set_quiet(&qz_home, quiet)?;
        println!(
            "{}",
            if quiet {
                "他不再先开口。用 qz reflect --speak-first 恢复。"
            } else {
                "他会在有话想说时，在下次见面开场提一句（一天至多一次）。"
            }
        );
        return Ok(());
    }
    let client = require_daemon(&qz_home)?.with_timeout(Duration::from_secs(300));
    match client.call(&IpcRequest::ReflectNow)? {
        IpcResponse::Reflection(report) => {
            if report.ran {
                println!(
                    "回想了一段相处：提出 {} 条，留下 {} 条，{} 条等更多证据。",
                    report.proposed, report.accepted, report.pending
                );
            } else {
                println!("这次没有回想：{}。", report.note);
            }
            Ok(())
        }
        IpcResponse::Error { detail, .. } => Err(QuetzalcoatlError::StorageError { detail }),
        other => Err(QuetzalcoatlError::StorageError {
            detail: format!("意外的回答: {other:?}"),
        }),
    }
}

/// `qz import <导出包>`：把导出恢复进一个空的家目录。
fn run_import(args: &[String]) -> Result<()> {
    let mut home: Option<PathBuf> = None;
    let mut zip_path: Option<PathBuf> = None;
    let mut from_stdin = false;
    let mut i = 0usize;
    while i < args.len() {
        match args[i].as_str() {
            "--passphrase-stdin" => from_stdin = true,
            "--home" => home = Some(PathBuf::from(parse_flag_value(args, &mut i, "--home")?)),
            other if zip_path.is_none() => zip_path = Some(PathBuf::from(other)),
            other => {
                return Err(QuetzalcoatlError::StorageError {
                    detail: format!("qz import 多余或未知参数: {other}"),
                });
            }
        }
        i += 1;
    }
    let zip_path = zip_path.ok_or_else(|| QuetzalcoatlError::StorageError {
        detail: String::from("用法: qz import <导出包> [--passphrase-stdin]"),
    })?;
    let qz_home = resolve_quetzalcoatl_home(home);
    let passphrase = read_passphrase(from_stdin, "导出时的口令: ")?;
    let report = restore_offline(&qz_home, &zip_path, &passphrase)?;
    println!(
        "{} 回来了：{} 条往事，{} 条记录。运行 qz up 启动，然后打开你的宿主。",
        report.agent_name, report.memories, report.events_imported
    );
    Ok(())
}

fn run_export(args: &[String]) -> Result<()> {
    let mut home: Option<PathBuf> = None;
    let mut include_sealed_spine = true;
    let mut zip_path: Option<PathBuf> = None;
    let mut recoverable = true;
    let mut from_stdin = false;

    let mut i = 0usize;
    while i < args.len() {
        match args[i].as_str() {
            "--no-sealed-spine" => include_sealed_spine = false,
            "--readable-only" => recoverable = false,
            "--passphrase-stdin" => from_stdin = true,
            "--home" => {
                i += 1;
                let v = args.get(i).ok_or_else(|| QuetzalcoatlError::StorageError {
                    detail: String::from("--home 缺少目录参数"),
                })?;
                home = Some(PathBuf::from(v));
            }
            other if zip_path.is_none() => zip_path = Some(PathBuf::from(other)),
            other => {
                return Err(QuetzalcoatlError::StorageError {
                    detail: format!("qz export 多余或未知参数: {other}"),
                });
            }
        }
        i += 1;
    }

    let target_zip = zip_path.ok_or_else(|| QuetzalcoatlError::StorageError {
        detail: String::from("用法: qz export <zip_path>"),
    })?;
    let qz_home = resolve_quetzalcoatl_home(home);
    // 没有终端、也没有用 --passphrase-stdin 时，问不了口令：只导出能读的那一份。
    let can_ask = from_stdin || std::io::IsTerminal::is_terminal(&std::io::stdin());
    let passphrase = if recoverable && can_ask {
        Some(read_passphrase(
            from_stdin,
            "口令（用来封存恢复包；第一次输入即设定）: ",
        )?)
    } else {
        None
    };
    let (_via_ipc, can_restore) = export_offline_or_via_ipc(
        &qz_home,
        &target_zip,
        ZipExportOptions {
            include_spine_packs: include_sealed_spine,
        },
        passphrase.as_deref(),
    )?;
    if can_restore {
        println!(
            "已导出到 {}。在另一台机器上用 qz import 和这个口令恢复。",
            target_zip.display()
        );
    } else {
        println!("已导出到 {}（只能阅读，不能恢复）。", target_zip.display());
    }
    Ok(())
}

fn run_import_v1(args: &[String]) -> Result<()> {
    let mut home: Option<PathBuf> = None;
    let mut soul_dir: Option<PathBuf> = None;
    let mut db_paths = Vec::<PathBuf>::new();

    let mut i = 0usize;
    while i < args.len() {
        match args[i].as_str() {
            "--home" => {
                i += 1;
                let v = args.get(i).ok_or_else(|| QuetzalcoatlError::StorageError {
                    detail: String::from("--home 缺少目录参数"),
                })?;
                home = Some(PathBuf::from(v));
            }
            "--soul-dir" => {
                i += 1;
                let v = args.get(i).ok_or_else(|| QuetzalcoatlError::StorageError {
                    detail: String::from("--soul-dir 缺少目录参数"),
                })?;
                soul_dir = Some(PathBuf::from(v));
            }
            "--db" => {
                i += 1;
                let v = args.get(i).ok_or_else(|| QuetzalcoatlError::StorageError {
                    detail: String::from("--db 缺少数据库路径参数"),
                })?;
                db_paths.push(PathBuf::from(v));
            }
            other => {
                return Err(QuetzalcoatlError::StorageError {
                    detail: format!("qz import-v1 未知参数: {other}"),
                });
            }
        }
        i += 1;
    }

    let soul = soul_dir.ok_or_else(|| QuetzalcoatlError::StorageError {
        detail: String::from("用法: qz import-v1 --soul-dir <dir> [--db <path>...]"),
    })?;
    let qz_home = resolve_quetzalcoatl_home(home);
    let (report, via_ipc) = import_v1_offline_or_via_ipc(&qz_home, Path::new(&soul), &db_paths)?;
    println!(
        "import-v1 complete (mode={}): events={}, memories={}, threads={}, messages={}, skipped_duplicates={}",
        if via_ipc { "ipc" } else { "offline" },
        report.imported_events,
        report.memories_imported,
        report.threads_imported,
        report.messages_imported,
        report.skipped_duplicates
    );
    Ok(())
}

fn parse_optional_home(args: &[String]) -> Result<Option<PathBuf>> {
    let mut home = None;
    let mut i = 0usize;
    while i < args.len() {
        if args[i] == "--home" {
            i += 1;
            let v = args.get(i).ok_or_else(|| QuetzalcoatlError::StorageError {
                detail: String::from("--home 缺少目录参数"),
            })?;
            home = Some(PathBuf::from(v));
        } else {
            return Err(QuetzalcoatlError::StorageError {
                detail: format!("未知选项: {}", args[i]),
            });
        }
        i += 1;
    }
    Ok(home)
}

fn parse_home_and_json_flags(args: &[String]) -> Result<(Option<PathBuf>, bool)> {
    let mut home = None;
    let mut json_mode = false;
    let mut i = 0usize;
    while i < args.len() {
        match args[i].as_str() {
            "--json" => json_mode = true,
            "--home" => {
                i += 1;
                let v = args.get(i).ok_or_else(|| QuetzalcoatlError::StorageError {
                    detail: String::from("--home 缺少目录参数"),
                })?;
                home = Some(PathBuf::from(v));
            }
            other => {
                return Err(QuetzalcoatlError::StorageError {
                    detail: format!("未知选项: {other}"),
                });
            }
        }
        i += 1;
    }
    Ok((home, json_mode))
}

fn dispatch_cli(raw_args: Vec<String>) -> Result<()> {
    let Some((subcmd, rest)) = raw_args.split_first() else {
        print!("{USAGE_TEXT}");
        return Ok(());
    };
    match subcmd.as_str() {
        "-h" | "--help" | "help" => {
            print!("{USAGE_TEXT}");
            Ok(())
        }
        "-V" | "--version" | "version" => {
            println!("{VERSION_BANNER}");
            Ok(())
        }
        "up" => run_up(rest),
        "down" => run_down(rest),
        "open" => run_open(rest),
        "status" => run_status(rest),
        "agents" => run_agents(rest),
        "delegate" => run_delegate(rest),
        "connect" => run_connect(rest),
        "doctor" => run_doctor(rest),
        "hook" => run_host_hook(rest),
        "mcp" => run_host_mcp(rest),
        "statusline" => run_host_status_line(rest),
        "export" => run_export(rest),
        "import-v1" => run_import_v1(rest),
        "login" => run_login(rest),
        "pair" => run_pair(rest),
        "nodes" => run_nodes(rest),
        "group" => run_group(rest),
        "channel" => run_channel(rest),
        "sayit" => run_sayit(rest),
        "import" => run_import(rest),
        "reflect" => run_reflect(rest),
        "webhook" => run_webhook(rest),
        "domain" => run_domain(rest),
        other => Err(QuetzalcoatlError::StorageError {
            detail: format!("未知子命令 `{other}`\n{USAGE_TEXT}"),
        }),
    }
}

fn parse_uuid_agent(raw: &str, flag: &str) -> Result<AgentId> {
    raw.parse::<AgentId>()
        .map_err(|err| QuetzalcoatlError::invalid_id(flag, format!("非法 Agent ID `{raw}`: {err}")))
}

/// 从守护进程的 `WatermarkConflict` 展示文本里还原 (last_seen, head)。
fn parse_watermark_seqs(detail: &str) -> (u64, u64) {
    let extract = |key: &str| -> u64 {
        detail
            .split(key)
            .nth(1)
            .and_then(|rest| rest.split(|c: char| !c.is_ascii_digit()).next())
            .and_then(|digits| digits.parse::<u64>().ok())
            .unwrap_or(0)
    };
    (extract("last_seen="), extract("head="))
}

fn group_ipc_error(code: &str, detail: &str) -> QuetzalcoatlError {
    match code {
        "FLOOR_SILENCED" => QuetzalcoatlError::FloorSilenced {
            detail: String::from(detail),
        },
        "WATERMARK_CONFLICT" => {
            // 保留守护进程回报的真实序号，绝不退化成 (0,0)。
            let (last_seen_seq, head_seq) = parse_watermark_seqs(detail);
            QuetzalcoatlError::WatermarkConflict {
                last_seen_seq,
                head_seq,
            }
        }
        "PERMISSION_DENIED" => QuetzalcoatlError::PermissionDenied {
            detail: String::from(detail),
        },
        "CONSCIENCE_VIOLATION" => QuetzalcoatlError::ConscienceViolation {
            detail: String::from(detail),
        },
        "DELIVERY_REFUSED" => QuetzalcoatlError::DeliveryRefused {
            detail: String::from(detail),
        },
        "INTEGRITY_VIOLATION" => QuetzalcoatlError::IntegrityViolation {
            detail: String::from(detail),
        },
        other => QuetzalcoatlError::StorageError {
            detail: format!("{other}: {detail}"),
        },
    }
}

fn require_group_room(room: Option<String>) -> Result<String> {
    room.ok_or_else(|| QuetzalcoatlError::invalid_id("qz group", "缺少 --room <room_id>"))
}

#[allow(clippy::too_many_lines)]
fn run_group(args: &[String]) -> Result<()> {
    let Some((subcmd, rest)) = args.split_first() else {
        return Err(QuetzalcoatlError::invalid_id(
            "qz group",
            "group 需要子命令: create | invite | join | leave | list | send | members | revoke-steward",
        ));
    };
    let mut home: Option<PathBuf> = None;
    let mut room: Option<String> = None;
    let mut level: u8 = 1;
    let mut key_package: Option<String> = None;
    let mut agent: Option<AgentId> = None;
    let mut welcome: Option<String> = None;
    let mut ratchet_tree: Option<String> = None;
    let mut text = String::new();
    let mut identity: Option<String> = None;
    let mut mentions: Vec<Mention> = Vec::new();
    let mut hops: u32 = 0;
    let mut kind = String::from("message");
    let mut parent_seq: u64 = 0;
    let mut ciphertext: Option<String> = None;
    let mut peek = false;
    let mut delivered_seq: Option<u64> = None;
    let mut after: u64 = 0;
    let mut limit: u32 = 50;
    let mut reason: Option<String> = None;
    let mut human_typing = false;
    let mut sender_kind = GroupSenderWire::Owner;
    let mut as_steward = false;
    let mut json_mode = false;

    let mut i = 0usize;
    while i < rest.len() {
        match rest[i].as_str() {
            "--home" => {
                i += 1;
                let v = rest.get(i).ok_or_else(|| QuetzalcoatlError::StorageError {
                    detail: String::from("--home 缺少目录参数"),
                })?;
                home = Some(PathBuf::from(v));
            }
            "--room" => {
                i += 1;
                room = Some(
                    rest.get(i)
                        .ok_or_else(|| QuetzalcoatlError::invalid_id("--room", "缺少房间 ID"))?
                        .clone(),
                );
            }
            "--level" => {
                i += 1;
                level = rest
                    .get(i)
                    .ok_or_else(|| QuetzalcoatlError::invalid_id("--level", "缺少保密等级"))?
                    .parse::<u8>()
                    .map_err(|err| QuetzalcoatlError::invalid_id("--level", err.to_string()))?;
            }
            "--key-package" => {
                i += 1;
                key_package = Some(
                    rest.get(i)
                        .ok_or_else(|| {
                            QuetzalcoatlError::invalid_id("--key-package", "缺少 base64")
                        })?
                        .clone(),
                );
            }
            "--agent" => {
                i += 1;
                agent = Some(parse_uuid_agent(
                    rest.get(i)
                        .ok_or_else(|| QuetzalcoatlError::invalid_id("--agent", "缺少 Agent ID"))?,
                    "--agent",
                )?);
            }
            "--welcome" => {
                i += 1;
                welcome = Some(
                    rest.get(i)
                        .ok_or_else(|| QuetzalcoatlError::invalid_id("--welcome", "缺少 base64"))?
                        .clone(),
                );
            }
            "--ratchet-tree" => {
                i += 1;
                ratchet_tree = Some(
                    rest.get(i)
                        .ok_or_else(|| {
                            QuetzalcoatlError::invalid_id("--ratchet-tree", "缺少 base64")
                        })?
                        .clone(),
                );
            }
            "--text" => {
                i += 1;
                text = rest
                    .get(i)
                    .ok_or_else(|| QuetzalcoatlError::invalid_id("--text", "缺少文本"))?
                    .clone();
            }
            "--identity" => {
                i += 1;
                identity = Some(
                    rest.get(i)
                        .ok_or_else(|| {
                            QuetzalcoatlError::invalid_id("--identity", "缺少 MLS 身份")
                        })?
                        .clone(),
                );
            }
            "--to" => {
                i += 1;
                mentions.push(Mention {
                    kind: MentionKind::Addressee,
                    target_agent_id: Some(parse_uuid_agent(
                        rest.get(i).ok_or_else(|| {
                            QuetzalcoatlError::invalid_id("--to", "缺少 Agent ID")
                        })?,
                        "--to",
                    )?),
                });
            }
            "--cc" => {
                i += 1;
                mentions.push(Mention {
                    kind: MentionKind::Cc,
                    target_agent_id: Some(parse_uuid_agent(
                        rest.get(i).ok_or_else(|| {
                            QuetzalcoatlError::invalid_id("--cc", "缺少 Agent ID")
                        })?,
                        "--cc",
                    )?),
                });
            }
            "--agents" => mentions.push(Mention {
                kind: MentionKind::AllAgents,
                target_agent_id: None,
            }),
            "--humans" => mentions.push(Mention {
                kind: MentionKind::AllHumans,
                target_agent_id: None,
            }),
            "--hops" => {
                i += 1;
                hops = rest
                    .get(i)
                    .ok_or_else(|| QuetzalcoatlError::invalid_id("--hops", "缺少跳数"))?
                    .parse::<u32>()
                    .map_err(|err| QuetzalcoatlError::invalid_id("--hops", err.to_string()))?;
            }
            "--kind" => {
                i += 1;
                kind = rest
                    .get(i)
                    .ok_or_else(|| QuetzalcoatlError::invalid_id("--kind", "缺少 kind"))?
                    .clone();
            }
            "--parent" => {
                i += 1;
                parent_seq = rest
                    .get(i)
                    .ok_or_else(|| QuetzalcoatlError::invalid_id("--parent", "缺少父序号"))?
                    .parse::<u64>()
                    .map_err(|err| QuetzalcoatlError::invalid_id("--parent", err.to_string()))?;
            }
            "--peek" => peek = true,
            "--seq" => {
                i += 1;
                delivered_seq = Some(
                    rest.get(i)
                        .ok_or_else(|| QuetzalcoatlError::invalid_id("--seq", "缺少序号"))?
                        .parse::<u64>()
                        .map_err(|err| QuetzalcoatlError::invalid_id("--seq", err.to_string()))?,
                );
            }
            "--after" => {
                i += 1;
                after = rest
                    .get(i)
                    .ok_or_else(|| QuetzalcoatlError::invalid_id("--after", "缺少起始序号"))?
                    .parse::<u64>()
                    .map_err(|err| QuetzalcoatlError::invalid_id("--after", err.to_string()))?;
            }
            "--limit" => {
                i += 1;
                limit = rest
                    .get(i)
                    .ok_or_else(|| QuetzalcoatlError::invalid_id("--limit", "缺少条数"))?
                    .parse::<u32>()
                    .map_err(|err| QuetzalcoatlError::invalid_id("--limit", err.to_string()))?;
            }
            "--reason" => {
                i += 1;
                reason = Some(
                    rest.get(i)
                        .ok_or_else(|| QuetzalcoatlError::invalid_id("--reason", "缺少原因"))?
                        .clone(),
                );
            }
            "--ciphertext" => {
                i += 1;
                ciphertext = Some(
                    rest.get(i)
                        .ok_or_else(|| {
                            QuetzalcoatlError::invalid_id("--ciphertext", "缺少 base64 密文")
                        })?
                        .clone(),
                );
            }
            "--human-typing" => human_typing = true,
            "--steward" => as_steward = true,
            "--peer" => sender_kind = GroupSenderWire::PeerAgent,
            "--other-human" => sender_kind = GroupSenderWire::OtherHuman,
            "--json" => json_mode = true,
            other => {
                return Err(QuetzalcoatlError::invalid_id(
                    "qz group",
                    format!("未知选项 {other}"),
                ));
            }
        }
        i += 1;
    }

    let qz_home = resolve_quetzalcoatl_home(home);
    let client =
        IpcClient::connect_from_home(&qz_home)?.ok_or_else(|| QuetzalcoatlError::StorageError {
            detail: String::from("quetzalcoatld 尚未启动，请先运行 `qz up`"),
        })?;

    let request = match subcmd.as_str() {
        "create" => IpcRequest::GroupCreate {
            room_id: require_group_room(room)?,
            secrecy_level: level,
        },
        "invite" => match key_package {
            Some(kp) => {
                let agent = agent.ok_or_else(|| {
                    QuetzalcoatlError::invalid_id(
                        "qz group invite",
                        "邀请远端成员需要 --agent <id>",
                    )
                })?;
                IpcRequest::GroupAddMember {
                    room_id: require_group_room(room)?,
                    key_package_b64: kp,
                    agent_id: agent,
                    as_steward,
                }
            }
            None => IpcRequest::GroupInviteKeyPackage {
                room_id: require_group_room(room)?,
            },
        },
        "join" => IpcRequest::GroupJoin {
            room_id: require_group_room(room)?,
            welcome_b64: welcome.ok_or_else(|| {
                QuetzalcoatlError::invalid_id("qz group join", "缺少 --welcome <base64>")
            })?,
            ratchet_tree_b64: ratchet_tree.ok_or_else(|| {
                QuetzalcoatlError::invalid_id("qz group join", "缺少 --ratchet-tree <base64>")
            })?,
        },
        "leave" => IpcRequest::GroupLeave {
            room_id: require_group_room(room)?,
        },
        "sync" => IpcRequest::GroupSync {
            room_id: require_group_room(room)?,
        },
        "consume" => IpcRequest::GroupConsume {
            room_id: require_group_room(room)?,
        },
        "read" => IpcRequest::GroupRead {
            room_id: require_group_room(room)?,
            ciphertext_b64: ciphertext.ok_or_else(|| {
                QuetzalcoatlError::invalid_id("qz group read", "缺少 --ciphertext <base64>")
            })?,
            delivered_seq,
            peek,
        },
        "history" => IpcRequest::GroupHistory {
            room_id: require_group_room(room)?,
            after,
            limit,
        },
        "quarantine" => IpcRequest::GroupQuarantine {
            room_id: require_group_room(room)?,
            server_seq: delivered_seq.ok_or_else(|| {
                QuetzalcoatlError::invalid_id("qz group quarantine", "缺少 --seq <序号>")
            })?,
            reason: reason.ok_or_else(|| {
                QuetzalcoatlError::invalid_id("qz group quarantine", "缺少 --reason <原因>")
            })?,
        },
        "claim-owner" => IpcRequest::GroupClaimOwner {
            room_id: require_group_room(room)?,
        },
        "list" => IpcRequest::GroupList,
        "members" => IpcRequest::GroupMembers {
            room_id: require_group_room(room)?,
        },
        "send" => IpcRequest::GroupSend {
            room_id: require_group_room(room)?,
            text,
            mentions,
            sender_kind,
            consecutive_agent_hops: hops,
            human_typing_active: human_typing,
            kind,
            parent_seq,
        },
        "revoke-steward" => IpcRequest::GroupRevokeSteward {
            room_id: require_group_room(room)?,
            mls_identity: identity.ok_or_else(|| {
                QuetzalcoatlError::invalid_id("qz group revoke-steward", "缺少 --identity <mls-id>")
            })?,
        },
        other => {
            return Err(QuetzalcoatlError::invalid_id(
                "qz group",
                format!("未知 group 子命令 {other}"),
            ));
        }
    };

    let response = client.call(&request)?;
    if let IpcResponse::Error { code, detail } = response {
        return Err(group_ipc_error(&code, &detail));
    }
    if json_mode {
        println!(
            "{}",
            serde_json::to_string_pretty(&response).map_err(|err| {
                QuetzalcoatlError::SerializationError {
                    detail: err.to_string(),
                }
            })?
        );
        return Ok(());
    }
    match response {
        IpcResponse::GroupRooms(rooms) => {
            if rooms.is_empty() {
                println!("No group rooms joined.");
            }
            for summary in rooms {
                println!(
                    "{}  epoch={} members={} secrecy={} watermark={} hub={}",
                    summary.room_id,
                    summary.mls_epoch,
                    summary.members.len(),
                    summary.secrecy_level,
                    summary.last_seen_group_seq,
                    if summary.hub_connected {
                        "connected"
                    } else {
                        "local"
                    }
                );
            }
        }
        IpcResponse::GroupRoom(summary) => {
            println!(
                "room={} epoch={} secrecy={} members={:?}",
                summary.room_id, summary.mls_epoch, summary.secrecy_level, summary.members
            );
        }
        IpcResponse::GroupInvite(outcome) => {
            if let Some(kp) = outcome.key_package_b64 {
                println!("KeyPackage handoff (send to group owner):");
                println!("{kp}");
            }
            if let Some(welcome) = outcome.welcome_b64 {
                println!("Welcome handoff (send to joining member):");
                println!("{welcome}");
            }
            if let Some(tree) = outcome.ratchet_tree_b64 {
                println!("RatchetTree handoff:");
                println!("{tree}");
            }
            if let Some(commit) = outcome.commit_b64 {
                println!("Commit (publish via Hub):");
                println!("{commit}");
            }
            println!("mls_epoch={}", outcome.mls_epoch);
        }
        IpcResponse::GroupMembers(members) => {
            for member in members {
                println!(
                    "{}{}",
                    member.identity,
                    if member.is_self { "  [self]" } else { "" }
                );
            }
        }
        IpcResponse::GroupLeave(outcome) => {
            println!("room={} left={}", outcome.room_id, outcome.left);
        }
        IpcResponse::GroupSend(outcome) => {
            println!(
                "floor={} envelope={} epoch={} watermark={} server_seq={}",
                outcome.floor_action,
                outcome.authority_envelope,
                outcome.mls_epoch,
                outcome
                    .watermark_resolution
                    .unwrap_or_else(|| String::from("-")),
                outcome
                    .server_seq
                    .map_or_else(|| String::from("-"), |seq| seq.to_string())
            );
            if let Some(ciphertext) = outcome.ciphertext_b64 {
                println!("ciphertext_b64={ciphertext}");
            }
        }
        IpcResponse::GroupPlaintext { text } => {
            println!("{text}");
        }
        IpcResponse::GroupHistory(rows) => {
            for row in rows {
                println!(
                    "seq={} kind={} device={} epoch={} ciphertext_b64={}",
                    row.server_seq,
                    row.kind,
                    row.author_device_id,
                    row.mls_epoch,
                    row.ciphertext_b64
                );
            }
        }
        IpcResponse::GroupRevokeSteward(outcome) => {
            println!(
                "revoked={} grant={} rotated_epoch={} dropped_rights={}",
                outcome.revoked_identity,
                outcome.grant_id,
                outcome.rotated_epoch,
                outcome.dropped_management_rights
            );
        }
        other => {
            return Err(QuetzalcoatlError::SerializationError {
                detail: format!("群组命令收到非预期响应: {other:?}"),
            });
        }
    }
    Ok(())
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match dispatch_cli(args) {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            eprintln!("qz error [{}]: {err}", err.code());
            ExitCode::from(1)
        }
    }
}

#[cfg(test)]
mod domain_cli_tests {
    use super::*;

    fn args(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| String::from(*s)).collect()
    }

    #[test]
    fn usage_banners_state_the_real_runtime_boundary() {
        let marker = "本版本仅完成领域包的声明、校验与切换审计";
        assert!(USAGE_TEXT.contains(marker), "全局帮助必须说明实机执行边界");
        assert!(
            DOMAIN_USAGE_TEXT.contains(marker),
            "qz domain 帮助必须说明实机执行边界"
        );
        assert!(
            DOMAIN_USAGE_TEXT.contains("随 Runner 接入生效"),
            "qz domain 帮助必须说明何时真正生效"
        );
    }

    #[test]
    fn list_rejects_extra_positional_argument_instead_of_silently_ignoring()
    -> std::result::Result<(), Box<dyn std::error::Error>> {
        let err = parse_domain_command(&args(&["list", "eldercare-guardian"]))
            .err()
            .ok_or("多余参数必须报错")?;
        assert_eq!(err.code().as_str(), "INVALID_ID");
        assert!(
            err.to_string().contains("show eldercare-guardian"),
            "错误信息必须指引正确用法，实际: {err}"
        );
        Ok(())
    }

    #[test]
    fn show_and_use_require_exactly_one_pack_id() {
        assert!(matches!(
            parse_domain_command(&args(&["show", "eldercare-guardian"])),
            Ok((DomainCommand::Show(_), false, None))
        ));
        assert!(matches!(
            parse_domain_command(&args(&["use", "personal-companion"])),
            Ok((DomainCommand::Use(_), false, None))
        ));
        assert!(parse_domain_command(&args(&["show"])).is_err());
        assert!(parse_domain_command(&args(&["use"])).is_err());
        assert!(parse_domain_command(&args(&["show", "a", "b"])).is_err());
        assert!(matches!(
            parse_domain_command(&args(&["--json", "list"])),
            Ok((DomainCommand::List, true, None))
        ));
    }
}
