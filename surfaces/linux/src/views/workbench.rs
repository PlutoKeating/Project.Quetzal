#![forbid(unsafe_code)]

//! 工作台态（Workbench）：会话、项目、审批与工作流的细节层。
//!
//! 披露 `Summary + Detail`：**绝不**出现 pid / socket / 错误码等运行技术细节
//! （那些只在检视态出现）。审批按钮挂 `win.approve` / `win.deny` 原生 `GSimpleAction`
//! （键盘可达、可被辅助技术触发）。

use gtk::glib::variant::ToVariant;
use gtk4 as gtk;
use libadwaita::prelude::*;

use crate::a11y;
use crate::model::{self, UiModel};
use crate::views::{action_row, clear, empty_row, fill_rows, group};

/// 审批动作对应的窗口动作名（由 [`crate::app`] 注册）。
pub const ACTION_APPROVE: &str = "win.approve";
/// 拒绝动作对应的窗口动作名。
pub const ACTION_DENY: &str = "win.deny";

/// 工作台视图的持久控件句柄。
pub struct WorkbenchView {
    /// 根容器。
    pub root: gtk::Box,
    /// 会话行列表。
    pub session_list: gtk::ListBox,
    /// 项目行列表。
    pub project_list: gtk::ListBox,
    /// 审批行列表。
    pub approval_list: gtk::ListBox,
    /// 工作流行列表。
    pub workflow_list: gtk::ListBox,
    /// 一行零术语状态摘要。
    pub status: gtk::Label,
    /// 最新本地提示（审批动作/重连结果等）。
    pub notice: gtk::Label,
}

/// 构建工作台视图。
#[must_use]
pub fn build() -> WorkbenchView {
    let root = gtk::Box::new(gtk::Orientation::Vertical, 0);
    root.add_css_class("workbench-view");
    a11y::set_label(&root, "工作台视图");

    let status = gtk::Label::new(Some("正在连接…"));
    status.set_xalign(0.0);
    status.set_margin_top(10);
    status.set_margin_start(18);
    status.set_margin_end(18);
    status.add_css_class("dim-label");
    a11y::set_label(&status, "连接状态");

    let notice = gtk::Label::new(None);
    notice.set_xalign(0.0);
    notice.set_wrap(true);
    notice.set_margin_start(18);
    notice.set_margin_end(18);
    notice.add_css_class("caption");
    notice.set_visible(false);
    a11y::set_label(&notice, "最新提示");

    let (session_group, session_list) = group("当前会话");
    let (project_group, project_list) = group("项目");
    let (approval_group, approval_list) = group("待批准的操作");
    let (workflow_group, workflow_list) = group("工作流");

    let content = gtk::Box::new(gtk::Orientation::Vertical, 0);
    content.append(&session_group);
    content.append(&project_group);
    content.append(&approval_group);
    content.append(&workflow_group);

    let scroller = gtk::ScrolledWindow::builder()
        .child(&content)
        .hexpand(true)
        .vexpand(true)
        .hscrollbar_policy(gtk::PolicyType::Never)
        .build();
    a11y::set_label(&scroller, "工作台内容滚动区");

    root.append(&status);
    root.append(&notice);
    root.append(&scroller);

    WorkbenchView {
        root,
        session_list,
        project_list,
        approval_list,
        workflow_list,
        status,
        notice,
    }
}

/// 用当前模型刷新工作台。
pub fn render(view: &WorkbenchView, model: &UiModel) {
    match model.notices.last() {
        Some(notice) => {
            view.notice.set_text(notice);
            view.notice.set_visible(true);
        }
        None => view.notice.set_visible(false),
    }

    if let Some(degraded) = model.degraded() {
        view.status.set_text(&format!("离线 · {}", degraded.title));
    } else {
        view.status.set_text("已连接 · 助手在运行");
    }

    fill_rows(
        &view.session_list,
        &model.rows_of(model::KIND_SESSION),
        true,
        "暂无会话记录",
    );
    fill_rows(
        &view.project_list,
        &model.rows_of(model::KIND_PROJECT),
        true,
        "暂无项目",
    );
    fill_rows(
        &view.workflow_list,
        &model.rows_of(model::KIND_WORKFLOW),
        true,
        "暂无进行中的工作流",
    );
    fill_approvals(&view.approval_list, model);
}

fn fill_approvals(list: &gtk::ListBox, model: &UiModel) {
    clear(list);
    let rows = model.rows_of(model::KIND_APPROVAL);
    if rows.is_empty() {
        list.append(&empty_row("没有等待你批准的操作"));
        return;
    }
    for row in rows {
        let view_row = action_row(&row.summary, row.detail.as_deref());
        view_row.set_activatable(false);

        let actions = gtk::Box::new(gtk::Orientation::Horizontal, 8);
        actions.set_valign(gtk::Align::Center);
        let approve = decision_button("批准", ACTION_APPROVE, &row.key);
        let deny = decision_button("拒绝", ACTION_DENY, &row.key);
        actions.append(&approve);
        actions.append(&deny);
        view_row.add_suffix(&actions);
        a11y::set_label(&view_row, &row.summary);
        list.append(&view_row);
    }
}

fn decision_button(label: &str, action: &str, key: &str) -> gtk::Button {
    let button = gtk::Button::with_label(label);
    button.set_size_request(88, 48);
    button.set_action_name(Some(action));
    button.set_action_target_value(Some(&key.to_variant()));
    a11y::set_label(&button, &format!("{label}：{key}"));
    button
}
