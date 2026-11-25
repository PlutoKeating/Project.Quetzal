#![deny(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]

//! `quetzalcoatl-uniffi` — Swift 6 / Kotlin 2.2 / .NET 9+ 三语言绑定的**拉模式**薄接口。
//!
//! 防坑规范 #14 的两条硬约束：
//!
//! 1. `uniffi` 精确锁定 `=0.32.0`（见根 `Cargo.toml`），`uniffi-bindgen-cs` 未发布到
//!    crates.io，改为按配对标签 `v0.12.0+v0.32.0` 安装同名工具，配对关系记录在
//!    [`bindgen-cs-pin.json`](../bindgen-cs-pin.json) 并由集成测试强制校验。
//! 2. **绝不导出外语回调接口**：没有任何 `callback_interface` / `with_foreign`，宿主只能
//!    通过 [`FfiViewStream::next_events`] 主动拉取有界批次（规避 C# 异步回调生成同步
//!    签名 Bug `#165` 与 GC 委托悬垂崩溃）。
//!
//! `unsafe` 豁免边界：本文件手写代码零 `unsafe`；唯一可能产生 `unsafe` 的位置是
//! `uniffi::setup_scaffolding!()` 宏展开的 FFI 胶水（`#[unsafe(no_mangle)]` 导出符号），
//! 因此 crate 级 lint 为 `deny(unsafe_code)` 而非 `forbid`。集成测试
//! `api_surface::handwritten_sources_contain_no_unsafe` 会静态扫描 `src/` 保证手写代码不含
//! 任何 `unsafe` 关键字。

use std::sync::{Arc, Mutex, MutexGuard};

use quetzalcoatl_client_core::llm_stream_bridge::{
    EventSource, StreamError, StreamEvent, StreamEventKind, ViewStream,
};
use quetzalcoatl_client_core::view_models::{
    CognitionDensity, PatchError, ViewOp, ViewPatch, ViewRow, ViewState,
};
use thiserror::Error;

uniffi::setup_scaffolding!();

#[derive(Clone, Copy, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum FfiCognitionDensity {
    Companion,
    Workbench,
    Inspector,
}

impl From<FfiCognitionDensity> for CognitionDensity {
    fn from(value: FfiCognitionDensity) -> Self {
        match value {
            FfiCognitionDensity::Companion => Self::Companion,
            FfiCognitionDensity::Workbench => Self::Workbench,
            FfiCognitionDensity::Inspector => Self::Inspector,
        }
    }
}

impl From<CognitionDensity> for FfiCognitionDensity {
    fn from(value: CognitionDensity) -> Self {
        match value {
            CognitionDensity::Companion => Self::Companion,
            CognitionDensity::Workbench => Self::Workbench,
            CognitionDensity::Inspector => Self::Inspector,
        }
    }
}

/// 一个 LLM/视图流事件（拉模式批次中的元素）。
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct FfiStreamEvent {
    pub seq: u64,
    pub kind: String,
    pub text: String,
}

impl From<StreamEvent> for FfiStreamEvent {
    fn from(event: StreamEvent) -> Self {
        Self {
            seq: event.seq,
            kind: stream_kind_label(event.kind).to_owned(),
            text: event.text,
        }
    }
}

fn stream_kind_label(kind: StreamEventKind) -> &'static str {
    match kind {
        StreamEventKind::Delta => "delta",
        StreamEventKind::Reasoning => "reasoning",
        StreamEventKind::ToolCall => "tool_call",
        StreamEventKind::Done => "done",
        StreamEventKind::Error => "error",
    }
}

/// 视图行（跨 FFI 的静态记录，避免外语侧持有 Rust 引用）。
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct FfiViewRow {
    pub key: String,
    pub kind: String,
    pub summary: String,
    pub detail: Option<String>,
    pub raw_json: Option<String>,
    pub updated_rev: u64,
}

impl From<ViewRow> for FfiViewRow {
    fn from(row: ViewRow) -> Self {
        Self {
            key: row.key,
            kind: row.kind,
            summary: row.summary,
            detail: row.detail,
            raw_json: row.raw_json,
            updated_rev: row.updated_rev,
        }
    }
}

