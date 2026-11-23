#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]

//! `CredentialBroker` — 零凭据代理（256-bit 能力令牌常量时间校验、严格源/路径白名单与响应明文/Base64 双重脱敏）。

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream, ToSocketAddrs};
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
#[cfg(unix)]
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use quetzalcoatl_crypto::hex_encode;
use quetzalcoatl_types::{QuetzalcoatlError, Result};
use rand_core::{OsRng, RngCore};
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use zeroize::{Zeroize, ZeroizeOnDrop};

use crate::constant_time_eq_32;

const B64_STD_ALPHABET: &[u8; 64] =
    b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_URL_ALPHABET: &[u8; 64] =
    b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

const REDACTED_MARKER: &[u8] = b"[REDACTED]";
const INTERNAL_JSON_PROXY_PATH: &str = "/__qz_broker/v1/proxy";
const MAX_HTTP_HEADER_BYTES: usize = 64 * 1024;
const MAX_HTTP_BODY_BYTES: usize = 16 * 1024 * 1024;
const MAX_CONCURRENT_IPC_CONNS: usize = 64;

fn encode_base64_with_alphabet(bytes: &[u8], alphabet: &[u8; 64], pad: bool) -> String {
    if bytes.is_empty() {
        return String::new();
    }
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    let mut idx = 0usize;
    while idx + 3 <= bytes.len() {
        let b0 = bytes[idx];
        let b1 = bytes[idx + 1];
        let b2 = bytes[idx + 2];
        out.push(char::from(alphabet[usize::from(b0 >> 2)]));
        out.push(char::from(
            alphabet[usize::from(((b0 & 0x03) << 4) | (b1 >> 4))],
        ));
        out.push(char::from(
            alphabet[usize::from(((b1 & 0x0f) << 2) | (b2 >> 6))],
        ));
        out.push(char::from(alphabet[usize::from(b2 & 0x3f)]));
        idx += 3;
    }
    let rem = bytes.len() - idx;
    if rem == 1 {
        let b0 = bytes[idx];
        out.push(char::from(alphabet[usize::from(b0 >> 2)]));
        out.push(char::from(alphabet[usize::from((b0 & 0x03) << 4)]));
        if pad {
            out.push_str("==");
        }
    } else if rem == 2 {
        let b0 = bytes[idx];
        let b1 = bytes[idx + 1];
        out.push(char::from(alphabet[usize::from(b0 >> 2)]));
        out.push(char::from(
            alphabet[usize::from(((b0 & 0x03) << 4) | (b1 >> 4))],
        ));
        out.push(char::from(alphabet[usize::from((b1 & 0x0f) << 2)]));
        if pad {
            out.push('=');
        }
    }
    out
}

/// 标准 RFC 4648 Base64 编码（含 `=` 填充）。
#[must_use]
pub fn encode_base64_standard(bytes: &[u8]) -> String {
    encode_base64_with_alphabet(bytes, B64_STD_ALPHABET, true)
}

/// URL-safe RFC 4648 §5 无填充 Base64 编码。
#[must_use]
pub fn encode_base64_urlsafe_unpadded(bytes: &[u8]) -> String {
    encode_base64_with_alphabet(bytes, B64_URL_ALPHABET, false)
}

/// 允许携带指定密钥访问的上游 `(scheme, host, port, path_prefix)` 规则。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct OriginPathRule {
    pub scheme: String,
    pub host: String,
    pub port: u16,
    pub path_prefix: String,
}

impl OriginPathRule {
    pub fn new(
        scheme: impl Into<String>,
        host: impl Into<String>,
        port: u16,
        path_prefix: impl Into<String>,
    ) -> Result<Self> {
        let norm_scheme = scheme.into().trim().to_ascii_lowercase();
        if norm_scheme != "http" && norm_scheme != "https" {
            return Err(QuetzalcoatlError::CredentialRejected {
                detail: format!("白名单仅支持 http 或 https 协议，实际为: {norm_scheme}"),
            });
        }
        let norm_host = host.into().trim().to_ascii_lowercase();
        if norm_host.is_empty()
            || norm_host.contains('@')
            || norm_host.contains('/')
            || norm_host.contains('?')
            || norm_host.contains('#')
            || norm_host.contains('\\')
            || norm_host.bytes().any(|b| b <= 0x20 || b == 0x7f)
        {
            return Err(QuetzalcoatlError::CredentialRejected {
                detail: format!("非法的白名单主机名: {norm_host}"),
            });
        }
        if port == 0 {
            return Err(QuetzalcoatlError::CredentialRejected {
                detail: String::from("白名单端口号不能为 0"),
            });
        }
        let pfx = path_prefix.into();
        validate_clean_url_path(&pfx)?;
        Ok(Self {
            scheme: norm_scheme,
            host: norm_host,
            port,
            path_prefix: pfx,
        })
    }
}

/// 凭据注入上游请求头的方式。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SecretInjection {
    BearerHeader,
    CustomHeader {
        header_name: String,
        value_prefix: Option<String>,
    },
}

/// 向宿主侧 `CredentialBroker` 注册作用域密钥的参数。
#[derive(Clone, Debug)]
pub struct ScopedSecretRegistration {
    pub secret_value: String,
    pub allowed_origins: Vec<OriginPathRule>,
    pub injection: SecretInjection,
}

/// 返回给沙箱侧的不透明代理能力授权（绝不包含真实密钥明文）。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScopedSecretGrant {
    pub grant_id: Uuid,
    pub capability_token: String,
    pub allowed_origins: Vec<OriginPathRule>,
}

/// `CredentialBroker` 跨平台 IPC 监听端点。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "address", rename_all = "snake_case")]
pub enum BrokerEndpoint {
    UnixSocket(PathBuf),
    LoopbackTcp(SocketAddr),
    NamedPipe(String),
}

/// 沙箱客户端发往 `CredentialBroker` 的结构化代理请求。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct BrokerProxyRequest {
    pub capability_token: String,
    pub method: String,
    pub target_url: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

/// `CredentialBroker` 脱敏后返回给沙箱客户端的代理响应。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct BrokerProxyResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl BrokerProxyResponse {
    #[must_use]
    pub fn body_lossy(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }
}

/// 经校验并注入真实凭据后的上游出站请求。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UpstreamRequest {
    pub method: String,
    pub scheme: String,
    pub host: String,
    pub port: u16,
    pub path_and_query: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

/// 上游原始响应（在返回沙箱前必须经过 `CredentialBroker` 脱敏）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UpstreamResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

/// 可插拔上游 HTTP/HTTPS 传输层抽象（默认使用不自动跟随重定向的原生 TCP HTTP/1.1 传输）。
pub trait UpstreamTransport: Send + Sync {
    fn roundtrip(&self, request: &UpstreamRequest) -> Result<UpstreamResponse>;
}

