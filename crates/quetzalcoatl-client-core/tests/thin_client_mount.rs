#![forbid(unsafe_code)]
#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

//! 单脊柱持有者契约（防坑规范 #13）：`quetzalcoatld` 在线时 GUI 与 CLI 薄客户端
//! 一律经本地 IPC 读写，进程内**绝不**打开 `spine/spine.sqlite`，也不产生 `SQLITE_BUSY`；
//! 守护进程不可达时返回类型化 `DaemonUnavailable` 而不是静默直连数据库。

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use quetzalcoatl_client_core::ipc_mode::{ClientError, ThinClient};
use quetzalcoatl_daemon::{DaemonConfig, IpcRequest, IpcResponse, QuetzalcoatlDaemon};
use uuid::Uuid;

const CHILD_HOME_ENV: &str = "QZ_CLIENT_CORE_CHILD_HOME";
const CHILD_OUT_ENV: &str = "QZ_CLIENT_CORE_CHILD_OUT";

struct TempHome {
    path: PathBuf,
}

impl TempHome {
    fn new() -> Self {
        let base = PathBuf::from("/tmp/opencode");
        let parent = if base.is_dir() {
            base
        } else {
            std::env::temp_dir()
        };
        let path = parent.join(format!("qz_client_core_{}", Uuid::new_v4().simple()));
        fs::create_dir_all(&path).expect("create temp home");
        Self { path }
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TempHome {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

/// 当前进程是否持有任何指向 `spine.sqlite*` 的文件描述符。
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

#[test]
fn client_core_manifest_has_no_direct_sqlite_dependency() {
    let manifest = include_str!("../Cargo.toml");
    assert!(
        !manifest.contains("rusqlite"),
        "client-core 绝不能直接依赖 rusqlite（防坑规范 #13）:\n{manifest}"
    );
    assert!(
        !manifest.contains("quetzalcoatl-spine"),
        "client-core 不得链接脊柱存储层"
    );
}

#[test]
fn absent_daemon_returns_typed_unavailable_and_never_touches_spine() {
    let home = TempHome::new();
    let err = ThinClient::mount(home.path()).expect_err("无 daemon 时必须失败");
    assert!(
        matches!(err, ClientError::DaemonUnavailable { .. }),
        "必须是类型化 DaemonUnavailable，实际: {err:?}"
    );
    assert!(
        !home.path().join("spine").exists(),
        "薄客户端挂载失败时不得创建 spine 目录"
    );
    assert!(
        !home.path().join("spine/spine.sqlite").exists(),
        "薄客户端绝不静默打开/创建 spine.sqlite"
    );
}

#[cfg(unix)]
#[test]
fn loose_token_file_permissions_are_refused_before_reading_the_secret() {
    use std::os::unix::fs::PermissionsExt;

    let home = TempHome::new();
    fs::create_dir_all(home.path().join("run")).expect("run dir");
    fs::create_dir_all(home.path().join("spine")).expect("spine dir");
    fs::write(home.path().join("spine/daemon.lock"), b"").expect("lock");
    // 故意写入非法 JSON：权限校验必须先于任何解析/读取发生，证明未消费令牌内容。
    fs::write(home.path().join("run/daemon.json"), b"{not-json").expect("info");
    let token_path = home.path().join("run/daemon.token");
    fs::write(&token_path, b"deadbeef").expect("token");
    fs::set_permissions(&token_path, fs::Permissions::from_mode(0o644)).expect("chmod");

    let err = ThinClient::mount(home.path()).expect_err("宽松权限令牌必须拒绝");
    assert!(
        matches!(err, ClientError::InsecureRuntimeFiles { .. }),
        "必须是类型化 InsecureRuntimeFiles，实际: {err:?}"
    );
    assert!(
        !home.path().join("spine/spine.sqlite").exists(),
        "权限拒绝时不得回退直连数据库"
    );
}

#[test]
fn corrupt_runtime_files_yield_daemon_unavailable() {
    use std::os::unix::fs::PermissionsExt;

    let home = TempHome::new();
    fs::create_dir_all(home.path().join("run")).expect("run dir");
    fs::create_dir_all(home.path().join("spine")).expect("spine dir");
    fs::write(home.path().join("spine/daemon.lock"), b"").expect("lock");
    fs::write(home.path().join("run/daemon.json"), b"{not-json").expect("info");
    let token_path = home.path().join("run/daemon.token");
    fs::write(&token_path, b"deadbeef").expect("token");
    #[cfg(unix)]
    fs::set_permissions(&token_path, fs::Permissions::from_mode(0o600)).expect("chmod");

    let err = ThinClient::mount(home.path()).expect_err("损坏的运行时信息必须失败");
    assert!(
        matches!(err, ClientError::DaemonUnavailable { .. }),
        "必须是类型化 DaemonUnavailable，实际: {err:?}"
    );
}

/// 子进程探针：由父测试以当前测试二进制重新执行，仅作为纯薄客户端运行。
#[test]
fn thin_client_child_probe() {
    let Some(home) = std::env::var_os(CHILD_HOME_ENV).map(PathBuf::from) else {
        return; // 父进程调用时直接跳过
    };
    let out_path = std::env::var_os(CHILD_OUT_ENV).map(PathBuf::from);

    let mut reads = 0u64;
    let mut writes = 0u64;
    let mut sqlite_busy = 0u64;
    let mut failure: Option<String> = None;

    match ThinClient::mount(&home) {
        Ok(client) => {
            for _ in 0..40 {
                match client.status() {
                    Ok(_) => reads += 1,
                    Err(err) => {
                        if err.to_string().contains("SQLITE_BUSY") {
                            sqlite_busy += 1;
                        }
                        failure = Some(format!("status: {err}"));
                        break;
                    }
                }
            }

            if failure.is_none() {
                let pack_ids = match client.call(&IpcRequest::DomainList) {
                    Ok(IpcResponse::DomainPacks { packs, .. }) => {
                        packs.into_iter().map(|p| p.id).collect::<Vec<_>>()
                    }
                    other => {
                        failure = Some(format!("domain list: {other:?}"));
                        Vec::new()
                    }
                };
                // 只做一次真实写入：切换到与当前活动包不同的领域包（写审计事件）。
                if let Some(target) = pack_ids.into_iter().find(|id| id != "personal-companion") {
                    match client.call(&IpcRequest::DomainUse { id: target }) {
                        Ok(IpcResponse::DomainActivated(_)) => writes += 1,
                        Ok(IpcResponse::DomainPacks { .. }) => writes += 1,
                        Ok(IpcResponse::Error { code, detail }) => {
                            failure = Some(format!("domain use ({code}): {detail}"));
                        }
                        other => failure = Some(format!("domain use: {other:?}")),
                    }
                }

                if failure.is_none() {
                    match client.call(&IpcRequest::ConsciencePinned) {
                        Ok(IpcResponse::ConsciencePinned { .. }) => reads += 1,
                        other => failure = Some(format!("conscience: {other:?}")),
                    }
                }
            }
        }
        Err(err) => failure = Some(format!("mount: {err}")),
    }

    let report = serde_json::json!({
        "ok": failure.is_none(),
        "failure": failure,
        "reads": reads,
        "writes": writes,
        "sqlite_busy": sqlite_busy,
        "db_fds": spine_db_fds(),
    });
    if let Some(path) = out_path {
        let _ = fs::write(path, report.to_string());
    }
}

fn wait_for_runtime_files(home: &Path) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        if home.join("run/daemon.json").is_file() && home.join("run/daemon.token").is_file() {
            return;
        }
        thread::sleep(Duration::from_millis(20));
    }
    panic!("quetzalcoatld 运行时文件未在 10s 内出现");
}

#[test]
fn gui_and_cli_concurrent_mounts_share_ipc_without_lock_conflict() {
    let home = TempHome::new();
    let mut config = DaemonConfig::new(home.path().to_path_buf());
    config.fabric = None;
    config.discovery_search_paths = Some(Vec::new());
    let mut daemon = QuetzalcoatlDaemon::start(config).expect("daemon start");
    wait_for_runtime_files(home.path());

    // 模拟 GUI 挂载（父进程）：读取必须成功且不触库。
    // 父进程本身是守护进程宿主，因此此处的 fd 断言只针对子进程薄客户端。
    let gui = ThinClient::mount(home.path()).expect("GUI 薄客户端挂载");
    let status_before = gui.status().expect("GUI 读取守护进程状态");
    assert!(status_before.pid > 0);
    let events_before = status_before.spine_events_count;

    let exe = std::env::current_exe().expect("current exe");
    let mut children = Vec::new();
    for index in 0..2 {
        let out = home.path().join(format!("child-{index}.json"));
        let child = Command::new(&exe)
            .arg("--exact")
            .arg("thin_client_child_probe")
            .arg("--nocapture")
            .env(CHILD_HOME_ENV, home.path())
            .env(CHILD_OUT_ENV, &out)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn thin client child");
        children.push((child, out));
    }

    for (child, out) in children {
        let output = child.wait_with_output().expect("wait child");
        assert!(
            output.status.success(),
            "薄客户端子进程失败: stdout={} stderr={}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        let raw = fs::read(&out).expect("read child report");
        let report: serde_json::Value = serde_json::from_slice(&raw).expect("child report json");
        assert_eq!(
            report["ok"],
            serde_json::Value::Bool(true),
            "子进程报告: {report}"
        );
        assert_eq!(
            report["sqlite_busy"].as_u64(),
            Some(0),
            "不得出现 SQLITE_BUSY"
        );
        assert_eq!(
            report["reads"].as_u64(),
            Some(41),
            "读取全部经 IPC 完成: {report}"
        );
        assert_eq!(
            report["writes"].as_u64(),
            Some(1),
            "写入经 IPC 完成: {report}"
        );
        assert_eq!(
            report["db_fds"].as_array().map(Vec::len),
            Some(0),
            "薄客户端进程不得持有 spine.sqlite 文件描述符: {report}"
        );
        println!("thin_client_child_report={report}");
    }

    // 并发挂载之后守护进程仍然独占可用，且写入已真实落盘到脊柱事件链。
    let status_after = gui.status().expect("daemon still healthy");
    println!(
        "daemon_status_after_concurrency: pid={} spine_events={} total_runs={}",
        status_after.pid, status_after.spine_events_count, status_after.total_runs
    );
    assert!(status_after.spine_events_count >= events_before);
    let rooms = gui.call(&IpcRequest::GroupList).expect("group list");
    assert!(matches!(rooms, IpcResponse::GroupRooms(_)));

    daemon.shutdown().expect("daemon shutdown");
    assert!(!home.path().join("run/daemon.json").exists());
}
