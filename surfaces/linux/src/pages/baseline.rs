#![forbid(unsafe_code)]

//! 底线：几条短句 + 口令框 + 签署。签署是全窗唯一的主按钮（白色）。
//! 未签署时整页的状态词是琥珀色的「待签署」；签署后是冰蓝色的「自某日起生效」。
//! 部署约束列在下方，只读。

use std::cell::{Cell, RefCell};
use std::rc::{Rc, Weak};

use gtk::prelude::*;
use gtk4 as gtk;
use quetzalcoatl_daemon::DirectiveDraft;
use quetzalcoatl_daemon::sea_governance::Baseline;

use crate::api::ApiError;
use crate::aside::Provenance;
use crate::ctx::{Ctx, Page, upgrade};
use crate::routes::PageKey;
use crate::timefmt::{format_date, ordinal};
use crate::ui::{
    Fact, Situation, Step, Tone, actions, amber_hint, button_outline, button_text, button_white,
    field, hbox, heading, input_shell, line, pick, section, text, vbox,
};

use super::{Frame, compact_empty, empty_page, frame, unavailable};

const MAX_CLAUSES: usize = 12;

#[derive(Clone, Debug, PartialEq, Eq)]
struct Clause {
    key: String,
    title: String,
    text: String,
}

fn to_clauses(data: &Baseline) -> Vec<Clause> {
    data.directives
        .iter()
        .map(|d| Clause {
            key: d.id.clone(),
            title: d.title.clone(),
            text: d.text.clone(),
        })
        .collect()
}

pub struct BaselinePage {
    ctx: Rc<Ctx>,
    frame: Frame,
    data: RefCell<Option<Baseline>>,
    failure: RefCell<Option<ApiError>>,
    clauses: RefCell<Vec<Clause>>,
    dirty: Cell<bool>,
    /// 正在改的那一条：`Some(None)` 是新添的一条，`Some(Some(i))` 是第 i 条。
    editing: RefCell<Option<Option<usize>>>,
    edit_failure: RefCell<Option<String>>,
    sign_failure: RefCell<Option<String>>,
    selected: RefCell<Option<String>>,
    recent: RefCell<Option<String>>,
    signing: Cell<bool>,
    secret: gtk::PasswordEntry,
    repeat: gtk::PasswordEntry,
    title_entry: gtk::Entry,
    text_view: gtk::TextView,
    me: Weak<BaselinePage>,
}

impl BaselinePage {
    pub fn build(ctx: &Rc<Ctx>) -> Rc<dyn Page> {
        let secret = gtk::PasswordEntry::new();
        secret.set_show_peek_icon(false);
        secret.set_widget_name("sign-passphrase");
        crate::a11y::set_label(&secret, "口令");
        let repeat = gtk::PasswordEntry::new();
        repeat.set_show_peek_icon(false);
        repeat.set_widget_name("sign-passphrase-repeat");
        crate::a11y::set_label(&repeat, "再输一遍口令");
        let title_entry = gtk::Entry::new();
        title_entry.set_widget_name("clause-title");
        title_entry.set_max_length(40);
        crate::a11y::set_label(&title_entry, "短题");
        let text_view = gtk::TextView::new();
        text_view.set_widget_name("clause-text");
        text_view.set_wrap_mode(gtk::WrapMode::WordChar);
        text_view.set_top_margin(8);
        text_view.set_bottom_margin(8);
        text_view.set_accepts_tab(false);
        crate::a11y::set_label(&text_view, "短句");
        Rc::new_cyclic(|me| Self {
            ctx: ctx.clone(),
            frame: frame(PageKey::Baseline),
            data: RefCell::new(None),
            failure: RefCell::new(None),
            clauses: RefCell::new(Vec::new()),
            dirty: Cell::new(false),
            editing: RefCell::new(None),
            edit_failure: RefCell::new(None),
            sign_failure: RefCell::new(None),
            selected: RefCell::new(None),
            recent: RefCell::new(None),
            signing: Cell::new(false),
            secret,
            repeat,
            title_entry,
            text_view,
            me: me.clone(),
        })
    }

    fn status(&self) -> (Tone, String) {
        let data = self.data.borrow();
        match data.as_ref() {
            Some(d) if d.signed && !self.dirty.get() && d.signed_at_ms.is_some() => (
                Tone::Ice,
                format!(
                    "自 {} 起生效",
                    format_date(d.signed_at_ms.unwrap_or_default())
                ),
            ),
            Some(d) if d.signed && self.dirty.get() => (Tone::Amber, String::from("有改动待签署")),
            _ => (Tone::Amber, String::from("待签署")),
        }
    }

