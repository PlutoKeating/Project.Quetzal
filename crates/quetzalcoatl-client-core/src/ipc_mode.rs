#![forbid(unsafe_code)]

//! 单脊柱持有者薄客户端自动切换器（防坑规范 #13）。
//!
//! 规则极简且不可协商：
//!
//! * 发现本机 `quetzalcoatld`（`spine/daemon.lock` + `run/daemon.json` + `run/daemon.token`
//!   三者齐备、令牌文件为当前用户 `0600` 私有、且 `/v1/health` 握手成功）时，**所有**
//!   读取与写入都经本地认证 IPC（优先 `0600` Unix Domain Socket，回退 `127.0.0.1` 回环）。
//! * 任一条件不满足即返回类型化 [`ClientError::DaemonUnavailable`] 或
//!   [`ClientError::InsecureRuntimeFiles`]，**绝不**静默直接打开 `spine/spine.sqlite`。
//!   本 crate **不直接依赖** `rusqlite` / `quetzalcoatl-spine`；到 SQLite 的唯一间接路径
//!   是 `quetzalcoatl-daemon` 的 IPC 协议类型（客户端进程只做 HTTP/JSON 往返，不持有任何
//!   数据库连接）。该不变量由 `tests/dependency_graph.rs` 对真实依赖图断言，并由
//!   `tests/thin_client_mount.rs` 对**子进程** `/proc/self/fd` 的动态断言兜底。
//! * 只读取运行必需的 `run/daemon.token`，且必须先通过权限/属主校验才触碰其内容。

use std::fs;
use std::path::{Path, PathBuf};

use quetzalcoatl_daemon::{DaemonRuntimeInfo, DaemonStatus, IpcClient, IpcRequest, IpcResponse};
use thiserror::Error;

/// 脊柱独占锁（守护进程在线时必然存在）。
pub const DAEMON_LOCK_REL: &str = "spine/daemon.lock";
/// 守护进程运行时信息（IPC 地址、网关地址、身份）。
pub const DAEMON_RUNTIME_REL: &str = "run/daemon.json";
/// IPC 管理员令牌（`0600` 私有）。
pub const DAEMON_TOKEN_REL: &str = "run/daemon.token";

const TOKEN_HEX_LEN: usize = 64;

#[derive(Debug, Error)]
pub enum ClientError {
    #[error("本机 quetzalcoatld 不可达，薄客户端拒绝直接打开 spine.sqlite: {detail}")]
    DaemonUnavailable { detail: String },

    #[error("本地 IPC 往返失败: {detail}")]
    IpcTransport { detail: String },

    #[error("本地 IPC 拒绝请求 [{code}]: {detail}")]
    IpcRemote { code: String, detail: String },

    #[error("运行时文件权限不安全，拒绝读取 IPC 令牌: {detail}")]
    InsecureRuntimeFiles { detail: String },
}

/// 解析客户端家目录（显式参数优先，其次 `QUETZALCOATL_HOME`，最后平台默认）。
#[must_use]
pub fn resolve_client_home(explicit: Option<PathBuf>) -> PathBuf {
    quetzalcoatl_daemon::resolve_quetzalcoatl_home(explicit)
}

/// 当前进程的有效 UID（Linux `/proc/self/status`，无需 `libc`/`unsafe`）。
#[cfg(unix)]
#[must_use]
pub fn current_effective_uid() -> Option<u32> {
    let status = fs::read_to_string("/proc/self/status").ok()?;
    let line = status.lines().find(|line| line.starts_with("Uid:"))?;
    let effective = line.split_whitespace().nth(2)?;
    effective.parse::<u32>().ok()
}

#[cfg(not(unix))]
#[must_use]
pub fn current_effective_uid() -> Option<u32> {
    None
}

#[cfg(unix)]
fn check_token_file_privacy(path: &Path) -> Result<(), ClientError> {
    use std::os::unix::fs::MetadataExt;

    let meta = fs::metadata(path).map_err(|e| ClientError::InsecureRuntimeFiles {
        detail: format!("无法读取 IPC 令牌元数据 ({}): {e}", path.display()),
    })?;
    if !meta.is_file() {
        return Err(ClientError::InsecureRuntimeFiles {
            detail: format!("IPC 令牌不是普通文件: {}", path.display()),
        });
    }
    if meta.mode() & 0o077 != 0 {
        return Err(ClientError::InsecureRuntimeFiles {
            detail: format!(
                "IPC 令牌权限过宽 (mode=0o{:o}, 需要 0600): {}",
                meta.mode() & 0o777,
                path.display()
            ),
        });
    }
    let euid = current_effective_uid().ok_or_else(|| ClientError::InsecureRuntimeFiles {
        detail: String::from("无法确定当前有效 UID，拒绝读取 IPC 令牌"),
    })?;
    if meta.uid() != euid {
        return Err(ClientError::InsecureRuntimeFiles {
            detail: format!(
                "IPC 令牌属主 uid={} 与当前有效 uid={euid} 不一致: {}",
                meta.uid(),
                path.display()
            ),
        });
    }
    Ok(())
}

