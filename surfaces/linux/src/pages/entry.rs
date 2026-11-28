#![forbid(unsafe_code)]

//! 条目（偏好、事实、往事）共用的部分：来历怎么写，三个固定动作——改、不主动提、抹除——怎么做。

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use gtk::prelude::*;
use gtk4 as gtk;
use quetzalcoatl_daemon::sea_governance::{MemoryDetail, MemoryItem};

use crate::api::ApiError;
use crate::aside::{Event, Provenance};
use crate::ctx::Ctx;
use crate::dialog::{ConfirmSpec, Finish, confirm};
use crate::timefmt::format_date;
use crate::ui::{
    Fact, Tone, actions, amber_hint, button_outline, button_text, field, hbox, state_word, vbox,
};

/// 「你说的」：这一条由本人亲手写过或改过。
#[must_use]
pub fn owner_mark() -> gtk::Box {
    let mark = state_word(Tone::Amber, "你说的");
    mark.set_widget_name("mark-owner");
    mark
}

/// 「不主动提」：他记得，但不会主动提起。
#[must_use]
pub fn muted_mark() -> gtk::Box {
    let mark = state_word(Tone::Quiet, "不主动提");
    mark.set_widget_name("mark-muted");
    mark
}

fn source_kind(kind: &str) -> &str {
    match kind {
        "host" => "宿主里的相处",
        "import" => "导入",
        "sayit" => "SayIt",
        "explore" => "他自己的探索",
        "owner" => "你亲手写下",
        other => other,
    }
}

fn history_action(action: &str) -> &str {
    match action {
        "created" => "记下",
        "corrected" => "纠正",
        "muted" => "设为不主动提",
        "unmuted" => "恢复主动提",
        "expired" => "过期",
        other => other,
    }
}

/// 记录、来历里的执行者。
#[must_use]
pub fn actor_label(actor: &str) -> &str {
    match actor {
        "owner" => "你",
        "arbiter" => "仲裁",
        "import" => "导入",
        "system" => "系统",
        other => other,
    }
}

/// 来历的一句话：来自哪里。
#[must_use]
pub fn source_label(item: &MemoryItem) -> String {
    format!("{} · {}", item.source.label, source_kind(&item.source.kind))
}

/// 生效时间的一句话。
#[must_use]
pub fn validity_text(item: &MemoryItem, now: u64) -> String {
    let since = format!("自 {} 起", format_date(item.since_ms));
    match item.valid_until_ms {
        None => format!("{since}，一直有效"),
        Some(until) if until <= now => {
            format!("{since}，已在 {} 过期", format_date(until))
        }
        Some(until) => format!("{since}，到 {} 为止", format_date(until)),
    }
}

/// 这一条是不是已过期。
#[must_use]
pub fn is_expired(item: &MemoryItem, now: u64) -> bool {
    item.valid_until_ms.is_some_and(|until| until <= now)
}

/// 一条来历读取的状态。
#[derive(Clone, Debug)]
pub enum DetailState {
    Loading,
    Missing,
    Loaded(Box<MemoryDetail>),
}

/// 一页里已经读过的单条来历，免得选中同一条时反复读。
#[derive(Default)]
pub struct DetailCache {
    entries: RefCell<HashMap<String, DetailState>>,
}

impl DetailCache {
    #[must_use]
    pub fn get(&self, id: &str) -> Option<DetailState> {
        self.entries.borrow().get(id).cloned()
    }

    pub fn forget(&self, id: &str) {
        self.entries.borrow_mut().remove(id);
    }

    /// 没读过就读；读完（或读不出来）调用 `ready`。
    pub fn load(&self, ctx: &Rc<Ctx>, cache: &Rc<Self>, id: &str, ready: impl Fn() + 'static) {
        if self.entries.borrow().contains_key(id) {
            return;
        }
        self.entries
            .borrow_mut()
            .insert(id.to_owned(), DetailState::Loading);
        let cache = cache.clone();
        let note_ctx = ctx.clone();
        let key = id.to_owned();
        ctx.api.memory(id.to_owned(), move |result| {
            note_ctx.note(&result);
            match result {
                Ok(detail) => {
                    cache
                        .entries
                        .borrow_mut()
                        .insert(key, DetailState::Loaded(Box::new(detail)));
                }
                Err(ApiError::Unreachable(_)) => {
                    cache.entries.borrow_mut().remove(&key);
                }
                Err(_) => {
                    cache.entries.borrow_mut().insert(key, DetailState::Missing);
                }
            }
            ready();
        });
    }
}