    fn start_editing(&self, at: Option<usize>) {
        let (title, body) = at
            .and_then(|i| self.clauses.borrow().get(i).cloned())
            .map(|c| (c.title, c.text))
            .unwrap_or_default();
        self.title_entry.set_text(&title);
        self.text_view.buffer().set_text(&body);
        *self.editing.borrow_mut() = Some(at);
        *self.edit_failure.borrow_mut() = None;
        self.render();
        self.title_entry.grab_focus();
    }

    fn finish_edit(&self) {
        let Some(at) = *self.editing.borrow() else {
            return;
        };
        let title = self.title_entry.text().trim().to_owned();
        let buffer = self.text_view.buffer();
        let body = buffer
            .text(&buffer.start_iter(), &buffer.end_iter(), false)
            .trim()
            .to_owned();
        if title.is_empty() || body.is_empty() {
            *self.edit_failure.borrow_mut() = Some(String::from("短题和短句都要写。"));
            self.render();
            return;
        }
        {
            let mut clauses = self.clauses.borrow_mut();
            match at {
                Some(index) if index < clauses.len() => {
                    clauses[index].title = title;
                    clauses[index].text = body;
                }
                _ => {
                    let key = format!("new-{}", clauses.len());
                    clauses.push(Clause {
                        key,
                        title,
                        text: body,
                    });
                }
            }
        }
        self.dirty.set(true);
        *self.editing.borrow_mut() = None;
        *self.edit_failure.borrow_mut() = None;
        self.ctx.say("已写进草稿，签署之后生效。");
        self.render();
    }

    fn remove(&self, index: usize) {
        let removed = {
            let mut clauses = self.clauses.borrow_mut();
            (index < clauses.len()).then(|| clauses.remove(index))
        };
        if let Some(removed) = removed {
            self.dirty.set(true);
            self.ctx.say(&format!(
                "已从草稿里移除「{}」，签署之后生效。",
                removed.title
            ));
        }
        *self.selected.borrow_mut() = None;
        self.render();
    }

    fn clause_row(&self, index: usize, clause: &Clause) -> gtk::Box {
        let current = self.selected.borrow().as_deref() == Some(clause.key.as_str());
        let row = hbox(16);
        row.add_css_class("qz-clause");
        row.set_widget_name(&format!("clause-{index}"));
        let number = line(&ordinal(index), &["qz-clause-no"]);
        number.set_valign(gtk::Align::Start);
        row.append(&number);
        let body = vbox(4);
        body.append(&heading(&clause.title, &["qz-clause-title"]));
        body.append(&text(&clause.text, &["qz-clause-text"]));
        let button = pick(&body, current, true);
        let weak = self.me.clone();
        let key = clause.key.clone();
        button.connect_clicked(move |_| {
            upgrade(&weak, |page| {
                {
                    let mut selected = page.selected.borrow_mut();
                    *selected = if selected.as_deref() == Some(key.as_str()) {
                        None
                    } else {
                        Some(key.clone())
                    };
                }
                page.render();
            });
        });
        row.append(&button);
        let tools = hbox(6);
        tools.set_valign(gtk::Align::Start);
        let edit = button_outline("改", true);
        edit.set_widget_name("clause-edit");
        crate::a11y::set_label(&edit, &format!("改「{}」", clause.title));
        let weak = self.me.clone();
        edit.connect_clicked(move |_| upgrade(&weak, |page| page.start_editing(Some(index))));
        tools.append(&self.ctx.guard(edit));
        let drop = button_text("移除");
        drop.set_widget_name("clause-remove");
        crate::a11y::set_label(&drop, &format!("移除「{}」", clause.title));
        let weak = self.me.clone();
        drop.connect_clicked(move |_| upgrade(&weak, |page| page.remove(index)));
        tools.append(&self.ctx.guard(drop));
        row.append(&tools);
        row
    }

