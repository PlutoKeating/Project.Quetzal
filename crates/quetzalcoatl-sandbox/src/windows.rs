#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]

//! Windows `mxc-sdk` AppContainer + `srt-win` Restricted Token 分级无容器沙箱后端。

use std::path::PathBuf;
use std::process::{Command, Stdio};

use quetzalcoatl_crypto::hex_encode;
use quetzalcoatl_types::{QuetzalcoatlError, Result};
use serde::{Deserialize, Serialize};

use crate::{
    NetworkPolicy, PROTECTED_WORKSPACE_SUBPATHS, SandboxBackendKind, SandboxCommand,
    SandboxExecSpec, SandboxExecutionOutput, SandboxMode, SandboxProbeReport, build_sanitized_env,
    collect_all_masked_paths, prepare_workspace_protections,
};

/// Windows Low Mandatory Integrity Level SID (`S-1-16-4096`).
pub const WIN_LOW_INTEGRITY_SID: &str = "S-1-16-4096";
/// Windows AppContainer InternetClient Capability SID (`S-1-15-3-1`).
pub const WIN_CAP_INTERNET_CLIENT_SID: &str = "S-1-15-3-1";
/// Windows AppContainer PrivateNetworkClientServer Capability SID (`S-1-15-3-3`).
pub const WIN_CAP_PRIVATE_NETWORK_SID: &str = "S-1-15-3-3";

/// Windows 分级沙箱层级。
#[derive(Copy, Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WindowsSandboxTier {
    /// 首选：`mxc-sdk` AppContainer 低特权能力隔离容器。
    MxcAppContainer,
    /// 回退：`srt-win` 受限令牌（Restricted Token）+ JobObject + 显式拒绝 DACL。
    SrtRestrictedToken,
}

/// Windows 对象 ACL 规则描述。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct WindowsAclEntry {
    pub path: PathBuf,
    pub access: WindowsAccessDisposition,
}

/// Windows 路径访问权限配置。
#[derive(Copy, Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WindowsAccessDisposition {
    AllowReadExecute,
    AllowReadWrite,
    DenyWrite,
    DenyAll,
}

/// 供跨平台验证与 Windows 执行器消费的完整沙箱执行计划。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct WindowsSandboxPlan {
    pub tier: WindowsSandboxTier,
    pub profile_moniker: String,
    pub capability_sids: Vec<String>,
    pub stripped_privileges: Vec<String>,
    pub integrity_level_sid: String,
    pub kill_on_job_close: bool,
    pub acl_entries: Vec<WindowsAclEntry>,
    pub program: String,
    pub args: Vec<String>,
}

/// 构造 Windows `mxc-sdk` / `srt-win` 分级沙箱计划（跨平台纯逻辑可测）。
pub fn build_windows_sandbox_plan(
    spec: &SandboxExecSpec,
    command: &SandboxCommand,
    appcontainer_available: bool,
) -> Result<WindowsSandboxPlan> {
    if spec.workspace_dir.as_os_str().is_empty() {
        return Err(QuetzalcoatlError::SandboxViolation {
            detail: String::from("Windows 沙箱工作区路径不能为空"),
        });
    }
    if command.program.is_empty() || command.program.contains('\0') {
        return Err(QuetzalcoatlError::SandboxViolation {
            detail: String::from("Windows 沙箱目标程序名不能为空或包含 NUL"),
        });
    }

    let mut hasher = blake3::Hasher::new_derive_key("quetzalcoatl/v2/windows-sandbox-profile-v1");
    hasher.update(spec.quetzalcoatl_home.to_string_lossy().as_bytes());
    hasher.update(&[0]);
    hasher.update(spec.workspace_dir.to_string_lossy().as_bytes());
    hasher.update(&[match spec.mode {
        SandboxMode::WorkspaceWritable => 0,
        SandboxMode::CleanRoomReadOnly => 1,
    }]);
    let digest = hasher.finalize();
    let profile_moniker = format!(
        "Quetzalcoatl.Sandbox.{}",
        hex_encode(&digest.as_bytes()[..8])
    );

    let tier = if appcontainer_available {
        WindowsSandboxTier::MxcAppContainer
    } else {
        WindowsSandboxTier::SrtRestrictedToken
    };

    let capability_sids = match (tier, spec.network_policy) {
        (WindowsSandboxTier::MxcAppContainer, NetworkPolicy::AllowHostNetwork) => vec![
            String::from(WIN_CAP_INTERNET_CLIENT_SID),
            String::from(WIN_CAP_PRIVATE_NETWORK_SID),
        ],
        _ => Vec::new(),
    };

    let stripped_privileges = vec![
        String::from("SeDebugPrivilege"),
        String::from("SeTakeOwnershipPrivilege"),
        String::from("SeRestorePrivilege"),
        String::from("SeBackupPrivilege"),
        String::from("SeImpersonatePrivilege"),
        String::from("SeCreateGlobalPrivilege"),
        String::from("SeLoadDriverPrivilege"),
        String::from("SeTcbPrivilege"),
    ];

    let mut acl_entries = Vec::new();
    for masked in collect_all_masked_paths(spec) {
        acl_entries.push(WindowsAclEntry {
            path: masked,
            access: WindowsAccessDisposition::DenyAll,
        });
    }

    match spec.mode {
        SandboxMode::WorkspaceWritable => {
            acl_entries.push(WindowsAclEntry {
                path: spec.workspace_dir.clone(),
                access: WindowsAccessDisposition::AllowReadWrite,
            });
            for rel in PROTECTED_WORKSPACE_SUBPATHS {
                acl_entries.push(WindowsAclEntry {
                    path: spec.workspace_dir.join(rel),
                    access: WindowsAccessDisposition::DenyWrite,
                });
            }
        }
        SandboxMode::CleanRoomReadOnly => {
            acl_entries.push(WindowsAclEntry {
                path: spec.workspace_dir.clone(),
                access: WindowsAccessDisposition::AllowReadExecute,
            });
            if let Some(suite_dir) = &spec.verifier_suite_dir {
                acl_entries.push(WindowsAclEntry {
                    path: suite_dir.clone(),
                    access: WindowsAccessDisposition::AllowReadExecute,
                });
            }
        }
    }

    Ok(WindowsSandboxPlan {
        tier,
        profile_moniker,
        capability_sids,
        stripped_privileges,
        integrity_level_sid: String::from(WIN_LOW_INTEGRITY_SID),
        kill_on_job_close: true,
        acl_entries,
        program: command.program.clone(),
        args: command.args.clone(),
    })
}

