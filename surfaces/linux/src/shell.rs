#![forbid(unsafe_code)]

//! 治理面的骨架：三栏——左导航、中正文、右出处；窄屏降为顶部一行导航，出处落到正文下方。
//!
//! 守护进程联系不上时，整页保留上一次的内容，导航上方出现一行琥珀状态词与下一步，
//! 所有写动作不可用。

use std::cell::{Cell, RefCell};
use std::rc::{Rc, Weak};
use std::time::Duration;

use gtk::glib;
use gtk4 as gtk;
use libadwaita as adw;
use libadwaita::prelude::*;

use quetzalcoatl_daemon::sea_governance::SeaOverview;

use crate::api::Api;
use crate::ctx::{Ctx, CtxEvent, Page};
use crate::degrade;
use crate::routes::{PAGES, PageKey};
use crate::ui::{Tone, button_outline, code_chip, hbox, state_word, text, vbox, vline};

/// 轮询间隔：当前页与总览每隔这么久向守护进程读一次，变了才重画。
const POLL_SECONDS: u32 = 5;
/// 宽屏时的出处栏宽度。
const ASIDE_WIDTH: i32 = 300;
/// 宽屏时的导航栏宽度。
const NAV_WIDTH: i32 = 208;

struct NavItem {
    key: PageKey,
    button: gtk::Button,
    signal: gtk::Label,
}

/// 治理面外壳。
pub struct Shell {
    pub ctx: Rc<Ctx>,
    /// 放进窗口的整个内容。
    pub root: gtk::Box,
    stack: gtk::Stack,
    pages: Vec<Rc<dyn Page>>,
    current: Cell<PageKey>,
    status: gtk::Revealer,
    side_nav: Vec<NavItem>,
    top_nav: Vec<NavItem>,
    side_column: gtk::Box,
    top_scroller: gtk::ScrolledWindow,
    aside_slot: gtk::ScrolledWindow,
    narrow_slot: gtk::Box,
    clamp: adw::Clamp,
    overview: RefCell<Option<SeaOverview>>,
    window: RefCell<Option<gtk::Window>>,
    me: Weak<Shell>,
}

fn nav_item(key: PageKey) -> NavItem {
    let info = key.info();
    let button = gtk::Button::new();
    button.add_css_class("qz-nav-item");
    button.set_widget_name(&format!("nav-{}", info.slug));
    let row = hbox(8);
    let label = gtk::Label::new(Some(info.label));
    label.set_xalign(0.0);
    label.set_hexpand(true);
    row.append(&label);
    let signal = gtk::Label::new(None);
    signal.add_css_class("qz-nav-signal");
    signal.set_visible(false);
    row.append(&signal);
    button.set_child(Some(&row));
    crate::a11y::set_label(&button, info.label);
    NavItem {
        key,
        button,
        signal,
    }
}