    fn clause_form(&self, index: usize) -> gtk::Box {
        let row = hbox(16);
        row.add_css_class("qz-clause");
        row.set_widget_name("clause-form");
        let number = line(&ordinal(index), &["qz-clause-no"]);
        number.set_valign(gtk::Align::Start);
        row.append(&number);
        let form = vbox(12);
        form.set_hexpand(true);
        form.append(&field("短题", &input_shell(&self.title_entry, false), None));
        let scroller = gtk::ScrolledWindow::new();
        scroller.set_policy(gtk::PolicyType::Never, gtk::PolicyType::Automatic);
        scroller.set_min_content_height(84);
        scroller.set_child(Some(&self.text_view));
        let shell = hbox(0);
        shell.add_css_class("qz-input");
        scroller.set_hexpand(true);
        shell.append(&scroller);
        form.append(&field("短句", &shell, None));
        if let Some(failure) = self.edit_failure.borrow().as_ref() {
            form.append(&amber_hint(failure));
        }
        let row_actions = actions();
        let done = button_outline("写好了", true);
        done.set_widget_name("clause-done");
        let weak = self.me.clone();
        done.connect_clicked(move |_| upgrade(&weak, |page| page.finish_edit()));
        row_actions.append(&done);
        let cancel = button_text("取消");
        cancel.set_widget_name("clause-cancel");
        let weak = self.me.clone();
        cancel.connect_clicked(move |_| {
            upgrade(&weak, |page| {
                *page.editing.borrow_mut() = None;
                *page.edit_failure.borrow_mut() = None;
                page.render();
            });
        });
        row_actions.append(&cancel);
        form.append(&row_actions);
        row.append(&form);
        row
    }

    fn own_section(&self) -> gtk::Box {
        let content = vbox(14);
        let list = vbox(0);
        list.add_css_class("qz-clauses");
        list.set_widget_name("clauses");
        let editing = *self.editing.borrow();
        let clauses = self.clauses.borrow().clone();
        for (index, clause) in clauses.iter().enumerate() {
            if editing == Some(Some(index)) {
                list.append(&self.clause_form(index));
            } else {
                list.append(&self.clause_row(index, clause));
            }
        }
        if editing == Some(None) {
            list.append(&self.clause_form(clauses.len()));
        }
        content.append(&list);
        if editing.is_none() && clauses.len() < MAX_CLAUSES {
            let add = button_outline("添一条", true);
            add.set_widget_name("clause-add");
            add.set_halign(gtk::Align::Start);
            let weak = self.me.clone();
            add.connect_clicked(move |_| upgrade(&weak, |page| page.start_editing(None)));
            content.append(&self.ctx.guard(add));
        }
        let title = section(
            "你的底线",
            false,
            Some(&format!("{} 条", clauses.len())),
            &content,
        );
        title.set_margin_top(0);
        title
    }

    fn sign_bar(&self, data: &Baseline) -> gtk::Box {
        let first = data.signed_at_ms.is_none();
        let settled = data.signed && !self.dirty.get();
        let blocked =
            settled || self.editing.borrow().is_some() || self.clauses.borrow().is_empty();
        let bar = hbox(32);
        bar.add_css_class("qz-sign-bar");
        bar.set_widget_name("sign-bar");
        bar.set_margin_top(32);
        let left = vbox(10);
        left.set_hexpand(true);
        left.append(&heading(
            if settled {
                "已经签署"
            } else {
                "签署这份底线"
            },
            &["qz-cell-title"],
        ));
        left.append(&text(
            if settled {
                "上面的每一条都在生效。改动任何一条之后，需要重新签署。"
            } else {
                "签署之后，上面的每一条先于一切送进每一个宿主；之前签过的那一份随之作废。"
            },
            &["qz-section-note"],
        ));
        if !settled {
            let fields = vbox(12);
            fields.set_margin_top(8);
            fields.set_widget_name("sign-fields");
            fields.append(&field(
                if first { "设定口令" } else { "口令" },
                &input_shell(&self.secret, true),
                Some(if first {
                    "第一次签署时，这个口令即被设定。以后签署和吊销设备都要用它。"
                } else {
                    "第一次签署时设定的那个口令。"
                }),
            ));
            if first {
                fields.append(&field("再输一遍", &input_shell(&self.repeat, true), None));
            }
            left.append(&fields);
        }
        if let Some(failure) = self.sign_failure.borrow().as_ref()
            && self.editing.borrow().is_none()
        {
            left.append(&amber_hint(failure));
        }
        bar.append(&left);
        let sign = button_white(if self.signing.get() {
            "正在签署"
        } else {
            "签署"
        });
        sign.set_widget_name("sign-button");
        sign.set_valign(gtk::Align::End);
        sign.set_sensitive(!blocked && self.ctx.can_write() && !self.signing.get());
        let weak = self.me.clone();
        sign.connect_clicked(move |_| upgrade(&weak, |page| page.sign(first)));
        bar.append(&sign);
        bar
    }

