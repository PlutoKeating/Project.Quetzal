#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]

//! `quetzalcoatl-channels` — 七大标准外置通道族的统一描述符、入站规范化、
//! 出站限额渲染与单 `witness_epoch` 长连接移交监管。
//!
//! 设计红线（AGENTS.md 防坑规范 #7/#18/#19/#20/#21）：
//! 1. 通道正文绝不进入 `Debug`/日志；凭据只在内存中解密使用；
//! 2. 长连接同一时刻只能由一个 `witness_epoch` 持有，漂移时必须先关闭旧连接；
//! 3. 出站超限必须显式分片或带可见截断标记，绝不静默丢字；
//! 4. 所有驱动均可注入 mock transport，CI 零真实网络。

pub mod drivers;
pub mod supervisor;

pub use drivers::{
    dingtalk::DingTalkDriver, email::EmailDriver, feishu::FeishuDriver,
    system_intents::SystemIntentsDriver, telegram::TelegramDriver, webhook::WebhookDriver,
    wecom::WeComDriver,
};
pub use supervisor::{ChannelCredentials, ChannelHealth, ChannelSupervisor, load_credentials};

use std::collections::BTreeMap;
use std::fmt;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

/// 通道传输类型。
#[derive(Copy, Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TransportKind {
    WebSocket,
    Webhook,
    Smtp,
    Http,
    LocalIpc,
}

/// 单个通道的平台限额。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelLimits {
    pub max_inbound_bytes: usize,
    pub max_outbound_bytes: usize,
    pub max_text_chars: usize,
    pub max_subject_chars: usize,
    pub max_attachments: usize,
    pub max_attachment_bytes: usize,
}

/// 通道描述符（`packages/channels/<id>/channel.json` 的唯一事实源）。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelDescriptor {
    pub id: String,
    pub display_name: String,
    pub transport: TransportKind,
    pub requires_credentials: bool,
    pub long_lived: bool,
    pub local_only: bool,
    pub limits: ChannelLimits,
}

/// 入站附件元数据（绝不携带正文）。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentRef {
    pub name: String,
    pub mime: String,
    pub size_bytes: usize,
    pub url: Option<String>,
}

/// 统一入站信封。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelEnvelope {
    pub channel: String,
    pub external_id: String,
    pub sender: String,
    pub text: String,
    pub attachments: Vec<AttachmentRef>,
    pub received_at_ms: u64,
    pub thread_hint: Option<String>,
}

/// 统一出站消息。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutboundMessage {
    pub subject: Option<String>,
    pub text: String,
    #[serde(default)]
    pub attachments: Vec<AttachmentRef>,
    pub thread_hint: Option<String>,
}

impl OutboundMessage {
    #[must_use]
    pub fn text_only(text: impl Into<String>) -> Self {
        Self {
            subject: None,
            text: text.into(),
            attachments: Vec::new(),
            thread_hint: None,
        }
    }
}

/// 原始入站载荷（平台原始字节 + 接收时间）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RawInbound {
    pub body: Vec<u8>,
    pub received_at_ms: u64,
}

impl RawInbound {
    #[must_use]
    pub fn new(body: impl Into<Vec<u8>>, received_at_ms: u64) -> Self {
        Self {
            body: body.into(),
            received_at_ms,
        }
    }
}

/// 出站渲染片段；`truncated` 为 true 时 payload 末尾必带可见截断标记。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RenderedPart {
    pub index: usize,
    pub payload: String,
    pub truncated: bool,
}

/// 投递报告。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeliveryReport {
    pub channel: String,
    pub destination: String,
    pub parts: usize,
    pub truncated: bool,
}

/// 通道错误；`Display` 绝不包含消息正文或令牌。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ChannelError {
    InvalidPayload(&'static str),
    PayloadTooLarge,
    AttachmentLimitExceeded,
    MissingCredential(String),
    TransportUnavailable,
    TransportRejected(u16),
    NotEnabled(String),
    PermissionDenied(String),
}