/// 原生同步 TCP HTTP/1.1 上游传输器（严格禁止自动跟随重定向，防止 302 跨源泄露凭据）。
pub struct StdHttpTransport;

impl UpstreamTransport for StdHttpTransport {
    fn roundtrip(&self, request: &UpstreamRequest) -> Result<UpstreamResponse> {
        if request.scheme != "http" {
            return Err(QuetzalcoatlError::CredentialRejected {
                detail: format!(
                    "默认 StdHttpTransport 仅支持明文回环/内网 http 传输，{} 需注入 TLS UpstreamTransport",
                    request.scheme
                ),
            });
        }

        let addr_spec = format!("{}:{}", request.host, request.port);
        let mut addrs =
            addr_spec
                .to_socket_addrs()
                .map_err(|e| QuetzalcoatlError::CredentialRejected {
                    detail: format!("解析上游地址失败 ({addr_spec}): {e}"),
                })?;
        let sock_addr = addrs
            .next()
            .ok_or_else(|| QuetzalcoatlError::CredentialRejected {
                detail: format!("上游地址无可用套接字记录: {addr_spec}"),
            })?;

        let mut stream =
            TcpStream::connect_timeout(&sock_addr, Duration::from_secs(5)).map_err(|e| {
                QuetzalcoatlError::StorageError {
                    detail: format!("连接上游 {sock_addr} 失败: {e}"),
                }
            })?;
        let _ = stream.set_read_timeout(Some(Duration::from_secs(15)));
        let _ = stream.set_write_timeout(Some(Duration::from_secs(15)));

        let mut wire = Vec::with_capacity(512 + request.body.len());
        let host_hdr = if (request.scheme == "http" && request.port == 80)
            || (request.scheme == "https" && request.port == 443)
        {
            request.host.clone()
        } else {
            format!("{}:{}", request.host, request.port)
        };
        wire.extend_from_slice(
            format!("{} {} HTTP/1.1\r\n", request.method, request.path_and_query).as_bytes(),
        );
        wire.extend_from_slice(format!("Host: {host_hdr}\r\n").as_bytes());
        wire.extend_from_slice(b"Connection: close\r\n");
        for (name, val) in &request.headers {
            if name.eq_ignore_ascii_case("host")
                || name.eq_ignore_ascii_case("connection")
                || name.eq_ignore_ascii_case("content-length")
                || name.eq_ignore_ascii_case("transfer-encoding")
            {
                continue;
            }
            if !name.contains('\r')
                && !name.contains('\n')
                && !val.contains('\r')
                && !val.contains('\n')
            {
                wire.extend_from_slice(format!("{name}: {val}\r\n").as_bytes());
            }
        }
        if !request.body.is_empty()
            || request.method.eq_ignore_ascii_case("POST")
            || request.method.eq_ignore_ascii_case("PUT")
            || request.method.eq_ignore_ascii_case("PATCH")
        {
            wire.extend_from_slice(
                format!("Content-Length: {}\r\n", request.body.len()).as_bytes(),
            );
        }
        wire.extend_from_slice(b"\r\n");
        wire.extend_from_slice(&request.body);

        stream
            .write_all(&wire)
            .map_err(|e| QuetzalcoatlError::StorageError {
                detail: format!("向上游发送请求失败: {e}"),
            })?;

        read_http_response_from_stream(&mut stream)
    }
}

#[derive(Zeroize, ZeroizeOnDrop)]
struct SecretRecord {
    token_bytes: [u8; 32],
    secret_plain: String,
    redaction_needles: Vec<Vec<u8>>,
    #[zeroize(skip)]
    grant_id: Uuid,
    #[zeroize(skip)]
    allowed_origins: Vec<OriginPathRule>,
    #[zeroize(skip)]
    injection: SecretInjection,
}

struct BrokerInner {
    grants: Mutex<Vec<SecretRecord>>,
    transport: Arc<dyn UpstreamTransport>,
}

/// 宿主内存零凭据代理。
#[derive(Clone)]
pub struct CredentialBroker {
    inner: Arc<BrokerInner>,
}

