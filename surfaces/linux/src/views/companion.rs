#![forbid(unsafe_code)]

//! 陪伴态（Companion）：零术语、只读的近况一览。
//!
//! 该视图只披露 `Summary` 层：会话、良知与审计每行只有一句话摘要，不展开细节与原始
//! 载荷，也不出现 pid、socket、错误码等运行技术细节；离线时用日常语言说明下一步，
//! 技术原因只在「检视」里展示。

use gtk::prelude::*;
use gtk4 as gtk;

use crate::a11y;
use crate::model::{self, UiModel};
use crate::views::{fill_rows, group};

/// 在线时的只读说明。
const READ_ONLY_NOTE: &str = "这个窗口只用来查看，不提供输入。";

/// 与分组容器一致的水平边距，让标题区和分组左右对齐。
const SIDE_MARGIN: i32 = 18;

/// 陪伴态视图的持久控件句柄（构建一次，只更新内容）。
pub struct CompanionView {
    /// 根容器。
    pub root: gtk::Box,
    /// 顶部大标题。
    pub heading: gtk::Label,
    /// 连接状态。
    pub status: gtk::Label,
    /// 只读说明（在线）或降级说明（离线）。
    pub hint: gtk::Label,
    /// 重新连接按钮（离线时出现，≥64pt）。
    pub retry: gtk::Button,
    /// 会话行列表（仅摘要）。
    pub session_list: gtk::ListBox,
    /// 良知行列表（仅摘要）。
    pub conscience_list: gtk::ListBox,
    /// 审计行列表（仅摘要）。
    pub audit_list: gtk::ListBox,
}

/// 构建陪伴态视图（不绑定任何回调，回调由 `crate::app` 统一接线）。
#[must_use]
pub fn build() -> CompanionView {
    let root = gtk::Box::new(gtk::Orientation::Vertical, 8);
    root.set_margin_top(28);
    root.set_margin_bottom(12);
    root.set_margin_start(10);
    root.set_margin_end(10);
    root.add_css_class("companion-view");
    a11y::set_label(&root, "陪伴视图");

    let heading = gtk::Label::new(Some("本机助手的近况"));
    heading.set_xalign(0.0);
    heading.set_wrap(true);
    heading.set_margin_start(SIDE_MARGIN);
    heading.set_margin_end(SIDE_MARGIN);
    heading.add_css_class("title-1");
    a11y::set_label(&heading, "陪伴视图标题");

    let status = gtk::Label::new(Some("正在连接…"));
    status.set_xalign(0.0);
    status.set_margin_start(SIDE_MARGIN);
    status.set_margin_end(SIDE_MARGIN);
    status.add_css_class("dim-label");
    a11y::set_label(&status, "连接状态");

    let hint = gtk::Label::new(Some(READ_ONLY_NOTE));
    hint.set_wrap(true);
    hint.set_xalign(0.0);
    hint.set_margin_start(SIDE_MARGIN);
    hint.set_margin_end(SIDE_MARGIN);
    hint.add_css_class("dim-label");
    a11y::set_label(&hint, "窗口说明");

    let retry = gtk::Button::with_label("重新连接");
    retry.set_size_request(-1, 72);
    retry.set_margin_top(8);
    retry.set_margin_start(SIDE_MARGIN);
    retry.set_margin_end(SIDE_MARGIN);
    retry.set_visible(false);
    a11y::set_label(&retry, "重新连接本机助手");

    let (session_group, session_list) = group("当前会话");
    let (conscience_group, conscience_list) = group("良知");
    let (audit_group, audit_list) = group("审计");

    let content = gtk::Box::new(gtk::Orientation::Vertical, 0);
    content.append(&session_group);
    content.append(&conscience_group);
    content.append(&audit_group);

    let scroller = gtk::ScrolledWindow::builder()
        .child(&content)
        .hexpand(true)
        .vexpand(true)
        .hscrollbar_policy(gtk::PolicyType::Never)
        .build();
    a11y::set_label(&scroller, "近况滚动区");

    root.append(&heading);
    root.append(&status);
    root.append(&hint);
    root.append(&retry);
    root.append(&scroller);

    CompanionView {
        root,
        heading,
        status,
        hint,
        retry,
        session_list,
        conscience_list,
        audit_list,
    }
}

/// 用当前模型刷新陪伴态。
pub fn render(view: &CompanionView, model: &UiModel) {
    if let Some(degraded) = model.degraded() {
        view.heading.set_text("我还没连上本机的助手");
        view.status.set_text("已断开");
        view.hint
            .set_text(&format!("{}\n{}", degraded.detail, degraded.hint));
        view.retry.set_visible(true);
    } else {
        view.heading.set_text("本机助手的近况");
        view.status.set_text("已连接");
        view.hint.set_text(READ_ONLY_NOTE);
        view.retry.set_visible(false);
    }

    fill_rows(
        &view.session_list,
        &model.rows_of(model::KIND_SESSION),
        false,
        "暂无会话记录",
    );
    fill_rows(
        &view.conscience_list,
        &model.rows_of(model::KIND_CONSCIENCE),
        false,
        "良知尚未从本机助手同步",
    );
    fill_rows(
        &view.audit_list,
        &model.rows_of(model::KIND_AUDIT),
        false,
        "暂无审计记录",
    );
}
