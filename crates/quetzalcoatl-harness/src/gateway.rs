#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]

//! 回环安全 LLM 网关（防坑规范 #1, #2, #3, #4 与 Review Focus #5）。

use std::collections::BTreeMap;
use std::fmt;
use std::fs;
use std::hint::black_box;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use quetzalcoatl_crypto::hex_encode;
use quetzalcoatl_ewave::AssembledContext;
use quetzalcoatl_sandbox::{UpstreamRequest, UpstreamTransport};
use quetzalcoatl_types::{QuetzalcoatlError, Result, RunId};
use rand_core::{OsRng, RngCore};
use serde::de::{MapAccess, SeqAccess, Visitor};
use serde::ser::{SerializeMap, SerializeSeq};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::value::RawValue;
use zeroize::{Zeroize, ZeroizeOnDrop};

use crate::drivers::opencode::OpenCodeDriver;

const MAX_GATEWAY_HEADER_BYTES: usize = 64 * 1024;
const MAX_GATEWAY_BODY_BYTES: usize = 16 * 1024 * 1024;
const STUB_TOKEN_PREFIX: &str = "qz_stub_";

#[must_use]
fn constant_time_eq_32(a: &[u8; 32], b: &[u8; 32]) -> bool {
    let mut acc = 0u8;
    for idx in 0..32 {
        acc |= black_box(a[idx]) ^ black_box(b[idx]);
    }
    black_box(acc) == 0
}

