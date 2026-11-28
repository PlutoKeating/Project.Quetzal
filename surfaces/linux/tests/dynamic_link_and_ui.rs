#![forbid(unsafe_code)]
#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

//! 治理面验收测试：Linux 纯原生桌面端的 ELF 动态链接合规，以及「只看和签」的治理面——
//! 九页都能从真实守护进程读出、没有给他发一句话的输入框、守护进程不在线时整页保留上一次的内容、
//! 写动作（改、不主动提、抹除、签署、迎合）真的落到守护进程、token 与样式层不漂移。
//! GTK 必须跑在进程主线程里，所以每个需要窗口的用例都由父测试以 `xvfb` 子进程驱动。
//!
//! ## 为什么必须断言 `libadwaita-1` 是**动态**链接（LGPL-2.1 合规说明）
//!
//! `libadwaita-1` 以 LGPL-2.1-or-later 发布。LGPL 允许专有/`Apache-2.0` 程序链接它，
//! 但前提是终端用户能够用修改过的库版本替换该库（LGPL-2.1 §6）。这一可替换性只有在
//! **动态链接**（`DT_NEEDED` 记录 soname、符号在运行时由 `ld.so` 解析）时才成立；
//! 一旦把 Adwaita 的符号静态并入我们的 `Apache-2.0` 可执行文件，就构成 LGPL §6 意义上的
//! 组合作品，整个二进制必须按 LGPL 分发，与本仓库的双层许可边界冲突。
//!
//! 因此本文件同时断言三件事：
//! 1. `readelf -d` 的 `NEEDED` 条目包含 `libadwaita-1.so.*` 与 `libgtk-4.so.*`；
//! 2. `ldd` 能解析到这两个共享库（没有 `not found`）；
//! 3. `nm -D -u`（动态未定义符号）里出现 `adw_*`/`gtk_*` 导入，而普通符号表
//!    （`nm --defined-only`，即静态并入的 `.text` 符号）里 `adw_*` 定义数为 0。
//!
//! `cargo` 层面不存在 `libadwaita` 的静态依赖：它只通过 `pkg-config` 探测系统库，
//! 因此 `deny.toml` 的许可证白名单不需要为 LGPL 开口子。

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use gtk::glib;
use libadwaita as adw;
use quetzalcoatl_daemon::{DaemonConfig, IpcClient, IpcRequest, IpcResponse, QuetzalcoatlDaemon};
use quetzalcoatl_desktop::app::{self, DesktopOptions};
use quetzalcoatl_desktop::routes::{PAGES, PageKey};
use uuid::Uuid;

use gtk::prelude::*;
use gtk4 as gtk;

const CHILD_TRAY_OUT: &str = "QZ_DESKTOP_TRAY_PROBE_OUT";
const CHILD_LIFECYCLE_OUT: &str = "QZ_DESKTOP_LIFECYCLE_PROBE_OUT";
const CHILD_TRAY_PROGRESS: &str = "QZ_DESKTOP_TRAY_PROBE_PROGRESS";
const CHILD_GOV_OUT: &str = "QZ_DESKTOP_GOV_PROBE_OUT";
const CHILD_GOV_MODE: &str = "QZ_DESKTOP_GOV_PROBE_MODE";
const CHILD_GOV_WIDTH: &str = "QZ_DESKTOP_GOV_PROBE_WIDTH";
const CHILD_GOV_SYNC: &str = "QZ_DESKTOP_GOV_PROBE_SYNC";
const SHOT_DIR_ENV: &str = "QZ_DESKTOP_SHOTS";

struct TempDir {
    path: PathBuf,
}

impl TempDir {
    fn new(tag: &str) -> Self {
        let base = PathBuf::from("/tmp/opencode");
        let parent = if base.is_dir() {
            base
        } else {
            std::env::temp_dir()
        };
        let path = parent.join(format!("qz_desktop_{tag}_{}", Uuid::new_v4().simple()));
        fs::create_dir_all(&path).expect("create temp dir");
        Self { path }
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

fn binary() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_quetzalcoatl-desktop"))
}

fn manifest_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn adw_application() -> adw::Application {
    adw::Application::builder()
        .application_id("org.quetzalcoatl.DesktopProbe")
        .flags(gtk::gio::ApplicationFlags::NON_UNIQUE)
        .build()
}

fn spawn_probe(name: &str, use_dbus_session: bool) -> Command {
    let exe = std::env::current_exe().expect("current exe");
    let mut command = headless_command(exe);
    if use_dbus_session {
        // `xvfb-run -a dbus-run-session -- <exe>`：私有会话总线 + 独立 X display。
        command = headless_command("dbus-run-session");
        command.arg("--");
        command.arg(std::env::current_exe().expect("current exe"));
        command.env_remove("DBUS_SESSION_BUS_ADDRESS");
    }
    command
        .arg("--exact")
        .arg(name)
        .arg("--ignored")
        .arg("--nocapture")
        .stdin(Stdio::null());
    command
}

fn run_capture(program: &str, args: &[&str]) -> (bool, String) {
    let output = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .output()
        .unwrap_or_else(|e| panic!("无法执行 {program}: {e}"));
    let mut text = String::from_utf8_lossy(&output.stdout).into_owned();
    text.push_str(&String::from_utf8_lossy(&output.stderr));
    (output.status.success(), text)
}

/// 真实进程存活检查：读取 `/proc/<pid>/stat`，并排除僵尸态。
fn process_alive(pid: u32) -> bool {
    match fs::read_to_string(format!("/proc/{pid}/stat")) {
        Ok(stat) => !stat.contains(") Z "),
        Err(_) => false,
    }
}

fn headless_command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    let mut command = Command::new("xvfb-run");
    command
        .arg("-a")
        // xvfb-run 把 -s 后面的一整段原样交给 Xvfb，这里必须是一个参数。
        .args(["-s", "-screen 0 1600x1100x24"])
        .arg(program)
        .stdin(Stdio::null())
        .env("GDK_BACKEND", "x11")
        .env_remove("WAYLAND_DISPLAY")
        .env_remove("EGL_PLATFORM")
        // 宿主 AppImage 注入的 LD_LIBRARY_PATH/GSETTINGS_SCHEMA_DIR 会污染 cargo 与
        // GTK 的系统库解析，无头子进程必须回到干净的系统路径。
        .env_remove("LD_LIBRARY_PATH")
        .env_remove("GSETTINGS_SCHEMA_DIR")
        .env_remove("GTK_MODULES");
    command
}

fn wait_for_daemon_runtime(home: &Path) {
    let deadline = Instant::now() + Duration::from_secs(15);
    while Instant::now() < deadline {
        if home.join("run/daemon.json").is_file() && home.join("run/daemon.token").is_file() {
            return;
        }
        thread::sleep(Duration::from_millis(20));
    }
    panic!("quetzalcoatld 运行时文件未在 15s 内出现");
}

fn start_real_daemon(home: &Path) -> quetzalcoatl_daemon::DaemonHandle {
    let mut config = DaemonConfig::new(home.to_path_buf());
    config.fabric = None;
    config.discovery_search_paths = Some(Vec::new());
    let daemon = QuetzalcoatlDaemon::start(config).expect("真实守护进程启动");
    wait_for_daemon_runtime(home);
    daemon
}

/// 一棵控件树的输入面清点（含当前不可见的页面与控件）。
struct InputSurface {
    /// 遍历到的控件总数（防空转：树必须真的被走过）。
    widgets: usize,
    /// 可编辑输入控件：最近一层有名字的祖先（含自己）的名字。
    editable: Vec<String>,
    /// 文案或图标带「发送」含义的按钮。
    send_buttons: Vec<String>,
    /// 全部按钮文案。
    buttons: Vec<String>,
}

fn walk_widgets(root: &gtk::Widget, visit: &mut dyn FnMut(&gtk::Widget)) {
    visit(root);
    let mut child = root.first_child();
    while let Some(node) = child {
        walk_widgets(&node, visit);
        child = node.next_sibling();
    }
}

/// 一个控件里能看见的全部文字。
fn visible_text(root: &impl IsA<gtk::Widget>) -> String {
    let mut parts = Vec::new();
    walk_widgets(root.as_ref(), &mut |widget| {
        if let Some(label) = widget.dynamic_cast_ref::<gtk::Label>() {
            parts.push(label.label().to_string());
        }
    });
    parts.join(" ")
}

/// 最近一层有名字的祖先（含自己）的名字；没有就回到类型名。
fn owner_name(widget: &gtk::Widget) -> String {
    let mut node = Some(widget.clone());
    while let Some(current) = node {
        let name = current.widget_name();
        let generic = current.type_().name().to_owned();
        if !name.is_empty() && name.as_str() != generic {
            return name.to_string();
        }
        node = current.parent();
    }
    widget.type_().name().to_owned()
}

fn input_surface(root: &impl IsA<gtk::Widget>) -> InputSurface {
    let mut surface = InputSurface {
        widgets: 0,
        editable: Vec::new(),
        send_buttons: Vec::new(),
        buttons: Vec::new(),
    };
    walk_widgets(root.as_ref(), &mut |widget| {
        surface.widgets += 1;
        let editable = widget
            .dynamic_cast_ref::<gtk::Editable>()
            .is_some_and(|input| input.is_editable())
            || widget
                .dynamic_cast_ref::<gtk::TextView>()
                .is_some_and(|input| input.is_editable());
        // `GtkText` 是 `Entry`/`SearchEntry`/`PasswordEntry` 的内部代理，只记最外层那个。
        let delegate = widget.type_().name() == "GtkText";
        if editable && !delegate {
            surface.editable.push(owner_name(widget));
        }
        if let Some(button) = widget.dynamic_cast_ref::<gtk::Button>() {
            let caption = button
                .label()
                .map(|label| label.to_string())
                .unwrap_or_else(|| visible_text(button))
                .trim()
                .to_owned();
            let icon = button
                .icon_name()
                .map(|name| name.to_string())
                .unwrap_or_default();
            if caption.contains("发送")
                || caption.to_lowercase().contains("send")
                || icon.contains("send")
            {
                surface.send_buttons.push(format!("{caption} {icon}"));
            }
            surface.buttons.push(caption);
        }
    });
    surface
}

