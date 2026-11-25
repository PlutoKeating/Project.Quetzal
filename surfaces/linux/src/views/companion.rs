#![forbid(unsafe_code)]

//! 陪伴态（Companion）：零术语、超大点按目标、流式对话正文。
//!
//! 该视图只披露 `Summary` 层：不出现 IPC、socket、pid、事件序号等任何术语；离线时
//! 用日常语言说明下一步，并在「检视」里才展示技术原因。

use gtk::prelude::*;
use gtk4 as gtk;

use crate::a11y;
use crate::model::UiModel;

/// 陪伴态视图的持久控件句柄（构建一次，只更新内容）。
pub struct CompanionView {
    /// 根容器。
    pub root: gtk::Box,
    /// 顶部大标题。
    pub heading: gtk::Label,
    /// 对话正文（`aria-live` 等价区域）。
    pub transcript: gtk::Label,
    /// 大号输入框（≥64pt）。
    pub entry: gtk::Entry,
    /// 发送按钮（≥64pt）。
    pub send: gtk::Button,
    /// 重新连接按钮（离线时出现，≥64pt）。
    pub retry: gtk::Button,
    /// 降级说明。
    pub hint: gtk::Label,
    /// 连接状态。
    pub status: gtk::Label,
}

/// 构建陪伴态视图（不绑定任何回调，回调由 `crate::app` 统一接线）。
#[must_use]
pub fn build() -> CompanionView {
    let root = gtk::Box::new(gtk::Orientation::Vertical, 16);
    root.set_margin_top(28);
    root.set_margin_bottom(24);
    root.set_margin_start(28);
    root.set_margin_end(28);
    root.add_css_class("companion-view");
    a11y::set_label(&root, "陪伴视图");

    let heading = gtk::Label::new(Some("今天想聊点什么？"));
    heading.set_xalign(0.0);
    heading.set_wrap(true);
    heading.add_css_class("title-1");
    a11y::set_label(&heading, "陪伴视图标题");

    let transcript = gtk::Label::new(None);
    transcript.set_wrap(true);
    transcript.set_selectable(true);
    // 只读正文不需要抢占键盘焦点：避免首帧把整段文本渲染成选区高亮。
    transcript.set_focusable(false);
    transcript.set_xalign(0.0);
    transcript.set_yalign(0.0);
    transcript.set_valign(gtk::Align::Start);
    transcript.set_hexpand(true);
    transcript.set_vexpand(true);
    transcript.add_css_class("title-3");
    a11y::set_label(&transcript, "对话内容");
    a11y::set_description(&transcript, "对话会持续更新，新的回复会自动播报");
    a11y::mark_live_region(&transcript, "会持续更新的对话内容");
    a11y::mark_multiline(&transcript);

    let scroller = gtk::ScrolledWindow::builder()
        .child(&transcript)
        .hexpand(true)
        .vexpand(true)
        .hscrollbar_policy(gtk::PolicyType::Never)
        .build();
    a11y::set_label(&scroller, "对话内容滚动区");

    let hint = gtk::Label::new(None);
    hint.set_wrap(true);
    hint.set_xalign(0.0);
    hint.add_css_class("dim-label");
    hint.set_visible(false);

    let entry = gtk::Entry::new();
    entry.set_placeholder_text(Some("想说什么都行"));
    entry.set_hexpand(true);
    entry.set_size_request(-1, 64);
    a11y::set_label(&entry, "想说的话");
    a11y::set_description(&entry, "输入一句话，按回车或点发送");

    let send = gtk::Button::with_label("发送");
    send.set_size_request(160, 72);
    send.add_css_class("suggested-action");
    a11y::set_label(&send, "发送这句话");

    let composer = gtk::Box::new(gtk::Orientation::Horizontal, 12);
    composer.append(&entry);
    composer.append(&send);

    let retry = gtk::Button::with_label("重新连接");
    retry.set_size_request(-1, 72);
    retry.set_visible(false);
    a11y::set_label(&retry, "重新连接本机助手");

    let status = gtk::Label::new(Some("正在连接…"));
    status.set_xalign(0.0);
    status.add_css_class("dim-label");
    a11y::set_label(&status, "连接状态");

    root.append(&heading);
    root.append(&scroller);
    root.append(&hint);
    root.append(&composer);
    root.append(&retry);
    root.append(&status);

    CompanionView {
        root,
        heading,
        transcript,
        entry,
        send,
        retry,
        hint,
        status,
    }
}

/// 用当前模型刷新陪伴态。
pub fn render(view: &CompanionView, model: &UiModel) {
    let offline = model.degraded();
    if let Some(degraded) = offline {
        view.heading.set_text("我还没连上本机的助手");
        view.hint
            .set_text(&format!("{}\n{}", degraded.detail, degraded.hint));
        view.hint.set_visible(true);
        view.retry.set_visible(true);
        view.entry.set_sensitive(false);
        view.send.set_sensitive(false);
        view.status.set_text("已断开");
    } else {
        view.heading.set_text("今天想聊点什么？");
        view.hint.set_visible(false);
        view.retry.set_visible(false);
        view.entry.set_sensitive(true);
        view.send.set_sensitive(true);
        view.status.set_text(if model.session.streaming {
            "正在回复…"
        } else {
            "已连接"
        });
    }

    let transcript = if model.session.messages.is_empty() {
        if offline.is_some() {
            String::from("助手启动后，我们刚才聊到哪儿都会接上。")
        } else {
            String::from("我在这儿。想说什么都可以。")
        }
    } else {
        model.session.transcript()
    };
    // 实时播报统一由 `app::ingest_stream_batch` 的应用级 LiveRegion 负责：
    // 这里只渲染文本，绝不重复调用 announce()。
    view.transcript.set_text(&transcript);
}