impl Shell {
    /// 建出骨架与九页（不发任何请求；`start` 才开始读）。
    #[must_use]
    pub fn new(api: Api) -> Rc<Self> {
        let root = vbox(0);
        root.add_css_class("qz-root");
        let ctx = Ctx::new(api, root.clone());

        let pages = crate::pages::build_all(&ctx);
        let stack = gtk::Stack::new();
        stack.set_hexpand(true);
        stack.set_vexpand(true);
        stack.set_transition_type(gtk::StackTransitionType::None);
        for page in &pages {
            stack.add_named(&page.root(), Some(page.key().info().slug));
        }

        // 左栏：字标 + 九个入口。
        let side_column = vbox(0);
        side_column.add_css_class("qz-app-nav");
        side_column.set_width_request(NAV_WIDTH);
        side_column.set_hexpand(false);
        let brand = gtk::Label::new(Some("Quetzalcoatl"));
        brand.add_css_class("qz-app-brand");
        brand.set_xalign(0.0);
        side_column.append(&brand);
        let list = vbox(2);
        list.add_css_class("qz-app-nav-list");
        let side_nav: Vec<NavItem> = PAGES.iter().map(|info| nav_item(info.key)).collect();
        for item in &side_nav {
            list.append(&item.button);
        }
        side_column.append(&list);

        // 窄屏的顶部导航：同样九个入口，横向滚动，不折叠成汉堡菜单。
        let top_row = hbox(0);
        let top_nav: Vec<NavItem> = PAGES.iter().map(|info| nav_item(info.key)).collect();
        for item in &top_nav {
            top_row.append(&item.button);
        }
        let top_scroller = gtk::ScrolledWindow::new();
        top_scroller.add_css_class("qz-topnav");
        top_scroller.set_policy(gtk::PolicyType::Automatic, gtk::PolicyType::Never);
        top_scroller.set_child(Some(&top_row));
        top_scroller.set_visible(false);

        // 中栏：正文；窄屏时出处栏接在正文下方。
        let narrow_slot = vbox(0);
        narrow_slot.set_visible(false);
        let content = vbox(0);
        content.append(&stack);
        content.append(&narrow_slot);
        let clamp = adw::Clamp::new();
        clamp.set_maximum_size(1040);
        clamp.set_tightening_threshold(720);
        clamp.set_margin_top(36);
        clamp.set_margin_bottom(48);
        clamp.set_margin_start(44);
        clamp.set_margin_end(44);
        clamp.set_child(Some(&content));
        let scroller = gtk::ScrolledWindow::new();
        scroller.add_css_class("qz-app-main");
        scroller.set_policy(gtk::PolicyType::Never, gtk::PolicyType::Automatic);
        scroller.set_hexpand(true);
        scroller.set_vexpand(true);
        scroller.set_child(Some(&clamp));
        let main_column = vbox(0);
        main_column.set_hexpand(true);
        main_column.append(&top_scroller);
        main_column.append(&scroller);

        // 右栏：出处。
        let aside_slot = gtk::ScrolledWindow::new();
        aside_slot.add_css_class("qz-app-aside");
        aside_slot.set_policy(gtk::PolicyType::Never, gtk::PolicyType::Automatic);
        aside_slot.set_width_request(ASIDE_WIDTH);
        aside_slot.set_hexpand(false);
        aside_slot.set_child(Some(&ctx.aside.root));

        // 导航上方的一行状态：只在守护进程联系不上时出现。
        let status = gtk::Revealer::new();
        // 收起时必须不占高度：用「滑入」并把时长设为 0（动效只改透明度与颜色，所以不真的滑）。
        status.set_transition_type(gtk::RevealerTransitionType::SlideDown);
        status.set_transition_duration(0);
        status.set_reveal_child(false);
        status.set_child(Some(&Self::status_row()));

        let body = hbox(0);
        body.set_vexpand(true);
        body.append(&side_column);
        body.append(&vline());
        body.append(&main_column);
        body.append(&aside_slot);
        root.append(&status);
        root.append(&body);

        Rc::new_cyclic(|me| Self {
            ctx,
            root,
            stack,
            pages,
            current: Cell::new(PageKey::Overview),
            status,
            side_nav,
            top_nav,
            side_column,
            top_scroller,
            aside_slot,
            narrow_slot,
            clamp,
            overview: RefCell::new(None),
            window: RefCell::new(None),
            me: me.clone(),
        })
    }

    fn status_row() -> gtk::Box {
        let row = hbox(14);
        row.set_widget_name("daemon-status");
        row.add_css_class("qz-app-status");
        row.append(&state_word(Tone::Amber, degrade::STATUS_WORD));
        let message = text(degrade::STATUS_TEXT, &["qz-status-text"]);
        message.set_max_width_chars(80);
        row.append(&message);
        row.append(&code_chip(degrade::NEXT_STEP_COMMAND));
        let retry = button_outline("重试", true);
        retry.set_widget_name("daemon-retry");
        row.append(&retry);
        row
    }

    /// 接上事件、导航与轮询，并读第一屏。
    pub fn start(self: &Rc<Self>) {
        let weak = Rc::downgrade(self);
        self.ctx.set_handler(move |event| {
            if let Some(shell) = weak.upgrade() {
                shell.handle(event);
            }
        });
        for item in self.side_nav.iter().chain(self.top_nav.iter()) {
            let key = item.key;
            let weak = self.me.clone();
            item.button.connect_clicked(move |_| {
                if let Some(shell) = weak.upgrade() {
                    shell.navigate(key);
                }
            });
        }
        if let Some(retry) = self.find_retry() {
            let weak = self.me.clone();
            retry.connect_clicked(move |_| {
                if let Some(shell) = weak.upgrade() {
                    shell.reload();
                }
            });
        }
        self.navigate(PageKey::Overview);
        self.load_overview();
        let weak = self.me.clone();
        glib::timeout_add_local(Duration::from_secs(u64::from(POLL_SECONDS)), move || {
            let Some(shell) = weak.upgrade() else {
                return glib::ControlFlow::Break;
            };
            shell.reload();
            glib::ControlFlow::Continue
        });
    }

    fn find_retry(&self) -> Option<gtk::Button> {
        let mut found = None;
        let mut stack = vec![self.status.clone().upcast::<gtk::Widget>()];
        while let Some(widget) = stack.pop() {
            if widget.widget_name() == "daemon-retry" {
                found = widget.downcast::<gtk::Button>().ok();
                break;
            }
            let mut child = widget.first_child();
            while let Some(node) = child {
                child = node.next_sibling();
                stack.push(node);
            }
        }
        found
    }

    /// 绑定主窗口（用来写窗口标题）。
    pub fn attach_window(&self, window: &gtk::Window) {
        *self.window.borrow_mut() = Some(window.clone());
        self.update_title();
    }

    fn update_title(&self) {
        if let Some(window) = self.window.borrow().as_ref() {
            window.set_title(Some(&format!(
                "Quetzalcoatl · {}",
                self.current.get().info().label
            )));
        }
    }

