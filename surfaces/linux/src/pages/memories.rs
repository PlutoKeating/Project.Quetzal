#![forbid(unsafe_code)]

//! 往事：主从结构。左列是结果（上方一个搜索框与一个分段控件：全部、不主动提、已过期）；
//! 右侧是选中条目的全文、来历、生效时间与三个动作。结果按页读取，不做无限长的单列。
//! 窄屏改为钻取：没有选中时只看列表，选中后只看详情与一个「返回列表」。

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::rc::{Rc, Weak};

use gtk::prelude::*;
use gtk4 as gtk;
use quetzalcoatl_daemon::sea_governance::{MemoriesPage as MemoriesPayload, MemoryItem};

use crate::api::ApiError;
use crate::aside::Provenance;
use crate::ctx::{Ctx, Page, upgrade};
use crate::routes::PageKey;
use crate::timefmt::{excerpt, format_date};
use crate::ui::{
    Fact, Situation, Step, Tone, actions, button_outline, button_text, deflist, hbox, input_shell,
    line, pick, segmented, state_word, text, vbox, vline,
};

use super::entry::{
    DetailCache, DetailState, EntryProvenance, Outcome, entry_actions, is_expired, muted_mark,
    owner_mark, source_label, validity_text,
};
use super::{Frame, compact_empty, frame, unavailable};

const PAGE_SIZE: usize = 50;
const FILTERS: [(&str, &str); 3] = [
    ("all", "全部"),
    ("muted", "不主动提"),
    ("expired", "已过期"),
];

pub struct MemoriesPage {
    ctx: Rc<Ctx>,
    frame: Frame,
    search: gtk::SearchEntry,
    tabs: gtk::Box,
    count: gtk::Label,
    content: gtk::Box,
    query: RefCell<String>,
    filter: Cell<&'static str>,
    items: RefCell<Vec<MemoryItem>>,
    next_cursor: RefCell<Option<String>>,
    total: Cell<usize>,
    loaded: Cell<bool>,
    selected: RefCell<Option<String>>,
    list_failure: RefCell<Option<ApiError>>,
    notice: RefCell<Option<String>>,
    recent: RefCell<HashMap<String, String>>,
    loading_more: Cell<bool>,
    generation: Cell<u32>,
    details: Rc<DetailCache>,
    me: Weak<MemoriesPage>,
}

impl MemoriesPage {
    pub fn build(ctx: &Rc<Ctx>) -> Rc<dyn Page> {
        let frame = frame(PageKey::Memories);
        let search = gtk::SearchEntry::new();
        search.set_placeholder_text(Some("搜索往事"));
        search.set_widget_name("memory-search");
        crate::a11y::set_label(&search, "搜索往事");
        search.set_hexpand(true);
        let tabs = vbox(0);
        let count = line("", &["qz-meta"]);
        count.set_widget_name("memory-count");
        let content = vbox(0);

        let toolbar = hbox(16);
        toolbar.set_margin_bottom(20);
        toolbar.append(&input_shell(&search, false));
        toolbar.append(&tabs);
        toolbar.append(&count);
        frame.body.append(&toolbar);
        frame.body.append(&content);
        // 搜索框不随重绘重建：输入到一半不会丢。
        search.set_size_request(220, -1);

        let page = Rc::new_cyclic(|me| Self {
            ctx: ctx.clone(),
            frame,
            search,
            tabs,
            count,
            content,
            query: RefCell::new(String::new()),
            filter: Cell::new("all"),
            items: RefCell::new(Vec::new()),
            next_cursor: RefCell::new(None),
            total: Cell::new(0),
            loaded: Cell::new(false),
            selected: RefCell::new(None),
            list_failure: RefCell::new(None),
            notice: RefCell::new(None),
            recent: RefCell::new(HashMap::new()),
            loading_more: Cell::new(false),
            generation: Cell::new(0),
            details: Rc::new(DetailCache::default()),
            me: me.clone(),
        });
        let weak = page.me.clone();
        page.search.connect_search_changed(move |entry| {
            upgrade(&weak, |page| {
                let query = entry.text().trim().to_owned();
                if *page.query.borrow() != query {
                    *page.query.borrow_mut() = query;
                    page.reload_list();
                }
            });
        });
        page
    }