// ---------------------------------------------------------------------------
// 1. ELF 动态链接合规（LGPL-2.1）
// ---------------------------------------------------------------------------

#[test]
fn adwaita_and_gtk_are_dynamically_linked_and_never_statically_embedded() {
    let bin = binary();
    let bin_str = bin.to_string_lossy().into_owned();
    assert!(bin.is_file(), "桌面可执行文件不存在: {}", bin.display());

    let (ok, dynamic) = run_capture("readelf", &["-d", &bin_str]);
    assert!(ok, "readelf -d 失败: {dynamic}");
    for soname in ["libadwaita-1.so", "libgtk-4.so"] {
        assert!(
            dynamic
                .lines()
                .any(|line| line.contains("(NEEDED)") && line.contains(soname)),
            "DT_NEEDED 必须包含动态共享库 {soname}（LGPL-2.1 §6 可替换性），实际:\n{dynamic}"
        );
    }

    let (ok, ldd) = run_capture("ldd", &[&bin_str]);
    assert!(ok, "ldd 失败: {ldd}");
    assert!(
        !ldd.contains("not found"),
        "存在未解析的共享库依赖，LGPL 动态链接不成立:\n{ldd}"
    );
    for soname in ["libadwaita-1.so", "libgtk-4.so"] {
        assert!(
            ldd.lines().any(|line| line.contains(soname)),
            "ldd 未解析到 {soname}:\n{ldd}"
        );
    }
    // 纯原生：绝不允许 WebView 套壳（AGENTS.md §4 明令禁止 Electron/Tauri/WebKitGTK）。
    assert!(
        !ldd.contains("libwebkit2gtk") && !ldd.contains("libwebkitgtk"),
        "桌面端禁止链接任何 WebView 运行时:\n{ldd}"
    );

    let (ok, imports) = run_capture("nm", &["-D", "-u", &bin_str]);
    assert!(ok, "nm -D -u 失败: {imports}");
    let adw_imports = imports
        .lines()
        .filter(|line| line.trim_end().ends_with(" adw_") || line.contains(" adw_"))
        .count();
    let gtk_imports = imports
        .lines()
        .filter(|line| line.contains(" gtk_"))
        .count();
    assert!(
        adw_imports > 20,
        "动态未定义符号里应出现大量 adw_* 导入（实际 {adw_imports}）"
    );
    assert!(
        gtk_imports > 30,
        "动态未定义符号里应出现成规模的 gtk_* 导入（实际 {gtk_imports}）"
    );

    // 静态并入会把 `adw_*` 变成我们自己的 `.text` 定义；LGPL-2.1 可替换性随即失效。
    // 剥离符号表的 release 产物没有 `.symtab`，此断言无从判定，必须显式跳过而不是「空即通过」。
    let (_, sections) = run_capture("readelf", &["-S", &bin_str]);
    if sections.contains(".symtab") {
        let (defined_ok, defined) = run_capture("nm", &["--defined-only", &bin_str]);
        assert!(defined_ok, "nm --defined-only 失败: {defined}");
        let adw_defined = defined
            .lines()
            .filter(|line| line.contains(" adw_"))
            .count();
        assert_eq!(
            adw_defined, 0,
            "二进制自身符号表禁止出现 adw_* 定义（说明 libadwaita 被静态并入）:\n{defined}"
        );
    } else {
        eprintln!("SKIP: 二进制被剥离符号表（无 .symtab），改用 DT_NEEDED 断言兜底");
    }
}

// ---------------------------------------------------------------------------
// 5. 构建集成：桌面规范文件、图标占位与安装说明
// ---------------------------------------------------------------------------

#[test]
fn desktop_entry_icon_and_readme_install_rules_are_present() {
    let resources = manifest_dir().join("resources");
    let entry = fs::read_to_string(resources.join("org.quetzalcoatl.Desktop.desktop"))
        .expect("缺少 .desktop 规范文件");
    for required in [
        "[Desktop Entry]",
        "Type=Application",
        "Name=Quetzalcoatl",
        "Exec=quetzalcoatl-desktop",
        "Icon=org.quetzalcoatl.Desktop",
        "Categories=Utility;Office;",
        "StartupWMClass=org.quetzalcoatl.Desktop",
        "DBusActivatable=false",
    ] {
        assert!(
            entry.lines().any(|line| line.trim() == required),
            ".desktop 缺少必需行 `{required}`:\n{entry}"
        );
    }
    assert!(
        !entry.to_lowercase().contains("webview"),
        ".desktop 不得声明任何 WebView 相关项"
    );

    let icon = resources.join("org.quetzalcoatl.Desktop.svg");
    let svg = fs::read_to_string(&icon).expect("缺少图标占位");
    assert!(svg.contains("<svg"));
    assert!(svg.contains("aria-label"));

    let readme = fs::read_to_string(manifest_dir().join("README.md")).expect("缺少 README");
    for required in [
        "quetzalcoatl-desktop",
        "install",
        ".desktop",
        "libadwaita",
        "LGPL-2.1",
        "--self-test",
        "Ctrl+1",
    ] {
        assert!(
            readme.to_lowercase().contains(&required.to_lowercase()),
            "README 缺少安装/合规说明 `{required}`"
        );
    }

    let manifest = fs::read_to_string(manifest_dir().join("Cargo.toml")).expect("Cargo.toml");
    assert!(manifest.contains("name = \"quetzalcoatl-desktop\""));
    assert!(!manifest.contains("webkit2gtk"));
    assert!(!manifest.contains("tauri"));
    assert!(!manifest.contains("electron"));
}

// ---------------------------------------------------------------------------
// 9. 托盘驻留：关闭隐藏 → 托盘唤醒 → 托盘菜单退出；无宿主时关闭即退出
// ---------------------------------------------------------------------------

struct StubWatcher;

#[zbus::interface(name = "org.kde.StatusNotifierWatcher")]
impl StubWatcher {
    fn register_status_notifier_item(&self, _service: &str) {}

    #[zbus(property)]
    fn is_status_notifier_host_registered(&self) -> bool {
        true
    }
}

fn install_stub_watcher() -> Option<zbus::blocking::Connection> {
    let connection = zbus::blocking::Connection::session().ok()?;
    connection
        .request_name("org.kde.StatusNotifierWatcher")
        .ok()?;
    connection
        .object_server()
        .at("/StatusNotifierWatcher", StubWatcher)
        .ok()?;
    Some(connection)
}

#[test]
#[ignore = "由父测试以子进程方式驱动（xvfb + 私有 D-Bus 会话 + 桩 Watcher）"]
fn tray_child_probe() {
    let Some(out_path) = std::env::var_os(CHILD_TRAY_OUT).map(PathBuf::from) else {
        return;
    };
    let progress_path = std::env::var_os(CHILD_TRAY_PROGRESS)
        .map(PathBuf::from)
        .unwrap_or_else(|| out_path.with_extension("progress"));
    let mut report = serde_json::json!({ "ok": false });
    let Some(_watcher) = install_stub_watcher() else {
        report["error"] = serde_json::Value::String(String::from(
            "私有会话总线上无法注册桩 StatusNotifierWatcher",
        ));
        let _ = fs::write(&out_path, report.to_string());
        return;
    };
    let home = quetzalcoatl_daemon::resolve_quetzalcoatl_home(None);
    let config_path = out_path.with_extension("desktop.json");
    let checks = std::rc::Rc::new(std::cell::RefCell::new(Vec::<(String, bool)>::new()));
    let tray_status = std::rc::Rc::new(std::cell::RefCell::new(String::from("unknown")));
    let fallback = std::rc::Rc::new(std::cell::Cell::new(false));
    let step = std::rc::Rc::new(std::cell::Cell::new(0u32));

    let code = app::run_with_hook(
        DesktopOptions {
            home,
            config_path: Some(config_path),
            self_test: false,
        },
        {
            let checks = checks.clone();
            let tray_status = tray_status.clone();
            let fallback = fallback.clone();
            let step = step.clone();
            move |app, desktop| {
                let item_name = format!("org.kde.StatusNotifierItem-{}-1", std::process::id());
                let bus = zbus::blocking::Connection::session().expect("session bus");
                let record = {
                    let checks = checks.clone();
                    move |name: &str, value: bool| {
                        checks.borrow_mut().push((String::from(name), value));
                    }
                };
                let safety_app = app.clone();
                let loop_app = app.clone();
                let safety_fallback = fallback.clone();
                let progress_path = progress_path.clone();
                glib::timeout_add_local_once(Duration::from_secs(12), move || {
                    safety_fallback.set(true);
                    safety_app.quit();
                });
                glib::timeout_add_local(Duration::from_millis(250), move || {
                    let current = step.get();
                    match current {
                        0 => {
                            let state = desktop.borrow();
                            *tray_status.borrow_mut() = quetzalcoatl_desktop::tray::status_label(
                                &state.widgets.tray_status,
                            )
                            .to_string();
                            record("tray_registered", state.widgets.tray_status.is_active());
                            record("visible_before_close", state.window.is_visible());
                            let window = state.window.clone();
                            drop(state);
                            window.close();
                        }
                        1 => {
                            let hidden = {
                                let state = desktop.borrow();
                                !state.window.is_visible()
                            };
                            record("hidden_after_close", hidden);
                            // 真实存活检查（/proc/<pid>/stat，且非僵尸），不再是常量。
                            record(
                                "process_alive_after_close",
                                process_alive(std::process::id()),
                            );
                            let _ = fs::write(&progress_path, std::process::id().to_string());
                            let _ = bus.call_method(
                                Some(item_name.as_str()),
                                "/StatusNotifierItem",
                                Some("org.kde.StatusNotifierItem"),
                                "Activate",
                                &(0i32, 0i32),
                            );
                        }
                        2 => {
                            let reactivated = {
                                let state = desktop.borrow();
                                state.window.is_visible()
                            };
                            record("reactivated", reactivated);
                            let _ = bus.call_method(
                                Some(item_name.as_str()),
                                "/StatusNotifierItem",
                                Some("org.kde.StatusNotifierItem"),
                                "ContextMenu",
                                &(0i32, 0i32),
                            );
                        }
                        3 => {
                            record("tray_menu_visible", loop_app.windows().len() >= 2);
                            let quit_registered = loop_app
                                .list_actions()
                                .iter()
                                .any(|action| action.as_str() == "quit");
                            record("quit_action_present", quit_registered);
                            loop_app.activate_action("quit", None);
                        }
                        _ => {}
                    }
                    step.set(current + 1);
                    if current >= 3 {
                        glib::ControlFlow::Break
                    } else {
                        glib::ControlFlow::Continue
                    }
                });
            }
        },
    );

    let checks = checks.borrow().clone();
    let all_ok = checks.iter().all(|(_, value)| *value);
    report = serde_json::json!({
        "ok": all_ok && !fallback.get(),
        "checks": checks,
        "tray": tray_status.borrow().clone(),
        "fallback_fired": fallback.get(),
        "exit_code": code.get(),
        "pid": std::process::id(),
        "pid_alive_at_report": process_alive(std::process::id()),
    });
    fs::write(&out_path, report.to_string()).expect("写入托盘探针报告");
}

