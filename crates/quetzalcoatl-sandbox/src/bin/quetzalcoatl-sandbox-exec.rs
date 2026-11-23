#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]

//! `quetzalcoatl-sandbox-exec` — 独立无容器沙箱包装可执行文件（兼容 `SHELL=quetzalcoatl-sandbox-exec` 的 `-c "<cmd>"` 统一调用约定）。

use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use std::process::ExitCode;

use quetzalcoatl_sandbox::{
    NetworkPolicy, SandboxCommand, SandboxExecSpec, SandboxManager, SandboxMode,
    default_quetzalcoatl_home,
};
use quetzalcoatl_types::{QuetzalcoatlError, Result};

const VERSION_BANNER: &str = concat!("quetzalcoatl-sandbox-exec ", env!("CARGO_PKG_VERSION"));

const USAGE_TEXT: &str = "\
Usage:
  quetzalcoatl-sandbox-exec [OPTIONS] -c \"<shell_command>\"
  quetzalcoatl-sandbox-exec [OPTIONS] -- <program> [args...]

Options:
  --spec <json_path>          Load SandboxExecSpec JSON (or set QUETZALCOATL_SANDBOX_SPEC / QUETZALCOATL_SANDBOX_SPEC_JSON)
  --workspace <dir>           Workspace directory (or QUETZALCOATL_SANDBOX_WORKSPACE; defaults to cwd)
  --home <dir>                Quetzalcoatl home directory (or QUETZALCOATL_HOME)
  --clean-room                Mount workspace strictly read-only and isolate network
  --verifier-suite <dir>      Mount kernel-locked verifier suite directory read-only
  --isolated-net              Isolate network namespace
  --broker-socket <path>      Bind-mount CredentialBroker Unix socket into sandbox
  -c, -lc <command>           Execute command string via /bin/sh -c (or cmd.exe /c on Windows)
  -V, --version               Print version
  -h, --help                  Print help
";

enum CliOutcome {
    PrintHelp,
    PrintVersion,
    Execute(Box<(SandboxExecSpec, SandboxCommand)>),
}

fn load_base_spec(explicit_spec_path: Option<PathBuf>) -> Result<Option<SandboxExecSpec>> {
    if let Some(path) = explicit_spec_path {
        let raw = fs::read(&path).map_err(|e| QuetzalcoatlError::StorageError {
            detail: format!("读取沙箱规格文件失败 ({}): {e}", path.display()),
        })?;
        let parsed = serde_json::from_slice::<SandboxExecSpec>(&raw).map_err(|e| {
            QuetzalcoatlError::SerializationError {
                detail: format!("解析沙箱规格 JSON 失败 ({}): {e}", path.display()),
            }
        })?;
        return Ok(Some(parsed));
    }

    if let Some(inline_json) = std::env::var_os("QUETZALCOATL_SANDBOX_SPEC_JSON") {
        let s = inline_json.to_string_lossy();
        let parsed = serde_json::from_str::<SandboxExecSpec>(&s).map_err(|e| {
            QuetzalcoatlError::SerializationError {
                detail: format!("解析 QUETZALCOATL_SANDBOX_SPEC_JSON 失败: {e}"),
            }
        })?;
        return Ok(Some(parsed));
    }

    if let Some(env_path_os) = std::env::var_os("QUETZALCOATL_SANDBOX_SPEC") {
        let path = PathBuf::from(env_path_os);
        let raw = fs::read(&path).map_err(|e| QuetzalcoatlError::StorageError {
            detail: format!(
                "读取 QUETZALCOATL_SANDBOX_SPEC 文件失败 ({}): {e}",
                path.display()
            ),
        })?;
        let parsed = serde_json::from_slice::<SandboxExecSpec>(&raw).map_err(|e| {
            QuetzalcoatlError::SerializationError {
                detail: format!("解析沙箱规格 JSON 失败 ({}): {e}", path.display()),
            }
        })?;
        return Ok(Some(parsed));
    }

    Ok(None)
}