/// 一条偏好、事实或往事的出处：它从哪次相处来，有没有被纠正过。
pub struct EntryProvenance<'a> {
    pub text: &'a str,
    pub since_ms: u64,
    pub by_owner: bool,
    pub item: Option<&'a MemoryItem>,
    pub detail: Option<&'a DetailState>,
    pub recent: Option<String>,
    pub now: u64,
}

impl EntryProvenance<'_> {
    #[must_use]
    pub fn build(&self) -> Provenance {
        let detail = match self.detail {
            Some(DetailState::Loaded(detail)) => Some(detail.as_ref()),
            _ => None,
        };
        let known: Option<&MemoryItem> = detail.map(|d| &d.item).or(self.item);
        let mut facts = Vec::new();
        if let Some(known) = known {
            facts.push(Fact::new("来自", source_label(known)));
            facts.push(Fact::new("生效", validity_text(known, self.now)));
            facts.push(Fact::mono("层", known.layer.clone()));
            if known.untrusted {
                facts.push(Fact::new("核实", "来自外部，没有经过核实"));
            }
        } else {
            facts.push(Fact::new(
                "记下",
                format!("自 {} 起", format_date(self.since_ms)),
            ));
        }
        let mut events = Vec::new();
        if let Some(detail) = detail {
            let corrections = detail
                .history
                .iter()
                .filter(|entry| entry.action == "corrected")
                .count();
            facts.push(Fact::new(
                "纠正",
                if corrections == 0 {
                    String::from("没有被纠正过")
                } else {
                    format!("被纠正过 {corrections} 次")
                },
            ));
            if let Some(previous) = &detail.supersedes {
                facts.push(Fact::mono("取代", previous.clone()));
            }
            events = detail
                .history
                .iter()
                .map(|entry| Event {
                    at_ms: Some(entry.at_ms),
                    text: format!(
                        "{} · {}",
                        history_action(&entry.action),
                        actor_label(&entry.by)
                    ),
                    amber: entry.by == "owner",
                })
                .collect();
        }
        let lead = if matches!(self.detail, Some(DetailState::Missing)) {
            "这一条更早的来历读不出来，下面是已经知道的部分。"
        } else if self.by_owner {
            "这一条由你亲手写过或改过。"
        } else {
            "这一条是他从相处里记下的，你没有改过它。"
        };
        Provenance {
            title: Some(self.text.to_owned()),
            lead: lead.to_owned(),
            facts,
            events: Some((String::from("经过"), events)),
            pending: matches!(self.detail, Some(DetailState::Loading)),
            recent: self.recent.clone(),
            ..Provenance::default()
        }
    }
}

/// 一次动作做成了什么。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Outcome {
    /// 改好了：守护进程让新的一条接替旧的，所以带回新的编号。
    Updated {
        id: String,
        text: String,
    },
    /// 设为或恢复「不主动提」。
    Muted {
        id: String,
        muted: bool,
    },
    Erased,
}

struct ActionsState {
    editing: bool,
    busy: bool,
    failure: Option<String>,
    draft: String,
}

struct Actions {
    ctx: Rc<Ctx>,
    id: String,
    text: String,
    muted: bool,
    on_outcome: Rc<dyn Fn(Outcome)>,
    root: gtk::glib::WeakRef<gtk::Box>,
    state: RefCell<ActionsState>,
    me: std::rc::Weak<Actions>,
}

