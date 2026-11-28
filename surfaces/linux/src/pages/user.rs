#![forbid(unsafe_code)]

//! 我：两栏对照——左是偏好（他据此调整做法），右是事实（他据此理解我）。
//! 选中一条，出处栏显示它从哪次相处来、有没有被纠正过；选中的那一行下面是改、不主动提、抹除。

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::{Rc, Weak};

use gtk::prelude::*;
use gtk4 as gtk;
use quetzalcoatl_daemon::sea_governance::{MemoryItem, SeaUser};

use crate::api::ApiError;
use crate::aside::Provenance;
use crate::ctx::{Ctx, Page, upgrade};
use crate::routes::PageKey;
use crate::timefmt::format_date;
use crate::ui::{Situation, Step, Tone, hbox, heading, line, pick, text, vbox, vline};

use super::entry::{DetailCache, EntryProvenance, Outcome, entry_actions, muted_mark, owner_mark};
use super::{Frame, compact_empty, empty_page, frame, unavailable};

#[derive(Clone, Debug, PartialEq)]
struct Entry {
    id: String,
    text: String,
    since_ms: u64,
    by_owner: bool,
    muted: bool,
    item: Option<MemoryItem>,
}

pub struct UserPage {
    ctx: Rc<Ctx>,
    frame: Frame,
    data: RefCell<Option<SeaUser>>,
    failure: RefCell<Option<ApiError>>,
    selected: RefCell<Option<String>>,
    notice: RefCell<Option<String>>,
    recent: RefCell<HashMap<String, String>>,
    details: Rc<DetailCache>,
    me: Weak<UserPage>,
}

impl UserPage {
    pub fn build(ctx: &Rc<Ctx>) -> Rc<dyn Page> {
        Rc::new_cyclic(|me| Self {
            ctx: ctx.clone(),
            frame: frame(PageKey::User),
            data: RefCell::new(None),
            failure: RefCell::new(None),
            selected: RefCell::new(None),
            notice: RefCell::new(None),
            recent: RefCell::new(HashMap::new()),
            details: Rc::new(DetailCache::default()),
            me: me.clone(),
        })
    }

    fn entries(data: &SeaUser) -> (Vec<Entry>, Vec<Entry>) {
        let preferences = data
            .preferences
            .iter()
            .map(|p| Entry {
                id: p.id.clone(),
                text: p.statement.clone(),
                since_ms: p.since_ms,
                by_owner: p.by_owner,
                muted: p.muted,
                item: None,
            })
            .collect();
        let facts = data
            .facts
            .iter()
            .map(|f| Entry {
                id: f.id.clone(),
                text: f.text.clone(),
                since_ms: f.since_ms,
                by_owner: f.by_owner,
                muted: f.muted,
                item: Some(f.clone()),
            })
            .collect();
        (preferences, facts)
    }

    fn find(&self, id: &str) -> Option<Entry> {
        let data = self.data.borrow();
        let data = data.as_ref()?;
        let (preferences, facts) = Self::entries(data);
        preferences
            .into_iter()
            .chain(facts)
            .find(|entry| entry.id == id)
    }

    fn select(&self, id: &str) {
        {
            let mut selected = self.selected.borrow_mut();
            *selected = if selected.as_deref() == Some(id) {
                None
            } else {
                Some(id.to_owned())
            };
        }
        *self.notice.borrow_mut() = None;
        if let Some(id) = self.selected.borrow().clone() {
            self.load_detail(&id);
        }
        self.render();
    }

    fn load_detail(&self, id: &str) {
        let weak = self.me.clone();
        self.details.load(&self.ctx, &self.details, id, move || {
            upgrade(&weak, |page| page.show_provenance());
        });
    }

    fn outcome(&self, old: &str, outcome: &Outcome) {
        let mut current = old.to_owned();
        match outcome {
            Outcome::Updated { id, .. } | Outcome::Muted { id, .. } => {
                // 守护进程让新的一条接替旧的：选中跟着走。
                current.clone_from(id);
                if self.selected.borrow().as_deref() == Some(old) {
                    *self.selected.borrow_mut() = Some(id.clone());
                }
                self.recent
                    .borrow_mut()
                    .insert(id.clone(), String::from("刚刚由你修改"));
                self.details.forget(old);
                self.details.forget(id);
            }
            Outcome::Erased => {
                *self.selected.borrow_mut() = None;
                *self.notice.borrow_mut() = Some(String::from("刚刚由你抹除"));
            }
        }
        self.ctx.overview_changed();
        self.load();
        if *outcome != Outcome::Erased {
            self.load_detail(&current);
        }
    }

