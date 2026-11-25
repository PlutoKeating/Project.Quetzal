#![forbid(unsafe_code)]

//! 桌面应用外壳：GTK4 `Application`、三态 `ViewStack`、快捷动作、托盘驻留与 IPC 接线。
//!
//! 关键不变量：
//! * 本进程**只**通过 `quetzalcoatl-client-core::ThinClient` 访问脊柱；
//!   守护进程不可达时进入类型化离线视图，绝不回退直连 `spine.sqlite`（防坑规范 #13）。
//! * 在线时启动即拉取真实 `desktop_snapshot`（会话/运行进展/良知/审计），并以差分
//!   `ViewPatch` 幂等落入 UI 模型；对话完成后再拉一次，保持界面与脊柱一致。
//! * 披露层级：pid / socket / 错误码等运行技术细节只进入检视态；工作台保持零术语。

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::io;
use std::path::{Path, PathBuf};
use std::rc::{Rc, Weak};
use std::sync::Arc;
use std::sync::mpsc::{self, TryRecvError};
use std::time::{Duration, Instant};

use gtk::gio::prelude::ApplicationExtManual;
use gtk::glib;
use gtk::prelude::*;
use gtk4 as gtk;
use libadwaita as adw;

use quetzalcoatl_client_core::{
    CognitionDensity, StreamEvent, StreamEventKind, ThinClient, ViewRow, ViewState,
};
use quetzalcoatl_daemon::{ChatRequest, DesktopRow, IpcRequest, IpcResponse};