impl Default for CredentialBroker {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct ParsedTargetUrl {
    scheme: String,
    host: String,
    port: u16,
    path: String,
    path_and_query: String,
}

const fn decode_hex_nibble(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

fn percent_decode_segment(seg: &str) -> Result<String> {
    let bytes = seg.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if i + 2 >= bytes.len() {
                return Err(QuetzalcoatlError::CredentialRejected {
                    detail: String::from("URL 路径包含截断的百分号编码"),
                });
            }
            let hi = decode_hex_nibble(bytes[i + 1]).ok_or_else(|| {
                QuetzalcoatlError::CredentialRejected {
                    detail: String::from("URL 路径包含非法百分号十六进制字符"),
                }
            })?;
            let lo = decode_hex_nibble(bytes[i + 2]).ok_or_else(|| {
                QuetzalcoatlError::CredentialRejected {
                    detail: String::from("URL 路径包含非法百分号十六进制字符"),
                }
            })?;
            let decoded = (hi << 4) | lo;
            // 严禁编码 NUL、编码斜杠 %2f 或编码反斜杠 %5c 引发代理与上游路由解析歧义
            if decoded == 0 || decoded == b'/' || decoded == b'\\' {
                return Err(QuetzalcoatlError::CredentialRejected {
                    detail: String::from("URL 路径禁止编码斜杠或 NUL 字节"),
                });
            }
            out.push(decoded);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|_| QuetzalcoatlError::CredentialRejected {
        detail: String::from("URL 路径解码后不是合法 UTF-8"),
    })
}

fn validate_clean_url_path(path: &str) -> Result<()> {
    if !path.starts_with('/') {
        return Err(QuetzalcoatlError::CredentialRejected {
            detail: format!("URL 路径必须以 '/' 开头: {path}"),
        });
    }
    if path.contains('\\')
        || path.contains('?')
        || path.contains('#')
        || path.bytes().any(|b| b <= 0x20 || b == 0x7f)
    {
        return Err(QuetzalcoatlError::CredentialRejected {
            detail: format!("URL 路径包含非法控制字符或分隔符: {path}"),
        });
    }
    for seg in path.split('/').skip(1) {
        let decoded = percent_decode_segment(seg)?;
        if decoded == "."
            || decoded == ".."
            || decoded.starts_with("..;")
            || decoded.starts_with(".;")
        {
            return Err(QuetzalcoatlError::CredentialRejected {
                detail: format!("检测到禁止的 URL 路径穿越段: {seg}"),
            });
        }
    }
    Ok(())
}

fn parse_target_url(raw_url: &str) -> Result<ParsedTargetUrl> {
    let trimmed = raw_url.trim();
    if trimmed.is_empty()
        || trimmed.contains('\\')
        || trimmed.contains('#')
        || trimmed.bytes().any(|b| b <= 0x20 || b == 0x7f)
    {
        return Err(QuetzalcoatlError::CredentialRejected {
            detail: String::from("目标 URL 为空或包含非法控制字符/反斜杠/片段标识符"),
        });
    }

    let (scheme_raw, after_scheme) =
        trimmed
            .split_once("://")
            .ok_or_else(|| QuetzalcoatlError::CredentialRejected {
                detail: String::from("目标 URL 缺少 scheme://"),
            })?;
    let scheme = scheme_raw.to_ascii_lowercase();
    if scheme != "http" && scheme != "https" {
        return Err(QuetzalcoatlError::CredentialRejected {
            detail: format!("不支持的 URL 协议: {scheme}"),
        });
    }

    let (authority, path_and_query) = match after_scheme.find('/') {
        Some(slash_idx) => (
            &after_scheme[..slash_idx],
            String::from(&after_scheme[slash_idx..]),
        ),
        None => (after_scheme, String::from("/")),
    };

    if authority.is_empty() || authority.contains('@') || authority.contains('?') {
        return Err(QuetzalcoatlError::CredentialRejected {
            detail: String::from("目标 URL authority 为空或包含禁止的 userinfo (@)"),
        });
    }

    let default_port = if scheme == "https" { 443 } else { 80 };
    let (host, port) = if let Some(rest) = authority.strip_prefix('[') {
        let (ipv6_host, after_bracket) =
            rest.split_once(']')
                .ok_or_else(|| QuetzalcoatlError::CredentialRejected {
                    detail: String::from("IPv6 主机名缺少闭合 ']'"),
                })?;
        let parsed_port = if let Some(port_str) = after_bracket.strip_prefix(':') {
            port_str
                .parse::<u16>()
                .map_err(|_| QuetzalcoatlError::CredentialRejected {
                    detail: String::from("IPv6 URL 端口号非法"),
                })?
        } else if after_bracket.is_empty() {
            default_port
        } else {
            return Err(QuetzalcoatlError::CredentialRejected {
                detail: String::from("IPv6 authority 语法非法"),
            });
        };
        (format!("[{}]", ipv6_host.to_ascii_lowercase()), parsed_port)
    } else if let Some((h, p_str)) = authority.rsplit_once(':') {
        let parsed_port =
            p_str
                .parse::<u16>()
                .map_err(|_| QuetzalcoatlError::CredentialRejected {
                    detail: String::from("URL 端口号非法"),
                })?;
        (h.to_ascii_lowercase(), parsed_port)
    } else {
        (authority.to_ascii_lowercase(), default_port)
    };

    if host.is_empty() || port == 0 {
        return Err(QuetzalcoatlError::CredentialRejected {
            detail: String::from("目标主机为空或端口为 0"),
        });
    }

    let path_only = match path_and_query.split_once('?') {
        Some((p, _q)) => p,
        None => path_and_query.as_str(),
    };
    validate_clean_url_path(path_only)?;

    Ok(ParsedTargetUrl {
        scheme,
        host,
        port,
        path: String::from(path_only),
        path_and_query,
    })
}

fn path_matches_prefix(path: &str, rule_prefix: &str) -> bool {
    if rule_prefix == "/" {
        return path.starts_with('/');
    }
    let clean_prefix = rule_prefix.trim_end_matches('/');
    if path == clean_prefix {
        return true;
    }
    path.starts_with(clean_prefix) && path.as_bytes().get(clean_prefix.len()) == Some(&b'/')
}

fn url_allowed_by_rules(parsed: &ParsedTargetUrl, rules: &[OriginPathRule]) -> bool {
    rules.iter().any(|rule| {
        rule.scheme == parsed.scheme
            && rule.host == parsed.host
            && rule.port == parsed.port
            && path_matches_prefix(&parsed.path, &rule.path_prefix)
    })
}

fn build_redaction_needles(secret: &str) -> Vec<Vec<u8>> {
    let raw = secret.as_bytes();
    if raw.is_empty() {
        return Vec::new();
    }
    let mut candidates = vec![
        raw.to_vec(),
        encode_base64_with_alphabet(raw, B64_STD_ALPHABET, true).into_bytes(),
        encode_base64_with_alphabet(raw, B64_STD_ALPHABET, false).into_bytes(),
        encode_base64_with_alphabet(raw, B64_URL_ALPHABET, true).into_bytes(),
        encode_base64_with_alphabet(raw, B64_URL_ALPHABET, false).into_bytes(),
    ];
    candidates.retain(|c| !c.is_empty());
    // 按长度降序排列并去重，确保先替换带 '=' 填充的完整 Base64，不残留尾部填充符
    candidates.sort_by(|a, b| b.len().cmp(&a.len()).then_with(|| a.cmp(b)));
    candidates.dedup();
    candidates
}

fn scrub_bytes_with_needles(input: &[u8], needles: &[Vec<u8>]) -> Vec<u8> {
    let mut current = input.to_vec();
    for needle in needles {
        if needle.is_empty() || current.len() < needle.len() {
            continue;
        }
        let mut next = Vec::with_capacity(current.len());
        let mut i = 0usize;
        while i < current.len() {
            if i + needle.len() <= current.len()
                && &current[i..i + needle.len()] == needle.as_slice()
            {
                next.extend_from_slice(REDACTED_MARKER);
                i += needle.len();
            } else {
                next.push(current[i]);
                i += 1;
            }
        }
        current = next;
    }
    current
}

fn decode_cap_token_constant_shape(token_str: &str) -> ([u8; 32], bool) {
    let trimmed = token_str.trim();
    let raw = trimmed.as_bytes();
    if raw.len() != 64 {
        return ([0u8; 32], false);
    }
    let mut out = [0u8; 32];
    let mut ok = true;
    for (idx, slot) in out.iter_mut().enumerate() {
        let hi = decode_hex_nibble(raw[idx * 2]);
        let lo = decode_hex_nibble(raw[idx * 2 + 1]);
        match (hi, lo) {
            (Some(h), Some(l)) => *slot = (h << 4) | l,
            _ => {
                *slot = 0;
                ok = false;
            }
        }
    }
    (out, ok)
}

impl CredentialBroker {
    #[must_use]
    pub fn new() -> Self {
        Self::with_transport(Arc::new(StdHttpTransport))
    }

    #[must_use]
    pub fn with_transport(transport: Arc<dyn UpstreamTransport>) -> Self {
        Self {
            inner: Arc::new(BrokerInner {
                grants: Mutex::new(Vec::new()),
                transport,
            }),
        }
    }

