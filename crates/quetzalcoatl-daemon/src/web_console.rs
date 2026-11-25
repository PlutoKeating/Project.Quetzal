#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]

//! 同源 Web 控制台托管：静态资源 + `/auth/local` 同机浏览器认证 + `/health`
//! + WebSocket `/rpc`（先认证后 RPC）与 HTTP `/rpc` 兜底。
//!
//! 安全边界：
//! 1. 复用 [`crate::local_ipc::validate_loopback_host_and_origin`] 的严格回环 `Host` 校验；
//! 2. `/auth/local` 额外要求 `Origin`（若存在）与 `Host` **逐字符同源**，防同机其他端口的
//!    恶意页面蹭取令牌；
//! 3. `/auth/local` 签发的是一次性随机会话令牌（256-bit），**绝不**回传管理员主令牌；
//!    会话在 12 小时后过期，最多保留 256 个；
//! 4. 静态资源拒绝 `%` 编码与 `..` 段，防止路径穿越；统一附加严格 CSP 与 `nosniff`。

use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine;
use rand_core::{OsRng, RngCore};
use serde::Deserialize;

use crate::local_ipc::{
    IpcHandler, IpcRequest, IpcResponse, ParsedIpcHttp, constant_time_eq_32, decode_hex_32_constant,
};

/// Web 会话有效期：12 小时。
const WEB_SESSION_TTL_MS: u64 = 12 * 60 * 60 * 1000;
const MAX_WEB_SESSIONS: usize = 256;
const MAX_STATIC_BYTES: usize = 8 * 1024 * 1024;
const WS_GUID: &str = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

// `'wasm-unsafe-eval'` 只放行 WebAssembly 编译（OPFS 单写者缓存宿主），
// 不等于 JS eval；`object-src`/`base-uri`/`frame-ancestors` 仍全部锁死。
const CSP: &str = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; \
style-src 'self'; img-src 'self' data:; connect-src 'self'; worker-src 'self'; \
object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

fn now_unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}

fn hex_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(char::from(b"0123456789abcdef"[usize::from(byte >> 4)]));
        out.push(char::from(b"0123456789abcdef"[usize::from(byte & 0x0f)]));
    }
    out
}

/// 同源网页会话令牌表（绝不持久化，令牌只在内存中存活）。
#[derive(Default)]
struct WebSessionStore {
    entries: Mutex<Vec<([u8; 32], u64)>>,
}

impl WebSessionStore {
    fn mint(&self) -> String {
        let mut raw = [0u8; 32];
        OsRng.fill_bytes(&mut raw);
        let now = now_unix_ms();
        let expiry = now.saturating_add(WEB_SESSION_TTL_MS);
        let Ok(mut guard) = self.entries.lock() else {
            // 锁中毒时仍签发令牌但无法登记：fail-closed，返回空令牌由调用方拒绝。
            return String::new();
        };
        guard.retain(|(_, exp)| *exp > now);
        if guard.len() >= MAX_WEB_SESSIONS {
            guard.remove(0);
        }
        guard.push((raw, expiry));
        hex_encode(&raw)
    }

    fn validate(&self, candidate: &str) -> bool {
        let (decoded, syntax_ok) = decode_hex_32_constant(candidate);
        if !syntax_ok {
            return false;
        }
        let now = now_unix_ms();
        let Ok(mut guard) = self.entries.lock() else {
            return false;
        };
        guard.retain(|(_, exp)| *exp > now);
        let mut matched = false;
        for (secret, _) in guard.iter() {
            if constant_time_eq_32(&decoded, secret) {
                matched = true;
            }
        }
        matched
    }
}

/// 一次 HTTP 响应（静态资源或 JSON）。
struct WebReply {
    status: u16,
    content_type: &'static str,
    body: Vec<u8>,
}

impl WebReply {
    fn json(status: u16, value: &serde_json::Value) -> Self {
        Self {
            status,
            content_type: "application/json; charset=utf-8",
            body: serde_json::to_vec(value).unwrap_or_else(|_| b"{\"error\":\"encode\"}".to_vec()),
        }
    }

    fn error(status: u16, code: &str) -> Self {
        Self::json(
            status,
            &serde_json::json!({ "error": code, "status": status }),
        )
    }
}

fn reason_phrase(status: u16) -> &'static str {
    match status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        413 => "Payload Too Large",
        500 => "Internal Server Error",
        _ => "Response",
    }
}