impl From<FfiViewRow> for ViewRow {
    fn from(row: FfiViewRow) -> Self {
        Self {
            key: row.key,
            kind: row.kind,
            summary: row.summary,
            detail: row.detail,
            raw_json: row.raw_json,
            updated_rev: row.updated_rev,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, uniffi::Enum)]
pub enum FfiViewOp {
    Upsert { row: FfiViewRow },
    Remove { key: String },
}

impl From<FfiViewOp> for ViewOp {
    fn from(op: FfiViewOp) -> Self {
        match op {
            FfiViewOp::Upsert { row } => Self::Upsert { row: row.into() },
            FfiViewOp::Remove { key } => Self::Remove { key },
        }
    }
}

impl From<ViewOp> for FfiViewOp {
    fn from(op: ViewOp) -> Self {
        match op {
            ViewOp::Upsert { row } => Self::Upsert { row: row.into() },
            ViewOp::Remove { key } => Self::Remove { key },
        }
    }
}

/// 响应式差分包：宿主按 `from_rev → to_rev` 幂等重放。
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct FfiViewPatch {
    pub from_rev: u64,
    pub to_rev: u64,
    pub density: FfiCognitionDensity,
    pub ops: Vec<FfiViewOp>,
}

impl From<ViewPatch> for FfiViewPatch {
    fn from(patch: ViewPatch) -> Self {
        Self {
            from_rev: patch.from_rev,
            to_rev: patch.to_rev,
            density: patch.density.into(),
            ops: patch.ops.into_iter().map(Into::into).collect(),
        }
    }
}

impl From<FfiViewPatch> for ViewPatch {
    fn from(patch: FfiViewPatch) -> Self {
        Self {
            from_rev: patch.from_rev,
            to_rev: patch.to_rev,
            density: patch.density.into(),
            ops: patch.ops.into_iter().map(Into::into).collect(),
        }
    }
}

/// 完整视图快照（可由历史补丁重放得到，也可一次性全量下发）。
#[derive(Clone, Debug, PartialEq, Eq, uniffi::Record)]
pub struct FfiViewSnapshot {
    pub rev: u64,
    pub density: FfiCognitionDensity,
    pub rows: Vec<FfiViewRow>,
}

#[derive(Debug, Error, uniffi::Error)]
pub enum FfiError {
    #[error("视图补丁序裂: {detail}")]
    PatchOutOfSequence { detail: String },

    #[error("视图补丁非法: {detail}")]
    PatchMalformed { detail: String },

    #[error("流已取消")]
    StreamCancelled,

    #[error("流已结束")]
    StreamFinished,

    #[error("拉取批次超时")]
    StreamTimeout,