const fn decode_hex_nibble(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

fn decode_hex_32_constant_shape(s: &str) -> ([u8; 32], bool) {
    let raw = s.trim().as_bytes();
    if raw.len() != 64 {
        return ([0u8; 32], false);
    }
    let mut out = [0u8; 32];
    let mut ok = true;
    for (idx, slot) in out.iter_mut().enumerate() {
        match (
            decode_hex_nibble(raw[idx * 2]),
            decode_hex_nibble(raw[idx * 2 + 1]),
        ) {
            (Some(hi), Some(lo)) => *slot = (hi << 4) | lo,
            _ => {
                *slot = 0;
                ok = false;
            }
        }
    }
    (out, ok)
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct GatewayUpstreamEndpoints {
    pub anthropic_base_url: String,
    pub openai_base_url: String,
    pub codex_chatgpt_base_url: String,
    pub gemini_base_url: String,
}

impl Default for GatewayUpstreamEndpoints {
    fn default() -> Self {
        Self {
            anthropic_base_url: String::from("https://api.anthropic.com"),
            openai_base_url: String::from("https://api.openai.com"),
            codex_chatgpt_base_url: String::from("https://chatgpt.com"),
            gemini_base_url: String::from("https://generativelanguage.googleapis.com"),
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct GatewayConfig {
    pub endpoints: GatewayUpstreamEndpoints,
}

#[derive(Clone, Default, Zeroize, ZeroizeOnDrop)]
pub struct ExtractedOAuthCredentials {
    pub claude_access_token: Option<String>,
    pub codex_access_token: Option<String>,
    pub codex_account_id: Option<String>,
}

impl fmt::Debug for ExtractedOAuthCredentials {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ExtractedOAuthCredentials")
            .field("has_claude_token", &self.claude_access_token.is_some())
            .field("has_codex_token", &self.codex_access_token.is_some())
            .field("codex_account_id", &self.codex_account_id)
            .finish()
    }
}

#[derive(Clone, Debug)]
pub struct StrippedOAuthStubBundle {
    pub claude_config_dir: PathBuf,
    pub codex_home_dir: PathBuf,
    pub ephemeral_stub_token: String,
    pub extracted: ExtractedOAuthCredentials,
}

#[derive(Clone, Debug)]
pub struct GatewaySessionConfig {
    pub run_id: RunId,
    pub assembled_context: AssembledContext,
    pub upstream_anthropic_bearer: Option<String>,
    pub upstream_openai_bearer: Option<String>,
    pub upstream_codex_bearer: Option<String>,
    pub upstream_codex_account_id: Option<String>,
    pub upstream_gemini_bearer: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct GatewaySessionGrant {
    pub run_id: RunId,
    pub cap_token: String,
    pub qz_token: String,
    pub ephemeral_stub_token: String,
    pub run_base_url: String,
}

#[derive(Zeroize, ZeroizeOnDrop)]
struct ManagedGatewaySession {
    cap_token_bytes: [u8; 32],
    qz_token_bytes: [u8; 32],
    stub_token_bytes: [u8; 32],
    upstream_anthropic_bearer: Option<String>,
    upstream_openai_bearer: Option<String>,
    upstream_codex_bearer: Option<String>,
    upstream_codex_account_id: Option<String>,
    upstream_gemini_bearer: Option<String>,
    #[zeroize(skip)]
    run_id: RunId,
    #[zeroize(skip)]
    assembled_context: AssembledContext,
}

struct GatewayInner {
    config: GatewayConfig,
    transport: Arc<dyn UpstreamTransport>,
    sessions: Mutex<Vec<ManagedGatewaySession>>,
}

pub struct GatewayServerHandle {
    bound_addr: SocketAddr,
    stop: Arc<AtomicBool>,
    join_handle: Option<JoinHandle<()>>,
}

impl GatewayServerHandle {
    #[must_use]
    pub const fn bound_addr(&self) -> SocketAddr {
        self.bound_addr
    }

    #[must_use]
    pub fn base_url(&self) -> String {
        format!("http://{}", self.bound_addr)
    }

    pub fn shutdown(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        let _ = TcpStream::connect_timeout(&self.bound_addr, Duration::from_millis(20));
        if let Some(h) = self.join_handle.take() {
            let _ = h.join();
        }
    }
}

impl Drop for GatewayServerHandle {
    fn drop(&mut self) {
        self.shutdown();
    }
}

#[derive(Clone)]
pub struct LoopbackGateway {
    inner: Arc<GatewayInner>,
}

impl LoopbackGateway {
    #[must_use]
    pub fn new(config: GatewayConfig, transport: Arc<dyn UpstreamTransport>) -> Self {
        Self {
            inner: Arc::new(GatewayInner {
                config,
                transport,
                sessions: Mutex::new(Vec::new()),
            }),
        }
    }

    pub fn register_session(
        &self,
        base_url: &str,
        session: GatewaySessionConfig,
    ) -> Result<GatewaySessionGrant> {
        let mut cap_token_bytes = [0u8; 32];
        let mut qz_token_bytes = [0u8; 32];
        let mut stub_token_bytes = [0u8; 32];
        OsRng.fill_bytes(&mut cap_token_bytes);
        OsRng.fill_bytes(&mut qz_token_bytes);
        OsRng.fill_bytes(&mut stub_token_bytes);

        let cap_token = hex_encode(&cap_token_bytes);
        let qz_token = hex_encode(&qz_token_bytes);
        let ephemeral_stub_token = format!("{STUB_TOKEN_PREFIX}{}", hex_encode(&stub_token_bytes));
        let clean_base = base_url.trim_end_matches('/');
        let run_base_url = format!("{clean_base}/run/{cap_token}");

        let record = ManagedGatewaySession {
            cap_token_bytes,
            qz_token_bytes,
            stub_token_bytes,
            upstream_anthropic_bearer: session.upstream_anthropic_bearer,
            upstream_openai_bearer: session.upstream_openai_bearer,
            upstream_codex_bearer: session.upstream_codex_bearer,
            upstream_codex_account_id: session.upstream_codex_account_id,
            upstream_gemini_bearer: session.upstream_gemini_bearer,
            run_id: session.run_id,
            assembled_context: session.assembled_context,
        };

        let mut guard =
            self.inner
                .sessions
                .lock()
                .map_err(|_| QuetzalcoatlError::StorageError {
                    detail: String::from("LoopbackGateway 会话表锁异常"),
                })?;
        guard.push(record);

        Ok(GatewaySessionGrant {
            run_id: session.run_id,
            cap_token,
            qz_token,
            ephemeral_stub_token,
            run_base_url,
        })
    }

    pub fn update_session_context(&self, cap_token: &str, ctx: AssembledContext) -> Result<()> {
        let (target_cap, ok) = decode_hex_32_constant_shape(cap_token);
        if !ok {
            return Err(QuetzalcoatlError::CredentialRejected {
                detail: String::from("非法的会话能力密钥格式"),
            });
        }
        let mut guard =
            self.inner
                .sessions
                .lock()
                .map_err(|_| QuetzalcoatlError::StorageError {
                    detail: String::from("LoopbackGateway 会话表锁异常"),
                })?;
        let mut updated = false;
        for s in guard.iter_mut() {
            if constant_time_eq_32(&s.cap_token_bytes, &target_cap) {
                s.assembled_context = ctx.clone();
                updated = true;
            }
        }
        if !updated {
            return Err(QuetzalcoatlError::CredentialRejected {
                detail: String::from("未找到对应的活跃网关会话"),
            });
        }
        Ok(())
    }

    /// 将宿主侧剥离提取的真实 `~/.claude` / `~/.codex` 访问凭据绑定到当前网关会话（沙箱内仅见 `qz_stub_*`）。
    pub fn attach_extracted_oauth(
        &self,
        cap_token: &str,
        extracted: &ExtractedOAuthCredentials,
    ) -> Result<()> {
        let (target_cap, ok) = decode_hex_32_constant_shape(cap_token);
        if !ok {
            return Err(QuetzalcoatlError::CredentialRejected {
                detail: String::from("非法的会话能力密钥格式"),
            });
        }
        let mut guard =
            self.inner
                .sessions
                .lock()
                .map_err(|_| QuetzalcoatlError::StorageError {
                    detail: String::from("LoopbackGateway 会话表锁异常"),
                })?;
        for s in guard.iter_mut() {
            if constant_time_eq_32(&s.cap_token_bytes, &target_cap) {
                if s.upstream_anthropic_bearer.is_none()
                    && let Some(tok) = &extracted.claude_access_token
                {
                    s.upstream_anthropic_bearer = Some(tok.clone());
                }
                if s.upstream_codex_bearer.is_none()
                    && let Some(tok) = &extracted.codex_access_token
                {
                    s.upstream_codex_bearer = Some(tok.clone());
                }
                if s.upstream_openai_bearer.is_none()
                    && let Some(tok) = &extracted.codex_access_token
                {
                    s.upstream_openai_bearer = Some(tok.clone());
                }
                if s.upstream_codex_account_id.is_none()
                    && let Some(acct) = &extracted.codex_account_id
                {
                    s.upstream_codex_account_id = Some(acct.clone());
                }
            }
        }
        Ok(())
    }

    pub fn revoke_session(&self, cap_token: &str) -> bool {
        let (target_cap, ok) = decode_hex_32_constant_shape(cap_token);
        if !ok {
            return false;
        }
        let Ok(mut guard) = self.inner.sessions.lock() else {
            return false;
        };
        let before = guard.len();
        guard.retain(|s| !constant_time_eq_32(&s.cap_token_bytes, &target_cap));
        guard.len() < before
    }

    pub fn serve_loopback(&self, bind_addr: SocketAddr) -> Result<GatewayServerHandle> {
        if !bind_addr.ip().is_loopback() {
            return Err(QuetzalcoatlError::SandboxViolation {
                detail: format!("LoopbackGateway 仅允许绑定回环地址，拒绝: {bind_addr}"),
            });
        }
        let listener =
            TcpListener::bind(bind_addr).map_err(|e| QuetzalcoatlError::StorageError {
                detail: format!("绑定 LoopbackGateway 失败 ({bind_addr}): {e}"),
            })?;
        let bound_addr = listener
            .local_addr()
            .map_err(|e| QuetzalcoatlError::StorageError {
                detail: format!("读取 LoopbackGateway 绑定地址失败: {e}"),
            })?;
        listener
            .set_nonblocking(true)
            .map_err(|e| QuetzalcoatlError::StorageError {
                detail: format!("设置 LoopbackGateway 非阻塞失败: {e}"),
            })?;

        let stop = Arc::new(AtomicBool::new(false));
        let stop_bg = Arc::clone(&stop);
        let gw_clone = self.clone();

        let join_handle = thread::spawn(move || {
            while !stop_bg.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((mut stream, peer)) => {
                        if !peer.ip().is_loopback() {
                            continue;
                        }
                        let _ = stream.set_nonblocking(false);
                        let _ = stream.set_read_timeout(Some(Duration::from_secs(15)));
                        let _ = stream.set_write_timeout(Some(Duration::from_secs(15)));
                        let gw_conn = gw_clone.clone();
                        thread::spawn(move || {
                            gw_conn.handle_connection(&mut stream);
                        });
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(4));
                    }
                    Err(_) => {
                        thread::sleep(Duration::from_millis(10));
                    }
                }
            }
        });

        Ok(GatewayServerHandle {
            bound_addr,
            stop,
            join_handle: Some(join_handle),
        })
    }

    fn handle_connection(&self, stream: &mut TcpStream) {
        let resp = match read_wire_http_request(stream) {
            Ok(req) => self.dispatch_http(req),
            Err(err) => gateway_json_error(400, err.code().as_str(), &err.to_string()),
        };
        write_wire_http_response(stream, &resp);
    }

    fn dispatch_http(&self, req: WireHttpRequest) -> WireHttpResponse {
        // 防坑规范 #4：任何命中裸 /api/pty* 的访问一律 403 阻断
        let path_only = req
            .target
            .split_once('?')
            .map_or(req.target.as_str(), |(p, _)| p);
        if OpenCodeDriver::is_blocked_http_path(path_only) {
            return gateway_json_error(403, "SANDBOX_VIOLATION", "blocked raw /api/pty endpoint");
        }

        // 1. 解析路径级 256-bit 能力密钥: /run/<64-hex-cap-token>/...
        let Some(after_run) = req.target.strip_prefix("/run/") else {
            return gateway_json_error(
                401,
                "CREDENTIAL_REJECTED",
                "missing /run/<cap_token> capability prefix",
            );
        };
        let (cap_hex, sub_target) = match after_run.find('/') {
            Some(slash_idx) => (&after_run[..slash_idx], &after_run[slash_idx..]),
            None => (after_run, "/"),
        };
        let (cand_cap, cap_syntax_ok) = decode_hex_32_constant_shape(cap_hex);

        // 提取调用方传入的 x-qz-token 或沙箱存根令牌 qz_stub_<64hex>
        let qz_header_opt = find_header(&req.headers, "x-qz-token");
        let (cand_qz, has_valid_qz_syntax) = match qz_header_opt {
            Some(v) => decode_hex_32_constant_shape(v),
            None => ([0u8; 32], false),
        };
        let stub_candidate_hex = extract_stub_token_hex(&req.headers);
        let (cand_stub, has_valid_stub_syntax) = match stub_candidate_hex {
            Some(h) => decode_hex_32_constant_shape(h),
            None => ([0u8; 32], false),
        };

        // 2. 常量时间会话匹配与令牌核验（防本机 SSRF 与时序侧信道）
        let auth_snapshot = {
            let Ok(guard) = self.inner.sessions.lock() else {
                return gateway_json_error(500, "STORAGE_ERROR", "gateway session lock poisoned");
            };
            let mut matched_idx: Option<usize> = None;
            for (idx, sess) in guard.iter().enumerate() {
                let cap_eq = constant_time_eq_32(&cand_cap, &sess.cap_token_bytes);
                let qz_eq = constant_time_eq_32(&cand_qz, &sess.qz_token_bytes);
                let stub_eq = constant_time_eq_32(&cand_stub, &sess.stub_token_bytes);
                let header_auth_ok =
                    (has_valid_qz_syntax && qz_eq) || (has_valid_stub_syntax && stub_eq);
                if cap_syntax_ok && cap_eq && header_auth_ok {
                    matched_idx = Some(idx);
                }
            }
            let Some(idx) = matched_idx else {
                return gateway_json_error(
                    401,
                    "CREDENTIAL_REJECTED",
                    "missing or invalid capability / x-qz-token",
                );
            };
            let s = &guard[idx];
            let _ = s.run_id;
            (
                s.assembled_context.clone(),
                s.upstream_anthropic_bearer
                    .clone()
                    .map(zeroize::Zeroizing::new),
                s.upstream_openai_bearer
                    .clone()
                    .map(zeroize::Zeroizing::new),
                s.upstream_codex_bearer.clone().map(zeroize::Zeroizing::new),
                s.upstream_codex_account_id.clone(),
                s.upstream_gemini_bearer
                    .clone()
                    .map(zeroize::Zeroizing::new),
            )
        };

        let (
            assembled_ctx,
            anthropic_bearer,
            openai_bearer,
            codex_bearer,
            codex_acct_id,
            gemini_bearer,
        ) = auth_snapshot;

        let sub_path_only = sub_target.split_once('?').map_or(sub_target, |(p, _)| p);
        if OpenCodeDriver::is_blocked_http_path(sub_path_only) {
            return gateway_json_error(403, "SANDBOX_VIOLATION", "blocked raw /api/pty endpoint");
        }

        // 防坑规范 #3：Codex v0.163+ 对 /responses 发起 WebSocket Upgrade 握手时直接返回 HTTP 426 Upgrade Required
        let is_ws_upgrade = find_header(&req.headers, "upgrade")
            .is_some_and(|v| v.eq_ignore_ascii_case("websocket"));
        if is_ws_upgrade && sub_path_only.ends_with("/responses") {
            let body =
                b"{\"error\":\"WebSocket disabled by Quetzalcoatl gateway; fallback to HTTP SSE\"}"
                    .to_vec();
            return WireHttpResponse {
                status: 426,
                headers: vec![
                    (String::from("Upgrade"), String::from("HTTP/1.1")),
                    (
                        String::from("Content-Type"),
                        String::from("application/json"),
                    ),
                    (String::from("Content-Length"), body.len().to_string()),
                ],
                body,
            };
        }

        // 防坑规范 #3：若请求体为 Content-Encoding: zstd，使用 window_log_max(20) 护栏解压后再做良知注入与转发
        let was_zstd_encoded = find_header(&req.headers, "content-encoding")
            .is_some_and(|v| v.trim().eq_ignore_ascii_case("zstd"));
        let decoded_body = if was_zstd_encoded {
            match decompress_zstd_window20(&req.body, MAX_GATEWAY_BODY_BYTES) {
                Ok(plain) => plain,
                Err(err) => {
                    return gateway_json_error(400, err.code().as_str(), &err.to_string());
                }
            }
        } else {
            req.body.clone()
        };

        // 3. 按目标协议族路由与注入
        let (target_base_url, upstream_path_and_query, bearer_override, extra_acct_hdr, out_body) =
            if let Some(codex_rest) = sub_target.strip_prefix("/chatgpt") {
                // Codex OAuth ChatGPT 后端：严格保留 /backend-api/codex 后缀与 ChatGPT-Account-ID
                let rewritten = if sub_path_only.ends_with("/responses") && !decoded_body.is_empty()
                {
                    inject_codex_responses_raw_preserving(&decoded_body, &assembled_ctx)
                        .unwrap_or(decoded_body)
                } else {
                    decoded_body
                };
                let acct = if find_header(&req.headers, "chatgpt-account-id").is_none() {
                    codex_acct_id
                } else {
                    None
                };
                (
                    self.inner.config.endpoints.codex_chatgpt_base_url.clone(),
                    String::from(if codex_rest.is_empty() {
                        "/"
                    } else {
                        codex_rest
                    }),
                    codex_bearer,
                    acct,
                    rewritten,
                )
            } else if let Some(oai_rest) = sub_target.strip_prefix("/openai") {
                let norm_rest = if oai_rest.is_empty() { "/" } else { oai_rest };
                let oai_path_only = norm_rest.split_once('?').map_or(norm_rest, |(p, _)| p);
                let rewritten = if oai_path_only.ends_with("/responses") && !decoded_body.is_empty()
                {
                    inject_codex_responses_raw_preserving(&decoded_body, &assembled_ctx)
                        .unwrap_or(decoded_body)
                } else if oai_path_only.ends_with("/chat/completions") && !decoded_body.is_empty() {
                    inject_openai_chat_completions(&decoded_body, &assembled_ctx)
                        .unwrap_or(decoded_body)
                } else {
                    decoded_body
                };
                (
                    self.inner.config.endpoints.openai_base_url.clone(),
                    String::from(norm_rest),
                    openai_bearer,
                    None,
                    rewritten,
                )
            } else if sub_path_only.starts_with("/v1internal:")
                || sub_path_only.starts_with("/v1beta/")
            {
                // 防坑规范 #4：Gemini CLI 启动握手 (/v1internal:loadCodeAssist / :onboardUser) 无 model 字段原样放行
                let rewritten = if (sub_path_only.contains(":generateContent")
                    || sub_path_only.contains(":streamGenerateContent"))
                    && !decoded_body.is_empty()
                {
                    inject_gemini_generate_content(&decoded_body, &assembled_ctx)
                        .unwrap_or(decoded_body)
                } else {
                    decoded_body
                };
                (
                    self.inner.config.endpoints.gemini_base_url.clone(),
                    String::from(sub_target),
                    gemini_bearer,
                    None,
                    rewritten,
                )
            } else {
                // Anthropic Messages API (/v1/messages & /v1/messages/count_tokens)
                // 防坑规范 #2：/v1/messages/count_tokens 逐字节原样透传；/v1/messages 严禁触碰 system[0] 且归一化 <= 4 个 cache_control
                let rewritten = if sub_path_only == "/v1/messages/count_tokens" {
                    decoded_body
                } else if sub_path_only == "/v1/messages" && !decoded_body.is_empty() {
                    match inject_anthropic_messages_preserving_prefix_cache(
                        &decoded_body,
                        &assembled_ctx,
                    ) {
                        Ok(b) => b,
                        Err(err) => {
                            return gateway_json_error(400, err.code().as_str(), &err.to_string());
                        }
                    }
                } else {
                    decoded_body
                };
                (
                    self.inner.config.endpoints.anthropic_base_url.clone(),
                    String::from(sub_target),
                    anthropic_bearer,
                    None,
                    rewritten,
                )
            };

        let parsed_ep = match parse_endpoint_base(&target_base_url) {
            Ok(ep) => ep,
            Err(err) => return gateway_json_error(500, err.code().as_str(), &err.to_string()),
        };

        let mut out_headers = Vec::with_capacity(req.headers.len() + 2);
        for (k, v) in &req.headers {
            let lower = k.to_ascii_lowercase();
            // 剥离内部鉴权头、压缩编码头与可能含沙箱存根令牌的认证头
            if lower == "x-qz-token"
                || lower.starts_with("x-quetzalcoatl-")
                || lower == "host"
                || lower == "connection"
                || lower == "content-length"
                || lower == "transfer-encoding"
                || lower == "content-encoding"
                || lower == "accept-encoding"
            {
                continue;
            }
            if bearer_override.is_some()
                && (lower == "authorization" || lower == "x-api-key" || lower == "x-goog-api-key")
            {
                continue;
            }
            // 若客户端传的是沙箱占位存根令牌 qz_stub_* 且未配宿主覆盖令牌，也不将存根泄露至上游
            if v.contains(STUB_TOKEN_PREFIX) {
                continue;
            }
            out_headers.push((k.clone(), v.clone()));
        }

        if let Some(real_tok) = bearer_override {
            out_headers.push((
                String::from("Authorization"),
                format!("Bearer {}", real_tok.as_str()),
            ));
        }
        if let Some(acct) = extra_acct_hdr {
            out_headers.push((String::from("ChatGPT-Account-ID"), acct));
        }

        let joined_path = join_base_path(&parsed_ep.base_path, &upstream_path_and_query);
        let upstream_req = UpstreamRequest {
            method: req.method,
            scheme: parsed_ep.scheme,
            host: parsed_ep.host,
            port: parsed_ep.port,
            path_and_query: joined_path,
            headers: out_headers,
            body: out_body,
        };

        let upstream_resp = match self.inner.transport.roundtrip(&upstream_req) {
            Ok(r) => r,
            Err(err) => return gateway_json_error(502, err.code().as_str(), &err.to_string()),
        };

        // 防坑规范 #3：若上游仍返回了 zstd 压缩体，解压后以未压缩流回传以兼容无解压 reqwest 的 Codex
        let upstream_is_zstd = find_header(&upstream_resp.headers, "content-encoding")
            .is_some_and(|v| v.trim().eq_ignore_ascii_case("zstd"));
        let final_resp_body = if upstream_is_zstd {
            decompress_zstd_window20(&upstream_resp.body, MAX_GATEWAY_BODY_BYTES)
                .unwrap_or(upstream_resp.body)
        } else {
            upstream_resp.body
        };

        let mut resp_headers = Vec::with_capacity(upstream_resp.headers.len() + 1);
        for (k, v) in upstream_resp.headers {
            if k.eq_ignore_ascii_case("content-length")
                || k.eq_ignore_ascii_case("transfer-encoding")
                || k.eq_ignore_ascii_case("connection")
                || k.eq_ignore_ascii_case("content-encoding")
            {
                continue;
            }
            resp_headers.push((k, v));
        }
        resp_headers.push((
            String::from("Content-Length"),
            final_resp_body.len().to_string(),
        ));

        WireHttpResponse {
            status: upstream_resp.status,
            headers: resp_headers,
            body: final_resp_body,
        }
    }
}

fn decompress_zstd_window20(compressed: &[u8], max_output_bytes: usize) -> Result<Vec<u8>> {
    let mut decoder = zstd::stream::read::Decoder::new(compressed).map_err(|e| {
        QuetzalcoatlError::IntegrityViolation {
            detail: format!("初始化网关 Zstd 解码器失败: {e}"),
        }
    })?;
    decoder
        .window_log_max(20)
        .map_err(|e| QuetzalcoatlError::IntegrityViolation {
            detail: format!("设置 Zstd window_log_max(20) 失败: {e}"),
        })?;
    let mut out = Vec::new();
    let cap = (max_output_bytes as u64).saturating_add(1);
    decoder
        .take(cap)
        .read_to_end(&mut out)
        .map_err(|e| QuetzalcoatlError::IntegrityViolation {
            detail: format!("Zstd 请求体解压失败或超过 window_log_max(20) 限制: {e}"),
        })?;
    if out.len() > max_output_bytes {
        return Err(QuetzalcoatlError::IntegrityViolation {
            detail: String::from("Zstd 解压后体积超出网关上限"),
        });
    }
    Ok(out)
}

fn find_header<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
    headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case(name))
        .map(|(_, v)| v.as_str())
}