#[test]
fn tray_hides_on_close_reactivates_and_quits() {
    let home = TempDir::new("tray_probe");
    let out = home.path().join("tray.json");
    let progress = home.path().join("tray.progress");
    let child = spawn_probe("tray_child_probe", true)
        .env(CHILD_TRAY_OUT, &out)
        .env(CHILD_TRAY_PROGRESS, &progress)
        .env("QUETZALCOATL_HOME", home.path().join("home"))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn tray probe");

    // 外部证据：子进程在关窗后把「自己的真实 pid」写进 progress 文件；
    // 父进程据此观察 /proc/<pid> 仍存在（hold 生效），Quit 后必须消失。
    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline && !progress.is_file() {
        thread::sleep(Duration::from_millis(50));
    }
    assert!(
        progress.is_file(),
        "托盘探针未在关窗后写出 progress 标记（进程可能提前退出）"
    );
    let pid_text = fs::read_to_string(&progress).expect("读取 progress pid");
    let pid: u32 = pid_text.trim().parse().expect("progress 中必须是真实 pid");
    let mut alive_observed = false;
    let observe_deadline = Instant::now() + Duration::from_secs(1);
    while Instant::now() < observe_deadline && !alive_observed {
        alive_observed = process_alive(pid);
        thread::sleep(Duration::from_millis(20));
    }
    assert!(
        alive_observed,
        "关闭主窗口后父进程必须能观察到子进程 {pid} 仍存活（app.hold() 生效）"
    );

    let output = child.wait_with_output().expect("wait tray probe");
    assert!(
        output.status.success(),
        "托盘探针失败: stdout={} stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        !process_alive(pid),
        "Quit 动作后子进程必须真正退出（/proc/{pid} 不再存在）"
    );
    let report: serde_json::Value =
        serde_json::from_slice(&fs::read(&out).expect("读取托盘报告")).expect("JSON");
    assert_eq!(
        report["ok"],
        serde_json::Value::Bool(true),
        "报告: {report}"
    );
    assert_eq!(report["tray"].as_str(), Some("registered"), "{report}");
    assert_eq!(report["fallback_fired"], serde_json::Value::Bool(false));
    assert_eq!(report["pid"].as_u64(), Some(u64::from(pid)));
    assert_eq!(report["pid_alive_at_report"], serde_json::Value::Bool(true));
    let checks = report["checks"].as_array().expect("checks");
    for expected in [
        "tray_registered",
        "visible_before_close",
        "hidden_after_close",
        "process_alive_after_close",
        "reactivated",
        "tray_menu_visible",
        "quit_action_present",
    ] {
        assert!(
            checks.iter().any(
                |entry| entry[0].as_str() == Some(expected) && entry[1].as_bool() == Some(true)
            ),
            "缺少通过项 {expected}: {report}"
        );
    }
}

#[test]
#[ignore = "由父测试以子进程方式驱动（xvfb，无 D-Bus 会话）"]
fn lifecycle_child_probe() {
    let Some(out_path) = std::env::var_os(CHILD_LIFECYCLE_OUT).map(PathBuf::from) else {
        return;
    };
    let home = quetzalcoatl_daemon::resolve_quetzalcoatl_home(None);
    let config_path = out_path.with_extension("desktop.json");
    let fallback = std::rc::Rc::new(std::cell::Cell::new(false));
    let tray_status = std::rc::Rc::new(std::cell::RefCell::new(String::from("unknown")));
    let closed = std::rc::Rc::new(std::cell::Cell::new(false));
    let code = app::run_with_hook(
        DesktopOptions {
            home,
            config_path: Some(config_path),
            self_test: false,
        },
        {
            let fallback = fallback.clone();
            let tray_status = tray_status.clone();
            let closed = closed.clone();
            move |app, desktop| {
                let status =
                    quetzalcoatl_desktop::tray::status_label(&desktop.borrow().widgets.tray_status)
                        .to_string();
                *tray_status.borrow_mut() = status;
                let safety_app = app.clone();
                let safety_fallback = fallback.clone();
                glib::timeout_add_local_once(Duration::from_secs(8), move || {
                    safety_fallback.set(true);
                    safety_app.quit();
                });
                glib::timeout_add_local_once(Duration::from_millis(300), move || {
                    closed.set(true);
                    let window = desktop.borrow().window.clone();
                    window.close();
                });
            }
        },
    );
    let report = serde_json::json!({
        "ok": closed.get()
            && !fallback.get()
            && tray_status.borrow().as_str() == "no-session-bus"
            && code.get() == 0,
        "closed": closed.get(),
        "fallback_fired": fallback.get(),
        "tray": tray_status.borrow().clone(),
        "exit_code": code.get(),
    });
    fs::write(&out_path, report.to_string()).expect("写入生命周期探针报告");
}

#[test]
fn close_exits_without_tray_host() {
    let home = TempDir::new("lifecycle_probe");
    let out = home.path().join("lifecycle.json");
    let output = spawn_probe("lifecycle_child_probe", false)
        .env(CHILD_LIFECYCLE_OUT, &out)
        .env("QUETZALCOATL_HOME", home.path().join("home"))
        .env_remove("DBUS_SESSION_BUS_ADDRESS")
        .output()
        .expect("spawn lifecycle probe");
    assert!(
        output.status.success(),
        "生命周期探针失败: stdout={} stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let report: serde_json::Value =
        serde_json::from_slice(&fs::read(&out).expect("读取生命周期报告")).expect("JSON");
    assert_eq!(
        report["ok"],
        serde_json::Value::Bool(true),
        "报告: {report}"
    );
    assert_eq!(report["tray"].as_str(), Some("no-session-bus"));
    assert_eq!(report["fallback_fired"], serde_json::Value::Bool(false));
}

// ---------------------------------------------------------------------------
// 3. 样式层：token 不漂移、只有两种语义色、GTK 能解析
// ---------------------------------------------------------------------------

fn governance_css() -> &'static str {
    quetzalcoatl_desktop::style::GOVERNANCE_CSS
}

fn design_tokens() -> String {
    let root = manifest_dir().join("../../packages/design-system/tokens");
    fs::read_to_string(root.join("colors.css")).expect("读取设计系统 colors.css")
}

fn token_value(css: &str, name: &str) -> String {
    let needle = format!("{name}:");
    let line = css
        .lines()
        .find(|line| line.trim_start().starts_with(&needle))
        .unwrap_or_else(|| panic!("设计系统里没有 {name}"));
    line.split(':')
        .nth(1)
        .expect("token 有值")
        .split(';')
        .next()
        .expect("token 以分号结束")
        .trim()
        .to_owned()
}

fn gtk_color(css: &str, name: &str) -> String {
    let needle = format!("@define-color {name} ");
    let line = css
        .lines()
        .find(|line| line.starts_with(&needle))
        .unwrap_or_else(|| panic!("GTK 样式里没有 {name}"));
    line[needle.len()..].trim_end_matches(';').trim().to_owned()
}

#[test]
fn gtk_colors_stay_in_sync_with_the_design_system_tokens() {
    let tokens = design_tokens();
    let css = governance_css();
    for (gtk_name, token) in [
        ("qz_void", "--qz-void"),
        ("qz_surface", "--qz-surface"),
        ("qz_well", "--qz-well"),
        ("qz_ink", "--qz-ink"),
        ("qz_ink_soft", "--qz-ink-soft"),
        ("qz_ink_support", "--qz-ink-support"),
        ("qz_ink_secondary", "--qz-ink-secondary"),
        ("qz_ink_quiet", "--qz-ink-quiet"),
        ("qz_ink_muted", "--qz-ink-muted"),
        ("qz_line_hairline", "--qz-hairline"),
        ("qz_line_border", "--qz-border"),
        ("qz_line_rail", "--qz-line-rail"),
        ("qz_line_control", "--qz-line-control"),
        ("qz_line_strong", "--qz-border-strong"),
        ("qz_line_mark", "--qz-line-mark"),
        ("qz_line_hover", "--qz-line-hover"),
        ("qz_fill_hover", "--qz-fill-hover"),
        ("qz_fill_selected", "--qz-fill-selected"),
        ("qz_fill_active", "--qz-fill-active"),
        ("qz_ice", "--qz-ice"),
        ("qz_amber", "--qz-amber"),
    ] {
        assert_eq!(
            gtk_color(css, gtk_name).replace(' ', ""),
            token_value(&tokens, token).replace(' ', ""),
            "GTK 的 {gtk_name} 与设计系统的 {token} 不一致"
        );
    }
    // 纯黑底、两种语义色：这三个值是整套视觉的地基。
    assert_eq!(gtk_color(css, "qz_void"), "#000000");
    assert_eq!(gtk_color(css, "qz_ice"), "#bae6fd");
    assert_eq!(gtk_color(css, "qz_amber"), "#e5a03d");
}

