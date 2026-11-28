#![forbid(unsafe_code)]

//! 桌面应用外壳：GTK4 `Application`、治理面窗口、快捷动作、托盘驻留与自检。
//!
//! 关键不变量：
//! * 治理面**只「看」和「签」**：没有任何给他发一句话的输入框，也不发起任何对话请求
//!   （000 号铁律：对话永远发生在别人的宿主里）；
//! * 本进程只经本机认证 IPC 调用守护进程的 `sea_*` 方法，守护进程不可达时整页保留上一次的内容、
//!   顶部一行琥珀色状态词与下一步，绝不回退直连 `spine.sqlite`（防坑规范 #13）；
//! * 写动作（改、不主动提、抹除、签署、吊销、迎合滑杆）都由本人亲手触发，守护进程联系不上时一律不可用。

use std::cell::RefCell;
use std::io;
use std::path::PathBuf;
use std::rc::{Rc, Weak};
use std::sync::mpsc::{self, TryRecvError};
use std::time::{Duration, Instant};

use gtk::gio::prelude::ApplicationExtManual;
use gtk::glib;
use gtk4 as gtk;
use libadwaita as adw;
use libadwaita::prelude::*;

use crate::api::Api;
use crate::config::DesktopConfig;
use crate::routes::{PAGES, PageKey};
use crate::shell::Shell;
use crate::tray::{self, TrayCallbacks, TrayHandle, TrayStatus};

/// 应用 ID（与 `.desktop` 文件的 `StartupWMClass` 一致）。
pub const APPLICATION_ID: &str = "org.quetzalcoatl.Desktop";

/// 窄屏版面的断点：窗口宽度不超过它时，导航收成顶部一行、出处落到正文下方。
pub const NARROW_BREAKPOINT: &str = "max-width: 900sp";

/// 启动参数。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DesktopOptions {
    /// Quetzalcoatl 家目录（`QUETZALCOATL_HOME` 或 `--home`）。
    pub home: PathBuf,
    /// 配置文件路径（`None` 时按 XDG 规则推导）。
    pub config_path: Option<PathBuf>,
    /// 无头自检模式：窗口就绪后打印 `SELF_TEST_OK …` 并退出。
    pub self_test: bool,
}

/// 持久控件。
pub struct Widgets {
    /// 托盘驻留状态。
    pub tray_status: TrayStatus,
}

/// 桌面应用状态（单线程 GTK 主上下文内使用）。
pub struct Desktop {
    /// 持久化配置。
    pub config: DesktopConfig,
    /// 配置文件路径。
    pub config_path: Option<PathBuf>,
    /// 家目录。
    pub home: PathBuf,
    /// 治理面外壳（导航、九页、出处栏）。
    pub shell: Rc<Shell>,
    /// 控件集合。
    pub widgets: Widgets,
    /// 主窗口。
    pub window: adw::ApplicationWindow,
    /// 启动时是否按配置请求了最大化（裸 Xvfb 无 WM 时 `is_maximized()` 可能仍为 false）。
    pub maximize_requested: bool,
    tray: Option<TrayHandle>,
    tray_menu: Option<gtk::Window>,
    hold_guard: Option<gtk::gio::ApplicationHoldGuard>,
    app: Option<adw::Application>,
}

impl std::fmt::Debug for Desktop {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Desktop")
            .field("page", &self.shell.current().info().slug)
            .field("online", &self.shell.ctx.online())
            .field("tray", &self.widgets.tray_status)
            .finish_non_exhaustive()
    }
}

