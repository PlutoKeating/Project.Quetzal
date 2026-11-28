#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]

//! 同源 Web 控制台托管：静态资源 + `/auth/local` 同机浏览器认证 + `/health`
//! + WebSocket `/rpc`（先认证后 RPC）与 HTTP `/rpc` 兜底。
//!
//! 安全边界（纵深防御）：
//! 1. 复用 [`crate::local_ipc::validate_loopback_host_and_origin`] 的严格回环 `Host` 校验；
//! 2. `/auth/local` **必须**携带与 `Host` 逐字符同源的 `Origin`（浏览器同源 POST），
//!    `curl` 式无 `Origin` 请求一律 `403`；本机脚本请走既有 gateway/admin IPC；
//! 3. 会话令牌绑定**单一 WebSocket 连接**，重复使用返回 `4409 SESSION_IN_USE`，
//!    连接关闭即销毁；并发 WebSocket 上限 32，超出以 `503` 类型化拒绝；
//! 4. Web 控制台只允许**只读/对话**方法白名单，`Export`/`ImportV1`/`Fabric*`/`Group*`/
//!    `Channel*`/`Shutdown` 等特权或状态变更方法即使持有有效令牌也返回
//!    `403 PERMISSION_DENIED`；
//! 5. 仅在显式配置 web 根（`QUETZALCOATL_WEB_DIR` 或可执行文件旁 `web/`）时启用控制台；
//!    静态资源拒绝 `%` 编码、`..`、点文件与逃逸根目录的符号链接；
//! 6. 统一附加严格 CSP（`wasm-unsafe-eval` 仅放行 WebAssembly 编译）与 `nosniff`。

use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};
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
const MAX_WEB_SOCKETS: usize = 32;
const MAX_STATIC_BYTES: usize = 8 * 1024 * 1024;
const MAX_WS_MESSAGE_BYTES: usize = 4 * 1024 * 1024;
const WS_GUID: &str = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

const WS_CLOSE_PROTOCOL: u16 = 1002;
const WS_CLOSE_TOO_LARGE: u16 = 1009;
const WS_CLOSE_UNAUTHORIZED: u16 = 4401;
const WS_CLOSE_SESSION_IN_USE: u16 = 4409;

/// Web 控制台仅允许这些方法（其余一律 `403 PERMISSION_DENIED`，与令牌无关）。
const WEB_ALLOWED_METHODS: &[&str] = &["status", "agents", "web_commit_artifact"];

// `'wasm-unsafe-eval'` 只放行 WebAssembly 编译，不等于 JS eval。
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

fn is_web_method_allowed(method: &str) -> bool {
    WEB_ALLOWED_METHODS.contains(&method)
}

struct SessionEntry {
    secret: [u8; 32],
    expires_ms: u64,
    bound: bool,
}

enum BindOutcome {
    Bound([u8; 32]),
    InUse,
    NotFound,
}

#[cfg(test)]
impl BindOutcome {
    fn bound_secret(self) -> Option<[u8; 32]> {
        match self {
            Self::Bound(secret) => Some(secret),
            Self::InUse | Self::NotFound => None,
        }
    }
}

/// 同源网页会话令牌表（绝不持久化；令牌与单一 WebSocket 连接绑定）。
#[derive(Default)]
struct WebSessionStore {
    entries: Mutex<Vec<SessionEntry>>,
}

impl WebSessionStore {
    #[cfg(test)]
    fn len(&self) -> usize {
        self.entries.lock().map_or(0, |guard| guard.len())
    }

    fn mint(&self) -> String {
        let mut raw = [0u8; 32];
        OsRng.fill_bytes(&mut raw);
        let now = now_unix_ms();
        let expiry = now.saturating_add(WEB_SESSION_TTL_MS);
        let Ok(mut guard) = self.entries.lock() else {
            return String::new();
        };
        guard.retain(|entry| entry.expires_ms > now);
        if guard.len() >= MAX_WEB_SESSIONS {
            guard.remove(0);
        }
        guard.push(SessionEntry {
            secret: raw,
            expires_ms: expiry,
            bound: false,
        });
        hex_encode(&raw)
    }