#[test]
fn only_ice_and_amber_are_chromatic_and_weights_stay_in_the_scale() {
    let css = governance_css();
    // 每一个十六进制颜色：要么无彩（R=G=B），要么正是冰蓝或琥珀。
    let mut hex_seen = 0;
    for (index, _) in css.match_indices('#') {
        let hex: String = css[index + 1..]
            .chars()
            .take_while(char::is_ascii_hexdigit)
            .collect();
        if hex.len() != 6 {
            continue;
        }
        hex_seen += 1;
        let (r, g, b) = (&hex[0..2], &hex[2..4], &hex[4..6]);
        let achromatic = r == g && g == b;
        assert!(
            achromatic || hex == "bae6fd" || hex == "e5a03d",
            "样式层出现了第三种颜色 #{hex}"
        );
    }
    assert!(hex_seen > 20, "颜色清点可能空转");
    // rgba 只允许白（线与填充）、黑（模糊底）与琥珀/冰蓝的发光。
    for (index, _) in css.match_indices("rgba(") {
        let args: String = css[index + 5..].chars().take_while(|c| *c != ')').collect();
        let parts: Vec<&str> = args.split(',').map(str::trim).collect();
        let (r, g, b) = (parts[0], parts[1], parts[2]);
        assert!(
            (r == g && g == b)
                || args.starts_with("229, 160, 61")
                || args.starts_with("186, 230, 253"),
            "rgba({args}) 不是无彩色"
        );
    }
    for (index, _) in css.match_indices("font-weight:") {
        let value: String = css[index + 12..]
            .chars()
            .take_while(|c| *c != ';')
            .collect::<String>()
            .trim()
            .to_owned();
        assert!(
            matches!(value.as_str(), "400" | "500" | "600" | "inherit"),
            "字重 {value} 不在 400/500/600 之内"
        );
    }
    // 每一对「文字色 + 黑底」都要够读：冰蓝与琥珀对纯黑的对比度。
    fn luminance(hex: &str) -> f64 {
        let channel = |at: usize| {
            let v = f64::from(u8::from_str_radix(&hex[at..at + 2], 16).expect("hex")) / 255.0;
            if v <= 0.03928 {
                v / 12.92
            } else {
                ((v + 0.055) / 1.055).powf(2.4)
            }
        };
        0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4)
    }
    for hex in ["bae6fd", "e5a03d", "8a8a8a", "b5b5b5"] {
        let ratio = (luminance(hex) + 0.05) / 0.05;
        assert!(ratio >= 4.5, "#{hex} 对纯黑的对比度只有 {ratio:.2}");
    }
}

#[test]
fn bundled_fonts_are_present_with_their_licenses() {
    let dir = manifest_dir().join("resources/fonts");
    for name in [
        "sora-latin-400-normal.ttf",
        "sora-latin-500-normal.ttf",
        "sora-latin-600-normal.ttf",
        "jetbrains-mono-latin-400-normal.ttf",
        "jetbrains-mono-latin-500-normal.ttf",
        "LICENSE-sora.txt",
        "LICENSE-jetbrains-mono.txt",
    ] {
        assert!(dir.join(name).is_file(), "缺少随包字体或许可证 {name}");
    }
    let css = governance_css();
    assert!(css.contains("\"Sora\"") && css.contains("\"JetBrains Mono\""));
}

// ---------------------------------------------------------------------------
// 4. 治理面子进程探针（xvfb + 真实守护进程）
// ---------------------------------------------------------------------------

fn find_named(root: &impl IsA<gtk::Widget>, name: &str) -> Option<gtk::Widget> {
    let mut found = None;
    walk_widgets(root.as_ref(), &mut |widget| {
        if found.is_none() && widget.widget_name() == name {
            found = Some(widget.clone());
        }
    });
    found
}

fn find_prefixed(root: &impl IsA<gtk::Widget>, prefix: &str) -> Vec<gtk::Widget> {
    let mut found = Vec::new();
    walk_widgets(root.as_ref(), &mut |widget| {
        if widget.widget_name().starts_with(prefix) {
            found.push(widget.clone());
        }
    });
    found
}

fn click_named(root: &impl IsA<gtk::Widget>, name: &str) -> bool {
    match find_named(root, name).and_then(|w| w.downcast::<gtk::Button>().ok()) {
        Some(button) => {
            button.emit_clicked();
            true
        }
        None => false,
    }
}

/// 点一整行（行本身是一个容器，里面第一个按钮才是选取按钮）。
fn click_first_button_in(container: &gtk::Widget) -> bool {
    let mut target = None;
    walk_widgets(container, &mut |widget| {
        if target.is_none()
            && let Some(button) = widget.dynamic_cast_ref::<gtk::Button>()
        {
            target = Some(button.clone());
        }
    });
    match target {
        Some(button) => {
            button.emit_clicked();
            true
        }
        None => false,
    }
}

fn wait_for_any(root: &impl IsA<gtk::Widget>, names: &[&str], timeout_ms: u64) -> bool {
    app::pump_until(timeout_ms, || {
        names.iter().any(|name| find_named(root, name).is_some())
    })
}

/// 每一页「已经读出来」的标志（任一出现即可）。
fn ready_markers(key: PageKey) -> &'static [&'static str] {
    match key {
        PageKey::Overview => &["agent-name"],
        PageKey::SelfPage => &["core-values", "changes", "identity", "situation-self-empty"],
        PageKey::User => &["user-columns", "situation-user-empty"],
        PageKey::Us => &["scale"],
        PageKey::Memories => &["memory-split", "memory-list"],
        PageKey::Baseline => &["clauses", "situation-baseline-empty"],
        PageKey::Hosts => &[
            "host-checks",
            "situation-hosts-empty",
            "host-not-installed",
            "host-not-connected",
        ],
        PageKey::Devices => &["this-device-rail"],
        PageKey::Audit => &["audit-timeline", "situation-audit-empty"],
    }
}

fn screenshot(widget: &impl IsA<gtk::Widget>, path: &Path) -> bool {
    use gtk::gdk::prelude::PaintableExt;
    let (width, height) = (widget.width(), widget.height());
    if width <= 0 || height <= 0 {
        return false;
    }
    let paintable = gtk::WidgetPaintable::new(Some(widget));
    let snapshot = gtk::Snapshot::new();
    paintable.snapshot(&snapshot, f64::from(width), f64::from(height));
    let Some(node) = snapshot.to_node() else {
        return false;
    };
    let Some(renderer) = widget.native().and_then(|native| native.renderer()) else {
        return false;
    };
    renderer
        .render_texture(&node, None)
        .save_to_png(path)
        .is_ok()
}

/// 把窗口里所有页的出现过的文字、按钮、可编辑控件清点成报告。
fn page_snapshot(window: &adw::ApplicationWindow, root: &gtk::Widget) -> serde_json::Value {
    let surface = input_surface(window);
    serde_json::json!({
        "text": visible_text(root),
        "widgets": surface.widgets,
        "editable": surface.editable,
        "send_buttons": surface.send_buttons,
        "buttons": surface.buttons,
    })
}

fn gov_options(out: &Path) -> DesktopOptions {
    let width: i32 = std::env::var(CHILD_GOV_WIDTH)
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(1440);
    let config_path = out.with_extension("desktop.json");
    let config = quetzalcoatl_desktop::config::DesktopConfig {
        width,
        height: 900,
        ..quetzalcoatl_desktop::config::DesktopConfig::default()
    };
    config.save_to(Some(&config_path)).expect("写入窗口配置");
    DesktopOptions {
        home: quetzalcoatl_daemon::resolve_quetzalcoatl_home(None),
        config_path: Some(config_path),
        self_test: false,
    }
}

fn shots_dir() -> Option<PathBuf> {
    std::env::var_os(SHOT_DIR_ENV).map(PathBuf::from)
}

fn css_parse_errors() -> Vec<String> {
    let errors = std::rc::Rc::new(std::cell::RefCell::new(Vec::<String>::new()));
    let provider = gtk::CssProvider::new();
    let sink = errors.clone();
    provider.connect_parsing_error(move |_, section, error| {
        sink.borrow_mut().push(format!(
            "行 {}: {error}",
            section.start_location().lines() + 1
        ));
    });
    provider.load_from_string(governance_css());

    errors.borrow().clone()
}

