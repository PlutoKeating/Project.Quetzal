#![forbid(unsafe_code)]

//! 九页。每一页只「看」和「签」：没有任何给他发一句话的输入框。

use std::rc::Rc;

use gtk::prelude::*;
use gtk4 as gtk;

use crate::api::ApiError;
use crate::ctx::{Ctx, Page};
use crate::degrade;
use crate::routes::PageKey;
use crate::ui::{
    PageHead, Situation, Step, Tone, actions, button_outline, clear, hbox, link_arrow, vbox,
};

mod audit;
mod baseline;
mod devices;
pub mod entry;
mod hosts;
mod memories;
mod overview;
mod self_page;
mod us;
mod user;

/// 建出九页，顺序与导航一致。
#[must_use]
pub fn build_all(ctx: &Rc<Ctx>) -> Vec<Rc<dyn Page>> {
    vec![
        overview::OverviewPage::build(ctx),
        self_page::SelfPage::build(ctx),
        user::UserPage::build(ctx),
        us::UsPage::build(ctx),
        memories::MemoriesPage::build(ctx),
        baseline::BaselinePage::build(ctx),
        hosts::HostsPage::build(ctx),
        devices::DevicesPage::build(ctx),
        audit::AuditPage::build(ctx),
    ]
}

/// 一页的外框：页首 + 正文。
pub struct Frame {
    pub root: gtk::Box,
    pub head: PageHead,
    pub body: gtk::Box,
}

/// 搭一页的外框。总览没有通用页首（它的标题就是他的名字），调用方可以隐藏。
#[must_use]
pub fn frame(key: PageKey) -> Frame {
    let info = key.info();
    let root = vbox(0);
    root.set_widget_name(&format!("page-{}", info.slug));
    let head = PageHead::new(info.label, info.lead);
    head.root.set_margin_bottom(28);
    root.append(&head.root);
    let body = vbox(0);
    body.set_widget_name(&format!("body-{}", info.slug));
    root.append(&body);
    Frame { root, head, body }
}

/// 这一页从来没有读出来过：联系不上、接口未就绪或读取失败。说清现状与下一步。
pub fn unavailable(body: &gtk::Box, error: &ApiError, retry: Rc<dyn Fn()>) {
    clear(body);
    let situation = match error {
        ApiError::Unreachable(_) => Situation {
            kind: "unreachable",
            tone: Tone::Amber,
            word: degrade::STATUS_WORD,
            title: degrade::UNREACHABLE_TITLE,
            body: degrade::UNREACHABLE_BODY,
            steps: &[],
            command: Some(("在终端启动它：", degrade::NEXT_STEP_COMMAND)),
            facts: Vec::new(),
            compact: false,
        },
        ApiError::Remote { code, detail } if code == "UNKNOWN_METHOD" || code == "BAD_REQUEST" => {
            Situation {
                kind: "not-ready",
                tone: Tone::Amber,
                word: "接口未就绪",
                title: "这个守护进程还不提供这一页的内容",
                body: "页面已经连上它，但它不认识这一页要用的读取方法。通常是守护进程的版本比治理面旧。",
                steps: &[
                    Step {
                        title: "升级",
                        text: "把 Quetzalcoatl 升级到最新版本。",
                    },
                    Step {
                        title: "重启守护进程",
                        text: "在终端先运行 qz down，再运行 qz up。",
                    },
                    Step {
                        title: "回到这里",
                        text: "点「重试」，这一页会重新读取。",
                    },
                ],
                command: None,
                facts: vec![crate::ui::Fact::mono(
                    "答复",
                    if detail.is_empty() {
                        code.clone()
                    } else {
                        format!("{code} · {detail}")
                    },
                )],
                compact: false,
            }
        }
        _ => Situation {
            kind: "failed",
            tone: Tone::Amber,
            word: "读取失败",
            title: "这一页没有读出来",
            body: &error.describe(),
            steps: &[],
            command: None,
            facts: Vec::new(),
            compact: false,
        },
    };
    let block = situation.build();
    let row = actions();
    let button = button_outline("重试", false);
    button.set_widget_name("situation-retry");
    button.connect_clicked(move |_| retry());
    row.append(&button);
    block.append(&row);
    body.append(&block);
}

/// 一页只有一部分为空时嵌进去的紧凑版面。
#[must_use]
pub fn compact_empty(kind: &str, word: &str, title: &str, text: &str) -> gtk::Box {
    Situation {
        kind,
        tone: Tone::Quiet,
        word,
        title,
        body: text,
        steps: &[],
        command: None,
        facts: Vec::new(),
        compact: true,
    }
    .build()
}

/// 一行：「看怎么接」之类的跳转。
#[must_use]
pub fn goto_link(ctx: &Rc<Ctx>, label: &str, key: PageKey) -> gtk::Button {
    let link = link_arrow(label);
    let ctx = ctx.clone();
    link.connect_clicked(move |_| ctx.goto(key, None));
    link
}

/// 一个标记、一句话、一个靠右的安静事实：格子里的短清单。
#[must_use]
pub fn signal_row(tone: Tone, content: &str, meta: Option<&str>) -> gtk::Box {
    let row = hbox(10);
    row.append(&crate::ui::dot(tone));
    let label = crate::ui::text(content, &["qz-body"]);
    label.set_hexpand(true);
    row.append(&label);
    if let Some(meta) = meta {
        let fact = crate::ui::text(meta, &["qz-meta"]);
        fact.set_halign(gtk::Align::End);
        fact.set_xalign(1.0);
        row.append(&fact);
    }
    row
}

/// 发丝线栅格里一个可选取的单元格：整格都能点。
#[must_use]
pub fn pickable_cell(inner: &gtk::Box, current: bool, on_pick: impl Fn() + 'static) -> gtk::Widget {
    let button = crate::ui::pick(inner, current, false);
    button.set_hexpand(true);
    button.connect_clicked(move |_| on_pick());
    button.upcast()
}

/// 空页版面：状态词 + 标题 + 说明 + 步骤，再加一个跳转。
pub fn empty_page(
    body: &gtk::Box,
    ctx: &Rc<Ctx>,
    situation: &Situation<'_>,
    link: Option<(&str, PageKey)>,
) {
    clear(body);
    let block = situation.build();
    if let Some((label, key)) = link {
        let row = hbox(0);
        row.append(&goto_link(ctx, label, key));
        block.append(&row);
    }
    body.append(&block);
}
