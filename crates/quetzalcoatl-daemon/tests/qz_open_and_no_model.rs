#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]

//! 新手验收回归：
//! 1. `qz up` 打印 Web 控制台 URL，`qz open` 在无桌面时打印同一个 URL 并以 0 退出；
//! 2. 没有任何模型凭据时，`qz chat` 返回单前缀的 `MODEL_NOT_CONFIGURED`，并**绝不**向上游发请求。
//!
//! 「不向上游发请求」用一个本地计数监听器证明：它只统计 TCP 连接数，聊天前后必须为 0。

mod common;

use std::error::Error;
use std::io::Write;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::thread;
use std::time::Duration;

type TestResult = Result<(), Box<dyn Error + Send + Sync>>;

struct TempHome(PathBuf);

impl TempHome {
    fn new(tag: &str) -> std::io::Result<Self> {
        // 守护进程要在 `QUETZALCOATL_HOME/run/daemon.sock` 上绑定 Unix 域套接字，
        // 而 `CARGO_TARGET_TMPDIR` 在 CI（/home/runner/work/...）会长到超过 SUN_LEN。
        // 统一走仓库的短路径工具，路径预算不足时给出可诊断错误而不是晦涩的绑定失败。
        let path = common::temp_root(tag)?;
        Ok(Self(path))
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempHome {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// 只计数的假上游：任何意外的连接都会被记录，用来断言「无模型时零上游请求」。
struct CountingUpstream {
    port: u16,
    connections: Arc<AtomicUsize>,
    stop: Arc<AtomicBool>,
    handle: Option<thread::JoinHandle<()>>,
}

impl CountingUpstream {
    fn start() -> std::io::Result<Self> {
        let listener = TcpListener::bind(("127.0.0.1", 0))?;
        listener.set_nonblocking(true)?;
        let port = listener.local_addr()?.port();
        let connections = Arc::new(AtomicUsize::new(0));
        let stop = Arc::new(AtomicBool::new(false));
        let count = Arc::clone(&connections);
        let flag = Arc::clone(&stop);
        let handle = thread::spawn(move || {
            while !flag.load(Ordering::SeqCst) {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        count.fetch_add(1, Ordering::SeqCst);
                        let _ = stream.write_all(
                            b"HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                        );
                    }
                    Err(ref error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(10));
                    }
                    Err(_) => break,
                }
            }
        });
        Ok(Self {
            port,
            connections,
            stop,
            handle: Some(handle),
        })
    }

    fn connection_count(&self) -> usize {
        self.connections.load(Ordering::SeqCst)
    }
}

impl Drop for CountingUpstream {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

struct DaemonGuard {
    qz: PathBuf,
    home: PathBuf,
    qz_home: PathBuf,
}

impl Drop for DaemonGuard {
    fn drop(&mut self) {
        let _ = Command::new(&self.qz)
            .env("HOME", &self.home)
            .env("QUETZALCOATL_HOME", &self.qz_home)
            .args(["down"])
            .output();
    }
}

fn run_qz(
    qz: &Path,
    home: &Path,
    qz_home: &Path,
    args: &[&str],
) -> std::io::Result<std::process::Output> {
    Command::new(qz)
        .env("HOME", home)
        .env("QUETZALCOATL_HOME", qz_home)
        .env("QZ_NO_BROWSER", "1")
        .env_remove("QUETZALCOATL_UPSTREAM_BEARER_TOKEN")
        .args(args)
        .output()
}

#[test]
fn qz_open_prints_console_url_and_unconfigured_chat_is_typed_without_upstream_call() -> TestResult {
    let home = TempHome::new("newcomer")?;
    let qz_home = home.path().join("qzhome");
    let upstream = CountingUpstream::start()?;
    let qz = PathBuf::from(env!("CARGO_BIN_EXE_qz"));
    let daemon_bin = PathBuf::from(env!("CARGO_BIN_EXE_quetzalcoatld"));

    let up_out = Command::new(&qz)
        .env("HOME", home.path())
        .env("QUETZALCOATL_HOME", &qz_home)
        .env("QUETZALCOATL_DAEMON_BIN", &daemon_bin)
        .env(
            "QUETZALCOATL_UPSTREAM_BASE_URL",
            format!("http://127.0.0.1:{}", upstream.port),
        )
        .env_remove("QUETZALCOATL_UPSTREAM_BEARER_TOKEN")
        .args(["up"])
        .output()?;
    assert!(
        up_out.status.success(),
        "qz up failed: {}",
        String::from_utf8_lossy(&up_out.stderr)
    );
    let guard = DaemonGuard {
        qz: qz.clone(),
        home: home.path().to_path_buf(),
        qz_home: qz_home.clone(),
    };

    let up_stdout = String::from_utf8_lossy(&up_out.stdout);
    let console_url = up_stdout
        .lines()
        .find_map(|line| line.strip_prefix("console: "))
        .map(str::trim)
        .ok_or("qz up must print the console URL")?
        .to_owned();
    assert!(
        console_url.starts_with("http://127.0.0.1:") && console_url.ends_with('/'),
        "unexpected console URL: {console_url}"
    );

    // `qz open` 在无桌面时打印同一个 URL，并以 0 退出。
    let open_out = run_qz(&qz, home.path(), &qz_home, &["open"])?;
    assert!(
        open_out.status.success(),
        "qz open failed: {}",
        String::from_utf8_lossy(&open_out.stderr)
    );
    assert_eq!(
        String::from_utf8_lossy(&open_out.stdout).trim(),
        console_url,
        "qz open must print the same console URL"
    );

    // `qz status` 仍然是健康的。
    let status_out = run_qz(&qz, home.path(), &qz_home, &["status", "--json"])?;
    assert!(
        status_out.status.success(),
        "qz status failed: {}",
        String::from_utf8_lossy(&status_out.stderr)
    );

    // 无模型：单前缀的 MODEL_NOT_CONFIGURED，带可执行指引，且不触碰上游。
    let chat_out = run_qz(&qz, home.path(), &qz_home, &["chat", "你好"])?;
    assert!(
        !chat_out.status.success(),
        "chat without a configured model must fail"
    );
    let stderr = String::from_utf8_lossy(&chat_out.stderr);
    assert!(
        stderr.contains("MODEL_NOT_CONFIGURED"),
        "expected MODEL_NOT_CONFIGURED, got: {stderr}"
    );
    // 指引必须是真实可行的路径（Claude Code / Codex 登录，或显式 Bearer），
    // 不得再指向并不存在的「控制台 → 模型」设置页。
    assert!(
        stderr.contains("登录 Claude Code") && stderr.contains("codex login"),
        "error must list the real subscription-login paths: {stderr}"
    );
    assert!(
        stderr.contains("QUETZALCOATL_UPSTREAM_BEARER_TOKEN"),
        "error must name the explicit bearer override: {stderr}"
    );
    assert!(
        !stderr.contains("打开控制台 → 模型"),
        "error must not point at a console screen that does not exist: {stderr}"
    );
    assert!(
        !stderr.contains("零凭据代理拒绝请求: 零凭据代理拒绝请求:"),
        "error prefix must not be duplicated: {stderr}"
    );
    assert!(
        !stderr.contains("上游模型认证失败"),
        "no upstream auth call should be made: {stderr}"
    );
    assert_eq!(
        upstream.connection_count(),
        0,
        "chat without credentials must not open any upstream connection"
    );

    // 工程工作区分支必须与日常对话分支一致：先拒绝，不建 worktree、不发上游请求。
    let repo = home.path().join("repo");
    std::fs::create_dir_all(&repo)?;
    let workspace_chat = run_qz(
        &qz,
        home.path(),
        &qz_home,
        &[
            "chat",
            "重构一下",
            "--workspace",
            repo.to_str().ok_or("repo path")?,
        ],
    )?;
    assert!(
        !workspace_chat.status.success(),
        "workspace chat without a configured model must fail"
    );
    let workspace_stderr = String::from_utf8_lossy(&workspace_chat.stderr);
    assert!(
        workspace_stderr.contains("MODEL_NOT_CONFIGURED"),
        "workspace branch must return MODEL_NOT_CONFIGURED, got: {workspace_stderr}"
    );
    assert!(
        !workspace_stderr.contains("上游模型认证失败"),
        "workspace branch must not attempt an upstream auth call: {workspace_stderr}"
    );
    assert_eq!(
        upstream.connection_count(),
        0,
        "workspace chat without credentials must not open any upstream connection"
    );

    drop(guard);
    Ok(())
}

/// 浏览器启动器会继承父进程的标准流：若 `qz open` 不重定向子进程，调用方（管道、CI、脚本）
/// 会被一个长驻子进程挂住。本用例用一个「打印噪声后长睡」的假 xdg-open 复现该场景，
/// 要求 stdout 能正常 EOF 且 `qz open` 及时退出。
#[cfg(target_os = "linux")]
#[test]
fn qz_open_does_not_hold_the_callers_stdout_pipe_when_the_launcher_lingers() -> TestResult {
    use std::io::Read;
    use std::os::unix::fs::PermissionsExt;
    use std::process::Stdio;
    use std::sync::mpsc;

    let home = TempHome::new("open_linger")?;
    let qz_home = home.path().join("qzhome");
    let fake_bin = home.path().join("fakebin");
    std::fs::create_dir_all(&fake_bin)?;
    let launcher = fake_bin.join("xdg-open");
    std::fs::write(&launcher, "#!/bin/sh\necho launcher-noise\nsleep 10\n")?;
    std::fs::set_permissions(&launcher, std::fs::Permissions::from_mode(0o755))?;

    let qz = PathBuf::from(env!("CARGO_BIN_EXE_qz"));
    let daemon_bin = PathBuf::from(env!("CARGO_BIN_EXE_quetzalcoatld"));
    let path_env = format!(
        "{}:{}",
        fake_bin.display(),
        std::env::var("PATH").unwrap_or_default()
    );
    let up_out = Command::new(&qz)
        .env("HOME", home.path())
        .env("QUETZALCOATL_HOME", &qz_home)
        .env("QUETZALCOATL_DAEMON_BIN", &daemon_bin)
        .env("PATH", &path_env)
        .env("DISPLAY", ":0")
        .env_remove("WAYLAND_DISPLAY")
        .env_remove("QZ_NO_BROWSER")
        .env_remove("QUETZALCOATL_UPSTREAM_BEARER_TOKEN")
        .args(["up"])
        .output()?;
    assert!(
        up_out.status.success(),
        "qz up failed: {}",
        String::from_utf8_lossy(&up_out.stderr)
    );
    let guard = DaemonGuard {
        qz: qz.clone(),
        home: home.path().to_path_buf(),
        qz_home: qz_home.clone(),
    };

    let mut child = Command::new(&qz)
        .env("HOME", home.path())
        .env("QUETZALCOATL_HOME", &qz_home)
        .env("PATH", &path_env)
        .env("DISPLAY", ":0")
        .env_remove("WAYLAND_DISPLAY")
        .env_remove("QZ_NO_BROWSER")
        .args(["open"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let mut stdout = child.stdout.take().ok_or("qz open stdout missing")?;
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout.read_to_end(&mut buf);
        let _ = tx.send(buf);
    });

    let deadline = std::time::Instant::now() + Duration::from_secs(20);
    loop {
        if let Some(status) = child.try_wait()? {
            assert!(status.success(), "qz open exited with {status}");
            break;
        }
        if std::time::Instant::now() > deadline {
            let _ = child.kill();
            return Err("qz open did not exit; the browser launcher is blocking the caller".into());
        }
        thread::sleep(Duration::from_millis(50));
    }

    let captured = rx
        .recv_timeout(Duration::from_secs(5))
        .map_err(|_| "qz open left the caller's stdout pipe open (launcher inherited it)")?;
    let text = String::from_utf8_lossy(&captured);
    assert!(
        text.contains("opened http://127.0.0.1:"),
        "qz open must report the opened URL, got: {text}"
    );
    assert!(
        !text.contains("launcher-noise"),
        "the browser launcher must not write into the caller's stdout: {text}"
    );

    drop(guard);
    Ok(())
}