fn probe_read(out: &Path) -> serde_json::Value {
    let state = app::build_desktop(gov_options(out));
    let window = state.borrow().window.clone();
    window.present();
    let mapped = app::pump_until_mapped(&window, 5_000);
    app::pump_events(400);
    let shell = state.borrow().shell.clone();
    let width = window.width();

    // 快捷键必须是 GAction + accelerator（布局无关），而不是裸 keyval 匹配。
    let app = adw_application();
    app.register(None::<&gtk::gio::Cancellable>)
        .expect("注册探针 GApplication");
    app::install_page_actions(&app, std::rc::Rc::downgrade(&shell));
    let accels_installed = (1..=PAGES.len()).all(|digit| {
        let expected = gtk::accelerator_parse(format!("<Primary>{digit}"));
        app.accels_for_action(&format!("app.page-{digit}"))
            .iter()
            .any(|installed| gtk::accelerator_parse(installed.as_str()) == expected)
    });
    // 触发 Ctrl+5 对应的动作：真的切到第 5 页（往事）。
    app.activate_action("page-5", None);
    app::pump_events(50);
    let accel_navigates = shell.current() == PageKey::Memories;

    let mut pages = serde_json::Map::new();
    for info in &PAGES {
        shell.navigate(info.key);
        let page = shell.page(info.key).expect("每一页都已建出");
        let ready = wait_for_any(&page.root(), ready_markers(info.key), 6_000);
        app::pump_events(350);
        let mut entry = page_snapshot(&window, &page.root());
        entry["ready"] = serde_json::Value::Bool(ready);
        entry["mapped"] = serde_json::Value::Bool(page.root().is_mapped());
        entry["provenance"] = serde_json::Value::String(visible_text(&shell.ctx.aside.root));
        if let Some(dir) = shots_dir() {
            let _ = fs::create_dir_all(&dir);
            let shot = dir.join(format!("{width}-{}.png", info.slug));
            entry["shot"] = serde_json::Value::Bool(screenshot(&window, &shot));
        }
        pages.insert(info.slug.to_owned(), entry);
    }

    // 往事页：选一件，右侧（宽屏）或钻取（窄屏）出现全文与三个动作。
    shell.navigate(PageKey::Memories);
    app::pump_events(100);
    let memories_root = shell.page(PageKey::Memories).expect("往事页").root();
    let rows = find_prefixed(&memories_root, "memory-row-");
    let first_row = rows.first().cloned();
    let selected = first_row.as_ref().is_some_and(click_first_button_in);
    app::pump_events(300);
    let detail_has_actions = ["action-edit", "action-mute", "action-erase"]
        .iter()
        .all(|name| find_named(&memories_root, name).is_some());
    let mut memory_detail = page_snapshot(&window, &memories_root);
    memory_detail["selected"] = serde_json::Value::Bool(selected);
    memory_detail["actions"] = serde_json::Value::Bool(detail_has_actions);
    if let Some(dir) = shots_dir() {
        memory_detail["shot"] = serde_json::Value::Bool(screenshot(
            &window,
            &dir.join(format!("{width}-memories-selected.png")),
        ));
    }

    // 往事页的抹除：二次确认并说明不可恢复；这里只看对话框，取消，不真的抹。
    let erase_clicked = click_named(&memories_root, "action-erase");
    app::pump_until(2_000, || find_named(&window, "confirm-ok").is_some());
    let dialog_text = find_named(&window, "confirm-ok")
        .and_then(|ok| {
            let mut node = ok.parent();
            while let Some(current) = node {
                if current.has_css_class("qz-dialog") {
                    return Some(current);
                }
                node = current.parent();
            }
            None
        })
        .map(|body| visible_text(&body))
        .unwrap_or_default();
    let dialog_has_cancel_default = find_named(&window, "confirm-cancel").is_some();
    if let Some(dir) = shots_dir() {
        let _ = screenshot(&window, &dir.join(format!("{width}-confirm-erase.png")));
    }
    click_named(&window, "confirm-cancel");
    app::pump_events(200);

    // 带口令的确认框：口令空着不能确认，并且说明原因。
    let secret_seen = std::rc::Rc::new(std::cell::RefCell::new(None::<String>));
    let seen = secret_seen.clone();
    let dialog = quetzalcoatl_desktop::dialog::confirm(
        shell.ctx.anchor(),
        quetzalcoatl_desktop::dialog::ConfirmSpec {
            title: String::from("吊销「合成设备」？"),
            word: String::from("不可撤回"),
            quote: None,
            paragraphs: vec![String::from("吊销之后不能撤回。")],
            confirm_label: String::from("吊销"),
            passphrase: Some((String::from("口令"), String::from("合成口令"))),
        },
        std::rc::Rc::new(move |secret, finish| {
            *seen.borrow_mut() = Some(secret);
            finish(Ok(()));
        }),
    );
    app::pump_events(200);
    click_named(&window, "confirm-ok");
    app::pump_events(100);
    let refused_without_passphrase = secret_seen.borrow().is_none()
        && find_named(&window, "confirm-ok").is_some()
        && visible_text(&window).contains("先输入口令");
    if let Some(entry) = find_named(&window, "confirm-passphrase")
        .and_then(|w| w.dynamic_cast::<gtk::Editable>().ok())
    {
        entry.set_text("synthetic-pass-1234");
    }
    click_named(&window, "confirm-ok");
    app::pump_events(200);
    let passphrase_delivered = secret_seen.borrow().as_deref() == Some("synthetic-pass-1234");
    let _ = dialog;

    serde_json::json!({
        "ok": mapped,
        "mapped": mapped,
        "width": width,
        "narrow": shell.ctx.narrow(),
        "aside_mapped": shell.ctx.aside.root.is_mapped(),
        "accels_installed": accels_installed,
        "accel_navigates": accel_navigates,
        "css_errors": css_parse_errors(),
        "pages": pages,
        "memory_detail": memory_detail,
        "erase_clicked": erase_clicked,
        "erase_dialog": dialog_text,
        "erase_dialog_has_cancel": dialog_has_cancel_default,
        "refused_without_passphrase": refused_without_passphrase,
        "passphrase_delivered": passphrase_delivered,
    })
}

/// 点选某一行（按行里的文字找），行里第一个按钮是选取按钮。
fn click_row_containing(root: &gtk::Widget, prefix: &str, needle: &str) -> bool {
    let row = find_prefixed(root, prefix)
        .into_iter()
        .find(|row| visible_text(row).contains(needle));
    row.as_ref().is_some_and(click_first_button_in)
}

fn set_text_view(root: &impl IsA<gtk::Widget>, name: &str, text: &str) -> bool {
    match find_named(root, name).and_then(|w| w.downcast::<gtk::TextView>().ok()) {
        Some(view) => {
            view.buffer().set_text(text);
            true
        }
        None => false,
    }
}

fn set_editable(root: &impl IsA<gtk::Widget>, name: &str, text: &str) -> bool {
    match find_named(root, name).and_then(|w| w.dynamic_cast::<gtk::Editable>().ok()) {
        Some(entry) => {
            entry.set_text(text);
            true
        }
        None => false,
    }
}

fn probe_write(out: &Path) -> serde_json::Value {
    let state = app::build_desktop(gov_options(out));
    let window = state.borrow().window.clone();
    window.present();
    let mapped = app::pump_until_mapped(&window, 5_000);
    let shell = state.borrow().shell.clone();
    let mut steps = serde_json::Map::new();

    // 往事页：改一条（搜出来的那一条）。
    shell.navigate(PageKey::Memories);
    let memories = shell.page(PageKey::Memories).expect("往事页").root();
    wait_for_any(&memories, ready_markers(PageKey::Memories), 6_000);
    app::pump_events(200);
    set_editable(&memories, "memory-search", "跨设备切换会话");
    app::pump_until(4_000, || {
        visible_text(&memories).contains("共 1 件")
            || visible_text(&memories).contains("已显示 1 / 1")
    });
    app::pump_events(200);
    steps.insert(
        "memory_selected".into(),
        click_row_containing(&memories, "memory-row-", "跨设备切换会话").into(),
    );
    app::pump_events(300);
    steps.insert(
        "edit_clicked".into(),
        click_named(&memories, "action-edit").into(),
    );
    app::pump_events(200);
    steps.insert(
        "edit_text_set".into(),
        set_text_view(
            &memories,
            "entry-edit-text",
            "跨设备切换会话时，先看未完成目标的步骤状态，再继续。",
        )
        .into(),
    );
    steps.insert(
        "save_clicked".into(),
        click_named(&memories, "action-save").into(),
    );
    app::pump_until(5_000, || {
        visible_text(&shell.ctx.aside.root).contains("刚刚由你修改")
    });
    steps.insert(
        "provenance_recent".into(),
        visible_text(&shell.ctx.aside.root)
            .contains("刚刚由你修改")
            .into(),
    );

    // 我页：把第一条偏好设为「不主动提」。
    shell.navigate(PageKey::User);
    let user = shell.page(PageKey::User).expect("我页").root();
    wait_for_any(&user, ready_markers(PageKey::User), 6_000);
    app::pump_events(200);
    let preference_row = find_prefixed(&user, "entry-row-").into_iter().next();
    steps.insert(
        "preference_selected".into(),
        preference_row
            .as_ref()
            .is_some_and(click_first_button_in)
            .into(),
    );
    app::pump_events(300);
    steps.insert(
        "mute_clicked".into(),
        click_named(&user, "action-mute").into(),
    );
    app::pump_until(5_000, || {
        find_prefixed(&user, "entry-row-")
            .iter()
            .any(|row| visible_text(row).contains("不主动提"))
    });
    app::pump_events(300);

    // 往事页：抹除另一条（经二次确认）。
    shell.navigate(PageKey::Memories);
    set_editable(&memories, "memory-search", "");
    app::pump_events(600);
    let erase_target = "按分类目录树组织";
    set_editable(&memories, "memory-search", erase_target);
    app::pump_until(4_000, || visible_text(&memories).contains("共 1 件"));
    app::pump_events(200);
    steps.insert(
        "erase_target_selected".into(),
        click_row_containing(&memories, "memory-row-", erase_target).into(),
    );
    app::pump_events(300);
    steps.insert(
        "erase_clicked".into(),
        click_named(&memories, "action-erase").into(),
    );
    app::pump_until(2_000, || find_named(&window, "confirm-ok").is_some());
    steps.insert(
        "erase_confirmed".into(),
        click_named(&window, "confirm-ok").into(),
    );
    app::pump_until(5_000, || {
        visible_text(&shell.ctx.aside.root).contains("刚刚由你抹除")
    });
    steps.insert(
        "erase_notice".into(),
        visible_text(&shell.ctx.aside.root)
            .contains("刚刚由你抹除")
            .into(),
    );

    // 底线页：写一条、设口令、签署。
    shell.navigate(PageKey::Baseline);
    let baseline = shell.page(PageKey::Baseline).expect("底线页").root();
    wait_for_any(&baseline, ready_markers(PageKey::Baseline), 6_000);
    app::pump_events(200);
    steps.insert(
        "clause_add".into(),
        click_named(&baseline, "clause-add").into(),
    );
    app::pump_events(200);
    steps.insert(
        "clause_title".into(),
        set_editable(&baseline, "clause-title", "不替我对外发出任何东西").into(),
    );
    steps.insert(
        "clause_text".into(),
        set_text_view(
            &baseline,
            "clause-text",
            "没有我点头，他不能替我发邮件、发消息或付款。",
        )
        .into(),
    );
    steps.insert(
        "clause_done".into(),
        click_named(&baseline, "clause-done").into(),
    );
    app::pump_events(200);
    // 两遍口令不一样：签不了，并说明原因。
    set_editable(&baseline, "sign-passphrase", "synthetic-pass-1234");
    set_editable(&baseline, "sign-passphrase-repeat", "synthetic-pass-9999");
    click_named(&baseline, "sign-button");
    app::pump_events(200);
    steps.insert(
        "mismatch_refused".into(),
        visible_text(&baseline).contains("两遍口令不一样").into(),
    );
    set_editable(&baseline, "sign-passphrase", "synthetic-pass-1234");
    set_editable(&baseline, "sign-passphrase-repeat", "synthetic-pass-1234");
    steps.insert(
        "sign_clicked".into(),
        click_named(&baseline, "sign-button").into(),
    );
    app::pump_until(5_000, || visible_text(&baseline).contains("起生效"));
    steps.insert(
        "signed_state".into(),
        visible_text(&baseline).contains("起生效").into(),
    );
    if let Some(dir) = shots_dir() {
        let _ = fs::create_dir_all(&dir);
        let _ = screenshot(&window, &dir.join("write-baseline-signed.png"));
    }

    // 我们页：把迎合滑杆拖到 60。
    shell.navigate(PageKey::Us);
    let us = shell.page(PageKey::Us).expect("我们页").root();
    wait_for_any(&us, ready_markers(PageKey::Us), 6_000);
    app::pump_events(200);
    let scale = find_named(&us, "focus-scale").and_then(|w| w.downcast::<gtk::Scale>().ok());
    steps.insert("scale_present".into(), scale.is_some().into());
    if let Some(scale) = &scale {
        scale.set_value(60.0);
    }
    app::pump_until(5_000, || {
        visible_text(&shell.ctx.aside.root).contains("刚刚由你调节")
    });
    steps.insert(
        "focus_notice".into(),
        visible_text(&shell.ctx.aside.root)
            .contains("刚刚由你调节")
            .into(),
    );

    serde_json::json!({ "ok": mapped, "steps": steps })
}