fn extract_stub_token_hex(headers: &[(String, String)]) -> Option<&str> {
    for (k, v) in headers {
        if k.eq_ignore_ascii_case("authorization") {
            let trimmed = v.trim();
            if let Some(bearer) = trimmed
                .strip_prefix("Bearer ")
                .or_else(|| trimmed.strip_prefix("bearer "))
                && let Some(hex_part) = bearer.trim().strip_prefix(STUB_TOKEN_PREFIX)
            {
                return Some(hex_part);
            }
        } else if (k.eq_ignore_ascii_case("x-api-key") || k.eq_ignore_ascii_case("x-goog-api-key"))
            && let Some(hex_part) = v.trim().strip_prefix(STUB_TOKEN_PREFIX)
        {
            return Some(hex_part);
        }
    }
    None
}

struct ParsedEndpointBase {
    scheme: String,
    host: String,
    port: u16,
    base_path: String,
}

fn parse_endpoint_base(url: &str) -> Result<ParsedEndpointBase> {
    let trimmed = url.trim().trim_end_matches('/');
    let (scheme_raw, rest) =
        trimmed
            .split_once("://")
            .ok_or_else(|| QuetzalcoatlError::SerializationError {
                detail: format!("上游端点缺少 scheme:// ({url})"),
            })?;
    let scheme = scheme_raw.to_ascii_lowercase();
    let default_port = if scheme == "https" { 443 } else { 80 };
    let (authority, base_path) = match rest.find('/') {
        Some(idx) => (&rest[..idx], String::from(&rest[idx..])),
        None => (rest, String::new()),
    };
    let (host, port) = if let Some(after_b) = authority.strip_prefix('[') {
        let (h6, rem) =
            after_b
                .split_once(']')
                .ok_or_else(|| QuetzalcoatlError::SerializationError {
                    detail: String::from("IPv6 端点缺少 ']'"),
                })?;
        let p = if let Some(ps) = rem.strip_prefix(':') {
            ps.parse::<u16>()
                .map_err(|_| QuetzalcoatlError::SerializationError {
                    detail: String::from("IPv6 端口非法"),
                })?
        } else {
            default_port
        };
        (format!("[{h6}]"), p)
    } else if let Some((h, ps)) = authority.rsplit_once(':') {
        let p = ps
            .parse::<u16>()
            .map_err(|_| QuetzalcoatlError::SerializationError {
                detail: String::from("上游端点端口非法"),
            })?;
        (String::from(h), p)
    } else {
        (String::from(authority), default_port)
    };

    Ok(ParsedEndpointBase {
        scheme,
        host,
        port,
        base_path,
    })
}