/// 同源 Web 控制台（跨连接共享会话表）。
pub(crate) struct WebConsole {
    dir: Option<PathBuf>,
    sessions: WebSessionStore,
}

impl WebConsole {
    pub(crate) fn new(dir: Option<PathBuf>) -> Self {
        let resolved = dir.filter(|path| path.is_dir());
        Self {
            dir: resolved,
            sessions: WebSessionStore::default(),
        }
    }

    #[cfg(test)]
    fn sessions_for_test(&self) -> &WebSessionStore {
        &self.sessions
    }

    /// 处理所有非 `/v1/*` 请求；WebSocket 连接会在此阻塞到对端关闭。
    pub(crate) fn handle<S: Read + Write, H: IpcHandler + ?Sized>(
        &self,
        stream: &mut S,
        request: &ParsedIpcHttp,
        handler: &H,
    ) {
        let path = request.target.split('?').next().unwrap_or("/");
        let method = request.method.as_str();
        let upgrade = request
            .header("upgrade")
            .is_some_and(|value| value.eq_ignore_ascii_case("websocket"));

        if path == "/rpc" && upgrade {
            self.serve_websocket(stream, request, handler);
            return;
        }

        let reply = match (method, path) {
            ("GET" | "HEAD", "/health") => WebReply::json(
                200,
                &serde_json::json!({
                    "status": "ok",
                    "version": env!("CARGO_PKG_VERSION"),
                    "web": self.dir.is_some(),
                }),
            ),
            ("GET" | "HEAD", "/auth/local") => self.auth_local(request),
            ("GET", "/rpc/snapshot") => self.snapshot_reply(request, handler),
            ("POST", "/rpc") => self.http_rpc(request, handler),
            ("GET" | "HEAD", _) => self.static_reply(path),
            _ => WebReply::error(405, "method_not_allowed"),
        };
        write_http_reply(stream, &reply);
    }

    fn auth_local(&self, request: &ParsedIpcHttp) -> WebReply {
        // 同源判定：若浏览器携带 Origin，其 authority 必须与 Host 完全一致。
        if let Some(origin) = request.header("origin") {
            let Some(host) = request.header("host") else {
                return WebReply::error(403, "missing_host");
            };
            let authority = origin
                .trim()
                .strip_prefix("http://")
                .or_else(|| origin.trim().strip_prefix("https://"))
                .unwrap_or("")
                .trim_end_matches('/');
            if authority.is_empty() || !authority.eq_ignore_ascii_case(host.trim()) {
                return WebReply::error(403, "cross_origin_denied");
            }
        }
        if self.dir.is_none() {
            return WebReply::error(404, "web_console_disabled");
        }
        let token = self.sessions.mint();
        if token.is_empty() {
            return WebReply::error(500, "session_store_unavailable");
        }
        WebReply::json(
            200,
            &serde_json::json!({
                "token": token,
                "expires_in_secs": WEB_SESSION_TTL_MS / 1000,
                "daemon_version": env!("CARGO_PKG_VERSION"),
            }),
        )
    }

    fn bearer_token(request: &ParsedIpcHttp) -> Option<&str> {
        request
            .header("authorization")
            .and_then(|value| {
                value
                    .strip_prefix("Bearer ")
                    .or_else(|| value.strip_prefix("bearer "))
            })
            .map(str::trim)
    }

    fn authorized(&self, request: &ParsedIpcHttp) -> bool {
        Self::bearer_token(request).is_some_and(|token| self.sessions.validate(token))
    }

    fn snapshot_reply<H: IpcHandler + ?Sized>(
        &self,
        request: &ParsedIpcHttp,
        handler: &H,
    ) -> WebReply {
        if !self.authorized(request) {
            return WebReply::error(401, "unauthorized");
        }
        let (response, _) = handler.handle(IpcRequest::Status);
        WebReply::json(200, &snapshot_from_status(&response))
    }

    fn http_rpc<H: IpcHandler + ?Sized>(&self, request: &ParsedIpcHttp, handler: &H) -> WebReply {
        if !self.authorized(request) {
            return WebReply::error(401, "unauthorized");
        }
        let parsed: IpcRequest = match serde_json::from_slice(&request.body) {
            Ok(value) => value,
            Err(error) => {
                return WebReply::json(
                    400,
                    &serde_json::json!({
                        "kind": "error",
                        "data": {"code": "SERIALIZATION_ERROR", "detail": error.to_string()},
                    }),
                );
            }
        };
        let (response, _) = handler.handle(parsed);
        WebReply::json(200, &serde_json::to_value(&response).unwrap_or_default())
    }