/// 条目上固定的三个动作：改、不主动提、抹除。
/// 「改」就地换成一个文本框；「抹除」要再确认一次，并说明不可恢复。
pub fn entry_actions(
    ctx: &Rc<Ctx>,
    id: &str,
    text: &str,
    muted: bool,
    on_outcome: Rc<dyn Fn(Outcome)>,
) -> gtk::Box {
    let root = vbox(10);
    root.set_widget_name("entry-actions");
    let actions = Rc::new_cyclic(|me| Actions {
        ctx: ctx.clone(),
        id: id.to_owned(),
        text: text.to_owned(),
        muted,
        on_outcome,
        root: root.downgrade(),
        state: RefCell::new(ActionsState {
            editing: false,
            busy: false,
            failure: None,
            draft: text.to_owned(),
        }),
        me: me.clone(),
    });
    actions.draw();
    // 动作块要活到它所在的控件被拆掉为止。
    let keep = actions.clone();
    root.connect_destroy(move |_| {
        let _ = &keep;
    });
    root
}

impl Actions {
    fn draw(&self) {
        let Some(root) = self.root.upgrade() else {
            return;
        };
        crate::ui::clear(&root);
        let (editing, failure) = {
            let state = self.state.borrow();
            (state.editing, state.failure.clone())
        };
        if editing {
            self.draw_editor(&root, failure.as_deref());
        } else {
            self.draw_buttons(&root, failure.as_deref());
        }
    }

    fn weak(&self) -> std::rc::Weak<Actions> {
        self.me.clone()
    }

    fn draw_buttons(&self, root: &gtk::Box, failure: Option<&str>) {
        let row = actions();
        let edit = button_outline("改", true);
        edit.set_widget_name("action-edit");
        {
            let weak = self.weak();
            edit.connect_clicked(move |_| {
                crate::ctx::upgrade(&weak, |a| {
                    {
                        let mut state = a.state.borrow_mut();
                        state.editing = true;
                        state.failure = None;
                        state.draft = a.text.clone();
                    }
                    a.draw();
                });
            });
        }
        row.append(&self.ctx.guard(edit));

        let mute = button_outline("不主动提", true);
        mute.set_widget_name("action-mute");
        if self.muted {
            mute.add_css_class("is-pressed");
        }
        mute.update_state(&[gtk::accessible::State::Pressed(if self.muted {
            gtk::AccessibleTristate::True
        } else {
            gtk::AccessibleTristate::False
        })]);
        {
            let weak = self.weak();
            mute.connect_clicked(move |_| {
                crate::ctx::upgrade(&weak, |a| a.mute());
            });
        }
        row.append(&self.ctx.guard(mute));

        let erase = button_outline("抹除", true);
        erase.set_widget_name("action-erase");
        {
            let weak = self.weak();
            erase.connect_clicked(move |_| {
                crate::ctx::upgrade(&weak, |a| a.erase());
            });
        }
        row.append(&self.ctx.guard(erase));
        root.append(&row);
        if let Some(failure) = failure {
            root.append(&amber_hint(failure));
        }
    }

    fn mute(&self) {
        if self.state.borrow().busy {
            return;
        }
        self.state.borrow_mut().busy = true;
        let weak = self.weak();
        let next = !self.muted;
        self.ctx
            .api
            .entry_mute(self.id.clone(), next, move |result| {
                crate::ctx::upgrade(&weak, |a| {
                    a.state.borrow_mut().busy = false;
                    a.ctx.note(&result);
                    match result {
                        Ok(write) => {
                            a.ctx.say(if next {
                                "已设为不主动提。"
                            } else {
                                "已恢复主动提。"
                            });
                            (a.on_outcome)(Outcome::Muted {
                                id: write.id,
                                muted: next,
                            });
                        }
                        Err(error) => a.fail("没有改成", &error),
                    }
                });
            });
    }

    fn fail(&self, prefix: &str, error: &ApiError) {
        let message = format!("{prefix}：{}", error.describe());
        self.ctx.alert(&message);
        self.state.borrow_mut().failure = Some(message);
        self.draw();
    }