fn join_base_path(base_path: &str, sub_path: &str) -> String {
    let b = base_path.trim_end_matches('/');
    if b.is_empty() {
        if sub_path.starts_with('/') {
            String::from(sub_path)
        } else {
            format!("/{sub_path}")
        }
    } else if sub_path.starts_with('/') {
        format!("{b}{sub_path}")
    } else {
        format!("{b}/{sub_path}")
    }
}

/// 统计 Anthropic `/v1/messages` 请求中 `tools + system + messages` 全量 `cache_control` 块数。
#[must_use]
pub fn count_anthropic_cache_controls(payload: &serde_json::Value) -> usize {
    let mut total = 0usize;
    if let Some(tools) = payload.get("tools").and_then(serde_json::Value::as_array) {
        for t in tools {
            if t.get("cache_control").is_some_and(|v| !v.is_null()) {
                total += 1;
            }
        }
    }
    if let Some(sys) = payload.get("system").and_then(serde_json::Value::as_array) {
        for s in sys {
            if s.get("cache_control").is_some_and(|v| !v.is_null()) {
                total += 1;
            }
        }
    }
    if let Some(msgs) = payload
        .get("messages")
        .and_then(serde_json::Value::as_array)
    {
        for m in msgs {
            if m.get("cache_control").is_some_and(|v| !v.is_null()) {
                total += 1;
            }
            if let Some(blocks) = m.get("content").and_then(serde_json::Value::as_array) {
                for b in blocks {
                    if b.get("cache_control").is_some_and(|v| !v.is_null()) {
                        total += 1;
                    }
                }
            }
        }
    }
    total
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum CcSlot {
    Tool(usize),
    SystemNonZero(usize),
    MessageTop(usize),
    MessageBlock(usize, usize),
}

/// 防坑规范 #2：
/// 1. 绝对不触碰 `system[0]`（保持首部指纹与原有 `cache_control` 100% 不变）；
/// 2. 将恒定 `pinned_system_tail` 追加至 `system[last]`；
/// 3. 将动态 `volatile_user_tail` 追加至最后一条 `user` / `tool_result` 消息末尾；
/// 4. 将全请求 `cache_control` 总数自动合并归拢至 `<= 4`。
fn inject_anthropic_messages_preserving_prefix_cache(
    raw_body: &[u8],
    ctx: &AssembledContext,
) -> Result<Vec<u8>> {
    let mut root: serde_json::Value =
        serde_json::from_slice(raw_body).map_err(|e| QuetzalcoatlError::SerializationError {
            detail: format!("解析 Anthropic /v1/messages JSON 失败: {e}"),
        })?;

    let Some(obj) = root.as_object_mut() else {
        return Err(QuetzalcoatlError::SerializationError {
            detail: String::from("Anthropic /v1/messages 请求体必须为 JSON 对象"),
        });
    };

    // 1. 追加会话恒定 PINNED 至 system[last]，绝不修改 system[0]
    if !ctx.pinned_system_tail.is_empty() {
        let pinned_block = serde_json::json!({
            "type": "text",
            "text": ctx.pinned_system_tail,
            "cache_control": {"type": "ephemeral"}
        });
        match obj.get_mut("system") {
            Some(serde_json::Value::Array(arr)) => {
                arr.push(pinned_block);
            }
            Some(serde_json::Value::String(existing_str)) => {
                let first_block = serde_json::json!({
                    "type": "text",
                    "text": existing_str.clone()
                });
                obj.insert(
                    String::from("system"),
                    serde_json::Value::Array(vec![first_block, pinned_block]),
                );
            }
            _ => {
                obj.insert(
                    String::from("system"),
                    serde_json::Value::Array(vec![pinned_block]),
                );
            }
        }
    }

    // 2. 将动态尾部注入最后一条 user 消息末尾（不触碰任何前序历史消息与 tool_result 块本身）
    if !ctx.volatile_user_tail.is_empty()
        && let Some(serde_json::Value::Array(msgs)) = obj.get_mut("messages")
        && let Some(last_user) = msgs
            .iter_mut()
            .rev()
            .find(|m| m.get("role").and_then(serde_json::Value::as_str) == Some("user"))
        && let Some(msg_obj) = last_user.as_object_mut()
    {
        match msg_obj.get_mut("content") {
            Some(serde_json::Value::Array(blocks)) => {
                blocks.push(serde_json::json!({
                    "type": "text",
                    "text": ctx.volatile_user_tail
                }));
            }
            Some(serde_json::Value::String(text)) => {
                let merged = if text.is_empty() {
                    ctx.volatile_user_tail.clone()
                } else {
                    format!("{text}\n{}", ctx.volatile_user_tail)
                };
                *text = merged;
            }
            _ => {
                msg_obj.insert(
                    String::from("content"),
                    serde_json::Value::String(ctx.volatile_user_tail.clone()),
                );
            }
        }
    }

    // 3. 归一化全请求 cache_control <= 4（且严禁改动 system[0]！）
    if count_anthropic_cache_controls(&root) > 4 {
        let system0_has_cc = root
            .get("system")
            .and_then(serde_json::Value::as_array)
            .and_then(|a| a.first())
            .and_then(|s0| s0.get("cache_control"))
            .is_some_and(|v| !v.is_null());

        let remaining_budget = if system0_has_cc { 3usize } else { 4usize };

        let mut tool_slots = Vec::<CcSlot>::new();
        if let Some(tools) = root.get("tools").and_then(serde_json::Value::as_array) {
            for (i, t) in tools.iter().enumerate() {
                if t.get("cache_control").is_some_and(|v| !v.is_null()) {
                    tool_slots.push(CcSlot::Tool(i));
                }
            }
        }

        let mut sys_slots = Vec::<CcSlot>::new();
        if let Some(sys) = root.get("system").and_then(serde_json::Value::as_array) {
            for (i, s) in sys.iter().enumerate().skip(1) {
                if s.get("cache_control").is_some_and(|v| !v.is_null()) {
                    sys_slots.push(CcSlot::SystemNonZero(i));
                }
            }
        }

        let mut msg_slots = Vec::<CcSlot>::new();
        if let Some(msgs) = root.get("messages").and_then(serde_json::Value::as_array) {
            for (mi, m) in msgs.iter().enumerate() {
                if m.get("cache_control").is_some_and(|v| !v.is_null()) {
                    msg_slots.push(CcSlot::MessageTop(mi));
                }
                if let Some(blocks) = m.get("content").and_then(serde_json::Value::as_array) {
                    for (bi, b) in blocks.iter().enumerate() {
                        if b.get("cache_control").is_some_and(|v| !v.is_null()) {
                            msg_slots.push(CcSlot::MessageBlock(mi, bi));
                        }
                    }
                }
            }
        }

        // 按累积前缀缓存收益挑选保留断点：system[last] -> tools[last] -> messages[last..]
        let mut keep = Vec::<CcSlot>::with_capacity(remaining_budget);
        if keep.len() < remaining_budget
            && let Some(&last_sys) = sys_slots.last()
        {
            keep.push(last_sys);
        }
        if keep.len() < remaining_budget
            && let Some(&last_tool) = tool_slots.last()
        {
            keep.push(last_tool);
        }
        for &ms in msg_slots.iter().rev() {
            if keep.len() >= remaining_budget {
                break;
            }
            if !keep.contains(&ms) {
                keep.push(ms);
            }
        }
        for &ss in sys_slots.iter().rev() {
            if keep.len() >= remaining_budget {
                break;
            }
            if !keep.contains(&ss) {
                keep.push(ss);
            }
        }
        for &ts in tool_slots.iter().rev() {
            if keep.len() >= remaining_budget {
                break;
            }
            if !keep.contains(&ts) {
                keep.push(ts);
            }
        }

        let all_candidates: Vec<CcSlot> = tool_slots
            .into_iter()
            .chain(sys_slots)
            .chain(msg_slots)
            .collect();
        for slot in all_candidates {
            if !keep.contains(&slot) {
                remove_cc_at_slot(&mut root, slot);
            }
        }
    }

    serde_json::to_vec(&root).map_err(|e| QuetzalcoatlError::SerializationError {
        detail: format!("序列化 Anthropic 请求体失败: {e}"),
    })
}

fn remove_cc_at_slot(root: &mut serde_json::Value, slot: CcSlot) {
    match slot {
        CcSlot::Tool(i) => {
            if let Some(obj) = root
                .get_mut("tools")
                .and_then(serde_json::Value::as_array_mut)
                .and_then(|a| a.get_mut(i))
                .and_then(serde_json::Value::as_object_mut)
            {
                obj.remove("cache_control");
            }
        }
        CcSlot::SystemNonZero(i) => {
            if i > 0
                && let Some(obj) = root
                    .get_mut("system")
                    .and_then(serde_json::Value::as_array_mut)
                    .and_then(|a| a.get_mut(i))
                    .and_then(serde_json::Value::as_object_mut)
            {
                obj.remove("cache_control");
            }
        }
        CcSlot::MessageTop(mi) => {
            if let Some(obj) = root
                .get_mut("messages")
                .and_then(serde_json::Value::as_array_mut)
                .and_then(|a| a.get_mut(mi))
                .and_then(serde_json::Value::as_object_mut)
            {
                obj.remove("cache_control");
            }
        }
        CcSlot::MessageBlock(mi, bi) => {
            if let Some(obj) = root
                .get_mut("messages")
                .and_then(serde_json::Value::as_array_mut)
                .and_then(|a| a.get_mut(mi))
                .and_then(|m| m.get_mut("content"))
                .and_then(serde_json::Value::as_array_mut)
                .and_then(|b| b.get_mut(bi))
                .and_then(serde_json::Value::as_object_mut)
            {
                obj.remove("cache_control");
            }
        }
    }
}

/// 保留原始字段顺序与未触碰字段逐字节字面量（含 `encrypted_content`）的有序 `RawValue` 映射。
struct OrderedRawObject(Vec<(String, Box<RawValue>)>);

impl Serialize for OrderedRawObject {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut map = serializer.serialize_map(Some(self.0.len()))?;
        for (k, v) in &self.0 {
            map.serialize_entry(k, v)?;
        }
        map.end()
    }
}