    fn filter_state(&self) -> Option<String> {
        match self.filter.get() {
            "all" => None,
            other => Some(other.to_owned()),
        }
    }

    fn query_param(&self) -> Option<String> {
        let query = self.query.borrow();
        (!query.is_empty()).then(|| query.clone())
    }

    fn set_filter(&self, key: &'static str) {
        if self.filter.get() == key {
            return;
        }
        self.filter.set(key);
        self.reload_list();
    }

    /// 重新读第一页（换了搜索词或分段、或写入之后）。
    fn reload_list(&self) {
        let generation = self.generation.get().wrapping_add(1);
        self.generation.set(generation);
        let weak = self.me.clone();
        let ctx = self.ctx.clone();
        self.ctx.api.memories(
            self.query_param(),
            self.filter_state(),
            None,
            PAGE_SIZE,
            move |result| {
                ctx.note(&result);
                upgrade(&weak, |page| {
                    if page.generation.get() != generation {
                        return;
                    }
                    page.apply_first_page(result);
                });
            },
        );
    }

    fn apply_first_page(&self, result: Result<MemoriesPayload, ApiError>) {
        match result {
            Ok(page) => {
                *self.list_failure.borrow_mut() = None;
                let was_loaded = self.loaded.replace(true);
                let unchanged = was_loaded
                    && *self.items.borrow() == page.items
                    && self.total.get() == page.total;
                if unchanged {
                    return;
                }
                *self.items.borrow_mut() = page.items;
                *self.next_cursor.borrow_mut() = page.next_cursor;
                self.total.set(page.total);
                // 选中的那一条已经不在结果里（搜索词换了）：回到没有选中。
                let selected = self.selected.borrow().clone();
                if let Some(id) = selected
                    && !self.items.borrow().iter().any(|item| item.id == id)
                    && !matches!(self.details.get(&id), Some(DetailState::Loaded(_)))
                {
                    *self.selected.borrow_mut() = None;
                }
                self.render();
            }
            Err(error) => {
                if !self.loaded.get() || !error.is_unreachable() {
                    *self.list_failure.borrow_mut() = Some(error);
                    self.render();
                }
            }
        }
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
        self.ctx.api.memories(
            self.query_param(),
            self.filter_state(),
            Some(cursor),
            PAGE_SIZE,
            move |result| {
                ctx.note(&result);
                upgrade(&weak, |page| {
                    page.loading_more.set(false);
                    match result {
                        Ok(more) => {
                            let known: Vec<String> =
                                page.items.borrow().iter().map(|i| i.id.clone()).collect();
                            page.items
                                .borrow_mut()
                                .extend(more.items.into_iter().filter(|i| !known.contains(&i.id)));
                            *page.next_cursor.borrow_mut() = more.next_cursor;
                            page.total.set(more.total);
                            *page.list_failure.borrow_mut() = None;
                            page.ctx.say(&format!(
                                "又读出一些，共显示 {} 件。",
                                page.items.borrow().len()
                            ));
                        }
                        Err(error) => {
                            if !error.is_unreachable() {
                                *page.list_failure.borrow_mut() = Some(error);
                            }
                        }
                    }
                    page.render();
                });
            },
        );
    }

