#![forbid(unsafe_code)]
#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

//! Task 4.3 验收测试：Linux 纯原生桌面端的 ELF 动态链接合规、三档认知密度状态切换、
//! 拉模式视图补丁回流、真实守护进程无头冒烟与降级路径。
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
use quetzalcoatl_client_core::ThinClient;
use quetzalcoatl_client_core::llm_stream_bridge::live_producer_threads;
use quetzalcoatl_client_core::{
    CognitionDensity, ScriptedSource, StreamEvent, StreamEventKind, ViewOp, ViewPatch, ViewRow,
    ViewStream,
};
use quetzalcoatl_daemon::{DaemonConfig, IpcRequest, IpcResponse, QuetzalcoatlDaemon};
use quetzalcoatl_desktop::app::{self, DesktopOptions};
use quetzalcoatl_desktop::config::DesktopConfig;
use quetzalcoatl_desktop::model::{self, ConnectionState, UiModel};
use quetzalcoatl_desktop::tray;
use uuid::Uuid;

use gtk::prelude::*;
use gtk4 as gtk;

const CHILD_PATCH_OUT: &str = "QZ_DESKTOP_PATCH_PROBE_OUT";
const CHILD_GTK_OUT: &str = "QZ_DESKTOP_GTK_PROBE_OUT";
const CHILD_GTK_CONFIG_DIR: &str = "QZ_DESKTOP_GTK_PROBE_CONFIG_DIR";
const CHILD_SNAPSHOT_OUT: &str = "QZ_DESKTOP_SNAPSHOT_PROBE_OUT";
const CHILD_ONLINE_UI_OUT: &str = "QZ_DESKTOP_ONLINE_UI_PROBE_OUT";
const CHILD_TRAY_OUT: &str = "QZ_DESKTOP_TRAY_PROBE_OUT";
const CHILD_LIFECYCLE_OUT: &str = "QZ_DESKTOP_LIFECYCLE_PROBE_OUT";

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

/// 当前进程是否持有指向 `spine.sqlite*` 的文件描述符（Task 4.1 同款探针）。
fn spine_db_fds() -> Vec<String> {
    let Ok(entries) = fs::read_dir("/proc/self/fd") else {
        return Vec::new();
    };
    entries
        .filter_map(std::result::Result::ok)
        .filter_map(|entry| fs::read_link(entry.path()).ok())
        .map(|target| target.display().to_string())
        .filter(|target| target.contains("spine.sqlite"))
        .collect()
}

fn headless_command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    let mut command = Command::new("xvfb-run");
    command
        .arg("-a")
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

fn session_patch() -> ViewPatch {
    ViewPatch {
        from_rev: 0,
        to_rev: 7,
        density: CognitionDensity::Workbench,
        ops: vec![
            ViewOp::Upsert {
                row: ViewRow::new(
                    model::KIND_SESSION,
                    model::KIND_SESSION,
                    "与助手的第 3 次对话",
                )
                .with_detail("线程 thread-synthetic-3 · 共 4 轮")
                .with_updated_rev(7),
            },
            ViewOp::Upsert {
                row: ViewRow::new(
                    model::KIND_PROJECT,
                    model::KIND_PROJECT,
                    "合成项目：花园光照记录",
                )
                .with_detail("/tmp/synthetic/garden · 2 个未提交变更")
                .with_updated_rev(6),
            },
            ViewOp::Upsert {
                row: ViewRow::new(
                    model::KIND_APPROVAL,
                    model::KIND_APPROVAL,
                    "等待批准：写入 3 个文件",
                )
                .with_detail("洁净室校验已通过 · 合成策略 allow_synthetic_write")
                .with_updated_rev(6),
            },
            ViewOp::Upsert {
                row: ViewRow::new(
                    model::KIND_WORKFLOW,
                    model::KIND_WORKFLOW,
                    "Sprint 4 · 桌面端接线",
                )
                .with_detail("3/5 步骤完成 · 下一步：无障碍审查")
                .with_updated_rev(5),
            },
            ViewOp::Upsert {
                row: ViewRow::new(
                    "conscience:ROOT",
                    model::KIND_CONSCIENCE,
                    "ROOT (100) · 不可协商的宪法红线",
                )
                .with_detail("层级 ROOT · 4 条锁定条款")
                .with_raw_json("{\"tier\":\"ROOT\",\"weight\":100,\"locked\":true}")
                .with_updated_rev(4),
            },
            ViewOp::Upsert {
                row: ViewRow::new(
                    "conscience:SELF_CORE",
                    model::KIND_CONSCIENCE,
                    "SELF_CORE (70) · 长期人格核",
                )
                .with_detail("层级 SELF_CORE · 冷却升格队列 1 项")
                .with_raw_json("{\"tier\":\"SELF_CORE\",\"weight\":70}")
                .with_updated_rev(3),
            },
            ViewOp::Upsert {
                row: ViewRow::new(model::KIND_TOOL, model::KIND_TOOL, "shell.exec（沙箱内）")
                    .with_detail("近 24h 调用 12 次 · 全部通过客观校验")
                    .with_raw_json("{\"tool\":\"shell.exec\",\"sandboxed\":true}")
                    .with_updated_rev(2),
            },
        ],
    }
}

