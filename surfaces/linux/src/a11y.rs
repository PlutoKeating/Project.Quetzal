#![forbid(unsafe_code)]

//! 无障碍语义辅助：给控件设置 AT-SPI 可读的名称。

use gtk::prelude::*;
use gtk4 as gtk;

/// 设置无障碍名称（等价 `aria-label`）。
pub fn set_label(widget: &impl IsA<gtk::Accessible>, text: &str) {
    widget.update_property(&[gtk::accessible::Property::Label(text)]);
}
