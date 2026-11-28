#![forbid(unsafe_code)]

//! 设备：这台设备在最上；其余设备按最近在线排序；吊销是一个需要口令、且再确认一次的动作。

use std::cell::RefCell;
use std::rc::{Rc, Weak};

use gtk::prelude::*;
use gtk4 as gtk;
use quetzalcoatl_daemon::sea_governance::{Device, DevicesView};

use crate::api::ApiError;
use crate::aside::Provenance;
use crate::ctx::{Ctx, Page, upgrade};
use crate::dialog::{ConfirmSpec, Finish, confirm};
use crate::routes::PageKey;
use crate::timefmt::{format_ago, format_date, format_date_time, hub_host};
use crate::ui::{
    Fact, Tone, button_outline, cell, command_block, hbox, heading, line, pick, rail, section,
    state_word, text, vbox,
};

use super::{Frame, compact_empty, frame, pickable_cell, unavailable};

pub struct DevicesPage {
    ctx: Rc<Ctx>,
    frame: Frame,
    data: RefCell<Option<DevicesView>>,
    failure: RefCell<Option<ApiError>>,
    selected: RefCell<Option<String>>,
    recent: RefCell<Option<String>>,
    me: Weak<DevicesPage>,
}

impl DevicesPage {
    pub fn build(ctx: &Rc<Ctx>) -> Rc<dyn Page> {
        Rc::new_cyclic(|me| Self {
            ctx: ctx.clone(),
            frame: frame(PageKey::Devices),
            data: RefCell::new(None),
            failure: RefCell::new(None),
            selected: RefCell::new(None),
            recent: RefCell::new(None),
            me: me.clone(),
        })
    }

    /// 其余设备：不含这一台，最近在线的在前，从没在线过的在最后。
    fn others(data: &DevicesView) -> Vec<Device> {
        let mut others: Vec<Device> = data
            .devices
            .iter()
            .filter(|device| device.id != data.this_device.id)
            .cloned()
            .collect();
        others.sort_by_key(|device| std::cmp::Reverse(device.last_seen_ms));
        others
    }

    fn select(&self, id: &str) {
        *self.recent.borrow_mut() = None;
        {
            let mut selected = self.selected.borrow_mut();
            *selected = if selected.as_deref() == Some(id) {
                None
            } else {
                Some(id.to_owned())
            };
        }
        self.render();
    }

    fn row(&self, device: &Device, now: u64) -> gtk::Box {
        let current = self.selected.borrow().as_deref() == Some(device.id.as_str());
        let row = hbox(0);
        row.add_css_class("qz-row");
        row.set_widget_name(&format!("device-row-{}", device.id));
        let content = vbox(6);
        content.add_css_class("qz-row-pad");
        content.append(&text(&device.name, &["qz-row-text"]));
        let meta = hbox(14);
        meta.append(&line(
            &device.last_seen_ms.map_or_else(
                || String::from("从没在线过"),
                |seen| format!("最近在线 {}", format_ago(seen, now)),
            ),
            &["qz-meta"],
        ));
        meta.append(&line(
            &format!("{} 加入", format_date(device.added_ms)),
            &["qz-meta"],
        ));
        if device.holds_control {
            meta.append(&state_word(Tone::Quiet, "可以管理别的设备"));
        }
        content.append(&meta);
        let button = pick(&content, current, true);
        let weak = self.me.clone();
        let id = device.id.clone();
        button.connect_clicked(move |_| upgrade(&weak, |page| page.select(&id)));
        row.append(&button);
        let revoke = button_outline("吊销", true);
        revoke.set_widget_name("device-revoke");
        revoke.set_valign(gtk::Align::Center);
        revoke.add_css_class("qz-row-action");
        crate::a11y::set_label(&revoke, &format!("吊销「{}」", device.name));
        let weak = self.me.clone();
        let target = device.clone();
        revoke.connect_clicked(move |_| upgrade(&weak, |page| page.revoke(&target)));
        row.append(&self.ctx.guard(revoke));
        row
    }

