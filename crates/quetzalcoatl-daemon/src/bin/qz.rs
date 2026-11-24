#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]

//! `qz` — Quetzalcoatl 唯一简写终端命令行入口（自动本地 IPC 薄客户端切换，杜绝 `SQLITE_BUSY`）。

use std::fs::{self, OpenOptions};
use std::io::{self, BufRead, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use quetzalcoatl_daemon::local_ipc::GroupSenderWire;
use quetzalcoatl_daemon::{
    ChatRequest, DaemonConfig, DaemonFabricConfig, FabricLoginRequest, IpcClient, IpcRequest,
    IpcResponse, QuetzalcoatlDaemon, export_offline_or_via_ipc, import_v1_offline_or_via_ipc,
    resolve_quetzalcoatl_home,
};
use quetzalcoatl_group::floor_control::{Mention, MentionKind};
use quetzalcoatl_harness::{DiscoveryConfig, discover_coding_agents};
use quetzalcoatl_kernel::CleanRoomVerifierDag;
use quetzalcoatl_sandbox::SandboxCommand;
use quetzalcoatl_spine::ZipExportOptions;
use quetzalcoatl_types::{AgentId, DeviceId, QuetzalcoatlError, Result};

const VERSION_BANNER: &str = concat!("qz (Quetzalcoatl CLI) ", env!("CARGO_PKG_VERSION"));

const USAGE_TEXT: &str = "\
Usage:
  qz <COMMAND> [OPTIONS]

Commands:
  up          Start local quetzalcoatld daemon and wait for health ready
  down        Gracefully shut down running quetzalcoatld
  status      Show daemon, sovereign spine, heart and fabric status
  agents      Discover installed Coding Agents (<10ms parallel probe)
  chat        Send a message (--interactive or direct prompt)
  export      Export readable Markdown + Spine ZIP archive
  import-v1   Idempotently migrate legacy V1 soul repo and SQLite sessions
  login       Authenticate against quetzalcoatl-hub (OPAQUE PIN or Bearer token)
  pair        Quantum-safe X-Wing device pairing (start | join | approve)
  nodes       List fabric peers, path kind, Router holder and witness_epoch
  group       openmls 群组：create | invite | join | leave | list | send | members | revoke-steward
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

    let mut i = 0usize;
    while i < args.len() {
        match args[i].as_str() {
            "--json" => json_mode = true,
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

    let hub = hub_url.ok_or_else(|| QuetzalcoatlError::StorageError {
        detail: String::from(
            "用法: qz login --hub <url> (--pin <pin> | --token <token>) [--ca-file <pem>]",
        ),
    })?;
    if token.is_none() && pin.is_none() {
        return Err(QuetzalcoatlError::CredentialRejected {
            detail: String::from("qz login 需要 --pin 或 --token 之一"),
        });
    }
    let qz_home = resolve_quetzalcoatl_home(home);
    let client = require_daemon(&qz_home)?;
    let resp = client.call(&IpcRequest::FabricLogin(FabricLoginRequest {
        hub_url: hub,
        token,
        ca_file,
        pin,
        agent_id: agent,
        device_id: device,
    }))?;
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

fn run_chat(args: &[String]) -> Result<()> {
    let mut home: Option<PathBuf> = None;
    let mut interactive = false;
    let mut json_mode = false;
    let mut workspace_dir: Option<PathBuf> = None;
    let mut verifier_suite: Option<PathBuf> = None;
    let mut verifier_cmd: Option<String> = None;
    let mut msg_parts = Vec::<String>::new();

    let mut i = 0usize;
    while i < args.len() {
        match args[i].as_str() {
            "--interactive" | "-i" => interactive = true,
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
            other => msg_parts.push(String::from(other)),
        }
        i += 1;
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

    if interactive {
        let stdin = io::stdin();
        for line_res in stdin.lock().lines() {
            let line = line_res.map_err(|e| QuetzalcoatlError::StorageError {
                detail: format!("读取终端输入失败: {e}"),
            })?;
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            if trimmed == "exit" || trimmed == "/quit" {
                break;
            }
            send_single_chat_turn(
                &client,
                trimmed,
                workspace_dir.clone(),
                verifier_dag.clone(),
                json_mode,
            )?;
        }
        return Ok(());
    }

    let prompt = msg_parts.join(" ");
    if prompt.trim().is_empty() {
        return Err(QuetzalcoatlError::StorageError {
            detail: String::from("qz chat 需要传入消息文本或 --interactive"),
        });
    }
    send_single_chat_turn(&client, &prompt, workspace_dir, verifier_dag, json_mode)
}

fn send_single_chat_turn(
    client: &IpcClient,
    prompt: &str,
    workspace_dir: Option<PathBuf>,
    verifier_dag: Option<CleanRoomVerifierDag>,
    json_mode: bool,
) -> Result<()> {
    let resp = client.call(&IpcRequest::Chat(ChatRequest {
        message: String::from(prompt),
        thread_id: None,
        peer_id: None,
        workspace_dir,
        verifier_dag,
        router_attempted_forbidden_tools: Vec::new(),
    }))?;
    match resp {
        IpcResponse::Chat(chat_resp) => {
            if json_mode {
                let s = serde_json::to_string_pretty(&*chat_resp).map_err(|e| {
                    QuetzalcoatlError::SerializationError {
                        detail: e.to_string(),
                    }
                })?;
                println!("{s}");
            } else {
                println!("{}", chat_resp.reply);
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

fn map_ipc_error_code(code: &str, detail: String) -> QuetzalcoatlError {
    match code {
        "SANDBOX_VIOLATION" => QuetzalcoatlError::SandboxViolation { detail },
        "CREDENTIAL_REJECTED" => QuetzalcoatlError::CredentialRejected { detail },
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

fn run_export(args: &[String]) -> Result<()> {
    let mut home: Option<PathBuf> = None;
    let mut include_sealed_spine = true;
    let mut zip_path: Option<PathBuf> = None;

    let mut i = 0usize;
    while i < args.len() {
        match args[i].as_str() {
            "--no-sealed-spine" => include_sealed_spine = false,
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
    let via_ipc = export_offline_or_via_ipc(
        &qz_home,
        &target_zip,
        ZipExportOptions {
            include_spine_packs: include_sealed_spine,
        },
    )?;
    println!(
        "exported archive to {} (mode={})",
        target_zip.display(),
        if via_ipc { "ipc" } else { "offline" }
    );
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
        "status" => run_status(rest),
        "agents" => run_agents(rest),
        "chat" => run_chat(rest),
        "export" => run_export(rest),
        "import-v1" => run_import_v1(rest),
        "login" => run_login(rest),
        "pair" => run_pair(rest),
        "nodes" => run_nodes(rest),
        "group" => run_group(rest),
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
            peek,
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
