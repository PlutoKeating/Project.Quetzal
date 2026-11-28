#![forbid(unsafe_code)]

//! 宿主：每个宿主一行发丝线栅格，四格对应四项——送核心、送往事、收信号、压缩后不丢。
//! 通的是冰蓝圆点加一句话，不通的是琥珀圆点加下一步怎么做。

use std::cell::RefCell;
use std::rc::{Rc, Weak};

use gtk::prelude::*;
use gtk4 as gtk;
use quetzalcoatl_daemon::sea_governance::{HostCheck, HostView, HostsView};

use crate::api::ApiError;
use crate::aside::Provenance;
use crate::ctx::{Ctx, Page, upgrade};
use crate::routes::PageKey;
use crate::ui::{
    Fact, Situation, Step, Tone, cell, code_chip, command_block, hbox, heading, line, rail,
    rail_head, section, state_word, text, vbox,
};

use super::{Frame, empty_page, frame, pickable_cell, unavailable};

struct CheckInfo {
    key: &'static str,
    label: &'static str,
    /// 这一项查的是什么。
    meaning: &'static str,
}

/// 四项的顺序固定：先送进去，再收回来，最后看压缩之后还在不在。
const CHECKS: [CheckInfo; 4] = [
    CheckInfo {
        key: "core",
        label: "送核心",
        meaning: "每次模型调用之前，把他的核心和你的底线送进去。",
    },
    CheckInfo {
        key: "recall",
        label: "送往事",
        meaning: "把和眼前这件事相关的往事送进去。",
    },
    CheckInfo {
        key: "signal",
        label: "收信号",
        meaning: "调用之后，把这一轮的输出当作信号收回来。",
    },
    CheckInfo {
        key: "compaction",
        label: "压缩后不丢",
        meaning: "宿主压缩上下文之后，他的核心和往事仍然在。",
    },
];

pub struct HostsPage {
    ctx: Rc<Ctx>,
    frame: Frame,
    data: RefCell<Option<HostsView>>,
    failure: RefCell<Option<ApiError>>,
    picked: RefCell<Option<(String, &'static str)>>,
    me: Weak<HostsPage>,
}

impl HostsPage {
    pub fn build(ctx: &Rc<Ctx>) -> Rc<dyn Page> {
        Rc::new_cyclic(|me| Self {
            ctx: ctx.clone(),
            frame: frame(PageKey::Hosts),
            data: RefCell::new(None),
            failure: RefCell::new(None),
            picked: RefCell::new(None),
            me: me.clone(),
        })
    }

