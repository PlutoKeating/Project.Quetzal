#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]

//! `quetzalcoatl-client-core` — 五端客户端共享的纯 Rust 核心。
//!
//! 三条不可让渡的契约：
//!
//! 1. **单脊柱持有者**（防坑规范 #13）：本机 `quetzalcoatld` 在线时，客户端一切读取与写入
//!    只能经本地认证 IPC；本 crate 不依赖 `rusqlite`，因此**物理上不可能**打开
//!    `spine/spine.sqlite`。守护进程不可达时返回类型化 [`ClientError::DaemonUnavailable`]，
//!    绝不静默直接打开数据库。
//! 2. **三档认知密度的差分视图**：`Companion / Workbench / Inspector` 通过
//!    [`ViewPatch`] 幂等重放得到完整 [`ViewState`] 快照。
//! 3. **拉模式异步流**（防坑规范 #14）：只暴露 [`ViewStream::next_events`] 拉取接口，
//!    绝不注册外语回调；批次有界，`Drop` 与 `cancel` 都会立即回收生产者线程。

pub mod llm_stream_bridge;
pub mod view_models;

#[cfg(not(target_arch = "wasm32"))]
pub mod ipc_mode;

pub use llm_stream_bridge::{
    DEFAULT_PULL_TIMEOUT, EventSource, MAX_BATCH_EVENTS, ScriptedSource, StreamError, StreamEvent,
    StreamEventKind, ViewStream, live_producer_threads,
};
pub use view_models::{
    CognitionDensity, DetailLayer, PatchError, ProjectedRow, ViewOp, ViewPatch, ViewRow, ViewState,
};

#[cfg(not(target_arch = "wasm32"))]
pub use ipc_mode::{
    ClientError, DAEMON_LOCK_REL, DAEMON_RUNTIME_REL, DAEMON_TOKEN_REL, ThinClient,
    current_effective_uid, resolve_client_home,
};
