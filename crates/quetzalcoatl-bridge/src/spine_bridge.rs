//! `quetzalcoatl-bridge` — Hermes / OpenClaw 兼容的受限 `Role::Bridge` 脊柱桥接器。
//!
//! 桥接键只允许：
//! - 为本注册 `body` 追加 `memory.*` / `journal.*` 事件；
//! - 读回自身 `body` 的同类事件。
//!
//! 任何对良知（`conscience`）、`SELF_*`、`ROOT`、`OPERATOR`、其他 body、
//! 成员关系（`membership.*`）或租约（`lease.*`）的写入都会返回
//! `PermissionDenied` 并写入内存审计账本。

use quetzalcoatl_crypto::PackCompartment;
use quetzalcoatl_spine::{MaterializedStore, SpineEngine, SpineEvent};
use quetzalcoatl_types::{AgentId, ArtifactId, QuetzalcoatlError, Result};
use serde::{Deserialize, Serialize};

/// 桥接键角色：永远只有受限 `Bridge` 一种。
#[derive(Copy, Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BridgeRole {
    Bridge,
}

/// 受限桥接键。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeKey {
    pub role: BridgeRole,
    pub agent_id: AgentId,
    /// 桥接器注册的唯一 `body` 标识（Hermes/OpenClaw 实例）。
    pub body_id: String,
}

/// 可读回自身作用域的事件视图（不含正文）。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeEvent {
    pub body_id: String,
    pub kind: String,
    pub event_blake3: ArtifactId,
}

/// 一条越权/放行审计记录；只记录 kind/body/原因，绝不含正文或令牌。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeAuditEntry {
    pub allowed: bool,
    pub kind: String,
    pub body_id: String,
    pub reason: String,
}

const MAX_BRIDGE_PAYLOAD_BYTES: usize = 64 * 1024;
const FORBIDDEN_MARKERS: &[&str] = &[
    "conscience",
    "self_",
    "selfcore",
    "self_core",
    "root",
    "operator",
    "membership",
    "lease",
    "steward",
    "group",
    "relationship",
    "authority",
    "directive",
];
const SECRET_KEY_MARKERS: &[&str] = &[
    "secret",
    "token",
    "password",
    "api_key",
    "apikey",
    "private_key",
    "privatekey",
    "credential",
    "authorization",
    "cookie",
    "refresh_token",
    "access_token",
];

fn contains_forbidden(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    FORBIDDEN_MARKERS.iter().any(|m| lower.contains(m))
}

fn is_token_char(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-')
}

fn at_boundary(value: &str, start: usize) -> bool {
    start == 0 || !is_token_char(value.as_bytes()[start - 1])
}

fn has_token_payload(value: &str, start: usize, min_bytes: usize) -> bool {
    let rest = &value[start..];
    let payload: Vec<u8> = rest
        .bytes()
        .take_while(|byte| is_token_char(*byte))
        .collect();
    payload.len() >= min_bytes
}

fn marker_with_payload(value: &str, marker: &str, min_payload: usize) -> bool {
    value.match_indices(marker).any(|(idx, _)| {
        at_boundary(value, idx) && has_token_payload(value, idx + marker.len(), min_payload)
    })
}

fn looks_secret_value(value: &str) -> bool {
    ["-----BEGIN ", "-----BEGIN\n", "-----BEGIN\r\n"]
        .iter()
        .any(|marker| {
            value.match_indices(marker).any(|(idx, _)| {
                at_boundary(value, idx) && !value[idx + marker.len()..].trim().is_empty()
            })
        })
        || [
            ("sk-", 8),
            ("xoxb-", 8),
            ("xoxp-", 8),
            ("AKIA", 8),
            ("ghp_", 8),
            ("Bearer", 8),
        ]
        .iter()
        .any(|(marker, min)| marker_with_payload(value, marker, *min))
}

