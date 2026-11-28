#![forbid(unsafe_code)]

//! 再确认一次：不可撤回的动作（抹除一条往事、吊销一台设备）之前的模态对话框。
//!
//! 版面：琥珀状态词 → 标题 → 被操作的原文 → 说明 → 口令（可选）→ 右对齐的「取消」与确认。
//! 对话框里不放白色主按钮；没有口令字段时默认焦点在「取消」。

use std::cell::RefCell;
use std::rc::Rc;

use gtk4 as gtk;
use libadwaita as adw;
use libadwaita::prelude::*;

use crate::ui::{
    Tone, amber_hint, button_outline, button_text, field, hbox, heading, input_shell, state_word,
    text, vbox,
};

/// 确认框要说的话。
pub struct ConfirmSpec {
    pub title: String,
    /// 琥珀状态词，例如「不可恢复」。
    pub word: String,
    /// 引出被操作的原文。
    pub quote: Option<String>,
    pub paragraphs: Vec<String>,
    pub confirm_label: String,
    /// 需要口令时：`(字段名, 说明)`。
    pub passphrase: Option<(String, String)>,
}

/// 动作做完时调用：`Ok` 关掉对话框，`Err` 把原因写在对话框里。
pub type Finish = Box<dyn FnOnce(Result<(), String>)>;

/// 弹出确认框。`action` 收到口令（没有口令字段时是空串）与 `Finish`。
pub fn confirm(
    anchor: &impl IsA<gtk::Widget>,
    spec: ConfirmSpec,
    action: Rc<dyn Fn(String, Finish)>,
) -> adw::Dialog {
    let dialog = adw::Dialog::new();
    dialog.set_content_width(440);
    dialog.set_follows_content_size(true);
    dialog.set_title(&spec.title);

    let body = vbox(14);
    body.set_margin_top(24);
    body.set_margin_bottom(20);
    body.set_margin_start(24);
    body.set_margin_end(24);
    body.add_css_class("qz-dialog");
    body.append(&state_word(Tone::Amber, &spec.word));
    body.append(&heading(&spec.title, &["qz-dialog-title"]));
    if let Some(quote) = &spec.quote {
        let quoted = text(quote, &["qz-detail-quote"]);
        body.append(&quoted);
    }
    for paragraph in &spec.paragraphs {
        body.append(&text(paragraph, &["qz-dialog-body"]));
    }

    let entry = gtk::PasswordEntry::new();
    entry.set_show_peek_icon(false);
    entry.set_widget_name("confirm-passphrase");
    crate::a11y::set_label(&entry, "口令");
    if let Some((label, hint)) = &spec.passphrase {
        body.append(&field(label, &input_shell(&entry, true), Some(hint)));
    }

    let failure = vbox(0);
    body.append(&failure);

    let cancel = button_text("取消");
    cancel.set_widget_name("confirm-cancel");
    let confirm_button = button_outline(&spec.confirm_label, false);
    confirm_button.set_widget_name("confirm-ok");
    let row = hbox(10);
    row.set_halign(gtk::Align::End);
    row.set_margin_top(6);
    row.append(&cancel);
    row.append(&confirm_button);
    body.append(&row);
    dialog.set_child(Some(&body));

    {
        let dialog = dialog.clone();
        cancel.connect_clicked(move |_| {
            dialog.close();
        });
    }

    let needs_passphrase = spec.passphrase.is_some();
    let busy = Rc::new(RefCell::new(false));
    {
        let dialog = dialog.clone();
        let failure = failure.clone();
        let entry = entry.clone();
        let button = confirm_button.clone();
        confirm_button.connect_clicked(move |_| {
            if *busy.borrow() {
                return;
            }
            crate::ui::clear(&failure);
            let secret = entry.text().to_string();
            if needs_passphrase && secret.is_empty() {
                failure.append(&amber_hint("先输入口令。"));
                entry.grab_focus();
                return;
            }
            *busy.borrow_mut() = true;
            button.set_sensitive(false);
            let finish_dialog = dialog.clone();
            let finish_failure = failure.clone();
            let finish_button = button.clone();
            let finish_entry = entry.clone();
            let finish_busy = busy.clone();
            action(
                secret,
                Box::new(move |result| {
                    *finish_busy.borrow_mut() = false;
                    match result {
                        Ok(()) => {
                            finish_dialog.close();
                        }
                        Err(reason) => {
                            finish_button.set_sensitive(true);
                            crate::ui::clear(&finish_failure);
                            finish_failure.append(&amber_hint(&reason));
                            if needs_passphrase {
                                finish_entry.grab_focus();
                            }
                        }
                    }
                }),
            );
        });
    }

    if needs_passphrase {
        dialog.set_focus(Some(&entry));
    } else {
        dialog.set_focus(Some(&cancel));
    }
    dialog.present(Some(anchor));
    dialog
}
