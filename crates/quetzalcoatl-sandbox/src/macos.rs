#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]

//! macOS Seatbelt (`/usr/bin/sandbox-exec`) 探针与 SBPL 沙箱策略生成器。

use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use quetzalcoatl_types::{QuetzalcoatlError, Result};

use crate::{
    NetworkPolicy, PROTECTED_WORKSPACE_SUBPATHS, SandboxBackendKind, SandboxCommand,
    SandboxExecSpec, SandboxExecutionOutput, SandboxMode, SandboxProbeReport, build_sanitized_env,
    collect_all_masked_paths, prepare_workspace_protections,
};

const MACOS_SANDBOX_EXEC_BIN: &str = "/usr/bin/sandbox-exec";

fn escape_sbpl_path(path: &Path, label: &str) -> Result<String> {
    let raw = path
        .to_str()
        .ok_or_else(|| QuetzalcoatlError::SandboxViolation {
            detail: format!("macOS Seatbelt {label} 路径包含非 UTF-8 字节"),
        })?;
    if raw.is_empty() || raw.contains('\0') || raw.contains('\n') || raw.contains('\r') {
        return Err(QuetzalcoatlError::SandboxViolation {
            detail: format!("macOS Seatbelt {label} 路径为空或包含控制字符"),
        });
    }
    let mut out = String::with_capacity(raw.len());
    for ch in raw.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            _ => out.push(ch),
        }
    }
    Ok(out)
}

/// 生成 macOS Seatbelt SBPL 策略源码。
///
/// 规则优先级：在基础只读放行后，显式 `(deny file-read* file-write* ...)` 遮蔽所有宿主私密目录，
/// 并在可写工作区之上对 `.git/hooks`、`.opencode`、`.claude`、`.codex` 追加 `(deny file-write* ...)`。
pub fn generate_seatbelt_profile(spec: &SandboxExecSpec) -> Result<String> {
    let ws_escaped = escape_sbpl_path(&spec.workspace_dir, "workspace_dir")?;
    let mut sbpl = String::with_capacity(1024);

    sbpl.push_str("(version 1)\n");
    sbpl.push_str("(deny default)\n");
    sbpl.push_str("(allow process-exec*)\n");
    sbpl.push_str("(allow process-fork)\n");
    sbpl.push_str("(allow signal (target self))\n");
    sbpl.push_str("(allow sysctl-read)\n");
    sbpl.push_str("(allow mach-lookup)\n");
    sbpl.push_str("(allow file-read*)\n");

    // 显式阻断读取或修改宿主密钥与订阅长期凭据目录
    for masked in collect_all_masked_paths(spec) {
        let escaped = escape_sbpl_path(&masked, "masked_path")?;
        let _ = writeln!(
            sbpl,
            "(deny file-read* file-write* (subpath \"{escaped}\"))"
        );
    }

    // 允许临时目录与设备节点写入
    sbpl.push_str("(allow file-write* (subpath \"/tmp\") (subpath \"/private/tmp\") (literal \"/dev/null\"))\n");

    match spec.mode {
        SandboxMode::WorkspaceWritable => {
            let _ = writeln!(sbpl, "(allow file-write* (subpath \"{ws_escaped}\"))");
            for rel in PROTECTED_WORKSPACE_SUBPATHS {
                let protected = spec.workspace_dir.join(rel);
                let escaped_prot = escape_sbpl_path(&protected, "protected_subpath")?;
                let _ = writeln!(sbpl, "(deny file-write* (subpath \"{escaped_prot}\"))");
            }
        }
        SandboxMode::CleanRoomReadOnly => {
            let _ = writeln!(sbpl, "(deny file-write* (subpath \"{ws_escaped}\"))");
            if let Some(suite_dir) = &spec.verifier_suite_dir {
                let escaped_suite = escape_sbpl_path(suite_dir, "verifier_suite_dir")?;
                let _ = writeln!(sbpl, "(deny file-write* (subpath \"{escaped_suite}\"))");
            }
        }
    }

    match spec.network_policy {
        NetworkPolicy::AllowHostNetwork => {
            sbpl.push_str("(allow network*)\n");
        }
        NetworkPolicy::Isolated => {
            sbpl.push_str("(deny network*)\n");
        }
    }

    if let Some(sock) = &spec.broker_unix_socket {
        let escaped_sock = escape_sbpl_path(sock, "broker_unix_socket")?;
        let _ = writeln!(
            sbpl,
            "(allow file-read* file-write* (literal \"{escaped_sock}\"))"
        );
        let _ = writeln!(
            sbpl,
            "(allow network-outbound (literal \"{escaped_sock}\"))"
        );
    }

    Ok(sbpl)
}

