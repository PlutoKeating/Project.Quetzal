#![forbid(unsafe_code)]

//! 系统托盘 / StatusNotifierItem 驻留项。
//!
//! 仅在存在 **D-Bus 会话总线** 时才尝试注册 `org.kde.StatusNotifierItem`：
//! * 无 `DBUS_SESSION_BUS_ADDRESS`（SSH、容器、Xvfb 裸环境）→ [`TrayStatus::NoSessionBus`]；
//! * 总线不可连接/无法申请名字 → [`TrayStatus::BusUnavailable`]；
//! * 有总线但没有 `org.kde.StatusNotifierWatcher` 宿主 → [`TrayStatus::NoWatcher`]
//!   （对象仍然导出，宿主稍后启动即可发现，不报错、不弹窗）。
//!
//! 三种降级路径都只返回类型化状态并打印一行 `eprintln!` 诊断，进程继续正常显示窗口。

use zbus::zvariant::OwnedObjectPath;

/// 托盘驻留状态。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TrayStatus {
    /// 尚未尝试驻留（`build_desktop` 不启动托盘；由 `app::run_with_hook` 统一接线）。
    Disabled,
    /// 已向 StatusNotifierWatcher 注册成功。
    Registered,
    /// 会话总线在线但没有 StatusNotifier 宿主（例如裸 Xvfb / 无托盘桌面）。
    NoWatcher,
    /// 没有 D-Bus 会话总线。
    NoSessionBus,
    /// 总线存在但无法连接或申请名字。
    BusUnavailable,
}

impl TrayStatus {
    /// 供自检输出与日志使用的稳定标签。
    #[must_use]
    pub const fn label(self) -> &'static str {
        match self {
            Self::Disabled => "disabled",
            Self::Registered => "registered",
            Self::NoWatcher => "no-watcher",
            Self::NoSessionBus => "no-session-bus",
            Self::BusUnavailable => "bus-unavailable",
        }
    }

    /// 是否真正驻留成功。
    #[must_use]
    pub const fn is_active(self) -> bool {
        matches!(self, Self::Registered)
    }
}

/// 取状态标签（与 [`TrayStatus::label`] 等价，供视图/自检直接调用）。
#[must_use]
pub const fn status_label(status: &TrayStatus) -> &'static str {
    status.label()
}

/// 托盘事件回调（从 D-Bus 线程投递；宿主必须自行跳回 GTK 主上下文）。
pub struct TrayCallbacks {
    /// 左键激活：通常用于呈现主窗口。
    pub on_activate: Box<dyn Fn() + Send + Sync>,
    /// 右键菜单：宿主没有 DBusMenu，由本端弹出原生菜单窗口。
    pub on_context_menu: Box<dyn Fn() + Send + Sync>,
}

/// 托盘驻留句柄：持有总线连接即以保活，`Drop` 时随进程退出自动注销。
pub struct TrayHandle {
    /// 注册结果。
    pub status: TrayStatus,
    /// 保活用的会话总线连接（未注册时为 `None`；仅靠 RAII 保活，不直接读取）。
    _connection: Option<zbus::blocking::Connection>,
}

impl std::fmt::Debug for TrayHandle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TrayHandle")
            .field("status", &self.status)
            .finish_non_exhaustive()
    }
}

const ITEM_PATH: &str = "/StatusNotifierItem";
const MENU_PATH: &str = "/NO_DBUS_MENU";
const WATCHER_SERVICE: &str = "org.kde.StatusNotifierWatcher";
const WATCHER_PATH: &str = "/StatusNotifierWatcher";

/// 启动托盘驻留（幂等、绝不 panic）。
#[must_use]
pub fn start(title: &str, callbacks: TrayCallbacks) -> TrayHandle {
    if std::env::var_os("DBUS_SESSION_BUS_ADDRESS").is_none() {
        return unsupported(TrayStatus::NoSessionBus);
    }
    let Ok(connection) = zbus::blocking::Connection::session() else {
        return unsupported(TrayStatus::BusUnavailable);
    };
    let pid = std::process::id();
    let Ok(()) = connection.request_name(format!("org.kde.StatusNotifierItem-{pid}-1")) else {
        return unsupported(TrayStatus::BusUnavailable);
    };
    let Ok(menu) = OwnedObjectPath::try_from(MENU_PATH) else {
        return unsupported(TrayStatus::BusUnavailable);
    };
    let item = StatusNotifierItem {
        id: String::from("quetzalcoatl-desktop"),
        title: title.to_owned(),
        status: String::from("Active"),
        icon_name: String::from("org.quetzalcoatl.Desktop"),
        menu,
        callbacks: std::sync::Arc::new(callbacks),
    };
    if connection.object_server().at(ITEM_PATH, item).is_err() {
        return unsupported(TrayStatus::BusUnavailable);
    }
    let status = if connection
        .call_method(
            Some(WATCHER_SERVICE),
            WATCHER_PATH,
            Some(WATCHER_SERVICE),
            "RegisterStatusNotifierItem",
            &(ITEM_PATH,),
        )
        .is_ok()
    {
        TrayStatus::Registered
    } else {
        TrayStatus::NoWatcher
    };
    TrayHandle {
        status,
        _connection: Some(connection),
    }
}

fn unsupported(status: TrayStatus) -> TrayHandle {
    eprintln!(
        "quetzalcoatl-desktop: 托盘降级为 `{}`（不影响窗口）",
        status.label()
    );
    TrayHandle {
        status,
        _connection: None,
    }
}

/// StatusNotifierItem 的最小可用实现（只暴露宿主真正会查询的属性）。
struct StatusNotifierItem {
    id: String,
    title: String,
    status: String,
    icon_name: String,
    menu: OwnedObjectPath,
    callbacks: std::sync::Arc<TrayCallbacks>,
}

#[zbus::interface(name = "org.kde.StatusNotifierItem")]
impl StatusNotifierItem {
    #[zbus(property)]
    fn category(&self) -> &str {
        "ApplicationStatus"
    }

    #[zbus(property)]
    fn id(&self) -> &str {
        &self.id
    }

    #[zbus(property)]
    fn title(&self) -> &str {
        &self.title
    }

    #[zbus(property)]
    fn status(&self) -> &str {
        &self.status
    }

    #[zbus(property)]
    fn window_id(&self) -> i32 {
        0
    }

    #[zbus(property)]
    fn icon_name(&self) -> &str {
        &self.icon_name
    }

    #[zbus(property)]
    fn icon_theme_path(&self) -> &str {
        ""
    }

    #[zbus(property)]
    fn item_is_menu(&self) -> bool {
        false
    }

    #[zbus(property)]
    fn menu(&self) -> OwnedObjectPath {
        self.menu.clone()
    }

    #[zbus(property)]
    fn attention_icon_name(&self) -> &str {
        ""
    }

    #[zbus(property)]
    fn overlay_icon_name(&self) -> &str {
        ""
    }

    fn activate(&self, _x: i32, _y: i32) {
        (self.callbacks.on_activate)();
    }

    fn secondary_activate(&self, _x: i32, _y: i32) {
        (self.callbacks.on_activate)();
    }

    fn context_menu(&self, _x: i32, _y: i32) {
        (self.callbacks.on_context_menu)();
    }

    fn scroll(&self, _delta: i32, _orientation: &str) {}
}
