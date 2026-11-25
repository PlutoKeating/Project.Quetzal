#![forbid(unsafe_code)]

//! 无障碍语义辅助：AT-SPI 等价的名称/描述属性与实时播报。
//!
//! GTK4 的 `gtk::accessible::Property` 类型化封装目前未暴露 `live` 属性，因此流式回复的
//! 「`aria-live` 等价物」由两条路径组成：
//! 1. 给播报目标设置 `RoleDescription`（让辅助技术知道这是会持续更新的对话区）；
//! 2. 每次流式批次收束时调用 GTK 4.14 的 `announce()`，由 AT-SPI 以 MEDIUM 优先级播报。
//!
//! 无 AT-SPI 总线（容器/Xvfb）时 `announce()` 是安全的空操作，绝不 panic、绝不弹窗。

use gtk::prelude::*;
use gtk4 as gtk;

/// 设置无障碍名称（等价 `aria-label`）。
pub fn set_label(widget: &impl IsA<gtk::Accessible>, text: &str) {
    widget.update_property(&[gtk::accessible::Property::Label(text)]);
}

/// 设置无障碍描述（等价 `aria-description`）。
pub fn set_description(widget: &impl IsA<gtk::Accessible>, text: &str) {
    widget.update_property(&[gtk::accessible::Property::Description(text)]);
}

/// 标记一个会持续更新的区域（等价 `aria-live="polite"` 的角色说明部分）。
pub fn mark_live_region(widget: &impl IsA<gtk::Accessible>, description: &str) {
    widget.update_property(&[gtk::accessible::Property::RoleDescription(description)]);
}

/// 以 MEDIUM 优先级实时播报一段文本；无辅助技术总线时静默。
pub fn announce<T>(widget: &T, text: &str)
where
    T: IsA<gtk::Accessible> + IsA<gtk::Widget>,
{
    if text.trim().is_empty() || !widget.is_realized() {
        return;
    }
    widget.announce(text, gtk::AccessibleAnnouncementPriority::Medium);
}

/// 标记只读文本区为多行（辅助技术据此使用浏览模式）。
pub fn mark_multiline(widget: &impl IsA<gtk::Accessible>) {
    widget.update_property(&[gtk::accessible::Property::MultiLine(true)]);
}