impl fmt::Display for ChannelError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidPayload(field) => write!(f, "通道载荷缺少或非法字段: {field}"),
            Self::PayloadTooLarge => write!(f, "通道载荷超出平台限额"),
            Self::AttachmentLimitExceeded => write!(f, "通道附件数量或大小超出平台限额"),
            Self::MissingCredential(channel) => write!(f, "通道 {channel} 缺少运行凭据"),
            Self::TransportUnavailable => write!(f, "通道传输不可用"),
            Self::TransportRejected(status) => write!(f, "通道平台拒绝投递 (HTTP {status})"),
            Self::NotEnabled(channel) => write!(f, "通道 {channel} 未启用"),
            Self::PermissionDenied(channel) => write!(f, "通道 {channel} 权限拒绝"),
        }
    }
}

impl std::error::Error for ChannelError {}

/// 可注入的通道传输（生产为 HTTP/WebSocket/SMTP，测试为 mock）。
pub trait ChannelTransport: Send + Sync {
    fn send(&self, destination: &str, payload: &str) -> Result<(), ChannelError>;
    fn close(&self);
}

/// 统一通道驱动契约。
pub trait ChannelDriver: Send + Sync {
    fn descriptor(&self) -> &ChannelDescriptor;
    fn normalize(&self, raw: &RawInbound) -> Result<ChannelEnvelope, ChannelError>;
    fn render(&self, message: &OutboundMessage) -> Result<Vec<RenderedPart>, ChannelError>;

    fn deliver(
        &self,
        destination: &str,
        message: &OutboundMessage,
    ) -> Result<DeliveryReport, ChannelError> {
        self.check_attachments(message)?;
        let parts = self.render(message)?;
        for part in &parts {
            self.transport().send(destination, &part.payload)?;
        }
        Ok(DeliveryReport {
            channel: self.descriptor().id.clone(),
            destination: String::from(destination),
            parts: parts.len(),
            truncated: parts.iter().any(|p| p.truncated),
        })
    }

    fn check_attachments(&self, message: &OutboundMessage) -> Result<(), ChannelError> {
        let limits = &self.descriptor().limits;
        if message.attachments.len() > limits.max_attachments {
            return Err(ChannelError::AttachmentLimitExceeded);
        }
        if message
            .attachments
            .iter()
            .any(|a| a.size_bytes > limits.max_attachment_bytes)
        {
            return Err(ChannelError::AttachmentLimitExceeded);
        }
        Ok(())
    }

    fn transport(&self) -> &dyn ChannelTransport;
    fn close(&self) {
        self.transport().close();
    }
}

/// 测试/离线 mock 传输：记录投递并支持关闭断言。
#[derive(Default)]
pub struct MockTransport {
    sent: Mutex<Vec<(String, String)>>,
    closed: Mutex<bool>,
    reject_with: Option<u16>,
}

impl MockTransport {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    #[must_use]
    pub fn rejecting(status: u16) -> Self {
        Self {
            reject_with: Some(status),
            ..Self::default()
        }
    }

    #[must_use]
    pub fn sent_payloads(&self) -> Vec<String> {
        self.sent
            .lock()
            .map(|g| g.iter().map(|(_, p)| p.clone()).collect())
            .unwrap_or_default()
    }

    #[must_use]
    pub fn sent_destinations(&self) -> Vec<String> {
        self.sent
            .lock()
            .map(|g| g.iter().map(|(d, _)| d.clone()).collect())
            .unwrap_or_default()
    }

    #[must_use]
    pub fn is_closed(&self) -> bool {
        self.closed.lock().map(|g| *g).unwrap_or(false)
    }
}

impl ChannelTransport for MockTransport {
    fn send(&self, destination: &str, payload: &str) -> Result<(), ChannelError> {
        if let Some(status) = self.reject_with {
            return Err(ChannelError::TransportRejected(status));
        }
        self.sent
            .lock()
            .map_err(|_| ChannelError::TransportUnavailable)?
            .push((String::from(destination), String::from(payload)));
        Ok(())
    }

