#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]

//! macOS Seatbelt (`/usr/bin/sandbox-exec`) 探针与 SBPL 沙箱策略生成器。

use std::collections::BTreeSet;
use std::fmt::Write as _;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use quetzalcoatl_types::{QuetzalcoatlError, Result};

use crate::{
    NetworkPolicy, SandboxBackendKind, SandboxCommand, SandboxExecSpec, SandboxExecutionOutput,
    SandboxMode, SandboxProbeReport, build_sanitized_env, collect_all_masked_paths,
    compute_protected_workspace_ro_targets, prepare_workspace_protections,
};

const MACOS_SANDBOX_EXEC_BIN: &str = "/usr/bin/sandbox-exec";

const MACOS_SYMLINK_PREFIX_PAIRS: &[(&str, &str)] = &[
    ("/tmp", "/private/tmp"),
    ("/var", "/private/var"),
    ("/etc", "/private/etc"),
];

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

fn canonicalize_with_longest_existing_ancestor(path: &Path) -> Option<PathBuf> {
    for ancestor in path.ancestors() {
        if ancestor.as_os_str().is_empty() {
            break;
        }
        if let Ok(canon_anc) = fs::canonicalize(ancestor)
            && let Ok(rel_suffix) = path.strip_prefix(ancestor)
        {
            return if rel_suffix.as_os_str().is_empty() {
                Some(canon_anc)
            } else {
                Some(canon_anc.join(rel_suffix))
            };
        }
    }
    None
}

/// 展开路径的原始形式、最长现存祖先 `canonicalize` 形式，以及 macOS `/tmp <-> /private/tmp`、`/var <-> /private/var` 双向别名。
///
/// XNU Seatbelt 在内核层针对真实 vnode 路径评估规则，因此必须同时覆盖符号链接与 `/private/*` 规范路径。
#[must_use]
pub fn expand_macos_path_variants(path: &Path) -> Vec<PathBuf> {
    let mut set = BTreeSet::<PathBuf>::new();
    set.insert(path.to_path_buf());
    if let Some(canon) = canonicalize_with_existing(path) {
        set.insert(canon);
    }

    let snapshot: Vec<PathBuf> = set.iter().cloned().collect();
    for item in snapshot {
        for &(short_pfx, private_pfx) in MACOS_SYMLINK_PREFIX_PAIRS {
            let short_path = Path::new(short_pfx);
            let private_path = Path::new(private_pfx);
            if let Ok(rel) = item.strip_prefix(short_path) {
                if rel.as_os_str().is_empty() {
                    set.insert(private_path.to_path_buf());
                } else {
                    set.insert(private_path.join(rel));
                }
            }
            if let Ok(rel) = item.strip_prefix(private_path) {
                if rel.as_os_str().is_empty() {
                    set.insert(short_path.to_path_buf());
                } else {
                    set.insert(short_path.join(rel));
                }
            }
        }
    }

    set.into_iter().collect()
}

fn canonicalize_with_existing(path: &Path) -> Option<PathBuf> {
    fs::canonicalize(path)
        .ok()
        .or_else(|| canonicalize_with_longest_existing_ancestor(path))
}

/// 生成 macOS Seatbelt SBPL 策略源码。
///
/// 遵循 Apple Seatbelt **Last-match-wins（后匹配覆盖前匹配）** 语义：
/// 1. 先声明基础只读与 `/tmp` (`/private/tmp`) 临时写放行；
/// 2. 再声明工作区可写与受保护子路径（单文件 `literal` / 目录 `subpath`）写拒绝，或洁净室只读拒绝；
/// 3. **最后**输出所有宿主私密路径 `(deny file-read* file-write* ...)`，确保即使 `workspace_dir == $HOME` 或位于 `/tmp` 下也绝不被前序 `allow` 重新打开；
/// 4. 若显式挂载了单文件 `broker_unix_socket`，在末尾以精确 `(literal ...)` 放行该单套接字节点。
pub fn generate_seatbelt_profile(spec: &SandboxExecSpec) -> Result<String> {
    let default_targets = compute_protected_workspace_ro_targets(spec);
    generate_seatbelt_profile_with_targets(spec, &default_targets)
}