fn stream_events() -> Vec<StreamEvent> {
    vec![
        StreamEvent {
            seq: 1,
            kind: StreamEventKind::Delta,
            text: String::from("土壤湿度已经连续三天偏低，"),
        },
        StreamEvent {
            seq: 2,
            kind: StreamEventKind::Delta,
            text: String::from("我建议今晚补一次透水。"),
        },
        StreamEvent {
            seq: 3,
            kind: StreamEventKind::Done,
            text: String::from("stop"),
        },
    ]
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
// 2. ViewPatch + 拉模式流到达 UI 模型，且绝不打开 spine.sqlite
// ---------------------------------------------------------------------------

#[test]
#[ignore = "由父测试以子进程方式驱动（无环境变量时不做任何断言）"]
fn patch_stream_child_probe() {
    let Some(out_path) = std::env::var_os(CHILD_PATCH_OUT).map(PathBuf::from) else {
        return; // 父测试直接调用时跳过
    };

    let mut report = serde_json::json!({ "ok": false });
    let mut model_ui = UiModel::offline("probe home 下没有守护进程");
    let patch_result = model_ui.apply_patch(&session_patch());

    let stream = ViewStream::spawn_with_timeout(
        ScriptedSource::new(stream_events()),
        Duration::from_secs(5),
    );
    let mut batches = 0usize;
    let mut deltas = String::new();
    while !stream.is_finished() && batches < 8 {
        match stream.next_events(16) {
            Ok(events) => {
                batches += 1;
                let ingested = model_ui.ingest_stream(&events);
                for event in events {
                    if event.kind == StreamEventKind::Delta {
                        deltas.push_str(&event.text);
                    }
                }
                assert_eq!(
                    ingested.applied,
                    model_ui.session.last_seq.max(1) as usize,
                    "每个事件都必须被 UI 模型消费"
                );
            }
            Err(err) => {
                report["ok"] = serde_json::Value::Bool(false);
                report["error"] = serde_json::Value::String(format!("流拉取失败: {err}"));
                let _ = fs::write(&out_path, report.to_string());
                return;
            }
        }
    }
    let finished_err = stream.next_events(4);
    let finished_is_typed = matches!(
        finished_err,
        Err(quetzalcoatl_client_core::StreamError::Finished)
    );
    drop(stream);
    thread::sleep(Duration::from_millis(50));

    let rows = model_ui.view.rows.len();
    report = serde_json::json!({
        "ok": patch_result.is_ok() && finished_is_typed && rows == 7,
        "patch_ok": patch_result.is_ok(),
        "rows": rows,
        "rev": model_ui.view.rev,
        "deltas": deltas,
        "transcript": model_ui.session.transcript(),
        "streaming": model_ui.session.streaming,
        "finished_typed": finished_is_typed,
        "batches": batches,
        "db_fds": spine_db_fds(),
        "live_producers": live_producer_threads(),
        "connection_offline": matches!(model_ui.connection, ConnectionState::Offline { .. }),
    });
    fs::write(&out_path, report.to_string()).expect("写入补丁探针报告");
}

#[test]
fn view_patch_and_pull_stream_reach_ui_model_without_touching_spine() {
    let temp = TempDir::new("patch");
    let out = temp.path().join("patch.json");
    let exe = std::env::current_exe().expect("current exe");
    let output = Command::new(&exe)
        .arg("--exact")
        .arg("patch_stream_child_probe")
        .arg("--ignored")
        .arg("--nocapture")
        .env(CHILD_PATCH_OUT, &out)
        .env("QUETZALCOATL_HOME", temp.path())
        .env_remove("LD_LIBRARY_PATH")
        .stdin(Stdio::null())
        .output()
        .expect("spawn patch probe");
    assert!(
        output.status.success(),
        "补丁探针子进程失败: stdout={} stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let report: serde_json::Value =
        serde_json::from_slice(&fs::read(&out).expect("读取探针报告")).expect("探针 JSON");
    assert_eq!(
        report["ok"],
        serde_json::Value::Bool(true),
        "报告: {report}"
    );
    assert_eq!(report["rows"].as_u64(), Some(7), "行数: {report}");
    assert_eq!(report["rev"].as_u64(), Some(7), "修订: {report}");
    assert_eq!(
        report["deltas"].as_str(),
        Some("土壤湿度已经连续三天偏低，我建议今晚补一次透水。"),
        "流增量必须原样进入 UI 模型: {report}"
    );
    assert_eq!(
        report["streaming"],
        serde_json::Value::Bool(false),
        "Done 事件必须收束流状态"
    );
    assert!(
        report["transcript"]
            .as_str()
            .unwrap_or_default()
            .contains("今晚补一次透水")
    );
    assert_eq!(
        report["db_fds"].as_array().map(Vec::len),
        Some(0),
        "UI 模型/流路径不得打开 spine.sqlite: {report}"
    );
    assert_eq!(
        report["live_producers"].as_u64(),
        Some(0),
        "拉模式流 Drop 后不得残留生产者线程: {report}"
    );
    assert_eq!(
        report["connection_offline"],
        serde_json::Value::Bool(true),
        "无守护进程时必须是类型化离线态"
    );
    assert_eq!(report["finished_typed"], serde_json::Value::Bool(true));
    assert!(
        !temp.path().join("spine").exists(),
        "薄客户端路径绝不创建 spine 目录"
    );
}

// ---------------------------------------------------------------------------
// 3. 三档密度切换 + 状态保持 + 配置回环（真实 GTK 窗口，xvfb 无头）
// ---------------------------------------------------------------------------

#[test]
#[ignore = "由父测试以子进程方式驱动（需要 xvfb 且无环境变量时不做任何断言）"]
fn gtk_child_probe() {
    let Some(out_path) = std::env::var_os(CHILD_GTK_OUT).map(PathBuf::from) else {
        return; // 父测试直接调用时跳过
    };
    let config_dir = std::env::var_os(CHILD_GTK_CONFIG_DIR)
        .map(PathBuf::from)
        .expect("子探针必须提供配置目录");

    let mut report = serde_json::json!({ "ok": false });
    if let Err(err) = gtk::init() {
        report["error"] = serde_json::Value::String(format!("gtk init 失败: {err}"));
        let _ = fs::write(&out_path, report.to_string());
        return;
    }

    let config_path = config_dir.join("desktop.json");
    fs::create_dir_all(&config_dir).expect("配置目录");
    let loaded = DesktopConfig::default();
    {
        let mut initial = loaded.clone();
        initial.density = CognitionDensity::Workbench;
        initial.width = 980;
        initial.height = 640;
        initial.save_to(Some(&config_path)).expect("写入初始配置");
    }

    let state = app::build_desktop(DesktopOptions {
        home: config_dir.join("home"),
        config_path: Some(config_path.clone()),
        self_test: false,
    });

    let patch = session_patch();
    let events = stream_events();
    let (base_rev, messages_before, streaming_text_before, page_before) = {
        let mut guard = state.borrow_mut();
        guard.model.apply_patch(&patch).expect("应用视图补丁");
        let ingested = guard.model.ingest_stream(&events);
        assert!(ingested.deltas.contains("今晚补一次透水"));
        guard.model.push_user_message("今晚要浇水吗？");
        let base_rev = guard.model.view.rev;
        let page_before = guard
            .widgets
            .stack
            .visible_child_name()
            .map(|s| s.to_string())
            .unwrap_or_default();
        (
            base_rev,
            guard.model.session.messages.len(),
            guard.model.session.transcript(),
            page_before,
        )
    };
    app::refresh(&state);
    state.borrow().window.present();
    let mapped = app::pump_until_mapped(&state.borrow().widgets.workbench.root, 4_000);

    let mut switches = Vec::new();
    let mut pages_mapped = Vec::new();
    let mut session_preserved = true;
    let mut stream_preserved = true;
    // 快捷键必须是 GAction + accelerator（布局无关），而不是裸 keyval 匹配。
    let app = adw_application();
    app.register(None::<&gtk::gio::Cancellable>)
        .expect("注册探针 GApplication");
    app::install_density_actions(&app, std::rc::Rc::downgrade(&state));
    let expected_accels = [
        ("density-companion", "<Primary>1"),
        ("density-companion", "<Primary><Shift>1"),
        ("density-workbench", "<Primary>2"),
        ("density-inspector", "<Primary>3"),
    ];
    // GTK 会把 "<Primary>1" 规范化成 "<Control>1"，按解析后的 (keyval, modifiers) 比较。
    let accels_installed = expected_accels.iter().all(|(action, accel)| {
        let expected = gtk::accelerator_parse(*accel);
        app.accels_for_action(&format!("app.{action}"))
            .iter()
            .any(|installed| gtk::accelerator_parse(installed.as_str()) == expected)
    });
    let mut shortcuts = Vec::new();
    let sequence = [
        ("density-companion", CognitionDensity::Companion),
        ("density-workbench", CognitionDensity::Workbench),
        ("density-inspector", CognitionDensity::Inspector),
        ("density-companion", CognitionDensity::Companion),
    ];
    for (action, density) in sequence {
        shortcuts.push(
            app.list_actions()
                .iter()
                .any(|registered| registered.as_str() == action),
        );
        app.activate_action(action, None);
        let _ = density;
        app::pump_events(120);
        let guard = state.borrow();
        let page = guard
            .widgets
            .stack
            .visible_child_name()
            .map(|s| s.to_string())
            .unwrap_or_default();
        switches.push(page.clone());
        pages_mapped.push((
            page.clone(),
            guard.widgets.stack.child_by_name(&page).is_some(),
            guard.widgets.companion.root.is_mapped(),
            guard.widgets.workbench.root.is_mapped(),
            guard.widgets.inspector.root.is_mapped(),
        ));
        session_preserved &= guard.model.session.messages.len() == messages_before
            && guard.model.session.transcript() == streaming_text_before;
        stream_preserved &= guard.model.session.last_seq == 3;
    }

    let accessible_button = gtk::test_accessible_has_role(
        &state.borrow().widgets.companion.send,
        gtk::AccessibleRole::Button,
    );
    // `aria-live` 等价物：GTK 4.14 的 announce() + 持续更新区域角色说明。
    // 无 AT-SPI 总线时 announce() 必须是安全空操作（不 panic、不弹窗）。
    let accessible_live = gtk::test_accessible_has_property(
        &state.borrow().widgets.companion.transcript,
        gtk::AccessibleProperty::RoleDescription,
    ) && {
        let state = state.borrow();
        let realized = state.widgets.companion.transcript.is_realized();
        quetzalcoatl_desktop::a11y::announce(
            &state.widgets.companion.transcript,
            "流式回复的无障碍播报探针",
        );
        realized
    };
    let rev_delta = state.borrow().model.view.rev - base_rev;

    let tray_status = tray::status_label(&state.borrow().widgets.tray_status).to_string();

    // 重启回环：落盘 Inspector，再以同一配置路径重新构建桌面。
    let window_size = [
        state.borrow().window.width(),
        state.borrow().window.height(),
    ];
    app::apply_density(&state, CognitionDensity::Inspector);
    state.borrow().persist_config().expect("持久化配置");
    let reloaded = DesktopConfig::load_from(Some(&config_path));
    let restarted = app::build_desktop(DesktopOptions {
        home: config_dir.join("home"),
        config_path: Some(config_path.clone()),
        self_test: false,
    });
    let restored_page = restarted
        .borrow()
        .widgets
        .stack
        .visible_child_name()
        .map(|s| s.to_string())
        .unwrap_or_default();

    // 最大化回环：写入 maximized=true 后重新构建，必须真实发出 maximize 请求。
    // 裸 Xvfb 没有窗口管理器，is_maximized() 可能仍为 false，因此以「请求已发出」为准，
    // 并在有 WM 时额外核对生效状态（两路都记录，绝不伪造）。
    let max_path = config_dir.join("desktop-maximized.json");
    let mut max_config = DesktopConfig::load_from(Some(&config_path));
    max_config.maximized = true;
    max_config.save_to(Some(&max_path)).expect("写入最大化配置");
    let maximized = app::build_desktop(DesktopOptions {
        home: config_dir.join("home"),
        config_path: Some(max_path),
        self_test: false,
    });
    let maximize_requested = maximized.borrow().maximize_requested;
    let maximize_effective = maximized.borrow().window.is_maximized();

    report = serde_json::json!({
        "ok": mapped
            && switches == vec!["companion", "workbench", "inspector", "companion"]
            && accels_installed
            && shortcuts.iter().all(|ok| *ok)
            && session_preserved
            && stream_preserved
            && accessible_button
            && accessible_live
            && rev_delta == 4
            && reloaded.density == CognitionDensity::Inspector
            && restored_page == "inspector"
            && maximize_requested,
        "mapped": mapped,
        "page_before": page_before,
        "switches": switches,
        "shortcuts_mapped": shortcuts,
        "accels_installed": accels_installed,
        "pages_mapped": pages_mapped,
        "session_preserved": session_preserved,
        "stream_preserved": stream_preserved,
        "accessible_button": accessible_button,
        "accessible_live": accessible_live,
        "rev_delta": rev_delta,
        "tray": tray_status,
        "reloaded_density": reloaded.density.label(),
        "reloaded_size": [reloaded.width, reloaded.height],
        "persisted_size": [reloaded.width, reloaded.height],
        "window_size": window_size,
        "restored_page": restored_page,
        "maximize_requested": maximize_requested,
        "maximize_effective": maximize_effective,
        "window_visible": state.borrow().window.is_visible(),
    });
    state.borrow().window.destroy();
    restarted.borrow().window.destroy();
    maximized.borrow().window.destroy();
    fs::write(&out_path, report.to_string()).expect("写入 GTK 探针报告");
}

#[test]
fn three_density_switching_preserves_state_and_persists_under_xvfb() {
    let temp = TempDir::new("gtk");
    let out = temp.path().join("gtk.json");
    let config_dir = temp.path().join("config");
    let exe = std::env::current_exe().expect("current exe");
    let output = headless_command(exe)
        .arg("--exact")
        .arg("gtk_child_probe")
        .arg("--ignored")
        .arg("--nocapture")
        .env(CHILD_GTK_OUT, &out)
        .env(CHILD_GTK_CONFIG_DIR, &config_dir)
        .env("QUETZALCOATL_HOME", temp.path().join("home"))
        .output()
        .expect("spawn GTK probe");
    assert!(
        output.status.success(),
        "GTK 无头探针失败: stdout={} stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let report: serde_json::Value =
        serde_json::from_slice(&fs::read(&out).expect("读取 GTK 探针报告")).expect("探针 JSON");
    assert_eq!(
        report["ok"],
        serde_json::Value::Bool(true),
        "报告: {report}"
    );
    assert_eq!(report["page_before"].as_str(), Some("workbench"));
    assert_eq!(
        report["switches"],
        serde_json::json!(["companion", "workbench", "inspector", "companion"]),
        "Ctrl+1/2/3 必须即时切到对应密度: {report}"
    );
    assert_eq!(report["rev_delta"].as_u64(), Some(4));
    assert_eq!(report["restored_page"].as_str(), Some("inspector"));
    assert_eq!(
        report["persisted_size"], report["window_size"],
        "落盘尺寸必须等于真实窗口尺寸（WM 无关）: {report}"
    );
    assert_eq!(
        report["reloaded_size"], report["window_size"],
        "重启后尺寸必须真实回环: {report}"
    );
    let persisted = report["persisted_size"].as_array().expect("persisted_size");
    let persisted_width = persisted[0].as_i64().unwrap_or(0);
    let persisted_height = persisted[1].as_i64().unwrap_or(0);
    assert!(
        persisted_width >= 320 && persisted_height >= 240,
        "持久化尺寸必须来自真实窗口: {report}"
    );
    assert_eq!(
        report["accels_installed"],
        serde_json::Value::Bool(true),
        "Ctrl+1/2/3 必须注册为 action accelerator: {report}"
    );
    assert!(
        report["shortcuts_mapped"]
            .as_array()
            .map(|values| values.iter().all(|v| v.as_bool() == Some(true)))
            .unwrap_or(false)
    );
    assert_eq!(report["accessible_button"], serde_json::Value::Bool(true));
    assert_eq!(report["accessible_live"], serde_json::Value::Bool(true));
    assert_eq!(report["window_visible"], serde_json::Value::Bool(true));

    // 可见性与无障碍角色的额外断言在子报告里逐页核对（被隐藏页不得占用布局）。
    let pages = report["pages_mapped"].as_array().expect("pages_mapped");
    for entry in pages {
        let page = entry[0].as_str().unwrap_or_default();
        let companion = entry[2].as_bool().unwrap_or(false);
        let workbench = entry[3].as_bool().unwrap_or(false);
        let inspector = entry[4].as_bool().unwrap_or(false);
        assert_eq!(
            companion,
            page == "companion",
            "companion 映射错误: {entry}"
        );
        assert_eq!(
            workbench,
            page == "workbench",
            "workbench 映射错误: {entry}"
        );
        assert_eq!(
            inspector,
            page == "inspector",
            "inspector 映射错误: {entry}"
        );
    }
}

// ---------------------------------------------------------------------------
// 4. 真实守护进程 + 真实二进制无头冒烟；以及无守护进程/无 DBus 的优雅降级
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
    assert!(
        stdout.contains("connected=true"),
        "必须经薄客户端连上真实守护进程: {stdout}"
    );
    assert!(
        stdout.contains("degraded=0"),
        "在线时不得进入降级态: {stdout}"
    );
    assert!(
        stdout.contains("density=workbench"),
        "默认密度应为工作台: {stdout}"
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
        "无守护进程必须进入类型化离线视图: {stdout}"
    );
    assert!(
        stdout.contains("degraded=1"),
        "离线视图必须显式标记降级: {stdout}"
    );
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
// 6. 生产路径快照：真实守护进程 → 会话/审计/良知行 + 良知正文（仅检视态）
// ---------------------------------------------------------------------------

#[test]
#[ignore = "由父测试以子进程方式驱动（需要 xvfb + 真实守护进程）"]
fn snapshot_child_probe() {
    let Some(out_path) = std::env::var_os(CHILD_SNAPSHOT_OUT).map(PathBuf::from) else {
        return;
    };
    let mut report = serde_json::json!({ "ok": false });
    if let Err(err) = gtk::init() {
        report["error"] = serde_json::Value::String(format!("gtk init 失败: {err}"));
        let _ = fs::write(&out_path, report.to_string());
        return;
    }
    let home = quetzalcoatl_client_core::resolve_client_home(None);
    let config_path = out_path.with_extension("desktop.json");
    let state = app::build_desktop(DesktopOptions {
        home,
        config_path: Some(config_path),
        self_test: false,
    });
    let desktop = state.borrow();
    let sessions = desktop.model.rows_of(model::KIND_SESSION).len();
    let audits = desktop.model.rows_of(model::KIND_AUDIT).len();
    let conscience = desktop.model.rows_of(model::KIND_CONSCIENCE).len();
    let workflow = desktop.model.rows_of(model::KIND_WORKFLOW).len();
    let body = desktop.model.conscience_body.clone().unwrap_or_default();
    report = serde_json::json!({
        "ok": desktop.model.connection.is_online()
            && sessions > 0
            && audits > 0
            && conscience > 0
            && !body.trim().is_empty(),
        "online": desktop.model.connection.is_online(),
        "sessions": sessions,
        "audits": audits,
        "conscience": conscience,
        "workflow": workflow,
        "conscience_body_chars": body.chars().count(),
        "model_rev": desktop.model.view.rev,
        "db_fds": spine_db_fds(),
        "rows_total": desktop.model.view.rows.len(),
    });
    fs::write(&out_path, report.to_string()).expect("写入快照探针报告");
}

#[test]
fn daemon_snapshot_populates_sessions_audit_and_conscience() {
    let home = TempDir::new("snapshot_daemon");
    let out = home.path().join("snapshot.json");
    let mut daemon = start_real_daemon(home.path());

    // 真实写入一条领域切换审计事件（守护进程会将其追加进脊柱）。
    let client = ThinClient::mount(home.path()).expect("薄客户端挂载");
    let packs = match client.call(&IpcRequest::DomainList) {
        Ok(IpcResponse::DomainPacks { packs, .. }) => packs,
        other => panic!("domain list 失败: {other:?}"),
    };
    let target = packs
        .iter()
        .map(|pack| pack.id.clone())
        .find(|id| id != "personal-companion")
        .expect("至少存在一个非默认领域包");
    match client.call(&IpcRequest::DomainUse { id: target.clone() }) {
        Ok(IpcResponse::DomainActivated(_)) | Ok(IpcResponse::DomainPacks { .. }) => {}
        other => panic!("domain use 失败: {other:?}"),
    }

    let output = spawn_probe("snapshot_child_probe", false)
        .env(CHILD_SNAPSHOT_OUT, &out)
        .env("QUETZALCOATL_HOME", home.path())
        .output()
        .expect("spawn snapshot probe");
    assert!(
        output.status.success(),
        "快照探针失败: stdout={} stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let report: serde_json::Value =
        serde_json::from_slice(&fs::read(&out).expect("读取快照报告")).expect("JSON");
    assert_eq!(
        report["ok"],
        serde_json::Value::Bool(true),
        "报告: {report}"
    );
    assert_eq!(report["online"], serde_json::Value::Bool(true));
    assert!(report["sessions"].as_u64().unwrap_or(0) > 0, "{report}");
    assert!(report["audits"].as_u64().unwrap_or(0) > 0, "{report}");
    assert!(report["conscience"].as_u64().unwrap_or(0) > 0, "{report}");
    assert!(
        report["conscience_body_chars"].as_u64().unwrap_or(0) > 0,
        "检视态必须能拿到良知锁定正文: {report}"
    );
    assert_eq!(
        report["db_fds"].as_array().map(Vec::len),
        Some(0),
        "桌面端读取快照不得持有 spine.sqlite: {report}"
    );

    daemon.shutdown().expect("关闭守护进程");
}

// ---------------------------------------------------------------------------
// 7. 工作台披露契约 + 工作台流式回复 + 应用级播报（仅一次）
// ---------------------------------------------------------------------------

#[test]
#[ignore = "由父测试以子进程方式驱动（需要 xvfb + 真实守护进程）"]
fn online_ui_child_probe() {
    let Some(out_path) = std::env::var_os(CHILD_ONLINE_UI_OUT).map(PathBuf::from) else {
        return;
    };
    let mut report = serde_json::json!({ "ok": false });
    if let Err(err) = gtk::init() {
        report["error"] = serde_json::Value::String(format!("gtk init 失败: {err}"));
        let _ = fs::write(&out_path, report.to_string());
        return;
    }
    let home = quetzalcoatl_client_core::resolve_client_home(None);
    let config_path = out_path.with_extension("desktop.json");
    let state = app::build_desktop(DesktopOptions {
        home,
        config_path: Some(config_path),
        self_test: false,
    });
    app::refresh(&state);
    state.borrow().window.present();
    let _ = app::pump_until_mapped(&state.borrow().widgets.workbench.root, 4_000);

    let workbench_text =
        quetzalcoatl_desktop::views::visible_text(&state.borrow().widgets.workbench.root);
    let inspector_text =
        quetzalcoatl_desktop::views::visible_text(&state.borrow().widgets.inspector.root);
    let disclosure_plain = !workbench_text.contains("pid")
        && !workbench_text.contains("127.0.0.1")
        && !workbench_text.contains("unix:")
        && !workbench_text.contains("STORAGE_")
        && !workbench_text.contains("IPC");
    let inspector_technical = inspector_text.contains("pid")
        && (inspector_text.contains("127.0.0.1") || inspector_text.contains("unix:"));

    // 工作台必须看得见自己的流式回复（同一份会话模型）。
    app::apply_density(&state, CognitionDensity::Workbench);
    let first_batch = vec![
        StreamEvent {
            seq: 1,
            kind: StreamEventKind::Delta,
            text: String::from("土壤湿度已经连续三天偏低，"),
        },
        StreamEvent {
            seq: 2,
            kind: StreamEventKind::Delta,
            text: String::from("我建议今晚补一次透水。"),
        },
        StreamEvent {
            seq: 3,
            kind: StreamEventKind::Done,
            text: String::from("stop"),
        },
    ];
    let ingested = app::ingest_stream_batch(&state, &first_batch);
    app::pump_events(80);
    let workbench_reply = state
        .borrow()
        .widgets
        .workbench
        .transcript
        .text()
        .to_string();
    let reply_visible = workbench_reply.contains("今晚补一次透水")
        && state.borrow().widgets.workbench.transcript.is_visible();

    // 播报必须独立于当前密度：工作台态下也播，且每批只播一次。
    let before = state.borrow().widgets.live.announcement_count();
    let second_batch = vec![
        StreamEvent {
            seq: 4,
            kind: StreamEventKind::Delta,
            text: String::from("如果需要，我也可以列出浇水清单。"),
        },
        StreamEvent {
            seq: 5,
            kind: StreamEventKind::Done,
            text: String::from("stop"),
        },
    ];
    let _ = app::ingest_stream_batch(&state, &second_batch);
    app::pump_events(80);
    let announced = state.borrow().widgets.live.announcement_count() - before;
    let page = state
        .borrow()
        .widgets
        .stack
        .visible_child_name()
        .map(|s| s.to_string())
        .unwrap_or_default();
    let live_independent = !state
        .borrow()
        .widgets
        .live
        .widget()
        .is_ancestor(&state.borrow().widgets.stack);

    let companion_text =
        quetzalcoatl_desktop::views::visible_text(&state.borrow().widgets.companion.root);

    report = serde_json::json!({
        "ok": disclosure_plain
            && inspector_technical
            && reply_visible
            && announced == 1
            && page == "workbench"
            && live_independent
            && ingested.deltas.contains("今晚补一次透水")
            && companion_text.contains("浇水清单"),
        "disclosure_plain": disclosure_plain,
        "inspector_technical": inspector_technical,
        "workbench_text": workbench_text,
        "inspector_text": inspector_text,
        "reply_visible": reply_visible,
        "workbench_reply": workbench_reply,
        "announced": announced,
        "page": page,
        "live_independent": live_independent,
        "companion_shared": companion_text.contains("浇水清单"),
        "db_fds": spine_db_fds(),
    });
    state.borrow().window.destroy();
    fs::write(&out_path, report.to_string()).expect("写入在线 UI 探针报告");
}

#[test]
fn workbench_stays_plain_and_shows_streaming_reply() {
    let home = TempDir::new("online_ui_daemon");
    let out = home.path().join("online_ui.json");
    let mut daemon = start_real_daemon(home.path());
    let output = spawn_probe("online_ui_child_probe", false)
        .env(CHILD_ONLINE_UI_OUT, &out)
        .env("QUETZALCOATL_HOME", home.path())
        .output()
        .expect("spawn online UI probe");
    assert!(
        output.status.success(),
        "在线 UI 探针失败: stdout={} stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let report: serde_json::Value =
        serde_json::from_slice(&fs::read(&out).expect("读取在线 UI 报告")).expect("JSON");
    assert_eq!(
        report["ok"],
        serde_json::Value::Bool(true),
        "报告: {report}"
    );
    assert_eq!(report["disclosure_plain"], serde_json::Value::Bool(true));
    assert_eq!(report["inspector_technical"], serde_json::Value::Bool(true));
    assert_eq!(report["reply_visible"], serde_json::Value::Bool(true));
    assert_eq!(report["announced"].as_u64(), Some(1));
    assert_eq!(report["page"].as_str(), Some("workbench"));
    assert_eq!(
        report["db_fds"].as_array().map(Vec::len),
        Some(0),
        "UI 路径不得持有 spine.sqlite: {report}"
    );
    daemon.shutdown().expect("关闭守护进程");
}

// ---------------------------------------------------------------------------
// 8. 托盘驻留：关闭隐藏 → 托盘唤醒 → 托盘菜单退出；无宿主时关闭即退出
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
    let mut report = serde_json::json!({ "ok": false });
    let Some(_watcher) = install_stub_watcher() else {
        report["error"] = serde_json::Value::String(String::from(
            "私有会话总线上无法注册桩 StatusNotifierWatcher",
        ));
        let _ = fs::write(&out_path, report.to_string());
        return;
    };
    let home = quetzalcoatl_client_core::resolve_client_home(None);
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
                            record("process_alive_after_close", true);
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
    });
    fs::write(&out_path, report.to_string()).expect("写入托盘探针报告");
}

#[test]
fn tray_hides_on_close_reactivates_and_quits() {
    let home = TempDir::new("tray_probe");
    let out = home.path().join("tray.json");
    let output = spawn_probe("tray_child_probe", true)
        .env(CHILD_TRAY_OUT, &out)
        .env("QUETZALCOATL_HOME", home.path().join("home"))
        .output()
        .expect("spawn tray probe");
    assert!(
        output.status.success(),
        "托盘探针失败: stdout={} stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
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
    let home = quetzalcoatl_client_core::resolve_client_home(None);
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