    /// 当前页。
    #[must_use]
    pub fn current(&self) -> PageKey {
        self.current.get()
    }

    /// 按键取页。
    #[must_use]
    pub fn page(&self, key: PageKey) -> Option<&Rc<dyn Page>> {
        self.pages.iter().find(|page| page.key() == key)
    }

    /// 切到一页：读最新的，并把它的出处写进出处栏。
    pub fn navigate(&self, key: PageKey) {
        self.current.set(key);
        self.ctx.set_current(key);
        self.stack.set_visible_child_name(key.info().slug);
        for item in self.side_nav.iter().chain(self.top_nav.iter()) {
            if item.key == key {
                item.button.add_css_class("is-current");
                item.button
                    .update_state(&[gtk::accessible::State::Selected(Some(true))]);
            } else {
                item.button.remove_css_class("is-current");
                item.button
                    .update_state(&[gtk::accessible::State::Selected(Some(false))]);
            }
        }
        self.update_title();
        if let Some(page) = self.page(key) {
            page.show_provenance();
            page.load();
        }
    }

    /// 重读当前页与总览（轮询、重试与写入之后）。
    pub fn reload(&self) {
        if let Some(page) = self.page(self.current.get()) {
            page.load();
        }
        self.load_overview();
    }

    fn load_overview(&self) {
        let weak = self.me.clone();
        let ctx = self.ctx.clone();
        self.ctx.api.overview(move |result| {
            ctx.note(&result);
            if let (Some(shell), Ok(overview)) = (weak.upgrade(), result) {
                shell.apply_signals(overview);
            }
        });
    }

    /// 导航上的信号点：只表示「这一页有事在等你」，必须带文字。
    fn apply_signals(&self, overview: SeaOverview) {
        let waiting_self = overview.pending.disclosures;
        let unsigned = !overview.baseline.signed;
        for item in self.side_nav.iter().chain(self.top_nav.iter()) {
            let (count, word) = match item.key {
                PageKey::SelfPage if waiting_self > 0 => (
                    Some(format!("● {waiting_self}")),
                    format!("{waiting_self} 处变化等你看"),
                ),
                PageKey::Baseline if unsigned => {
                    (Some(String::from("● 待签")), String::from("待签署"))
                }
                _ => (None, String::new()),
            };
            match count {
                Some(mark) => {
                    item.signal.set_label(&mark);
                    item.signal.set_visible(true);
                    crate::a11y::set_label(
                        &item.button,
                        &format!("{}，{word}", item.key.info().label),
                    );
                }
                None => {
                    item.signal.set_visible(false);
                    crate::a11y::set_label(&item.button, item.key.info().label);
                }
            }
        }
        *self.overview.borrow_mut() = Some(overview);
    }

    fn handle(&self, event: CtxEvent) {
        match event {
            CtxEvent::OnlineChanged => {
                self.status.set_reveal_child(!self.ctx.online());
                // 写动作按在线状态重新定可用性：用已有的数据重画。
                for page in &self.pages {
                    page.render();
                }
            }
            CtxEvent::NarrowChanged => {
                self.apply_layout();
                for page in &self.pages {
                    page.render();
                }
                if let Some(page) = self.page(self.current.get()) {
                    page.show_provenance();
                }
            }
            CtxEvent::OverviewDirty => {
                self.load_overview();
                if self.current.get() != PageKey::Overview
                    && let Some(page) = self.page(PageKey::Overview)
                {
                    page.load();
                }
            }
            CtxEvent::Goto(key, param) => {
                self.navigate(key);
                if let (Some(param), Some(page)) = (param, self.page(key)) {
                    page.focus_entry(&param);
                }
            }
        }
    }

    /// 窄屏：导航收成顶部一行，出处落到正文下方；宽屏反之。
    pub fn set_narrow(&self, narrow: bool) {
        self.ctx.set_narrow(narrow);
    }

    fn apply_layout(&self) {
        let narrow = self.ctx.narrow();
        self.side_column.set_visible(!narrow);
        self.top_scroller.set_visible(narrow);
        self.aside_slot.set_visible(!narrow);
        self.narrow_slot.set_visible(narrow);
        let aside = &self.ctx.aside.root;
        if narrow {
            self.aside_slot.set_child(None::<&gtk::Widget>);
            if aside.parent().is_none() {
                self.narrow_slot.append(aside);
            }
            aside.add_css_class("is-following");
            aside.set_margin_start(0);
            aside.set_margin_end(0);
        } else {
            aside.set_margin_start(24);
            aside.set_margin_end(24);
            if aside.parent().is_some() {
                self.narrow_slot.remove(aside);
            }
            aside.remove_css_class("is-following");
            self.aside_slot.set_child(Some(aside));
        }
        let gutter = if narrow { 16 } else { 44 };
        self.clamp.set_margin_start(gutter);
        self.clamp.set_margin_end(gutter);
        self.clamp.set_margin_top(if narrow { 24 } else { 36 });
    }
}