    fn find(&self, candidate: &str) -> Option<([u8; 32], bool)> {
        let (decoded, syntax_ok) = decode_hex_32_constant(candidate);
        if !syntax_ok {
            return None;
        }
        let now = now_unix_ms();
        let mut guard = self.entries.lock().ok()?;
        guard.retain(|entry| entry.expires_ms > now);
        let mut matched = None;
        for entry in guard.iter() {
            if constant_time_eq_32(&decoded, &entry.secret) {
                matched = Some((entry.secret, entry.bound));
            }
        }
        matched
    }

    /// HTTP `/rpc` 兜底：已绑定 WS 的令牌仍允许同一页面在 WS 失败时回退。
    fn validate(&self, candidate: &str) -> bool {
        self.find(candidate).is_some()
    }

    fn bind(&self, candidate: &str) -> BindOutcome {
        let (decoded, syntax_ok) = decode_hex_32_constant(candidate);
        if !syntax_ok {
            return BindOutcome::NotFound;
        }
        let now = now_unix_ms();
        let Ok(mut guard) = self.entries.lock() else {
            return BindOutcome::NotFound;
        };
        guard.retain(|entry| entry.expires_ms > now);
        for entry in guard.iter_mut() {
            if constant_time_eq_32(&decoded, &entry.secret) {
                if entry.bound {
                    return BindOutcome::InUse;
                }
                entry.bound = true;
                return BindOutcome::Bound(entry.secret);
            }
        }
        BindOutcome::NotFound
    }

    /// 连接关闭即销毁令牌（不可复活）；同页面的 HTTP 回退会重新 `/auth/local`。
    fn release(&self, secret: &[u8; 32]) {
        let Ok(mut guard) = self.entries.lock() else {
            return;
        };
        guard.retain(|entry| !constant_time_eq_32(secret, &entry.secret));
    }
}

struct WsSessionLease<'a> {
    sessions: &'a WebSessionStore,
    secret: [u8; 32],
}

impl Drop for WsSessionLease<'_> {
    fn drop(&mut self) {
        self.sessions.release(&self.secret);
    }
}

struct SocketSlot<'a>(&'a AtomicUsize);

impl Drop for SocketSlot<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
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
        match serde_json::to_vec(value) {
            Ok(body) => Self {
                status,
                content_type: "application/json; charset=utf-8",
                body,
            },
            Err(_) => Self::encode_failure(),
        }
    }

    /// 序列化失败必须是明确的 `500`（绝不返回 `null` / 空体）。
    fn encode_failure() -> Self {
        Self {
            status: 500,
            content_type: "application/json; charset=utf-8",
            body: br#"{"kind":"error","data":{"code":"ENCODE_FAILED","detail":"response encoding failed"}}"#
                .to_vec(),
        }
    }

    fn error(status: u16, code: &str) -> Self {
        Self::json(
            status,
            &serde_json::json!({ "error": code, "status": status }),
        )
    }

    fn ipc_error(status: u16, code: &str, detail: &str) -> Self {
        Self::json(
            status,
            &serde_json::json!({
                "kind": "error",
                "data": { "code": code, "detail": detail },
            }),
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
        409 => "Conflict",
        413 => "Payload Too Large",
        500 => "Internal Server Error",
        503 => "Service Unavailable",
        _ => "Response",
    }
}

/// 同源 Web 控制台（跨连接共享会话表与连接计数）。
pub(crate) struct WebConsole {
    dir: Option<PathBuf>,
    sessions: WebSessionStore,
    active_sockets: AtomicUsize,
}