    fn erase(&self) {
        let weak = self.weak();
        let id = self.id.clone();
        let ctx = self.ctx.clone();
        confirm(
            self.ctx.anchor(),
            ConfirmSpec {
                title: String::from("抹除这一条？"),
                word: String::from("不可恢复"),
                quote: Some(self.text.clone()),
                paragraphs: vec![
                    String::from("它会从所有设备上消失，而且不可恢复。"),
                    String::from("如果只是不想让他主动提起，用「不主动提」就够了。"),
                ],
                confirm_label: String::from("抹除"),
                passphrase: None,
            },
            Rc::new(move |_secret, finish: Finish| {
                let weak = weak.clone();
                let ctx = ctx.clone();
                let done_ctx = ctx.clone();
                ctx.api.entry_erase(id.clone(), move |result| {
                    done_ctx.note(&result);
                    match result {
                        Ok(_) => {
                            finish(Ok(()));
                            done_ctx.say("已抹除这一条。");
                            crate::ctx::upgrade(&weak, |a| (a.on_outcome)(Outcome::Erased));
                        }
                        Err(error) => finish(Err(format!("没有抹除：{}", error.describe()))),
                    }
                });
            }),
        );
    }

    fn draw_editor(&self, root: &gtk::Box, failure: Option<&str>) {
        let view = gtk::TextView::new();
        view.set_wrap_mode(gtk::WrapMode::WordChar);
        view.set_widget_name("entry-edit-text");
        view.set_accepts_tab(false);
        view.set_top_margin(8);
        view.set_bottom_margin(8);
        view.set_left_margin(2);
        view.set_right_margin(2);
        view.set_hexpand(true);
        view.buffer().set_text(&self.state.borrow().draft);
        crate::a11y::set_label(&view, "改成");
        {
            let weak = self.weak();
            view.buffer().connect_changed(move |buffer| {
                crate::ctx::upgrade(&weak, |a| {
                    a.state.borrow_mut().draft = buffer
                        .text(&buffer.start_iter(), &buffer.end_iter(), false)
                        .to_string();
                });
            });
        }
        let scroller = gtk::ScrolledWindow::new();
        scroller.set_policy(gtk::PolicyType::Never, gtk::PolicyType::Automatic);
        scroller.set_min_content_height(96);
        scroller.set_child(Some(&view));
        let shell = hbox(0);
        shell.add_css_class("qz-input");
        shell.append(&scroller);
        scroller.set_hexpand(true);
        root.append(&field("改成", &shell, None));
        if let Some(failure) = failure {
            root.append(&amber_hint(failure));
        }
        let row = actions();
        let save = button_outline("保存", true);
        save.set_widget_name("action-save");
        {
            let weak = self.weak();
            save.connect_clicked(move |_| crate::ctx::upgrade(&weak, |a| a.save()));
        }
        row.append(&self.ctx.guard(save));
        let cancel = button_text("取消");
        cancel.set_widget_name("action-cancel");
        {
            let weak = self.weak();
            cancel.connect_clicked(move |_| {
                crate::ctx::upgrade(&weak, |a| {
                    {
                        let mut state = a.state.borrow_mut();
                        state.editing = false;
                        state.failure = None;
                    }
                    a.draw();
                });
            });
        }
        row.append(&cancel);
        root.append(&row);
        view.grab_focus();
    }

    fn save(&self) {
        let next = self.state.borrow().draft.trim().to_owned();
        if next.is_empty() {
            self.state.borrow_mut().failure = Some(String::from("改成什么？这一条不能是空的。"));
            self.draw();
            return;
        }
        if next == self.text {
            self.state.borrow_mut().editing = false;
            self.draw();
            return;
        }
        if self.state.borrow().busy {
            return;
        }
        self.state.borrow_mut().busy = true;
        let weak = self.weak();
        let sent = next.clone();
        self.ctx
            .api
            .entry_update(self.id.clone(), next, move |result| {
                crate::ctx::upgrade(&weak, |a| {
                    a.state.borrow_mut().busy = false;
                    a.ctx.note(&result);
                    match result {
                        Ok(write) => {
                            a.ctx.say("已改好这一条。");
                            a.state.borrow_mut().editing = false;
                            (a.on_outcome)(Outcome::Updated {
                                id: write.id,
                                text: sent,
                            });
                        }
                        Err(error) => a.fail("没有改成", &error),
                    }
                });
            });
    }
}
