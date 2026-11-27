#![forbid(unsafe_code)]

//! 桌面端 UI 模型：三档认知密度的差分视图 + 类型化连接状态。
//!
//! 该模型**完全由** `quetzalcoatl-client-core` 的 [`ViewPatch`] 驱动，自身不持有任何
//! 数据库连接，也不允许任何视图直接读写脊柱（防坑规范 #13）。视图层只做只读投影渲染，
//! 因此切换密度不会重建或丢弃任何一行。

use quetzalcoatl_client_core::{CognitionDensity, PatchError, ProjectedRow, ViewPatch, ViewState};

use crate::degrade::{self, DegradedView};

/// 会话行（当前会话形态）。
pub const KIND_SESSION: &str = "session";
/// 项目行。
pub const KIND_PROJECT: &str = "project";
/// 待审批动作行。
pub const KIND_APPROVAL: &str = "approval";
/// 工作流行。
pub const KIND_WORKFLOW: &str = "workflow";
/// 良知树节点行。
pub const KIND_CONSCIENCE: &str = "conscience";
/// 工具调用行。
pub const KIND_TOOL: &str = "tool";
/// 审计事件行。
pub const KIND_AUDIT: &str = "audit";
/// 运行状态行（睡眠相位/脊柱水位等技术字段，仅检视态）。
pub const KIND_STATUS: &str = "status";

/// 与 `quetzalcoatld` 的连接状态（类型化，不在视图层解析字符串）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ConnectionState {
    /// 已通过本地认证 IPC 连上守护进程。
    Online {
        /// 守护进程 pid。
        pid: u32,
        /// IPC 端点（审计可见）。
        endpoint: String,
        /// 脊柱事件数。
        spine_events: usize,
    },
    /// 不可达/不安全/被拒；携带面向人的说明。
    Offline {
        /// 面向人的降级说明。
        view: DegradedView,
    },
}

impl ConnectionState {
    /// 是否在线。
    #[must_use]
    pub const fn is_online(&self) -> bool {
        matches!(self, Self::Online { .. })
    }

    /// 降级说明（在线时为 `None`）。
    #[must_use]
    pub fn degraded(&self) -> Option<&DegradedView> {
        match self {
            Self::Online { .. } => None,
            Self::Offline { view } => Some(view),
        }
    }
}

/// 桌面端 UI 模型。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UiModel {
    /// 差分视图快照（含当前密度）。
    pub view: ViewState,
    /// 连接状态。
    pub connection: ConnectionState,
    /// 本地提示（工作台可见的零术语短句）。
    pub notices: Vec<String>,
    /// 技术日志（错误码、socket、pid 等；仅检视态可见）。
    pub technical_log: Vec<String>,
    /// 良知锁定正文（`conscience_pinned`，仅检视态渲染）。
    pub conscience_body: Option<String>,
}

impl UiModel {
    /// 构造一个确定性的离线模型（无守护进程时不静默直连数据库）。
    #[must_use]
    pub fn offline(reason: impl Into<String>) -> Self {
        let mut view = degrade::offline_default();
        view.technical = reason.into();
        Self {
            view: ViewState::empty(0, CognitionDensity::Workbench),
            connection: ConnectionState::Offline { view },
            notices: Vec::new(),
            technical_log: Vec::new(),
            conscience_body: None,
        }
    }

    /// 以指定密度构造离线模型（配置恢复用）。
    #[must_use]
    pub fn offline_with_density(reason: impl Into<String>, density: CognitionDensity) -> Self {
        let mut model = Self::offline(reason);
        model.view.density = density;
        model
    }

    /// 在线模型。
    #[must_use]
    pub fn online(
        pid: u32,
        endpoint: impl Into<String>,
        spine_events: usize,
        density: CognitionDensity,
    ) -> Self {
        Self {
            view: ViewState::empty(0, density),
            connection: ConnectionState::Online {
                pid,
                endpoint: endpoint.into(),
                spine_events,
            },
            notices: Vec::new(),
            technical_log: Vec::new(),
            conscience_body: None,
        }
    }

    /// 当前密度。
    #[must_use]
    pub const fn density(&self) -> CognitionDensity {
        self.view.density
    }

    /// 幂等应用视图补丁。
    pub fn apply_patch(&mut self, patch: &ViewPatch) -> Result<(), PatchError> {
        self.view.apply(patch)
    }

    /// 切换密度：只推进一个纯密度补丁修订，绝不动任何行。
    pub fn set_density(&mut self, density: CognitionDensity) -> Result<(), PatchError> {
        if self.view.density == density {
            return Ok(());
        }
        let patch = self.view.density_patch(density);
        self.view.apply(&patch)
    }

    /// 记录一条本地提示（零术语，允许工作台展示）。
    pub fn notice(&mut self, text: impl Into<String>) {
        self.notices.push(text.into());
    }

    /// 记录一条技术细节（错误码/端点/pid；仅检视态展示）。
    pub fn technical(&mut self, text: impl Into<String>) {
        self.technical_log.push(text.into());
    }

    /// 按当前密度投影出指定种类的行。
    #[must_use]
    pub fn rows_of(&self, kind: &str) -> Vec<ProjectedRow> {
        self.view
            .project()
            .into_iter()
            .filter(|row| row.kind == kind || row.key == kind)
            .collect()
    }

    /// 当前降级说明。
    #[must_use]
    pub fn degraded(&self) -> Option<&DegradedView> {
        self.connection.degraded()
    }
}
