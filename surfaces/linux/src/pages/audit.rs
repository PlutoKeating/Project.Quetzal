#![forbid(unsafe_code)]

//! 记录：时间线，按天分组，每条一行等宽的时间、动作与对象；选中后出处栏显示完整内容。

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::rc::{Rc, Weak};

use gtk::prelude::*;
use gtk4 as gtk;
use quetzalcoatl_daemon::sea_governance::{AuditItem, AuditPage as AuditPayload, MemoryDetail};

use crate::api::ApiError;
use crate::aside::Provenance;
use crate::ctx::{Ctx, Page, upgrade};
use crate::routes::PageKey;
use crate::timefmt::{format_clock, format_date, format_date_time, format_day_heading};
use crate::ui::{
    Fact, Situation, Step, TickTone, Tone, button_outline, hbox, line, pick, text, timeline_item,
    vbox,
};

use super::entry::actor_label;
use super::{Frame, empty_page, frame, unavailable};

const PAGE_SIZE: usize = 50;

/// 写入的种类怎么读出来；不认识的种类原样显示。
#[must_use]
pub fn kind_label(kind: &str) -> &str {
    match kind {
        "entry_created" => "记下",
        "entry_update" => "改",
        "entry_mute" => "不主动提",
        "entry_unmute" => "恢复主动提",
        "entry_erase" => "抹除",
        "entry_expired" => "过期",
        "core_change" => "核心变化",
        "baseline_sign" => "签署底线",
        "focus_set" => "调节",
        "device_added" => "加入设备",
        "device_revoke" => "吊销设备",
        "import" => "导入",
        other => other,
    }
}

#[derive(Clone)]
enum EntryState {
    Loading,
    Gone,
    Loaded(Box<MemoryDetail>),
}

pub struct AuditPage {
    ctx: Rc<Ctx>,
    frame: Frame,
    items: RefCell<Vec<AuditItem>>,
    next_cursor: RefCell<Option<String>>,
    loaded: Cell<bool>,
    failure: RefCell<Option<ApiError>>,
    selected: Cell<Option<u64>>,
    loading_more: Cell<bool>,
    more_failure: RefCell<Option<String>>,
    entries: RefCell<HashMap<String, EntryState>>,
    me: Weak<AuditPage>,
}

impl AuditPage {
    pub fn build(ctx: &Rc<Ctx>) -> Rc<dyn Page> {
        Rc::new_cyclic(|me| Self {
            ctx: ctx.clone(),
            frame: frame(PageKey::Audit),
            items: RefCell::new(Vec::new()),
            next_cursor: RefCell::new(None),
            loaded: Cell::new(false),
            failure: RefCell::new(None),
            selected: Cell::new(None),
            loading_more: Cell::new(false),
            more_failure: RefCell::new(None),
            entries: RefCell::new(HashMap::new()),
            me: me.clone(),
        })
    }

    fn select(&self, item: &AuditItem) {
        self.selected.set(if self.selected.get() == Some(item.seq) {
            None
        } else {
            Some(item.seq)
        });
        if self.selected.get().is_some()
            && let Some(entry_id) = &item.entry_id
        {
            self.load_entry(entry_id);
        }
        self.render();
    }

    /// 记录只带一句摘要；它写的那一条的完整内容另外读。
    fn load_entry(&self, entry_id: &str) {
        if self.entries.borrow().contains_key(entry_id) {
            return;
        }
        self.entries
            .borrow_mut()
            .insert(entry_id.to_owned(), EntryState::Loading);
        let weak = self.me.clone();
        let ctx = self.ctx.clone();
        let key = entry_id.to_owned();
        self.ctx.api.memory(entry_id.to_owned(), move |result| {
            ctx.note(&result);
            upgrade(&weak, |page| {
                match result {
                    Ok(detail) => {
                        page.entries
                            .borrow_mut()
                            .insert(key, EntryState::Loaded(Box::new(detail)));
                    }
                    Err(ApiError::Unreachable(_)) => {
                        page.entries.borrow_mut().remove(&key);
                    }
                    Err(_) => {
                        page.entries.borrow_mut().insert(key, EntryState::Gone);
                    }
                }
                page.show_provenance();
            });
        });
    }