/// 构造 `/usr/bin/sandbox-exec -p <profile> -- <cmd...>` 调用参数。
pub fn build_seatbelt_invocation(
    spec: &SandboxExecSpec,
    command: &SandboxCommand,
) -> Result<(PathBuf, Vec<String>, String)> {
    let mut merged = spec.clone();
    if command.broker_unix_socket.is_some() {
        merged
            .broker_unix_socket
            .clone_from(&command.broker_unix_socket);
    }
    let sbpl = generate_seatbelt_profile(&merged)?;
    let mut args = Vec::with_capacity(4 + command.args.len());
    args.push(String::from("-p"));
    args.push(sbpl.clone());
    args.push(String::from("--"));
    args.push(command.program.clone());
    args.extend(command.args.iter().cloned());
    Ok((PathBuf::from(MACOS_SANDBOX_EXEC_BIN), args, sbpl))
}

/// 在 macOS 宿主执行真实 `/usr/bin/sandbox-exec` 探针。
pub fn probe_macos() -> Result<SandboxProbeReport> {
    let bin = PathBuf::from(MACOS_SANDBOX_EXEC_BIN);
    if !bin.is_file() {
        return Ok(SandboxProbeReport {
            backend: SandboxBackendKind::Unavailable,
            available: false,
            binary_path: None,
            supports_network_isolation: false,
            supports_readonly_bind: false,
            supports_seccomp_clone3_enosys: false,
            apparmor_userns_restricted: false,
            detail: String::from("未找到 /usr/bin/sandbox-exec"),
        });
    }

    let output = Command::new(&bin)
        .args(["-p", "(version 1)(allow default)", "/usr/bin/true"])
        .stdin(Stdio::null())
        .output()
        .map_err(|e| QuetzalcoatlError::SandboxViolation {
            detail: format!("运行 macOS sandbox-exec 探针失败: {e}"),
        })?;

    if output.status.success() {
        Ok(SandboxProbeReport {
            backend: SandboxBackendKind::MacOsSeatbelt,
            available: true,
            binary_path: Some(bin),
            supports_network_isolation: true,
            supports_readonly_bind: true,
            supports_seccomp_clone3_enosys: false,
            apparmor_userns_restricted: false,
            detail: String::from("macOS Seatbelt (sandbox-exec) 真实执行探针通过"),
        })
    } else {
        Ok(SandboxProbeReport {
            backend: SandboxBackendKind::Unavailable,
            available: false,
            binary_path: Some(bin),
            supports_network_isolation: false,
            supports_readonly_bind: false,
            supports_seccomp_clone3_enosys: false,
            apparmor_userns_restricted: false,
            detail: format!(
                "macOS Seatbelt 探针失败: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ),
        })
    }
}

/// 在 macOS Seatbelt 沙箱内执行命令。
pub fn execute_macos(
    spec: &SandboxExecSpec,
    command: &SandboxCommand,
    inherit_stdio: bool,
) -> Result<SandboxExecutionOutput> {
    let protection_guard = prepare_workspace_protections(spec)?;
    let (bin, args, _sbpl) = build_seatbelt_invocation(spec, command)?;
    let env_map = build_sanitized_env(spec, command);
    let cwd = command.current_dir.as_ref().unwrap_or(&spec.workspace_dir);

    let mut cmd = Command::new(bin);
    cmd.env_clear().envs(&env_map).current_dir(cwd).args(&args);

    if inherit_stdio {
        let status = cmd
            .stdin(Stdio::inherit())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit())
            .status()
            .map_err(|e| QuetzalcoatlError::SandboxViolation {
                detail: format!("启动 macOS sandbox-exec 失败: {e}"),
            })?;
        drop(protection_guard);
        Ok(SandboxExecutionOutput {
            exit_code: status.code().unwrap_or(128),
            stdout: Vec::new(),
            stderr: Vec::new(),
        })
    } else {
        let output =
            cmd.stdin(Stdio::null())
                .output()
                .map_err(|e| QuetzalcoatlError::SandboxViolation {
                    detail: format!("启动 macOS sandbox-exec 失败: {e}"),
                })?;
        drop(protection_guard);
        Ok(SandboxExecutionOutput {
            exit_code: output.status.code().unwrap_or(128),
            stdout: output.stdout,
            stderr: output.stderr,
        })
    }
}
