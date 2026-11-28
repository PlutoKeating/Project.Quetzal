#![forbid(unsafe_code)]

//! 他：上半是核心价值的发丝线栅格（编号、陈述、自何时起），性情列在其后、字号小一级；
//! 下半是「最近的变化」时间线，每一条变化可以展开证据链（哪几次相处、跨多少天）。

use std::cell::RefCell;
use std::collections::HashSet;
use std::rc::{Rc, Weak};

use gtk::prelude::*;
use gtk4 as gtk;
use quetzalcoatl_daemon::sea_governance::{SeaSelf, SelfChange};

use crate::api::ApiError;
use crate::aside::{Event, Provenance};
use crate::ctx::{Ctx, Page, upgrade};
use crate::routes::PageKey;
use crate::timefmt::{excerpt, format_date, format_date_time, ordinal, span_days};
use crate::ui::{
    Fact, TickTone, Tone, button_text, cell, deflist, hbox, heading, line, pick, rail, section,
    state_word, text, timeline_item, vbox,
};

use super::{Frame, compact_empty, empty_page, frame, pickable_cell, unavailable};
use crate::ui::{Situation, Step};

/// 自述是 Markdown 写的：界面里只要字，不要标记。
fn plain_text(markdown: &str) -> String {
    markdown
        .lines()
        .map(|line| line.trim_start_matches('#').trim())
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum Selection {
    Value(String),
    Temperament(String),
    Change(String),
}

pub struct SelfPage {
    ctx: Rc<Ctx>,
    frame: Frame,
    data: RefCell<Option<SeaSelf>>,
    failure: RefCell<Option<ApiError>>,
    selection: RefCell<Option<Selection>>,
    expanded: RefCell<HashSet<String>>,
    me: Weak<SelfPage>,
}

impl SelfPage {
    pub fn build(ctx: &Rc<Ctx>) -> Rc<dyn Page> {
        Rc::new_cyclic(|me| Self {
            ctx: ctx.clone(),
            frame: frame(PageKey::SelfPage),
            data: RefCell::new(None),
            failure: RefCell::new(None),
            selection: RefCell::new(None),
            expanded: RefCell::new(HashSet::new()),
            me: me.clone(),
        })
    }

    fn select(&self, selection: Selection) {
        {
            let mut current = self.selection.borrow_mut();
            *current = if current.as_ref() == Some(&selection) {
                None
            } else {
                Some(selection)
            };
        }
        self.render();
    }

    fn is_current(&self, selection: &Selection) -> bool {
        self.selection.borrow().as_ref() == Some(selection)
    }

    fn target_statement(target_id: &str, data: &SeaSelf) -> Option<String> {
        data.core_values
            .iter()
            .find(|value| value.id == target_id)
            .map(|value| value.statement.clone())
            .or_else(|| {
                data.temperament
                    .iter()
                    .find(|item| item.id == target_id)
                    .map(|item| item.statement.clone())
            })
            .or_else(|| {
                data.identity
                    .iter()
                    .find(|item| item.id == target_id)
                    .map(|item| item.text.clone())
            })
    }

    fn core_section(&self, data: &SeaSelf) -> gtk::Box {
        let content: gtk::Widget = if data.core_values.is_empty() {
            compact_empty(
                "core-empty",
                "还没有",
                "他的核心还没有成形",
                "同一件事在多次相处里反复出现，经过冷却，才会升为核心。这个过程不需要你批准，但每一次都会告诉你。",
            )
            .upcast()
        } else {
            let cells: Vec<gtk::Widget> = data
                .core_values
                .iter()
                .enumerate()
                .map(|(index, value)| {
                    let selection = Selection::Value(value.id.clone());
                    let inner = cell();
                    inner.append(&line(&ordinal(index), &["qz-cell-num"]));
                    inner.append(&heading(&value.statement, &["qz-cell-title"]));
                    inner.append(&line(
                        &format!("自 {} 起", format_date(value.since_ms)),
                        &["qz-meta"],
                    ));
                    let weak = self.me.clone();
                    let target = selection.clone();
                    pickable_cell(&inner, self.is_current(&selection), move || {
                        upgrade(&weak, |page| page.select(target.clone()));
                    })
                })
                .collect();
            let grid = rail(&cells, 3);
            grid.set_widget_name("core-values");
            grid.upcast()
        };
        section(
            "核心价值",
            false,
            Some("一次施压改不了它；只有反复出现的证据可以。"),
            &content,
        )
    }

    fn temperament_section(&self, data: &SeaSelf) -> gtk::Box {
        let cells: Vec<gtk::Widget> = data
            .temperament
            .iter()
            .map(|item| {
                let selection = Selection::Temperament(item.id.clone());
                let inner = cell();
                inner.append(&text(&item.statement, &["qz-body"]));
                inner.append(&line(
                    &format!("自 {} 起", format_date(item.since_ms)),
                    &["qz-meta"],
                ));
                let weak = self.me.clone();
                let target = selection.clone();
                pickable_cell(&inner, self.is_current(&selection), move || {
                    upgrade(&weak, |page| page.select(target.clone()));
                })
            })
            .collect();
        let grid = rail(&cells, 3);
        grid.set_widget_name("temperament");
        section(
            "性情",
            true,
            Some("他说话和做事的习惯，比核心更容易变。"),
            &grid,
        )
    }

    fn change_item(&self, change: &SelfChange, data: &SeaSelf) -> gtk::Overlay {
        let selection = Selection::Change(change.id.clone());
        let current = self.is_current(&selection);
        let open = self.expanded.borrow().contains(&change.id);
        let target = Self::target_statement(&change.target_id, data);
        let span = span_days(
            &change
                .evidence
                .iter()
                .map(|evidence| evidence.at_ms)
                .collect::<Vec<_>>(),
        );
        let body = vbox(6);
        let summary = text(&change.summary, &["qz-timeline-text"]);
        let weak = self.me.clone();
        let target_selection = selection.clone();
        let summary_pick = pick(&summary, current, false);
        summary_pick.connect_clicked(move |_| {
            upgrade(&weak, |page| page.select(target_selection.clone()));
        });
        body.append(&summary_pick);
        let meta = hbox(12);
        if let Some(target) = &target {
            meta.append(&line(
                &format!("落在「{}」", excerpt(target, 18)),
                &["qz-meta"],
            ));
        }
        if !change.acknowledged {
            meta.append(&state_word(Tone::Amber, "等你看"));
        }
        body.append(&meta);
        if change.evidence.is_empty() {
            body.append(&line("这次变化没有附带证据", &["qz-meta"]));
        } else {
            let toggle = button_text(&format!(
                "证据：{} 次相处，跨 {span} 天",
                change.evidence.len()
            ));
            toggle.set_halign(gtk::Align::Start);
            toggle.set_widget_name("evidence-toggle");
            let weak = self.me.clone();
            let id = change.id.clone();
            toggle.connect_clicked(move |_| {
                upgrade(&weak, |page| {
                    {
                        let mut expanded = page.expanded.borrow_mut();
                        if !expanded.remove(&id) {
                            expanded.insert(id.clone());
                        }
                    }
                    *page.selection.borrow_mut() = Some(Selection::Change(id.clone()));
                    page.render();
                });
            });
            body.append(&toggle);
            if open {
                let list = vbox(6);
                list.set_widget_name("evidence");
                for evidence in &change.evidence {
                    let row = hbox(10);
                    row.append(&crate::ui::dot(Tone::Quiet));
                    let label = text(&format!("在 {} 里的一次相处", evidence.host), &["qz-body"]);
                    label.set_hexpand(true);
                    row.append(&label);
                    row.append(&line(&format_date_time(evidence.at_ms), &["qz-meta"]));
                    list.append(&row);
                }
                body.append(&list);
            }
        }
        let tone = if current {
            TickTone::Current
        } else if change.acknowledged {
            TickTone::Neutral
        } else {
            TickTone::Amber
        };
        timeline_item(Some(&format_date(change.at_ms)), &body, tone, false)
    }

    fn changes_section(&self, data: &SeaSelf) -> gtk::Box {
        let content: gtk::Widget = if data.changes.is_empty() {
            compact_empty(
                "changes-empty",
                "没有变化",
                "他最近没有变",
                "他的核心每变一次，这里就多一条，并写明是从哪几次相处里长出来的。",
            )
            .upcast()
        } else {
            let list = vbox(0);
            list.set_widget_name("changes");
            for change in &data.changes {
                list.append(&self.change_item(change, data));
            }
            list.upcast()
        };
        section(
            "最近的变化",
            false,
            Some("他的变化不需要你批准，但每一次都告诉你。"),
            &content,
        )
    }

    fn draw(&self, data: &SeaSelf) {
        let body = &self.frame.body;
        crate::ui::clear(body);
        let waiting = data.changes.iter().filter(|c| !c.acknowledged).count();
        self.frame
            .head
            .set_state((waiting > 0).then(|| (Tone::Amber, format!("{waiting} 处变化等你看"))));
        let empty = data.identity.is_empty()
            && data.core_values.is_empty()
            && data.temperament.is_empty()
            && data.changes.is_empty();
        if empty {
            *self.selection.borrow_mut() = None;
            empty_page(
                body,
                &self.ctx,
                &Situation {
                    kind: "self-empty",
                    tone: Tone::Quiet,
                    word: "还没有成形",
                    title: "他还没有长出自己的样子",
                    body: "核心价值和性情不是填出来的。同一件事在多次相处里反复出现，经过冷却，才会沉淀成他的一部分。",
                    steps: &[
                        Step {
                            title: "把他接进宿主",
                            text: "在终端运行 qz connect，他会住进你已经在用的工具。",
                        },
                        Step {
                            title: "照常相处",
                            text: "不用专门教他。聊过的事会被当作信号收回来。",
                        },
                        Step {
                            title: "回来看",
                            text: "他的核心每变一次，这里就多一条，并写明来处。",
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
        if !data.identity.is_empty() {
            let rows: Vec<Fact> = data
                .identity
                .iter()
                .map(|item| Fact::new(&item.label, plain_text(&item.text)))
                .collect();
            let identity = deflist(&rows);
            identity.set_widget_name("identity");
            body.append(&identity);
        }
        body.append(&self.core_section(data));
        if !data.temperament.is_empty() {
            body.append(&self.temperament_section(data));
        }
        body.append(&self.changes_section(data));
    }

    fn provenance(&self) -> Provenance {
        let data = self.data.borrow();
        let selection = self.selection.borrow().clone();
        let (Some(data), Some(selection)) = (data.as_ref(), selection) else {
            return Provenance::sentence(PageKey::SelfPage.info().sentence);
        };
        match selection {
            Selection::Value(id) => {
                let Some(value) = data.core_values.iter().find(|v| v.id == id) else {
                    return Provenance::sentence(PageKey::SelfPage.info().sentence);
                };
                let related: Vec<Event> = data
                    .changes
                    .iter()
                    .filter(|change| change.target_id == value.id)
                    .map(|change| Event {
                        at_ms: Some(change.at_ms),
                        text: change.summary.clone(),
                        amber: !change.acknowledged,
                    })
                    .collect();
                Provenance {
                    title: Some(value.statement.clone()),
                    lead: value
                        .rationale
                        .clone()
                        .unwrap_or_else(|| String::from("他没有写下为什么。")),
                    facts: vec![
                        Fact::new("层", "核心价值"),
                        Fact::new("自", format_date(value.since_ms)),
                        Fact::new("证据", format!("{} 次相处", value.evidence_count)),
                    ],
                    events: Some((String::from("它的变化"), related)),
                    ..Provenance::default()
                }
            }
            Selection::Temperament(id) => {
                let Some(item) = data.temperament.iter().find(|t| t.id == id) else {
                    return Provenance::sentence(PageKey::SelfPage.info().sentence);
                };
                Provenance {
                    title: Some(item.statement.clone()),
                    lead: String::from(
                        "性情是他说话和做事的习惯。它跟着相处慢慢变，不需要证据链。",
                    ),
                    facts: vec![
                        Fact::new("层", "性情"),
                        Fact::new("自", format_date(item.since_ms)),
                    ],
                    ..Provenance::default()
                }
            }
            Selection::Change(id) => {
                let Some(change) = data.changes.iter().find(|c| c.id == id) else {
                    return Provenance::sentence(PageKey::SelfPage.info().sentence);
                };
                let target = Self::target_statement(&change.target_id, data);
                let span = span_days(&change.evidence.iter().map(|e| e.at_ms).collect::<Vec<_>>());
                Provenance {
                    title: Some(change.summary.clone()),
                    lead: target.map_or_else(
                        || String::from("这次变化落在一条已经不在的条目上。"),
                        |target| format!("这次变化落在「{target}」上。"),
                    ),
                    facts: vec![
                        Fact::new("时间", format_date_time(change.at_ms)),
                        Fact::new(
                            "证据",
                            if change.evidence.is_empty() {
                                String::from("没有附带")
                            } else {
                                format!("{} 次相处，跨 {span} 天", change.evidence.len())
                            },
                        ),
                        Fact::new(
                            "状态",
                            if change.acknowledged {
                                "已经告诉过你"
                            } else {
                                "等你看"
                            },
                        ),
                    ],
                    events: Some((
                        String::from("长出它的相处"),
                        change
                            .evidence
                            .iter()
                            .map(|e| Event {
                                at_ms: Some(e.at_ms),
                                text: format!("在 {} 里", e.host),
                                amber: false,
                            })
                            .collect(),
                    )),
                    ..Provenance::default()
                }
            }
        }
    }
}

impl Page for SelfPage {
    fn key(&self) -> PageKey {
        PageKey::SelfPage
    }

    fn root(&self) -> gtk::Widget {
        self.frame.root.clone().upcast()
    }

    fn load(&self) {
        let weak = self.me.clone();
        let ctx = self.ctx.clone();
        self.ctx.api.self_page(move |result| {
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
        self.ctx
            .provenance_for(PageKey::SelfPage, self.provenance());
    }
}