    fn load_more(&self) {
        let Some(cursor) = self.next_cursor.borrow().clone() else {
            return;
        };
        if self.loading_more.get() {
            return;
        }
        self.loading_more.set(true);
        self.render();
        let weak = self.me.clone();
        let ctx = self.ctx.clone();
        self.ctx.api.audit(Some(cursor), PAGE_SIZE, move |result| {
            ctx.note(&result);
            upgrade(&weak, |page| {
                page.loading_more.set(false);
                match result {
                    Ok(more) => {
                        let known: Vec<u64> = page.items.borrow().iter().map(|i| i.seq).collect();
                        let fresh: Vec<AuditItem> = more
                            .items
                            .into_iter()
                            .filter(|i| !known.contains(&i.seq))
                            .collect();
                        page.ctx
                            .say(&format!("又读出 {} 条更早的记录。", fresh.len()));
                        page.items.borrow_mut().extend(fresh);
                        *page.next_cursor.borrow_mut() = more.next_cursor;
                        *page.more_failure.borrow_mut() = None;
                    }
                    Err(error) => {
                        *page.more_failure.borrow_mut() = (!error.is_unreachable())
                            .then(|| format!("没有读出来：{}", error.describe()));
                    }
                }
                page.render();
            });
        });
    }

    fn entry_row(&self, item: &AuditItem) -> gtk::Overlay {
        let current = self.selected.get() == Some(item.seq);
        let row = hbox(14);
        row.set_widget_name(&format!("audit-{}", item.seq));
        let time = line(&format_clock(item.at_ms), &["qz-timeline-time"]);
        time.set_width_chars(5);
        time.set_valign(gtk::Align::Start);
        row.append(&time);
        let kind = line(kind_label(&item.kind), &["qz-ledger-kind"]);
        kind.set_width_chars(8);
        kind.set_valign(gtk::Align::Start);
        row.append(&kind);
        let summary = text(&item.summary, &["qz-timeline-text"]);
        let button = pick(&summary, current, false);
        let weak = self.me.clone();
        let target = item.clone();
        button.connect_clicked(move |_| upgrade(&weak, |page| page.select(&target)));
        row.append(&button);
        let actor = line(actor_label(&item.actor), &["qz-meta"]);
        actor.set_valign(gtk::Align::Start);
        row.append(&actor);
        let tone = if current {
            TickTone::Current
        } else if item.actor == "owner" {
            TickTone::Amber
        } else {
            TickTone::Neutral
        };
        timeline_item(None, &row, tone, false)
    }

    fn draw(&self) {
        let body = &self.frame.body;
        crate::ui::clear(body);
        let items = self.items.borrow().clone();
        if items.is_empty() {
            empty_page(
                body,
                &self.ctx,
                &Situation {
                    kind: "audit-empty",
                    tone: Tone::Quiet,
                    word: "还没有",
                    title: "还没有任何写入",
                    body: "他记下一件事、你改了一条、底线被签署、设备被吊销——每一次写入都会在这里留下一行：谁，在什么时候，写了什么。",
                    steps: &[
                        Step {
                            title: "他写下的",
                            text: "从相处里沉淀的往事，经过独立审查才写入。",
                        },
                        Step {
                            title: "你写下的",
                            text: "你在这里改的、抹的、签的每一步。",
                        },
                        Step {
                            title: "系统写下的",
                            text: "导入、过期、设备的加入与吊销。",
                        },
                    ],
                    command: None,
                    facts: Vec::new(),
                    compact: false,
                },
                Some(("看他记得的往事", PageKey::Memories)),
            );
            return;
        }
        let now = self.ctx.now();
        let timeline = vbox(0);
        timeline.set_widget_name("audit-timeline");
        let mut day = String::new();
        for item in &items {
            let key = format_date(item.at_ms);
            if key != day {
                let heading = line(&format_day_heading(item.at_ms, now), &["qz-timeline-day"]);
                heading.set_widget_name(&format!("day-{key}"));
                timeline.append(&heading);
                day = key;
            }
            timeline.append(&self.entry_row(item));
        }
        body.append(&timeline);
        let foot = hbox(12);
        foot.set_margin_top(12);
        let shown = line(&format!("已显示 {} 条", items.len()), &["qz-meta"]);
        shown.set_widget_name("audit-shown");
        shown.set_hexpand(true);
        foot.append(&shown);
        if self.next_cursor.borrow().is_none() {
            foot.append(&line("这是最早的一条", &["qz-meta"]));
        } else {
            let more = button_outline(
                if self.loading_more.get() {
                    "正在读取"
                } else {
                    "更早的记录"
                },
                true,
            );
            more.set_widget_name("audit-more");
            more.set_sensitive(!self.loading_more.get());
            let weak = self.me.clone();
            more.connect_clicked(move |_| upgrade(&weak, |page| page.load_more()));
            foot.append(&more);
        }
        body.append(&foot);
        if let Some(failure) = self.more_failure.borrow().as_ref() {
            body.append(&crate::ui::amber_hint(failure));
        }
    }