    fn static_reply(&self, path: &str) -> WebReply {
        let Some(dir) = &self.dir else {
            return WebReply::error(404, "web_console_disabled");
        };
        let Some(relative) = sanitize_static_path(path) else {
            return WebReply::error(403, "path_denied");
        };
        let candidate = dir.join(&relative);
        let mut file = candidate.clone();
        let mut exists = file.is_file();
        if !exists && relative.extension().is_none() {
            // SPA 深链回退（仅无扩展名路径）。
            file = dir.join("index.html");
            exists = file.is_file();
        }
        if !exists {
            return WebReply::error(404, "not_found");
        }
        let Ok(metadata) = fs::metadata(&file) else {
            return WebReply::error(404, "not_found");
        };
        if metadata.len() > u64::try_from(MAX_STATIC_BYTES).unwrap_or(u64::MAX) {
            return WebReply::error(413, "asset_too_large");
        }
        let Ok(body) = fs::read(&file) else {
            return WebReply::error(404, "not_found");
        };
        WebReply {
            status: 200,
            content_type: content_type_for(&file),
            body,
        }
    }

    fn serve_websocket<S: Read + Write, H: IpcHandler + ?Sized>(
        &self,
        stream: &mut S,
        request: &ParsedIpcHttp,
        handler: &H,
    ) {
        let Some(key) = request.header("sec-websocket-key").map(str::trim) else {
            write_http_reply(stream, &WebReply::error(400, "missing_websocket_key"));
            return;
        };
        let version_ok = request
            .header("sec-websocket-version")
            .is_some_and(|value| value.trim() == "13");
        if !version_ok {
            write_http_reply(
                stream,
                &WebReply::error(400, "unsupported_websocket_version"),
            );
            return;
        }
        let accept = base64::engine::general_purpose::STANDARD
            .encode(sha1(format!("{key}{WS_GUID}").as_bytes()));
        let head = format!(
            "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n\r\n"
        );
        if stream.write_all(head.as_bytes()).is_err() || stream.flush().is_err() {
            return;
        }

        // 1. 首帧必须是认证信封。
        let Some(payload) = ws_read_text(stream) else {
            return;
        };
        let auth: WsAuth = match serde_json::from_slice(&payload) {
            Ok(value) => value,
            Err(_) => {
                ws_write_close(stream, 4400, "malformed-auth");
                return;
            }
        };
        if !self.sessions.validate(&auth.auth) {
            ws_write_close(stream, 4401, "unauthorized");
            return;
        }
        if ws_write_json(
            stream,
            &serde_json::json!({"type": "ready", "transport": "websocket"}),
        )
        .is_err()
        {
            return;
        }
        let (status_response, _) = handler.handle(IpcRequest::Status);
        if ws_write_json(
            stream,
            &serde_json::json!({"type": "snapshot", "state": snapshot_from_status(&status_response)}),
        )
        .is_err()
        {
            return;
        }

        // 2. 请求/响应循环：ping 保活、resync 重发快照、未知方法返回 typed error。
        let mut patch_rev = 1u64;
        while let Some(payload) = ws_read_text(stream) {
            let envelope: serde_json::Value = match serde_json::from_slice(&payload) {
                Ok(value) => value,
                Err(error) => {
                    if ws_write_json(
                        stream,
                        &serde_json::json!({"type": "error", "detail": error.to_string()}),
                    )
                    .is_err()
                    {
                        return;
                    }
                    continue;
                }
            };
            match envelope.get("type").and_then(serde_json::Value::as_str) {
                Some("ping") => {
                    if ws_write_json(stream, &serde_json::json!({"type": "pong"})).is_err() {
                        return;
                    }
                    continue;
                }
                Some("resync") => {
                    let (status_response, _) = handler.handle(IpcRequest::Status);
                    patch_rev = 1;
                    if ws_write_json(
                        stream,
                        &serde_json::json!({"type": "snapshot", "state": snapshot_from_status(&status_response)}),
                    )
                    .is_err()
                    {
                        return;
                    }
                    continue;
                }
                _ => {}
            }
            let id = envelope
                .get("id")
                .and_then(serde_json::Value::as_u64)
                .unwrap_or(0);
            let Some(request_value) = envelope.get("request") else {
                if ws_write_json(
                    stream,
                    &serde_json::json!({"type": "error", "detail": "missing-request"}),
                )
                .is_err()
                {
                    return;
                }
                continue;
            };
            let request: IpcRequest = match serde_json::from_value(request_value.clone()) {
                Ok(value) => value,
                Err(error) => {
                    if ws_write_json(
                        stream,
                        &serde_json::json!({
                            "type": "response",
                            "id": id,
                            "response": {
                                "kind": "error",
                                "data": {"code": "SERIALIZATION_ERROR", "detail": error.to_string()},
                            },
                        }),
                    )
                    .is_err()
                    {
                        return;
                    }
                    continue;
                }
            };
            let (response, should_shutdown) = handler.handle(request);
            if let IpcResponse::Chat(chat) = &response {
                let run_id = format!("{}", chat.run_id);
                if ws_write_json(
                    stream,
                    &serde_json::json!({
                        "type": "token",
                        "messageId": run_id,
                        "seq": 0,
                        "text": chat.reply,
                    }),
                )
                .is_err()
                {
                    return;
                }
                let from_rev = patch_rev;
                patch_rev = patch_rev.saturating_add(1);
                let patch = serde_json::json!({
                    "type": "patch",
                    "patch": {
                        "from_rev": from_rev,
                        "to_rev": patch_rev,
                        "density": "workbench",
                        "ops": [{"op": "upsert", "row": {
                            "key": format!("chat/{run_id}"),
                            "kind": "assistant",
                            "summary": chat.reply,
                            "detail": format!(
                                "worker={} verifier_runs={}",
                                chat.delegated_to_worker, chat.verifier_runs
                            ),
                            "raw_json": serde_json::to_string(chat).unwrap_or_default(),
                            "updated_rev": patch_rev,
                        }}],
                    },
                });
                if ws_write_json(stream, &patch).is_err() {
                    return;
                }
            }
            let Ok(response_value) = serde_json::to_value(&response) else {
                return;
            };
            if ws_write_json(
                stream,
                &serde_json::json!({"type": "response", "id": id, "response": response_value}),
            )
            .is_err()
            {
                return;
            }
            if should_shutdown {
                return;
            }
        }
    }
}