    fn revoke(&self, device: &Device) {
        let weak = self.me.clone();
        let ctx = self.ctx.clone();
        let id = device.id.clone();
        let name = device.name.clone();
        confirm(
            self.ctx.anchor(),
            ConfirmSpec {
                title: format!("吊销「{}」？", device.name),
                word: String::from("不可撤回"),
                quote: None,
                paragraphs: vec![
                    String::from(
                        "这台设备会立刻失去读取和同步他的资格，已经同步过去的内容在它下次联网时作废。",
                    ),
                    String::from("吊销之后不能撤回。要再用它，得重新配对。"),
                ],
                confirm_label: String::from("吊销"),
                passphrase: Some((
                    String::from("口令"),
                    String::from("第一次签署底线时设定的那个口令。"),
                )),
            },
            Rc::new(move |secret, finish: Finish| {
                let weak = weak.clone();
                let ctx = ctx.clone();
                let done_ctx = ctx.clone();
                let name = name.clone();
                let id = id.clone();
                let revoked_id = id.clone();
                ctx.api.device_revoke(id, secret, move |result| {
                    done_ctx.note(&result);
                    match result {
                        Ok(view) => {
                            finish(Ok(()));
                            upgrade(&weak, |page| {
                                if page.selected.borrow().as_deref() == Some(revoked_id.as_str()) {
                                    *page.selected.borrow_mut() = None;
                                }
                                *page.recent.borrow_mut() = Some(String::from("刚刚由你吊销"));
                                *page.data.borrow_mut() = Some(view);
                                page.ctx.say(&format!("已吊销「{name}」。"));
                                page.ctx.overview_changed();
                                page.render();
                            });
                        }
                        Err(error) => {
                            let reason = match error.code() {
                                Some("PASSPHRASE_MISMATCH") => String::from("口令不对。"),
                                Some("PASSPHRASE_NOT_SET") => String::from(
                                    "还没有设过口令：先在底线页签署一次，口令即被设定。",
                                ),
                                _ => format!("没有吊销：{}", error.describe()),
                            };
                            finish(Err(reason));
                        }
                    }
                });
            }),
        );
    }

    fn draw(&self, data: &DevicesView) {
        let body = &self.frame.body;
        crate::ui::clear(body);
        let now = self.ctx.now();
        let others = Self::others(data);
        let hub = &data.hub;
        self.frame
            .head
            .set_state(Some(match (&hub.url, hub.connected) {
                (None, _) => (Tone::Quiet, String::from("仅本机")),
                (Some(_), true) => (Tone::Ice, String::from("已同步")),
                (Some(_), false) => (Tone::Amber, String::from("同步不通")),
            }));

        // 这台设备 + 同步：两格。
        let this_current = self.selected.borrow().as_deref() == Some(data.this_device.id.as_str());
        let this_cell = cell();
        let head = hbox(8);
        let title = heading("这台设备", &["qz-cell-title"]);
        title.set_hexpand(true);
        head.append(&title);
        head.append(&state_word(Tone::Quiet, "正在用"));
        this_cell.append(&head);
        this_cell.append(&text(&data.this_device.name, &["qz-body"]));
        this_cell.append(&line(
            &format!("{} 加入", format_date(data.this_device.added_ms)),
            &["qz-meta"],
        ));
        let weak = self.me.clone();
        let this_id = data.this_device.id.clone();
        let this_widget = pickable_cell(&this_cell, this_current, move || {
            upgrade(&weak, |page| page.select(&this_id));
        });
        this_widget.set_widget_name("this-device");

        let hub_cell = cell();
        let head = hbox(8);
        let title = heading("同步", &["qz-cell-title"]);
        title.set_hexpand(true);
        head.append(&title);
        head.append(&match (&hub.url, hub.connected) {
            (None, _) => state_word(Tone::Quiet, "没有接"),
            (Some(_), true) => state_word(Tone::Ice, "连着"),
            (Some(_), false) => state_word(Tone::Amber, "连不上"),
        });
        hub_cell.append(&head);
        hub_cell.append(&text(
            match (&hub.url, hub.connected) {
                (None, _) => "没有接同步，他只在这台设备上。设备丢了，他也就丢了。",
                (Some(_), true) => "各台设备经它互相找到对方。它只转发密文，读不到内容。",
                (Some(_), false) => {
                    "连不上同步服务。这台设备上的改动会先留在本机，连上之后再对账。"
                }
            },
            &["qz-body"],
        ));
        if let Some(url) = &hub.url {
            hub_cell.append(&line(&hub_host(url), &["qz-meta"]));
        }
        let grid = rail(&[this_widget, hub_cell.upcast()], 2);
        grid.set_widget_name("this-device-rail");
        body.append(&grid);

        let content = vbox(14);
        if others.is_empty() {
            content.append(&compact_empty(
                "devices-only-this",
                "只有这一台",
                "他只在这台设备上",
                "再加一台设备，他会跟着你走：两边是同一个他，不需要重新介绍。配对时两台设备都要在你手上。",
            ));
            content.append(&command_block(
                "在这台设备的终端开始配对：",
                "qz pair start",
            ));
        } else {
            let list = vbox(0);
            list.add_css_class("qz-list");
            list.set_widget_name("other-devices");
            for device in &others {
                list.append(&self.row(device, now));
            }
            content.append(&list);
        }
        body.append(&section(
            "其余设备",
            false,
            Some(&if others.is_empty() {
                String::from("没有")
            } else {
                format!("{} 台 · 最近在线的在前", others.len())
            }),
            &content,
        ));
    }