    /// 在宿主内存注册作用域密钥，生成 256-bit 随机能力令牌，仅向沙箱侧暴露不透明授权句柄。
    pub fn register_scoped_secret(
        &self,
        registration: ScopedSecretRegistration,
    ) -> Result<ScopedSecretGrant> {
        if registration.secret_value.is_empty() {
            return Err(QuetzalcoatlError::CredentialRejected {
                detail: String::from("注册的作用域密钥不能为空"),
            });
        }
        if registration.allowed_origins.is_empty() {
            return Err(QuetzalcoatlError::CredentialRejected {
                detail: String::from("作用域密钥至少需要一条 OriginPathRule 白名单"),
            });
        }
        let mut normalized_rules = Vec::with_capacity(registration.allowed_origins.len());
        for rule in &registration.allowed_origins {
            normalized_rules.push(OriginPathRule::new(
                rule.scheme.clone(),
                rule.host.clone(),
                rule.port,
                rule.path_prefix.clone(),
            )?);
        }

        if let SecretInjection::CustomHeader { header_name, .. } = &registration.injection
            && (header_name.trim().is_empty()
                || header_name.contains('\r')
                || header_name.contains('\n')
                || header_name.contains(':'))
        {
            return Err(QuetzalcoatlError::CredentialRejected {
                detail: String::from("自定义凭据请求头名称非法"),
            });
        }

        let mut token_bytes = [0u8; 32];
        OsRng.fill_bytes(&mut token_bytes);
        let capability_token = hex_encode(&token_bytes);
        let grant_id = Uuid::new_v4();
        let needles = build_redaction_needles(&registration.secret_value);

        let record = SecretRecord {
            token_bytes,
            secret_plain: registration.secret_value,
            redaction_needles: needles,
            grant_id,
            allowed_origins: normalized_rules.clone(),
            injection: registration.injection,
        };

        let mut guard =
            self.inner
                .grants
                .lock()
                .map_err(|_| QuetzalcoatlError::CredentialRejected {
                    detail: String::from("CredentialBroker 内部锁异常"),
                })?;
        guard.push(record);

        Ok(ScopedSecretGrant {
            grant_id,
            capability_token,
            allowed_origins: normalized_rules,
        })
    }

    /// 立即吊销指定授权并触发内存中密钥与编码样本的 `ZeroizeOnDrop` 擦除。
    pub fn revoke_grant(&self, grant_id: Uuid) -> bool {
        let Ok(mut guard) = self.inner.grants.lock() else {
            return false;
        };
        let before = guard.len();
        guard.retain(|g| g.grant_id != grant_id);
        guard.len() < before
    }

    /// 处理单次代理请求（常量时间鉴权 -> 源/路径严格校验 -> 注入凭据 -> 跨源重定向拦截 -> 响应脱敏）。
    #[must_use]
    pub fn handle_proxy_request(&self, req: &BrokerProxyRequest) -> BrokerProxyResponse {
        let (candidate_tok, tok_syntax_ok) = decode_cap_token_constant_shape(&req.capability_token);

        // 在单次锁持有内执行全表常量时间匹配，并收集所有脱敏特征串，且不把明文密钥带出受控作用域
        let matched = {
            let Ok(guard) = self.inner.grants.lock() else {
                return json_error_response(500, "INTERNAL_LOCK_ERROR", "broker lock poisoned");
            };
            let mut matched_idx: Option<usize> = None;
            for (idx, rec) in guard.iter().enumerate() {
                let eq = constant_time_eq_32(&candidate_tok, &rec.token_bytes);
                if tok_syntax_ok && eq {
                    matched_idx = Some(idx);
                }
            }
            let Some(idx) = matched_idx else {
                return json_error_response(
                    401,
                    "CREDENTIAL_REJECTED",
                    "无效或未授权的代理能力令牌",
                );
            };

            let mut all_needles = Vec::<Vec<u8>>::new();
            for rec in guard.iter() {
                all_needles.extend(rec.redaction_needles.iter().cloned());
            }
            all_needles.sort_by(|a, b| b.len().cmp(&a.len()).then_with(|| a.cmp(b)));
            all_needles.dedup();

            let rec = &guard[idx];
            let (inj_header_name, inj_header_val) = match &rec.injection {
                SecretInjection::BearerHeader => (
                    String::from("Authorization"),
                    format!("Bearer {}", rec.secret_plain),
                ),
                SecretInjection::CustomHeader {
                    header_name,
                    value_prefix,
                } => {
                    let val = match value_prefix {
                        Some(pfx) => format!("{pfx}{}", rec.secret_plain),
                        None => rec.secret_plain.clone(),
                    };
                    (header_name.clone(), val)
                }
            };
            (
                rec.allowed_origins.clone(),
                inj_header_name,
                zeroize::Zeroizing::new(inj_header_val),
                all_needles,
            )
        };

        let (allowed_origins, inj_header_name, inj_header_val, all_needles) = matched;

        let parsed_url = match parse_target_url(&req.target_url) {
            Ok(u) => u,
            Err(err) => {
                return json_error_response(403, err.code().as_str(), &err.to_string());
            }
        };

        if !url_allowed_by_rules(&parsed_url, &allowed_origins) {
            return json_error_response(
                403,
                "CREDENTIAL_REJECTED",
                "目标源或路径不在该能力令牌的白名单内",
            );
        }

        // 过滤调用方伪造的凭据头与内部控制头，注入真实宿主凭据
        let mut outbound_headers = Vec::with_capacity(req.headers.len() + 1);
        for (k, v) in &req.headers {
            let lower = k.to_ascii_lowercase();
            if lower.starts_with("x-qz-")
                || lower.starts_with("x-quetzalcoatl-")
                || lower.starts_with("proxy-")
                || k.eq_ignore_ascii_case(&inj_header_name)
                || k.eq_ignore_ascii_case("authorization")
            {
                continue;
            }
            outbound_headers.push((k.clone(), v.clone()));
        }
        outbound_headers.push((inj_header_name, (*inj_header_val).clone()));

        let upstream_req = UpstreamRequest {
            method: if req.method.trim().is_empty() {
                String::from("GET")
            } else {
                req.method.trim().to_ascii_uppercase()
            },
            scheme: parsed_url.scheme,
            host: parsed_url.host,
            port: parsed_url.port,
            path_and_query: parsed_url.path_and_query,
            headers: outbound_headers,
            body: req.body.clone(),
        };

        let upstream_resp = match self.inner.transport.roundtrip(&upstream_req) {
            Ok(r) => r,
            Err(err) => {
                let status = if err.code() == quetzalcoatl_types::ErrorCode::CredentialRejected {
                    403
                } else {
                    502
                };
                let scrubbed_msg =
                    scrub_bytes_with_needles(err.to_string().as_bytes(), &all_needles);
                return json_error_response(
                    status,
                    err.code().as_str(),
                    &String::from_utf8_lossy(&scrubbed_msg),
                );
            }
        };

        // 拦截指向非白名单源的 3xx 重定向响应，防止下游客户端跟随跨源重定向
        if matches!(upstream_resp.status, 301 | 302 | 303 | 307 | 308) {
            for (k, v) in &upstream_resp.headers {
                if k.eq_ignore_ascii_case("location") {
                    let allowed_redirect = parse_target_url(v)
                        .map(|u| url_allowed_by_rules(&u, &allowed_origins))
                        .unwrap_or(false);
                    if !allowed_redirect {
                        return json_error_response(
                            403,
                            "CREDENTIAL_REJECTED",
                            "已阻断上游指向非白名单源的 HTTP 重定向",
                        );
                    }
                }
            }
        }

        // 对响应头与响应体执行明文 + 标准 Base64 + URL-safe 无填充 Base64 全量脱敏
        let scrubbed_body = scrub_bytes_with_needles(&upstream_resp.body, &all_needles);
        let mut scrubbed_headers = Vec::with_capacity(upstream_resp.headers.len() + 1);
        for (k, v) in &upstream_resp.headers {
            if k.eq_ignore_ascii_case("content-length")
                || k.eq_ignore_ascii_case("transfer-encoding")
                || k.eq_ignore_ascii_case("connection")
            {
                continue;
            }
            let clean_val_bytes = scrub_bytes_with_needles(v.as_bytes(), &all_needles);
            let clean_val = String::from_utf8_lossy(&clean_val_bytes).into_owned();
            scrubbed_headers.push((k.clone(), clean_val));
        }
        scrubbed_headers.push((
            String::from("Content-Length"),
            scrubbed_body.len().to_string(),
        ));

        BrokerProxyResponse {
            status: upstream_resp.status,
            headers: scrubbed_headers,
            body: scrubbed_body,
        }
    }

