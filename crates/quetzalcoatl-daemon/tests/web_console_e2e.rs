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

fn ws_send_raw_frame(
    stream: &mut TcpStream,
    fin: bool,
    opcode: u8,
    masked: bool,
    payload: &[u8],
) -> Result<(), Box<dyn Error>> {
    let mut frame = vec![(if fin { 0x80 } else { 0x00 }) | opcode];
    let mask_bit = if masked { 0x80 } else { 0x00 };
    if payload.len() < 126 {
        frame.push(mask_bit | u8::try_from(payload.len())?);
    } else {
        frame.push(mask_bit | 126);
        frame.extend_from_slice(&u16::try_from(payload.len())?.to_be_bytes());
    }
    let mask = [0x5au8, 0xa5, 0x0f, 0xf0];
    if masked {
        frame.extend_from_slice(&mask);
    }
    for (index, byte) in payload.iter().enumerate() {
        frame.push(if masked {
            byte ^ mask[index % 4]
        } else {
            *byte
        });
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

fn ws_handshake(daemon: &RunningDaemon) -> Result<(TcpStream, String), Box<dyn Error>> {
    let mut stream = TcpStream::connect_timeout(&daemon.addr, Duration::from_secs(5))?;
    stream.set_read_timeout(Some(Duration::from_secs(20)))?;
    stream.set_nodelay(true)?;
    let request = format!(
        "GET /rpc HTTP/1.1\r\nHost: {}\r\nOrigin: http://{}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n",
        daemon.addr, daemon.addr
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
    let head_text = std::str::from_utf8(&head)?.to_owned();
    Ok((stream, head_text))
}

fn ws_connect(daemon: &RunningDaemon) -> Result<TcpStream, Box<dyn Error>> {
    let (stream, head_text) = ws_handshake(daemon)?;
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

    // WebSocket upgrade 同样必须被 404 门禁（绝不先于 web 根判定升级）。
    let (upgrade_stream, upgrade_head) = ws_handshake(&daemon)?;
    assert!(
        upgrade_head.starts_with("HTTP/1.1 404"),
        "未配置 web 根时 /rpc upgrade 必须 404，实际: {}",
        upgrade_head.lines().next().unwrap_or("")
    );
    drop(upgrade_stream);

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

    // WS 同样拒绝特权方法，但保持连接并返回 typed error 响应。
    let mut stream = ws_connect(&daemon)?;
    ws_send_text(&mut stream, &format!(r#"{{"auth":"{token}"}}"#))?;
    let _ready = read_json_frame(&mut stream)?;
    let _snapshot = read_json_frame(&mut stream)?;
    ws_send_text(
        &mut stream,
        r#"{"id":42,"request":{"method":"export","params":{}}}"#,
    )?;
    let response = read_json_frame(&mut stream)?;
    assert_eq!(response["type"], "response");
    assert_eq!(response["id"], 42);
    assert_eq!(response["response"]["kind"], "error");
    assert_eq!(response["response"]["data"]["code"], "PERMISSION_DENIED");
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
fn websocket_close_code_protocol_and_fragmentation() -> TestResult {
    let home = TempDirGuard::new("qz_web_ws2_home")?;
    let web = TempDirGuard::new("qz_web_ws2_dist")?;
    seed_web_dir(web.path())?;
    let daemon = RunningDaemon::start(Some(web.path().to_path_buf()), home.path())?;
    let token = auth_token(&daemon)?;

    // 1. 错误令牌 → 文档化 close code 4401。
    let mut rejected = ws_connect(&daemon)?;
    ws_send_text(&mut rejected, r#"{"auth":"wrong"}"#)?;
    let (opcode, payload) = ws_read_frame(&mut rejected)?;
    assert_eq!(opcode, 0x8);
    assert!(payload.len() >= 2);
    let code = u16::from_be_bytes([payload[0], payload[1]]);
    assert_eq!(code, 4401, "未认证必须返回 4401");

    // 2. 未掩码客户端帧 → 1002 协议错误。
    let mut unmasked = ws_connect(&daemon)?;
    ws_send_raw_frame(&mut unmasked, true, 0x1, false, br#"{"auth":"x"}"#)?;
    let (opcode, payload) = ws_read_frame(&mut unmasked)?;
    assert_eq!(opcode, 0x8);
    assert_eq!(u16::from_be_bytes([payload[0], payload[1]]), 1002);

    // 3. 分片认证帧（FIN=0 + continuation FIN=1）必须被正确重组。
    let mut fragmented = ws_connect(&daemon)?;
    let auth_frame = format!(r#"{{"auth":"{token}"}}"#);
    let (left, right) = auth_frame.split_at(auth_frame.len() / 2);
    ws_send_raw_frame(&mut fragmented, false, 0x1, true, left.as_bytes())?;
    ws_send_raw_frame(&mut fragmented, true, 0x0, true, right.as_bytes())?;
    let ready = read_json_frame(&mut fragmented)?;
    assert_eq!(ready["type"], "ready");
    let snapshot = read_json_frame(&mut fragmented)?;
    assert_eq!(snapshot["type"], "snapshot");
    Ok(())
}

#[test]
fn session_tokens_are_single_connection_and_socket_cap_is_enforced() -> TestResult {
    let home = TempDirGuard::new("qz_web_cap_home")?;
    let web = TempDirGuard::new("qz_web_cap_dist")?;
    seed_web_dir(web.path())?;
    let daemon = RunningDaemon::start(Some(web.path().to_path_buf()), home.path())?;

    let token = auth_token(&daemon)?;
    let mut first = ws_connect(&daemon)?;
    ws_send_text(&mut first, &format!(r#"{{"auth":"{token}"}}"#))?;
    let _ready = read_json_frame(&mut first)?;
    let _snapshot = read_json_frame(&mut first)?;

    // 同一令牌第二条连接 → 4409 SESSION_IN_USE。
    let mut second = ws_connect(&daemon)?;
    ws_send_text(&mut second, &format!(r#"{{"auth":"{token}"}}"#))?;
    let (opcode, payload) = ws_read_frame(&mut second)?;
    assert_eq!(opcode, 0x8);
    assert_eq!(u16::from_be_bytes([payload[0], payload[1]]), 4409);

    // 关闭第一条连接后令牌即销毁（不可复活）→ 4401。
    ws_send_raw_frame(&mut first, true, 0x8, true, &[0x03, 0xe8])?;
    std::thread::sleep(Duration::from_millis(120));
    let mut third = ws_connect(&daemon)?;
    ws_send_text(&mut third, &format!(r#"{{"auth":"{token}"}}"#))?;
    let (opcode, payload) = ws_read_frame(&mut third)?;
    assert_eq!(opcode, 0x8);
    assert_eq!(u16::from_be_bytes([payload[0], payload[1]]), 4401);

    // 并发上限：32 条已认证连接后，第 33 条握手必须收到 503。
    let mut held = Vec::new();
    for index in 0..32 {
        let token = auth_token(&daemon)?;
        let mut stream = ws_connect(&daemon)?;
        ws_send_text(&mut stream, &format!(r#"{{"auth":"{token}"}}"#))?;
        let ready = read_json_frame(&mut stream)?;
        assert_eq!(ready["type"], "ready", "第 {index} 条连接认证失败");
        let _snapshot = read_json_frame(&mut stream)?;
        held.push(stream);
    }
    let (overflow_stream, head) = ws_handshake(&daemon)?;
    assert!(
        head.starts_with("HTTP/1.1 503"),
        "第 33 条连接必须被 503 拒绝，实际: {}",
        head.lines().next().unwrap_or("")
    );
    drop(overflow_stream);
    drop(held);
    Ok(())
}

#[test]
fn snapshot_exposes_real_conscience_tree_and_artifacts_without_sensitive_bodies() -> TestResult {
    let home = TempDirGuard::new("qz_web_rows_home")?;
    let web = TempDirGuard::new("qz_web_rows_dist")?;
    seed_web_dir(web.path())?;
    let daemon = RunningDaemon::start(Some(web.path().to_path_buf()), home.path())?;
    let token = auth_token(&daemon)?;
    let response = http_request(
        daemon.addr,
        "GET",
        "/rpc/snapshot",
        &[("Authorization", &format!("Bearer {token}"))],
        b"",
    )?;
    assert_eq!(response.status, 200);
    let snapshot = response.json()?;
    let rows = snapshot["rows"].as_object().ok_or("快照缺少 rows 对象")?;

    let conscience_keys: Vec<&String> = rows
        .keys()
        .filter(|key| key.starts_with("conscience/"))
        .collect();
    assert!(
        !conscience_keys.is_empty(),
        "真实守护进程必须披露良知树行，实际 keys={:?}",
        rows.keys().collect::<Vec<_>>()
    );
    let mut saw_root = false;
    for key in conscience_keys {
        let row = &rows[key];
        assert_eq!(row["kind"], "conscience");
        let raw = row["raw_json"].as_str().ok_or("良知行缺少 raw_json")?;
        let parsed: serde_json::Value = serde_json::from_str(raw)?;
        let object = parsed.as_object().ok_or("良知 raw_json 必须是对象")?;
        for field in object.keys() {
            assert!(
                matches!(
                    field.as_str(),
                    "tier" | "level" | "id" | "authority" | "flags"
                ),
                "良知 raw_json 泄露非结构字段: {field}"
            );
        }
        if row["detail"]
            .as_str()
            .is_some_and(|d| d.contains("ROOT 100"))
        {
            saw_root = true;
        }
    }
    assert!(saw_root, "必须至少有一行 ROOT 100 良知条目");

    let artifact_keys: Vec<&String> = rows
        .keys()
        .filter(|key| key.starts_with("artifact/"))
        .collect();
    assert!(
        artifact_keys.iter().any(|key| key.contains("SOUL.md")),
        "真实脊柱 Markdown 产物必须出现在 artifact 行: {:?}",
        artifact_keys
    );
    let session = &rows["session/active"];
    assert_eq!(session["kind"], "session");
    assert!(
        session["raw_json"]
            .as_str()
            .is_some_and(|raw| raw.contains("personal")),
        "无群组时必须声明个人会话"
    );

    // 个人会话下提交产物 → 类型化拒绝，而不是伪造成功。
    let commit = http_request(
        daemon.addr,
        "POST",
        "/rpc",
        &[("Authorization", &format!("Bearer {token}"))],
        br#"{"method":"web_commit_artifact","params":{"artifact_key":"artifact/md/SOUL.md"}}"#,
    )?;
    assert_eq!(commit.status, 409, "个人会话提交必须是 409");
    let commit_json = commit.json()?;
    assert_eq!(commit_json["data"]["code"], "NO_GROUP_SESSION");
    Ok(())
}

#[test]
fn web_commit_artifact_uses_real_group_path_when_room_exists() -> TestResult {
    let home = TempDirGuard::new("qz_web_group_home")?;
    let web = TempDirGuard::new("qz_web_group_dist")?;
    seed_web_dir(web.path())?;
    let daemon = RunningDaemon::start(Some(web.path().to_path_buf()), home.path())?;

    // 管理面（/v1/rpc + 管理员主令牌）创建本地群房间；Web 面无权调用该方法。
    for room in ["zzz-web-room", "aaa-web-room"] {
        let body = format!(
            r#"{{"method":"group_create","params":{{"room_id":"{room}","secrecy_level":2}}}}"#
        );
        let created = http_request(
            daemon.addr,
            "POST",
            "/v1/rpc",
            &[("x-qz-ipc-token", daemon.handle.ipc_token())],
            body.as_bytes(),
        )?;
        assert_eq!(
            created.status, 200,
            "群房间 {room} 创建失败: {:?}",
            created.body
        );
        assert_eq!(created.json()?["kind"], "group_room");
    }

    let token = auth_token(&daemon)?;
    let snapshot = http_request(
        daemon.addr,
        "GET",
        "/rpc/snapshot",
        &[("Authorization", &format!("Bearer {token}"))],
        b"",
    )?;
    let snapshot = snapshot.json()?;
    let session = &snapshot["rows"]["session/active"];
    assert!(
        session["raw_json"]
            .as_str()
            .is_some_and(|raw| raw.contains("aaa-web-room")),
        "多群房间时必须确定性选择字典序最小的房间: {session}"
    );

    // 提交会走真实 GroupSend 路径（无 Hub 时得到网络类错误），而不再是 NO_GROUP_SESSION。
    let commit = http_request(
        daemon.addr,
        "POST",
        "/rpc",
        &[("Authorization", &format!("Bearer {token}"))],
        br#"{"method":"web_commit_artifact","params":{"artifact_key":"artifact/md/SOUL.md"}}"#,
    )?;
    let commit_json = commit.json()?;
    if commit.status == 200 {
        // 本地群引擎离线入队也走真实 GroupSend 结果；细节必须点名房间。
        assert_eq!(
            commit_json["kind"], "ack",
            "成功必须是 typed ack: {commit_json}"
        );
        assert!(
            commit_json["data"]["detail"]
                .as_str()
                .is_some_and(|detail| detail.contains("aaa-web-room")),
            "ack 必须点名真实群房间: {commit_json}"
        );
    } else {
        let code = commit_json["data"]["code"].as_str().unwrap_or_default();
        assert_ne!(
            code, "NO_GROUP_SESSION",
            "存在群房间时必须进入真实群提交路径，实际 code={code}"
        );
        assert!(
            commit_json["data"]["detail"]
                .as_str()
                .is_some_and(|detail| !detail.is_empty()),
            "失败必须带可解释 detail"
        );
    }
    Ok(())
}
