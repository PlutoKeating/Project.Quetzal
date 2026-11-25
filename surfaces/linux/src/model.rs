#![forbid(unsafe_code)]

//! 桌面端 UI 模型：三档认知密度的差分视图 + 会话/流状态 + 类型化连接状态。
//!
//! 该模型**完全由** `quetzalcoatl-client-core` 的 [`ViewPatch`] 与 [`StreamEvent`]
//! 驱动，自身不持有任何数据库连接，也不允许任何视图直接读写脊柱（防坑规范 #13）。
//! 视图层只做投影渲染，因此切换密度不会重建、丢弃或重放任何会话/流状态。

use quetzalcoatl_client_core::{
    CognitionDensity, PatchError, ProjectedRow, StreamEvent, StreamEventKind, ViewPatch, ViewState,
};

use crate::degrade::{self, DegradedView};

/// 会话行（当前对话线程）。
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

/// 会话内一条消息的角色。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChatRole {
    /// 用户。
    User,
    /// 助手（流式增量都并入最后一条助手消息）。
    Assistant,
    /// 系统/工具/错误等提示。
    System,
}

/// 会话内一条消息。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChatLine {
    /// 角色。
    pub role: ChatRole,
    /// 正文。
    pub text: String,
}

/// 当前会话与流状态（跨密度切换保持不变）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SessionState {
    /// 线程标识（合成数据或守护进程返回值）。
    pub thread_id: String,
    /// 线程标题。
    pub title: String,
    /// 已发生的消息。
    pub messages: Vec<ChatLine>,
    /// 推理增量（`Inspector` 可见）。
    pub reasoning: String,
    /// 是否正在流式接收。
    pub streaming: bool,
    /// 已消费的最大事件序号（用于幂等去重）。
    pub last_seq: u64,
}

impl SessionState {
    /// 新建空会话。
    #[must_use]
    pub fn new() -> Self {
        Self {
            thread_id: String::from("local"),
            title: String::from("当前会话"),
            messages: Vec::new(),
            reasoning: String::new(),
            streaming: false,
            last_seq: 0,
        }
    }

    /// 面向人的完整对话文本（`Companion` 直接展示）。
    #[must_use]
    pub fn transcript(&self) -> String {
        self.messages
            .iter()
            .map(|line| match line.role {
                ChatRole::User => format!("你：{}", line.text),
                ChatRole::Assistant => line.text.clone(),
                ChatRole::System => format!("· {}", line.text),
            })
            .collect::<Vec<_>>()
            .join("\n\n")
    }
}

impl Default for SessionState {
    fn default() -> Self {
        Self::new()
    }
}

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

/// 一次流事件批次的消费结果（供无障碍播报与视图刷新决策）。
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct StreamIngest {
    /// 实际消费的事件数（被幂等去重的旧事件不计）。
    pub applied: usize,
    /// 本批新增的正文增量。
    pub deltas: String,
    /// 需要实时播报的短句（`aria-live` 等价物）。
    pub announcements: Vec<String>,
}

/// 桌面端 UI 模型。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UiModel {
    /// 差分视图快照（含当前密度）。
    pub view: ViewState,
    /// 会话与流状态。
    pub session: SessionState,
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
            session: SessionState::new(),
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
            session: SessionState::new(),
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

    /// 切换密度：只推进一个纯密度补丁修订，绝不动任何行或会话状态。
    pub fn set_density(&mut self, density: CognitionDensity) -> Result<(), PatchError> {
        if self.view.density == density {
            return Ok(());
        }
        let patch = self.view.density_patch(density);
        self.view.apply(&patch)
    }

    /// 消费一批拉模式流事件（幂等：重复批次不会重复追加正文）。
    pub fn ingest_stream(&mut self, events: &[StreamEvent]) -> StreamIngest {
        let mut ingest = StreamIngest::default();
        for event in events {
            if event.seq != 0 {
                if event.seq <= self.session.last_seq {
                    continue;
                }
                self.session.last_seq = event.seq;
            }
            ingest.applied += 1;
            match event.kind {
                StreamEventKind::Delta => {
                    self.session.streaming = true;
                    self.append_assistant_delta(&event.text);
                    ingest.deltas.push_str(&event.text);
                }
                StreamEventKind::Reasoning => {
                    self.session.reasoning.push_str(&event.text);
                }
                StreamEventKind::ToolCall => {
                    self.session.messages.push(ChatLine {
                        role: ChatRole::System,
                        text: format!("工具：{}", event.text),
                    });
                }
                StreamEventKind::Done => {
                    self.session.streaming = false;
                }
                StreamEventKind::Error => {
                    self.session.streaming = false;
                    self.session.messages.push(ChatLine {
                        role: ChatRole::System,
                        text: format!("出错了：{}", event.text),
                    });
                    ingest
                        .announcements
                        .push(format!("本轮出错了：{}", event.text));
                }
            }
        }
        if !ingest.deltas.trim().is_empty() {
            ingest
                .announcements
                .push(tail_chars(&ingest.deltas, 80).to_owned());
        }
        ingest
    }

    /// 追加用户消息（本地回显）。
    pub fn push_user_message(&mut self, text: impl Into<String>) {
        let text = text.into();
        if text.trim().is_empty() {
            return;
        }
        self.session.messages.push(ChatLine {
            role: ChatRole::User,
            text,
        });
    }

    /// 追加一段助手正文增量。
    pub fn append_assistant_delta(&mut self, text: &str) {
        if let Some(last) = self.session.messages.last_mut()
            && last.role == ChatRole::Assistant
        {
            last.text.push_str(text);
            return;
        }
        self.session.messages.push(ChatLine {
            role: ChatRole::Assistant,
            text: text.to_owned(),
        });
    }

    /// 收束当前流（非流式 IPC 回包同样走这条路径）。
    pub fn finish_stream(&mut self) {
        self.session.streaming = false;
    }

    /// 记录一条本地提示（零术语，允许工作台展示）。
    pub fn notice(&mut self, text: impl Into<String>) {
        self.notices.push(text.into());
    }

    /// 记录一条技术细节（错误码/端点/pid；仅检视态展示）。
    pub fn technical(&mut self, text: impl Into<String>) {
        self.technical_log.push(text.into());
    }

    /// 最近一条助手消息（工作台的流式回复区直接复用）。
    #[must_use]
    pub fn last_assistant_text(&self) -> Option<&str> {
        self.session
            .messages
            .iter()
            .rev()
            .find(|line| line.role == ChatRole::Assistant)
            .map(|line| line.text.as_str())
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

fn tail_chars(text: &str, limit: usize) -> &str {
    let count = text.chars().count();
    if count <= limit {
        return text.trim();
    }
    let skip = count - limit;
    let start = text
        .char_indices()
        .nth(skip)
        .map(|(index, _)| index)
        .unwrap_or(0);
    text.get(start..).unwrap_or(text).trim()
}