/// 构建主窗口与状态（不启动 GTK 主循环，测试可独立调用）。
///
/// 托盘驻留**不在这里**启动：它需要 `gtk::Application` 来持有进程（`app.hold()`），
/// 由 [`run_with_hook`] 的激活阶段统一接线。
#[must_use]
pub fn build_desktop(options: DesktopOptions) -> Rc<RefCell<Desktop>> {
    crate::style::install();
    let config = DesktopConfig::load_from(options.config_path.as_deref());

    let shell = Shell::new(Api::new(options.home.clone()));
    let toolbar = adw::ToolbarView::new();
    let header = adw::HeaderBar::new();
    header.add_css_class("qz-header");
    // 窗口标题随页走；标题区不放任何东西，让出一整条安静的细线。
    header.set_title_widget(Some(&gtk::Box::new(gtk::Orientation::Horizontal, 0)));
    toolbar.add_top_bar(&header);
    toolbar.set_content(Some(&shell.root));

    let maximize_requested = config.maximized;
    let window = adw::ApplicationWindow::builder()
        .title("Quetzalcoatl")
        .default_width(config.width)
        .default_height(config.height)
        .content(&toolbar)
        .build();
    window.add_css_class("qz-window");
    window.set_size_request(360, 400);
    shell.attach_window(window.upcast_ref());
    if maximize_requested {
        window.maximize();
    }

    if let Ok(condition) = adw::BreakpointCondition::parse(NARROW_BREAKPOINT) {
        let breakpoint = adw::Breakpoint::new(condition);
        let narrow = Rc::downgrade(&shell);
        breakpoint.connect_apply(move |_| {
            if let Some(shell) = narrow.upgrade() {
                shell.set_narrow(true);
            }
        });
        let wide = Rc::downgrade(&shell);
        breakpoint.connect_unapply(move |_| {
            if let Some(shell) = wide.upgrade() {
                shell.set_narrow(false);
            }
        });
        window.add_breakpoint(breakpoint);
    }

    let desktop = Rc::new(RefCell::new(Desktop {
        config: config.clone(),
        config_path: options.config_path,
        home: options.home,
        shell: shell.clone(),
        widgets: Widgets {
            tray_status: TrayStatus::Disabled,
        },
        window,
        maximize_requested,
        tray: None,
        tray_menu: None,
        hold_guard: None,
        app: None,
    }));

    wire_signals(&desktop);
    shell.start();
    if let Some(key) = PageKey::from_slug(&config.page)
        && key != PageKey::Overview
    {
        shell.navigate(key);
    }
    desktop
}

impl Desktop {
    /// 把当前页与窗口尺寸原子写盘。
    pub fn persist_config(&self) -> io::Result<()> {
        let mut config = self.config.clone();
        let (width, height) = (self.window.width(), self.window.height());
        if width >= 320 && height >= 240 {
            config.width = width;
            config.height = height;
        }
        if self.window.is_mapped() {
            config.maximized = self.window.is_maximized();
        }
        config.page = self.shell.current().info().slug.to_owned();
        config.sanitized().save_to(self.config_path.as_deref())
    }
}

/// 注册九页的 `GAction` 与布局无关的 accelerator（`<Primary>1..9`），以及重读（`<Primary>r`）。
///
/// 用 action accelerator 而不是裸 keyval 匹配：AZERTY 等布局下 `1` 需要 `Shift`，
/// accelerator 会按「产生该字符的按键组合」匹配；`Ctrl+Shift+1` 也能命中同一动作。
pub fn install_page_actions<A>(app: &A, shell: Weak<Shell>)
where
    A: IsA<gtk::Application> + IsA<gtk::gio::ActionMap> + IsA<gtk::gio::ActionGroup>,
{
    for (index, info) in PAGES.iter().enumerate() {
        let digit = index + 1;
        let name = format!("page-{digit}");
        let action = gtk::gio::SimpleAction::new(&name, None);
        let weak = shell.clone();
        let key = info.key;
        action.connect_activate(move |_, _| {
            if let Some(shell) = weak.upgrade() {
                shell.navigate(key);
            }
        });
        app.add_action(&action);
        app.set_accels_for_action(
            &format!("app.{name}"),
            &[
                &format!("<Primary>{digit}"),
                &format!("<Primary><Shift>{digit}"),
            ],
        );
    }
    let reload = gtk::gio::SimpleAction::new("reload", None);
    reload.connect_activate(move |_, _| {
        if let Some(shell) = shell.upgrade() {
            shell.reload();
        }
    });
    app.add_action(&reload);
    app.set_accels_for_action("app.reload", &["<Primary>r", "F5"]);
}

fn install_app_actions(app: &adw::Application, state: Weak<RefCell<Desktop>>) {
    let show = gtk::gio::SimpleAction::new("show-window", None);
    let show_weak = state.clone();
    show.connect_activate(move |_, _| {
        if let Some(state) = show_weak.upgrade() {
            hide_tray_menu(&state);
            present_window(&state);
        }
    });
    app.add_action(&show);

    let quit = gtk::gio::SimpleAction::new("quit", None);
    quit.connect_activate(move |_, _| {
        if let Some(state) = state.upgrade() {
            {
                let mut desktop = state.borrow_mut();
                let _ = desktop.persist_config();
                // 显式释放 hold，确保没有任何隐藏窗口时进程也能退出。
                desktop.hold_guard = None;
            }
            let app = state.borrow().app.clone();
            if let Some(app) = app {
                app.quit();
            }
        }
    });
    app.add_action(&quit);
}