fn generate_seatbelt_profile_with_targets(
    spec: &SandboxExecSpec,
    protected_targets: &[(PathBuf, bool)],
) -> Result<String> {
    let _ = escape_sbpl_path(&spec.workspace_dir, "workspace_dir")?;
    let mut sbpl = String::with_capacity(2048);

    sbpl.push_str("(version 1)\n");
    sbpl.push_str("(deny default)\n");
    sbpl.push_str("(allow process-exec*)\n");
    sbpl.push_str("(allow process-fork)\n");
    sbpl.push_str("(allow signal (target self))\n");
    sbpl.push_str("(allow sysctl-read)\n");
    sbpl.push_str("(allow mach-lookup)\n");
    sbpl.push_str("(allow file-read*)\n");

    // 1. 允许基础临时目录与空设备写入（后续洁净室工作区或私密目录若位于 /tmp 下，将由后序 deny 覆盖）
    sbpl.push_str(
        "(allow file-write* (subpath \"/tmp\") (subpath \"/private/tmp\") (literal \"/dev/null\"))\n",
    );

    // 2. 工作区读写与受保护子路径只读锁定
    match spec.mode {
        SandboxMode::WorkspaceWritable => {
            for ws_var in expand_macos_path_variants(&spec.workspace_dir) {
                let escaped_ws = escape_sbpl_path(&ws_var, "workspace_dir")?;
                let _ = writeln!(sbpl, "(allow file-write* (subpath \"{escaped_ws}\"))");
            }
            for (prot_path, is_regular_file) in protected_targets {
                let pred = if *is_regular_file {
                    "literal"
                } else {
                    "subpath"
                };
                for prot_var in expand_macos_path_variants(prot_path) {
                    let escaped_prot = escape_sbpl_path(&prot_var, "protected_subpath")?;
                    let _ = writeln!(sbpl, "(deny file-write* ({pred} \"{escaped_prot}\"))");
                }
            }
        }
        SandboxMode::CleanRoomReadOnly => {
            for ws_var in expand_macos_path_variants(&spec.workspace_dir) {
                let escaped_ws = escape_sbpl_path(&ws_var, "workspace_dir")?;
                let _ = writeln!(sbpl, "(deny file-write* (subpath \"{escaped_ws}\"))");
            }
            if let Some(suite_dir) = &spec.verifier_suite_dir {
                for suite_var in expand_macos_path_variants(suite_dir) {
                    let escaped_suite = escape_sbpl_path(&suite_var, "verifier_suite_dir")?;
                    let _ = writeln!(sbpl, "(deny file-write* (subpath \"{escaped_suite}\"))");
                }
            }
        }
    }

    // 3. 最后施加宿主私密目录与文件读写双拒（压制 /tmp、/private/tmp 与 workspace == $HOME 的前序放行）
    for masked in collect_all_masked_paths(spec) {
        let is_file = fs::symlink_metadata(&masked)
            .map(|m| m.file_type().is_file())
            .unwrap_or(false);
        let pred = if is_file { "literal" } else { "subpath" };
        for masked_var in expand_macos_path_variants(&masked) {
            let escaped = escape_sbpl_path(&masked_var, "masked_path")?;
            let _ = writeln!(sbpl, "(deny file-read* file-write* ({pred} \"{escaped}\"))");
        }
    }

    // 4. 网络隔离策略
    match spec.network_policy {
        NetworkPolicy::AllowHostNetwork => {
            sbpl.push_str("(allow network*)\n");
        }
        NetworkPolicy::Isolated => {
            sbpl.push_str("(deny network*)\n");
        }
    }

    // 5. 若显式指定了 CredentialBroker 单文件 UnixSocket（即使嵌套在被遮蔽目录内），仅精确放行该 literal 节点
    if let Some(sock) = &spec.broker_unix_socket {
        for sock_var in expand_macos_path_variants(sock) {
            let escaped_sock = escape_sbpl_path(&sock_var, "broker_unix_socket")?;
            let _ = writeln!(
                sbpl,
                "(allow file-read* file-write* (literal \"{escaped_sock}\"))"
            );
            let _ = writeln!(
                sbpl,
                "(allow network-outbound (literal \"{escaped_sock}\"))"
            );
        }
    }

    Ok(sbpl)
}

/// 构造 `/usr/bin/sandbox-exec -p <profile> -- <cmd...>` 调用参数。
pub fn build_seatbelt_invocation(
    spec: &SandboxExecSpec,
    command: &SandboxCommand,
) -> Result<(PathBuf, Vec<String>, String)> {
    let default_targets = compute_protected_workspace_ro_targets(spec);
    build_seatbelt_invocation_with_targets(spec, command, &default_targets)
}

fn build_seatbelt_invocation_with_targets(
    spec: &SandboxExecSpec,
    command: &SandboxCommand,
    protected_targets: &[(PathBuf, bool)],
) -> Result<(PathBuf, Vec<String>, String)> {
    let mut merged = spec.clone();
    if command.broker_unix_socket.is_some() {
        merged
            .broker_unix_socket
            .clone_from(&command.broker_unix_socket);
    }
    let sbpl = generate_seatbelt_profile_with_targets(&merged, protected_targets)?;
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
    let guard_targets: Vec<(PathBuf, bool)> = protection_guard
        .ro_paths()
        .iter()
        .map(|p| {
            let is_file = fs::symlink_metadata(p)
                .map(|m| m.file_type().is_file())
                .unwrap_or(false);
            (p.clone(), is_file)
        })
        .collect();
    let (bin, args, _sbpl) = build_seatbelt_invocation_with_targets(spec, command, &guard_targets)?;
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