fn probe_offline(out: &Path) -> serde_json::Value {
    let state = app::build_desktop(gov_options(out));
    let window = state.borrow().window.clone();
    window.present();
    let mapped = app::pump_until_mapped(&window, 5_000);
    let shell = state.borrow().shell.clone();
    app::pump_until(5_000, || shell.ctx.answered());
    app::pump_events(300);
    let status = find_named(&window, "daemon-status")
        .and_then(|row| row.ancestor(gtk::Revealer::static_type()))
        .and_then(|w| w.downcast::<gtk::Revealer>().ok());
    let mut pages = serde_json::Map::new();
    for info in &PAGES {
        shell.navigate(info.key);
        let page = shell.page(info.key).expect("页");
        let ready = wait_for_any(&page.root(), &["situation-unreachable"], 4_000);
        app::pump_events(100);
        let mut entry = page_snapshot(&window, &page.root());
        entry["unreachable_situation"] = ready.into();
        pages.insert(info.slug.to_owned(), entry);
    }
    if let Some(dir) = shots_dir() {
        let _ = fs::create_dir_all(&dir);
        shell.navigate(PageKey::Overview);
        app::pump_events(200);
        let _ = screenshot(
            &window,
            &dir.join(format!("{}-offline.png", window.width())),
        );
    }
    serde_json::json!({
        "ok": mapped,
        "online": shell.ctx.online(),
        "ever_online": shell.ctx.ever_online(),
        "status_revealed": status.is_some_and(|r| r.reveals_child()),
        "status_text": visible_text(&window),
        "pages": pages,
    })
}

fn probe_outage(out: &Path) -> serde_json::Value {
    let sync_dir = PathBuf::from(std::env::var_os(CHILD_GOV_SYNC).expect("同步目录"));
    let state = app::build_desktop(gov_options(out));
    let window = state.borrow().window.clone();
    window.present();
    let mapped = app::pump_until_mapped(&window, 5_000);
    let shell = state.borrow().shell.clone();
    let overview = shell.page(PageKey::Overview).expect("总览").root();
    let loaded = wait_for_any(&overview, &["agent-name"], 6_000);
    let name_before = find_named(&overview, "agent-name")
        .and_then(|w| w.downcast::<gtk::Label>().ok())
        .map(|label| label.label().to_string())
        .unwrap_or_default();
    // 往事页也读一遍并选中一条：断线之后它的写动作必须不可用。
    shell.navigate(PageKey::User);
    let user = shell.page(PageKey::User).expect("我页").root();
    wait_for_any(&user, ready_markers(PageKey::User), 6_000);
    app::pump_events(200);
    let selected = find_prefixed(&user, "entry-row-")
        .into_iter()
        .next()
        .as_ref()
        .is_some_and(click_first_button_in);
    app::pump_events(300);
    let writable_before = find_named(&user, "action-edit").is_some_and(|w| w.is_sensitive());
    let online_before = shell.ctx.online();

    fs::write(sync_dir.join("loaded"), "1").expect("写入同步标记");
    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline && !sync_dir.join("stopped").is_file() {
        app::pump_events(50);
    }
    // 守护进程已被停掉：重读，应当进入降级但保留上一次的内容。
    shell.reload();
    app::pump_until(8_000, || !shell.ctx.online());
    app::pump_events(300);
    let status = find_named(&window, "daemon-status")
        .and_then(|row| row.ancestor(gtk::Revealer::static_type()))
        .and_then(|w| w.downcast::<gtk::Revealer>().ok());
    let name_after = find_named(&overview, "agent-name")
        .and_then(|w| w.downcast::<gtk::Label>().ok())
        .map(|label| label.label().to_string())
        .unwrap_or_default();
    let writable_after = find_named(&user, "action-edit").map(|w| w.is_sensitive());
    let user_text_after = visible_text(&user);
    // 一页从没读过：整页是联系不上的状态版面。
    shell.navigate(PageKey::Hosts);
    let hosts = shell.page(PageKey::Hosts).expect("宿主页").root();
    let hosts_unreachable = wait_for_any(&hosts, &["situation-unreachable"], 6_000);
    if let Some(dir) = shots_dir() {
        let _ = fs::create_dir_all(&dir);
        shell.navigate(PageKey::User);
        app::pump_events(300);
        let _ = screenshot(
            &window,
            &dir.join(format!("{}-outage-user.png", window.width())),
        );
    }
    serde_json::json!({
        "ok": mapped && loaded,
        "name_before": name_before,
        "name_after": name_after,
        "selected": selected,
        "writable_before": writable_before,
        "online_before": online_before,
        "online_after": shell.ctx.online(),
        "status_revealed": status.is_some_and(|r| r.reveals_child()),
        "writable_after": writable_after,
        "user_text_after": user_text_after,
        "hosts_unreachable": hosts_unreachable,
    })
}

#[test]
#[ignore = "由父测试以子进程方式驱动（xvfb）；无环境变量时不做任何断言"]
fn governance_child_probe() {
    let Some(out_path) = std::env::var_os(CHILD_GOV_OUT).map(PathBuf::from) else {
        return;
    };
    let mode = std::env::var(CHILD_GOV_MODE).unwrap_or_default();
    let mut report = serde_json::json!({ "ok": false });
    if let Err(err) = gtk::init() {
        report["error"] = serde_json::Value::String(format!("gtk init 失败: {err}"));
        let _ = fs::write(&out_path, report.to_string());
        return;
    }
    let _ = adw::init();
    report = match mode.as_str() {
        "read" => probe_read(&out_path),
        "write" => probe_write(&out_path),
        "offline" => probe_offline(&out_path),
        "outage" => probe_outage(&out_path),
        other => serde_json::json!({ "ok": false, "error": format!("未知模式 {other}") }),
    };
    fs::write(&out_path, report.to_string()).expect("写入治理面探针报告");
}

/// 起真实守护进程并导入 V1 夹具，得到一片有内容的海。
fn seeded_daemon(tag: &str) -> (TempDir, quetzalcoatl_daemon::DaemonHandle, IpcClient) {
    let home = TempDir::new(tag);
    let daemon = start_real_daemon(&home.path().join("h"));
    let client = IpcClient::from_runtime_info(daemon.runtime_info(), daemon.ipc_token().to_owned());
    let soul = manifest_dir().join("../../crates/quetzalcoatl-spine/tests/fixtures/v1_soul_v14");
    if let IpcResponse::Error { code, detail } = client
        .call(&IpcRequest::ImportV1 {
            soul_dir: soul,
            db_paths: Vec::new(),
        })
        .expect("导入 V1 夹具")
    {
        panic!("导入 V1 夹具失败: {code} {detail}")
    }
    (home, daemon, client)
}