/// 处理主循环事件直到超时（无头测试与自检使用）。
pub fn pump_events(millis: u64) {
    let context = glib::MainContext::default();
    let deadline = Instant::now() + Duration::from_millis(millis);
    loop {
        while context.pending() {
            let _ = context.iteration(false);
        }
        if Instant::now() >= deadline {
            return;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
}

/// 处理主循环事件直到某个控件被映射（或超时）。
#[must_use]
pub fn pump_until_mapped(widget: &impl IsA<gtk::Widget>, timeout_ms: u64) -> bool {
    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    loop {
        pump_events(10);
        if widget.is_mapped() {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
    }
}

/// 处理主循环事件直到条件成立（或超时）；返回条件是否成立。
pub fn pump_until(timeout_ms: u64, mut condition: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    loop {
        pump_events(10);
        if condition() {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
    }
}

fn wire_signals(state: &Rc<RefCell<Desktop>>) {
    let window = state.borrow().window.clone();
    let weak: Weak<RefCell<Desktop>> = Rc::downgrade(state);

    window.connect_close_request(move |window| {
        if let Some(state) = weak.upgrade() {
            let (width, height) = (window.width(), window.height());
            let keep_alive = {
                let mut desktop = state.borrow_mut();
                if width >= 320 && height >= 240 {
                    desktop.config.width = width;
                    desktop.config.height = height;
                }
                if window.is_mapped() {
                    desktop.config.maximized = window.is_maximized();
                }
                let _ = desktop.persist_config();
                desktop.hold_guard.is_some()
            };
            if keep_alive {
                // 托盘驻留中：关闭只隐藏窗口，进程继续驻留在托盘。
                window.set_visible(false);
                return glib::Propagation::Stop;
            }
        }
        glib::Propagation::Proceed
    });
}

fn present_window(state: &Rc<RefCell<Desktop>>) {
    let desktop = state.borrow();
    desktop.window.set_visible(true);
    desktop.window.present();
}

fn hide_tray_menu(state: &Rc<RefCell<Desktop>>) {
    let menu = state.borrow().tray_menu.clone();
    if let Some(menu) = menu {
        menu.set_visible(false);
    }
}

fn show_tray_menu(state: &Rc<RefCell<Desktop>>) {
    let (existing, app) = {
        let desktop = state.borrow();
        (desktop.tray_menu.clone(), desktop.app.clone())
    };
    let menu = match existing {
        Some(menu) => menu,
        None => {
            let menu = gtk::Window::builder()
                .title("Quetzalcoatl 托盘菜单")
                .default_width(320)
                .resizable(false)
                .build();
            menu.add_css_class("tray-menu");
            menu.add_css_class("qz-window");
            if let Some(app) = &app {
                menu.set_application(Some(app));
            }
            let root = crate::ui::vbox(12);
            root.set_margin_top(16);
            root.set_margin_bottom(16);
            root.set_margin_start(16);
            root.set_margin_end(16);

            let title = gtk::Label::new(Some("Quetzalcoatl"));
            title.set_xalign(0.0);
            title.add_css_class("qz-cell-title");
            crate::a11y::set_label(&title, "托盘菜单标题");

            let show = crate::ui::button_outline("显示主窗口", false);
            show.set_size_request(-1, 56);
            show.set_action_name(Some("app.show-window"));
            crate::a11y::set_label(&show, "显示 Quetzalcoatl 主窗口");

            let quit = crate::ui::button_outline("退出 Quetzalcoatl", false);
            quit.set_size_request(-1, 56);
            quit.set_action_name(Some("app.quit"));
            crate::a11y::set_label(&quit, "退出 Quetzalcoatl");

            root.append(&title);
            root.append(&show);
            root.append(&quit);
            menu.set_child(Some(&root));
            state.borrow_mut().tray_menu = Some(menu.clone());
            menu
        }
    };
    menu.present();
}

/// 托盘驻留接线：关闭隐藏 + 左键唤醒 + 右键原生菜单（含退出）。
///
/// 无会话总线 / 总线不可连接 / 无 StatusNotifier 宿主时不 `hold()`，
/// 关闭主窗口即正常退出（不会留下无法唤回的幽灵进程）。
fn attach_tray(app: &adw::Application, state: &Rc<RefCell<Desktop>>) {
    let (tx, rx) = mpsc::channel::<TrayEvent>();
    let activate_tx = tx.clone();
    let callbacks = TrayCallbacks {
        on_activate: Box::new(move || {
            let _ = activate_tx.send(TrayEvent::Activate);
        }),
        on_context_menu: Box::new(move || {
            let _ = tx.send(TrayEvent::Menu);
        }),
    };
    let handle = tray::start("Quetzalcoatl", callbacks);
    let status = handle.status;
    let hold_guard = if status.is_active() {
        Some(app.hold())
    } else {
        None
    };
    {
        let mut desktop = state.borrow_mut();
        desktop.widgets.tray_status = status;
        desktop.hold_guard = hold_guard;
        desktop.tray = Some(handle);
    }
    let weak = Rc::downgrade(state);
    glib::timeout_add_local(Duration::from_millis(100), move || {
        loop {
            match rx.try_recv() {
                Ok(TrayEvent::Activate) => {
                    if let Some(state) = weak.upgrade() {
                        present_window(&state);
                    }
                }
                Ok(TrayEvent::Menu) => {
                    if let Some(state) = weak.upgrade() {
                        show_tray_menu(&state);
                    }
                }
                Err(TryRecvError::Empty) => return glib::ControlFlow::Continue,
                Err(TryRecvError::Disconnected) => return glib::ControlFlow::Break,
            }
        }
    });
}

enum TrayEvent {
    Activate,
    Menu,
}

/// 启动 GTK 应用主循环。
pub fn run(options: DesktopOptions) -> glib::ExitCode {
    let self_test = options.self_test;
    run_with_hook(options, move |app, desktop| {
        if self_test {
            schedule_self_test(app, desktop);
        }
    })
}

/// 启动主循环并暴露激活钩子（无头生命周期测试与自检共用同一真实路径）。
pub fn run_with_hook<F>(options: DesktopOptions, hook: F) -> glib::ExitCode
where
    F: FnOnce(&adw::Application, Rc<RefCell<Desktop>>) + 'static,
{
    let app = adw::Application::builder()
        .application_id(APPLICATION_ID)
        .flags(gtk::gio::ApplicationFlags::NON_UNIQUE)
        .build();

    let hook = Rc::new(RefCell::new(Some(hook)));
    app.connect_activate(move |app| {
        let desktop = build_desktop(options.clone());
        {
            let mut state = desktop.borrow_mut();
            state.app = Some(app.clone());
            state.window.set_application(Some(app));
        }
        let shell = Rc::downgrade(&desktop.borrow().shell);
        install_page_actions(app, shell);
        install_app_actions(app, Rc::downgrade(&desktop));
        attach_tray(app, &desktop);
        desktop.borrow().window.present();
        if let Some(hook) = hook.borrow_mut().take() {
            hook(app, desktop);
        }
    });

    app.run_with_args::<&str>(&[])
}

fn schedule_self_test(app: &adw::Application, desktop: Rc<RefCell<Desktop>>) {
    let app = app.clone();
    // 等第一批读取回来（联系上了，或确认联系不上）再自检，最多等 3 秒。
    let started = Instant::now();
    glib::timeout_add_local(Duration::from_millis(50), move || {
        let answered = desktop.borrow().shell.ctx.answered();
        if !answered && started.elapsed() < Duration::from_secs(3) {
            return glib::ControlFlow::Continue;
        }
        let visible = {
            let state = desktop.borrow();
            let visible = state.window.is_visible();
            let ctx = &state.shell.ctx;
            let connected = ctx.online() && ctx.ever_online();
            let page = state.shell.current().info().slug;
            println!(
                "SELF_TEST_OK window={} page={page} connected={connected} degraded={} tray={}",
                if visible { "visible" } else { "hidden" },
                u8::from(!connected),
                state.widgets.tray_status.label(),
            );
            visible
        };
        if !visible {
            eprintln!("quetzalcoatl-desktop: 自检失败，主窗口未能显示");
        }
        app.quit();
        glib::ControlFlow::Break
    });
}
