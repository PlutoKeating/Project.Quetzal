#![forbid(unsafe_code)]

//! 出处栏：当前选中条目的来历。没有选中时是这一页的一句话说明，永不留空。
//! 窄屏下它不再是一栏，而是正文下方的一段。

use std::rc::Rc;

use gtk::prelude::*;
use gtk4 as gtk;

use crate::timefmt::format_date_time;
use crate::ui::{
    Fact, TickTone, Tone, button_outline, deflist, heading, line, state_word, text, timeline_item,
    vbox,
};

/// 来历里的一步。
#[derive(Clone, Debug)]
pub struct Event {
    pub at_ms: Option<u64>,
    pub text: String,
    /// 这一步由人亲手做出。
    pub amber: bool,
}

/// 出处栏要显示的一条来历。
#[derive(Default)]
pub struct Provenance {
    /// 选中条目的原文或名字；没有选中时省略。
    pub title: Option<String>,
    /// 一句话：必填，出处栏因此永不留空。
    pub lead: String,
    pub facts: Vec<Fact>,
    pub events: Option<(String, Vec<Event>)>,
    pub list: Option<(String, Vec<String>)>,
    pub link: Option<(String, Rc<dyn Fn()>)>,
    /// 正在读取这一条更完整的来历。
    pub pending: bool,
    /// 写操作刚刚成功时追加的那一行，例如「刚刚由你修改」。
    pub recent: Option<String>,
}

impl Provenance {
    /// 没有选中任何条目时：这一页的一句话说明。
    #[must_use]
    pub fn sentence(lead: &str) -> Self {
        Self {
            lead: lead.to_owned(),
            ..Self::default()
        }
    }
}

/// 出处栏控件。
pub struct Aside {
    /// 整个出处栏（宽屏放在右栏，窄屏放在正文下方）。
    pub root: gtk::Box,
    body: gtk::Box,
}

impl Aside {
    #[must_use]
    pub fn new() -> Self {
        let root = vbox(0);
        root.add_css_class("qz-app-aside-inner");
        root.set_widget_name("provenance");
        root.set_margin_top(28);
        root.set_margin_bottom(32);
        root.set_margin_start(24);
        root.set_margin_end(24);
        root.append(&heading("出处", &["qz-label-small"]));
        let body = vbox(0);
        body.set_margin_top(10);
        root.append(&body);
        Self { root, body }
    }

    /// 换成这一条来历。
    pub fn show(&self, content: &Provenance) {
        crate::ui::clear(&self.body);
        let body = &self.body;
        if let Some(title) = &content.title {
            let title_label = heading(title, &["qz-aside-title"]);
            title_label.set_widget_name("provenance-title");
            body.append(&title_label);
        }
        let lead = text(&content.lead, &["qz-aside-lead"]);
        lead.set_widget_name("provenance-lead");
        lead.set_margin_top(if content.title.is_some() { 10 } else { 0 });
        body.append(&lead);

        if !content.facts.is_empty() {
            let facts = deflist(&content.facts);
            facts.set_margin_top(20);
            body.append(&facts);
        }
        if let Some((label, items)) = &content.list
            && !items.is_empty()
        {
            let block = vbox(8);
            block.set_margin_top(22);
            block.append(&line(label, &["qz-label-small"]));
            for item in items {
                block.append(&text(item, &["qz-aside-lead"]));
            }
            body.append(&block);
        }
        if let Some((label, events)) = &content.events
            && !events.is_empty()
        {
            let block = vbox(10);
            block.set_margin_top(22);
            block.append(&line(label, &["qz-label-small"]));
            let timeline = vbox(0);
            for event in events {
                let time = event.at_ms.map(format_date_time);
                let content = text(&event.text, &["qz-timeline-text"]);
                timeline.append(&timeline_item(
                    time.as_deref(),
                    &content,
                    if event.amber {
                        TickTone::Amber
                    } else {
                        TickTone::Neutral
                    },
                    true,
                ));
            }
            block.append(&timeline);
            body.append(&block);
        }
        if content.pending {
            let pending = line("正在读取它的来历", &["qz-meta"]);
            pending.set_margin_top(18);
            body.append(&pending);
        }
        if let Some((label, go)) = &content.link {
            let link = button_outline(label, true);
            link.set_halign(gtk::Align::Start);
            link.set_margin_top(20);
            let go = go.clone();
            link.connect_clicked(move |_| go());
            body.append(&link);
        }
        crate::ui::cap_label_width(&self.body, 30);
        if let Some(recent) = &content.recent {
            let mark = state_word(Tone::Amber, recent);
            mark.set_widget_name("provenance-recent");
            mark.set_margin_top(20);
            mark.set_halign(gtk::Align::Start);
            body.append(&mark);
        }
    }
}

impl Default for Aside {
    fn default() -> Self {
        Self::new()
    }
}