    fn close(&self) {
        if let Ok(mut guard) = self.closed.lock() {
            *guard = true;
        }
    }
}

/// 真实 HTTP/1.1 POST 传输（仅 `http://`；生产应置于本机 TLS 终结器之后）。
/// 绝不打印 URL 查询串、请求头或正文。
pub struct HttpPostTransport;

impl ChannelTransport for HttpPostTransport {
    fn send(&self, destination: &str, payload: &str) -> Result<(), ChannelError> {
        use std::io::{Read, Write};
        use std::net::TcpStream;
        use std::time::Duration;

        let rest = destination
            .strip_prefix("http://")
            .ok_or(ChannelError::TransportUnavailable)?;
        let (authority, path) = rest.split_once('/').map_or((rest, ""), |(a, p)| (a, p));
        let path = format!("/{path}");
        if authority.is_empty()
            || authority.contains('@')
            || authority.bytes().any(|b| b <= 0x20 || b == b'/')
        {
            return Err(ChannelError::TransportUnavailable);
        }
        let addr = if authority.contains(':') {
            authority.to_owned()
        } else {
            format!("{authority}:80")
        };
        let mut stream =
            TcpStream::connect(addr.as_str()).map_err(|_| ChannelError::TransportUnavailable)?;
        let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
        let _ = stream.set_write_timeout(Some(Duration::from_secs(10)));
        let request = format!(
            "POST {path} HTTP/1.1\r\nHost: {authority}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}",
            payload.len()
        );
        stream
            .write_all(request.as_bytes())
            .map_err(|_| ChannelError::TransportUnavailable)?;
        let mut response = [0u8; 128];
        let n = stream.read(&mut response).unwrap_or(0);
        let head = String::from_utf8_lossy(&response[..n]);
        let status = head
            .split_whitespace()
            .nth(1)
            .and_then(|s| s.parse::<u16>().ok())
            .unwrap_or(0);
        if (200..300).contains(&status) {
            Ok(())
        } else {
            Err(ChannelError::TransportRejected(status))
        }
    }

    fn close(&self) {}
}

/// 通道未配置时的 fail-closed 传输。
pub struct UnavailableTransport;

impl ChannelTransport for UnavailableTransport {
    fn send(&self, _destination: &str, _payload: &str) -> Result<(), ChannelError> {
        Err(ChannelError::TransportUnavailable)
    }
    fn close(&self) {}
}

pub(crate) fn json_value<'a>(
    root: &'a serde_json::Value,
    path: &[&str],
) -> Option<&'a serde_json::Value> {
    let mut cur = root;
    for key in path {
        cur = cur.get(*key)?;
    }
    Some(cur)
}

pub(crate) fn json_str<'a>(root: &'a serde_json::Value, path: &[&str]) -> Option<&'a str> {
    json_value(root, path).and_then(serde_json::Value::as_str)
}

pub(crate) fn parse_json(
    body: &[u8],
    field: &'static str,
) -> Result<serde_json::Value, ChannelError> {
    serde_json::from_slice(body).map_err(|_| ChannelError::InvalidPayload(field))
}

/// 轻量 XML 标签抽取（WeCom 风格回调），仅做结构提取，不做任何执行。
pub(crate) fn xml_tag<'a>(body: &'a str, tag: &str) -> Option<&'a str> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = body.find(&open)? + open.len();
    let rest = body.get(start..)?;
    let end = rest.find(&close)?;
    let raw = rest.get(..end)?.trim();
    let raw = raw
        .strip_prefix("<![CDATA[")
        .and_then(|s| s.strip_suffix("]]>"))
        .unwrap_or(raw);
    Some(raw)
}

pub(crate) fn enforce_inbound_limit(
    descriptor: &ChannelDescriptor,
    body: &[u8],
) -> Result<(), ChannelError> {
    if body.len() > descriptor.limits.max_inbound_bytes {
        return Err(ChannelError::PayloadTooLarge);
    }
    Ok(())
}