    /// 启动本地认证 IPC 代理监听服务（POSIX `0600` Unix Domain Socket 或 `127.0.0.1` 回环 HTTP）。
    pub fn serve_ipc(&self, endpoint: BrokerEndpoint) -> Result<BrokerServerHandle> {
        match endpoint {
            #[cfg(unix)]
            BrokerEndpoint::UnixSocket(sock_path) => self.serve_unix_socket(sock_path),
            #[cfg(not(unix))]
            BrokerEndpoint::UnixSocket(_) => Err(QuetzalcoatlError::SandboxViolation {
                detail: String::from("当前非 Unix 平台不支持 UnixSocket IPC"),
            }),
            BrokerEndpoint::LoopbackTcp(addr) => self.serve_loopback_tcp(addr),
            BrokerEndpoint::NamedPipe(pipe_name) => {
                if !pipe_name.starts_with(r"\\.\pipe\quetzalcoatl-") {
                    return Err(QuetzalcoatlError::SandboxViolation {
                        detail: format!(
                            "Windows NamedPipe 名称必须以 \\\\.\\pipe\\quetzalcoatl- 开头: {pipe_name}"
                        ),
                    });
                }
                Err(QuetzalcoatlError::SandboxViolation {
                    detail: String::from(
                        "跨平台宿主建议在非 Windows 环境使用 UnixSocket 或 LoopbackTcp 端点",
                    ),
                })
            }
        }
    }

    #[cfg(unix)]
    fn serve_unix_socket(&self, sock_path: PathBuf) -> Result<BrokerServerHandle> {
        if let Some(parent) = sock_path.parent()
            && !parent.as_os_str().is_empty()
        {
            std::fs::create_dir_all(parent).map_err(|e| QuetzalcoatlError::StorageError {
                detail: format!("创建 Broker Socket 父目录失败 ({}): {e}", parent.display()),
            })?;
            std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700)).map_err(
                |e| QuetzalcoatlError::StorageError {
                    detail: format!("设置 Broker 父目录 0700 权限失败: {e}"),
                },
            )?;
        }
        if sock_path.exists() {
            let _ = std::fs::remove_file(&sock_path);
        }

        let listener =
            UnixListener::bind(&sock_path).map_err(|e| QuetzalcoatlError::StorageError {
                detail: format!("绑定 UnixSocket 失败 ({}): {e}", sock_path.display()),
            })?;
        std::fs::set_permissions(&sock_path, std::fs::Permissions::from_mode(0o600)).map_err(
            |e| QuetzalcoatlError::StorageError {
                detail: format!("设置 Broker UnixSocket 0600 权限失败: {e}"),
            },
        )?;
        listener
            .set_nonblocking(true)
            .map_err(|e| QuetzalcoatlError::StorageError {
                detail: format!("设置 UnixListener 非阻塞失败: {e}"),
            })?;

        let stop = Arc::new(AtomicBool::new(false));
        let stop_bg = Arc::clone(&stop);
        let broker_clone = self.clone();
        let cleanup_path = sock_path.clone();
        let inflight = Arc::new(AtomicUsize::new(0));

        let join_handle = thread::spawn(move || {
            while !stop_bg.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        let _ = stream.set_nonblocking(false);
                        let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
                        let _ = stream.set_write_timeout(Some(Duration::from_secs(10)));
                        if inflight.fetch_add(1, Ordering::AcqRel) >= MAX_CONCURRENT_IPC_CONNS {
                            inflight.fetch_sub(1, Ordering::AcqRel);
                            let busy = json_error_response(
                                503,
                                "STORAGE_ERROR",
                                "broker concurrent request limit reached",
                            );
                            write_http_response_to_stream(&mut stream, &busy);
                            continue;
                        }
                        let broker_conn = broker_clone.clone();
                        let inflight_conn = Arc::clone(&inflight);
                        thread::spawn(move || {
                            serve_single_http_stream(&broker_conn, &mut stream);
                            inflight_conn.fetch_sub(1, Ordering::AcqRel);
                        });
                    }
                    Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(5));
                    }
                    Err(_) => {
                        thread::sleep(Duration::from_millis(10));
                    }
                }
            }
            let _ = std::fs::remove_file(&cleanup_path);
        });

        Ok(BrokerServerHandle {
            endpoint: BrokerEndpoint::UnixSocket(sock_path),
            stop,
            join_handle: Some(join_handle),
        })
    }

    fn serve_loopback_tcp(&self, addr: SocketAddr) -> Result<BrokerServerHandle> {
        if !addr.ip().is_loopback() {
            return Err(QuetzalcoatlError::SandboxViolation {
                detail: format!("CredentialBroker TCP 端点必须绑定回环地址，拒绝绑定: {addr}"),
            });
        }
        let listener = TcpListener::bind(addr).map_err(|e| QuetzalcoatlError::StorageError {
            detail: format!("绑定回环 TCP 端口失败 ({addr}): {e}"),
        })?;
        let bound_addr = listener
            .local_addr()
            .map_err(|e| QuetzalcoatlError::StorageError {
                detail: format!("读取回环监听地址失败: {e}"),
            })?;
        listener
            .set_nonblocking(true)
            .map_err(|e| QuetzalcoatlError::StorageError {
                detail: format!("设置 TcpListener 非阻塞失败: {e}"),
            })?;

        let stop = Arc::new(AtomicBool::new(false));
        let stop_bg = Arc::clone(&stop);
        let broker_clone = self.clone();
        let inflight = Arc::new(AtomicUsize::new(0));

        let join_handle = thread::spawn(move || {
            while !stop_bg.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((mut stream, peer)) => {
                        if !peer.ip().is_loopback() {
                            continue;
                        }
                        let _ = stream.set_nonblocking(false);
                        let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
                        let _ = stream.set_write_timeout(Some(Duration::from_secs(10)));
                        if inflight.fetch_add(1, Ordering::AcqRel) >= MAX_CONCURRENT_IPC_CONNS {
                            inflight.fetch_sub(1, Ordering::AcqRel);
                            let busy = json_error_response(
                                503,
                                "STORAGE_ERROR",
                                "broker concurrent request limit reached",
                            );
                            write_http_response_to_stream(&mut stream, &busy);
                            continue;
                        }
                        let broker_conn = broker_clone.clone();
                        let inflight_conn = Arc::clone(&inflight);
                        thread::spawn(move || {
                            serve_single_http_stream(&broker_conn, &mut stream);
                            inflight_conn.fetch_sub(1, Ordering::AcqRel);
                        });
                    }
                    Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(5));
                    }
                    Err(_) => {
                        thread::sleep(Duration::from_millis(10));
                    }
                }
            }
        });

        Ok(BrokerServerHandle {
            endpoint: BrokerEndpoint::LoopbackTcp(bound_addr),
            stop,
            join_handle: Some(join_handle),
        })
    }
}

