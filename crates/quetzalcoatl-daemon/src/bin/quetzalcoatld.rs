#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]

//! `quetzalcoatld` — Quetzalcoatl 本机后台独占脊柱守护进程可执行入口。

use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::ExitCode;

use quetzalcoatl_daemon::{
    DaemonConfig, DaemonFabricConfig, QuetzalcoatlDaemon, resolve_quetzalcoatl_home,
};
use quetzalcoatl_types::{QuetzalcoatlError, Result};

const VERSION_BANNER: &str = concat!("quetzalcoatld ", env!("CARGO_PKG_VERSION"));

const HELP_TEXT: &str = "\
Usage:
  quetzalcoatld [OPTIONS]

Options:
  --home <dir>                Quetzalcoatl home directory (or QUETZALCOATL_HOME)
  --ipc-addr <ip:port>        Loopback IPC bind address (default 127.0.0.1:0)
  --gateway-addr <ip:port>    Loopback LLM gateway bind address (default 127.0.0.1:0)
  --upstream-url <url>        Override upstream LLM base URL
  --worker-bin <path>         Override Worker Coding Agent binary path
  --fabric-hub <url>          Enable quetzalcoatl-fabric against this quetzalcoatl-hub
  --fabric-ca-file <pem>      Custom Hub CA bundle (PEM or DER)
  --fabric-relay-url <url>    iroh relay URL (default: same as --fabric-hub)
  --fabric-qad-port <port>    Hub QAD UDP port (default 7842)
  --fabric-mdns <0|1>         Enable LAN mDNS peer discovery (default 1)
  -V, --version               Print version
  -h, --help                  Print help
";

enum DaemonCli {
    Help,
    Version,
    Run(Box<DaemonConfig>),
}

fn parse_args(args: Vec<String>) -> Result<DaemonCli> {
    let mut home: Option<PathBuf> = None;
    let mut ipc_addr: Option<SocketAddr> = None;
    let mut gateway_addr: Option<SocketAddr> = None;
    let mut upstream_url: Option<String> = None;
    let mut worker_bin: Option<PathBuf> = None;
    let mut fabric_hub: Option<String> = None;
    let mut fabric_ca_file: Option<PathBuf> = None;
    let mut fabric_relay_url: Option<String> = None;
    let mut fabric_qad_port: Option<u16> = None;
    let mut fabric_mdns: Option<bool> = None;

    let mut i = 0usize;
    while i < args.len() {
        match args[i].as_str() {
            "-h" | "--help" => return Ok(DaemonCli::Help),
            "-V" | "--version" => return Ok(DaemonCli::Version),
            "--home" => {
                i += 1;
                let v = args.get(i).ok_or_else(|| QuetzalcoatlError::StorageError {
                    detail: String::from("--home 缺少目录参数"),
                })?;
                home = Some(PathBuf::from(v));
            }
            "--ipc-addr" => {
                i += 1;
                let v = args.get(i).ok_or_else(|| QuetzalcoatlError::StorageError {
                    detail: String::from("--ipc-addr 缺少地址参数"),
                })?;
                ipc_addr =
                    Some(
                        v.parse::<SocketAddr>()
                            .map_err(|e| QuetzalcoatlError::StorageError {
                                detail: format!("非法 --ipc-addr: {e}"),
                            })?,
                    );
            }
            "--gateway-addr" => {
                i += 1;
                let v = args.get(i).ok_or_else(|| QuetzalcoatlError::StorageError {
                    detail: String::from("--gateway-addr 缺少地址参数"),
                })?;
                gateway_addr =
                    Some(
                        v.parse::<SocketAddr>()
                            .map_err(|e| QuetzalcoatlError::StorageError {
                                detail: format!("非法 --gateway-addr: {e}"),
                            })?,
                    );
            }
            "--upstream-url" => {
                i += 1;
                let v = args.get(i).ok_or_else(|| QuetzalcoatlError::StorageError {
                    detail: String::from("--upstream-url 缺少 URL 参数"),
                })?;
                upstream_url = Some(v.clone());
            }
            "--worker-bin" => {
                i += 1;
                let v = args.get(i).ok_or_else(|| QuetzalcoatlError::StorageError {
                    detail: String::from("--worker-bin 缺少路径参数"),
                })?;
                worker_bin = Some(PathBuf::from(v));
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
                    detail: format!("未知选项: {other}"),
                });
            }
        }
        i += 1;
    }

    let qz_home = resolve_quetzalcoatl_home(home);
    let mut cfg = DaemonConfig::new(qz_home);
    if let Some(ia) = ipc_addr {
        cfg.ipc_bind_addr = ia;
    }
    if let Some(ga) = gateway_addr {
        cfg.gateway_bind_addr = ga;
    }
    if let Some(u) = upstream_url {
        cfg.upstream_endpoints.anthropic_base_url = u.clone();
        cfg.upstream_endpoints.openai_base_url = u.clone();
        cfg.upstream_endpoints.codex_chatgpt_base_url = u.clone();
        cfg.upstream_endpoints.gemini_base_url = u;
    }
    if let Some(wb) = worker_bin {
        cfg.worker_binary_override = Some(wb);
    }
    if let Some(hub) = fabric_hub {
        cfg.fabric = Some(DaemonFabricConfig {
            relay_url: fabric_relay_url.unwrap_or_else(|| hub.clone()),
            hub_url: hub,
            hub_ca_file: fabric_ca_file,
            qad_port: fabric_qad_port.unwrap_or(7842),
            enable_mdns: fabric_mdns.unwrap_or(true),
            tick_interval_ms: 5_000,
        });
    }

    Ok(DaemonCli::Run(Box::new(cfg)))
}

fn main() -> ExitCode {
    let raw_args: Vec<String> = std::env::args().skip(1).collect();
    match parse_args(raw_args) {
        Ok(DaemonCli::Help) => {
            print!("{HELP_TEXT}");
            ExitCode::SUCCESS
        }
        Ok(DaemonCli::Version) => {
            println!("{VERSION_BANNER}");
            ExitCode::SUCCESS
        }
        Ok(DaemonCli::Run(cfg)) => match QuetzalcoatlDaemon::start(*cfg) {
            Ok(mut handle) => {
                handle.wait_until_stopped();
                ExitCode::SUCCESS
            }
            Err(err) => {
                eprintln!("quetzalcoatld error [{}]: {err}", err.code());
                ExitCode::from(1)
            }
        },
        Err(err) => {
            eprintln!("quetzalcoatld cli error [{}]: {err}", err.code());
            ExitCode::from(2)
        }
    }
}