#[derive(Deserialize)]
struct WsAuth {
    auth: String,
}

impl ParsedIpcHttp {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }
}

/// 把守护进程状态折叠为三档共用的响应式快照（rev=1 基线）。
fn snapshot_from_status(response: &IpcResponse) -> serde_json::Value {
    let mut rows = serde_json::Map::new();
    if let IpcResponse::Status(status) = response {
        let raw = serde_json::to_string(status).unwrap_or_default();
        rows.insert(
            String::from("status/daemon"),
            serde_json::json!({
                "key": "status/daemon",
                "kind": "status",
                "summary": "羽蛇神已就绪 · 本机守护进程在线",
                "detail": format!(
                    "设备 {} · 脊柱事件 {} · 群房间 {} · 睡眠相位 {:?}",
                    status.device_id, status.spine_events_count, status.group_rooms, status.sleep_phase
                ),
                "raw_json": raw,
                "updated_rev": 1,
            }),
        );
        for (index, agent) in status.discovered_agents.iter().enumerate() {
            let key = format!("agent/{index}");
            rows.insert(
                key.clone(),
                serde_json::json!({
                    "key": key,
                    "kind": "agent",
                    "summary": format!("已发现编码代理 · {:?}", agent.kind),
                    "detail": agent.binary_path.display().to_string(),
                    "raw_json": serde_json::to_string(agent).unwrap_or_default(),
                    "updated_rev": 1,
                }),
            );
        }
    }
    serde_json::json!({
        "rev": 1,
        "density": "workbench",
        "rows": rows,
    })
}

fn sanitize_static_path(path: &str) -> Option<PathBuf> {
    if path.contains('%') || path.contains('\\') || path.contains('\0') || path.len() > 2048 {
        return None;
    }
    let mut relative = PathBuf::new();
    for segment in path.split('/') {
        if segment.is_empty() || segment == "." {
            continue;
        }
        if segment == ".." {
            return None;
        }
        relative.push(segment);
    }
    if relative.as_os_str().is_empty() {
        relative.push("index.html");
    }
    Some(relative)
}

