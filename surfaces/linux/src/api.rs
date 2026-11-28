#![forbid(unsafe_code)]

//! 治理面与守护进程之间的接口（`docs/GOVERNANCE_SURFACE.md` 第 3 节）。
//!
//! 单脊柱持有者：这里只经本机认证 IPC（`quetzalcoatl_daemon::IpcClient`）调用 `sea_*` 方法，
//! 进程内绝不打开 `spine.sqlite`。守护进程每次启动都会换令牌与端口，所以每次调用都现读
//! 运行态文件；调用在工作线程里阻塞，结果回到 GTK 主上下文再交给界面。
//! 没有任何把一句话发给他的方法。

use std::path::PathBuf;
use std::time::Duration;

use gtk::{gio, glib};
use gtk4 as gtk;
use quetzalcoatl_daemon::sea_governance::{
    AuditPage, Baseline, BaselineSigned, DevicesView, EntryWrite, HostsView, MemoriesPage,
    MemoryDetail, SeaOverview, SeaSelf, SeaUs, SeaUser,
};
use quetzalcoatl_daemon::{DirectiveDraft, IpcClient, IpcRequest, IpcResponse};

/// 读取与写入的时限：治理面是本机调用，超过它就当作联系不上。
const CALL_TIMEOUT: Duration = Duration::from_secs(8);
/// 带口令的写（签底线、吊销）要做 Argon2id，第一次签署还要封存根私钥：多给些时间。
const PASSPHRASE_CALL_TIMEOUT: Duration = Duration::from_secs(45);

/// 一次调用没有成功。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ApiError {
    /// 联系不上守护进程（没有运行、刚重启、传输失败）。
    Unreachable(String),
    /// 守护进程答复了一个错误。
    Remote { code: String, detail: String },
    /// 答复读不懂：不是这个方法该有的形状。
    Unexpected(String),
}

impl ApiError {
    /// 是不是「联系不上」。
    #[must_use]
    pub fn is_unreachable(&self) -> bool {
        matches!(self, Self::Unreachable(_))
    }

    /// 写成一句给人看的话。
    #[must_use]
    pub fn describe(&self) -> String {
        match self {
            Self::Unreachable(_) => String::from("联系不上本机的守护进程。"),
            Self::Remote { code, detail } if detail.is_empty() => {
                format!("守护进程拒绝了这次请求（{code}）。")
            }
            Self::Remote { detail, .. } => detail.clone(),
            Self::Unexpected(detail) => format!("守护进程的答复读不懂：{detail}。"),
        }
    }

    /// 守护进程给出的机器可读错误码（口令不对等）。
    #[must_use]
    pub fn code(&self) -> Option<&str> {
        match self {
            Self::Remote { code, .. } => Some(code),
            _ => None,
        }
    }
}

/// 守护进程的本机入口。
#[derive(Clone, Debug)]
pub struct Api {
    home: PathBuf,
}

/// 从 `IpcResponse` 里取出这个方法该有的载荷。
type Extract<T> = fn(IpcResponse) -> Option<T>;

impl Api {
    /// 以家目录创建（不探活、不读文件）。
    #[must_use]
    pub fn new(home: PathBuf) -> Self {
        Self { home }
    }

    /// 家目录。
    #[must_use]
    pub fn home(&self) -> &std::path::Path {
        &self.home
    }

    /// 同步调用一次（工作线程里用）。
    pub fn call_blocking(&self, request: &IpcRequest) -> Result<IpcResponse, ApiError> {
        blocking_call(&self.home, request)
    }

    /// 异步调用：阻塞部分在工作线程，`done` 在 GTK 主上下文里执行。
    pub fn call<T: Send + 'static>(
        &self,
        request: IpcRequest,
        extract: Extract<T>,
        done: impl FnOnce(Result<T, ApiError>) + 'static,
    ) {
        let home = self.home.clone();
        glib::spawn_future_local(async move {
            let outcome = gio::spawn_blocking(move || {
                blocking_call(&home, &request).and_then(|response| {
                    extract(response).ok_or_else(|| {
                        ApiError::Unexpected(String::from("答复不是这个方法该有的形状"))
                    })
                })
            })
            .await;
            match outcome {
                Ok(result) => done(result),
                Err(_) => done(Err(ApiError::Unreachable(String::from("调用线程意外结束")))),
            }
        });
    }
}

fn blocking_call(home: &std::path::Path, request: &IpcRequest) -> Result<IpcResponse, ApiError> {
    let Some(client) = IpcClient::from_home_unprobed(home) else {
        return Err(ApiError::Unreachable(String::from(
            "run/daemon.json 或 run/daemon.token 缺失",
        )));
    };
    let timeout = match request {
        IpcRequest::SeaBaselineSign { .. } | IpcRequest::SeaDeviceRevoke { .. } => {
            PASSPHRASE_CALL_TIMEOUT
        }
        _ => CALL_TIMEOUT,
    };
    match client.with_timeout(timeout).call(request) {
        Ok(IpcResponse::Error { code, detail }) => Err(ApiError::Remote { code, detail }),
        Ok(response) => Ok(response),
        Err(err) => Err(ApiError::Unreachable(err.to_string())),
    }
}

// ---------------------------------------------------------------- 读

/// 每个方法一行：请求怎么拼、答复里取哪个变体。
impl Api {
    pub fn overview(&self, done: impl FnOnce(Result<SeaOverview, ApiError>) + 'static) {
        self.call(
            IpcRequest::SeaOverview,
            |r| match r {
                IpcResponse::SeaOverview(v) => Some(v),
                _ => None,
            },
            done,
        );
    }