    fn provenance(&self) -> Provenance {
        let seq = self.selected.get();
        let items = self.items.borrow();
        let Some(item) = seq.and_then(|seq| items.iter().find(|i| i.seq == seq)) else {
            return Provenance::sentence(PageKey::Audit.info().sentence);
        };
        let entry = item
            .entry_id
            .as_ref()
            .and_then(|id| self.entries.borrow().get(id).cloned());
        let mut lead = String::from("这一次写入没有落在某一条往事上。");
        let mut list = None;
        let mut link: Option<(String, Rc<dyn Fn()>)> = None;
        if let Some(entry_id) = &item.entry_id {
            match &entry {
                None | Some(EntryState::Loading) => {
                    lead = String::from("这一次写入落在一条往事上。");
                }
                Some(EntryState::Gone) => {
                    lead = String::from("这一次写入落在一条往事上，那一条现在已经不在了。");
                }
                Some(EntryState::Loaded(detail)) => {
                    lead = String::from("这一次写入落在下面这条往事上。");
                    list = Some((String::from("它现在的内容"), vec![detail.item.text.clone()]));
                    let ctx = self.ctx.clone();
                    let id = entry_id.clone();
                    link = Some((
                        String::from("在往事里看它"),
                        Rc::new(move || ctx.goto(PageKey::Memories, Some(id.clone()))),
                    ));
                }
            }
        }
        Provenance {
            title: Some(item.summary.clone()),
            lead,
            facts: vec![
                Fact::new("时间", format_date_time(item.at_ms)),
                Fact::new("动作", kind_label(&item.kind)),
                Fact::new("由", actor_label(&item.actor)),
                Fact::mono("序号", item.seq.to_string()),
            ],
            list,
            link,
            pending: matches!(entry, Some(EntryState::Loading)),
            ..Provenance::default()
        }
    }
}

impl Page for AuditPage {
    fn key(&self) -> PageKey {
        PageKey::Audit
    }

    fn root(&self) -> gtk::Widget {
        self.frame.root.clone().upcast()
    }

    fn load(&self) {
        // 已经翻过页的记录不被轮询打回第一页。
        if self.items.borrow().len() > PAGE_SIZE || self.loading_more.get() {
            return;
        }
        let weak = self.me.clone();
        let ctx = self.ctx.clone();
        self.ctx.api.audit(
            None,
            PAGE_SIZE,
            move |result: Result<AuditPayload, ApiError>| {
                ctx.note(&result);
                upgrade(&weak, |page| match result {
                    Ok(first) => {
                        *page.failure.borrow_mut() = None;
                        let was_loaded = page.loaded.replace(true);
                        if was_loaded && *page.items.borrow() == first.items {
                            return;
                        }
                        *page.items.borrow_mut() = first.items;
                        *page.next_cursor.borrow_mut() = first.next_cursor;
                        page.render();
                    }
                    Err(error) => {
                        if !page.loaded.get() {
                            *page.failure.borrow_mut() = Some(error);
                            page.render();
                        }
                    }
                });
            },
        );
    }

    fn render(&self) {
        if self.loaded.get() {
            self.draw();
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
        self.ctx.provenance_for(PageKey::Audit, self.provenance());
    }
}
