#![forbid(unsafe_code)]

//! 桌面应用外壳：GTK4 `Application`、三态 `ViewStack`、快捷键、托盘与 IPC 接线。
//!
//! 关键不变量：本进程**只**通过 `quetzalcoatl-client-core::ThinClient` 访问脊柱；
//! 守护进程不可达时进入类型化离线视图，绝不回退直连 `spine.sqlite`（防坑规范 #13）。

use std::cell::RefCell;
use std::io;
use std::path::{Path, PathBuf};
use std::rc::{Rc, Weak};
use std::sync::Arc;
use std::sync::mpsc::TryRecvError;
use std::time::{Duration, Instant};

use gtk::glib;
use gtk::prelude::*;
use gtk4 as gtk;
use libadwaita as adw;

use quetzalcoatl_client_core::{CognitionDensity, StreamEvent, StreamEventKind, ThinClient};
use quetzalcoatl_daemon::{ChatRequest, IpcRequest, IpcResponse};

use crate::config::DesktopConfig;
use crate::degrade;
use crate::model::{ConnectionState, UiModel};
use crate::tray::{self, TrayHandle, TrayStatus};
use crate::views::{companion, inspector, workbench};

/// 应用 ID（与 `.desktop` 文件的 `StartupWMClass` 一致）。
pub const APPLICATION_ID: &str = "org.quetzalcoatl.Desktop";

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

/// 三档视图的持久控件集合。
pub struct Widgets {
    /// 密度页栈。
    pub stack: adw::ViewStack,
    /// 陪伴态。
    pub companion: companion::CompanionView,
    /// 工作台态。
    pub workbench: workbench::WorkbenchView,
    /// 检视态。
    pub inspector: inspector::InspectorView,
    /// 全局离线/降级横幅。
    pub banner: adw::Banner,
    /// 托盘驻留状态。
    pub tray_status: TrayStatus,
}

/// 桌面应用状态（单线程 GTK 主上下文内使用）。
pub struct Desktop {
    /// UI 模型。
    pub model: UiModel,
    /// 持久化配置。
    pub config: DesktopConfig,
    /// 配置文件路径。
    pub config_path: Option<PathBuf>,
    /// 家目录。
    pub home: PathBuf,
    /// 薄客户端（在线时存在）。
    pub client: Option<Arc<ThinClient>>,
    /// 控件集合。
    pub widgets: Widgets,
    /// 主窗口。
    pub window: adw::ApplicationWindow,
    /// 托盘句柄（保活）。
    _tray: TrayHandle,
}

/// 构建主窗口与状态（不启动 GTK 主循环，测试可独立调用）。
#[must_use]
pub fn build_desktop(options: DesktopOptions) -> Rc<RefCell<Desktop>> {
    let config = DesktopConfig::load_from(options.config_path.as_deref());
    let density = config.density;
    let (connection, client) = probe_daemon(&options.home);
    let model = match connection {
        ConnectionState::Online {
            pid,
            endpoint,
            spine_events,
        } => UiModel::online(pid, endpoint, spine_events, density),
        offline @ ConnectionState::Offline { .. } => {
            let mut model = UiModel::offline_with_density(String::new(), density);
            model.connection = offline;
            model
        }
    };

    let companion = companion::build();
    let workbench = workbench::build();
    let inspector = inspector::build();

    let stack = adw::ViewStack::new();
    stack.add_titled(&companion.root, Some("companion"), "陪伴");
    stack.add_titled(&workbench.root, Some("workbench"), "工作台");
    stack.add_titled(&inspector.root, Some("inspector"), "检视");
    stack.set_visible_child_name(density.label());

    let switcher = adw::ViewSwitcher::new();
    switcher.set_stack(Some(&stack));
    switcher.set_policy(adw::ViewSwitcherPolicy::Wide);
    let header = adw::HeaderBar::new();
    header.set_title_widget(Some(&switcher));

    let banner = adw::Banner::new("");
    banner.set_revealed(false);

    let toolbar = adw::ToolbarView::new();
    toolbar.add_top_bar(&header);
    toolbar.add_top_bar(&banner);
    toolbar.set_content(Some(&stack));

    let window = adw::ApplicationWindow::builder()
        .title("Quetzalcoatl")
        .default_width(config.width)
        .default_height(config.height)
        .content(&toolbar)
        .build();

    let tray_handle = tray::start("Quetzalcoatl");
    let tray_status = tray_handle.status;

    let desktop = Rc::new(RefCell::new(Desktop {
        model,
        config,
        config_path: options.config_path,
        home: options.home,
        client,
        widgets: Widgets {
            stack,
            companion,
            workbench,
            inspector,
            banner,
            tray_status,
        },
        window,
        _tray: tray_handle,
    }));

    wire_signals(&desktop);
    refresh(&desktop);
    desktop
}

