#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]

//! 治理面的同源托管：静态资源 + `/auth/local` 同机浏览器认证 + `/health` + `POST /rpc`。
//!
//! 治理面只「看」和「签」：每次调用是一次请求/响应，没有长连接，也没有任何对话方法。
//!
//! 安全边界（纵深防御）：
//! 1. 复用 [`crate::local_ipc::validate_loopback_host_and_origin`] 的严格回环 `Host` 校验；
//! 2. `/auth/local` **必须**携带与 `Host` 逐字符同源的 `Origin`（浏览器同源 POST），
//!    `curl` 式无 `Origin` 请求一律 `403`；本机脚本请走既有的本机 IPC；
//! 3. 只允许治理面的 `sea_*` 方法与只读的 `status`；其余（导出、导入、组网、群组、通道、
//!    宿主会话、委派、停机等）即使持有有效令牌也返回 `403 PERMISSION_DENIED`；
//! 4. 仅在显式配置 web 根（`QUETZALCOATL_WEB_DIR` 或可执行文件旁 `web/`）时启用；
//!    静态资源拒绝 `%` 编码、`..`、点文件与逃逸根目录的符号链接；
//! 5. 统一附加严格 CSP 与 `nosniff`。

use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use rand_core::{OsRng, RngCore};

use crate::local_ipc::{
    IpcHandler, IpcRequest, ParsedIpcHttp, constant_time_eq_32, decode_hex_32_constant,
};

/// Web 会话有效期：12 小时。
const WEB_SESSION_TTL_MS: u64 = 12 * 60 * 60 * 1000;
const MAX_WEB_SESSIONS: usize = 256;
const MAX_STATIC_BYTES: usize = 8 * 1024 * 1024;

/// Web 控制台仅允许这些方法（其余一律 `403 PERMISSION_DENIED`，与令牌无关）。
const WEB_ALLOWED_METHODS: &[&str] = &[
    "status",
    "sea_overview",
    "sea_self",
    "sea_user",
    "sea_us",
    "sea_memories",
    "sea_memory",
    "sea_baseline",
    "sea_hosts",
    "sea_devices",
    "sea_audit",
    "sea_entry_update",
    "sea_entry_mute",
    "sea_entry_erase",
    "sea_baseline_sign",
    "sea_focus_set",
    "sea_rhythm_set",
    "sea_device_revoke",
];

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
}

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
        });
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
        guard.retain(|entry| entry.expires_ms > now);
        let mut matched = false;
        for entry in guard.iter() {
            matched |= constant_time_eq_32(&decoded, &entry.secret);
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
        let method = request.method.to_ascii_uppercase();
        let head_only = method == "HEAD";

        // 未显式配置 web 根时，除存活探针外全部 404（治理面不对外存在）。
        if self.dir.is_none() && path != "/health" {
            write_http_reply(
                stream,
                &WebReply::error(404, "web_console_disabled"),
                head_only,
            );
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
            return WebReply::ipc_error(403, "PERMISSION_DENIED", "该方法不允许经治理面调用");
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
}

impl ParsedIpcHttp {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }
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
        "woff2" => "font/woff2",
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::local_ipc::IpcResponse;

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
        for allowed in [
            "status",
            "sea_overview",
            "sea_memories",
            "sea_baseline_sign",
        ] {
            assert!(is_web_method_allowed(allowed), "{allowed} 应在白名单内");
        }
        for denied in [
            "agents",
            "web_commit_artifact",
            "chat",
            "delegate_run",
            "host_session_start",
            "host_prompt_submit",
            "host_turn_end",
            "host_status_line",
            "host_tool_call",
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
    fn web_sessions_mint_and_validate() {
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