fn find_windows_launcher() -> Option<(WindowsSandboxTier, PathBuf)> {
    if let Some(path_os) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path_os) {
            let mxc = dir.join("mxc-sandbox.exe");
            if mxc.is_file() {
                return Some((WindowsSandboxTier::MxcAppContainer, mxc));
            }
            let srt = dir.join("srt-win.exe");
            if srt.is_file() {
                return Some((WindowsSandboxTier::SrtRestrictedToken, srt));
            }
        }
    }
    None
}

/// 探测当前 Windows 宿主可用沙箱等级。
pub fn probe_windows() -> Result<SandboxProbeReport> {
    if let Some((tier, bin)) = find_windows_launcher() {
        let backend = match tier {
            WindowsSandboxTier::MxcAppContainer => SandboxBackendKind::WindowsMxcAppContainer,
            WindowsSandboxTier::SrtRestrictedToken => SandboxBackendKind::WindowsSrtRestrictedToken,
        };
        Ok(SandboxProbeReport {
            backend,
            available: true,
            binary_path: Some(bin),
            supports_network_isolation: true,
            supports_readonly_bind: true,
            supports_seccomp_clone3_enosys: false,
            apparmor_userns_restricted: false,
            detail: format!("Windows 分级无容器沙箱就绪 ({backend:?})"),
        })
    } else {
        Ok(SandboxProbeReport {
            backend: SandboxBackendKind::Unavailable,
            available: false,
            binary_path: None,
            supports_network_isolation: false,
            supports_readonly_bind: false,
            supports_seccomp_clone3_enosys: false,
            apparmor_userns_restricted: false,
            detail: String::from("未检测到 mxc-sdk AppContainer 或 srt-win 受限令牌启动器"),
        })
    }
}

/// 在 Windows 分级沙箱中执行目标命令。
pub fn execute_windows(
    spec: &SandboxExecSpec,
    command: &SandboxCommand,
    inherit_stdio: bool,
) -> Result<SandboxExecutionOutput> {
    let (tier, launcher_bin) =
        find_windows_launcher().ok_or_else(|| QuetzalcoatlError::SandboxViolation {
            detail: String::from("Windows 宿主缺少 mxc-sdk / srt-win 沙箱启动器，拒绝无沙箱裸跑"),
        })?;
    let protection_guard = prepare_workspace_protections(spec)?;
    let plan =
        build_windows_sandbox_plan(spec, command, tier == WindowsSandboxTier::MxcAppContainer)?;
    let plan_json =
        serde_json::to_string(&plan).map_err(|e| QuetzalcoatlError::SerializationError {
            detail: format!("序列化 WindowsSandboxPlan 失败: {e}"),
        })?;

    let env_map = build_sanitized_env(spec, command);
    let cwd = command.current_dir.as_ref().unwrap_or(&spec.workspace_dir);
    let mut cmd = Command::new(launcher_bin);
    cmd.env_clear()
        .envs(&env_map)
        .current_dir(cwd)
        .args(["--plan-json", &plan_json, "--", &plan.program])
        .args(&plan.args);

    if inherit_stdio {
        let status = cmd
            .stdin(Stdio::inherit())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit())
            .status()
            .map_err(|e| QuetzalcoatlError::SandboxViolation {
                detail: format!("启动 Windows 沙箱进程失败: {e}"),
            })?;
        drop(protection_guard);
        Ok(SandboxExecutionOutput {
            exit_code: status.code().unwrap_or(1),
            stdout: Vec::new(),
            stderr: Vec::new(),
        })
    } else {
        let output =
            cmd.stdin(Stdio::null())
                .output()
                .map_err(|e| QuetzalcoatlError::SandboxViolation {
                    detail: format!("启动 Windows 沙箱进程失败: {e}"),
                })?;
        drop(protection_guard);
        Ok(SandboxExecutionOutput {
            exit_code: output.status.code().unwrap_or(1),
            stdout: output.stdout,
            stderr: output.stderr,
        })
    }
}
