#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]

//! Linux `bubblewrap` (`bwrap`) 无容器沙箱后端、AppArmor 真实挂载探针与 `SYS_clone3 -> ENOSYS` seccomp BPF 生成器。

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use quetzalcoatl_types::{QuetzalcoatlError, Result};
use uuid::Uuid;

use crate::{
    NetworkPolicy, SandboxBackendKind, SandboxCommand, SandboxExecSpec, SandboxExecutionOutput,
    SandboxMode, SandboxProbeReport, build_sanitized_env, collect_collapsed_masked_paths,
    prepare_workspace_protections,
};

/// `x86_64` 与 `aarch64` Linux 上的 `SYS_clone3` 系统调用号。
pub const SYS_CLONE3_NR: u32 = 435;
/// `x86_64` x32 ABI 系统调用高位掩码（`__X32_SYSCALL_BIT`）。
pub const X32_SYSCALL_BIT: u32 = 0x4000_0000;
/// `x86_64` 与 `aarch64` Linux 上的 `ENOSYS` 错误码。
pub const LINUX_ENOSYS: u32 = 38;
/// `AUDIT_ARCH_X86_64` 常量。
pub const AUDIT_ARCH_X86_64: u32 = 0xc000_003e;
/// `AUDIT_ARCH_AARCH64` 常量。
pub const AUDIT_ARCH_AARCH64: u32 = 0xc000_00b7;

const BPF_LD_W_ABS: u16 = 0x20;
const BPF_JMP_JEQ_K: u16 = 0x15;
const BPF_RET_K: u16 = 0x06;

const SECCOMP_RET_ALLOW: u32 = 0x7fff_0000;
const SECCOMP_RET_ERRNO: u32 = 0x0005_0000;

const SECCOMP_DATA_NR_OFFSET: u32 = 0;
const SECCOMP_DATA_ARCH_OFFSET: u32 = 4;

fn append_sock_filter(buf: &mut Vec<u8>, code: u16, jt: u8, jf: u8, k: u32) {
    buf.extend_from_slice(&code.to_ne_bytes());
    buf.push(jt);
    buf.push(jf);
    buf.extend_from_slice(&k.to_ne_bytes());
}

/// 生成拦截 `SYS_clone3` 并返回 `SECCOMP_RET_ERRNO | ENOSYS`（`38`）的经典 BPF 字节码。
///
/// 在用户/挂载命名空间与部分受限环境中，拦截 `SYS_clone3` 并返回 `ENOSYS` 可促使 `glibc`
/// 干净回退至传统 `clone` 系统调用，避免线程/子进程孵化异常失败。
#[must_use]
pub fn build_clone3_enosys_bpf() -> Vec<u8> {
    let mut bpf = Vec::with_capacity(9 * 8);
    // [0] 加载 seccomp_data.arch (offset 4)
    append_sock_filter(&mut bpf, BPF_LD_W_ABS, 0, 0, SECCOMP_DATA_ARCH_OFFSET);
    // [1] 若 arch == AUDIT_ARCH_X86_64 -> 跳至 [3]；否则继续 [2]
    append_sock_filter(&mut bpf, BPF_JMP_JEQ_K, 1, 0, AUDIT_ARCH_X86_64);
    // [2] 若 arch == AUDIT_ARCH_AARCH64 -> 跳至 [3]；否则跳至 [7] (ALLOW)
    append_sock_filter(&mut bpf, BPF_JMP_JEQ_K, 0, 4, AUDIT_ARCH_AARCH64);
    // [3] 加载 seccomp_data.nr (offset 0)
    append_sock_filter(&mut bpf, BPF_LD_W_ABS, 0, 0, SECCOMP_DATA_NR_OFFSET);
    // [4] 若 nr == 435 (SYS_clone3) -> 跳至 [8] (ERRNO ENOSYS)
    append_sock_filter(&mut bpf, BPF_JMP_JEQ_K, 3, 0, SYS_CLONE3_NR);
    // [5] 若 nr == (X32_SYSCALL_BIT | 435) -> 跳至 [8] (ERRNO ENOSYS)；否则跳至 [7] (ALLOW)
    append_sock_filter(
        &mut bpf,
        BPF_JMP_JEQ_K,
        2,
        1,
        X32_SYSCALL_BIT | SYS_CLONE3_NR,
    );
    // [6] 安全兜底 ALLOW
    append_sock_filter(&mut bpf, BPF_RET_K, 0, 0, SECCOMP_RET_ALLOW);
    // [7] 放行其余系统调用
    append_sock_filter(&mut bpf, BPF_RET_K, 0, 0, SECCOMP_RET_ALLOW);
    // [8] 对 SYS_clone3 返回 ENOSYS (38)
    append_sock_filter(&mut bpf, BPF_RET_K, 0, 0, SECCOMP_RET_ERRNO | LINUX_ENOSYS);
    bpf
}

