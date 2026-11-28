#![forbid(unsafe_code)]

//! 我们：上半是共同的承诺；下半是一根横向的刻度——左端「他自己」，右端「我们」，
//! 一个可拖动的标记当前位置，下限处有一条不可越过的线。这是全窗唯一的滑杆。

use std::cell::{Cell, RefCell};
use std::rc::{Rc, Weak};
use std::time::Duration;

use gtk::glib;
use gtk::prelude::*;
use gtk4 as gtk;
use quetzalcoatl_daemon::sea_governance::{Focus, SeaUs};

use crate::api::ApiError;
use crate::aside::Provenance;
use crate::ctx::{Ctx, Page, upgrade};
use crate::routes::PageKey;
use crate::timefmt::{ordinal, percent};
use crate::ui::{Fact, hbox, heading, line, rail, rail_head, section, vbox};

use super::{Frame, compact_empty, frame, goto_link, pickable_cell, unavailable};

/// 松手之后等多久再写给守护进程。
const COMMIT_DELAY_MS: u64 = 350;
/// 滑杆旋钮的直径；刻度的两端各让出半个旋钮。
const KNOB: f64 = 14.0;

pub struct UsPage {
    ctx: Rc<Ctx>,
    frame: Frame,
    data: RefCell<Option<SeaUs>>,
    failure: RefCell<Option<ApiError>>,
    picked: RefCell<Option<(String, usize)>>,
    focus_failure: RefCell<Option<String>>,
    recent: RefCell<Option<String>>,
    commit: RefCell<Option<glib::SourceId>>,
    /// 正在拖动的位置：重画时不要把它弹回去。
    dragging: Cell<bool>,
    me: Weak<UsPage>,
}

impl UsPage {
    pub fn build(ctx: &Rc<Ctx>) -> Rc<dyn Page> {
        Rc::new_cyclic(|me| Self {
            ctx: ctx.clone(),
            frame: frame(PageKey::Us),
            data: RefCell::new(None),
            failure: RefCell::new(None),
            picked: RefCell::new(None),
            focus_failure: RefCell::new(None),
            recent: RefCell::new(None),
            commit: RefCell::new(None),
            dragging: Cell::new(false),
            me: me.clone(),
        })
    }

    fn pick_commitment(&self, relation: &str, index: usize) {
        {
            let mut picked = self.picked.borrow_mut();
            let same = picked
                .as_ref()
                .is_some_and(|(id, at)| id == relation && *at == index);
            *picked = if same {
                None
            } else {
                Some((relation.to_owned(), index))
            };
        }
        self.render();
    }

    fn commitments_section(&self, data: &SeaUs) -> gtk::Box {
        let with_commitments: Vec<_> = data
            .relations
            .iter()
            .filter(|relation| !relation.commitments.is_empty())
            .collect();
        let content = vbox(28);
        if with_commitments.is_empty() {
            content.append(&compact_empty(
                "commitments-empty",
                "还没有",
                "你们还没有共同的承诺",
                "承诺是你们在相处里一起定下、双方都认的事。它不是你单方面的要求——那是底线；也不是他单方面的看法——那是他的核心。",
            ));
            content.append(&goto_link(&self.ctx, "先看他眼里的你", PageKey::User));
        }
        for relation in with_commitments {
            let group = vbox(0);
            group.set_widget_name(&format!("relation-{}", relation.id));
            let meta = line(
                &format!(
                    "{} 条承诺 · 信任 {}",
                    relation.commitments.len(),
                    percent(relation.trust)
                ),
                &["qz-meta"],
            );
            meta.set_hexpand(true);
            meta.set_xalign(1.0);
            group.append(&rail_head(
                &format!("和{}", relation.peer),
                &[meta.upcast()],
            ));
            let cells: Vec<gtk::Widget> = relation
                .commitments
                .iter()
                .enumerate()
                .map(|(index, commitment)| {
                    let current = self
                        .picked
                        .borrow()
                        .as_ref()
                        .is_some_and(|(id, at)| id == &relation.id && *at == index);
                    let inner = crate::ui::cell();
                    inner.append(&line(&ordinal(index), &["qz-cell-num"]));
                    inner.append(&heading(commitment, &["qz-cell-title"]));
                    let weak = self.me.clone();
                    let id = relation.id.clone();
                    pickable_cell(&inner, current, move || {
                        upgrade(&weak, |page| page.pick_commitment(&id, index));
                    })
                })
                .collect();
            let grid = rail(&cells, 2);
            grid.set_widget_name("commitments");
            group.append(&grid);
            content.append(&group);
        }
        section(
            "共同的承诺",
            false,
            Some("一起定下、双方都认的事。"),
            &content,
        )
    }

