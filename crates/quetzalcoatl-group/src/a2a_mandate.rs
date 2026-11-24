//! 跨组织 A2A 身份卡与 MasDrift 衰减授权信封（Topology ④）：
//! RFC 8785（JCS）规范化 + Ed25519 JWS 签名 + 单调衰减权限 + `AUTH_REQUIRED` 人工升级路径。

use std::collections::BTreeSet;

use ed25519_dalek::{Signature, Signer as _, SigningKey, Verifier as _, VerifyingKey};
use quetzalcoatl_crypto::hex_encode;
use quetzalcoatl_types::{AgentId, QuetzalcoatlError, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;

fn mandate_error(context: &str, err: impl std::fmt::Display) -> QuetzalcoatlError {
    QuetzalcoatlError::SerializationError {
        detail: format!("{context}: {err}"),
    }
}

fn decode_hex(raw: &str) -> Result<Vec<u8>> {
    let bytes = raw.as_bytes();
    if !bytes.len().is_multiple_of(2) {
        return Err(QuetzalcoatlError::SerializationError {
            detail: String::from("十六进制字符串长度为奇数"),
        });
    }
    let mut out = Vec::with_capacity(bytes.len() / 2);
    for idx in (0..bytes.len()).step_by(2) {
        let hi =
            decode_nibble(bytes[idx]).ok_or_else(|| QuetzalcoatlError::SerializationError {
                detail: String::from("非法十六进制字符"),
            })?;
        let lo =
            decode_nibble(bytes[idx + 1]).ok_or_else(|| QuetzalcoatlError::SerializationError {
                detail: String::from("非法十六进制字符"),
            })?;
        out.push((hi << 4) | lo);
    }
    Ok(out)
}

const fn decode_nibble(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

/// RFC 8785 JSON 规范化（JCS）。
///
/// * 对象键按 UTF-16 码元序升序；
/// * 字符串仅转义 `"`、`\` 与控制字符（其余 UTF-8 原样保留）；
/// * 数字采用 ES6 `JSON.stringify` 风格（本工程 A2A 卡仅使用整数，避免浮点歧义）。
pub fn jcs_canonicalize(value: &Value) -> Result<String> {
    let mut out = String::new();
    write_jcs(value, &mut out)?;
    Ok(out)
}

fn write_jcs(value: &Value, out: &mut String) -> Result<()> {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(true) => out.push_str("true"),
        Value::Bool(false) => out.push_str("false"),
        Value::Number(number) => {
            if number.is_f64() {
                let raw = number
                    .as_f64()
                    .ok_or_else(|| QuetzalcoatlError::SerializationError {
                        detail: String::from("无法读取 JSON 浮点数"),
                    })?;
                if !raw.is_finite() {
                    return Err(QuetzalcoatlError::SerializationError {
                        detail: String::from("非有限浮点数不可参与 JCS 规范化"),
                    });
                }
                // 仅保留最短往返表示；本工程 A2A 卡不使用浮点数。
                out.push_str(&raw.to_string());
            } else {
                out.push_str(&number.to_string());
            }
        }
        Value::String(text) => write_jcs_string(text, out),
        Value::Array(items) => {
            out.push('[');
            for (idx, item) in items.iter().enumerate() {
                if idx > 0 {
                    out.push(',');
                }
                write_jcs(item, out)?;
            }
            out.push(']');
        }
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
            out.push('{');
            for (idx, key) in keys.iter().enumerate() {
                if idx > 0 {
                    out.push(',');
                }
                write_jcs_string(key, out);
                out.push(':');
                let entry = map
                    .get(*key)
                    .ok_or_else(|| QuetzalcoatlError::SerializationError {
                        detail: String::from("JCS 对象键在迭代中消失"),
                    })?;
                write_jcs(entry, out)?;
            }
            out.push('}');
        }
    }
    Ok(())
}

fn write_jcs_string(text: &str, out: &mut String) {
    out.push('"');
    for ch in text.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{0008}' => out.push_str("\\b"),
            '\u{0009}' => out.push_str("\\t"),
            '\u{000a}' => out.push_str("\\n"),
            '\u{000c}' => out.push_str("\\f"),
            '\u{000d}' => out.push_str("\\r"),
            ch if (ch as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", ch as u32));
            }
            ch => out.push(ch),
        }
    }
    out.push('"');
}

/// A2A Agent 身份卡（自签名，可跨组织交换）。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentCard {
    pub agent_id: AgentId,
    pub organisation: String,
    pub display_name: String,
    pub capabilities: Vec<String>,
    pub public_key_hex: String,
    pub issued_at_ms: u64,
    pub expires_at_ms: u64,
}

/// 已签名的 AgentCard（Ed25519 JWS over JCS 载荷）。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SignedAgentCard {
    pub card: AgentCard,
    pub signature_hex: String,
}

