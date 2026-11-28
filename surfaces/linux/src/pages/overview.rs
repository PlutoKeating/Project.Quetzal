#![forbid(unsafe_code)]

//! 总览：居中的名字与「相处第 N 天」，其下一条三格的发丝线栅格——宿主、等你的事、同步。
//! 等你的事为零时这一格说「没有事在等你」，不隐藏。

use std::cell::RefCell;
use std::rc::{Rc, Weak};

use gtk::prelude::*;
use gtk4 as gtk;
use quetzalcoatl_daemon::sea_governance::{OverviewHost, SeaOverview};

use crate::api::ApiError;
use crate::aside::Provenance;
use crate::ctx::{Ctx, Page, upgrade};
use crate::routes::PageKey;
use crate::timefmt::{days_together, format_ago, format_date, hub_host};
use crate::ui::{Fact, Tone, cell, code_chip, hbox, heading, line, rail, state_word, text, vbox};

use super::{Frame, frame, goto_link, signal_row, unavailable};

/// 有几件事在等：他的变化、要拍板的事，以及还没签的底线。
#[must_use]
pub fn pending_count(overview: &SeaOverview) -> usize {
    overview.pending.disclosures
        + overview.pending.approvals
        + usize::from(!overview.baseline.signed)
}

pub struct OverviewPage {
    ctx: Rc<Ctx>,
    frame: Frame,
    data: RefCell<Option<SeaOverview>>,
    failure: RefCell<Option<ApiError>>,
    me: Weak<OverviewPage>,
}

impl OverviewPage {
    pub fn build(ctx: &Rc<Ctx>) -> Rc<dyn Page> {
        let frame = frame(PageKey::Overview);
        // 这一页的标题就是他的名字；通用页首只在读不出来时出现。
        frame.head.root.set_visible(false);
        Rc::new_cyclic(|me| Self {
            ctx: ctx.clone(),
            frame,
            data: RefCell::new(None),
            failure: RefCell::new(None),
            me: me.clone(),
        })
    }

    fn cell(title: &str, state: gtk::Box, children: &[gtk::Widget]) -> gtk::Box {
        let holder = cell();
        let head = hbox(10);
        let name = heading(title, &["qz-cell-title"]);
        name.set_hexpand(true);
        head.append(&name);
        head.append(&state);
        holder.append(&head);
        for child in children {
            holder.append(child);
        }
        holder
    }

    fn hosts_cell(&self, hosts: &[OverviewHost], now: u64) -> gtk::Widget {
        if hosts.is_empty() {
            let note = hbox(6);
            note.append(&text("他还没有住进任何宿主。在终端运行", &["qz-body"]));
            let holder = vbox(10);
            holder.append(&note);
            holder.append(&code_chip("qz connect"));
            holder.append(&text("把他接进去。", &["qz-body"]));
            return Self::cell(
                "宿主",
                state_word(Tone::Amber, "还没有"),
                &[
                    holder.upcast(),
                    goto_link(&self.ctx, "看怎么接", PageKey::Hosts).upcast(),
                ],
            )
            .upcast();
        }
        let connected = hosts.iter().filter(|host| host.connected).count();
        let state = if connected > 0 {
            state_word(Tone::Ice, &format!("{connected} 个通着"))
        } else {
            state_word(Tone::Amber, "都没接上")
        };
        let list = vbox(8);
        for host in hosts {
            let meta = if host.connected {
                String::from("通")
            } else {
                match host.last_seen_ms {
                    None => String::from("未接上"),
                    Some(seen) => format!("未接上 · {}见过", format_ago(seen, now)),
                }
            };
            list.append(&signal_row(
                if host.connected {
                    Tone::Ice
                } else {
                    Tone::Amber
                },
                &host.name,
                Some(&meta),
            ));
        }
        Self::cell(
            "宿主",
            state,
            &[
                list.upcast(),
                goto_link(&self.ctx, "看每一步通不通", PageKey::Hosts).upcast(),
            ],
        )
        .upcast()
    }

    fn pending_cell(&self, overview: &SeaOverview) -> gtk::Widget {
        let total = pending_count(overview);
        if total == 0 {
            let note = text("没有事在等你。", &["qz-cell-title"]);
            note.set_widget_name("nothing-pending");
            return Self::cell(
                "等你的事",
                state_word(Tone::Quiet, "0 件"),
                &[
                    note.upcast(),
                    text(
                        "他变了、底线要签、有事要你拍板时，会出现在这里。",
                        &["qz-body"],
                    )
                    .upcast(),
                ],
            )
            .upcast();
        }
        let list = vbox(10);
        if overview.pending.disclosures > 0 {
            let row = signal_row(
                Tone::Amber,
                &format!("{} 处变化等你看", overview.pending.disclosures),
                None,
            );
            list.append(&row);
            list.append(&goto_link(&self.ctx, "去看他的变化", PageKey::SelfPage));
        }
        if !overview.baseline.signed {
            list.append(&signal_row(Tone::Amber, "底线待签署", None));
            list.append(&goto_link(&self.ctx, "去签署底线", PageKey::Baseline));
        }
        if overview.pending.approvals > 0 {
            list.append(&signal_row(
                Tone::Amber,
                &format!("{} 件事等你拍板", overview.pending.approvals),
                Some("在宿主里拍板"),
            ));
        }
        Self::cell(
            "等你的事",
            state_word(Tone::Amber, &format!("{total} 件")),
            &[list.upcast()],
        )
        .upcast()
    }