fn json_error_response(status: u16, code: &str, detail: &str) -> BrokerProxyResponse {
    let payload = serde_json::json!({
        "code": code,
        "detail": detail,
    });
    let body = serde_json::to_vec(&payload).unwrap_or_else(|_| b"{\"error\":true}".to_vec());
    BrokerProxyResponse {
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

fn status_reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        201 => "Created",
        204 => "No Content",
        301 => "Moved Permanently",
        302 => "Found",
        307 => "Temporary Redirect",
        308 => "Permanent Redirect",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        500 => "Internal Server Error",
        502 => "Bad Gateway",
        _ => "Response",
    }
}

fn find_header_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|w| w == b"\r\n\r\n")
}

struct ParsedHttpWireRequest {
    method: String,
    request_target: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

fn read_http_request_from_stream<R: Read>(stream: &mut R) -> Result<ParsedHttpWireRequest> {
    let mut buf = Vec::with_capacity(2048);
    let mut chunk = [0u8; 2048];
    let header_end = loop {
        if let Some(pos) = find_header_end(&buf) {
            break pos;
        }
        if buf.len() > MAX_HTTP_HEADER_BYTES {
            return Err(QuetzalcoatlError::CredentialRejected {
                detail: String::from("HTTP 请求头超出 64KiB 上限"),
            });
        }
        let n = stream
            .read(&mut chunk)
            .map_err(|e| QuetzalcoatlError::StorageError {
                detail: format!("读取 IPC HTTP 请求失败: {e}"),
            })?;
        if n == 0 {
            return Err(QuetzalcoatlError::CredentialRejected {
                detail: String::from("客户端在完整发送 HTTP 请求头前关闭连接"),
            });
        }
        buf.extend_from_slice(&chunk[..n]);
    };

    let header_text = std::str::from_utf8(&buf[..header_end]).map_err(|_| {
        QuetzalcoatlError::CredentialRejected {
            detail: String::from("HTTP 请求头不是合法 UTF-8"),
        }
    })?;
    let mut lines = header_text.split("\r\n");
    let req_line = lines
        .next()
        .ok_or_else(|| QuetzalcoatlError::CredentialRejected {
            detail: String::from("缺少 HTTP 请求行"),
        })?;
    let mut parts = req_line.split_whitespace();
    let method = parts
        .next()
        .ok_or_else(|| QuetzalcoatlError::CredentialRejected {
            detail: String::from("HTTP 请求行缺少 method"),
        })?;
    let target = parts
        .next()
        .ok_or_else(|| QuetzalcoatlError::CredentialRejected {
            detail: String::from("HTTP 请求行缺少 target"),
        })?;

    let mut headers = Vec::new();
    let mut content_length: usize = 0;
    for line in lines {
        if line.is_empty() {
            continue;
        }
        if let Some((k, v)) = line.split_once(':') {
            let name = k.trim();
            let val = v.trim();
            if name.eq_ignore_ascii_case("content-length") {
                content_length =
                    val.parse::<usize>()
                        .map_err(|_| QuetzalcoatlError::CredentialRejected {
                            detail: String::from("Content-Length 非法"),
                        })?;
                if content_length > MAX_HTTP_BODY_BYTES {
                    return Err(QuetzalcoatlError::CredentialRejected {
                        detail: String::from("HTTP 请求体超出 16MiB 上限"),
                    });
                }
            }
            headers.push((String::from(name), String::from(val)));
        }
    }

    let body_start = header_end + 4;
    let mut body = Vec::with_capacity(content_length);
    if buf.len() > body_start {
        let already = (buf.len() - body_start).min(content_length);
        body.extend_from_slice(&buf[body_start..body_start + already]);
    }
    while body.len() < content_length {
        let want = (content_length - body.len()).min(chunk.len());
        let n = stream
            .read(&mut chunk[..want])
            .map_err(|e| QuetzalcoatlError::StorageError {
                detail: format!("读取 HTTP 请求体失败: {e}"),
            })?;
        if n == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..n]);
    }

    Ok(ParsedHttpWireRequest {
        method: String::from(method),
        request_target: String::from(target),
        headers,
        body,
    })
}

fn decode_chunked_body(raw: &[u8]) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    let mut pos = 0usize;
    while pos < raw.len() {
        let Some(rel_end) = raw[pos..].windows(2).position(|w| w == b"\r\n") else {
            break;
        };
        let size_line = std::str::from_utf8(&raw[pos..pos + rel_end]).map_err(|_| {
            QuetzalcoatlError::SerializationError {
                detail: String::from("chunked 长度行非法 UTF-8"),
            }
        })?;
        let size_hex = size_line.split(';').next().unwrap_or("").trim();
        let chunk_size = usize::from_str_radix(size_hex, 16).map_err(|_| {
            QuetzalcoatlError::SerializationError {
                detail: String::from("chunked 十六进制长度解析失败"),
            }
        })?;
        pos += rel_end + 2;
        if chunk_size == 0 {
            break;
        }
        if pos + chunk_size > raw.len() {
            return Err(QuetzalcoatlError::SerializationError {
                detail: String::from("chunked 数据块截断"),
            });
        }
        out.extend_from_slice(&raw[pos..pos + chunk_size]);
        pos += chunk_size;
        if raw.get(pos..pos + 2) == Some(b"\r\n") {
            pos += 2;
        }
    }
    Ok(out)
}