use crate::a11y::LiveRegion;
use crate::config::DesktopConfig;
use crate::degrade;
use crate::model::{ConnectionState, StreamIngest, UiModel};
use crate::tray::{self, TrayCallbacks, TrayHandle, TrayStatus};
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
    /// 应用级实时播报区域（不随密度变化）。
    pub live: LiveRegion,
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
            .field("density", &self.model.density())
            .field("online", &self.model.connection.is_online())
            .field("rows", &self.model.view.rows.len())
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
    let config = DesktopConfig::load_from(options.config_path.as_deref());
    let density = config.density;
    let (connection, client) = probe_daemon(&options.home);
    let mut model = match connection {
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
    if let Some(client) = &client {
        hydrate_model(&mut model, client.as_ref());
    }

    let companion = companion::build();
    let workbench = workbench::build();
    let inspector = inspector::build();

    let stack = adw::ViewStack::new();
    // 显式给每个密度页一个存在的 symbolic 图标：libadwaita 在宽模式下会渲染页图标，
    // 缺省会落到 `image-missing`（真实安装验收里就是三个红叉），既是视觉缺陷也降低可辨识度。
    stack.add_titled_with_icon(
        &companion.root,
        Some("companion"),
        "陪伴",
        "chat-message-new-symbolic",
    );
    stack.add_titled_with_icon(
        &workbench.root,
        Some("workbench"),
        "工作台",
        "view-grid-symbolic",
    );
    stack.add_titled_with_icon(
        &inspector.root,
        Some("inspector"),
        "检视",
        "system-search-symbolic",
    );
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

    let live = LiveRegion::new();
    let overlay = gtk::Overlay::new();
    overlay.set_child(Some(&toolbar));
    overlay.add_overlay(live.widget());
    live.widget().set_halign(gtk::Align::Start);
    live.widget().set_valign(gtk::Align::Start);

    let maximize_requested = config.maximized;
    let window = adw::ApplicationWindow::builder()
        .title("Quetzalcoatl")
        .default_width(config.width)
        .default_height(config.height)
        .content(&overlay)
        .build();
    if maximize_requested {
        window.maximize();
    }

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
            live,
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

/// 从真实本地 IPC 拉取快照 + 良知正文，并以差分补丁落入 UI 模型。
fn hydrate_model(model: &mut UiModel, client: &ThinClient) {
    match client.call(&IpcRequest::DesktopSnapshot) {
        Ok(IpcResponse::DesktopSnapshot { rev, rows }) => apply_desktop_rows(model, rev, &rows),
        Ok(IpcResponse::Error { code, detail }) => {
            model.notice("暂时读不到本机助手的动态，稍后会自动重试。");
            model.technical(format!("desktop_snapshot {code}: {detail}"));
        }
        Ok(other) => {
            model.technical(format!("desktop_snapshot 返回了非快照响应: {other:?}"));
        }
        Err(err) => {
            model.notice("暂时读不到本机助手的动态，稍后会自动重试。");
            model.technical(format!("desktop_snapshot 传输失败: {err}"));
        }
    }
    match client.call(&IpcRequest::ConsciencePinned) {
        Ok(IpcResponse::ConsciencePinned { pinned_system_tail }) => {
            model.conscience_body = Some(pinned_system_tail);
        }
        Ok(_) => model.technical(String::from("conscience_pinned 返回了非预期响应")),
        Err(err) => model.technical(format!("conscience_pinned 失败: {err}")),
    }
}

fn apply_desktop_rows(model: &mut UiModel, rev: u64, rows: &[DesktopRow]) {
    let mut map: BTreeMap<String, ViewRow> = BTreeMap::new();
    for row in rows {
        map.insert(
            row.key.clone(),
            ViewRow {
                key: row.key.clone(),
                kind: row.kind.clone(),
                summary: row.summary.clone(),
                detail: row.detail.clone(),
                raw_json: row.raw_json.clone(),
                updated_rev: row.updated_rev,
            },
        );
    }
    let target = ViewState {
        rev: rev.max(model.view.rev.saturating_add(1)),
        density: model.density(),
        rows: map,
    };
    match model.view.diff(&target) {
        Ok(patch) => {
            if let Err(err) = model.apply_patch(&patch) {
                model.technical(format!("视图补丁应用失败: {err}"));
            }
        }
        Err(err) => model.technical(format!("视图差分失败: {err}")),
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
        if self.window.is_mapped() {
            config.maximized = self.window.is_maximized();
        }
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

/// 即时切换认知密度（快捷动作 `Ctrl+1/2/3` 与视图切换器共用此入口）。
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

/// 注册三档密度的 `GAction` 与布局无关的 accelerator（`<Primary>1/2/3`）。
///
/// 用 action accelerator 而不是裸 keyval 匹配：AZERTY 等布局下 `1` 需要 `Shift`，
/// accelerator 会按「产生该字符的按键组合」匹配；`Ctrl+Shift+1` 也能命中同一动作。
pub fn install_density_actions<A>(app: &A, state: Weak<RefCell<Desktop>>)
where
    A: IsA<gtk::Application> + IsA<gtk::gio::ActionMap> + IsA<gtk::gio::ActionGroup>,
{
    let bindings = [
        ("density-companion", CognitionDensity::Companion, "1"),
        ("density-workbench", CognitionDensity::Workbench, "2"),
        ("density-inspector", CognitionDensity::Inspector, "3"),
    ];
    for (name, density, digit) in bindings {
        let accelerator = format!("<Primary>{digit}");
        let shifted = format!("<Primary><Shift>{digit}");
        let action = gtk::gio::SimpleAction::new(name, None);
        let weak = state.clone();
        action.connect_activate(move |_, _| {
            if let Some(state) = weak.upgrade() {
                apply_density(&state, density);
            }
        });
        app.add_action(&action);
        app.set_accels_for_action(&format!("app.{name}"), &[&accelerator, &shifted]);
    }
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

/// 消费一批流事件 → 刷新三档视图 → **恰好一次**应用级播报。
pub fn ingest_stream_batch(state: &Rc<RefCell<Desktop>>, events: &[StreamEvent]) -> StreamIngest {
    let (ingest, announcement) = {
        let mut desktop = state.borrow_mut();
        let ingest = desktop.model.ingest_stream(events);
        let announcement = ingest
            .preferred_announcement()
            .map(str::to_owned)
            .unwrap_or_default();
        (ingest, announcement)
    };
    if !announcement.is_empty() {
        state.borrow().widgets.live.announce(&announcement);
    }
    refresh(state);
    ingest
}

fn wire_signals(state: &Rc<RefCell<Desktop>>) {
    let window = state.borrow().window.clone();
    let weak: Weak<RefCell<Desktop>> = Rc::downgrade(state);

    let close_weak = weak.clone();
    window.connect_close_request(move |window| {
        if let Some(state) = close_weak.upgrade() {
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
                // 托盘驻留中：关闭只隐藏窗口，进程继续在后台接收消息。
                window.set_visible(false);
                return glib::Propagation::Stop;
            }
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
            desktop
                .model
                .notice("还没连上本机助手，这句话只留在本机窗口里，不会被发送。");
        }
    }
    refresh(state);

    let Some(client) = client.filter(|_| online) else {
        return;
    };
    let prompt = text.to_owned();
    let (tx, rx) = mpsc::channel();
    let spawned = std::thread::Builder::new()
        .name(String::from("qz-desktop-chat"))
        .spawn(move || {
            let response = client.call(&IpcRequest::Chat(ChatRequest::simple(prompt)));
            let _ = tx.send(response);
        });
    if spawned.is_err() {
        let mut desktop = state.borrow_mut();
        desktop.model.finish_stream();
        desktop.model.notice("无法启动本机请求线程，请重试。");
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
                {
                    let mut desktop = state.borrow_mut();
                    desktop.model.finish_stream();
                    desktop.model.notice("本机请求线程意外结束，请重试。");
                }
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
            let reply = chat.reply.clone();
            let delegated = chat.delegated_to_worker;
            let seq = state.borrow().model.session.last_seq.saturating_add(1);
            let _ = ingest_stream_batch(
                state,
                &[
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
                ],
            );
            {
                let mut desktop = state.borrow_mut();
                if delegated {
                    desktop
                        .model
                        .notice("本轮由沙箱内的 Worker Agent 执行，并经洁净室校验。");
                }
            }
        }
        Ok(IpcResponse::Error { code, detail }) => {
            let mut desktop = state.borrow_mut();
            desktop.model.finish_stream();
            desktop.model.notice("这次没有收到回复，请稍后重试。");
            desktop
                .model
                .technical(format!("chat 被拒绝 [{code}]: {detail}"));
        }
        Ok(other) => {
            let mut desktop = state.borrow_mut();
            desktop.model.finish_stream();
            desktop.model.notice("这次没有收到回复，请稍后重试。");
            desktop
                .model
                .technical(format!("chat 返回了非对话响应: {other:?}"));
        }
        Err(err) => {
            let mut desktop = state.borrow_mut();
            desktop.model.finish_stream();
            desktop.model.notice("这次没有收到回复，请稍后重试。");
            desktop.model.technical(format!("chat 传输失败: {err}"));
        }
    }
    refresh_snapshot(state);
    refresh(state);
}

fn refresh_snapshot(state: &Rc<RefCell<Desktop>>) {
    let client = state.borrow().client.clone();
    if let Some(client) = client {
        let mut desktop = state.borrow_mut();
        hydrate_model(&mut desktop.model, client.as_ref());
    }
}

fn reconnect(state: &Rc<RefCell<Desktop>>) {
    let home = state.borrow().home.clone();
    let (connection, client) = probe_daemon(&home);
    {
        let mut desktop = state.borrow_mut();
        let online = connection.is_online();
        desktop.model.connection = connection;
        desktop.client = client.clone();
        desktop.model.notice(if online {
            String::from("已重新连接本机助手。")
        } else {
            String::from("还是连不上本机助手，请确认 quetzalcoatld 正在运行。")
        });
        if let Some(client) = &client {
            hydrate_model(&mut desktop.model, client.as_ref());
        }
    }
    refresh(state);
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
            if let Some(app) = &app {
                menu.set_application(Some(app));
            }
            let root = gtk::Box::new(gtk::Orientation::Vertical, 12);
            root.set_margin_top(16);
            root.set_margin_bottom(16);
            root.set_margin_start(16);
            root.set_margin_end(16);

            let title = gtk::Label::new(Some("Quetzalcoatl"));
            title.set_xalign(0.0);
            title.add_css_class("title-4");
            crate::a11y::set_label(&title, "托盘菜单标题");

            let show = gtk::Button::with_label("显示主窗口");
            show.set_size_request(-1, 56);
            show.set_action_name(Some("app.show-window"));
            crate::a11y::set_label(&show, "显示 Quetzalcoatl 主窗口");

            let quit = gtk::Button::with_label("退出 Quetzalcoatl");
            quit.set_size_request(-1, 56);
            quit.add_css_class("destructive-action");
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
        install_density_actions(app, Rc::downgrade(&desktop));
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
    glib::timeout_add_local_once(Duration::from_millis(600), move || {
        let visible = {
            let state = desktop.borrow();
            let visible = state.window.is_visible();
            let density = state.model.density().label();
            let connected = state.model.connection.is_online();
            let degraded = u8::from(state.model.degraded().is_some());
            let tray = state.widgets.tray_status.label();
            let rows = state.model.view.rows.len();
            println!(
                "SELF_TEST_OK window={} density={density} connected={connected} degraded={degraded} tray={tray} rows={rows}",
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