    /// 刻度：两端之间的一个标记，和一条它越不过去的线。
    fn scale_section(&self, focus: &Focus) -> gtk::Box {
        let limit = f64::from(percent(1.0 - focus.floor_self));
        let value = f64::from(percent(focus.us_weight)).min(limit);

        let readout = hbox(10);
        readout.set_widget_name("focus-readout");
        let paint = {
            let readout = readout.clone();
            move |position: f64| {
                crate::ui::clear(&readout);
                readout.append(&line(&format!("他自己 {}", 100.0 - position), &["qz-meta"]));
                readout.append(&line("·", &["qz-meta"]));
                readout.append(&line(&format!("我们 {position}"), &["qz-meta"]));
            }
        };
        paint(value);

        let track = gtk::DrawingArea::new();
        track.set_content_height(28);
        track.set_hexpand(true);
        track.set_draw_func(move |_, cr, width, height| {
            let w = f64::from(width);
            let mid = f64::from(height) / 2.0;
            let x = |p: f64| KNOB / 2.0 + (w - KNOB) * p / 100.0;
            // 底轨：0.18 白的细线；限位之外是虚线。
            cr.set_line_width(1.0);
            cr.set_source_rgba(1.0, 1.0, 1.0, 0.18);
            cr.move_to(x(0.0), mid);
            cr.line_to(x(limit), mid);
            let _ = cr.stroke();
            cr.set_dash(&[3.0, 4.0], 0.0);
            cr.set_source_rgba(1.0, 1.0, 1.0, 0.28);
            cr.move_to(x(limit), mid);
            cr.line_to(x(100.0), mid);
            let _ = cr.stroke();
            cr.set_dash(&[], 0.0);
            // 每十分之一一个刻度。
            cr.set_source_rgba(1.0, 1.0, 1.0, 0.28);
            for step in 0..=10 {
                let at = x(f64::from(step) * 10.0);
                cr.move_to(at.floor() + 0.5, mid + 6.0);
                cr.line_to(at.floor() + 0.5, mid + 10.0);
            }
            let _ = cr.stroke();
            // 越不过去的那条线：1.5px 的白色竖线。
            cr.set_source_rgba(1.0, 1.0, 1.0, 1.0);
            cr.set_line_width(1.5);
            cr.move_to(x(limit), mid - 8.0);
            cr.line_to(x(limit), mid + 8.0);
            let _ = cr.stroke();
        });

        let adjustment = gtk::Adjustment::new(value, 0.0, limit.max(1.0), 1.0, 10.0, 0.0);
        let scale = gtk::Scale::new(gtk::Orientation::Horizontal, Some(&adjustment));
        scale.add_css_class("qz-scale-input");
        scale.set_draw_value(false);
        scale.set_hexpand(true);
        scale.set_widget_name("focus-scale");
        crate::a11y::set_label(&scale, "他迎合的对象：往左是他自己，往右是我们");
        scale.set_sensitive(limit > 0.0 && self.ctx.can_write());
        scale.update_property(&[gtk::accessible::Property::ValueText(&format!(
            "他自己 {}，我们 {}",
            100.0 - value,
            value
        ))]);

        let overlay = gtk::Overlay::new();
        overlay.set_child(Some(&track));
        overlay.add_overlay(&scale);
        // 原生滑杆只覆盖允许的那一段：标记在物理上到不了线的另一边。
        track.connect_resize({
            let scale = scale.clone();
            move |_, width, _| {
                let w = f64::from(width);
                let reach = KNOB / 2.0 + (w - KNOB) * limit / 100.0 + KNOB / 2.0;
                scale.set_margin_end((w - reach).max(0.0).round() as i32);
            }
        });

        let weak = self.me.clone();
        adjustment.connect_value_changed({
            let scale = scale.clone();
            move |adjustment| {
                let position = adjustment.value().round();
                scale.update_property(&[gtk::accessible::Property::ValueText(&format!(
                    "他自己 {}，我们 {}",
                    100.0 - position,
                    position
                ))]);
                paint(position);
                upgrade(&weak, |page| page.schedule_commit(position));
            }
        });

        let ends = hbox(0);
        ends.add_css_class("qz-scale-ends");
        let left = line("他自己", &["qz-scale-ends"]);
        left.set_hexpand(true);
        let right = line("我们", &["qz-scale-ends"]);
        ends.append(&left);
        ends.append(&right);

        let legend = hbox(16);
        legend.append(&readout);
        let floor_text = if focus.floor_locked {
            format!(
                "下限：他至少留 {} 给自己 · 已锁定",
                percent(focus.floor_self)
            )
        } else {
            format!("下限：他至少留 {} 给自己", percent(focus.floor_self))
        };
        let floor = line(&floor_text, &["qz-meta"]);
        floor.set_widget_name("focus-floor");
        floor.set_hexpand(true);
        floor.set_xalign(1.0);
        legend.append(&floor);

        let scale_box = vbox(6);
        scale_box.set_widget_name("scale");
        scale_box.append(&ends);
        scale_box.append(&overlay);
        scale_box.append(&legend);
        if let Some(failure) = self.focus_failure.borrow().as_ref() {
            scale_box.append(&crate::ui::amber_hint(failure));
        }
        section(
            "他迎合谁",
            false,
            Some("往左，他更坚持自己的判断；往右，他更顺着你们的共识。竖线右边是他不会去的地方。"),
            &scale_box,
        )
    }