pub(crate) fn validate_inbound_text(
    descriptor: &ChannelDescriptor,
    text: &str,
) -> Result<(), ChannelError> {
    if text.chars().count() > descriptor.limits.max_text_chars {
        return Err(ChannelError::PayloadTooLarge);
    }
    Ok(())
}

pub const TRUNCATION_INDICATOR: &str = "…[truncated]";

/// 按字符上限切分文本；最后一段显式追加截断标记，绝不静默丢字。
pub(crate) fn split_text_chars(text: &str, max_chars: usize) -> Vec<(String, bool)> {
    if max_chars == 0 {
        return vec![(String::from(TRUNCATION_INDICATOR), true)];
    }
    let total = text.chars().count();
    if total <= max_chars {
        return vec![(String::from(text), false)];
    }
    let indicator_chars = TRUNCATION_INDICATOR.chars().count();
    let chunk = max_chars.saturating_sub(indicator_chars).max(1);
    let chars: Vec<char> = text.chars().collect();
    let mut out = Vec::new();
    let mut idx = 0usize;
    while idx < total {
        let end = (idx + chunk).min(total);
        let mut part: String = chars[idx..end].iter().collect();
        let is_last = end == total;
        if is_last {
            part.push_str(TRUNCATION_INDICATOR);
        }
        out.push((part, is_last));
        idx = end;
    }
    out
}

/// 按 UTF-8 字节上限切分（不会拆坏多字节字符）。
pub(crate) fn split_text_bytes(text: &str, max_bytes: usize) -> Vec<(String, bool)> {
    if max_bytes == 0 {
        return vec![(String::from(TRUNCATION_INDICATOR), true)];
    }
    if text.len() <= max_bytes {
        return vec![(String::from(text), false)];
    }
    let indicator_bytes = TRUNCATION_INDICATOR.len();
    let chunk = max_bytes.saturating_sub(indicator_bytes).max(1);
    let mut out = Vec::new();
    let mut start = 0usize;
    while start < text.len() {
        let mut end = (start + chunk).min(text.len());
        while end > start && !text.is_char_boundary(end) {
            end -= 1;
        }
        if end == start {
            end = text.len().min(start + 1);
            while end < text.len() && !text.is_char_boundary(end) {
                end += 1;
            }
        }
        let is_last = end >= text.len();
        let mut part = String::from(&text[start..end]);
        if is_last {
            part.push_str(TRUNCATION_INDICATOR);
        }
        out.push((part, is_last));
        start = end;
    }
    out
}

pub(crate) fn render_parts(
    segments: Vec<(String, bool)>,
    wrap: impl Fn(usize, &str) -> String,
) -> Vec<RenderedPart> {
    segments
        .into_iter()
        .enumerate()
        .map(|(index, (text, truncated))| RenderedPart {
            index,
            payload: wrap(index, &text),
            truncated,
        })
        .collect()
}

pub(crate) fn truncate_chars(text: &str, max_chars: usize) -> (String, bool) {
    if text.chars().count() <= max_chars {
        return (String::from(text), false);
    }
    let keep = max_chars.saturating_sub(TRUNCATION_INDICATOR.chars().count());
    let mut out: String = text.chars().take(keep).collect();
    out.push_str(TRUNCATION_INDICATOR);
    (out, true)
}

/// 测试与守护进程共用的描述符注册表。
#[must_use]
pub fn descriptors() -> BTreeMap<String, ChannelDescriptor> {
    drivers::all_descriptors()
        .into_iter()
        .map(|d| (d.id.clone(), d))
        .collect()
}

/// 以给定传输构造全部七大驱动。
#[must_use]
pub fn drivers_with_transport(
    transport: Arc<dyn ChannelTransport>,
) -> BTreeMap<String, Arc<dyn ChannelDriver>> {
    drivers::build_all(transport)
}
