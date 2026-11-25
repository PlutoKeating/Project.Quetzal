#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]

//! Task 4.2 验收：`quetzalcoatld` 同源静态托管 + `/auth/local` + `/health` + WebSocket `/rpc`
//! 与 HTTP `/rpc` 兜底。使用真实守护进程、真实回环 TCP 与手写 WebSocket 客户端。

use std::error::Error;
use std::fs;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::time::Duration;

use quetzalcoatl_daemon::{DaemonConfig, QuetzalcoatlDaemon};
use uuid::Uuid;

type TestResult = Result<(), Box<dyn Error>>;

struct TempDirGuard {
    path: PathBuf,
}

impl TempDirGuard {
    fn new(prefix: &str) -> Result<Self, Box<dyn Error>> {
        let base = PathBuf::from("/tmp/opencode");
        let parent = if base.is_dir() {
            base
        } else {
            std::env::temp_dir()
        };
        let path = parent.join(format!("{prefix}_{}", Uuid::new_v4().simple()));
        fs::create_dir_all(&path)?;
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
    let response = http_request(daemon.addr, "GET", "/auth/local", &[], b"")?;
    if response.status != 200 {
        return Err(format!("GET /auth/local 状态 {}", response.status).into());
    }
    let json = response.json()?;
    let token = json
        .get("token")
        .and_then(|value| value.as_str())
        .ok_or("认证响应缺少 token")?;
    Ok(token.to_owned())
}

/// 发送一个客户端到服务端的掩码文本帧。
fn ws_send_text(stream: &mut TcpStream, text: &str) -> Result<(), Box<dyn Error>> {
    let payload = text.as_bytes();
    let mask = [0x11u8, 0x22, 0x33, 0x44];
    let mut frame = vec![0x81u8];
    if payload.len() < 126 {
        frame.push(0x80 | u8::try_from(payload.len())?);
    } else {
        frame.push(0x80 | 126);
        frame.extend_from_slice(&u16::try_from(payload.len())?.to_be_bytes());
    }
    frame.extend_from_slice(&mask);
    for (index, byte) in payload.iter().enumerate() {
        frame.push(byte ^ mask[index % 4]);
    }
    stream.write_all(&frame)?;
    stream.flush()?;
    Ok(())
}

fn ws_read_frame(stream: &mut TcpStream) -> Result<(u8, Vec<u8>), Box<dyn Error>> {
    let mut header = [0u8; 2];
    stream.read_exact(&mut header)?;
    let opcode = header[0] & 0x0f;
    let masked = header[1] & 0x80 != 0;
    let mut length = u64::from(header[1] & 0x7f);
    if length == 126 {
        let mut extended = [0u8; 2];
        stream.read_exact(&mut extended)?;
        length = u64::from(u16::from_be_bytes(extended));
    } else if length == 127 {
        let mut extended = [0u8; 8];
        stream.read_exact(&mut extended)?;
        length = u64::from_be_bytes(extended);
    }
    if length > 4 * 1024 * 1024 {
        return Err("WebSocket 帧过大".into());
    }
    let mut mask = [0u8; 4];
    if masked {
        stream.read_exact(&mut mask)?;
    }
    let mut payload = vec![0u8; usize::try_from(length)?];
    stream.read_exact(&mut payload)?;
    if masked {
        for (index, byte) in payload.iter_mut().enumerate() {
            *byte ^= mask[index % 4];
        }
    }
    Ok((opcode, payload))
}

fn ws_connect(daemon: &RunningDaemon) -> Result<TcpStream, Box<dyn Error>> {
    let mut stream = TcpStream::connect_timeout(&daemon.addr, Duration::from_secs(5))?;
    stream.set_read_timeout(Some(Duration::from_secs(20)))?;
    stream.set_nodelay(true)?;
    let request = format!(
        "GET /rpc HTTP/1.1\r\nHost: {}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n",
        daemon.addr
    );
    stream.write_all(request.as_bytes())?;
    let mut head = Vec::new();
    let mut byte = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        stream.read_exact(&mut byte)?;
        head.push(byte[0]);
        if head.len() > 16 * 1024 {
            return Err("WebSocket 握手响应过大".into());
        }
    }
    let head_text = std::str::from_utf8(&head)?;
    if !head_text.starts_with("HTTP/1.1 101") {
        return Err(format!("WebSocket 握手失败: {head_text}").into());
    }
    if !head_text
        .to_ascii_lowercase()
        .contains("sec-websocket-accept: s3pplmbitxaq9kygzzhzrbk+xoo=")
    {
        return Err(format!("WebSocket accept 校验失败: {head_text}").into());
    }
    Ok(stream)
}