    fn provenance(&self) -> Provenance {
        let data = self.data.borrow();
        let Some(data) = data.as_ref() else {
            return Provenance::sentence(PageKey::Devices.info().sentence);
        };
        let now = self.ctx.now();
        let recent = self.recent.borrow().clone();
        let selected = self.selected.borrow().clone();
        if selected.as_deref() == Some(data.this_device.id.as_str()) {
            return Provenance {
                title: Some(data.this_device.name.clone()),
                lead: String::from(
                    "你正在用的这一台。它不能在这里吊销自己；要让它退出，在另一台设备上吊销它。",
                ),
                facts: vec![
                    Fact::new("加入", format_date_time(data.this_device.added_ms)),
                    Fact::mono("标识", data.this_device.id.clone()),
                ],
                recent,
                ..Provenance::default()
            };
        }
        let device = selected.and_then(|id| data.devices.iter().find(|d| d.id == id));
        let Some(device) = device else {
            let mut content = Provenance::sentence(PageKey::Devices.info().sentence);
            content.facts = vec![
                Fact::new("设备", format!("{} 台", Self::others(data).len() + 1)),
                Fact::new(
                    "同步",
                    match (&data.hub.url, data.hub.connected) {
                        (None, _) => "没有接",
                        (Some(_), true) => "连着",
                        (Some(_), false) => "连不上",
                    },
                ),
            ];
            content.recent = recent;
            return content;
        };
        Provenance {
            title: Some(device.name.clone()),
            lead: if device.holds_control {
                String::from("这台设备可以管理别的设备：批准配对，也可以吊销。")
            } else {
                String::from("这台设备可以读取和同步他，但不能管理别的设备。")
            },
            facts: vec![
                Fact::new("加入", format_date_time(device.added_ms)),
                Fact::new(
                    "在线",
                    device.last_seen_ms.map_or_else(
                        || String::from("从没在线过"),
                        |seen| format!("{}（{}）", format_date_time(seen), format_ago(seen, now)),
                    ),
                ),
                Fact::mono("标识", device.id.clone()),
            ],
            recent,
            ..Provenance::default()
        }
    }
}

impl Page for DevicesPage {
    fn key(&self) -> PageKey {
        PageKey::Devices
    }

    fn root(&self) -> gtk::Widget {
        self.frame.root.clone().upcast()
    }

    fn load(&self) {
        let weak = self.me.clone();
        let ctx = self.ctx.clone();
        self.ctx.api.devices(move |result| {
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
        self.ctx.provenance_for(PageKey::Devices, self.provenance());
    }
}