impl<'de> Deserialize<'de> for OrderedRawObject {
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct ObjVisitor;
        impl<'de> Visitor<'de> for ObjVisitor {
            type Value = OrderedRawObject;

            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("a JSON object preserving RawValue fields")
            }

            fn visit_map<A>(self, mut map: A) -> std::result::Result<Self::Value, A::Error>
            where
                A: MapAccess<'de>,
            {
                let mut entries = Vec::new();
                while let Some((k, v)) = map.next_entry::<String, Box<RawValue>>()? {
                    entries.push((k, v));
                }
                Ok(OrderedRawObject(entries))
            }
        }
        deserializer.deserialize_map(ObjVisitor)
    }
}

struct RawJsonSequence(Vec<Box<RawValue>>);

impl Serialize for RawJsonSequence {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut seq = serializer.serialize_seq(Some(self.0.len()))?;
        for item in &self.0 {
            seq.serialize_element(item)?;
        }
        seq.end()
    }
}

impl<'de> Deserialize<'de> for RawJsonSequence {
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct SeqVisitor;
        impl<'de> Visitor<'de> for SeqVisitor {
            type Value = RawJsonSequence;

            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("a JSON array of RawValue items")
            }

            fn visit_seq<A>(self, mut seq: A) -> std::result::Result<Self::Value, A::Error>
            where
                A: SeqAccess<'de>,
            {
                let mut items = Vec::new();
                while let Some(elem) = seq.next_element::<Box<RawValue>>()? {
                    items.push(elem);
                }
                Ok(RawJsonSequence(items))
            }
        }
        deserializer.deserialize_seq(SeqVisitor)
    }
}