    pub fn self_page(&self, done: impl FnOnce(Result<SeaSelf, ApiError>) + 'static) {
        self.call(
            IpcRequest::SeaSelf,
            |r| match r {
                IpcResponse::SeaSelf(v) => Some(v),
                _ => None,
            },
            done,
        );
    }

    pub fn user(&self, done: impl FnOnce(Result<SeaUser, ApiError>) + 'static) {
        self.call(
            IpcRequest::SeaUser,
            |r| match r {
                IpcResponse::SeaUser(v) => Some(v),
                _ => None,
            },
            done,
        );
    }

    pub fn us(&self, done: impl FnOnce(Result<SeaUs, ApiError>) + 'static) {
        self.call(
            IpcRequest::SeaUs,
            |r| match r {
                IpcResponse::SeaUs(v) => Some(v),
                _ => None,
            },
            done,
        );
    }

    pub fn memories(
        &self,
        query: Option<String>,
        state: Option<String>,
        cursor: Option<String>,
        limit: usize,
        done: impl FnOnce(Result<MemoriesPage, ApiError>) + 'static,
    ) {
        self.call(
            IpcRequest::SeaMemories {
                query,
                state,
                cursor,
                limit: Some(limit),
            },
            |r| match r {
                IpcResponse::SeaMemories(v) => Some(v),
                _ => None,
            },
            done,
        );
    }

    pub fn memory(&self, id: String, done: impl FnOnce(Result<MemoryDetail, ApiError>) + 'static) {
        self.call(
            IpcRequest::SeaMemory { id },
            |r| match r {
                IpcResponse::SeaMemory(v) => Some(v),
                _ => None,
            },
            done,
        );
    }

    pub fn baseline(&self, done: impl FnOnce(Result<Baseline, ApiError>) + 'static) {
        self.call(
            IpcRequest::SeaBaseline,
            |r| match r {
                IpcResponse::SeaBaseline(v) => Some(v),
                _ => None,
            },
            done,
        );
    }

    pub fn hosts(&self, done: impl FnOnce(Result<HostsView, ApiError>) + 'static) {
        self.call(
            IpcRequest::SeaHosts,
            |r| match r {
                IpcResponse::SeaHosts(v) => Some(v),
                _ => None,
            },
            done,
        );
    }

    pub fn devices(&self, done: impl FnOnce(Result<DevicesView, ApiError>) + 'static) {
        self.call(
            IpcRequest::SeaDevices,
            |r| match r {
                IpcResponse::SeaDevices(v) => Some(v),
                _ => None,
            },
            done,
        );
    }

    pub fn audit(
        &self,
        cursor: Option<String>,
        limit: usize,
        done: impl FnOnce(Result<AuditPage, ApiError>) + 'static,
    ) {
        self.call(
            IpcRequest::SeaAudit {
                cursor,
                limit: Some(limit),
            },
            |r| match r {
                IpcResponse::SeaAudit(v) => Some(v),
                _ => None,
            },
            done,
        );
    }
}

// ---------------------------------------------------------------- 写（都是本人亲手触发）

impl Api {
    pub fn entry_update(
        &self,
        id: String,
        text: String,
        done: impl FnOnce(Result<EntryWrite, ApiError>) + 'static,
    ) {
        self.call(
            IpcRequest::SeaEntryUpdate { id, text },
            |r| match r {
                IpcResponse::SeaEntryUpdate(v) => Some(v),
                _ => None,
            },
            done,
        );
    }

    pub fn entry_mute(
        &self,
        id: String,
        muted: bool,
        done: impl FnOnce(Result<EntryWrite, ApiError>) + 'static,
    ) {
        self.call(
            IpcRequest::SeaEntryMute { id, muted },
            |r| match r {
                IpcResponse::SeaEntryMute(v) => Some(v),
                _ => None,
            },
            done,
        );
    }

    pub fn entry_erase(
        &self,
        id: String,
        done: impl FnOnce(Result<EntryWrite, ApiError>) + 'static,
    ) {
        self.call(
            IpcRequest::SeaEntryErase { id },
            |r| match r {
                IpcResponse::SeaEntryErase(v) => Some(v),
                _ => None,
            },
            done,
        );
    }

    pub fn baseline_sign(
        &self,
        directives: Vec<DirectiveDraft>,
        passphrase: String,
        done: impl FnOnce(Result<BaselineSigned, ApiError>) + 'static,
    ) {
        self.call(
            IpcRequest::SeaBaselineSign {
                directives,
                passphrase,
            },
            |r| match r {
                IpcResponse::SeaBaselineSign(v) => Some(v),
                _ => None,
            },
            done,
        );
    }

    pub fn rhythm_set(
        &self,
        speak_first: bool,
        quiet_hours: Option<(u8, u8)>,
        done: impl FnOnce(Result<SeaSelf, ApiError>) + 'static,
    ) {
        self.call(
            IpcRequest::SeaRhythmSet {
                speak_first,
                quiet_hours,
            },
            |r| match r {
                IpcResponse::SeaRhythmSet(v) => Some(v),
                _ => None,
            },
            done,
        );
    }

    pub fn focus_set(
        &self,
        self_weight: f64,
        done: impl FnOnce(Result<SeaUs, ApiError>) + 'static,
    ) {
        self.call(
            IpcRequest::SeaFocusSet { self_weight },
            |r| match r {
                IpcResponse::SeaFocusSet(v) => Some(v),
                _ => None,
            },
            done,
        );
    }

    pub fn device_revoke(
        &self,
        device_id: String,
        passphrase: String,
        done: impl FnOnce(Result<DevicesView, ApiError>) + 'static,
    ) {
        self.call(
            IpcRequest::SeaDeviceRevoke {
                device_id,
                passphrase,
            },
            |r| match r {
                IpcResponse::SeaDeviceRevoke(v) => Some(v),
                _ => None,
            },
            done,
        );
    }
}