    fn row(&self, entry: &Entry) -> gtk::Box {
        let current = self.selected.borrow().as_deref() == Some(entry.id.as_str());
        let holder = vbox(0);
        holder.add_css_class("qz-row");
        holder.set_widget_name(&format!("entry-row-{}", entry.id));
        let content = vbox(6);
        content.add_css_class("qz-row-pad");
        content.append(&text(&entry.text, &["qz-row-text"]));
        let meta = hbox(12);
        meta.append(&line(
            &format!("自 {} 起", format_date(entry.since_ms)),
            &["qz-meta"],
        ));
        if entry.by_owner {
            meta.append(&owner_mark());
        }
        if entry.muted {
            meta.append(&muted_mark());
        }
        content.append(&meta);
        let button = pick(&content, current, true);
        let weak = self.me.clone();
        let id = entry.id.clone();
        button.connect_clicked(move |_| upgrade(&weak, |page| page.select(&id)));
        holder.append(&button);
        if current {
            let detail = vbox(0);
            detail.set_margin_start(16);
            detail.set_margin_end(16);
            detail.set_margin_bottom(16);
            let weak = self.me.clone();
            let id = entry.id.clone();
            detail.append(&entry_actions(
                &self.ctx,
                &entry.id,
                &entry.text,
                entry.muted,
                Rc::new(move |outcome| {
                    upgrade(&weak, |page| page.outcome(&id, &outcome));
                }),
            ));
            holder.append(&detail);
        }
        holder
    }

    fn column(
        &self,
        key: &str,
        title: &str,
        sub: &str,
        entries: &[Entry],
        empty: (&str, &str),
    ) -> gtk::Box {
        let column = vbox(10);
        column.set_hexpand(true);
        column.set_widget_name(&format!("column-{key}"));
        column.set_valign(gtk::Align::Start);
        let head = hbox(10);
        let name = heading(title, &["qz-cell-title"]);
        name.set_hexpand(true);
        head.append(&name);
        head.append(&line(&format!("{} 条", entries.len()), &["qz-meta"]));
        column.append(&head);
        column.append(&text(sub, &["qz-section-note"]));
        if entries.is_empty() {
            column.append(&compact_empty(
                &format!("{key}-empty"),
                "还没有",
                empty.0,
                empty.1,
            ));
        } else {
            let list = vbox(0);
            list.add_css_class("qz-list");
            for entry in entries {
                list.append(&self.row(entry));
            }
            column.append(&list);
        }
        column
    }

    fn draw(&self, data: &SeaUser) {
        let body = &self.frame.body;
        crate::ui::clear(body);
        let (preferences, facts) = Self::entries(data);
        if preferences.is_empty() && facts.is_empty() {
            *self.selected.borrow_mut() = None;
            empty_page(
                body,
                &self.ctx,
                &Situation {
                    kind: "user-empty",
                    tone: Tone::Quiet,
                    word: "还没有",
                    title: "他还没有记下关于你的事",
                    body: "偏好和事实都从相处里来：你怎么说话、在意什么、提到过什么。不用专门告诉他，也不用在这里填。",
                    steps: &[
                        Step {
                            title: "把他接进宿主",
                            text: "在终端运行 qz connect。",
                        },
                        Step {
                            title: "照常用你的工具",
                            text: "聊过的会被当作信号收回来，经过审查才写下。",
                        },
                        Step {
                            title: "回来核对",
                            text: "他记下的每一条都在这里，可以改、不主动提或抹除。",
                        },
                    ],
                    command: None,
                    facts: Vec::new(),
                    compact: false,
                },
                Some(("看宿主接上没有", PageKey::Hosts)),
            );
            return;
        }
        let preferences_column = self.column(
            "preferences",
            "偏好",
            "他据此调整做法",
            &preferences,
            (
                "他还没有记下你的偏好",
                "你在相处里反复表现出的做法——怎么回答、多长、什么语气——会被记到这里。",
            ),
        );
        let facts_column = self.column(
            "facts",
            "事实",
            "他据此理解你",
            &facts,
            (
                "他还没有记下关于你的事实",
                "你提到过的、关于你自己的事会被记到这里：你做什么、在意什么、正在经历什么。",
            ),
        );
        let narrow = self.ctx.narrow();
        let columns = if narrow { vbox(28) } else { hbox(0) };
        columns.set_widget_name("user-columns");
        if narrow {
            columns.append(&preferences_column);
            columns.append(&facts_column);
        } else {
            preferences_column.set_margin_end(28);
            facts_column.set_margin_start(28);
            columns.append(&preferences_column);
            columns.append(&vline());
            columns.append(&facts_column);
        }
        body.append(&columns);
    }

    fn provenance(&self) -> Provenance {
        let selected = self.selected.borrow().clone();
        let Some(entry) = selected.and_then(|id| self.find(&id)) else {
            let mut content = Provenance::sentence(PageKey::User.info().sentence);
            content.recent = self.notice.borrow().clone();
            return content;
        };
        let detail = self.details.get(&entry.id);
        EntryProvenance {
            text: &entry.text,
            since_ms: entry.since_ms,
            by_owner: entry.by_owner,
            item: entry.item.as_ref(),
            detail: detail.as_ref(),
            recent: self.recent.borrow().get(&entry.id).cloned(),
            now: self.ctx.now(),
        }
        .build()
    }
}

impl Page for UserPage {
    fn key(&self) -> PageKey {
        PageKey::User
    }

    fn root(&self) -> gtk::Widget {
        self.frame.root.clone().upcast()
    }

    fn load(&self) {
        let weak = self.me.clone();
        let ctx = self.ctx.clone();
        self.ctx.api.user(move |result| {
            ctx.note(&result);
            upgrade(&weak, |page| match result {
                Ok(data) => {
                    *page.failure.borrow_mut() = None;
                    if page.data.borrow().as_ref() != Some(&data) {
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
        self.ctx.provenance_for(PageKey::User, self.provenance());
    }
}
