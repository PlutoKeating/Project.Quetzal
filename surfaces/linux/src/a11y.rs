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

/// 应用级实时播报区域（等价于一个全应用共享的 `aria-live` 区域）。
///
/// 它挂在窗口的 `GtkOverlay` 上、**不属于** 三档页栈，因此与当前认知密度无关；
/// 每批流式回复只播报一次，计时器/页面切换不会重复播报。可视尺寸 1×1、透明度 0，
/// 但仍被映射进 AT-SPI 树，辅助技术可以持续接收播报。
pub struct LiveRegion {
    widget: gtk::Label,
    announcements: std::rc::Rc<std::cell::Cell<u64>>,
    last: std::rc::Rc<std::cell::RefCell<String>>,
}

impl LiveRegion {
    /// 构建播报区域（调用方负责把它挂到窗口 overlay）。
    #[must_use]
    pub fn new() -> Self {
        let widget = gtk::Label::new(None);
        widget.set_size_request(1, 1);
        widget.set_opacity(0.0);
        widget.set_can_focus(false);
        widget.set_focusable(false);
        widget.set_can_target(false);
        widget.set_accessible_role(gtk::AccessibleRole::Status);
        widget.update_property(&[gtk::accessible::Property::RoleDescription(
            "全应用实时播报区域",
        )]);
        Self {
            widget,
            announcements: std::rc::Rc::new(std::cell::Cell::new(0)),
            last: std::rc::Rc::new(std::cell::RefCell::new(String::new())),
        }
    }

    /// 挂载用的控件。
    #[must_use]
    pub fn widget(&self) -> &gtk::Label {
        &self.widget
    }

    /// 已发生的播报次数（可观测性：测试断言「每批恰好一次」）。
    #[must_use]
    pub fn announcement_count(&self) -> u64 {
        self.announcements.get()
    }

    /// 最近一次播报文本（测试据此断言「错误优先」）。
    #[must_use]
    pub fn last_announcement(&self) -> String {
        self.last.borrow().clone()
    }

    /// 播报一段文本：更新实时区域内容 + 调 GTK 4.14 `announce()`。
    pub fn announce(&self, text: &str) {
        let text = text.trim();
        if text.is_empty() {
            return;
        }
        self.widget
            .update_property(&[gtk::accessible::Property::Label(text)]);
        if self.widget.is_realized() {
            self.widget
                .announce(text, gtk::AccessibleAnnouncementPriority::Medium);
        }
        *self.last.borrow_mut() = text.to_owned();
        self.announcements
            .set(self.announcements.get().saturating_add(1));
    }
}

impl Default for LiveRegion {
    fn default() -> Self {
        Self::new()
    }
}