fn content_type_for(path: &Path) -> &'static str {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match extension.as_str() {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "map" => "application/json; charset=utf-8",
        "wasm" => "application/wasm",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "ico" => "image/x-icon",
        "txt" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

fn write_http_reply<W: Write>(stream: &mut W, reply: &WebReply) {
    let head = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: {}\r\nContent-Length: {}\r\nContent-Security-Policy: {}\r\nX-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
        reply.status,
        reason_phrase(reply.status),
        reply.content_type,
        reply.body.len(),
        CSP,
    );
    let _ = stream.write_all(head.as_bytes());
    let _ = stream.write_all(&reply.body);
    let _ = stream.flush();
}

/// 读取一个客户端文本帧；控制帧在内部应答（ping→pong，close→`None`）。
fn ws_read_text<S: Read + Write>(stream: &mut S) -> Option<Vec<u8>> {
    loop {
        let mut header = [0u8; 2];
        if stream.read_exact(&mut header).is_err() {
            return None;
        }
        let opcode = header[0] & 0x0f;
        let masked = header[1] & 0x80 != 0;
        let mut length = u64::from(header[1] & 0x7f);
        if length == 126 {
            let mut extended = [0u8; 2];
            if stream.read_exact(&mut extended).is_err() {
                return None;
            }
            length = u64::from(u16::from_be_bytes(extended));
        } else if length == 127 {
            let mut extended = [0u8; 8];
            if stream.read_exact(&mut extended).is_err() {
                return None;
            }
            length = u64::from_be_bytes(extended);
        }
        if length > 4 * 1024 * 1024 {
            ws_write_close(stream, 1009, "frame-too-large");
            return None;
        }
        let mut mask = [0u8; 4];
        if masked && stream.read_exact(&mut mask).is_err() {
            return None;
        }
        let mut payload = vec![0u8; usize::try_from(length).ok()?];
        if stream.read_exact(&mut payload).is_err() {
            return None;
        }
        if masked {
            for (index, byte) in payload.iter_mut().enumerate() {
                *byte ^= mask[index % 4];
            }
        }
        match opcode {
            0x8 => {
                ws_write_close(stream, 1000, "bye");
                return None;
            }
            0x9 => {
                if ws_write_frame(stream, 0xa, &payload).is_err() {
                    return None;
                }
            }
            0x1 | 0x2 => return Some(payload),
            _ => {}
        }
    }
}

fn ws_write_json<W: Write>(stream: &mut W, value: &serde_json::Value) -> std::io::Result<()> {
    let text = serde_json::to_vec(value).unwrap_or_else(|_| b"{}".to_vec());
    ws_write_frame(stream, 0x1, &text)
}

fn ws_write_close<W: Write>(stream: &mut W, code: u16, reason: &str) {
    let mut payload = Vec::with_capacity(2 + reason.len());
    payload.extend_from_slice(&code.to_be_bytes());
    payload.extend_from_slice(reason.as_bytes());
    let _ = ws_write_frame(stream, 0x8, &payload);
}

fn ws_write_frame<W: Write>(stream: &mut W, opcode: u8, payload: &[u8]) -> std::io::Result<()> {
    let mut frame = Vec::with_capacity(payload.len() + 10);
    frame.push(0x80 | opcode);
    if payload.len() < 126 {
        frame.push(u8::try_from(payload.len()).unwrap_or(125));
    } else if payload.len() <= usize::from(u16::MAX) {
        frame.push(126);
        frame.extend_from_slice(
            &u16::try_from(payload.len())
                .unwrap_or(u16::MAX)
                .to_be_bytes(),
        );
    } else {
        frame.push(127);
        frame.extend_from_slice(
            &u64::try_from(payload.len())
                .unwrap_or(u64::MAX)
                .to_be_bytes(),
        );
    }
    frame.extend_from_slice(payload);
    stream.write_all(&frame)?;
    stream.flush()
}