fn run_gov_child(
    mode: &str,
    width: i32,
    home: &Path,
    sync: Option<&Path>,
) -> (serde_json::Value, std::process::Output) {
    let out_dir = TempDir::new(&format!("gov_{mode}"));
    let out = out_dir.path().join("report.json");
    let mut command = spawn_probe("governance_child_probe", false);
    command
        .env(CHILD_GOV_OUT, &out)
        .env(CHILD_GOV_MODE, mode)
        .env(CHILD_GOV_WIDTH, width.to_string())
        .env("QUETZALCOATL_HOME", home)
        .env("QUETZALCOATL_DESKTOP_CONFIG_DIR", out_dir.path())
        .env("GSK_RENDERER", "cairo")
        .env("XDG_CACHE_HOME", out_dir.path().join("cache"))
        .env_remove("DBUS_SESSION_BUS_ADDRESS");
    if let Some(sync) = sync {
        command.env(CHILD_GOV_SYNC, sync);
    }
    if let Some(dir) = std::env::var_os(SHOT_DIR_ENV) {
        command.env(SHOT_DIR_ENV, dir);
    }
    let output = command.output().expect("spawn governance probe");
    let report = fs::read(&out)
        .ok()
        .and_then(|raw| serde_json::from_slice(&raw).ok())
        .unwrap_or_else(|| {
            panic!(
                "治理面探针没有写出报告: status={:?}\nstdout={}\nstderr={}",
                output.status,
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            )
        });
    (report, output)
}

/// 失败信息里只放报告的一小段，免得整份报告淹没输出。
fn brief(report: &serde_json::Value) -> String {
    let text = report.to_string();
    text.chars().take(700).collect()
}

fn page_text<'a>(report: &'a serde_json::Value, slug: &str) -> &'a str {
    report["pages"][slug]["text"].as_str().unwrap_or_default()
}

/// 治理面里唯一允许存在的可编辑控件，以及它们各自的用途。
/// 其中没有任何一个是「对他说一句话」。
const ALLOWED_EDITABLES: [&str; 3] = ["memory-search", "sign-passphrase", "sign-passphrase-repeat"];

fn assert_governance_read(report: &serde_json::Value, narrow: bool) {
    assert_eq!(
        report["ok"],
        serde_json::Value::Bool(true),
        "{}",
        brief(report)
    );
    assert_eq!(
        report["narrow"],
        serde_json::Value::Bool(narrow),
        "{}",
        brief(report)
    );
    assert_eq!(
        report["css_errors"].as_array().map(Vec::len),
        Some(0),
        "样式层必须能被 GTK 无错解析: {}",
        report["css_errors"]
    );
    assert_eq!(
        report["accels_installed"],
        serde_json::Value::Bool(true),
        "{}",
        brief(report)
    );
    assert_eq!(
        report["accel_navigates"],
        serde_json::Value::Bool(true),
        "{}",
        brief(report)
    );

    // 九页都从真守护进程读了出来。
    for info in &PAGES {
        let entry = &report["pages"][info.slug];
        assert_eq!(
            entry["ready"],
            serde_json::Value::Bool(true),
            "{} 页没有读出内容: {}",
            info.slug,
            brief(entry)
        );
        assert!(
            entry["widgets"].as_u64().unwrap_or(0) > 60,
            "{} 页遍历到的控件太少，断言可能空转: {}",
            info.slug,
            brief(entry)
        );
        assert!(
            !entry["provenance"].as_str().unwrap_or_default().is_empty(),
            "出处栏永不留空: {} {}",
            info.slug,
            brief(entry)
        );
    }
    let overview = page_text(report, "overview");
    assert!(overview.contains("青羽"), "总览要写他的名字: {overview}");
    assert!(overview.contains("相处第"), "{overview}");
    assert!(
        overview.contains("等你的事") && overview.contains("同步") && overview.contains("宿主"),
        "{overview}"
    );
    assert!(
        overview.contains("底线待签署"),
        "没签底线时总览里这一格是琥珀的待签署: {overview}"
    );
    let me = page_text(report, "self");
    assert!(
        me.contains("核心价值") || me.contains("他还没有长出自己的样子"),
        "{me}"
    );
    let user = page_text(report, "user");
    assert!(user.contains("偏好") && user.contains("事实"), "{user}");
    let us = page_text(report, "us");
    assert!(us.contains("他迎合谁") && us.contains("下限"), "{us}");
    let memories = page_text(report, "memories");
    assert!(
        memories.contains("已显示") && memories.contains("不主动提"),
        "{memories}"
    );
    let baseline = page_text(report, "baseline");
    assert!(baseline.contains("待签署"), "{baseline}");
    let hosts = page_text(report, "hosts");
    assert!(
        hosts.contains("重新体检") || hosts.contains("他还没有住进任何宿主"),
        "{hosts}"
    );
    let devices = page_text(report, "devices");
    assert!(
        devices.contains("这台设备") && devices.contains("其余设备"),
        "{devices}"
    );
    let audit = page_text(report, "audit");
    assert!(
        audit.contains("已显示") || audit.contains("还没有任何写入"),
        "{audit}"
    );

    // 无输入框不变量：任何一页、窗口里的任何控件，都没有给他发一句话的地方。
    for info in &PAGES {
        let entry = &report["pages"][info.slug];
        let editable: Vec<&str> = entry["editable"]
            .as_array()
            .expect("editable")
            .iter()
            .filter_map(|name| name.as_str())
            .collect();
        for name in &editable {
            assert!(
                ALLOWED_EDITABLES.contains(name),
                "{} 页出现了不该有的可编辑控件 `{name}`（只允许搜索与口令）: {}",
                info.slug,
                brief(entry)
            );
        }
        assert_eq!(
            entry["send_buttons"].as_array().map(Vec::len),
            Some(0),
            "{} 页出现了「发送」类按钮: {}",
            info.slug,
            brief(entry)
        );
    }
    // 整棵树里搜索与口令框各只有一份；其余的编辑框只在点了「改」「添一条」之后才出现。
    let any_page = &report["pages"]["overview"]["editable"];
    assert!(
        any_page
            .as_array()
            .expect("editable")
            .iter()
            .any(|name| name == "memory-search"),
        "整棵树里应当有且只有搜索框这一类常驻输入: {any_page}"
    );

    // 往事页：选中之后有全文与「改、不主动提、抹除」三个动作。
    let detail = &report["memory_detail"];
    assert_eq!(
        detail["selected"],
        serde_json::Value::Bool(true),
        "{}",
        brief(detail)
    );
    assert_eq!(
        detail["actions"],
        serde_json::Value::Bool(true),
        "{}",
        brief(detail)
    );
    for editable in detail["editable"].as_array().expect("editable") {
        let name = editable.as_str().unwrap_or_default();
        assert!(
            ALLOWED_EDITABLES.contains(&name),
            "往事选中态出现了不该有的可编辑控件 `{name}`: {}",
            brief(detail)
        );
    }
    // 抹除要二次确认，并说明不可恢复。
    assert_eq!(
        report["erase_clicked"],
        serde_json::Value::Bool(true),
        "{}",
        brief(report)
    );
    let dialog = report["erase_dialog"].as_str().unwrap_or_default();
    assert!(
        dialog.contains("抹除这一条") && dialog.contains("不可恢复"),
        "{dialog}"
    );
    assert!(dialog.contains("所有设备"), "{dialog}");
    assert_eq!(
        report["erase_dialog_has_cancel"],
        serde_json::Value::Bool(true)
    );
    // 口令确认框：口令空着不能确认；填了之后口令原样交给动作。
    assert_eq!(
        report["refused_without_passphrase"],
        serde_json::Value::Bool(true),
        "{}",
        brief(report)
    );
    assert_eq!(
        report["passphrase_delivered"],
        serde_json::Value::Bool(true),
        "{}",
        brief(report)
    );
}

#[test]
fn nine_pages_read_from_a_real_daemon_without_any_chat_input_at_wide_and_narrow_widths() {
    let (home, mut daemon, _client) = seeded_daemon("gov_read");
    let hold_home = home.path().join("h");
    let (wide, wide_out) = run_gov_child("read", 1440, &hold_home, None);
    assert!(
        wide_out.status.success(),
        "{}",
        String::from_utf8_lossy(&wide_out.stderr)
    );
    assert_governance_read(&wide, false);
    assert_eq!(
        wide["aside_mapped"],
        serde_json::Value::Bool(true),
        "宽屏有独立的出处栏: {}",
        brief(&wide)
    );
    let (narrow, narrow_out) = run_gov_child("read", 720, &hold_home, None);
    assert!(
        narrow_out.status.success(),
        "{}",
        String::from_utf8_lossy(&narrow_out.stderr)
    );
    assert_governance_read(&narrow, true);
    // 窄屏：出处栏落到正文下方，仍然在。
    assert_eq!(
        narrow["aside_mapped"],
        serde_json::Value::Bool(true),
        "{}",
        brief(&narrow)
    );
    daemon.shutdown().expect("关闭守护进程");
}