fn to_boxed_raw_value<T: Serialize>(val: &T) -> Result<Box<RawValue>> {
    let s = serde_json::to_string(val).map_err(|e| QuetzalcoatlError::SerializationError {
        detail: format!("构造 RawValue 字符串失败: {e}"),
    })?;
    RawValue::from_string(s).map_err(|e| QuetzalcoatlError::SerializationError {
        detail: format!("转换 RawValue 失败: {e}"),
    })
}

/// 防坑规范 #3：在不触碰 `encrypted_content`（及 `input` 内任何推理项 `encrypted_content`）原始字节的前提下，
/// 为 Codex `/responses` 请求注入 `pinned_system_tail` 与 `volatile_user_tail`。
fn inject_codex_responses_raw_preserving(
    raw_body: &[u8],
    ctx: &AssembledContext,
) -> Result<Vec<u8>> {
    let body_str =
        std::str::from_utf8(raw_body).map_err(|e| QuetzalcoatlError::SerializationError {
            detail: format!("Codex /responses 请求体非合法 UTF-8: {e}"),
        })?;
    let mut top = serde_json::from_str::<OrderedRawObject>(body_str).map_err(|e| {
        QuetzalcoatlError::SerializationError {
            detail: format!("解析 Codex /responses 对象失败: {e}"),
        }
    })?;

    if !ctx.pinned_system_tail.is_empty() {
        let mut found_inst = false;
        for (k, raw_v) in &mut top.0 {
            if k == "instructions" {
                found_inst = true;
                let existing = serde_json::from_str::<Option<String>>(raw_v.get())
                    .ok()
                    .flatten()
                    .unwrap_or_default();
                let merged = if existing.is_empty() {
                    ctx.pinned_system_tail.clone()
                } else {
                    format!("{existing}\n{}", ctx.pinned_system_tail)
                };
                *raw_v = to_boxed_raw_value(&merged)?;
                break;
            }
        }
        if !found_inst {
            top.0.push((
                String::from("instructions"),
                to_boxed_raw_value(&ctx.pinned_system_tail)?,
            ));
        }
    }

    if !ctx.volatile_user_tail.is_empty() {
        for (k, raw_v) in &mut top.0 {
            if k == "input" {
                let raw_input_str = raw_v.get().trim_start();
                if raw_input_str.starts_with('"') {
                    if let Ok(s) = serde_json::from_str::<String>(raw_input_str) {
                        let merged = format!("{s}\n{}", ctx.volatile_user_tail);
                        *raw_v = to_boxed_raw_value(&merged)?;
                    }
                } else if raw_input_str.starts_with('[')
                    && let Ok(mut seq) = serde_json::from_str::<RawJsonSequence>(raw_input_str)
                {
                    // 仅改写最后一个 role == "user" 的输入项，所有 reasoning 项与 encrypted_content 保持原始 RawValue 字节！
                    let mut target_user_idx: Option<usize> = None;
                    for (idx, elem) in seq.0.iter().enumerate().rev() {
                        if let Ok(probe_obj) = serde_json::from_str::<OrderedRawObject>(elem.get())
                            && probe_obj.0.iter().any(|(fk, fv)| {
                                fk == "role"
                                    && serde_json::from_str::<String>(fv.get()).ok().as_deref()
                                        == Some("user")
                            })
                        {
                            target_user_idx = Some(idx);
                            break;
                        }
                    }

                    if let Some(u_idx) = target_user_idx {
                        let mut user_item =
                            serde_json::from_str::<OrderedRawObject>(seq.0[u_idx].get()).map_err(
                                |e| QuetzalcoatlError::SerializationError {
                                    detail: format!("解析 Codex user input 项失败: {e}"),
                                },
                            )?;
                        for (uk, uv) in &mut user_item.0 {
                            if uk == "content" {
                                let uv_trim = uv.get().trim_start();
                                if uv_trim.starts_with('"') {
                                    if let Ok(text) = serde_json::from_str::<String>(uv_trim) {
                                        let merged = format!("{text}\n{}", ctx.volatile_user_tail);
                                        *uv = to_boxed_raw_value(&merged)?;
                                    }
                                } else if uv_trim.starts_with('[')
                                    && let Ok(mut cseq) =
                                        serde_json::from_str::<RawJsonSequence>(uv_trim)
                                {
                                    let tail_block = serde_json::json!({
                                        "type": "input_text",
                                        "text": ctx.volatile_user_tail
                                    });
                                    cseq.0.push(to_boxed_raw_value(&tail_block)?);
                                    *uv = to_boxed_raw_value(&cseq)?;
                                }
                                break;
                            }
                        }
                        seq.0[u_idx] = to_boxed_raw_value(&user_item)?;
                    } else {
                        let appended = serde_json::json!({
                            "role": "user",
                            "content": ctx.volatile_user_tail
                        });
                        seq.0.push(to_boxed_raw_value(&appended)?);
                    }
                    *raw_v = to_boxed_raw_value(&seq)?;
                }
                break;
            }
        }
    }

    serde_json::to_vec(&top).map_err(|e| QuetzalcoatlError::SerializationError {
        detail: format!("序列化 Codex /responses 请求失败: {e}"),
    })
}

