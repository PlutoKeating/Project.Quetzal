#![forbid(unsafe_code)]

//! 三档认知密度的原生 GTK4/libadwaita 视图。
//!
//! 每个视图只接收 [`crate::model::UiModel`] 的只读快照并做投影渲染，永远不直接接触
//! `spine.sqlite`、守护进程套接字或任何网络，因此三档切换可以纯替换可见页完成，天然
//! 保持会话与流状态。

pub mod companion;
pub mod inspector;
pub mod workbench;

use gtk4 as gtk;
use libadwaita as adw;
use libadwaita::prelude::*;

/// 构建一个「标题 + boxed list」的原生分组。
#[must_use]
pub fn group(title: &str) -> (gtk::Box, gtk::ListBox) {
    let container = gtk::Box::new(gtk::Orientation::Vertical, 8);
    container.set_margin_top(12);
    container.set_margin_bottom(12);
    container.set_margin_start(18);
    container.set_margin_end(18);

    let heading = gtk::Label::new(Some(title));
    heading.set_xalign(0.0);
    heading.add_css_class("title-4");
    crate::a11y::set_label(&heading, title);

    let list = gtk::ListBox::new();
    list.set_selection_mode(gtk::SelectionMode::None);
    list.add_css_class("boxed-list");
    list.set_can_focus(false);
    crate::a11y::set_label(&list, title);

    container.append(&heading);
    container.append(&list);
    (container, list)
}

/// 清空一个列表的全部行。
pub fn clear(list: &gtk::ListBox) {
    while let Some(child) = list.first_child() {
        list.remove(&child);
    }
}

/// 构建一行「标题 + 可选副标题」的原生 Adwaita 行。
#[must_use]
pub fn action_row(title: &str, subtitle: Option<&str>) -> adw::ActionRow {
    let row = adw::ActionRow::new();
    row.set_title(title);
    row.set_title_lines(2);
    if let Some(subtitle) = subtitle.filter(|text| !text.trim().is_empty()) {
        row.set_subtitle(subtitle);
        row.set_subtitle_lines(0);
        row.set_subtitle_selectable(true);
    }
    row
}

/// 空分组占位行（不伪造任何后端数据）。
#[must_use]
pub fn empty_row(text: &str) -> adw::ActionRow {
    let row = adw::ActionRow::new();
    row.set_title(text);
    row.set_title_lines(2);
    row.add_css_class("dim-label");
    row
}

/// 递归收集一个视图根下面所有可见文案（Label/AdwActionRow/AdwExpanderRow/Button）。
///
/// 用途有两个：无头测试断言「工作台不得出现 pid/socket/错误码」这类披露契约，
/// 以及调试时快速 dump 界面。它不触发任何布局或后端调用。
#[must_use]
pub fn visible_text(root: &impl IsA<gtk::Widget>) -> String {
    let mut out = String::new();
    collect_text(root.as_ref(), &mut out);
    out
}

fn collect_text(widget: &gtk::Widget, out: &mut String) {
    if let Some(label) = widget.downcast_ref::<gtk::Label>() {
        push_text(out, &label.text());
    }
    if let Some(row) = widget.downcast_ref::<adw::ExpanderRow>() {
        push_text(out, &row.title());
        push_text(out, &row.subtitle());
    } else if let Some(row) = widget.downcast_ref::<adw::ActionRow>() {
        push_text(out, &row.title());
        if let Some(subtitle) = row.subtitle() {
            push_text(out, &subtitle);
        }
    }
    if let Some(button) = widget.downcast_ref::<gtk::Button>()
        && let Some(label) = button.label()
    {
        push_text(out, &label);
    }
    let mut child = widget.first_child();
    while let Some(node) = child {
        collect_text(&node, out);
        child = node.next_sibling();
    }
}

fn push_text(out: &mut String, text: &str) {
    if !text.trim().is_empty() {
        out.push_str(text);
        out.push('\n');
    }
}