/// 调用守护进程健康握手；失败时返回零术语的离线说明。
fn probe_daemon(home: &Path) -> (ConnectionState, Option<Arc<ThinClient>>) {
    match ThinClient::mount(home) {
        Ok(client) => {
            let endpoint = client.runtime_info().ipc_http_addr.to_string();
            match client.status() {
                Ok(status) => (
                    ConnectionState::Online {
                        pid: status.pid,
                        endpoint,
                        spine_events: status.spine_events_count,
                    },
                    Some(Arc::new(client)),
                ),
                Err(err) => (
                    ConnectionState::Offline {
                        view: degrade::explain_client_error(&err),
                    },
                    None,
                ),
            }
        }
        Err(err) => (
            ConnectionState::Offline {
                view: degrade::explain_client_error(&err),
            },
            None,
        ),
    }
}

impl Desktop {
    /// 把当前密度与窗口尺寸原子写盘。
    pub fn persist_config(&self) -> io::Result<()> {
        let mut config = self.config.clone();
        let (width, height) = (self.window.width(), self.window.height());
        if width >= 320 && height >= 240 {
            config.width = width;
            config.height = height;
        }
        config.maximized = self.window.is_maximized();
        config.sanitized().save_to(self.config_path.as_deref())
    }
}

/// 把模型投影到三档原生视图、横幅与页栈。
pub fn refresh(state: &Rc<RefCell<Desktop>>) {
    let desktop = state.borrow();
    companion::render(&desktop.widgets.companion, &desktop.model);
    workbench::render(&desktop.widgets.workbench, &desktop.model);
    inspector::render(&desktop.widgets.inspector, &desktop.model);

    if let Some(degraded) = desktop.model.degraded() {
        desktop.widgets.banner.set_title(&degraded.title);
        desktop.widgets.banner.set_revealed(true);
    } else {
        desktop.widgets.banner.set_revealed(false);
    }

    let density = desktop.model.density();
    if desktop.widgets.stack.visible_child_name().as_deref() != Some(density.label()) {
        desktop
            .widgets
            .stack
            .set_visible_child_name(density.label());
    }
    let title = match density {
        CognitionDensity::Companion => "Quetzalcoatl · 陪伴",
        CognitionDensity::Workbench => "Quetzalcoatl · 工作台",
        CognitionDensity::Inspector => "Quetzalcoatl · 检视",
    };
    desktop.window.set_title(Some(title));
}

/// 即时切换认知密度（`Ctrl+1/2/3` 与视图切换器共用此入口）。
pub fn apply_density(state: &Rc<RefCell<Desktop>>, density: CognitionDensity) {
    {
        let mut desktop = state.borrow_mut();
        if desktop.model.set_density(density).is_ok() {
            desktop.config.density = density;
            let _ = desktop.persist_config();
        }
    }
    refresh(state);
}