impl WebConsole {
    pub(crate) fn new(dir: Option<PathBuf>) -> Self {
        let resolved = dir.filter(|path| path.is_dir());
        Self {
            dir: resolved,
            sessions: WebSessionStore::default(),
            active_sockets: AtomicUsize::new(0),
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
        let method = request.method.to_ascii_uppercase();
        let head_only = method == "HEAD";
        let upgrade = request
            .header("upgrade")
            .is_some_and(|value| value.eq_ignore_ascii_case("websocket"));

        // 未显式配置 web 根时，除存活探针外全部 404（控制台与 WS 升级都不对外存在）。
        if self.dir.is_none() && path != "/health" {
            write_http_reply(
                stream,
                &WebReply::error(404, "web_console_disabled"),
                head_only,
            );
            return;
        }

        if path == "/rpc" && upgrade {
            self.serve_websocket(stream, request, handler);
            return;
        }

        let reply = match (method.as_str(), path) {
            ("GET" | "HEAD", "/health") => WebReply::json(
                200,
                &serde_json::json!({
                    "status": "ok",
                    "version": env!("CARGO_PKG_VERSION"),
                    "web": self.dir.is_some(),
                }),
            ),
            ("GET" | "HEAD" | "POST", "/auth/local") => self.auth_local(request, head_only),
            ("GET", "/rpc/snapshot") => self.snapshot_reply(request, handler),
            ("POST", "/rpc") => self.http_rpc(request, handler),
            ("GET" | "HEAD", _) => self.static_reply(path),
            _ => WebReply::error(405, "method_not_allowed"),
        };
        write_http_reply(stream, &reply, head_only);
    }

    fn auth_local(&self, request: &ParsedIpcHttp, head_only: bool) -> WebReply {
        // 必须同源：Origin 缺失（curl/本机脚本）或与 Host 不一致一律拒绝。
        let Some(host) = request.header("host") else {
            return WebReply::error(403, "missing_host");
        };
        let Some(origin) = request.header("origin") else {
            return WebReply::error(403, "origin_required");
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
        // HEAD 只是能力预检：绝不签发一条无人使用的会话令牌。
        if head_only {
            return WebReply::json(
                200,
                &serde_json::json!({
                    "expires_in_secs": WEB_SESSION_TTL_MS / 1000,
                    "daemon_version": env!("CARGO_PKG_VERSION"),
                }),
            );
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
        WebReply::json(200, &snapshot_for(handler))
    }

    fn http_rpc<H: IpcHandler + ?Sized>(&self, request: &ParsedIpcHttp, handler: &H) -> WebReply {
        if !self.authorized(request) {
            return WebReply::error(401, "unauthorized");
        }
        let value: serde_json::Value = match serde_json::from_slice(&request.body) {
            Ok(value) => value,
            Err(error) => {
                return WebReply::ipc_error(400, "SERIALIZATION_ERROR", &error.to_string());
            }
        };
        let method = value
            .get("method")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("");
        if !is_web_method_allowed(method) {
            return WebReply::ipc_error(403, "PERMISSION_DENIED", "该方法不允许经 Web 控制台调用");
        }
        if method == "web_commit_artifact" {
            let artifact = value
                .get("params")
                .and_then(|params| params.get("artifact_key"))
                .and_then(serde_json::Value::as_str)
                .unwrap_or("");
            return commit_reply(handler, artifact);
        }
        let parsed: IpcRequest = match serde_json::from_value(value) {
            Ok(parsed) => parsed,
            Err(error) => {
                return WebReply::ipc_error(400, "SERIALIZATION_ERROR", &error.to_string());
            }
        };
        let (response, _) = handler.handle(parsed);
        match serde_json::to_value(&response) {
            Ok(value) => WebReply::json(200, &value),
            Err(_) => WebReply::encode_failure(),
        }
    }

    fn static_reply(&self, path: &str) -> WebReply {
        let Some(dir) = &self.dir else {
            return WebReply::error(404, "web_console_disabled");
        };
        let Some(relative) = sanitize_static_path(path) else {
            return WebReply::error(403, "path_denied");
        };
        let Ok(canonical_root) = fs::canonicalize(dir) else {
            return WebReply::error(404, "web_console_disabled");
        };
        let mut file = dir.join(&relative);
        if !file.is_file() && relative.extension().is_none() {
            // SPA 深链回退（仅无扩展名路径）。
            file = dir.join("index.html");
        }
        let Ok(canonical_file) = fs::canonicalize(&file) else {
            return WebReply::error(404, "not_found");
        };
        if !canonical_file.starts_with(&canonical_root) {
            return WebReply::error(403, "path_denied");
        }
        let Ok(metadata) = fs::metadata(&canonical_file) else {
            return WebReply::error(404, "not_found");
        };
        if !metadata.is_file() {
            return WebReply::error(404, "not_found");
        }
        if metadata.len() > u64::try_from(MAX_STATIC_BYTES).unwrap_or(u64::MAX) {
            return WebReply::error(413, "asset_too_large");
        }
        let Ok(body) = fs::read(&canonical_file) else {
            return WebReply::error(404, "not_found");
        };
        WebReply {
            status: 200,
            content_type: content_type_for(&canonical_file),
            body,
        }
    }

    fn reserve_socket(&self) -> Option<SocketSlot<'_>> {
        let mut current = self.active_sockets.load(Ordering::SeqCst);
        loop {
            if current >= MAX_WEB_SOCKETS {
                return None;
            }
            match self.active_sockets.compare_exchange(
                current,
                current + 1,
                Ordering::SeqCst,
                Ordering::SeqCst,
            ) {
                Ok(_) => return Some(SocketSlot(&self.active_sockets)),
                Err(actual) => current = actual,
            }
        }
    }

    fn serve_websocket<S: Read + Write, H: IpcHandler + ?Sized>(
        &self,
        stream: &mut S,
        request: &ParsedIpcHttp,
        handler: &H,
    ) {
        let Some(_slot) = self.reserve_socket() else {
            write_http_reply(stream, &WebReply::error(503, "too_many_connections"), false);
            return;
        };
        let Some(key) = request.header("sec-websocket-key").map(str::trim) else {
            write_http_reply(
                stream,
                &WebReply::error(400, "missing_websocket_key"),
                false,
            );
            return;
        };
        let version_ok = request
            .header("sec-websocket-version")
            .is_some_and(|value| value.trim() == "13");
        if !version_ok {
            write_http_reply(
                stream,
                &WebReply::error(400, "unsupported_websocket_version"),
                false,
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

        let Some(payload) = ws_read_message(stream) else {
            return;
        };
        let auth: WsAuth = match serde_json::from_slice(&payload) {
            Ok(value) => value,
            Err(_) => {
                ws_write_close(stream, 4400, "malformed-auth");
                return;
            }
        };
        let secret = match self.sessions.bind(&auth.auth) {
            BindOutcome::Bound(secret) => secret,
            BindOutcome::InUse => {
                ws_write_close(stream, WS_CLOSE_SESSION_IN_USE, "session-in-use");
                return;
            }
            BindOutcome::NotFound => {
                ws_write_close(stream, WS_CLOSE_UNAUTHORIZED, "unauthorized");
                return;
            }
        };
        let _lease = WsSessionLease {
            sessions: &self.sessions,
            secret,
        };
        if ws_write_json(
            stream,
            &serde_json::json!({"type": "ready", "transport": "websocket"}),
        )
        .is_err()
        {
            return;
        }
        if ws_write_json(
            stream,
            &serde_json::json!({"type": "snapshot", "state": snapshot_for(handler)}),
        )
        .is_err()
        {
            return;
        }

        while let Some(payload) = ws_read_message(stream) {
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
                    if ws_write_json(
                        stream,
                        &serde_json::json!({"type": "snapshot", "state": snapshot_for(handler)}),
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
            let method = request_value
                .get("method")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("");
            if !is_web_method_allowed(method) {
                if ws_write_json(
                    stream,
                    &serde_json::json!({
                        "type": "response",
                        "id": id,
                        "response": {
                            "kind": "error",
                            "data": {"code": "PERMISSION_DENIED", "detail": "该方法不允许经 Web 控制台调用"},
                        },
                    }),
                )
                .is_err()
                {
                    return;
                }
                continue;
            }
            if method == "web_commit_artifact" {
                let artifact = request_value
                    .get("params")
                    .and_then(|params| params.get("artifact_key"))
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("");
                let (code, detail) = match validate_artifact_key(artifact) {
                    Ok(()) => match handler.web_commit_artifact(artifact) {
                        Ok(detail) => {
                            if ws_write_json(
                                stream,
                                &serde_json::json!({
                                    "type": "response",
                                    "id": id,
                                    "response": {"kind": "ack", "data": {"detail": detail}},
                                }),
                            )
                            .is_err()
                            {
                                return;
                            }
                            continue;
                        }
                        Err((code, detail)) => (code, detail),
                    },
                    Err((code, detail)) => (code, detail),
                };
                if ws_write_json(
                    stream,
                    &serde_json::json!({
                        "type": "response",
                        "id": id,
                        "response": {"kind": "error", "data": {"code": code, "detail": detail}},
                    }),
                )
                .is_err()
                {
                    return;
                }
                continue;
            }
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
            let Ok(response_value) = serde_json::to_value(&response) else {
                if ws_write_json(
                    stream,
                    &serde_json::json!({
                        "type": "response",
                        "id": id,
                        "response": {"kind": "error", "data": {"code": "ENCODE_FAILED", "detail": "响应序列化失败"}},
                    }),
                )
                .is_err()
                {
                    return;
                }
                continue;
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

fn validate_artifact_key(artifact: &str) -> std::result::Result<(), (String, String)> {
    if artifact.is_empty()
        || artifact.len() > 256
        || !artifact.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b'.' | b'_' | b'-' | b':')
        })
    {
        return Err((
            String::from("MALFORMED_ARTIFACT"),
            String::from("产物引用格式非法"),
        ));
    }
    Ok(())
}

fn commit_reply<H: IpcHandler + ?Sized>(handler: &H, artifact: &str) -> WebReply {
    if let Err((code, detail)) = validate_artifact_key(artifact) {
        return WebReply::ipc_error(400, &code, &detail);
    }
    match handler.web_commit_artifact(artifact) {
        Ok(detail) => WebReply::json(
            200,
            &serde_json::json!({"kind": "ack", "data": {"detail": detail}}),
        ),
        Err((code, detail)) => {
            let status = match code.as_str() {
                "NO_GROUP_SESSION" => 409,
                "PERMISSION_DENIED" => 403,
                _ => 500,
            };
            WebReply::ipc_error(status, &code, &detail)
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

/// 把守护进程状态 + Web 附加面板折叠为三档共用的响应式快照（rev=1 基线）。
fn snapshot_for<H: IpcHandler + ?Sized>(handler: &H) -> serde_json::Value {
    let (response, _) = handler.handle(IpcRequest::Status);
    snapshot_from_status(&response, handler.web_extras().as_ref())
}

fn snapshot_from_status(
    response: &IpcResponse,
    extras: Option<&serde_json::Value>,
) -> serde_json::Value {
    let mut rows = serde_json::Map::new();
    if let IpcResponse::Status(status) = response {
        let raw = serde_json::to_string(status).unwrap_or_else(|_| String::from("{}"));
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
                    "raw_json": serde_json::to_string(agent).unwrap_or_else(|_| String::from("{}")),
                    "updated_rev": 1,
                }),
            );
        }
    }

    let mut session = serde_json::json!({"kind": "personal"});
    if let Some(extras) = extras {
        if let Some(extra_rows) = extras.get("rows").and_then(serde_json::Value::as_object) {
            for (key, row) in extra_rows {
                rows.insert(key.clone(), row.clone());
            }
        }
        if let Some(extra_session) = extras.get("session") {
            session = extra_session.clone();
        }
    }
    let kind = session
        .get("kind")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("personal");
    let room = session
        .get("room_id")
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.is_empty());
    let summary = match (kind, room) {
        ("group", Some(room_id)) => format!("群组会话 · {room_id}"),
        ("group", None) => String::from("群组会话"),
        _ => String::from("个人会话"),
    };
    let detail = if kind == "group" {
        "提交产物会发布到当前群组纪元。"
    } else {
        "提交产物需要先加入群组房间；当前为个人会话。"
    };
    rows.insert(
        String::from("session/active"),
        serde_json::json!({
            "key": "session/active",
            "kind": "session",
            "summary": summary,
            "detail": detail,
            "raw_json": serde_json::to_string(&session).unwrap_or_else(|_| String::from("{}")),
            "updated_rev": 1,
        }),
    );

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
        if segment == ".." || segment.starts_with('.') {
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

fn write_http_reply<W: Write>(stream: &mut W, reply: &WebReply, head_only: bool) {
    let head = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: {}\r\nContent-Length: {}\r\nContent-Security-Policy: {}\r\nX-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
        reply.status,
        reason_phrase(reply.status),
        reply.content_type,
        reply.body.len(),
        CSP,
    );
    let _ = stream.write_all(head.as_bytes());
    if !head_only {
        let _ = stream.write_all(&reply.body);
    }
    let _ = stream.flush();
}

struct WsFrame {
    fin: bool,
    opcode: u8,
    payload: Vec<u8>,
}

/// 读取一个**必须掩码**的客户端帧；协议违规立即 close 1002。
fn ws_read_frame<S: Read + Write>(stream: &mut S) -> Option<WsFrame> {
    let mut header = [0u8; 2];
    if stream.read_exact(&mut header).is_err() {
        return None;
    }
    let fin = header[0] & 0x80 != 0;
    let opcode = header[0] & 0x0f;
    let masked = header[1] & 0x80 != 0;
    if !masked {
        ws_write_close(stream, WS_CLOSE_PROTOCOL, "unmasked-client-frame");
        return None;
    }
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
    if length > MAX_WS_MESSAGE_BYTES as u64 {
        ws_write_close(stream, WS_CLOSE_TOO_LARGE, "frame-too-large");
        return None;
    }
    let mut mask = [0u8; 4];
    if stream.read_exact(&mut mask).is_err() {
        return None;
    }
    let mut payload = vec![0u8; usize::try_from(length).ok()?];
    if stream.read_exact(&mut payload).is_err() {
        return None;
    }
    for (index, byte) in payload.iter_mut().enumerate() {
        *byte ^= mask[index % 4];
    }
    Some(WsFrame {
        fin,
        opcode,
        payload,
    })
}

/// 读取一条完整文本/二进制消息，支持分片（FIN/continuation）并内联处理控制帧。
fn ws_read_message<S: Read + Write>(stream: &mut S) -> Option<Vec<u8>> {
    let mut assembled: Option<Vec<u8>> = None;
    loop {
        let frame = ws_read_frame(stream)?;
        match frame.opcode {
            0x8 => {
                if !frame.fin || frame.payload.len() > 125 {
                    ws_write_close(stream, WS_CLOSE_PROTOCOL, "bad-close-frame");
                    return None;
                }
                ws_write_close(stream, 1000, "bye");
                return None;
            }
            0x9 => {
                if !frame.fin || frame.payload.len() > 125 {
                    ws_write_close(stream, WS_CLOSE_PROTOCOL, "bad-control-frame");
                    return None;
                }
                if ws_write_frame(stream, 0xa, &frame.payload).is_err() {
                    return None;
                }
            }
            0xa => {
                if !frame.fin || frame.payload.len() > 125 {
                    ws_write_close(stream, WS_CLOSE_PROTOCOL, "bad-control-frame");
                    return None;
                }
            }
            0x1 | 0x2 => {
                if assembled.is_some() {
                    ws_write_close(stream, WS_CLOSE_PROTOCOL, "fragmented-data-in-progress");
                    return None;
                }
                if frame.fin {
                    return Some(frame.payload);
                }
                assembled = Some(frame.payload);
            }
            0x0 => {
                let Some(buffer) = assembled.as_mut() else {
                    ws_write_close(stream, WS_CLOSE_PROTOCOL, "unexpected-continuation");
                    return None;
                };
                if buffer.len().saturating_add(frame.payload.len()) > MAX_WS_MESSAGE_BYTES {
                    ws_write_close(stream, WS_CLOSE_TOO_LARGE, "message-too-large");
                    return None;
                }
                buffer.extend_from_slice(&frame.payload);
                if frame.fin {
                    return assembled.take();
                }
            }
            _ => {
                ws_write_close(stream, WS_CLOSE_PROTOCOL, "unknown-opcode");
                return None;
            }
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
    fn static_path_sanitizer_rejects_traversal_encoding_and_dotfiles() {
        assert!(sanitize_static_path("/../Cargo.toml").is_none());
        assert!(sanitize_static_path("/%2e%2e/secret").is_none());
        assert!(sanitize_static_path("/a/../../b").is_none());
        assert!(sanitize_static_path("/.git/config").is_none());
        assert!(sanitize_static_path("/.env").is_none());
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
    fn web_method_allowlist_is_read_only_and_explicit() {
        for allowed in ["status", "agents", "web_commit_artifact"] {
            assert!(is_web_method_allowed(allowed), "{allowed} 应在白名单内");
        }
        for denied in [
            "chat",
            "delegate_run",
            "host_session_start",
            "host_prompt_submit",
            "host_turn_end",
            "host_status_line",
            "host_tool_call",
            "conscience_pinned",
            "desktop_snapshot",
            "export",
            "import_v1",
            "fabric_login",
            "group_send",
            "group_list",
            "channel_deliver",
            "shutdown",
            "set_permission",
            "self_update",
            "restart",
            "secrets",
        ] {
            assert!(!is_web_method_allowed(denied), "{denied} 绝不能在白名单内");
        }
    }

    #[test]
    fn web_sessions_mint_bind_and_release() {
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

        let bound = store.bind(&first);
        assert!(matches!(&bound, BindOutcome::Bound(_)));
        let secret = bound.bound_secret().unwrap_or_default();
        assert!(matches!(store.bind(&first), BindOutcome::InUse));
        assert!(matches!(store.bind("deadbeef"), BindOutcome::NotFound));
        store.release(&secret);
        assert!(!store.validate(&first));
        assert!(matches!(store.bind(&first), BindOutcome::NotFound));
        assert!(store.validate(&second), "其他令牌不受影响");
    }

    #[test]
    fn web_session_validation_accepts_uppercase_hex() {
        let store = WebSessionStore::default();
        let token = store.mint();
        assert!(store.validate(&token.to_ascii_uppercase()));
    }

    struct CapturingHandler {
        last: Mutex<Option<IpcRequest>>,
    }

    impl IpcHandler for CapturingHandler {
        fn handle(&self, req: IpcRequest) -> (IpcResponse, bool) {
            if let Ok(mut guard) = self.last.lock() {
                *guard = Some(req);
            }
            (
                IpcResponse::Ack {
                    detail: String::from("ok"),
                },
                false,
            )
        }
    }

    fn authed_request(
        method: &str,
        target: &str,
        body: Vec<u8>,
        console: &WebConsole,
    ) -> ParsedIpcHttp {
        let token = console.sessions_for_test().mint();
        ParsedIpcHttp {
            method: method.to_owned(),
            target: target.to_owned(),
            headers: vec![(String::from("authorization"), format!("Bearer {token}"))],
            body,
        }
    }

    #[test]
    fn head_auth_local_does_not_mint_an_unused_session() {
        let console = WebConsole::new(Some(std::env::temp_dir()));
        let request = ParsedIpcHttp {
            method: String::from("HEAD"),
            target: String::from("/auth/local"),
            headers: vec![
                (String::from("host"), String::from("127.0.0.1:1234")),
                (
                    String::from("origin"),
                    String::from("http://127.0.0.1:1234"),
                ),
            ],
            body: Vec::new(),
        };
        let reply = console.auth_local(&request, true);
        assert_eq!(reply.status, 200);
        assert_eq!(
            console.sessions_for_test().len(),
            0,
            "HEAD 预检不得签发无人使用的会话令牌"
        );

        let get_reply = console.auth_local(&request, false);
        assert_eq!(get_reply.status, 200);
        assert_eq!(console.sessions_for_test().len(), 1);
    }

    #[test]
    fn web_callers_cannot_delegate_runs() {
        let console = WebConsole::new(Some(std::env::temp_dir()));
        let handler = CapturingHandler {
            last: Mutex::new(None),
        };
        let crafted = serde_json::json!({
            "method": "delegate_run",
            "params": {
                "task": "改掉整个仓库",
                "peer_id": null,
                "workspace_dir": "/tmp/evil-repo",
                "verifier_dag": null,
                "router_attempted_forbidden_tools": []
            }
        });
        let Ok(body) = serde_json::to_vec(&crafted) else {
            return;
        };
        let request = authed_request("POST", "/rpc", body, &console);
        let reply = console.http_rpc(&request, &handler);
        assert_eq!(reply.status, 403, "委派受管运行不允许经 Web 调用");
        let reached = handler.last.lock().ok().and_then(|guard| guard.clone());
        assert!(reached.is_none(), "被拒绝的方法不得到达守护进程");
    }

    #[test]
    fn web_console_without_dir_serves_no_static() {
        let console = WebConsole::new(None);
        assert_eq!(console.static_reply("/").status, 404);
        assert_eq!(console.sessions_for_test().mint().len(), 64);
    }
}