fn read_http_response_from_stream<R: Read>(stream: &mut R) -> Result<UpstreamResponse> {
    let mut buf = Vec::with_capacity(4096);
    let mut tmp = [0u8; 4096];
    let header_end = loop {
        if let Some(pos) = find_header_end(&buf) {
            break pos;
        }
        if buf.len() > MAX_HTTP_HEADER_BYTES {
            return Err(QuetzalcoatlError::SerializationError {
                detail: String::from("上游响应头超过 64KiB 上限"),
            });
        }
        let n = stream
            .read(&mut tmp)
            .map_err(|e| QuetzalcoatlError::StorageError {
                detail: format!("读取上游响应头失败: {e}"),
            })?;
        if n == 0 {
            return Err(QuetzalcoatlError::StorageError {
                detail: String::from("上游未返回有效 HTTP 响应头"),
            });
        }
        buf.extend_from_slice(&tmp[..n]);
    };

    let header_text = std::str::from_utf8(&buf[..header_end]).map_err(|_| {
        QuetzalcoatlError::SerializationError {
            detail: String::from("上游 HTTP 响应头不是合法 UTF-8"),
        }
    })?;
    let mut lines = header_text.split("\r\n");
    let status_line = lines
        .next()
        .ok_or_else(|| QuetzalcoatlError::SerializationError {
            detail: String::from("缺少 HTTP 状态行"),
        })?;
    let mut status_parts = status_line.split_whitespace();
    let _http_ver = status_parts.next();
    let status_code = status_parts
        .next()
        .and_then(|s| s.parse::<u16>().ok())
        .ok_or_else(|| QuetzalcoatlError::SerializationError {
            detail: format!("无法解析上游 HTTP 状态码: {status_line}"),
        })?;

    let mut headers = Vec::new();
    let mut content_length: Option<usize> = None;
    let mut is_chunked = false;
    for line in lines {
        if line.is_empty() {
            continue;
        }
        if let Some((k, v)) = line.split_once(':') {
            let name = k.trim();
            let val = v.trim();
            if name.eq_ignore_ascii_case("content-length") {
                content_length = val.parse::<usize>().ok();
            } else if name.eq_ignore_ascii_case("transfer-encoding")
                && val.to_ascii_lowercase().contains("chunked")
            {
                is_chunked = true;
            }
            headers.push((String::from(name), String::from(val)));
        }
    }

    let body_start = header_end + 4;
    let mut raw_body = Vec::new();
    if buf.len() > body_start {
        raw_body.extend_from_slice(&buf[body_start..]);
    }

    if let Some(expected_len) = content_length {
        if expected_len > MAX_HTTP_BODY_BYTES {
            return Err(QuetzalcoatlError::SerializationError {
                detail: String::from("上游响应 Content-Length 超出 16MiB 安全上限"),
            });
        }
        while raw_body.len() < expected_len {
            let want = (expected_len - raw_body.len()).min(tmp.len());
            let n = stream
                .read(&mut tmp[..want])
                .map_err(|e| QuetzalcoatlError::StorageError {
                    detail: format!("读取上游定长响应体失败: {e}"),
                })?;
            if n == 0 {
                break;
            }
            raw_body.extend_from_slice(&tmp[..n]);
        }
        raw_body.truncate(expected_len);
    } else {
        loop {
            if raw_body.len() > MAX_HTTP_BODY_BYTES {
                return Err(QuetzalcoatlError::SerializationError {
                    detail: String::from("上游流式响应超出 16MiB 安全上限，拒绝截断放行防半段泄密"),
                });
            }
            let n = stream
                .read(&mut tmp)
                .map_err(|e| QuetzalcoatlError::StorageError {
                    detail: format!("读取上游响应流失败: {e}"),
                })?;
            if n == 0 {
                break;
            }
            raw_body.extend_from_slice(&tmp[..n]);
        }
    }

    let body = if is_chunked {
        decode_chunked_body(&raw_body)?
    } else {
        raw_body
    };

    Ok(UpstreamResponse {
        status: status_code,
        headers,
        body,
    })
}

fn write_http_response_to_stream<W: Write>(stream: &mut W, resp: &BrokerProxyResponse) {
    let mut out = Vec::with_capacity(256 + resp.body.len());
    out.extend_from_slice(
        format!(
            "HTTP/1.1 {} {}\r\n",
            resp.status,
            status_reason(resp.status)
        )
        .as_bytes(),
    );
    let mut has_len = false;
    for (k, v) in &resp.headers {
        if k.eq_ignore_ascii_case("content-length") {
            has_len = true;
        }
        if !k.contains('\r') && !k.contains('\n') && !v.contains('\r') && !v.contains('\n') {
            out.extend_from_slice(format!("{k}: {v}\r\n").as_bytes());
        }
    }
    if !has_len {
        out.extend_from_slice(format!("Content-Length: {}\r\n", resp.body.len()).as_bytes());
    }
    out.extend_from_slice(b"Connection: close\r\n\r\n");
    out.extend_from_slice(&resp.body);
    let _ = stream.write_all(&out);
    let _ = stream.flush();
}