    fn result_of<'a>(host: &'a HostView, key: &str) -> Option<&'a HostCheck> {
        host.checks.iter().find(|check| check.key == key)
    }

    fn pick(&self, host: &str, key: &'static str) {
        {
            let mut picked = self.picked.borrow_mut();
            let same = picked.as_ref().is_some_and(|(h, k)| h == host && *k == key);
            *picked = if same {
                None
            } else {
                Some((host.to_owned(), key))
            };
        }
        self.render();
    }

    fn check_cell(&self, host: &HostView, info: &CheckInfo) -> gtk::Widget {
        let current = self
            .picked
            .borrow()
            .as_ref()
            .is_some_and(|(h, k)| h == &host.host && *k == info.key);
        let result = Self::result_of(host, info.key);
        let (state, sentence) = match result {
            None => (
                state_word(Tone::Quiet, "没有检查"),
                String::from("守护进程没有报告这一项。"),
            ),
            Some(check) if check.ok => (state_word(Tone::Ice, "通"), check.detail.clone()),
            Some(check) => (state_word(Tone::Amber, "不通"), check.detail.clone()),
        };
        let inner = cell();
        let head = hbox(8);
        let title = heading(info.label, &["qz-cell-title"]);
        title.set_hexpand(true);
        head.append(&title);
        head.append(&state);
        inner.append(&head);
        inner.append(&text(&sentence, &["qz-body"]));
        let weak = self.me.clone();
        let host_id = host.host.clone();
        let key = info.key;
        let widget = pickable_cell(&inner, current, move || {
            upgrade(&weak, |page| page.pick(&host_id, key));
        });
        widget.set_widget_name(&format!("check-{}-{}", host.host, info.key));
        widget
    }

    fn host_group(&self, host: &HostView) -> gtk::Box {
        let group = vbox(0);
        group.set_widget_name(&format!("host-{}", host.host));
        group.set_margin_bottom(32);
        let state = if !host.installed {
            state_word(Tone::Quiet, "未安装")
        } else if host.connected {
            state_word(Tone::Ice, "已接上")
        } else {
            state_word(Tone::Amber, "未接上")
        };
        let mut trailing: Vec<gtk::Widget> = vec![state.upcast()];
        if let Some(version) = &host.version {
            trailing.push(line(version, &["qz-meta"]).upcast());
        }
        group.append(&rail_head(&host.name, &trailing));
        // 没接上时四项都不通、原因相同：只说一句该做什么，不铺四格一样的「不通」。
        if host.connected {
            let cells: Vec<gtk::Widget> = CHECKS
                .iter()
                .map(|info| self.check_cell(host, info))
                .collect();
            let grid = rail(&cells, 4);
            grid.set_widget_name("host-checks");
            group.append(&grid);
        } else {
            let note = hbox(6);
            note.set_widget_name(if host.installed {
                "host-not-connected"
            } else {
                "host-not-installed"
            });
            note.append(&text(
                if host.installed {
                    "装了，还没接上。在终端运行"
                } else {
                    "这台设备上没有装它。装上之后在终端运行"
                },
                &["qz-section-note"],
            ));
            note.append(&code_chip("qz connect"));
            note.append(&text("，四项检查会列在这里。", &["qz-section-note"]));
            group.append(&note);
        }
        group
    }

    fn failing(data: &HostsView) -> usize {
        data.hosts
            .iter()
            .filter(|host| host.connected)
            .map(|host| host.checks.iter().filter(|check| !check.ok).count())
            .sum()
    }

    fn draw(&self, data: &HostsView) {
        let body = &self.frame.body;
        crate::ui::clear(body);
        if data.hosts.is_empty() {
            self.frame
                .head
                .set_state(Some((Tone::Amber, String::from("还没有接上"))));
            *self.picked.borrow_mut() = None;
            empty_page(
                body,
                &self.ctx,
                &Situation {
                    kind: "hosts-empty",
                    tone: Tone::Amber,
                    word: "还没有接上",
                    title: "他还没有住进任何宿主",
                    body: "宿主是你已经在用的工具。对话和推理都发生在那里；他只是在每次模型调用之前被送进去，调用之后把信号收回来。",
                    steps: &[
                        Step {
                            title: "装一个宿主",
                            text: "Claude Code、Codex、OpenCode 都可以。已经在用的那个最好。",
                        },
                        Step {
                            title: "把他接进去",
                            text: "在终端运行 qz connect。",
                        },
                        Step {
                            title: "回来看四项",
                            text: "每个宿主会在这里列出四项检查，逐项写明通不通。",
                        },
                    ],
                    command: Some(("在终端把他接进本机的宿主：", "qz connect")),
                    facts: Vec::new(),
                    compact: false,
                },
                None,
            );
            return;
        }
        let failing = Self::failing(data);
        self.frame.head.set_state(Some(if failing == 0 {
            (Tone::Ice, String::from("每一步都通"))
        } else {
            (Tone::Amber, format!("{failing} 步不通"))
        }));
        for host in &data.hosts {
            body.append(&self.host_group(host));
        }
        let doctor = command_block("逐个宿主查这四项：", "qz doctor");
        body.append(&section(
            "重新体检",
            true,
            Some("改过宿主的配置之后，在终端再查一遍。"),
            &doctor,
        ));
    }

    fn provenance(&self) -> Provenance {
        let data = self.data.borrow();
        let picked = self.picked.borrow().clone();
        let found = data.as_ref().and_then(|data| {
            let (host_id, key) = picked?;
            let host = data.hosts.iter().find(|h| h.host == host_id)?;
            let info = CHECKS.iter().find(|c| c.key == key)?;
            Some((host, info))
        });
        let Some((host, info)) = found else {
            return Provenance::sentence(PageKey::Hosts.info().sentence);
        };
        let result = Self::result_of(host, info.key);
        let outcome = match result {
            None => "没有检查",
            Some(check) if check.ok => "通",
            Some(_) => "不通",
        };
        Provenance {
            title: Some(format!("{} · {}", host.name, info.label)),
            lead: info.meaning.to_owned(),
            facts: vec![
                Fact::new("结果", outcome),
                Fact::new("宿主", host.name.clone()),
                Fact::mono(
                    "版本",
                    host.version.clone().unwrap_or_else(|| String::from("未知")),
                ),
                Fact::new("接上", if host.connected { "是" } else { "否" }),
            ],
            list: result.map(|check| {
                (
                    String::from(if check.ok {
                        "守护进程报告"
                    } else {
                        "下一步"
                    }),
                    vec![check.detail.clone()],
                )
            }),
            ..Provenance::default()
        }
    }
}

impl Page for HostsPage {
    fn key(&self) -> PageKey {
        PageKey::Hosts
    }

    fn root(&self) -> gtk::Widget {
        self.frame.root.clone().upcast()
    }

    fn load(&self) {
        let weak = self.me.clone();
        let ctx = self.ctx.clone();
        self.ctx.api.hosts(move |result| {
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
        self.ctx.provenance_for(PageKey::Hosts, self.provenance());
    }
}