    fn schedule_commit(&self, position: f64) {
        self.dragging.set(true);
        if let Some(pending) = self.commit.borrow_mut().take() {
            pending.remove();
        }
        let weak = self.me.clone();
        let id = glib::timeout_add_local_once(Duration::from_millis(COMMIT_DELAY_MS), move || {
            upgrade(&weak, |page| {
                page.commit.borrow_mut().take();
                page.commit_position(position);
            });
        });
        *self.commit.borrow_mut() = Some(id);
    }

    fn commit_position(&self, position: f64) {
        self.dragging.set(false);
        let current = self
            .data
            .borrow()
            .as_ref()
            .map(|data| f64::from(percent(data.focus.us_weight)));
        if current == Some(position) {
            return;
        }
        let weak = self.me.clone();
        let ctx = self.ctx.clone();
        self.ctx
            .api
            .focus_set((100.0 - position) / 100.0, move |result| {
                ctx.note(&result);
                upgrade(&weak, |page| {
                    match result {
                        Ok(us) => {
                            *page.focus_failure.borrow_mut() = None;
                            *page.recent.borrow_mut() = Some(String::from("刚刚由你调节"));
                            let settled = percent(us.focus.us_weight);
                            page.ctx.say(&format!(
                                "已调到：他自己 {}，我们 {settled}。",
                                100 - settled
                            ));
                            *page.data.borrow_mut() = Some(us);
                        }
                        Err(error) => {
                            // 没有调成：刻度回到守护进程里实际的位置。
                            let message = format!("没有调成：{}", error.describe());
                            page.ctx.alert(&message);
                            *page.focus_failure.borrow_mut() = Some(message);
                        }
                    }
                    page.render();
                });
            });
    }

    fn draw(&self, data: &SeaUs) {
        let body = &self.frame.body;
        crate::ui::clear(body);
        body.append(&self.commitments_section(data));
        body.append(&self.scale_section(&data.focus));
    }

    fn provenance(&self) -> Provenance {
        let data = self.data.borrow();
        let Some(data) = data.as_ref() else {
            return Provenance::sentence(PageKey::Us.info().sentence);
        };
        let picked = self.picked.borrow().clone();
        let found = picked.and_then(|(id, index)| {
            let relation = data.relations.iter().find(|r| r.id == id)?;
            let commitment = relation.commitments.get(index)?;
            Some((relation, commitment))
        });
        let recent = self.recent.borrow().clone();
        let Some((relation, commitment)) = found else {
            let mut content = Provenance::sentence(PageKey::Us.info().sentence);
            content.facts = vec![
                Fact::new("他自己", percent(data.focus.self_weight).to_string()),
                Fact::new("我们", percent(data.focus.us_weight).to_string()),
                Fact::new(
                    "下限",
                    format!(
                        "{}{}",
                        percent(data.focus.floor_self),
                        if data.focus.floor_locked {
                            "，已锁定"
                        } else {
                            ""
                        }
                    ),
                ),
            ];
            content.recent = recent;
            return content;
        };
        Provenance {
            title: Some(commitment.clone()),
            lead: format!("这是他和{}之间的承诺。", relation.peer),
            facts: vec![
                Fact::new("关系", format!("和{}", relation.peer)),
                Fact::new("信任", percent(relation.trust).to_string()),
            ],
            list: Some((
                format!("他眼里的{}", relation.peer),
                relation.their_model.clone(),
            )),
            recent,
            ..Provenance::default()
        }
    }
}

impl Page for UsPage {
    fn key(&self) -> PageKey {
        PageKey::Us
    }

    fn root(&self) -> gtk::Widget {
        self.frame.root.clone().upcast()
    }

    fn load(&self) {
        if self.dragging.get() {
            return;
        }
        let weak = self.me.clone();
        let ctx = self.ctx.clone();
        self.ctx.api.us(move |result| {
            ctx.note(&result);
            upgrade(&weak, |page| match result {
                Ok(data) => {
                    *page.failure.borrow_mut() = None;
                    if !page.dragging.get() && page.data.borrow().as_ref() != Some(&data) {
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
        self.ctx.provenance_for(PageKey::Us, self.provenance());
    }
}
