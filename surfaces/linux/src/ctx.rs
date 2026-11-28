#![forbid(unsafe_code)]

//! 各页共用的上下文：守护进程入口、在线状态、窗口宽窄、出处栏，以及页的统一形状。

use std::cell::{Cell, RefCell};
use std::rc::{Rc, Weak};

use gtk::prelude::*;
use gtk4 as gtk;

use crate::api::{Api, ApiError};
use crate::aside::{Aside, Provenance};
use crate::routes::PageKey;
use crate::timefmt::now_ms;

/// 上下文向外壳报告的事件。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CtxEvent {
    /// 联系得上、联系不上之间切换了。
    OnlineChanged,
    /// 窗口在宽窄两种版面之间切换了。
    NarrowChanged,
    /// 一次写入改了总览里的数字：总览与导航上的信号需要重读。
    OverviewDirty,
    /// 请求跳到另一页（可带这一页里的条目编号）。
    Goto(PageKey, Option<String>),
}

type Handler = Rc<dyn Fn(CtxEvent)>;

/// 各页共用的上下文。
pub struct Ctx {
    pub api: Api,
    pub aside: Aside,
    anchor: gtk::Box,
    online: Cell<bool>,
    /// 是否至少成功联系过一次（还没联系上过与联系中断是两种状态）。
    ever_online: Cell<bool>,
    /// 至少有一次调用有了结果（成功或确认联系不上）。
    answered: Cell<bool>,
    narrow: Cell<bool>,
    current: Cell<PageKey>,
    handler: RefCell<Option<Handler>>,
}

impl Ctx {
    #[must_use]
    pub fn new(api: Api, anchor: gtk::Box) -> Rc<Self> {
        Rc::new(Self {
            api,
            aside: Aside::new(),
            anchor,
            online: Cell::new(true),
            ever_online: Cell::new(false),
            answered: Cell::new(false),
            narrow: Cell::new(false),
            current: Cell::new(PageKey::Overview),
            handler: RefCell::new(None),
        })
    }

    /// 外壳接上事件处理。
    pub fn set_handler(&self, handler: impl Fn(CtxEvent) + 'static) {
        *self.handler.borrow_mut() = Some(Rc::new(handler));
    }

    fn emit(&self, event: CtxEvent) {
        let handler = self.handler.borrow().clone();
        if let Some(handler) = handler {
            handler(event);
        }
    }

    /// 窗口里的任意控件：对话框与读屏播报以它为锚。
    #[must_use]
    pub fn anchor(&self) -> &gtk::Box {
        &self.anchor
    }

    /// 此刻（毫秒时间戳）。
    #[must_use]
    pub fn now(&self) -> u64 {
        now_ms()
    }

    /// 守护进程此刻联系得上吗。
    #[must_use]
    pub fn online(&self) -> bool {
        self.online.get()
    }

    /// 是否曾经联系上过。
    #[must_use]
    pub fn ever_online(&self) -> bool {
        self.ever_online.get()
    }

    /// 是否已经有过第一次结果。
    #[must_use]
    pub fn answered(&self) -> bool {
        self.answered.get()
    }

    /// 写操作可不可用：联系不上时一律不可用。
    #[must_use]
    pub fn can_write(&self) -> bool {
        self.online.get()
    }

    /// 当前是不是窄屏版面。
    #[must_use]
    pub fn narrow(&self) -> bool {
        self.narrow.get()
    }

    /// 外壳在窗口宽窄变化时调用。
    pub fn set_narrow(&self, narrow: bool) {
        if self.narrow.replace(narrow) != narrow {
            self.emit(CtxEvent::NarrowChanged);
        }
    }

    /// 每一次调用的结果都经这里：联系不上就整个界面进入降级。
    pub fn note<T>(&self, result: &Result<T, ApiError>) {
        self.answered.set(true);
        let reachable = match result {
            Ok(_) => true,
            Err(error) => !error.is_unreachable(),
        };
        if reachable {
            self.ever_online.set(true);
        }
        if self.online.replace(reachable) != reachable {
            self.emit(CtxEvent::OnlineChanged);
        }
    }

    /// 总览里的数字变了（抹除、签署、吊销之后）。
    pub fn overview_changed(&self) {
        self.emit(CtxEvent::OverviewDirty);
    }

    /// 跳到另一页。
    pub fn goto(&self, key: PageKey, param: Option<String>) {
        self.emit(CtxEvent::Goto(key, param));
    }

    /// 读屏播报一句话（写操作成功时）。
    pub fn say(&self, message: &str) {
        self.anchor
            .announce(message, gtk::AccessibleAnnouncementPriority::Medium);
    }

    /// 读屏播报一句出错的话。
    pub fn alert(&self, message: &str) {
        self.anchor
            .announce(message, gtk::AccessibleAnnouncementPriority::High);
    }

    /// 外壳切页时登记当前页。
    pub fn set_current(&self, key: PageKey) {
        self.current.set(key);
    }

    /// 当前页。
    #[must_use]
    pub fn current(&self) -> PageKey {
        self.current.get()
    }

    /// 出处栏显示一条来历（无条件）。
    pub fn provenance(&self, content: Provenance) {
        self.aside.show(&content);
    }

    /// 只有 `key` 这一页正是当前页时才改出处栏：后台轮询读到新数据时不抢别的页的出处栏。
    pub fn provenance_for(&self, key: PageKey, content: Provenance) {
        if self.current.get() == key {
            self.aside.show(&content);
        }
    }

    /// 给一个写动作的控件按在线状态定可用性。
    pub fn guard<W: IsA<gtk::Widget>>(&self, widget: W) -> W {
        widget.set_sensitive(self.can_write());
        widget
    }
}

/// 九页的统一形状。
pub trait Page {
    fn key(&self) -> PageKey;
    fn root(&self) -> gtk::Widget;
    /// 进入、轮询与「重试」时调用：读最新的，变了才重画。
    fn load(&self);
    /// 在线状态或窗口宽窄变了：用已有的数据重画。
    fn render(&self);
    /// 把这一页当前的出处写进出处栏。
    fn show_provenance(&self);
    /// 跳转时带来的条目编号（例如记录里「在往事里看它」）。
    fn focus_entry(&self, _id: &str) {}
}

/// 页内持有自己的弱引用，闭包里升级它来回调自己。
pub fn upgrade<T>(weak: &Weak<T>, run: impl FnOnce(Rc<T>)) {
    if let Some(strong) = weak.upgrade() {
        run(strong);
    }
}