fn inject_openai_chat_completions(raw_body: &[u8], ctx: &AssembledContext) -> Result<Vec<u8>> {
    let mut root: serde_json::Value =
        serde_json::from_slice(raw_body).map_err(|e| QuetzalcoatlError::SerializationError {
            detail: format!("解析 OpenAI chat/completions 失败: {e}"),
        })?;
    if let Some(msgs) = root
        .get_mut("messages")
        .and_then(serde_json::Value::as_array_mut)
    {
        if !ctx.pinned_system_tail.is_empty() {
            msgs.push(serde_json::json!({
                "role": "system",
                "content": ctx.pinned_system_tail
            }));
        }
        if !ctx.volatile_user_tail.is_empty()
            && let Some(last_u) = msgs
                .iter_mut()
                .rev()
                .find(|m| m.get("role").and_then(serde_json::Value::as_str) == Some("user"))
            && let Some(serde_json::Value::String(s)) = last_u.get_mut("content")
        {
            *s = format!("{s}\n{}", ctx.volatile_user_tail);
        }
    }
    serde_json::to_vec(&root).map_err(|e| QuetzalcoatlError::SerializationError {
        detail: format!("序列化 OpenAI chat/completions 失败: {e}"),
    })
}

fn inject_gemini_generate_content(raw_body: &[u8], ctx: &AssembledContext) -> Result<Vec<u8>> {
    let mut root: serde_json::Value =
        serde_json::from_slice(raw_body).map_err(|e| QuetzalcoatlError::SerializationError {
            detail: format!("解析 Gemini generateContent 失败: {e}"),
        })?;
    if let Some(obj) = root.as_object_mut() {
        if !ctx.pinned_system_tail.is_empty() {
            match obj.get_mut("systemInstruction") {
                Some(si) => {
                    if let Some(parts) = si
                        .get_mut("parts")
                        .and_then(serde_json::Value::as_array_mut)
                    {
                        parts.push(serde_json::json!({"text": ctx.pinned_system_tail}));
                    }
                }
                None => {
                    obj.insert(
                        String::from("systemInstruction"),
                        serde_json::json!({"parts": [{"text": ctx.pinned_system_tail}]}),
                    );
                }
            }
        }
        if !ctx.volatile_user_tail.is_empty()
            && let Some(contents) = obj
                .get_mut("contents")
                .and_then(serde_json::Value::as_array_mut)
            && let Some(last_turn) = contents.last_mut()
            && let Some(parts) = last_turn
                .get_mut("parts")
                .and_then(serde_json::Value::as_array_mut)
        {
            parts.push(serde_json::json!({"text": ctx.volatile_user_tail}));
        }
    }
    serde_json::to_vec(&root).map_err(|e| QuetzalcoatlError::SerializationError {
        detail: format!("序列化 Gemini generateContent 失败: {e}"),
    })
}

fn strip_oauth_json_value(
    value: &mut serde_json::Value,
    ephemeral_stub_token: &str,
    extracted: &mut ExtractedOAuthCredentials,
    is_claude: bool,
) {
    match value {
        serde_json::Value::Object(map) => {
            // 先提取宿主真实令牌与 account_id 至受控内存
            for (k, v) in map.iter() {
                if let Some(s) = v.as_str()
                    && !s.trim().is_empty()
                {
                    if is_claude && (k == "accessToken" || k == "access_token") {
                        extracted.claude_access_token = Some(String::from(s));
                    } else if !is_claude
                        && (k == "access_token" || k == "accessToken" || k == "OPENAI_API_KEY")
                    {
                        extracted.codex_access_token = Some(String::from(s));
                    } else if !is_claude && (k == "account_id" || k == "accountId") {
                        extracted.codex_account_id = Some(String::from(s));
                    }
                }
            }

            // 彻底移除所有长期刷新密钥与身份令牌字段
            for sensitive_remove_key in [
                "refresh_token",
                "refreshToken",
                "id_token",
                "idToken",
                "client_secret",
                "clientSecret",
            ] {
                map.remove(sensitive_remove_key);
            }

            // 将短期访问令牌替换为仅回环网关认识的临时存根令牌
            for (k, v) in map.iter_mut() {
                if matches!(
                    k.as_str(),
                    "access_token"
                        | "accessToken"
                        | "api_key"
                        | "apiKey"
                        | "OPENAI_API_KEY"
                        | "ANTHROPIC_API_KEY"
                ) && v.is_string()
                {
                    *v = serde_json::Value::String(String::from(ephemeral_stub_token));
                } else {
                    strip_oauth_json_value(v, ephemeral_stub_token, extracted, is_claude);
                }
            }
        }
        serde_json::Value::Array(arr) => {
            for item in arr {
                strip_oauth_json_value(item, ephemeral_stub_token, extracted, is_claude);
            }
        }
        _ => {}
    }
}

fn write_mode_0600(path: &Path, bytes: &[u8]) -> Result<()> {
    fs::write(path, bytes).map_err(|e| QuetzalcoatlError::StorageError {
        detail: format!("写入凭据存根失败 ({}): {e}", path.display()),
    })?;
    #[cfg(unix)]
    {
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).map_err(|e| {
            QuetzalcoatlError::StorageError {
                detail: format!("设置凭据存根 0600 权限失败 ({}): {e}", path.display()),
            }
        })?;
    }
    Ok(())
}

fn copy_and_strip_cred_dir(
    host_dir: &Path,
    stub_dir: &Path,
    ephemeral_stub_token: &str,
    extracted: &mut ExtractedOAuthCredentials,
    is_claude: bool,
) -> Result<()> {
    if !host_dir.is_dir() {
        return Ok(());
    }
    let entries = fs::read_dir(host_dir).map_err(|e| QuetzalcoatlError::StorageError {
        detail: format!("遍历宿主凭据目录失败 ({}): {e}", host_dir.display()),
    })?;
    for entry_res in entries {
        let entry = entry_res.map_err(|e| QuetzalcoatlError::StorageError {
            detail: format!("读取凭据目录项失败: {e}"),
        })?;
        let ftype = entry
            .file_type()
            .map_err(|e| QuetzalcoatlError::StorageError {
                detail: format!("读取凭据文件类型失败: {e}"),
            })?;
        if !ftype.is_file() {
            continue;
        }
        let name_os = entry.file_name();
        let Some(name) = name_os.to_str() else {
            continue;
        };
        if !Path::new(name)
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("json"))
        {
            continue;
        }
        let raw = fs::read(entry.path()).map_err(|e| QuetzalcoatlError::StorageError {
            detail: format!("读取宿主凭据 JSON 失败 ({}): {e}", entry.path().display()),
        })?;
        if let Ok(mut parsed) = serde_json::from_slice::<serde_json::Value>(&raw) {
            strip_oauth_json_value(&mut parsed, ephemeral_stub_token, extracted, is_claude);
            let out_bytes = serde_json::to_vec_pretty(&parsed).map_err(|e| {
                QuetzalcoatlError::SerializationError {
                    detail: format!("序列化剥离后的凭据存根失败: {e}"),
                }
            })?;
            write_mode_0600(&stub_dir.join(name), &out_bytes)?;
        }
    }
    Ok(())
}