#[test]
fn every_write_in_the_governance_surface_reaches_the_daemon() {
    let (home, mut daemon, client) = seeded_daemon("gov_write");
    let (report, output) = run_gov_child("write", 1440, &home.path().join("h"), None);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        report["ok"],
        serde_json::Value::Bool(true),
        "{}",
        brief(&report)
    );
    for step in [
        "memory_selected",
        "edit_clicked",
        "edit_text_set",
        "save_clicked",
        "provenance_recent",
        "preference_selected",
        "mute_clicked",
        "erase_target_selected",
        "erase_clicked",
        "erase_confirmed",
        "erase_notice",
        "clause_add",
        "clause_title",
        "clause_text",
        "clause_done",
        "mismatch_refused",
        "sign_clicked",
        "signed_state",
        "scale_present",
        "focus_notice",
    ] {
        assert_eq!(
            report["steps"][step],
            serde_json::Value::Bool(true),
            "步骤 {step} 没有完成: {}",
            brief(&report)
        );
    }

    let value = |request: &IpcRequest| -> serde_json::Value {
        serde_json::to_value(client.call(request).expect("调用守护进程")).expect("序列化")
    };
    // 改：新的一条接替旧的，写着是你改的。
    let edited = value(&IpcRequest::SeaMemories {
        query: Some(String::from("先看未完成目标的步骤状态")),
        state: None,
        cursor: None,
        limit: None,
    });
    assert_eq!(edited["data"]["items"][0]["by_owner"], true, "{edited}");
    // 抹除：搜不到了。
    let erased = value(&IpcRequest::SeaMemories {
        query: Some(String::from("按分类目录树组织")),
        state: Some(String::from("all")),
        cursor: None,
        limit: None,
    });
    assert_eq!(
        erased["data"]["items"].as_array().map(Vec::len),
        Some(0),
        "{erased}"
    );
    // 不主动提：我页里至少有一条被设了。
    let muted = value(&IpcRequest::SeaMemories {
        query: None,
        state: Some(String::from("muted")),
        cursor: None,
        limit: None,
    });
    assert!(muted["data"]["total"].as_u64().unwrap_or(0) >= 1, "{muted}");
    // 签署：一条你的底线，已生效。
    let baseline = value(&IpcRequest::SeaBaseline);
    assert_eq!(baseline["data"]["signed"], true, "{baseline}");
    assert_eq!(
        baseline["data"]["directives"].as_array().map(Vec::len),
        Some(1),
        "{baseline}"
    );
    // 迎合：拖到 60 之后，「我们」的权重不是默认值。
    let us = value(&IpcRequest::SeaUs);
    let us_weight = us["data"]["focus"]["us_weight"].as_f64().unwrap_or(-1.0);
    let floor = us["data"]["focus"]["floor_self"].as_f64().unwrap_or(0.0);
    assert!(
        (us_weight - 0.6_f64.min(1.0 - floor)).abs() < 0.011,
        "迎合权重没有落到守护进程: {us}"
    );
    daemon.shutdown().expect("关闭守护进程");
}

#[test]
fn without_a_daemon_every_page_degrades_to_one_amber_line_and_a_next_step() {
    let home = TempDir::new("gov_offline");
    fs::create_dir_all(home.path().join("h")).expect("空 home");
    let (report, output) = run_gov_child("offline", 1440, &home.path().join("h"), None);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        report["ok"],
        serde_json::Value::Bool(true),
        "{}",
        brief(&report)
    );
    assert_eq!(
        report["online"],
        serde_json::Value::Bool(false),
        "{}",
        brief(&report)
    );
    assert_eq!(
        report["status_revealed"],
        serde_json::Value::Bool(true),
        "{}",
        brief(&report)
    );
    let status = report["status_text"].as_str().unwrap_or_default();
    assert!(
        status.contains("联系不上") && status.contains("qz up"),
        "{status}"
    );
    for info in &PAGES {
        let entry = &report["pages"][info.slug];
        assert_eq!(
            entry["unreachable_situation"],
            serde_json::Value::Bool(true),
            "{} 页在守护进程不在线时应是联系不上的状态版面: {}",
            info.slug,
            brief(entry)
        );
        assert!(
            entry["text"].as_str().unwrap_or_default().contains("qz up"),
            "{} 页要给出下一步: {}",
            info.slug,
            brief(entry)
        );
        assert_eq!(
            entry["send_buttons"].as_array().map(Vec::len),
            Some(0),
            "{}",
            brief(entry)
        );
    }
    assert!(
        !home.path().join("h/spine/spine.sqlite").exists(),
        "桌面端绝不直接创建 spine.sqlite"
    );
}

#[test]
fn an_outage_keeps_the_last_content_and_switches_every_write_off() {
    let (home, mut daemon, _client) = seeded_daemon("gov_outage");
    let sync = TempDir::new("gov_outage_sync");
    let sync_path = sync.path().to_path_buf();
    let home_path = home.path().join("h");
    let handle = thread::spawn(move || run_gov_child("outage", 1440, &home_path, Some(&sync_path)));
    let deadline = Instant::now() + Duration::from_secs(30);
    while Instant::now() < deadline && !sync.path().join("loaded").is_file() {
        thread::sleep(Duration::from_millis(50));
    }
    assert!(
        sync.path().join("loaded").is_file(),
        "子进程没有在 30 秒内读完第一屏"
    );
    daemon.shutdown().expect("关闭守护进程");
    fs::write(sync.path().join("stopped"), "1").expect("写入同步标记");
    let (report, output) = handle.join().expect("子进程线程");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        report["ok"],
        serde_json::Value::Bool(true),
        "{}",
        brief(&report)
    );
    assert_eq!(report["name_before"], "青羽", "{}", brief(&report));
    assert_eq!(
        report["name_after"],
        "青羽",
        "断线之后整页保留上一次的内容: {}",
        brief(&report)
    );
    assert_eq!(
        report["selected"],
        serde_json::Value::Bool(true),
        "{}",
        brief(&report)
    );
    assert_eq!(
        report["writable_before"],
        serde_json::Value::Bool(true),
        "在线时写动作可用: {}",
        brief(&report)
    );
    assert_eq!(
        report["online_after"],
        serde_json::Value::Bool(false),
        "{}",
        brief(&report)
    );
    assert_eq!(
        report["status_revealed"],
        serde_json::Value::Bool(true),
        "{}",
        brief(&report)
    );
    assert_eq!(
        report["writable_after"],
        serde_json::Value::Bool(false),
        "断线之后写动作一律不可用: {}",
        brief(&report)
    );
    assert!(
        report["user_text_after"]
            .as_str()
            .unwrap_or_default()
            .contains("偏好"),
        "断线之后「我」页仍保留上一次的内容: {}",
        brief(&report)
    );
    assert_eq!(
        report["hosts_unreachable"],
        serde_json::Value::Bool(true),
        "从没读过的页是联系不上的状态版面: {}",
        brief(&report)
    );
}

// ---------------------------------------------------------------------------
// 5. 真实二进制无头冒烟：在线与离线
// ---------------------------------------------------------------------------

#[test]
fn headless_smoke_launches_binary_against_real_daemon_and_exits_cleanly() {
    let home = TempDir::new("daemon");
    let config_dir = TempDir::new("daemon_config");
    let mut daemon = start_real_daemon(home.path());

    let output = headless_command(binary())
        .arg("--self-test")
        .arg("--home")
        .arg(home.path())
        .env("QUETZALCOATL_DESKTOP_CONFIG_DIR", config_dir.path())
        .env("XDG_CACHE_HOME", config_dir.path().join("cache"))
        .env(
            "DBUS_SESSION_BUS_ADDRESS",
            format!(
                "unix:path={}",
                config_dir.path().join("no-such-bus").display()
            ),
        )
        .output()
        .expect("spawn desktop self-test");
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    assert!(
        output.status.success(),
        "无头冒烟失败: status={:?} stdout={stdout} stderr={stderr}",
        output.status
    );
    assert!(
        stdout.contains("SELF_TEST_OK"),
        "缺少自检标记: stdout={stdout} stderr={stderr}"
    );
    assert!(
        stdout.contains("window=visible"),
        "主窗口必须真实存在: {stdout}"
    );
    assert!(stdout.contains("page=overview"), "默认停在总览: {stdout}");
    assert!(
        stdout.contains("connected=true"),
        "必须经本机 IPC 连上真实守护进程: {stdout}"
    );
    assert!(
        stdout.contains("degraded=0"),
        "在线时不得进入降级态: {stdout}"
    );
    let tray_field = stdout
        .split_whitespace()
        .find(|token| token.starts_with("tray="))
        .unwrap_or("tray=missing");
    assert!(
        matches!(
            tray_field,
            "tray=registered" | "tray=no-watcher" | "tray=no-session-bus" | "tray=bus-unavailable"
        ),
        "托盘必须优雅降级而不是崩溃: {tray_field}"
    );

    daemon.shutdown().expect("关闭守护进程");
    assert!(!home.path().join("run/daemon.json").exists());
}

#[test]
fn headless_smoke_degrades_without_daemon_and_without_dbus() {
    let home = TempDir::new("degraded");
    let config_dir = TempDir::new("degraded_config");
    fs::create_dir_all(home.path()).expect("空 home");

    let output = headless_command(binary())
        .arg("--self-test")
        .arg("--home")
        .arg(home.path())
        .env("QUETZALCOATL_DESKTOP_CONFIG_DIR", config_dir.path())
        .env("XDG_CACHE_HOME", config_dir.path().join("cache"))
        .env_remove("DBUS_SESSION_BUS_ADDRESS")
        .output()
        .expect("spawn degraded self-test");
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    assert!(
        output.status.success(),
        "无守护进程时必须优雅退出而不是崩溃: status={:?} stdout={stdout} stderr={stderr}",
        output.status
    );
    assert!(stdout.contains("SELF_TEST_OK"), "{stdout}");
    assert!(stdout.contains("window=visible"), "{stdout}");
    assert!(
        stdout.contains("connected=false"),
        "无守护进程必须进入降级: {stdout}"
    );
    assert!(stdout.contains("degraded=1"), "降级必须显式标记: {stdout}");
    assert!(
        stdout.contains("tray=no-session-bus"),
        "无 DBus 会话总线时托盘必须静默降级: {stdout}"
    );
    assert!(
        !stderr.contains("panic"),
        "绝不允许 panic 或错误对话框路径: {stderr}"
    );
    assert!(
        !home.path().join("spine/spine.sqlite").exists(),
        "桌面端绝不直接创建 spine.sqlite"
    );
}