fn serve_single_http_stream<S: Read + Write>(broker: &CredentialBroker, stream: &mut S) {
    let parsed_wire = match read_http_request_from_stream(stream) {
        Ok(req) => req,
        Err(err) => {
            let resp = json_error_response(400, err.code().as_str(), &err.to_string());
            write_http_response_to_stream(stream, &resp);
            return;
        }
    };

    if parsed_wire.method.eq_ignore_ascii_case("POST")
        && parsed_wire.request_target == INTERNAL_JSON_PROXY_PATH
    {
        match serde_json::from_slice::<BrokerProxyRequest>(&parsed_wire.body) {
            Ok(proxy_req) => {
                let resp = broker.handle_proxy_request(&proxy_req);
                write_http_response_to_stream(stream, &resp);
            }
            Err(err) => {
                let resp = json_error_response(400, "SERIALIZATION_ERROR", &err.to_string());
                write_http_response_to_stream(stream, &resp);
            }
        }
        return;
    }

    // 原始 HTTP/1.1 代理模式：从 X-Qz-Capability-Token 或 Proxy-Authorization 提取能力令牌，
    // 从完整 URL 请求行或 X-Qz-Target-Url 请求头提取目标 URL。
    let mut cap_token = String::new();
    let mut header_target_url: Option<String> = None;
    for (k, v) in &parsed_wire.headers {
        if k.eq_ignore_ascii_case("x-quetzalcoatl-capability-token")
            || k.eq_ignore_ascii_case("x-qz-capability-token")
        {
            cap_token = v.trim().to_string();
        } else if cap_token.is_empty() && k.eq_ignore_ascii_case("proxy-authorization") {
            let stripped = v.trim().strip_prefix("Bearer ").unwrap_or(v.trim());
            cap_token = String::from(stripped);
        } else if k.eq_ignore_ascii_case("x-quetzalcoatl-target-url")
            || k.eq_ignore_ascii_case("x-qz-target-url")
        {
            header_target_url = Some(v.trim().to_string());
        }
    }

    let target_url = if let Some(explicit) = header_target_url {
        explicit
    } else if parsed_wire.request_target.starts_with("http://")
        || parsed_wire.request_target.starts_with("https://")
    {
        parsed_wire.request_target
    } else {
        let resp = json_error_response(
            400,
            "CREDENTIAL_REJECTED",
            "缺少 X-Qz-Target-Url 头或完整目标 URL",
        );
        write_http_response_to_stream(stream, &resp);
        return;
    };

    let proxy_req = BrokerProxyRequest {
        capability_token: cap_token,
        method: parsed_wire.method,
        target_url,
        headers: parsed_wire.headers,
        body: parsed_wire.body,
    };
    let resp = broker.handle_proxy_request(&proxy_req);
    write_http_response_to_stream(stream, &resp);
}

/// 后台运行中的 `CredentialBroker` IPC 服务句柄。
pub struct BrokerServerHandle {
    endpoint: BrokerEndpoint,
    stop: Arc<AtomicBool>,
    join_handle: Option<JoinHandle<()>>,
}

impl BrokerServerHandle {
    #[must_use]
    pub const fn endpoint(&self) -> &BrokerEndpoint {
        &self.endpoint
    }

    #[must_use]
    pub fn unix_socket_path(&self) -> Option<&Path> {
        match &self.endpoint {
            BrokerEndpoint::UnixSocket(p) => Some(p.as_path()),
            BrokerEndpoint::LoopbackTcp(_) | BrokerEndpoint::NamedPipe(_) => None,
        }
    }

    #[must_use]
    pub const fn loopback_addr(&self) -> Option<SocketAddr> {
        match &self.endpoint {
            BrokerEndpoint::LoopbackTcp(addr) => Some(*addr),
            BrokerEndpoint::UnixSocket(_) | BrokerEndpoint::NamedPipe(_) => None,
        }
    }

    /// 经当前 IPC 通道（UnixSocket 或回环 TCP）发送结构化代理请求并取回脱敏后的响应。
    pub fn send_request(&self, req: &BrokerProxyRequest) -> Result<BrokerProxyResponse> {
        let json_body =
            serde_json::to_vec(req).map_err(|e| QuetzalcoatlError::SerializationError {
                detail: format!("序列化 BrokerProxyRequest 失败: {e}"),
            })?;
        let raw_http = format!(
            "POST {INTERNAL_JSON_PROXY_PATH} HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            json_body.len()
        );

        match &self.endpoint {
            #[cfg(unix)]
            BrokerEndpoint::UnixSocket(path) => {
                let mut stream =
                    UnixStream::connect(path).map_err(|e| QuetzalcoatlError::StorageError {
                        detail: format!("连接 Broker UnixSocket ({}) 失败: {e}", path.display()),
                    })?;
                let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
                let _ = stream.set_write_timeout(Some(Duration::from_secs(10)));
                stream
                    .write_all(raw_http.as_bytes())
                    .and_then(|()| stream.write_all(&json_body))
                    .map_err(|e| QuetzalcoatlError::StorageError {
                        detail: format!("发送 Broker UnixSocket 请求失败: {e}"),
                    })?;
                let up = read_http_response_from_stream(&mut stream)?;
                Ok(BrokerProxyResponse {
                    status: up.status,
                    headers: up.headers,
                    body: up.body,
                })
            }
            #[cfg(not(unix))]
            BrokerEndpoint::UnixSocket(_) => Err(QuetzalcoatlError::SandboxViolation {
                detail: String::from("非 Unix 平台不支持 UnixSocket"),
            }),
            BrokerEndpoint::LoopbackTcp(addr) => {
                let mut stream =
                    TcpStream::connect_timeout(addr, Duration::from_secs(5)).map_err(|e| {
                        QuetzalcoatlError::StorageError {
                            detail: format!("连接 Broker 回环端口 ({addr}) 失败: {e}"),
                        }
                    })?;
                let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
                let _ = stream.set_write_timeout(Some(Duration::from_secs(10)));
                stream
                    .write_all(raw_http.as_bytes())
                    .and_then(|()| stream.write_all(&json_body))
                    .map_err(|e| QuetzalcoatlError::StorageError {
                        detail: format!("发送 Broker TCP 请求失败: {e}"),
                    })?;
                let up = read_http_response_from_stream(&mut stream)?;
                Ok(BrokerProxyResponse {
                    status: up.status,
                    headers: up.headers,
                    body: up.body,
                })
            }
            BrokerEndpoint::NamedPipe(_) => Err(QuetzalcoatlError::SandboxViolation {
                detail: String::from("NamedPipe 传输仅在原生 Windows 命名管道运行时启用"),
            }),
        }
    }

    /// 优雅停止后台 IPC 监听并清理套接字文件。
    pub fn shutdown(mut self) -> Result<()> {
        self.stop_inner();
        Ok(())
    }

    fn stop_inner(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(handle) = self.join_handle.take() {
            let _ = handle.join();
        }
        #[cfg(unix)]
        if let BrokerEndpoint::UnixSocket(path) = &self.endpoint {
            let _ = std::fs::remove_file(path);
        }
    }
}

impl Drop for BrokerServerHandle {
    fn drop(&mut self) {
        self.stop_inner();
    }
}

#[cfg(test)]
mod unit_tests {
    use super::*;

    #[test]
    fn base64_rfc4648_test_vectors_match() {
        assert_eq!(encode_base64_standard(b""), "");
        assert_eq!(encode_base64_standard(b"f"), "Zg==");
        assert_eq!(encode_base64_standard(b"fo"), "Zm8=");
        assert_eq!(encode_base64_standard(b"foo"), "Zm9v");
        assert_eq!(encode_base64_standard(b"foob"), "Zm9vYg==");
        assert_eq!(encode_base64_standard(b"foobar"), "Zm9vYmFy");
        assert_eq!(
            encode_base64_standard(&[0xfb, 0xff, 0xbf]),
            "+/+_".replace('_', "/")
        );
        assert_eq!(encode_base64_urlsafe_unpadded(&[0xfb, 0xff]), "-_8");
    }
}