/// 防坑规范 #1：在沙箱外读取宿主 `~/.claude` 与 `~/.codex` 凭据，生成彻底剥离 `refresh_token` 且权限严格 `0600` 的临时存根目录。
pub fn prepare_stripped_oauth_stubs(
    host_claude_dir: Option<&Path>,
    host_codex_dir: Option<&Path>,
    stub_root_dir: &Path,
    ephemeral_stub_token: &str,
) -> Result<StrippedOAuthStubBundle> {
    let claude_config_dir = stub_root_dir.join("claude");
    let codex_home_dir = stub_root_dir.join("codex");
    for d in [&claude_config_dir, &codex_home_dir] {
        fs::create_dir_all(d).map_err(|e| QuetzalcoatlError::StorageError {
            detail: format!("创建 OAuth 临时存根目录失败 ({}): {e}", d.display()),
        })?;
        #[cfg(unix)]
        {
            fs::set_permissions(d, fs::Permissions::from_mode(0o700)).map_err(|e| {
                QuetzalcoatlError::StorageError {
                    detail: format!("设置 OAuth 存根目录 0700 权限失败: {e}"),
                }
            })?;
        }
    }

    let mut extracted = ExtractedOAuthCredentials::default();
    if let Some(hc) = host_claude_dir {
        copy_and_strip_cred_dir(
            hc,
            &claude_config_dir,
            ephemeral_stub_token,
            &mut extracted,
            true,
        )?;
    }
    if let Some(hx) = host_codex_dir {
        copy_and_strip_cred_dir(
            hx,
            &codex_home_dir,
            ephemeral_stub_token,
            &mut extracted,
            false,
        )?;
    }

    Ok(StrippedOAuthStubBundle {
        claude_config_dir,
        codex_home_dir,
        ephemeral_stub_token: String::from(ephemeral_stub_token),
        extracted,
    })
}

/// 防坑规范 #4：生成 Gemini CLI 所需的双环境变量（自动剥离尾部 `/v1` 后缀）。
#[must_use]
pub fn gemini_cli_env(run_base_url: &str, qz_token: &str) -> BTreeMap<String, String> {
    let trimmed = run_base_url.trim().trim_end_matches('/');
    let without_v1 = trimmed.strip_suffix("/v1").unwrap_or(trimmed);
    let mut env = BTreeMap::new();
    env.insert(
        String::from("CODE_ASSIST_ENDPOINT"),
        String::from(without_v1),
    );
    env.insert(
        String::from("GOOGLE_GEMINI_BASE_URL"),
        String::from(without_v1),
    );
    env.insert(
        String::from("GEMINI_API_KEY"),
        format!("qz-session:{qz_token}"),
    );
    env
}

struct WireHttpRequest {
    method: String,
    target: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

struct WireHttpResponse {
    status: u16,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

fn gateway_json_error(status: u16, code: &str, detail: &str) -> WireHttpResponse {
    let body = serde_json::to_vec(&serde_json::json!({
        "code": code,
        "detail": detail,
    }))
    .unwrap_or_else(|_| b"{\"error\":true}".to_vec());
    WireHttpResponse {
        status,
        headers: vec![
            (
                String::from("Content-Type"),
                String::from("application/json"),
            ),
            (String::from("Content-Length"), body.len().to_string()),
        ],
        body,
    }
}

fn read_wire_http_request<R: Read>(stream: &mut R) -> Result<WireHttpRequest> {
    let mut buf = Vec::with_capacity(2048);
    let mut chunk = [0u8; 4096];
    let header_end = loop {
        if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break pos;
        }
        if buf.len() > MAX_GATEWAY_HEADER_BYTES {
            return Err(QuetzalcoatlError::CredentialRejected {
                detail: String::from("HTTP 请求头超过 64KiB 上限"),
            });
        }
        let n = stream
            .read(&mut chunk)
            .map_err(|e| QuetzalcoatlError::StorageError {
                detail: format!("读取网关请求失败: {e}"),
            })?;
        if n == 0 {
            return Err(QuetzalcoatlError::CredentialRejected {
                detail: String::from("客户端在发送完整请求头前关闭连接"),
            });
        }
        buf.extend_from_slice(&chunk[..n]);
    };

    let head_str = std::str::from_utf8(&buf[..header_end]).map_err(|_| {
        QuetzalcoatlError::CredentialRejected {
            detail: String::from("HTTP 请求头不是合法 UTF-8"),
        }
    })?;
    let mut lines = head_str.split("\r\n");
    let req_line = lines
        .next()
        .ok_or_else(|| QuetzalcoatlError::CredentialRejected {
            detail: String::from("缺少 HTTP 请求行"),
        })?;
    let mut parts = req_line.split_whitespace();
    let method = parts
        .next()
        .ok_or_else(|| QuetzalcoatlError::CredentialRejected {
            detail: String::from("缺少 HTTP 方法"),
        })?;
    let target = parts
        .next()
        .ok_or_else(|| QuetzalcoatlError::CredentialRejected {
            detail: String::from("缺少 HTTP 请求路径"),
        })?;

    let mut headers = Vec::new();
    let mut content_len = 0usize;
    for line in lines {
        if let Some((k, v)) = line.split_once(':') {
            let name = k.trim();
            let val = v.trim();
            if name.eq_ignore_ascii_case("content-length") {
                content_len =
                    val.parse::<usize>()
                        .map_err(|_| QuetzalcoatlError::CredentialRejected {
                            detail: String::from("Content-Length 非法"),
                        })?;
                if content_len > MAX_GATEWAY_BODY_BYTES {
                    return Err(QuetzalcoatlError::CredentialRejected {
                        detail: String::from("HTTP 请求体超过 16MiB 上限"),
                    });
                }
            }
            headers.push((String::from(name), String::from(val)));
        }
    }

    let body_start = header_end + 4;
    let mut body = Vec::with_capacity(content_len);
    if buf.len() > body_start {
        let take = (buf.len() - body_start).min(content_len);
        body.extend_from_slice(&buf[body_start..body_start + take]);
    }
    while body.len() < content_len {
        let want = (content_len - body.len()).min(chunk.len());
        let n = stream
            .read(&mut chunk[..want])
            .map_err(|e| QuetzalcoatlError::StorageError {
                detail: format!("读取网关请求体失败: {e}"),
            })?;
        if n == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..n]);
    }

    Ok(WireHttpRequest {
        method: String::from(method),
        target: String::from(target),
        headers,
        body,
    })
}

fn reason_phrase(status: u16) -> &'static str {
    match status {
        200 => "OK",
        201 => "Created",
        204 => "No Content",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        426 => "Upgrade Required",
        500 => "Internal Server Error",
        502 => "Bad Gateway",
        _ => "Response",
    }
}

fn write_wire_http_response<W: Write>(stream: &mut W, resp: &WireHttpResponse) {
    let mut wire = Vec::with_capacity(256 + resp.body.len());
    wire.extend_from_slice(
        format!(
            "HTTP/1.1 {} {}\r\n",
            resp.status,
            reason_phrase(resp.status)
        )
        .as_bytes(),
    );
    wire.extend_from_slice(b"Connection: close\r\n");
    for (k, v) in &resp.headers {
        if !k.contains('\r') && !k.contains('\n') && !v.contains('\r') && !v.contains('\n') {
            wire.extend_from_slice(format!("{k}: {v}\r\n").as_bytes());
        }
    }
    wire.extend_from_slice(b"\r\n");
    wire.extend_from_slice(&resp.body);
    let _ = stream.write_all(&wire);
    let _ = stream.flush();
}
