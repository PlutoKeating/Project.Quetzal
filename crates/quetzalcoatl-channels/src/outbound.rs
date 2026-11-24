#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]

//! 出站 HTTP 请求构造：按通道把凭据渲染成 URL 模板与认证头。
//! 该模块只做纯计算，真实 HTTPS 发送由守护进程的 `HttpsUpstreamTransport` 完成。

use std::collections::BTreeMap;

use base64::Engine;
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};

use crate::{ChannelCredentials, ChannelError};

/// 已渲染的出站 HTTP 请求（`Debug` 会泄漏 token，故不派生 Debug）。
#[derive(Clone, PartialEq, Eq)]
pub struct HttpRequestSpec {
    pub url: String,
    pub headers: BTreeMap<String, String>,
    pub body: String,
}

fn required<'a>(
    creds: &'a ChannelCredentials,
    keys: &[&str],
    channel: &str,
) -> Result<&'a str, ChannelError> {
    for key in keys {
        if let Some(value) = creds.get(key).filter(|v| !v.trim().is_empty()) {
            return Ok(value);
        }
    }
    Err(ChannelError::MissingCredential(String::from(channel)))
}

fn insert_ct(headers: &mut BTreeMap<String, String>) {
    headers.insert(
        String::from("Content-Type"),
        String::from("application/json"),
    );
}

/// 构造单通道出站请求。
pub fn build_http_request(
    channel: &str,
    creds: &ChannelCredentials,
    destination: &str,
    payload: &str,
) -> Result<HttpRequestSpec, ChannelError> {
    let mut headers = BTreeMap::new();
    insert_ct(&mut headers);
    let (url, body) = match channel {
        "telegram" => {
            let token = required(creds, &["token", "bot_token"], "telegram")?;
            let chat_id = if destination.trim().is_empty() {
                required(creds, &["chat_id"], "telegram")?
            } else {
                destination
            };
            let mut value: serde_json::Value = serde_json::from_str(payload)
                .map_err(|_| ChannelError::InvalidPayload("payload"))?;
            let object = value
                .as_object_mut()
                .ok_or(ChannelError::InvalidPayload("payload"))?;
            object.insert(
                String::from("chat_id"),
                serde_json::Value::String(String::from(chat_id)),
            );
            (
                format!("https://api.telegram.org/bot{token}/sendMessage"),
                value.to_string(),
            )
        }
        "feishu" => {
            let url = if destination.starts_with("https://") || destination.starts_with("http://") {
                String::from(destination)
            } else {
                String::from(required(creds, &["url", "webhook_url"], "feishu")?)
            };
            if let Some(token) = creds.get("token").filter(|v| !v.trim().is_empty()) {
                headers.insert(String::from("Authorization"), format!("Bearer {token}"));
            }
            (url, String::from(payload))
        }
        "wecom" => {
            let key = required(creds, &["key", "webhook_key"], "wecom")?;
            (
                format!("https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key={key}"),
                String::from(payload),
            )
        }
        "dingtalk" => {
            let token = required(creds, &["access_token", "token"], "dingtalk")?;
            let mut url = format!("https://oapi.dingtalk.com/robot/send?access_token={token}");
            if let Some(secret) = creds.get("secret").filter(|v| !v.trim().is_empty()) {
                let ts = creds
                    .get("timestamp_ms")
                    .map(String::from)
                    .unwrap_or_else(|| String::from("0"));
                let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(secret.as_bytes())
                    .map_err(|_| ChannelError::MissingCredential(String::from("dingtalk")))?;
                mac.update(format!("{ts}\n{secret}").as_bytes());
                let sign =
                    base64::engine::general_purpose::STANDARD.encode(mac.finalize().into_bytes());
                url.push_str(&format!("&timestamp={ts}&sign={sign}"));
            }
            (url, String::from(payload))
        }
        "webhook" => {
            let url = if destination.starts_with("https://") || destination.starts_with("http://") {
                String::from(destination)
            } else {
                String::from(required(creds, &["url", "endpoint"], "webhook")?)
            };
            if let Some(token) = creds.get("token").filter(|v| !v.trim().is_empty()) {
                headers.insert(String::from("Authorization"), format!("Bearer {token}"));
            }
            if let Some(secret) = creds.get("secret").filter(|v| !v.trim().is_empty()) {
                let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(secret.as_bytes())
                    .map_err(|_| ChannelError::MissingCredential(String::from("webhook")))?;
                mac.update(payload.as_bytes());
                let digest = mac.finalize().into_bytes();
                let mut hex = String::with_capacity(64);
                for byte in digest {
                    hex.push_str(&format!("{byte:02x}"));
                }
                headers.insert(String::from("X-QZ-Signature"), format!("sha256={hex}"));
            }
            (url, String::from(payload))
        }
        "system-intents" => {
            return Err(ChannelError::TransportUnavailable);
        }
        "email" => {
            return Err(ChannelError::TransportUnavailable);
        }
        _ => return Err(ChannelError::NotEnabled(String::from(channel))),
    };
    Ok(HttpRequestSpec { url, headers, body })
}

/// 供测试/审计使用的规范化请求指纹（不含 token/body）。
#[must_use]
pub fn request_fingerprint(spec: &HttpRequestSpec) -> String {
    let mut hasher = Sha256::new();
    hasher.update(spec.url.as_bytes());
    hasher.update(b"\0");
    for (k, v) in &spec.headers {
        hasher.update(k.as_bytes());
        hasher.update(b":");
        hasher.update(v.as_bytes());
        hasher.update(b"\n");
    }
    let mut out = String::with_capacity(64);
    for byte in hasher.finalize() {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}