    fn refuse(&self, message: &str, focus: &gtk::PasswordEntry) {
        *self.sign_failure.borrow_mut() = Some(message.to_owned());
        self.ctx.alert(message);
        self.render();
        focus.grab_focus();
    }

    fn sign(&self, first: bool) {
        if self.signing.get() || self.editing.borrow().is_some() {
            return;
        }
        let secret = self.secret.text().to_string();
        if secret.is_empty() {
            self.refuse("先输入口令。", &self.secret);
            return;
        }
        if first && self.repeat.text().as_str() != secret {
            self.refuse("两遍口令不一样。", &self.repeat);
            return;
        }
        self.signing.set(true);
        *self.sign_failure.borrow_mut() = None;
        self.render();
        let clauses = self.clauses.borrow().clone();
        let drafts: Vec<DirectiveDraft> = clauses
            .iter()
            .map(|c| DirectiveDraft {
                title: c.title.clone(),
                text: c.text.clone(),
            })
            .collect();
        let weak = self.me.clone();
        let ctx = self.ctx.clone();
        self.ctx.api.baseline_sign(drafts, secret, move |result| {
            ctx.note(&result);
            upgrade(&weak, |page| {
                page.signing.set(false);
                match result {
                    Ok(signed) => {
                        {
                            let mut data = page.data.borrow_mut();
                            if let Some(data) = data.as_mut() {
                                data.signed = true;
                                data.signed_at_ms = Some(signed.signed_at_ms);
                            }
                        }
                        page.dirty.set(false);
                        page.secret.set_text("");
                        page.repeat.set_text("");
                        *page.recent.borrow_mut() = Some(String::from("刚刚由你签署"));
                        page.ctx
                            .say(&format!("已签署，{} 条底线自现在起生效。", clauses.len()));
                        page.ctx.overview_changed();
                        page.load();
                    }
                    Err(error) => {
                        let message = if error.code() == Some("PASSPHRASE_MISMATCH") {
                            String::from("没有签成：口令不对。")
                        } else {
                            format!("没有签成：{}", error.describe())
                        };
                        page.ctx.alert(&message);
                        *page.sign_failure.borrow_mut() = Some(message);
                    }
                }
                page.render();
            });
        });
    }

    fn deployment_section(&self, data: &Baseline) -> gtk::Box {
        let content: gtk::Widget = if data.deployment.is_empty() {
            compact_empty(
                "deployment-empty",
                "没有",
                "这份部署没有附加约束",
                "部署约束由安装和运营这套系统的一方定下。这里没有，他只受你的底线限制。",
            )
            .upcast()
        } else {
            let list = vbox(0);
            list.add_css_class("qz-clauses");
            list.set_widget_name("deployment");
            for (index, item) in data.deployment.iter().enumerate() {
                let row = hbox(16);
                row.add_css_class("qz-clause");
                let number = line(&ordinal(index), &["qz-clause-no"]);
                number.set_valign(gtk::Align::Start);
                row.append(&number);
                let body = vbox(4);
                body.append(&heading(&item.title, &["qz-clause-title"]));
                body.append(&text(&item.text, &["qz-clause-text"]));
                row.append(&body);
                list.append(&row);
            }
            list.upcast()
        };
        section(
            "部署约束",
            true,
            Some("由部署这套系统的一方定下。只读，不在这里签。"),
            &content,
        )
    }