impl SignedAgentCard {
    pub fn sign(card: AgentCard, signing_key: &SigningKey) -> Result<Self> {
        let payload = card_payload(&card)?;
        let signature = signing_key.sign(payload.as_bytes());
        Ok(Self {
            card,
            signature_hex: hex_encode(&signature.to_bytes()),
        })
    }

    pub fn canonical_payload(&self) -> Result<String> {
        card_payload(&self.card)
    }

    pub fn verify(&self) -> Result<()> {
        let payload = self.canonical_payload()?;
        let key_bytes: [u8; 32] =
            decode_hex(&self.card.public_key_hex)?
                .try_into()
                .map_err(|_| QuetzalcoatlError::VerificationFailed {
                    detail: String::from("AgentCard 公钥长度不是 32 字节"),
                })?;
        let verifying_key = VerifyingKey::from_bytes(&key_bytes).map_err(|_| {
            QuetzalcoatlError::VerificationFailed {
                detail: String::from("AgentCard 公钥不是合法 Ed25519 公钥"),
            }
        })?;
        let sig_bytes: [u8; 64] = decode_hex(&self.signature_hex)?.try_into().map_err(|_| {
            QuetzalcoatlError::VerificationFailed {
                detail: String::from("AgentCard 签名长度不是 64 字节"),
            }
        })?;
        let signature = Signature::from_bytes(&sig_bytes);
        verifying_key
            .verify(payload.as_bytes(), &signature)
            .map_err(|_| QuetzalcoatlError::VerificationFailed {
                detail: String::from("AgentCard Ed25519 签名校验失败"),
            })
    }
}

fn card_payload(card: &AgentCard) -> Result<String> {
    let value =
        serde_json::to_value(card).map_err(|err| mandate_error("序列化 AgentCard 失败", err))?;
    jcs_canonicalize(&value)
}

/// 衰减信封的请求参数（子信封只能收窄）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MandateRequest {
    pub scope: BTreeSet<String>,
    pub expires_at_ms: u64,
    pub max_hops: u8,
}

/// 越权升级需人工审批的票据。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct EscalationTicket {
    pub ticket_id: String,
    pub auth_required: bool,
    pub detail: String,
}

/// 沿委派链单调衰减的授权信封。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AttenuatedMandate {
    pub mandate_id: String,
    pub parent_mandate_id: Option<String>,
    pub subject_agent: AgentId,
    pub issuer_agent: AgentId,
    pub scope: BTreeSet<String>,
    pub max_hops: u8,
    pub issued_at_ms: u64,
    pub expires_at_ms: u64,
    pub issuer_public_key_hex: String,
    pub signature_hex: String,
}

#[derive(Serialize)]
struct MandateSigningView<'a> {
    mandate_id: &'a str,
    parent_mandate_id: Option<&'a str>,
    subject_agent: AgentId,
    issuer_agent: AgentId,
    scope: &'a BTreeSet<String>,
    max_hops: u8,
    issued_at_ms: u64,
    expires_at_ms: u64,
    issuer_public_key_hex: &'a str,
}

impl AttenuatedMandate {
    /// 创建根授权信封。
    #[allow(clippy::too_many_arguments)]
    pub fn root(
        subject_agent: AgentId,
        issuer_agent: AgentId,
        scope: BTreeSet<String>,
        max_hops: u8,
        issued_at_ms: u64,
        expires_at_ms: u64,
        signing_key: &SigningKey,
    ) -> Result<Self> {
        if expires_at_ms <= issued_at_ms {
            return Err(QuetzalcoatlError::PermissionDenied {
                detail: String::from("AUTH_REQUIRED: 根授权信封过期时间必须晚于签发时间"),
            });
        }
        let mut mandate = Self {
            mandate_id: format!("mandate-{}", uuid::Uuid::new_v4()),
            parent_mandate_id: None,
            subject_agent,
            issuer_agent,
            scope,
            max_hops,
            issued_at_ms,
            expires_at_ms,
            issuer_public_key_hex: hex_encode(&signing_key.verifying_key().to_bytes()),
            signature_hex: String::new(),
        };
        mandate.signature_hex = mandate.signing_payload_string(signing_key)?;
        Ok(mandate)
    }

