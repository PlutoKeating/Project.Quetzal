#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]

//! `quetzalcoatl-uniffi` — Swift 6 / Kotlin 2.2 / .NET 9+ 三语言绑定的薄接口（只读视图会话）。
//!
//! 防坑规范 #14 的两条硬约束：
//!
//! 1. `uniffi` 精确锁定 `=0.32.0`（见根 `Cargo.toml`），`uniffi-bindgen-cs` 未发布到
//!    crates.io，改为按配对标签 `v0.12.0+v0.32.0` 安装同名工具，配对关系记录在
//!    [`bindgen-cs-pin.json`](../bindgen-cs-pin.json) 并由集成测试强制校验。
//! 2. **绝不导出外语回调接口**：没有任何 `callback_interface` / `with_foreign`，宿主只能
//!    主动调用对象方法（拉模式），不存在任何由 Rust 向外语侧推送的通道（规避 C# 异步回调生成同步
//!    签名 Bug `#165` 与 GC 委托悬垂崩溃）。
//!
//! `unsafe` 边界：本 crate 与全工作区一致启用了 `#![forbid(unsafe_code)]`。
//! `uniffi::setup_scaffolding!()` 与 `#[uniffi::export]` 宏展开的 `#[unsafe(no_mangle)]`
//! 导出符号来自外部宏 span，不受本 crate 的 `forbid` 约束，因此**不需要任何收窄豁免**。
//! 集成测试 `api_surface::handwritten_sources_contain_no_unsafe` 额外静态扫描 `src/`，
//! 保证手写代码不含 `unsafe` 关键字。

use std::sync::{Arc, Mutex, MutexGuard};

use quetzalcoatl_client_core::view_models::{
    CognitionDensity, DetailLayer, PatchError, ViewOp, ViewPatch, ViewRow, ViewState,
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

    #[error("视图会话状态已损坏: {detail}")]
    StatePoisoned { detail: String },
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

    /// 当前修订号；状态锁中毒时返回类型化错误，绝不静默降级为 `0`。
    pub fn rev(&self) -> Result<u64, FfiError> {
        Ok(self.lock_state()?.rev)
    }

    pub fn density(&self) -> Result<FfiCognitionDensity, FfiError> {
        Ok(self.lock_state()?.density.into())
    }

    /// 生成"切换到目标密度"的补丁（**纯函数**：不修改会话状态，宿主需自行 `apply_patch` 重放）。
    pub fn density_patch(&self, density: FfiCognitionDensity) -> Result<FfiViewPatch, FfiError> {
        let state = self.lock_state()?;
        Ok(state.density_patch(density.into()).into())
    }

    /// 当前密度的完整快照：**与 [`Self::projected_rows`] 使用同一裁剪规则**，
    /// Companion 只含摘要、Workbench 不含原始载荷、Inspector 才全量。
    pub fn snapshot(&self) -> Result<FfiViewSnapshot, FfiError> {
        let state = self.lock_state()?;
        let density = state.density;
        Ok(FfiViewSnapshot {
            rev: state.rev,
            density: density.into(),
            rows: state
                .rows
                .values()
                .map(|row| project_row(row, density))
                .collect(),
        })
    }

    /// 按当前密度裁剪后的行集合（Companion 端只拿到摘要，绝不含原始载荷）；
    /// 每行保留自身真实 `updated_rev`，与 [`Self::snapshot`] 逐字段一致。
    pub fn projected_rows(&self) -> Result<Vec<FfiViewRow>, FfiError> {
        let state = self.lock_state()?;
        let density = state.density;
        Ok(state
            .rows
            .values()
            .map(|row| project_row(row, density))
            .collect())
    }
}

/// 单一裁剪实现：快照与投影共用，避免两条路径的隐私契约漂移。
fn project_row(row: &ViewRow, density: CognitionDensity) -> FfiViewRow {
    FfiViewRow {
        key: row.key.clone(),
        kind: row.kind.clone(),
        summary: row.summary.clone(),
        detail: if density.includes(DetailLayer::Detail) {
            row.detail.clone()
        } else {
            None
        },
        raw_json: if density.includes(DetailLayer::Raw) {
            row.raw_json.clone()
        } else {
            None
        },
        updated_rev: row.updated_rev,
    }
}

impl FfiViewSession {
    fn lock_state(&self) -> Result<MutexGuard<'_, ViewState>, FfiError> {
        self.state.lock().map_err(|_| FfiError::StatePoisoned {
            detail: String::from("view session state poisoned"),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[allow(clippy::panic, clippy::expect_used)]
    fn poisoned_session_state_yields_typed_error_instead_of_zero_rev() {
        let session = FfiViewSession::new(FfiCognitionDensity::Workbench);
        let poisoned = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _guard = session.state.lock().expect("view session lock");
            panic!("poison view session");
        }));
        assert!(poisoned.is_err(), "必须真实污染状态锁");
        assert!(
            matches!(session.rev(), Err(FfiError::StatePoisoned { .. })),
            "锁中毒时 rev 必须返回类型化错误，实际 {:?}",
            session.rev()
        );
        assert!(matches!(
            session.snapshot(),
            Err(FfiError::StatePoisoned { .. })
        ));
    }
}