fn parse_cli(raw_args: Vec<String>) -> Result<CliOutcome> {
    let mut spec_path: Option<PathBuf> = None;
    let mut workspace_override: Option<PathBuf> = None;
    let mut home_override: Option<PathBuf> = None;
    let mut clean_room = false;
    let mut isolated_net = false;
    let mut verifier_suite: Option<PathBuf> = None;
    let mut broker_socket: Option<PathBuf> = None;
    let mut shell_cmd: Option<String> = None;
    let mut direct_argv: Vec<String> = Vec::new();

    let mut idx = 0usize;
    while idx < raw_args.len() {
        let arg = &raw_args[idx];
        match arg.as_str() {
            "-h" | "--help" => return Ok(CliOutcome::PrintHelp),
            "-V" | "--version" => return Ok(CliOutcome::PrintVersion),
            "--spec" => {
                idx += 1;
                let val = raw_args
                    .get(idx)
                    .ok_or_else(|| QuetzalcoatlError::SandboxViolation {
                        detail: String::from("--spec 缺少文件路径参数"),
                    })?;
                spec_path = Some(PathBuf::from(val));
            }
            "--workspace" => {
                idx += 1;
                let val = raw_args
                    .get(idx)
                    .ok_or_else(|| QuetzalcoatlError::SandboxViolation {
                        detail: String::from("--workspace 缺少目录参数"),
                    })?;
                workspace_override = Some(PathBuf::from(val));
            }
            "--home" => {
                idx += 1;
                let val = raw_args
                    .get(idx)
                    .ok_or_else(|| QuetzalcoatlError::SandboxViolation {
                        detail: String::from("--home 缺少目录参数"),
                    })?;
                home_override = Some(PathBuf::from(val));
            }
            "--clean-room" => {
                clean_room = true;
                isolated_net = true;
            }
            "--isolated-net" => {
                isolated_net = true;
            }
            "--verifier-suite" => {
                idx += 1;
                let val = raw_args
                    .get(idx)
                    .ok_or_else(|| QuetzalcoatlError::SandboxViolation {
                        detail: String::from("--verifier-suite 缺少目录参数"),
                    })?;
                verifier_suite = Some(PathBuf::from(val));
            }
            "--broker-socket" => {
                idx += 1;
                let val = raw_args
                    .get(idx)
                    .ok_or_else(|| QuetzalcoatlError::SandboxViolation {
                        detail: String::from("--broker-socket 缺少路径参数"),
                    })?;
                broker_socket = Some(PathBuf::from(val));
            }
            "-c" | "-lc" => {
                idx += 1;
                let cmd_str =
                    raw_args
                        .get(idx)
                        .ok_or_else(|| QuetzalcoatlError::SandboxViolation {
                            detail: format!("{arg} 缺少待执行命令字符串"),
                        })?;
                shell_cmd = Some(cmd_str.clone());
                break;
            }
            "--" => {
                direct_argv.extend_from_slice(&raw_args[idx + 1..]);
                break;
            }
            other if other.starts_with('-') => {
                return Err(QuetzalcoatlError::SandboxViolation {
                    detail: format!("未知命令行选项: {other}"),
                });
            }
            _ => {
                direct_argv.extend_from_slice(&raw_args[idx..]);
                break;
            }
        }
        idx += 1;
    }

    let command = if let Some(script) = shell_cmd {
        SandboxCommand::shell(script)
    } else if let Some((prog, rest)) = direct_argv.split_first() {
        SandboxCommand::new(prog.clone(), rest.to_vec())
    } else {
        return Err(QuetzalcoatlError::SandboxViolation {
            detail: String::from("必须提供 -c \"<cmd>\" 或目标可执行程序参数"),
        });
    };

    let mut spec = match load_base_spec(spec_path)? {
        Some(loaded) => loaded,
        None => {
            let ws = match workspace_override.clone() {
                Some(w) => w,
                None => match std::env::var_os("QUETZALCOATL_SANDBOX_WORKSPACE") {
                    Some(env_ws) => PathBuf::from(env_ws),
                    None => std::env::current_dir().map_err(|e| {
                        QuetzalcoatlError::SandboxViolation {
                            detail: format!("获取当前工作目录失败: {e}"),
                        }
                    })?,
                },
            };
            let qz_home = home_override
                .clone()
                .or_else(|| std::env::var_os("QUETZALCOATL_HOME").map(PathBuf::from))
                .unwrap_or_else(default_quetzalcoatl_home);
            SandboxExecSpec {
                quetzalcoatl_home: qz_home,
                user_home: std::env::var_os("HOME")
                    .or_else(|| std::env::var_os("USERPROFILE"))
                    .map(PathBuf::from),
                workspace_dir: ws,
                mode: SandboxMode::WorkspaceWritable,
                network_policy: NetworkPolicy::AllowHostNetwork,
                verifier_suite_dir: None,
                broker_unix_socket: None,
                extra_masked_paths: Vec::new(),
                extra_ro_mounts: Vec::new(),
                extra_env: BTreeMap::new(),
                allowlisted_host_env: Vec::new(),
            }
        }
    };

    if let Some(ws) = workspace_override {
        spec.workspace_dir = ws;
    }
    if let Some(home) = home_override {
        spec.quetzalcoatl_home = home;
    }
    if clean_room {
        spec.mode = SandboxMode::CleanRoomReadOnly;
    }
    if isolated_net {
        spec.network_policy = NetworkPolicy::Isolated;
    }
    if verifier_suite.is_some() {
        spec.verifier_suite_dir = verifier_suite;
    }
    if broker_socket.is_some() {
        spec.broker_unix_socket = broker_socket;
    }

    Ok(CliOutcome::Execute(Box::new((spec, command))))
}

fn exit_code_from_i32(code: i32) -> ExitCode {
    if (0..=255).contains(&code) {
        let low = (code & 0xff) as u8;
        ExitCode::from(low)
    } else {
        ExitCode::from(1)
    }
}

fn main() -> ExitCode {
    let raw_args: Vec<String> = std::env::args().skip(1).collect();
    match parse_cli(raw_args) {
        Ok(CliOutcome::PrintHelp) => {
            print!("{USAGE_TEXT}");
            ExitCode::SUCCESS
        }
        Ok(CliOutcome::PrintVersion) => {
            println!("{VERSION_BANNER}");
            ExitCode::SUCCESS
        }
        Ok(CliOutcome::Execute(boxed)) => {
            let (spec, command) = *boxed;
            match SandboxManager::execute_spec_direct(&spec, &command, true) {
                Ok(out) => exit_code_from_i32(out.exit_code),
                Err(err) => {
                    eprintln!("quetzalcoatl-sandbox-exec error [{}]: {err}", err.code());
                    ExitCode::from(126)
                }
            }
        }
        Err(err) => {
            eprintln!("quetzalcoatl-sandbox-exec error [{}]: {err}", err.code());
            ExitCode::from(125)
        }
    }
}