    #[error("流生产者已断开: {detail}")]
    StreamBroken { detail: String },
}

impl From<PatchError> for FfiError {
    fn from(error: PatchError) -> Self {
        match error {
            PatchError::OutOfSequence { .. } => Self::PatchOutOfSequence {
                detail: error.to_string(),
            },
            other => Self::PatchMalformed {
                detail: other.to_string(),
            },
        }
    }
}

impl From<StreamError> for FfiError {
    fn from(error: StreamError) -> Self {
        match error {
            StreamError::Cancelled => Self::StreamCancelled,
            StreamError::Finished => Self::StreamFinished,
            StreamError::Timeout { .. } => Self::StreamTimeout,
            StreamError::ProducerGone => Self::StreamBroken {
                detail: String::from("producer gone"),
            },
            StreamError::Poisoned => Self::StreamBroken {
                detail: String::from("stream state poisoned"),
            },
        }
    }
}

/// 三档认知密度的视图会话（宿主持有，线程安全）。
#[derive(uniffi::Object)]
pub struct FfiViewSession {
    state: Mutex<ViewState>,
}

#[uniffi::export]
impl FfiViewSession {
    #[uniffi::constructor]
    #[must_use]
    pub fn new(density: FfiCognitionDensity) -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(ViewState::empty(0, density.into())),
        })
    }

    /// 幂等应用一个补丁（重复下发同一补丁是安全空操作）。
    pub fn apply_patch(&self, patch: FfiViewPatch) -> Result<(), FfiError> {
        let mut state = self.lock_state()?;
        state.apply(&patch.into()).map_err(Into::into)
    }

    #[must_use]
    pub fn rev(&self) -> u64 {
        self.lock_state().map(|state| state.rev).unwrap_or(0)
    }

    pub fn density(&self) -> Result<FfiCognitionDensity, FfiError> {
        Ok(self.lock_state()?.density.into())
    }

    /// 生成"切换到目标密度"的补丁（宿主可当作普通补丁重放）。
    pub fn switch_density(&self, density: FfiCognitionDensity) -> Result<FfiViewPatch, FfiError> {
        let state = self.lock_state()?;
        Ok(state.density_patch(density.into()).into())
    }

    /// 全量快照（Inspector 密度下等价于全量状态树）。
    pub fn snapshot(&self) -> Result<FfiViewSnapshot, FfiError> {
        let state = self.lock_state()?;
        Ok(FfiViewSnapshot {
            rev: state.rev,
            density: state.density.into(),
            rows: state.rows.values().cloned().map(Into::into).collect(),
        })
    }

    /// 按当前密度裁剪后的行集合（Companion 端只拿到摘要，绝不含原始载荷）。
    pub fn projected_rows(&self) -> Result<Vec<FfiViewRow>, FfiError> {
        let state = self.lock_state()?;
        Ok(state
            .project()
            .into_iter()
            .map(|row| FfiViewRow {
                key: row.key,
                kind: row.kind,
                summary: row.summary,
                detail: row.detail,
                raw_json: row.raw_json,
                updated_rev: state.rev,
            })
            .collect())
    }
}

impl FfiViewSession {
    fn lock_state(&self) -> Result<MutexGuard<'_, ViewState>, FfiError> {
        self.state.lock().map_err(|_| FfiError::StreamBroken {
            detail: String::from("view session state poisoned"),
        })
    }
}

/// 拉模式 LLM 流（唯一的外语消费方式；无任何回调注册）。
#[derive(uniffi::Object)]
pub struct FfiViewStream {
    inner: ViewStream,
}

/// 确定性演示/回放事件源：按 `0..event_count` 生成 `Delta` 事件后以 `Done` 结束。
struct FfiScriptedSource {
    next_seq: u64,
    event_count: u64,
}

impl EventSource for FfiScriptedSource {
    fn next_event(&mut self) -> Option<StreamEvent> {
        if self.next_seq < self.event_count {
            let seq = self.next_seq;
            self.next_seq += 1;
            return Some(StreamEvent {
                seq,
                kind: StreamEventKind::Delta,
                text: format!("delta-{seq}"),
            });
        }
        if self.next_seq == self.event_count {
            self.next_seq += 1;
            return Some(StreamEvent {
                seq: self.event_count,
                kind: StreamEventKind::Done,
                text: String::from("done"),
            });
        }
        None
    }
}

#[uniffi::export]
impl FfiViewStream {
    /// 构造一个确定性的 `Delta` 流（真实宿主由回环网关 SSE 解析器驱动同一接口）。
    #[uniffi::constructor]
    #[must_use]
    pub fn new(event_count: u32) -> Arc<Self> {
        Arc::new(Self {
            inner: ViewStream::spawn(FfiScriptedSource {
                next_seq: 0,
                event_count: u64::from(event_count),
            }),
        })
    }

    /// 拉取至多 `max_events` 个事件（内部硬上界 64，绝无无界缓冲）。
    pub fn next_events(&self, max_events: u32) -> Result<Vec<FfiStreamEvent>, FfiError> {
        let max = usize::try_from(max_events).unwrap_or(usize::MAX);
        self.inner
            .next_events(max)
            .map(|events| events.into_iter().map(Into::into).collect())
            .map_err(Into::into)
    }

    /// 立即取消并回收生产者线程（幂等）。
    pub fn cancel(&self) -> Result<(), FfiError> {
        self.inner.cancel().map_err(Into::into)
    }

    #[must_use]
    pub fn is_finished(&self) -> bool {
        self.inner.is_finished()
    }

    #[must_use]
    pub fn is_cancelled(&self) -> bool {
        self.inner.is_cancelled()
    }
}
