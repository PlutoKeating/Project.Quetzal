#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]

//! 治理面的同源托管：静态资源 + `/auth/local` + `/health` + `POST /rpc`。
//! 使用真实守护进程与真实回环 TCP；治理面只有请求/响应，没有长连接。

mod common;

use std::error::Error;
use std::fs;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::time::Duration;

use quetzalcoatl_daemon::{DaemonConfig, QuetzalcoatlDaemon};

type TestResult = Result<(), Box<dyn Error>>;

struct TempDirGuard {
    path: PathBuf,
}

impl TempDirGuard {
    fn new(prefix: &str) -> Result<Self, Box<dyn Error>> {
        let path = common::temp_root(prefix)?;
        Ok(Self { path })
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TempDirGuard {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

struct RunningDaemon {
    handle: quetzalcoatl_daemon::DaemonHandle,
    addr: SocketAddr,
}

impl RunningDaemon {
    fn start(web_dir: Option<PathBuf>, home: &Path) -> Result<Self, Box<dyn Error>> {
        let mut config = DaemonConfig::new(home.to_path_buf());
        config.fabric = None;
        config.discovery_search_paths = Some(Vec::new());
        config.web_dir = web_dir;
        let handle = QuetzalcoatlDaemon::start(config)?;
        let addr = handle.runtime_info().ipc_http_addr;
        Ok(Self { handle, addr })
    }
}

impl Drop for RunningDaemon {
    fn drop(&mut self) {
        let _ = self.handle.shutdown();
    }
}

fn seed_web_dir(dir: &Path) -> Result<(), Box<dyn Error>> {
    fs::create_dir_all(dir.join("assets"))?;
    fs::write(
        dir.join("index.html"),
        "<!doctype html><html lang=\"zh\"><head><meta charset=\"utf-8\"><title>羽蛇神</title><link rel=\"stylesheet\" href=\"/assets/app.css\"></head><body><div id=\"app\"></div><script type=\"module\" src=\"/assets/app.js\"></script></body></html>",
    )?;
    fs::write(dir.join("assets/app.js"), "console.log('quetzalcoatl');")?;
    fs::write(dir.join("assets/app.css"), ":root{color-scheme:light dark}")?;
    Ok(())
}

struct HttpResponse {
    status: u16,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl HttpResponse {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }

    fn json(&self) -> Result<serde_json::Value, Box<dyn Error>> {
        Ok(serde_json::from_slice(&self.body)?)
    }
}

fn http_request(
    addr: SocketAddr,
    method: &str,
    path: &str,
    headers: &[(&str, &str)],
    body: &[u8],
) -> Result<HttpResponse, Box<dyn Error>> {
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_secs(5))?;
    stream.set_read_timeout(Some(Duration::from_secs(20)))?;
    stream.set_write_timeout(Some(Duration::from_secs(20)))?;
    let mut head = format!(
        "{method} {path} HTTP/1.1\r\nHost: {addr}\r\nContent-Length: {}\r\nConnection: close\r\n",
        body.len()
    );
    for (name, value) in headers {
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    head.push_str("\r\n");
    stream.write_all(head.as_bytes())?;
    stream.write_all(body)?;
    stream.flush()?;

    let mut raw = Vec::new();
    stream.read_to_end(&mut raw)?;
    let sep = raw
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .ok_or("HTTP 响应缺少头部终止符")?;
    let head_text = std::str::from_utf8(&raw[..sep])?;
    let mut lines = head_text.split("\r\n");
    let status_line = lines.next().ok_or("缺少状态行")?;
    let status = status_line
        .split_whitespace()
        .nth(1)
        .ok_or("缺少状态码")?
        .parse::<u16>()?;
    let headers: Vec<(String, String)> = lines
        .filter_map(|line| line.split_once(':'))
        .map(|(key, value)| (key.trim().to_ascii_lowercase(), value.trim().to_owned()))
        .collect();
    Ok(HttpResponse {
        status,
        headers,
        body: raw[sep + 4..].to_vec(),
    })
}

fn auth_token(daemon: &RunningDaemon) -> Result<String, Box<dyn Error>> {
    let origin = format!("http://{}", daemon.addr);
    let response = http_request(
        daemon.addr,
        "POST",
        "/auth/local",
        &[("Origin", origin.as_str())],
        b"",
    )?;
    if response.status != 200 {
        return Err(format!("POST /auth/local 状态 {}", response.status).into());
    }
    let json = response.json()?;
    let token = json
        .get("token")
        .and_then(|value| value.as_str())
        .ok_or("认证响应缺少 token")?;
    Ok(token.to_owned())
}

/// 发送一个客户端到服务端的掩码文本帧。
#[test]
fn web_console_serves_static_assets_and_enforces_loopback_origin() -> TestResult {
    let home = TempDirGuard::new("qz_web_home")?;
    let web = TempDirGuard::new("qz_web_dist")?;
    seed_web_dir(web.path())?;
    let daemon = RunningDaemon::start(Some(web.path().to_path_buf()), home.path())?;

    // 1. 根路径返回 index.html 并附带严格 CSP/防嗅探头。
    let index = http_request(daemon.addr, "GET", "/", &[], b"")?;
    assert_eq!(index.status, 200, "GET / 必须返回 200");
    assert!(
        index
            .header("content-type")
            .is_some_and(|value| value.starts_with("text/html")),
        "GET / 必须是 text/html"
    );
    let csp = index.header("content-security-policy").unwrap_or_default();
    assert!(csp.contains("default-src 'self'"));
    assert!(csp.contains("frame-ancestors 'none'"));
    assert_eq!(
        index.header("x-content-type-options"),
        Some("nosniff"),
        "必须禁止 MIME 嗅探"
    );
    assert!(String::from_utf8_lossy(&index.body).contains("/assets/app.js"));

    let asset = http_request(daemon.addr, "GET", "/assets/app.js", &[], b"")?;
    assert_eq!(asset.status, 200);
    assert!(
        asset
            .header("content-type")
            .is_some_and(|value| value.contains("javascript")),
        "JS 资源必须带 javascript MIME"
    );

    // 2. SPA 深链回退到 index.html；带扩展名的缺失资源必须 404。
    let deep_link = http_request(daemon.addr, "GET", "/rooms/alpha", &[], b"")?;
    assert_eq!(deep_link.status, 200);
    assert!(String::from_utf8_lossy(&deep_link.body).contains("id=\"app\""));
    let missing = http_request(daemon.addr, "GET", "/assets/nope.js", &[], b"")?;
    assert_eq!(missing.status, 404);

    // 3. 路径穿越必须拒绝。
    let traversal = http_request(daemon.addr, "GET", "/../Cargo.toml", &[], b"")?;
    assert!(
        traversal.status == 403 || traversal.status == 404,
        "路径穿越必须拒绝，实际 {}",
        traversal.status
    );
    let encoded = http_request(daemon.addr, "GET", "/%2e%2e/Cargo.toml", &[], b"")?;
    assert!(encoded.status == 403 || encoded.status == 404);

    // 4. /health 零令牌可读，但 /auth/local 拒绝跨源 Origin。
    let health = http_request(daemon.addr, "GET", "/health", &[], b"")?;
    assert_eq!(health.status, 200);
    let health_json = health.json()?;
    assert_eq!(health_json["status"], "ok");
    assert_eq!(health_json["web"], true);

    let cross_origin = http_request(
        daemon.addr,
        "GET",
        "/auth/local",
        &[("Origin", "http://evil.example")],
        b"",
    )?;
    assert_eq!(cross_origin.status, 403, "跨源必须拒绝");

    let mismatched_port = http_request(
        daemon.addr,
        "GET",
        "/auth/local",
        &[("Origin", "http://127.0.0.1:1")],
        b"",
    )?;
    assert_eq!(mismatched_port.status, 403, "非同源端口必须拒绝");

    // 5. 令牌可用，HTTP /rpc 兜底可调用管理员 RPC。
    let token = auth_token(&daemon)?;
    assert_eq!(token.len(), 64, "Web 会话令牌必须是 256-bit hex");
    let rpc = http_request(
        daemon.addr,
        "POST",
        "/rpc",
        &[("Authorization", &format!("Bearer {token}"))],
        br#"{"method":"status"}"#,
    )?;
    assert_eq!(rpc.status, 200);
    assert_eq!(rpc.json()?["kind"], "status");

    let unauthenticated =
        http_request(daemon.addr, "POST", "/rpc", &[], br#"{"method":"status"}"#)?;
    assert_eq!(unauthenticated.status, 401);
    let bad_token = http_request(
        daemon.addr,
        "POST",
        "/rpc",
        &[("Authorization", "Bearer deadbeef")],
        br#"{"method":"status"}"#,
    )?;
    assert_eq!(bad_token.status, 401);

    // 6. /v1/rpc 原有管理员令牌通道不受影响。
    let legacy = http_request(
        daemon.addr,
        "POST",
        "/v1/rpc",
        &[("x-qz-ipc-token", daemon.handle.ipc_token())],
        br#"{"method":"status"}"#,
    )?;
    assert_eq!(legacy.status, 200);
    assert_eq!(legacy.json()?["kind"], "status");
    Ok(())
}

#[test]
fn web_console_absent_keeps_legacy_ipc_and_returns_404() -> TestResult {
    let home = TempDirGuard::new("qz_web_off_home")?;
    let daemon = RunningDaemon::start(None, home.path())?;
    let root = http_request(daemon.addr, "GET", "/", &[], b"")?;
    assert_eq!(root.status, 404, "未配置 web 目录时根路径必须 404");
    let health = http_request(daemon.addr, "GET", "/health", &[], b"")?;
    assert_eq!(health.status, 200, "/health 与 web 目录无关");
    // 未显式配置 web 根时，认证与 RPC 面必须整体不存在（不只是静态 404）。
    let origin = format!("http://{}", daemon.addr);
    let auth = http_request(
        daemon.addr,
        "POST",
        "/auth/local",
        &[("Origin", origin.as_str())],
        b"",
    )?;
    assert_eq!(auth.status, 404, "未配置 web 根时不得签发会话令牌");
    let rpc = http_request(
        daemon.addr,
        "POST",
        "/rpc",
        &[("Authorization", "Bearer deadbeef")],
        br#"{"method":"status"}"#,
    )?;
    assert_eq!(rpc.status, 404, "未配置 web 根时不得暴露 Web RPC");

    // 禁用控制台的 404 在 HEAD 下也不能写响应体。
    let head_root = http_request(daemon.addr, "HEAD", "/", &[], b"")?;
    assert_eq!(head_root.status, 404);
    assert!(head_root.body.is_empty(), "禁用控制台 HEAD 不得写响应体");
    let get_root = http_request(daemon.addr, "GET", "/", &[], b"")?;
    assert_eq!(get_root.status, 404);
    assert!(!get_root.body.is_empty(), "GET 404 应有类型化错误体");
    let legacy = http_request(
        daemon.addr,
        "POST",
        "/v1/rpc",
        &[("x-qz-ipc-token", daemon.handle.ipc_token())],
        br#"{"method":"status"}"#,
    )?;
    assert_eq!(legacy.status, 200);
    Ok(())
}

fn assert_rejected_method(
    daemon: &RunningDaemon,
    token: &str,
    method: &str,
) -> Result<(), Box<dyn Error>> {
    let body = format!(r#"{{"method":"{method}","params":{{}}}}"#);
    let response = http_request(
        daemon.addr,
        "POST",
        "/rpc",
        &[("Authorization", &format!("Bearer {token}"))],
        body.as_bytes(),
    )?;
    assert_eq!(
        response.status, 403,
        "特权方法 {method} 必须被 Web 控制台拒绝，实际 {}",
        response.status
    );
    let json = response.json()?;
    assert_eq!(
        json["data"]["code"], "PERMISSION_DENIED",
        "拒绝必须带类型化 code（{method}）"
    );
    Ok(())
}

#[test]
fn web_auth_requires_same_origin_and_rejects_curl_style_requests() -> TestResult {
    let home = TempDirGuard::new("qz_web_auth_home")?;
    let web = TempDirGuard::new("qz_web_auth_dist")?;
    seed_web_dir(web.path())?;
    let daemon = RunningDaemon::start(Some(web.path().to_path_buf()), home.path())?;
    let same_origin = format!("http://{}", daemon.addr);

    // curl 式：无 Origin 一律 403（GET 与 POST 都不放行）。
    for method in ["GET", "POST"] {
        let response = http_request(daemon.addr, method, "/auth/local", &[], b"")?;
        assert_eq!(
            response.status, 403,
            "无 Origin 的 {method} /auth/local 必须 403"
        );
    }
    let cross = http_request(
        daemon.addr,
        "POST",
        "/auth/local",
        &[("Origin", "http://evil.example")],
        b"",
    )?;
    assert_eq!(cross.status, 403);
    let other_port = http_request(
        daemon.addr,
        "POST",
        "/auth/local",
        &[("Origin", "http://127.0.0.1:1")],
        b"",
    )?;
    assert_eq!(other_port.status, 403);

    let allowed = http_request(
        daemon.addr,
        "POST",
        "/auth/local",
        &[("Origin", same_origin.as_str())],
        b"",
    )?;
    assert_eq!(allowed.status, 200);
    Ok(())
}

#[test]
fn web_rpc_enforces_method_allowlist_and_web_token_cannot_touch_admin_ipc() -> TestResult {
    let home = TempDirGuard::new("qz_web_allow_home")?;
    let web = TempDirGuard::new("qz_web_allow_dist")?;
    seed_web_dir(web.path())?;
    let daemon = RunningDaemon::start(Some(web.path().to_path_buf()), home.path())?;
    let token = auth_token(&daemon)?;

    let status = http_request(
        daemon.addr,
        "POST",
        "/rpc",
        &[("Authorization", &format!("Bearer {token}"))],
        br#"{"method":"status"}"#,
    )?;
    assert_eq!(status.status, 200, "status 必须在 Web 允许清单内");

    for method in [
        "conscience_pinned",
        "export",
        "import_v1",
        "fabric_login",
        "fabric_pair_start",
        "group_list",
        "group_send",
        "channel_deliver",
        "say_it_ingest",
        "webhook_pull",
        "domain_use",
        "shutdown",
        "set_permission",
        "set_sentinel",
        "self_update",
        "restart",
        "quit",
        "secrets",
        "secrets_get",
    ] {
        assert_rejected_method(&daemon, &token, method)?;
    }

    // Web 会话令牌绝不能当作管理 IPC 令牌使用。
    let admin_with_web_token = http_request(
        daemon.addr,
        "POST",
        "/v1/rpc",
        &[("Authorization", &format!("Bearer {token}"))],
        br#"{"method":"status"}"#,
    )?;
    assert_eq!(admin_with_web_token.status, 401);

    Ok(())
}

#[test]
fn head_requests_write_headers_without_body() -> TestResult {
    let home = TempDirGuard::new("qz_web_head_home")?;
    let web = TempDirGuard::new("qz_web_head_dist")?;
    seed_web_dir(web.path())?;
    let daemon = RunningDaemon::start(Some(web.path().to_path_buf()), home.path())?;
    for path in ["/health", "/", "/assets/app.js"] {
        let response = http_request(daemon.addr, "HEAD", path, &[], b"")?;
        assert_eq!(response.status, 200, "HEAD {path} 状态");
        assert!(response.body.is_empty(), "HEAD {path} 绝不能写响应体");
        assert!(
            response
                .header("content-length")
                .is_some_and(|value| value != "0"),
            "HEAD {path} 仍必须携带真实 Content-Length"
        );
    }
    Ok(())
}

#[cfg(unix)]
#[test]
fn static_serving_rejects_symlink_escape_and_dotfiles() -> TestResult {
    use std::os::unix::fs::symlink;
    let home = TempDirGuard::new("qz_web_sym_home")?;
    let web = TempDirGuard::new("qz_web_sym_dist")?;
    seed_web_dir(web.path())?;
    let outside = TempDirGuard::new("qz_web_outside")?;
    let secret = outside.path().join("secret.txt");
    fs::write(&secret, "TOP_SECRET_OUTSIDE_ROOT")?;
    symlink(&secret, web.path().join("escape.txt"))?;
    fs::create_dir_all(web.path().join(".git"))?;
    fs::write(web.path().join(".git/config"), "[core]")?;
    let daemon = RunningDaemon::start(Some(web.path().to_path_buf()), home.path())?;

    let escaped = http_request(daemon.addr, "GET", "/escape.txt", &[], b"")?;
    assert!(
        escaped.status == 403 || escaped.status == 404,
        "符号链接逃逸必须拒绝，实际 {}",
        escaped.status
    );
    assert!(!String::from_utf8_lossy(&escaped.body).contains("TOP_SECRET_OUTSIDE_ROOT"));

    let dotfile = http_request(daemon.addr, "GET", "/.git/config", &[], b"")?;
    assert!(
        dotfile.status == 403 || dotfile.status == 404,
        "点文件必须拒绝，实际 {}",
        dotfile.status
    );
    Ok(())
}

#[test]
fn governance_methods_answer_over_plain_http_without_params() -> TestResult {
    let home = TempDirGuard::new("gov-http")?;
    let web = TempDirGuard::new("gov-web")?;
    seed_web_dir(web.path())?;
    let daemon = RunningDaemon::start(Some(web.path().to_path_buf()), home.path())?;
    let token = auth_token(&daemon)?;
    let auth = format!("Bearer {token}");

    // 无参方法的请求体不带 params。
    let overview = http_request(
        daemon.addr,
        "POST",
        "/rpc",
        &[("Authorization", &auth)],
        br#"{"method":"sea_overview"}"#,
    )?;
    assert_eq!(overview.status, 200);
    let body = overview.json()?;
    assert_eq!(body["kind"], "sea_overview", "{body}");
    assert_eq!(body["data"]["baseline"]["signed"], false);

    let memories = http_request(
        daemon.addr,
        "POST",
        "/rpc",
        &[("Authorization", &auth)],
        br#"{"method":"sea_memories","params":{"state":"all","limit":5}}"#,
    )?;
    assert_eq!(memories.json()?["kind"], "sea_memories");

    // 旧的长连接与快照通道已经不存在。
    let gone = http_request(
        daemon.addr,
        "GET",
        "/rpc/snapshot",
        &[("Authorization", &auth)],
        b"",
    )?;
    // 无扩展名的路径落到页面本身（单页应用的深链），不再是数据快照。
    let body = String::from_utf8_lossy(&gone.body);
    assert!(
        !body.contains("\"rows\""),
        "/rpc/snapshot 不应再提供数据快照: {body}"
    );
    for removed in ["agents", "web_commit_artifact"] {
        assert_rejected_method(&daemon, &token, removed)?;
    }
    Ok(())
}