/// 把键盘事件映射到认知密度；只接受 `Ctrl+1/2/3`。
#[must_use]
pub fn density_shortcut(
    key: gdk_key::Key,
    modifiers: gdk_key::ModifierType,
) -> Option<CognitionDensity> {
    if !modifiers.contains(gdk_key::ModifierType::CONTROL_MASK) {
        return None;
    }
    match key {
        gdk_key::Key::_1 => Some(CognitionDensity::Companion),
        gdk_key::Key::_2 => Some(CognitionDensity::Workbench),
        gdk_key::Key::_3 => Some(CognitionDensity::Inspector),
        _ => None,
    }
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

fn wire_signals(state: &Rc<RefCell<Desktop>>) {
    let window = state.borrow().window.clone();
    let weak: Weak<RefCell<Desktop>> = Rc::downgrade(state);

    let keys = gtk::EventControllerKey::new();
    let key_state = weak.clone();
    keys.connect_key_pressed(move |_, key, _code, modifiers| {
        if let Some(density) = density_shortcut(key, modifiers)
            && let Some(state) = key_state.upgrade()
        {
            apply_density(&state, density);
            return glib::Propagation::Stop;
        }
        glib::Propagation::Proceed
    });
    window.add_controller(keys);

    let close_weak = weak.clone();
    window.connect_close_request(move |window| {
        if let Some(state) = close_weak.upgrade() {
            let (width, height) = (window.width(), window.height());
            let mut desktop = state.borrow_mut();
            if width >= 320 && height >= 240 {
                desktop.config.width = width;
                desktop.config.height = height;
            }
            desktop.config.maximized = window.is_maximized();
            let _ = desktop.persist_config();
        }
        glib::Propagation::Proceed
    });

    let retry_weak = weak.clone();
    state
        .borrow()
        .widgets
        .companion
        .retry
        .connect_clicked(move |_| {
            if let Some(state) = retry_weak.upgrade() {
                reconnect(&state);
            }
        });

    let (companion_entry, companion_send) = {
        let desktop = state.borrow();
        (
            desktop.widgets.companion.entry.clone(),
            desktop.widgets.companion.send.clone(),
        )
    };
    wire_composer(state, &companion_entry, &companion_send);

    let (workbench_entry, workbench_send) = {
        let desktop = state.borrow();
        (
            desktop.widgets.workbench.entry.clone(),
            desktop.widgets.workbench.send.clone(),
        )
    };
    wire_composer(state, &workbench_entry, &workbench_send);

    wire_approval_actions(state);
}

fn wire_composer(state: &Rc<RefCell<Desktop>>, entry: &gtk::Entry, send: &gtk::Button) {
    let send_entry = entry.clone();
    let send_weak = Rc::downgrade(state);
    send.connect_clicked(move |_| {
        let text = send_entry.text().to_string();
        send_entry.set_text("");
        if let Some(state) = send_weak.upgrade() {
            send_message(&state, &text);
        }
    });

    let activate_weak = Rc::downgrade(state);
    entry.connect_activate(move |entry| {
        let text = entry.text().to_string();
        entry.set_text("");
        if let Some(state) = activate_weak.upgrade() {
            send_message(&state, &text);
        }
    });
}

fn wire_approval_actions(state: &Rc<RefCell<Desktop>>) {
    let group = gtk::gio::SimpleActionGroup::new();
    for (name, decision) in [("approve", "已批准"), ("deny", "已拒绝")] {
        let action = gtk::gio::SimpleAction::new(name, Some(glib::VariantTy::STRING));
        let weak = Rc::downgrade(state);
        let decision = String::from(decision);
        action.connect_activate(move |_, target| {
            let key = target
                .and_then(|value| value.get::<String>())
                .unwrap_or_default();
            if let Some(state) = weak.upgrade() {
                {
                    let mut desktop = state.borrow_mut();
                    desktop.model.notice(format!(
                        "{decision}：{key}（等待守护进程审批通道接线，尚未写回脊柱）"
                    ));
                }
                refresh(&state);
            }
        });
        group.add_action(&action);
    }
    state
        .borrow()
        .window
        .insert_action_group("win", Some(&group));
}

fn send_message(state: &Rc<RefCell<Desktop>>, text: &str) {
    if text.trim().is_empty() {
        return;
    }
    let (client, online) = {
        let desktop = state.borrow();
        (desktop.client.clone(), desktop.model.connection.is_online())
    };
    {
        let mut desktop = state.borrow_mut();
        desktop.model.push_user_message(text);
        if online {
            desktop.model.session.streaming = true;
        } else {
            desktop.model.notice(String::from(
                "还没连上本机助手，这句话只留在本机窗口里，不会被发送。",
            ));
        }
    }
    refresh(state);

    let Some(client) = client.filter(|_| online) else {
        return;
    };
    let prompt = text.to_owned();
    let (tx, rx) = std::sync::mpsc::channel();
    let spawned = std::thread::Builder::new()
        .name(String::from("qz-desktop-chat"))
        .spawn(move || {
            let response = client.call(&IpcRequest::Chat(ChatRequest::simple(prompt)));
            let _ = tx.send(response);
        });
    if spawned.is_err() {
        let mut desktop = state.borrow_mut();
        desktop.model.finish_stream();
        desktop
            .model
            .notice(String::from("无法启动本机请求线程，请重试。"));
        drop(desktop);
        refresh(state);
        return;
    }

    let weak = Rc::downgrade(state);
    glib::timeout_add_local(Duration::from_millis(120), move || match rx.try_recv() {
        Ok(result) => {
            if let Some(state) = weak.upgrade() {
                apply_chat_result(&state, result);
            }
            glib::ControlFlow::Break
        }
        Err(TryRecvError::Empty) => glib::ControlFlow::Continue,
        Err(TryRecvError::Disconnected) => {
            if let Some(state) = weak.upgrade() {
                let mut desktop = state.borrow_mut();
                desktop.model.finish_stream();
                desktop
                    .model
                    .notice(String::from("本机请求线程意外结束，请重试。"));
                drop(desktop);
                refresh(&state);
            }
            glib::ControlFlow::Break
        }
    });
}

fn apply_chat_result(
    state: &Rc<RefCell<Desktop>>,
    result: Result<IpcResponse, quetzalcoatl_client_core::ClientError>,
) {
    match result {
        Ok(IpcResponse::Chat(chat)) => {
            let mut desktop = state.borrow_mut();
            let seq = desktop.model.session.last_seq.saturating_add(1);
            let reply = chat.reply.clone();
            let ingested = desktop.model.ingest_stream(&[
                StreamEvent {
                    seq,
                    kind: StreamEventKind::Delta,
                    text: reply,
                },
                StreamEvent {
                    seq: seq.saturating_add(1),
                    kind: StreamEventKind::Done,
                    text: String::from("stop"),
                },
            ]);
            if chat.delegated_to_worker {
                desktop.model.notice(String::from(
                    "本轮由沙箱内的 Worker Agent 执行，并经洁净室校验。",
                ));
            }
            for line in ingested.announcements {
                crate::a11y::announce(&desktop.widgets.companion.transcript, &line);
            }
        }
        Ok(IpcResponse::Error { code, detail }) => {
            let mut desktop = state.borrow_mut();
            desktop.model.finish_stream();
            desktop
                .model
                .notice(format!("守护进程拒绝了这次对话（{code}）：{detail}"));
        }
        Ok(other) => {
            let mut desktop = state.borrow_mut();
            desktop.model.finish_stream();
            desktop
                .model
                .notice(format!("守护进程返回了非对话响应：{other:?}"));
        }
        Err(err) => {
            let mut desktop = state.borrow_mut();
            desktop.model.finish_stream();
            desktop
                .model
                .notice(format!("请求失败：{err}（可点「重新连接」后重试）"));
        }
    }
    refresh(state);
}

fn reconnect(state: &Rc<RefCell<Desktop>>) {
    let home = state.borrow().home.clone();
    let (connection, client) = probe_daemon(&home);
    {
        let mut desktop = state.borrow_mut();
        let online = connection.is_online();
        desktop.model.connection = connection;
        desktop.client = client;
        desktop.model.notice(if online {
            String::from("已重新连接本机助手。")
        } else {
            String::from("还是连不上本机助手，请确认 quetzalcoatld 正在运行。")
        });
    }
    refresh(state);
}

/// 启动 GTK 应用主循环。
pub fn run(options: DesktopOptions) -> glib::ExitCode {
    let app = adw::Application::builder()
        .application_id(APPLICATION_ID)
        .flags(gtk::gio::ApplicationFlags::NON_UNIQUE)
        .build();

    let self_test = options.self_test;
    app.connect_activate(move |app| {
        let desktop = build_desktop(options.clone());
        desktop.borrow().window.set_application(Some(app));
        desktop.borrow().window.present();
        if self_test {
            schedule_self_test(app, desktop);
        }
    });

    app.run_with_args::<&str>(&[])
}

fn schedule_self_test(app: &adw::Application, desktop: Rc<RefCell<Desktop>>) {
    let app = app.clone();
    glib::timeout_add_local_once(Duration::from_millis(600), move || {
        let visible = {
            let state = desktop.borrow();
            let visible = state.window.is_visible();
            let density = state.model.density().label();
            let connected = state.model.connection.is_online();
            let degraded = u8::from(state.model.degraded().is_some());
            let tray = state.widgets.tray_status.label();
            println!(
                "SELF_TEST_OK window={} density={density} connected={connected} degraded={degraded} tray={tray}",
                if visible { "visible" } else { "hidden" }
            );
            visible
        };
        if !visible {
            eprintln!("quetzalcoatl-desktop: 自检失败，主窗口未能显示");
        }
        app.quit();
    });
}

mod gdk_key {
    //! 仅为降低重复路径而做的窄别名（避免在签名里出现两层 `gtk::gdk::`）。
    pub use gtk4::gdk::{Key, ModifierType};
}