#[cfg(not(unix))]
fn check_token_file_privacy(_path: &Path) -> Result<(), ClientError> {
    // Windows 上没有 POSIX 权限位；`%LOCALAPPDATA%` 的 ACL 由守护进程创建时继承。
    Ok(())
}

fn unavailable(detail: impl Into<String>) -> ClientError {
    ClientError::DaemonUnavailable {
        detail: detail.into(),
    }
}

/// 经本地认证 IPC 读写本机脊柱的薄客户端。
pub struct ThinClient {
    qz_home: PathBuf,
    runtime: DaemonRuntimeInfo,
    ipc: IpcClient,
}

impl std::fmt::Debug for ThinClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ThinClient")
            .field("qz_home", &self.qz_home)
            .field("pid", &self.runtime.pid)
            .field("ipc_http_addr", &self.runtime.ipc_http_addr)
            .field("unix_socket_path", &self.runtime.unix_socket_path)
            .finish_non_exhaustive()
    }
}

impl ThinClient {
    /// 仅当守护进程确实在线（运行时文件齐备 + 令牌私有 + 健康握手成功）时才成功返回。
    ///
    /// 本函数**只做读取**，不会创建任何目录/文件，也绝不触碰 `spine.sqlite`。
    pub fn mount(qz_home: &Path) -> Result<Self, ClientError> {
        let lock_path = qz_home.join(DAEMON_LOCK_REL);
        let info_path = qz_home.join(DAEMON_RUNTIME_REL);
        let token_path = qz_home.join(DAEMON_TOKEN_REL);

        if !lock_path.is_file() {
            return Err(unavailable(format!(
                "未发现脊柱独占锁 {}（quetzalcoatld 未运行）",
                lock_path.display()
            )));
        }
        if !info_path.is_file() || !token_path.is_file() {
            return Err(unavailable(format!(
                "守护进程运行时文件缺失 (info={}, token={})",
                info_path.is_file(),
                token_path.is_file()
            )));
        }

        // 权限校验严格先于令牌内容读取与 JSON 解析（未获授权绝不消费密钥）。
        check_token_file_privacy(&token_path)?;

        let raw_info = fs::read(&info_path)
            .map_err(|e| unavailable(format!("读取 {} 失败: {e}", info_path.display())))?;
        let runtime: DaemonRuntimeInfo = serde_json::from_slice(&raw_info)
            .map_err(|e| unavailable(format!("解析 daemon.json 失败: {e}")))?;

        let raw_token = fs::read_to_string(&token_path)
            .map_err(|e| unavailable(format!("读取 IPC 令牌失败: {e}")))?;
        let token = raw_token.trim().to_owned();
        if token.len() != TOKEN_HEX_LEN || !token.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(unavailable(String::from(
                "IPC 令牌格式非法（应为 64 位十六进制）",
            )));
        }

        #[cfg(unix)]
        if let Some(sock) = &runtime.unix_socket_path
            && !sock.exists()
        {
            return Err(unavailable(format!(
                "daemon.sock 不存在（{}），守护进程可能已崩溃",
                sock.display()
            )));
        }

        let ipc = IpcClient::from_runtime_info(&runtime, token);
        match ipc.call(&IpcRequest::Status) {
            Ok(IpcResponse::Status(_)) => {}
            Ok(IpcResponse::Error { code, detail }) => {
                return Err(ClientError::IpcRemote { code, detail });
            }
            Ok(_) => {
                return Err(unavailable(String::from("健康握手返回了非 Status 响应")));
            }
            Err(err) => {
                return Err(unavailable(format!(
                    "健康握手失败 ({}) : {err}",
                    runtime.ipc_http_addr
                )));
            }
        }

        Ok(Self {
            qz_home: qz_home.to_path_buf(),
            runtime,
            ipc,
        })
    }

    /// 唯一的状态读写通道：所有查询与变更都必须经此 IPC 调用。
    pub fn call(&self, request: &IpcRequest) -> Result<IpcResponse, ClientError> {
        let response = self
            .ipc
            .call(request)
            .map_err(|e| ClientError::IpcTransport {
                detail: e.to_string(),
            })?;
        if let IpcResponse::Error { code, detail } = &response {
            return Err(ClientError::IpcRemote {
                code: code.clone(),
                detail: detail.clone(),
            });
        }
        Ok(response)
    }

    /// 读取守护进程状态（薄客户端最常用的只读入口）。
    pub fn status(&self) -> Result<DaemonStatus, ClientError> {
        match self.call(&IpcRequest::Status)? {
            IpcResponse::Status(status) => Ok(*status),
            _ => Err(unavailable(String::from("Status 调用返回了非 Status 响应"))),
        }
    }

    #[must_use]
    pub fn home(&self) -> &Path {
        &self.qz_home
    }

    #[must_use]
    pub const fn runtime_info(&self) -> &DaemonRuntimeInfo {
        &self.runtime
    }
}