/// 最小 SHA-1 实现（仅用于 RFC 6455 握手 Accept；不承担任何密码学安全职责）。
fn sha1(data: &[u8]) -> [u8; 20] {
    let mut h: [u32; 5] = [
        0x6745_2301,
        0xEFCD_AB89,
        0x98BA_DCFE,
        0x1032_5476,
        0xC3D2_E1F0,
    ];
    let bit_len = u64::try_from(data.len()).unwrap_or(0).wrapping_mul(8);
    let mut message = data.to_vec();
    message.push(0x80);
    while message.len() % 64 != 56 {
        message.push(0);
    }
    message.extend_from_slice(&bit_len.to_be_bytes());

    for chunk in message.as_chunks::<64>().0 {
        let mut w = [0u32; 80];
        for (index, word) in chunk.as_chunks::<4>().0.iter().enumerate().take(16) {
            w[index] = u32::from_be_bytes(*word);
        }
        for index in 16..80 {
            w[index] = (w[index - 3] ^ w[index - 8] ^ w[index - 14] ^ w[index - 16]).rotate_left(1);
        }
        let mut a = h[0];
        let mut b = h[1];
        let mut c = h[2];
        let mut d = h[3];
        let mut e = h[4];
        for (index, word) in w.iter().enumerate() {
            let (f, k) = match index {
                0..=19 => ((b & c) | ((!b) & d), 0x5A82_7999u32),
                20..=39 => (b ^ c ^ d, 0x6ED9_EBA1),
                40..=59 => ((b & c) | (b & d) | (c & d), 0x8F1B_BCDC),
                _ => (b ^ c ^ d, 0xCA62_C1D6),
            };
            let temp = a
                .rotate_left(5)
                .wrapping_add(f)
                .wrapping_add(e)
                .wrapping_add(k)
                .wrapping_add(*word);
            e = d;
            d = c;
            c = b.rotate_left(30);
            b = a;
            a = temp;
        }
        h[0] = h[0].wrapping_add(a);
        h[1] = h[1].wrapping_add(b);
        h[2] = h[2].wrapping_add(c);
        h[3] = h[3].wrapping_add(d);
        h[4] = h[4].wrapping_add(e);
    }

    let mut digest = [0u8; 20];
    for (index, word) in h.iter().enumerate() {
        digest[index * 4..index * 4 + 4].copy_from_slice(&word.to_be_bytes());
    }
    digest
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha1_matches_rfc3174_vectors() {
        assert_eq!(
            hex_encode(&sha1(b"abc")),
            "a9993e364706816aba3e25717850c26c9cd0d89d"
        );
        assert_eq!(
            hex_encode(&sha1(b"")),
            "da39a3ee5e6b4b0d3255bfef95601890afd80709"
        );
        assert_eq!(
            hex_encode(&sha1(
                b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"
            )),
            "84983e441c3bd26ebaae4aa1f95129e5e54670f1"
        );
    }

    #[test]
    fn websocket_accept_matches_rfc6455_sample() {
        let accept = base64::engine::general_purpose::STANDARD.encode(sha1(
            format!("dGhlIHNhbXBsZSBub25jZQ=={WS_GUID}").as_bytes(),
        ));
        assert_eq!(accept, "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
    }

    #[test]
    fn static_path_sanitizer_rejects_traversal_and_encoding() {
        assert!(sanitize_static_path("/../Cargo.toml").is_none());
        assert!(sanitize_static_path("/%2e%2e/secret").is_none());
        assert!(sanitize_static_path("/a/../../b").is_none());
        assert_eq!(
            sanitize_static_path("/").and_then(|p| p.to_str().map(str::to_owned)),
            Some(String::from("index.html"))
        );
        assert_eq!(
            sanitize_static_path("/assets/app.js").and_then(|p| p.to_str().map(str::to_owned)),
            Some(String::from("assets/app.js"))
        );
    }

    #[test]
    fn web_sessions_mint_unique_tokens_and_validate() {
        let store = WebSessionStore::default();
        let first = store.mint();
        let second = store.mint();
        assert_eq!(first.len(), 64);
        assert_ne!(first, second);
        assert!(store.validate(&first));
        assert!(store.validate(&second));
        assert!(!store.validate("deadbeef"));
        assert!(!store.validate(""));
        assert!(!store.validate(&"zz".repeat(32)));
    }

    #[test]
    fn web_session_validation_accepts_uppercase_hex() {
        let store = WebSessionStore::default();
        let token = store.mint();
        assert!(store.validate(&token.to_ascii_uppercase()));
    }

    #[test]
    fn web_console_without_dir_serves_no_static() {
        let console = WebConsole::new(None);
        assert_eq!(console.static_reply("/").status, 404);
        assert_eq!(console.sessions_for_test().mint().len(), 64);
    }
}