/// 定位宿主 `bwrap` 可执行文件。
#[must_use]
pub fn locate_bwrap_binary() -> Option<PathBuf> {
    for candidate in ["/usr/bin/bwrap", "/bin/bwrap", "/usr/local/bin/bwrap"] {
        let p = PathBuf::from(candidate);
        if p.is_file() {
            return Some(p);
        }
    }
    if let Some(path_os) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path_os) {
            let candidate = dir.join("bwrap");
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

/// 读取内核 `apparmor_restrict_unprivileged_userns` 开关状态。
#[must_use]
pub fn is_apparmor_userns_restricted() -> bool {
    fs::read_to_string("/proc/sys/kernel/apparmor_restrict_unprivileged_userns")
        .map(|s| s.trim() == "1")
        .unwrap_or(false)
}

fn find_true_binary() -> &'static str {
    if Path::new("/usr/bin/true").is_file() {
        "/usr/bin/true"
    } else {
        "/bin/true"
    }
}

struct EphemeralSeccompFile {
    path: PathBuf,
}

impl EphemeralSeccompFile {
    fn create() -> Result<Self> {
        let base_candidate = PathBuf::from("/tmp/opencode");
        let dir = if base_candidate.is_dir() {
            base_candidate
        } else {
            std::env::temp_dir()
        };
        let path = dir.join(format!("qz_seccomp_{}.bpf", Uuid::new_v4().simple()));
        let bpf = build_clone3_enosys_bpf();
        fs::write(&path, &bpf).map_err(|e| QuetzalcoatlError::SandboxViolation {
            detail: format!("写入临时 seccomp BPF 规则失败 ({}): {e}", path.display()),
        })?;
        Ok(Self { path })
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for EphemeralSeccompFile {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

/// 将真实挂载探测结果归一为结构化 `SandboxProbeReport`（支持单测覆盖 AppArmor 阻断与正常放行分支）。
#[must_use]
pub fn evaluate_linux_probe_outcome(
    bwrap_bin: Option<PathBuf>,
    apparmor_restricted: bool,
    probe_succeeded: bool,
    stderr_summary: &str,
) -> SandboxProbeReport {
    let Some(bin) = bwrap_bin else {
        return SandboxProbeReport {
            backend: SandboxBackendKind::Unavailable,
            available: false,
            binary_path: None,
            supports_network_isolation: false,
            supports_readonly_bind: false,
            supports_seccomp_clone3_enosys: false,
            apparmor_userns_restricted: apparmor_restricted,
            detail: String::from("未在宿主找到 bubblewrap (bwrap) 可执行文件"),
        };
    };

    if probe_succeeded {
        SandboxProbeReport {
            backend: SandboxBackendKind::LinuxBubblewrap,
            available: true,
            binary_path: Some(bin),
            supports_network_isolation: true,
            supports_readonly_bind: true,
            supports_seccomp_clone3_enosys: true,
            apparmor_userns_restricted: apparmor_restricted,
            detail: if apparmor_restricted {
                String::from(
                    "bwrap 真实挂载与 seccomp 探针通过（宿主已开启 apparmor_restrict_unprivileged_userns=1 且具备有效 AppArmor 放行配置）",
                )
            } else {
                String::from("bwrap 真实挂载与 seccomp 探针通过")
            },
        }
    } else {
        let hint = if apparmor_restricted {
            format!(
                "bwrap 真实挂载探针失败（apparmor_restrict_unprivileged_userns=1 拦截了非特权 userns）: {}",
                stderr_summary.trim()
            )
        } else {
            format!("bwrap 真实挂载探针失败: {}", stderr_summary.trim())
        };
        SandboxProbeReport {
            backend: SandboxBackendKind::Unavailable,
            available: false,
            binary_path: Some(bin),
            supports_network_isolation: false,
            supports_readonly_bind: false,
            supports_seccomp_clone3_enosys: false,
            apparmor_userns_restricted: apparmor_restricted,
            detail: hint,
        }
    }
}

/// 在 Linux 宿主执行真实 `bwrap` 挂载与 seccomp 探针（识别 Ubuntu AppArmor `userns` 拦截）。
pub fn probe_linux() -> Result<SandboxProbeReport> {
    let apparmor_restricted = is_apparmor_userns_restricted();
    let Some(bwrap_bin) = locate_bwrap_binary() else {
        return Ok(evaluate_linux_probe_outcome(
            None,
            apparmor_restricted,
            false,
            "",
        ));
    };

    let seccomp_file = EphemeralSeccompFile::create()?;
    let true_bin = find_true_binary();

    // 使用 POSIX /bin/sh 位置参数在宿主侧打开只读 FD 9 喂给 bwrap --seccomp 9，零字符串拼接注入风险且零 unsafe
    let output = Command::new("/bin/sh")
        .arg("-c")
        .arg("bpf=$1; bw=$2; shift 2; exec \"$bw\" --seccomp 9 \"$@\" 9< \"$bpf\"")
        .arg("qz-bwrap-probe")
        .arg(seccomp_file.path())
        .arg(&bwrap_bin)
        .args([
            "--die-with-parent",
            "--unshare-net",
            "--ro-bind",
            "/",
            "/",
            "--dev",
            "/dev",
            "--proc",
            "/proc",
            "--tmpfs",
            "/tmp",
            "--",
            true_bin,
        ])
        .stdin(Stdio::null())
        .output()
        .map_err(|e| QuetzalcoatlError::SandboxViolation {
            detail: format!("启动 bwrap 探针子进程失败: {e}"),
        })?;

    let stderr_text = String::from_utf8_lossy(&output.stderr);
    Ok(evaluate_linux_probe_outcome(
        Some(bwrap_bin),
        apparmor_restricted,
        output.status.success(),
        &stderr_text,
    ))
}

fn path_to_arg(path: &Path, label: &str) -> Result<String> {
    let s = path
        .to_str()
        .ok_or_else(|| QuetzalcoatlError::SandboxViolation {
            detail: format!("{label} 路径包含非 UTF-8 字节"),
        })?;
    if s.is_empty() || s.contains('\0') {
        return Err(QuetzalcoatlError::SandboxViolation {
            detail: format!("{label} 路径为空或包含非法 NUL 字节"),
        });
    }
    Ok(String::from(s))
}

/// 根据给定规格组装 `bwrap` 参数列表（不含 `--seccomp 9`，由启动包装器统一前置挂载）。
pub fn build_bwrap_args(
    spec: &SandboxExecSpec,
    command: &SandboxCommand,
) -> Result<(PathBuf, Vec<String>)> {
    let bwrap_bin = locate_bwrap_binary().unwrap_or_else(|| PathBuf::from("/usr/bin/bwrap"));
    build_bwrap_args_with_ro_locks(spec, command, &bwrap_bin, &[])
}

fn build_bwrap_args_with_ro_locks(
    spec: &SandboxExecSpec,
    command: &SandboxCommand,
    bwrap_bin: &Path,
    protected_ro_paths: &[PathBuf],
) -> Result<(PathBuf, Vec<String>)> {
    let mut args = Vec::<String>::with_capacity(64);
    args.push(String::from("--die-with-parent"));
    args.push(String::from("--unshare-pid"));
    args.push(String::from("--unshare-ipc"));
    args.push(String::from("--unshare-uts"));
    if spec.network_policy == NetworkPolicy::Isolated {
        args.push(String::from("--unshare-net"));
    }

    // 根文件系统默认只读，/tmp 为隔离内存盘，且彻底清空宿主继承环境变量
    args.extend([
        String::from("--ro-bind"),
        String::from("/"),
        String::from("/"),
        String::from("--dev"),
        String::from("/dev"),
        String::from("--proc"),
        String::from("/proc"),
        String::from("--tmpfs"),
        String::from("/tmp"),
        String::from("--clearenv"),
    ]);

    // 1. 遮蔽所有宿主存在的敏感目录与文件（$QUETZALCOATL_HOME、~/.ssh、~/.gnupg、~/.aws、~/.claude、~/.codex 等）
    let masked = collect_collapsed_masked_paths(spec);
    for mpath in &masked {
        let Ok(meta) = fs::symlink_metadata(mpath) else {
            // 宿主上本就不存在的路径在只读根挂载 (--ro-bind / /) 与空 /tmp 下既无秘密数据也无法被创建
            continue;
        };
        let m_str = path_to_arg(mpath, "masked_path")?;
        let under_tmp = mpath == Path::new("/tmp") || mpath.starts_with("/tmp/");
        if meta.file_type().is_dir() {
            if under_tmp {
                args.extend([String::from("--dir"), m_str.clone()]);
            }
            args.extend([
                String::from("--tmpfs"),
                m_str.clone(),
                String::from("--remount-ro"),
                m_str,
            ]);
        } else if meta.file_type().is_file() {
            if under_tmp
                && let Some(parent) = mpath.parent()
                && parent != Path::new("/tmp")
            {
                let p_str = path_to_arg(parent, "masked_file_parent")?;
                args.extend([String::from("--dir"), p_str]);
            }
            args.extend([String::from("--ro-bind"), String::from("/dev/null"), m_str]);
        }
        // 若 meta.file_type().is_symlink()，collect_all_masked_paths 已将其 canonicalize 真实目标纳入集合遮蔽
    }

    // 2. 挂载工作区（普通模式可写，洁净室模式严格只读）
    let ws_str = path_to_arg(&spec.workspace_dir, "workspace_dir")?;
    match spec.mode {
        SandboxMode::WorkspaceWritable => {
            args.extend([String::from("--bind"), ws_str.clone(), ws_str.clone()]);
        }
        SandboxMode::CleanRoomReadOnly => {
            args.extend([String::from("--ro-bind"), ws_str.clone(), ws_str.clone()]);
        }
    }

    // 3. 洁净室锁定校验套件目录与额外只读挂载
    if let Some(suite_dir) = &spec.verifier_suite_dir {
        let suite_str = path_to_arg(suite_dir, "verifier_suite_dir")?;
        args.extend([String::from("--ro-bind"), suite_str.clone(), suite_str]);
    }
    for extra_ro in spec
        .extra_ro_mounts
        .iter()
        .chain(command.extra_ro_mounts.iter())
    {
        let ro_str = path_to_arg(extra_ro, "extra_ro_mount")?;
        args.extend([String::from("--ro-bind"), ro_str.clone(), ro_str]);
    }

    // 4. 若配置了 CredentialBroker Unix Domain Socket，则仅将该单文件节点挂载入沙箱供受控代理通信
    if let Some(sock_path) = command
        .broker_unix_socket
        .as_ref()
        .or(spec.broker_unix_socket.as_ref())
    {
        let sock_str = path_to_arg(sock_path, "broker_unix_socket")?;
        if sock_path.starts_with("/tmp/")
            && let Some(parent) = sock_path.parent()
            && parent != Path::new("/tmp")
        {
            let parent_str = path_to_arg(parent, "broker_unix_socket_parent")?;
            args.extend([String::from("--dir"), parent_str]);
        }
        args.extend([String::from("--bind"), sock_str.clone(), sock_str]);
    }

    // 5. 在可写工作区之上叠挂载只读锁（.git/hooks, .opencode, .claude, .codex）
    for ro_lock in protected_ro_paths {
        let lock_str = path_to_arg(ro_lock, "protected_workspace_subpath")?;
        args.extend([String::from("--ro-bind"), lock_str.clone(), lock_str]);
    }

    // 6. 设置工作目录与净化后的环境变量
    let cwd = command.current_dir.as_ref().unwrap_or(&spec.workspace_dir);
    let cwd_str = path_to_arg(cwd, "current_dir")?;
    args.extend([String::from("--chdir"), cwd_str]);

    let env_map = build_sanitized_env(spec, command);
    for (k, v) in env_map {
        if !k.contains('\0') && !v.contains('\0') {
            args.extend([String::from("--setenv"), k, v]);
        }
    }

    args.push(String::from("--"));
    args.push(command.program.clone());
    args.extend(command.args.iter().cloned());

    Ok((bwrap_bin.to_path_buf(), args))
}

/// 在 Linux `bwrap` + seccomp 沙箱内运行目标命令。
pub fn execute_linux(
    spec: &SandboxExecSpec,
    command: &SandboxCommand,
    inherit_stdio: bool,
) -> Result<SandboxExecutionOutput> {
    let bwrap_bin = locate_bwrap_binary().ok_or_else(|| QuetzalcoatlError::SandboxViolation {
        detail: String::from("Linux 宿主未安装 bubblewrap (bwrap)，拒绝无沙箱裸跑"),
    })?;

    let protection_guard = prepare_workspace_protections(spec)?;
    let (_, bwrap_args) =
        build_bwrap_args_with_ro_locks(spec, command, &bwrap_bin, protection_guard.ro_paths())?;
    let seccomp_file = EphemeralSeccompFile::create()?;

    let mut cmd = Command::new("/bin/sh");
    cmd.env_clear();
    cmd.arg("-c")
        .arg("bpf=$1; bw=$2; shift 2; exec \"$bw\" --seccomp 9 \"$@\" 9< \"$bpf\"")
        .arg("qz-bwrap-exec")
        .arg(seccomp_file.path())
        .arg(&bwrap_bin)
        .args(&bwrap_args);

    if inherit_stdio {
        let status = cmd
            .stdin(Stdio::inherit())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit())
            .status()
            .map_err(|e| QuetzalcoatlError::SandboxViolation {
                detail: format!("执行 bwrap 沙箱子进程失败: {e}"),
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
                    detail: format!("执行 bwrap 沙箱子进程失败: {e}"),
                })?;
        drop(protection_guard);
        Ok(SandboxExecutionOutput {
            exit_code: output.status.code().unwrap_or(128),
            stdout: output.stdout,
            stderr: output.stderr,
        })
    }
}

#[cfg(test)]
mod unit_tests {
    use super::*;

    fn simulate_bpf(bpf: &[u8], arch: u32, nr: u32) -> u32 {
        let insn_count = bpf.len() / 8;
        let mut pc = 0usize;
        let mut acc = 0u32;
        while pc < insn_count {
            let base = pc * 8;
            let code = u16::from_ne_bytes([bpf[base], bpf[base + 1]]);
            let jt = usize::from(bpf[base + 2]);
            let jf = usize::from(bpf[base + 3]);
            let k =
                u32::from_ne_bytes([bpf[base + 4], bpf[base + 5], bpf[base + 6], bpf[base + 7]]);
            match code {
                BPF_LD_W_ABS => {
                    acc = if k == SECCOMP_DATA_ARCH_OFFSET {
                        arch
                    } else {
                        nr
                    };
                    pc += 1;
                }
                BPF_JMP_JEQ_K => {
                    if acc == k {
                        pc = pc + 1 + jt;
                    } else {
                        pc = pc + 1 + jf;
                    }
                }
                BPF_RET_K => return k,
                _ => return 0,
            }
        }
        0
    }

    #[test]
    fn bpf_filter_returns_enosys_for_clone3_on_x86_64_and_aarch64_only() {
        let bpf = build_clone3_enosys_bpf();
        let expected_enosys = SECCOMP_RET_ERRNO | LINUX_ENOSYS;
        assert_eq!(
            simulate_bpf(&bpf, AUDIT_ARCH_X86_64, SYS_CLONE3_NR),
            expected_enosys
        );
        assert_eq!(
            simulate_bpf(&bpf, AUDIT_ARCH_X86_64, X32_SYSCALL_BIT | SYS_CLONE3_NR),
            expected_enosys
        );
        assert_eq!(
            simulate_bpf(&bpf, AUDIT_ARCH_AARCH64, SYS_CLONE3_NR),
            expected_enosys
        );
        assert_eq!(simulate_bpf(&bpf, AUDIT_ARCH_X86_64, 56), SECCOMP_RET_ALLOW);
        assert_eq!(
            simulate_bpf(&bpf, AUDIT_ARCH_AARCH64, 220),
            SECCOMP_RET_ALLOW
        );
        assert_eq!(
            simulate_bpf(&bpf, 0x4000_0003, SYS_CLONE3_NR),
            SECCOMP_RET_ALLOW
        );
    }

    #[test]
    fn probe_outcome_reports_apparmor_block_accurately() {
        let blocked = evaluate_linux_probe_outcome(
            Some(PathBuf::from("/usr/bin/bwrap")),
            true,
            false,
            "bwrap: setting up uid map: Permission denied",
        );
        assert!(!blocked.available);
        assert_eq!(blocked.backend, SandboxBackendKind::Unavailable);
        assert!(blocked.apparmor_userns_restricted);
        assert!(
            blocked
                .detail
                .contains("apparmor_restrict_unprivileged_userns=1")
        );
    }
}
