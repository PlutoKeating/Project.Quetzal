#![forbid(unsafe_code)]

//! 检视态（Inspector）：良知树、工具调用与审计原始载荷。
//!
//! 披露 `Summary + Detail + Raw`，因此这里**是唯一**允许出现原始 JSON、错误码、
//! socket 路径与事件序号的界面语境。

use gtk4 as gtk;
use libadwaita as adw;
use libadwaita::prelude::*;

use crate::a11y;
use crate::model::{self, UiModel};
use crate::views::{action_row, clear, empty_row, group};

/// 检视态视图的持久控件句柄。
pub struct InspectorView {
    /// 根容器。
    pub root: gtk::Box,
    /// 良知树节点列表。
    pub conscience_list: gtk::ListBox,
    /// 工具调用列表。
    pub tool_list: gtk::ListBox,
    /// 审计事件列表。
    pub audit_list: gtk::ListBox,
    /// 运行技术细节（pid / IPC 端点 / 脊柱水位 / 技术日志；仅检视态允许出现）。
    pub technical: gtk::Label,
    /// 推理增量（流式 `Reasoning` 事件）。
    pub reasoning: gtk::Label,
}

/// 构建检视态视图。
#[must_use]
pub fn build() -> InspectorView {
    let root = gtk::Box::new(gtk::Orientation::Vertical, 0);
    root.add_css_class("inspector-view");
    a11y::set_label(&root, "检视视图");

    let technical = gtk::Label::new(None);
    technical.set_xalign(0.0);
    technical.set_wrap(true);
    technical.set_selectable(true);
    technical.set_margin_top(10);
    technical.set_margin_start(18);
    technical.set_margin_end(18);
    technical.add_css_class("caption");
    technical.add_css_class("monospace");
    technical.set_visible(false);
    a11y::set_label(&technical, "连接技术原因");

    let reasoning = gtk::Label::new(None);
    reasoning.set_xalign(0.0);
    reasoning.set_wrap(true);
    reasoning.set_selectable(true);
    reasoning.set_margin_start(18);
    reasoning.set_margin_end(18);
    reasoning.set_visible(false);
    reasoning.add_css_class("caption");
    reasoning.add_css_class("monospace");
    a11y::set_label(&reasoning, "推理增量");

    let (conscience_group, conscience_list) = group("良知树");
    let (tool_group, tool_list) = group("工具");
    let (audit_group, audit_list) = group("审计");

    let content = gtk::Box::new(gtk::Orientation::Vertical, 0);
    content.append(&conscience_group);
    content.append(&tool_group);
    content.append(&audit_group);

    let scroller = gtk::ScrolledWindow::builder()
        .child(&content)
        .hexpand(true)
        .vexpand(true)
        .hscrollbar_policy(gtk::PolicyType::Never)
        .build();
    a11y::set_label(&scroller, "检视内容滚动区");

    root.append(&technical);
    root.append(&reasoning);
    root.append(&scroller);

    InspectorView {
        root,
        conscience_list,
        tool_list,
        audit_list,
        technical,
        reasoning,
    }
}

/// 用当前模型刷新检视态。
pub fn render(view: &InspectorView, model: &UiModel) {
    // 运行技术细节（pid / socket / 错误码）只允许出现在检视态。
    let mut technical: Vec<String> = Vec::new();
    match &model.connection {
        model::ConnectionState::Online {
            pid,
            endpoint,
            spine_events,
        } => {
            technical.push(format!("pid {pid}"));
            technical.push(format!("ipc {endpoint}"));
            technical.push(format!("spine_events {spine_events}"));
        }
        model::ConnectionState::Offline { .. } => {
            if let Some(degraded) = model.degraded() {
                technical.push(degraded.technical_line());
            }
        }
    }
    technical.extend(model.technical_log.iter().cloned());
    if technical.is_empty() {
        view.technical.set_visible(false);
    } else {
        view.technical.set_text(&technical.join("\n"));
        view.technical.set_visible(true);
    }

    if model.session.reasoning.trim().is_empty() {
        view.reasoning.set_visible(false);
    } else {
        view.reasoning.set_visible(true);
        view.reasoning.set_text(&model.session.reasoning);
    }

    clear(&view.conscience_list);
    let conscience = model.rows_of(model::KIND_CONSCIENCE);
    if conscience.is_empty() {
        view.conscience_list
            .append(&empty_row("良知树尚未从守护进程同步"));
    }
    for row in conscience {
        let expander = adw::ExpanderRow::new();
        expander.set_title(&row.summary);
        expander.set_title_lines(2);
        if let Some(detail) = &row.detail {
            expander.set_subtitle(detail);
            expander.set_subtitle_lines(0);
        }
        if let Some(raw) = &row.raw_json {
            let raw_label = gtk::Label::new(Some(raw));
            raw_label.set_xalign(0.0);
            raw_label.set_wrap(true);
            raw_label.set_selectable(true);
            raw_label.add_css_class("monospace");
            raw_label.add_css_class("caption");
            a11y::set_label(&raw_label, "良知节点原始载荷");
            expander.add_row(&raw_label);
        }
        a11y::set_label(&expander, &row.summary);
        view.conscience_list.append(&expander);
    }
    if let Some(body) = &model.conscience_body {
        let expander = adw::ExpanderRow::new();
        expander.set_title("良知锁定正文（仅检视态）");
        expander.set_subtitle(&format!(
            "{} 字符 · 来自本机 `conscience_pinned`",
            body.chars().count()
        ));
        let body_label = gtk::Label::new(Some(body));
        body_label.set_xalign(0.0);
        body_label.set_wrap(true);
        body_label.set_selectable(true);
        body_label.add_css_class("monospace");
        body_label.add_css_class("caption");
        a11y::set_label(&body_label, "良知锁定正文");
        expander.add_row(&body_label);
        a11y::set_label(&expander, "良知锁定正文（仅检视态）");
        view.conscience_list.append(&expander);
    }

    clear(&view.tool_list);
    let tools = model.rows_of(model::KIND_TOOL);
    if tools.is_empty() {
        view.tool_list.append(&empty_row("暂无工具调用记录"));
    }
    for row in tools {
        let view_row = action_row(&row.summary, row.detail.as_deref());
        view_row.set_activatable(false);
        if let Some(raw) = &row.raw_json {
            view_row.set_tooltip_text(Some(raw));
        }
        a11y::set_label(&view_row, &row.summary);
        view.tool_list.append(&view_row);
    }

    clear(&view.audit_list);
    let audits = model.rows_of(model::KIND_AUDIT);
    if audits.is_empty() {
        view.audit_list
            .append(&empty_row("暂无审计事件（或尚未同步）"));
    }
    for row in audits {
        let expander = adw::ExpanderRow::new();
        expander.set_title(&row.summary);
        expander.set_title_lines(2);
        if let Some(detail) = &row.detail {
            expander.set_subtitle(detail);
            expander.set_subtitle_lines(0);
        }
        if let Some(raw) = &row.raw_json {
            let raw_label = gtk::Label::new(Some(raw));
            raw_label.set_xalign(0.0);
            raw_label.set_wrap(true);
            raw_label.set_selectable(true);
            raw_label.add_css_class("monospace");
            raw_label.add_css_class("caption");
            a11y::set_label(&raw_label, "审计原始载荷");
            expander.add_row(&raw_label);
        }
        a11y::set_label(&expander, &row.summary);
        view.audit_list.append(&expander);
    }
}