    fn sync_cell(&self, overview: &SeaOverview, now: u64) -> gtk::Widget {
        let sync = &overview.sync;
        let state = match sync.state.as_str() {
            "synced" => state_word(Tone::Ice, "已同步"),
            "behind" => state_word(Tone::Amber, "落后"),
            _ => state_word(Tone::Quiet, "仅本机"),
        };
        let list = vbox(8);
        list.append(&signal_row(
            Tone::Quiet,
            &format!("{} 台设备上有他", sync.devices),
            None,
        ));
        if sync.state == "local-only" {
            list.append(&text("没有接同步，他只在这台设备上。", &["qz-body"]));
        } else {
            let last = sync
                .last_synced_ms
                .map_or_else(|| String::from("还没有过"), |ms| format_ago(ms, now));
            list.append(&signal_row(Tone::Quiet, "上次同步", Some(&last)));
            if let Some(url) = &sync.hub_url {
                list.append(&signal_row(Tone::Quiet, "经由", Some(&hub_host(url))));
            }
        }
        Self::cell(
            "同步",
            state,
            &[
                list.upcast(),
                goto_link(&self.ctx, "看设备", PageKey::Devices).upcast(),
            ],
        )
        .upcast()
    }

    fn draw(&self, overview: &SeaOverview) {
        let now = self.ctx.now();
        let body = &self.frame.body;
        crate::ui::clear(body);

        let presence = vbox(10);
        presence.set_halign(gtk::Align::Center);
        presence.set_margin_top(24);
        presence.set_margin_bottom(44);
        let name = heading(&overview.agent.name, &["qz-display"]);
        name.set_widget_name("agent-name");
        name.set_justify(gtk::Justification::Center);
        name.set_xalign(0.5);
        presence.append(&name);
        let days = text(
            &format!("相处第 {} 天", days_together(overview.agent.since_ms, now)),
            &["qz-lead"],
        );
        days.set_widget_name("days-together");
        days.set_xalign(0.5);
        days.set_justify(gtk::Justification::Center);
        presence.append(&days);
        let counts = hbox(10);
        counts.set_halign(gtk::Align::Center);
        counts.set_margin_top(6);
        for (index, word) in [
            format!("{} 条核心", overview.counts.core_values),
            format!("{} 条关于你", overview.counts.about_user),
            format!("{} 件往事", overview.counts.memories),
        ]
        .iter()
        .enumerate()
        {
            if index > 0 {
                counts.append(&line("·", &["qz-meta"]));
            }
            counts.append(&line(word, &["qz-meta"]));
        }
        presence.append(&counts);
        body.append(&presence);

        let cells = vec![
            self.hosts_cell(&overview.hosts, now),
            self.pending_cell(overview),
            self.sync_cell(overview, now),
        ];
        let grid = rail(&cells, 3);
        grid.set_widget_name("overview-rail");
        body.append(&grid);
    }

    fn provenance(&self) -> Provenance {
        let mut content = Provenance::sentence(PageKey::Overview.info().sentence);
        if let Some(overview) = self.data.borrow().as_ref() {
            let baseline = match (overview.baseline.signed, overview.baseline.signed_at_ms) {
                (true, Some(at)) => format!(
                    "{} 条，自 {} 起生效",
                    overview.baseline.directive_count,
                    format_date(at)
                ),
                _ => String::from("待签署"),
            };
            content.facts = vec![
                Fact::new("相处自", format_date(overview.agent.since_ms)),
                Fact::new("底线", baseline),
                Fact::new("不主动提", format!("{} 条", overview.counts.muted)),
            ];
        }
        content
    }
}

impl Page for OverviewPage {
    fn key(&self) -> PageKey {
        PageKey::Overview
    }

    fn root(&self) -> gtk::Widget {
        self.frame.root.clone().upcast()
    }

    fn load(&self) {
        let weak = self.me.clone();
        let ctx = self.ctx.clone();
        self.ctx.api.overview(move |result| {
            ctx.note(&result);
            upgrade(&weak, |page| match result {
                Ok(overview) => {
                    *page.failure.borrow_mut() = None;
                    if page.data.borrow().as_ref() != Some(&overview) {
                        *page.data.borrow_mut() = Some(overview);
                        page.render();
                    }
                    page.show_provenance();
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
        match data {
            Some(overview) => self.draw(&overview),
            None => {
                let failure = self.failure.borrow().clone();
                match failure {
                    Some(error) => {
                        self.frame.head.root.set_visible(true);
                        let weak = self.me.clone();
                        unavailable(
                            &self.frame.body,
                            &error,
                            Rc::new(move || upgrade(&weak, |page| page.load())),
                        );
                    }
                    None => crate::ui::clear(&self.frame.body),
                }
            }
        }
        if self.data.borrow().is_some() {
            self.frame.head.root.set_visible(false);
        }
    }

    fn show_provenance(&self) {
        self.ctx
            .provenance_for(PageKey::Overview, self.provenance());
    }
}