    fn signing_view(&self) -> MandateSigningView<'_> {
        MandateSigningView {
            mandate_id: &self.mandate_id,
            parent_mandate_id: self.parent_mandate_id.as_deref(),
            subject_agent: self.subject_agent,
            issuer_agent: self.issuer_agent,
            scope: &self.scope,
            max_hops: self.max_hops,
            issued_at_ms: self.issued_at_ms,
            expires_at_ms: self.expires_at_ms,
            issuer_public_key_hex: &self.issuer_public_key_hex,
        }
    }

    fn signing_payload_string(&self, signing_key: &SigningKey) -> Result<String> {
        let value = serde_json::to_value(self.signing_view())
            .map_err(|err| mandate_error("序列化衰减授权信封失败", err))?;
        let canonical = jcs_canonicalize(&value)?;
        let signature = signing_key.sign(canonical.as_bytes());
        Ok(hex_encode(&signature.to_bytes()))
    }

    /// 沿父信封继续衰减；任何扩权/延期/跳数增加都会触发 `AUTH_REQUIRED` 人工审批。
    pub fn attenuate(&self, request: MandateRequest, signing_key: &SigningKey) -> Result<Self> {
        if !request.scope.is_subset(&self.scope) {
            let exceeded: Vec<&String> = request.scope.difference(&self.scope).collect();
            return Err(QuetzalcoatlError::PermissionDenied {
                detail: format!("AUTH_REQUIRED: 子信封请求超出父信封权限范围 {exceeded:?}"),
            });
        }
        if request.expires_at_ms > self.expires_at_ms {
            return Err(QuetzalcoatlError::PermissionDenied {
                detail: String::from("AUTH_REQUIRED: 子信封有效期不得长于父信封"),
            });
        }
        if request.max_hops > self.max_hops {
            return Err(QuetzalcoatlError::PermissionDenied {
                detail: String::from("AUTH_REQUIRED: 子信封委派跳数不得多于父信封"),
            });
        }
        let mut child = Self {
            mandate_id: format!("mandate-{}", uuid::Uuid::new_v4()),
            parent_mandate_id: Some(self.mandate_id.clone()),
            subject_agent: self.subject_agent,
            issuer_agent: self.issuer_agent,
            scope: request.scope,
            max_hops: request.max_hops,
            issued_at_ms: self.issued_at_ms,
            expires_at_ms: request.expires_at_ms,
            issuer_public_key_hex: hex_encode(&signing_key.verifying_key().to_bytes()),
            signature_hex: String::new(),
        };
        child.signature_hex = child.signing_payload_string(signing_key)?;
        Ok(child)
    }

    pub fn verify(&self, parent: Option<&AttenuatedMandate>) -> Result<()> {
        let value = serde_json::to_value(self.signing_view())
            .map_err(|err| mandate_error("序列化衰减授权信封失败", err))?;
        let canonical = jcs_canonicalize(&value)?;
        let key_bytes: [u8; 32] = decode_hex(&self.issuer_public_key_hex)?
            .try_into()
            .map_err(|_| QuetzalcoatlError::VerificationFailed {
                detail: String::from("衰减信封签发公钥长度非法"),
            })?;
        let verifying_key = VerifyingKey::from_bytes(&key_bytes).map_err(|_| {
            QuetzalcoatlError::VerificationFailed {
                detail: String::from("衰减信封签发公钥非法"),
            }
        })?;
        let sig_bytes: [u8; 64] = decode_hex(&self.signature_hex)?.try_into().map_err(|_| {
            QuetzalcoatlError::VerificationFailed {
                detail: String::from("衰减信封签名长度非法"),
            }
        })?;
        verifying_key
            .verify(canonical.as_bytes(), &Signature::from_bytes(&sig_bytes))
            .map_err(|_| QuetzalcoatlError::VerificationFailed {
                detail: String::from("衰减信封 Ed25519 签名校验失败"),
            })?;
        if let Some(parent) = parent {
            parent.verify(None)?;
            if self.parent_mandate_id.as_deref() != Some(parent.mandate_id.as_str()) {
                return Err(QuetzalcoatlError::VerificationFailed {
                    detail: String::from("子信封未正确引用父信封"),
                });
            }
            if !self.scope.is_subset(&parent.scope)
                || self.expires_at_ms > parent.expires_at_ms
                || self.max_hops > parent.max_hops
            {
                return Err(QuetzalcoatlError::PermissionDenied {
                    detail: String::from("AUTH_REQUIRED: 子信封权限/时效/跳数超出父信封"),
                });
            }
        }
        Ok(())
    }

    /// 执行动作前的本地授权校验（过期与范围）。
    pub fn authorize(&self, action: &str, now_ms: u64) -> Result<()> {
        if now_ms >= self.expires_at_ms {
            return Err(QuetzalcoatlError::PermissionDenied {
                detail: String::from("AUTH_REQUIRED: 衰减授权信封已过期，需要人工重新签发"),
            });
        }
        if !self.scope.contains(action) {
            return Err(QuetzalcoatlError::PermissionDenied {
                detail: format!("AUTH_REQUIRED: 动作 {action} 不在衰减授权范围内"),
            });
        }
        Ok(())
    }

    /// 从越权错误中提取人工审批票据（`AUTH_REQUIRED` 升级路径）。
    #[must_use]
    pub fn escalation_ticket(error: &QuetzalcoatlError) -> Option<EscalationTicket> {
        let QuetzalcoatlError::PermissionDenied { detail } = error else {
            return None;
        };
        if !detail.contains("AUTH_REQUIRED") {
            return None;
        }
        Some(EscalationTicket {
            ticket_id: format!("authreq-{}", uuid::Uuid::new_v4()),
            auth_required: true,
            detail: detail.clone(),
        })
    }
}