fn contains_absolute_path_token(value: &str) -> bool {
    ["/etc/", "/home/", "/root/", "C:\\", "D:\\"]
        .iter()
        .any(|prefix| {
            value.match_indices(prefix).any(|(idx, _)| {
                at_boundary(value, idx)
                    && value[idx + prefix.len()..]
                        .bytes()
                        .next()
                        .is_some_and(is_token_char)
            })
        })
}

fn looks_absolute_path(value: &str) -> bool {
    let trimmed = value.trim();
    if trimmed.starts_with('/') || trimmed.starts_with("\\") {
        return true;
    }
    let bytes = trimmed.as_bytes();
    bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/')
}

fn scan_json(value: &serde_json::Value, reason: &mut Option<&'static str>) -> bool {
    match value {
        serde_json::Value::Object(map) => {
            for (key, child) in map {
                let lower_key = key.to_ascii_lowercase();
                if contains_forbidden(&lower_key) {
                    *reason = Some("payload key contains forbidden authority marker");
                    return true;
                }
                if SECRET_KEY_MARKERS
                    .iter()
                    .any(|marker| lower_key.contains(marker))
                {
                    *reason = Some("payload key looks secret-bearing");
                    return true;
                }
                if lower_key.contains("path") && child.as_str().is_some_and(looks_absolute_path) {
                    *reason = Some("payload contains an absolute filesystem path");
                    return true;
                }
                if scan_json(child, reason) {
                    return true;
                }
            }
            false
        }
        serde_json::Value::Array(items) => items.iter().any(|item| scan_json(item, reason)),
        serde_json::Value::String(text) => {
            if looks_secret_value(text) {
                *reason = Some("payload value contains an unambiguous secret pattern");
                return true;
            }
            if looks_absolute_path(text) || contains_absolute_path_token(text) {
                *reason = Some("payload contains an absolute filesystem path");
                return true;
            }
            false
        }
        _ => false,
    }
}

fn kind_allowed(kind: &str) -> bool {
    if !(kind.starts_with("memory.") || kind.starts_with("journal.")) {
        return false;
    }
    !contains_forbidden(kind)
}

/// 受限脊柱桥接器。
pub struct SpineBridge<'a, S: MaterializedStore> {
    engine: &'a mut SpineEngine<S>,
    key: BridgeKey,
    audit: Vec<BridgeAuditEntry>,
}

impl<'a, S: MaterializedStore> SpineBridge<'a, S> {
    pub fn new(engine: &'a mut SpineEngine<S>, key: BridgeKey) -> Self {
        Self {
            engine,
            key,
            audit: Vec::new(),
        }
    }

    #[must_use]
    pub fn key(&self) -> &BridgeKey {
        &self.key
    }

    #[must_use]
    pub fn audit_log(&self) -> &[BridgeAuditEntry] {
        &self.audit
    }

    /// 为自身注册 body 追加受限事件。
    pub fn append(
        &mut self,
        kind: &str,
        body_id: &str,
        payload_json: &str,
        now_ms: u64,
    ) -> Result<SpineEvent> {
        self.append_for_agent(self.key.agent_id, kind, body_id, payload_json, now_ms)
    }

