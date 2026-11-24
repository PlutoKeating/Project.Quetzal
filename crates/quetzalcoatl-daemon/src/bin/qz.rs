#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]

//! `qz` — Quetzalcoatl 唯一简写终端命令行入口（自动本地 IPC 薄客户端切换，杜绝 `SQLITE_BUSY`）。

use std::fs::{self, OpenOptions};
use std::io::{self, BufRead, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use quetzalcoatl_daemon::{
    ChatRequest, DaemonConfig, IpcClient, IpcRequest, IpcResponse, QuetzalcoatlDaemon,
    export_offline_or_via_ipc, import_v1_offline_or_via_ipc, resolve_quetzalcoatl_home,
};
use quetzalcoatl_harness::{DiscoveryConfig, discover_coding_agents};
use quetzalcoatl_kernel::CleanRoomVerifierDag;
use quetzalcoatl_sandbox::SandboxCommand;
use quetzalcoatl_spine::ZipExportOptions;
use quetzalcoatl_types::{QuetzalcoatlError, Result};

const VERSION_BANNER: &str = concat!("qz (Quetzalcoatl CLI) ", env!("CARGO_PKG_VERSION"));

const USAGE_TEXT: &str = "\
Usage:
  qz <COMMAND> [OPTIONS]

Commands:
  up          Start local quetzalcoatld daemon and wait for health ready
  down        Gracefully shut down running quetzalcoatld
  status      Show daemon, sovereign spine, and heart status
  agents      Discover installed Coding Agents (<10ms parallel probe)
  chat        Send a message (--interactive or direct prompt)
  export      Export readable Markdown + Spine ZIP archive
  import-v1   Idempotently migrate legacy V1 soul repo and SQLite sessions
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

    if foreground {
        let mut cfg = DaemonConfig::new(qz_home);
        if let Some(u) = upstream_url {
            cfg.upstream_endpoints.anthropic_base_url = u.clone();
            cfg.upstream_endpoints.openai_base_url = u.clone();
            cfg.upstream_endpoints.codex_chatgpt_base_url = u.clone();
            cfg.upstream_endpoints.gemini_base_url = u;
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
        other => Err(QuetzalcoatlError::StorageError {
            detail: format!("未知子命令 `{other}`\n{USAGE_TEXT}"),
        }),
    }
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