fn read_json_frame(stream: &mut TcpStream) -> Result<serde_json::Value, Box<dyn Error>> {
    let (opcode, payload) = ws_read_frame(stream)?;
    if opcode != 0x1 {
        return Err(format!("期望文本帧，收到 opcode={opcode}").into());
    }
    Ok(serde_json::from_slice(&payload)?)
}

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
fn websocket_rpc_authenticates_streams_snapshot_and_forwards_requests() -> TestResult {
    let home = TempDirGuard::new("qz_web_ws_home")?;
    let web = TempDirGuard::new("qz_web_ws_dist")?;
    seed_web_dir(web.path())?;
    let daemon = RunningDaemon::start(Some(web.path().to_path_buf()), home.path())?;
    let token = auth_token(&daemon)?;

    // 1. 错误令牌必须关闭连接（不回显任何状态）。
    let mut rejected = ws_connect(&daemon)?;
    ws_send_text(&mut rejected, r#"{"auth":"wrong"}"#)?;
    let (opcode, payload) = ws_read_frame(&mut rejected)?;
    assert_eq!(opcode, 0x8, "错误令牌必须收到 close 帧");
    assert!(
        payload.len() >= 2,
        "close 帧必须包含状态码（expected 4401）"
    );

    // 2. 正确令牌：ready → snapshot → 请求/响应。
    let mut stream = ws_connect(&daemon)?;
    ws_send_text(&mut stream, &format!(r#"{{"auth":"{token}"}}"#))?;
    let ready = read_json_frame(&mut stream)?;
    assert_eq!(ready["type"], "ready");
    assert_eq!(ready["transport"], "websocket");

    let snapshot = read_json_frame(&mut stream)?;
    assert_eq!(snapshot["type"], "snapshot");
    assert_eq!(snapshot["state"]["density"], "workbench");
    let rows = snapshot["state"]["rows"]
        .as_object()
        .ok_or("snapshot 必须包含 rows 对象")?;
    assert!(
        rows.contains_key("status/daemon"),
        "快照必须包含本机守护进程状态行"
    );
    let status_row = &rows["status/daemon"];
    assert!(
        status_row["raw_json"]
            .as_str()
            .is_some_and(|raw| raw.contains("agent_id")),
        "Inspector 原始层必须包含 agent_id"
    );
    assert!(
        status_row["summary"]
            .as_str()
            .is_some_and(|s| s.contains("在线"))
    );

    ws_send_text(&mut stream, r#"{"id":7,"request":{"method":"status"}}"#)?;
    let response = read_json_frame(&mut stream)?;
    assert_eq!(response["type"], "response");
    assert_eq!(response["id"], 7);
    assert_eq!(response["response"]["kind"], "status");

    // 3. 未知方法返回显式错误而不是断链。
    ws_send_text(
        &mut stream,
        r#"{"id":8,"request":{"method":"not_a_real_method"}}"#,
    )?;
    let mut saw_error = false;
    for _ in 0..3 {
        let frame = read_json_frame(&mut stream)?;
        if frame["type"] == "response" {
            assert_eq!(frame["id"], 8);
            assert_eq!(frame["response"]["kind"], "error");
            saw_error = true;
            break;
        }
    }
    assert!(saw_error, "未知方法必须返回 typed error 响应");

    // 4. ping 保活。
    ws_send_text(&mut stream, r#"{"type":"ping"}"#)?;
    let pong = read_json_frame(&mut stream)?;
    assert_eq!(pong["type"], "pong");
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