    /// 显式携带 Agent 归属的追加入口（用于伪造跨 Agent 写入的拒绝测试）。
    pub fn append_for_agent(
        &mut self,
        agent_id: AgentId,
        kind: &str,
        body_id: &str,
        payload_json: &str,
        now_ms: u64,
    ) -> Result<SpineEvent> {
        if self.key.role != BridgeRole::Bridge {
            return self.deny(kind, body_id, "bridge key role is not Bridge");
        }
        if agent_id != self.key.agent_id {
            return self.deny(kind, body_id, "bridge key cannot write another agent");
        }
        if body_id != self.key.body_id {
            return self.deny(kind, body_id, "bridge key cannot write another body");
        }
        if !kind_allowed(kind) {
            return self.deny(
                kind,
                body_id,
                "kind is outside memory.*/journal.* bridge scope",
            );
        }
        if payload_json.len() > MAX_BRIDGE_PAYLOAD_BYTES {
            return self.deny(kind, body_id, "payload exceeds bridge size limit");
        }
        let payload: serde_json::Value = serde_json::from_str(payload_json).map_err(|_| {
            QuetzalcoatlError::SerializationError {
                detail: String::from("bridge payload must be valid JSON object"),
            }
        })?;
        let Some(object) = payload.as_object() else {
            return self.deny(kind, body_id, "bridge payload must be a JSON object");
        };
        let Some(claimed_kind) = object.get("kind").and_then(serde_json::Value::as_str) else {
            return self.deny(kind, body_id, "payload must declare kind");
        };
        if claimed_kind != kind {
            return self.deny(kind, body_id, "payload kind does not match envelope kind");
        }
        let Some(claimed_body) = object.get("body").and_then(serde_json::Value::as_str) else {
            return self.deny(kind, body_id, "payload must declare body");
        };
        if claimed_body != self.key.body_id {
            return self.deny(kind, body_id, "payload body does not match bridge body");
        }
        let mut marker_reason: Option<&'static str> = None;
        if scan_json(&payload, &mut marker_reason) {
            return self.deny(
                kind,
                body_id,
                marker_reason.unwrap_or("payload contains forbidden authority markers"),
            );
        }
        if let Some(claimed_agent) = object
            .get("agent_id")
            .or_else(|| object.get("agentId"))
            .and_then(serde_json::Value::as_str)
            && claimed_agent != self.key.agent_id.to_string()
        {
            return self.deny(kind, body_id, "payload agent does not match bridge agent");
        }

        // 桥接事件必须进入独立 external_channel 分舱，绝不可被下游误认为核心良知状态。
        let event =
            self.engine
                .append_event(PackCompartment::ExternalChannel, payload_json, now_ms)?;
        self.audit.push(BridgeAuditEntry {
            allowed: true,
            kind: String::from(kind),
            body_id: String::from(body_id),
            reason: String::from("within role::bridge scope"),
        });
        Ok(event)
    }

    /// 只读回自身 body 的 `memory.*` / `journal.*` 事件。
    pub fn read_own(&self) -> Result<Vec<BridgeEvent>> {
        let mut out = Vec::new();
        for (event, compartment) in self.engine.store().list_all_events()? {
            if compartment != PackCompartment::ExternalChannel
                && compartment != PackCompartment::Core
            {
                continue;
            }
            let Ok(payload) = serde_json::from_str::<serde_json::Value>(&event.payload_utf8) else {
                continue;
            };
            let Some(kind) = payload.get("kind").and_then(serde_json::Value::as_str) else {
                continue;
            };
            let body = payload
                .get("body")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("");
            if body != self.key.body_id || !kind_allowed(kind) {
                continue;
            }
            // 兼容历史 Core 分舱桥接事件：仅当事件显式归属本 Agent 时才可读回。
            if compartment == PackCompartment::Core {
                let legacy_agent = payload
                    .get("agent_id")
                    .or_else(|| payload.get("agentId"))
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("");
                if legacy_agent != self.key.agent_id.to_string() {
                    continue;
                }
            }
            out.push(BridgeEvent {
                body_id: String::from(body),
                kind: String::from(kind),
                event_blake3: event.event_blake3,
            });
        }
        Ok(out)
    }

    fn deny<T>(&mut self, kind: &str, body_id: &str, reason: &str) -> Result<T> {
        self.audit.push(BridgeAuditEntry {
            allowed: false,
            kind: String::from(kind),
            body_id: String::from(body_id),
            reason: String::from(reason),
        });
        Err(QuetzalcoatlError::PermissionDenied {
            detail: format!("Role::Bridge 越权写入被拒绝: {reason}"),
        })
    }
}