    fn draw(&self, data: &Baseline) {
        let body = &self.frame.body;
        crate::ui::clear(body);
        let (tone, word) = self.status();
        self.frame.head.set_state(Some((tone, word)));
        if self.clauses.borrow().is_empty() && self.editing.borrow().is_none() {
            let block_body = &self.frame.body;
            empty_page(
                block_body,
                &self.ctx,
                &Situation {
                    kind: "baseline-empty",
                    tone: Tone::Amber,
                    word: "待签署",
                    title: "你还没有写下底线",
                    body: "底线是无论如何不许变的几件事。它不由他推断，也不随相处改变，只由你亲手写下并签署。没有底线时，他只受部署约束的限制。",
                    steps: &[
                        Step {
                            title: "写下",
                            text: "每条一个短题和一句话。少而硬，三五条就够。",
                        },
                        Step {
                            title: "签署",
                            text: "输入口令并签署。第一次签署时，这个口令即被设定。",
                        },
                        Step {
                            title: "生效",
                            text: "签署之后，它们先于一切送进每一个宿主。",
                        },
                    ],
                    command: None,
                    facts: Vec::new(),
                    compact: false,
                },
                None,
            );
            let add = button_outline("写第一条", false);
            add.set_widget_name("clause-add");
            add.set_halign(gtk::Align::Start);
            add.set_margin_top(4);
            let weak = self.me.clone();
            add.connect_clicked(move |_| upgrade(&weak, |page| page.start_editing(None)));
            body.append(&self.ctx.guard(add));
            body.append(&self.deployment_section(data));
            return;
        }
        body.append(&self.own_section());
        body.append(&self.sign_bar(data));
        body.append(&self.deployment_section(data));
    }

    fn provenance(&self) -> Provenance {
        let data = self.data.borrow();
        let Some(data) = data.as_ref() else {
            return Provenance::sentence(PageKey::Baseline.info().sentence);
        };
        let (_, status_word) = self.status();
        let signed_fact = Fact::new(
            "签署",
            data.signed_at_ms.map_or_else(
                || String::from("还没有签过"),
                |at| format!("{}，由你", format_date(at)),
            ),
        );
        let recent = self.recent.borrow().clone();
        let selected = self.selected.borrow().clone();
        let clause =
            selected.and_then(|key| self.clauses.borrow().iter().find(|c| c.key == key).cloned());
        let Some(clause) = clause else {
            let mut content = Provenance::sentence(PageKey::Baseline.info().sentence);
            content.facts = vec![
                Fact::new("状态", status_word),
                signed_fact,
                Fact::new(
                    "条数",
                    format!(
                        "{} 条你的底线，{} 条部署约束",
                        self.clauses.borrow().len(),
                        data.deployment.len()
                    ),
                ),
            ];
            content.recent = recent;
            return content;
        };
        let unchanged = data
            .directives
            .iter()
            .any(|d| d.title == clause.title && d.text == clause.text);
        Provenance {
            title: Some(clause.title),
            lead: if data.signed && unchanged {
                String::from("这一条由你写下，并且已经签署生效。")
            } else {
                String::from("这一条由你写下，还在草稿里。签署之后才生效。")
            },
            facts: vec![
                Fact::new(
                    "状态",
                    if unchanged {
                        status_word
                    } else {
                        String::from("待签署")
                    },
                ),
                signed_fact,
            ],
            recent,
            ..Provenance::default()
        }
    }
}

impl Page for BaselinePage {
    fn key(&self) -> PageKey {
        PageKey::Baseline
    }

    fn root(&self) -> gtk::Widget {
        self.frame.root.clone().upcast()
    }

    fn load(&self) {
        let weak = self.me.clone();
        let ctx = self.ctx.clone();
        self.ctx.api.baseline(move |result| {
            ctx.note(&result);
            upgrade(&weak, |page| match result {
                Ok(data) => {
                    *page.failure.borrow_mut() = None;
                    if page.data.borrow().as_ref() != Some(&data) {
                        // 还有没签的改动时，重新读取不覆盖手上的草稿。
                        if !page.dirty.get() && page.editing.borrow().is_none() {
                            *page.clauses.borrow_mut() = to_clauses(&data);
                        }
                        *page.data.borrow_mut() = Some(data);
                        page.render();
                    }
                }
                Err(error) => {
                    if page.data.borrow().is_none() {
                        *page.failure.borrow_mut() = Some(error);
                        page.render();
                    }
                }
            });
        });
    }

    fn render(&self) {
        let data = self.data.borrow().clone();
        if let Some(data) = data {
            self.draw(&data);
        } else if let Some(error) = self.failure.borrow().clone() {
            let weak = self.me.clone();
            unavailable(
                &self.frame.body,
                &error,
                Rc::new(move || upgrade(&weak, |page| page.load())),
            );
        }
        self.show_provenance();
    }

    fn show_provenance(&self) {
        self.ctx
            .provenance_for(PageKey::Baseline, self.provenance());
    }
}