    fn select(&self, id: Option<String>) {
        {
            let mut selected = self.selected.borrow_mut();
            *selected = if *selected == id { None } else { id };
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
            upgrade(&weak, |page| {
                page.render();
            });
        });
    }

    /// 选中的这一条：先在列表里找，没有就用单条读取的结果（例如从记录页跳来）。
    fn current(&self) -> Option<MemoryItem> {
        let id = self.selected.borrow().clone()?;
        let listed = self
            .items
            .borrow()
            .iter()
            .find(|item| item.id == id)
            .cloned();
        listed.or_else(|| match self.details.get(&id) {
            Some(DetailState::Loaded(detail)) => Some(detail.item.clone()),
            _ => None,
        })
    }

    fn outcome(&self, old: &str, outcome: &Outcome) {
        match outcome {
            Outcome::Updated { id, text } => {
                self.replace(old, id, |item| {
                    item.text.clone_from(text);
                    item.by_owner = true;
                });
            }
            Outcome::Muted { id, muted } => {
                self.replace(old, id, |item| item.muted = *muted);
            }
            Outcome::Erased => {
                let index = self.items.borrow().iter().position(|item| item.id == old);
                self.items.borrow_mut().retain(|item| item.id != old);
                self.total.set(self.total.get().saturating_sub(1));
                self.recent.borrow_mut().remove(old);
                *self.notice.borrow_mut() = Some(String::from("刚刚由你抹除"));
                let next = if self.ctx.narrow() {
                    None
                } else {
                    index.and_then(|at| {
                        let items = self.items.borrow();
                        items
                            .get(at)
                            .or_else(|| at.checked_sub(1).and_then(|prev| items.get(prev)))
                            .map(|item| item.id.clone())
                    })
                };
                *self.selected.borrow_mut() = next.clone();
                if let Some(next) = next {
                    self.load_detail(&next);
                }
            }
        }
        self.ctx.overview_changed();
        self.render();
        // 守护进程里的列表才是真的：安静地重读一遍第一页。
        self.reload_list();
    }

    /// 改或不主动提之后：旧的一条被新的一条接替，列表、选中与来历都跟着换。
    fn replace(&self, old: &str, new: &str, change: impl Fn(&mut MemoryItem)) {
        for item in self.items.borrow_mut().iter_mut().filter(|i| i.id == old) {
            item.id = new.to_owned();
            change(item);
        }
        if self.selected.borrow().as_deref() == Some(old) {
            *self.selected.borrow_mut() = Some(new.to_owned());
        }
        self.recent
            .borrow_mut()
            .insert(new.to_owned(), String::from("刚刚由你修改"));
        self.details.forget(old);
        self.details.forget(new);
        self.load_detail(new);
    }

    fn row(&self, item: &MemoryItem, now: u64) -> gtk::Box {
        let current = self.selected.borrow().as_deref() == Some(item.id.as_str());
        let holder = vbox(0);
        holder.add_css_class("qz-row");
        holder.set_widget_name(&format!("memory-row-{}", item.id));
        let content = vbox(6);
        content.add_css_class("qz-row-pad");
        content.append(&text(&excerpt(&item.text, 64), &["qz-row-text"]));
        let meta = hbox(12);
        meta.append(&line(
            &format!("{} · {}", format_date(item.since_ms), item.source.label),
            &["qz-meta"],
        ));
        if item.by_owner {
            meta.append(&owner_mark());
        }
        if item.muted {
            meta.append(&muted_mark());
        }
        if is_expired(item, now) {
            meta.append(&state_word(Tone::Quiet, "已过期"));
        }
        content.append(&meta);
        let button = pick(&content, current, true);
        let weak = self.me.clone();
        let id = item.id.clone();
        button.connect_clicked(move |_| upgrade(&weak, |page| page.select(Some(id.clone()))));
        holder.append(&button);
        holder
    }

    fn empty_list(&self) -> gtk::Box {
        if let Some(error) = self.list_failure.borrow().as_ref() {
            let block = Situation {
                kind: "memories-failed",
                tone: Tone::Amber,
                word: "读取失败",
                title: "这一组往事没有读出来",
                body: &error.describe(),
                steps: &[],
                command: None,
                facts: Vec::new(),
                compact: true,
            }
            .build();
            let row = actions();
            let retry = button_outline("重试", true);
            let weak = self.me.clone();
            retry.connect_clicked(move |_| upgrade(&weak, |page| page.reload_list()));
            row.append(&retry);
            block.append(&row);
            return block;
        }
        let query = self.query.borrow().clone();
        if !query.is_empty() {
            let block = compact_empty(
                "memories-no-match",
                "没有找到",
                &format!("没有找到「{query}」"),
                "换一个更短的词，或者换一种说法。他记下的是事情本身，不一定是你当时的原话。",
            );
            let row = actions();
            let clear = button_outline("清空搜索", true);
            let weak = self.me.clone();
            clear.connect_clicked(move |_| {
                upgrade(&weak, |page| page.search.set_text(""));
            });
            row.append(&clear);
            block.append(&row);
            return block;
        }
        let (kind, title, body) = match self.filter.get() {
            "muted" => (
                "memories-no-muted",
                "没有不主动提的往事",
                "在一件往事上点「不主动提」，他仍然记得，但不会再主动提起。那样的往事会列在这里。",
            ),
            "expired" => (
                "memories-no-expired",
                "没有已过期的往事",
                "有些事只在一段时间里成立。过了期限，它们不再送进宿主，但仍然列在这里备查。",
            ),
            _ => ("memories-empty", "", ""),
        };
        if self.filter.get() == "all" {
            return Situation {
                kind,
                tone: Tone::Quiet,
                word: "还没有",
                title: "他还没有任何往事",
                body: "往事从相处里来。你在宿主里和他聊过的事，会被当作信号收回来，经过独立审查才写下。也可以把过去带进来。",
                steps: &[
                    Step {
                        title: "把他接进宿主",
                        text: "在终端运行 qz connect。",
                    },
                    Step {
                        title: "照常相处",
                        text: "聊过的会自己沉淀，不需要你确认。",
                    },
                    Step {
                        title: "回来核对",
                        text: "每一件都能在这里搜到、改掉、不主动提或抹除。",
                    },
                ],
                command: None,
                facts: Vec::new(),
                compact: true,
            }
            .build();
        }
        let block = compact_empty(kind, "没有", title, body);
        let row = actions();
        let all = button_outline("看全部往事", true);
        let weak = self.me.clone();
        all.connect_clicked(move |_| upgrade(&weak, |page| page.set_filter("all")));
        row.append(&all);
        block.append(&row);
        block
    }

    fn list_column(&self) -> gtk::Box {
        let column = vbox(0);
        column.set_widget_name("memory-list");
        column.set_hexpand(false);
        let items = self.items.borrow().clone();
        if items.is_empty() {
            column.append(&self.empty_list());
            return column;
        }
        let now = self.ctx.now();
        let list = vbox(0);
        list.add_css_class("qz-list");
        for item in &items {
            list.append(&self.row(item, now));
        }
        let scroller = gtk::ScrolledWindow::new();
        scroller.set_policy(gtk::PolicyType::Never, gtk::PolicyType::Automatic);
        scroller.set_min_content_height(if self.ctx.narrow() { 360 } else { 440 });
        scroller.set_max_content_height(640);
        scroller.set_propagate_natural_height(true);
        scroller.set_child(Some(&list));
        column.append(&scroller);
        let foot = hbox(12);
        foot.set_margin_top(12);
        let shown = line(
            &format!("已显示 {} / {}", items.len(), self.total.get()),
            &["qz-meta"],
        );
        shown.set_widget_name("memory-shown");
        shown.set_hexpand(true);
        foot.append(&shown);
        if self.next_cursor.borrow().is_some() {
            let remaining = self.total.get().saturating_sub(items.len());
            let label = if self.loading_more.get() {
                String::from("正在读取")
            } else if remaining > 0 {
                format!("再看 {} 件", remaining.min(PAGE_SIZE))
            } else {
                String::from("再看一些")
            };
            let more = button_outline(&label, true);
            more.set_widget_name("memory-more");
            more.set_sensitive(!self.loading_more.get());
            let weak = self.me.clone();
            more.connect_clicked(move |_| upgrade(&weak, |page| page.load_more()));
            foot.append(&more);
        }
        column.append(&foot);
        if let Some(error) = self.list_failure.borrow().as_ref() {
            column.append(&crate::ui::amber_hint(&format!(
                "没有读出来：{}",
                error.describe()
            )));
        }
        column
    }

    fn detail_column(&self) -> gtk::Box {
        let column = vbox(16);
        column.set_widget_name("memory-detail");
        column.add_css_class("qz-split-detail");
        column.set_hexpand(true);
        let selected = self.selected.borrow().clone();
        if self.ctx.narrow() && selected.is_some() {
            let back = button_text("返回列表");
            back.set_halign(gtk::Align::Start);
            back.set_widget_name("memory-back");
            let weak = self.me.clone();
            back.connect_clicked(move |_| {
                upgrade(&weak, |page| {
                    *page.selected.borrow_mut() = None;
                    page.render();
                });
            });
            column.append(&back);
        }
        let Some(id) = selected else {
            column.append(&compact_empty(
                "memories-nothing-selected",
                "没有选中",
                "选一件往事",
                "它的全文、来历、生效时间和三个动作会出现在这里。",
            ));
            return column;
        };
        let Some(item) = self.current() else {
            if matches!(self.details.get(&id), Some(DetailState::Missing)) {
                column.append(&compact_empty(
                    "memory-missing",
                    "读不出来",
                    "这一件往事读不出来",
                    "它可能已经被抹除了。",
                ));
            } else {
                column.append(&line("正在读取这一件往事", &["qz-meta"]));
            }
            return column;
        };
        let now = self.ctx.now();
        let meta = hbox(12);
        if let Some(topic) = &item.topic {
            meta.append(&line(topic, &["qz-meta"]));
        }
        if item.by_owner {
            meta.append(&owner_mark());
        }
        if item.muted {
            meta.append(&muted_mark());
        }
        if is_expired(&item, now) {
            meta.append(&state_word(Tone::Quiet, "已过期"));
        }
        column.append(&meta);
        let body = text(&item.text, &["qz-detail-text"]);
        body.set_widget_name("memory-text");
        body.set_max_width_chars(48);
        column.append(&body);
        column.append(&deflist(&[
            Fact::new("来历", source_label(&item)),
            Fact::new("生效", validity_text(&item, now)),
        ]));
        let weak = self.me.clone();
        let item_id = item.id.clone();
        column.append(&entry_actions(
            &self.ctx,
            &item.id,
            &item.text,
            item.muted,
            Rc::new(move |outcome| {
                upgrade(&weak, |page| page.outcome(&item_id, &outcome));
            }),
        ));
        column
    }

    fn draw_toolbar(&self) {
        crate::ui::clear(&self.tabs);
        let weak = self.me.clone();
        let tabs = segmented(&FILTERS, self.filter.get(), move |key| {
            upgrade(&weak, |page| page.set_filter(key));
        });
        self.tabs.append(&tabs);
        self.count.set_label(&format!("共 {} 件", self.total.get()));
    }

    fn draw(&self) {
        self.draw_toolbar();
        crate::ui::clear(&self.content);
        let narrow = self.ctx.narrow();
        let selected = self.selected.borrow().is_some();
        if narrow {
            if selected {
                self.content.append(&self.detail_column());
            } else {
                self.content.append(&self.list_column());
            }
            return;
        }
        let split = hbox(0);
        split.set_widget_name("memory-split");
        let list = self.list_column();
        list.set_width_request(380);
        split.append(&list);
        split.append(&vline());
        split.append(&self.detail_column());
        self.content.append(&split);
    }

    fn provenance(&self) -> Provenance {
        let Some(item) = self.current() else {
            let mut content = Provenance::sentence(PageKey::Memories.info().sentence);
            content.facts = vec![Fact::new("共有", format!("{} 件", self.total.get()))];
            content.recent = self.notice.borrow().clone();
            return content;
        };
        let detail = self.details.get(&item.id);
        let mut content = EntryProvenance {
            text: &item.text,
            since_ms: item.since_ms,
            by_owner: item.by_owner,
            item: Some(&item),
            detail: detail.as_ref(),
            recent: self.recent.borrow().get(&item.id).cloned(),
            now: self.ctx.now(),
        }
        .build();
        // 往事的出处栏还保留上一步的痕迹：刚抹除了另一条。
        if content.recent.is_none() {
            content.recent = self.notice.borrow().clone();
        }
        content
    }
}

impl Page for MemoriesPage {
    fn key(&self) -> PageKey {
        PageKey::Memories
    }

    fn root(&self) -> gtk::Widget {
        self.frame.root.clone().upcast()
    }

    fn load(&self) {
        // 已经翻过页的列表不被轮询打回第一页。
        if self.items.borrow().len() > PAGE_SIZE || self.loading_more.get() {
            return;
        }
        self.reload_list();
    }

    fn render(&self) {
        if !self.loaded.get() {
            if let Some(error) = self.list_failure.borrow().clone() {
                crate::ui::clear(&self.content);
                let weak = self.me.clone();
                let holder = vbox(0);
                unavailable(
                    &holder,
                    &error,
                    Rc::new(move || upgrade(&weak, |page| page.reload_list())),
                );
                self.content.append(&holder);
            }
            return;
        }
        self.draw();
        self.show_provenance();
    }

    fn show_provenance(&self) {
        self.ctx
            .provenance_for(PageKey::Memories, self.provenance());
    }

    fn focus_entry(&self, id: &str) {
        self.filter.set("all");
        self.search.set_text("");
        *self.selected.borrow_mut() = Some(id.to_owned());
        self.load_detail(id);
        self.render();
    }
}
