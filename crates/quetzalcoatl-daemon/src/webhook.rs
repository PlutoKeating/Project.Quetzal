#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]

//! `qz webhook pull` 的本地解密、平台解密、规范化、脊柱落盘与重试/死信管线。
//!
//! - 先用本设备独立 `ChannelIngressKey` 解封 HPKE；
//! - 再按通道解密平台加密回调（WeCom/飞书/钉钉）；
//! - 经通道驱动 normalize 后写 `channel.message`；密封原文写 `channel.ingress.sealed` 供审计；
//! - 解密/规范化失败不 ack，按 event 计数重试，达到上限写 `channel.dead_letter` 并 ack。

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use quetzalcoatl_crypto::{PackCompartment, hex_decode};
use quetzalcoatl_fabric::{WebhookIngressAckKey, WebhookIngressEnvelope};
use quetzalcoatl_spine::{RusqliteWalStore, SpineEngine};
use quetzalcoatl_types::{QuetzalcoatlError, Result};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::channels::ChannelRuntime;
use crate::ingress_key::ChannelIngressKey;

const MAX_ATTEMPTS: u32 = 3;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebhookPulledEvent {
    pub event_id: String,
    pub channel: String,
    pub received_at_ms: i64,
    pub sealed_bytes: usize,
    pub plaintext_bytes: usize,
    pub spine_seq: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebhookPullFailure {
    pub event_id: String,
    pub channel: String,
    pub error_code: String,
    pub detail: String,
    pub dead_lettered: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebhookPullReport {
    pub pulled: usize,
    pub persisted: usize,
    pub acked: u64,
    pub dead_lettered: usize,
    pub next_cursor: i64,
    pub queue_depth: u64,
    pub events: Vec<WebhookPulledEvent>,
    pub failures: Vec<WebhookPullFailure>,
}

#[derive(Default, Serialize, Deserialize)]
struct RetryState {
    attempts: BTreeMap<String, u32>,
}

fn retry_path(home: &Path) -> PathBuf {
    home.join("channels/webhook_retry.json")
}

fn load_retry(home: &Path) -> RetryState {
    std::fs::read(retry_path(home))
        .ok()
        .and_then(|raw| serde_json::from_slice(&raw).ok())
        .unwrap_or_default()
}

fn save_retry(home: &Path, state: &RetryState) -> Result<()> {
    let path = retry_path(home);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| QuetzalcoatlError::StorageError {
            detail: format!("创建 webhook 重试目录失败: {e}"),
        })?;
    }
    let encoded =
        serde_json::to_vec_pretty(state).map_err(|e| QuetzalcoatlError::SerializationError {
            detail: format!("序列化 webhook 重试状态失败: {e}"),
        })?;
    std::fs::write(&path, encoded).map_err(|e| QuetzalcoatlError::StorageError {
        detail: format!("写入 webhook 重试状态失败: {e}"),
    })?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

/// 解封、平台解密、规范化并写入脊柱；返回应 ack 的 (channel,event_id) 与报告。
pub fn decrypt_and_persist(
    engine: &mut SpineEngine<RusqliteWalStore>,
    ingress_key: &ChannelIngressKey,
    runtime: &ChannelRuntime,
    home: &Path,
    envelopes: &[WebhookIngressEnvelope],
    now_ms: u64,
) -> (Vec<WebhookIngressAckKey>, WebhookPullReport) {
    let mut report = WebhookPullReport {
        pulled: envelopes.len(),
        ..WebhookPullReport::default()
    };
    let mut retry = load_retry(home);
    let mut ack_keys = Vec::new();
    for envelope in envelopes {
        let retry_key = format!("{}:{}", envelope.channel, envelope.event_id);
        let legacy_device = engine.local_device().clone();
        let outcome =
            decrypt_envelope(ingress_key, &legacy_device, runtime, envelope).and_then(|decoded| {
                runtime
                    .normalize(
                        &envelope.channel,
                        &decoded.text,
                        u64::try_from(envelope.received_at_ms).unwrap_or(0),
                    )
                    .map(|normalized| (decoded, normalized))
            });
        match outcome {
            Ok((decoded, normalized)) => {
                if decoded.legacy_key_used {
                    let audit = json!({
                        "kind": "channel.legacy_ingress_key",
                        "channel": envelope.channel,
                        "event_id": envelope.event_id,
                    })
                    .to_string();
                    let _ = engine.append_event(PackCompartment::ExternalChannel, &audit, now_ms);
                }
                let sealed_audit = json!({
                    "kind": "channel.ingress.sealed",
                    "channel": envelope.channel,
                    "event_id": envelope.event_id,
                    "received_at_ms": envelope.received_at_ms,
                    "aad_json": envelope.aad_json,
                    "enc_hex": envelope.enc_hex,
                    "ciphertext_hex": envelope.ciphertext_hex,
                })
                .to_string();
                let message = json!({
                    "kind": "channel.message",
                    "channel": envelope.channel,
                    "event_id": envelope.event_id,
                    "received_at_ms": envelope.received_at_ms,
                    "payload": normalized,
                })
                .to_string();
                match engine
                    .append_event(PackCompartment::ExternalChannel, &sealed_audit, now_ms)
                    .and_then(|_| {
                        engine.append_event(PackCompartment::ExternalChannel, &message, now_ms)
                    }) {
                    Ok(event) => {
                        report.persisted += 1;
                        report.events.push(WebhookPulledEvent {
                            event_id: envelope.event_id.clone(),
                            channel: envelope.channel.clone(),
                            received_at_ms: envelope.received_at_ms,
                            sealed_bytes: envelope.ciphertext_hex.len() / 2,
                            plaintext_bytes: decoded.text.len(),
                            spine_seq: event.header.seq,
                        });
                        ack_keys.push(WebhookIngressAckKey {
                            channel: envelope.channel.clone(),
                            event_id: envelope.event_id.clone(),
                        });
                        retry.attempts.remove(&retry_key);
                    }
                    Err(err) => {
                        let failure = record_retry(
                            engine, home, &mut retry, envelope, &retry_key, &err, now_ms,
                        );
                        if failure.dead_lettered {
                            ack_keys.push(WebhookIngressAckKey {
                                channel: envelope.channel.clone(),
                                event_id: envelope.event_id.clone(),
                            });
                            report.dead_lettered += 1;
                        }
                        report.failures.push(failure);
                    }
                }
            }
            Err(err) => {
                let failure =
                    record_retry(engine, home, &mut retry, envelope, &retry_key, &err, now_ms);
                if failure.dead_lettered {
                    ack_keys.push(WebhookIngressAckKey {
                        channel: envelope.channel.clone(),
                        event_id: envelope.event_id.clone(),
                    });
                    report.dead_lettered += 1;
                }
                report.failures.push(failure);
            }
        }
    }
    let _ = save_retry(home, &retry);
    (ack_keys, report)
}

struct DecryptedPayload {
    text: Vec<u8>,
    legacy_key_used: bool,
}

fn decrypt_envelope(
    ingress_key: &ChannelIngressKey,
    legacy_device: &quetzalcoatl_crypto::DeviceIdentity,
    runtime: &ChannelRuntime,
    envelope: &WebhookIngressEnvelope,
) -> Result<DecryptedPayload> {
    let enc = hex_decode("webhook_enc", &envelope.enc_hex)?;
    let ciphertext = hex_decode("webhook_ciphertext", &envelope.ciphertext_hex)?;
    let (plaintext, legacy_key_used) =
        match ingress_key.open(envelope.aad_json.as_bytes(), &enc, &ciphertext) {
            Ok(plaintext) => (plaintext, false),
            Err(err) if envelope.target_device_id.is_empty() => {
                let sealed = quetzalcoatl_crypto::HpkeSealedBox {
                    enc: enc.clone(),
                    ciphertext: ciphertext.clone(),
                };
                let fallback = quetzalcoatl_crypto::hpke_xwing_open(
                    legacy_device.xwing_keypair(),
                    quetzalcoatl_crypto::WEBHOOK_INGRESS_INFO,
                    envelope.aad_json.as_bytes(),
                    &sealed,
                )
                .map_err(|_| err)?;
                (fallback, true)
            }
            Err(err) => return Err(err),
        };
    let text = runtime.decrypt_platform(&envelope.channel, &plaintext)?;
    Ok(DecryptedPayload {
        text,
        legacy_key_used,
    })
}

fn record_retry(
    engine: &mut SpineEngine<RusqliteWalStore>,
    _home: &Path,
    retry: &mut RetryState,
    envelope: &WebhookIngressEnvelope,
    retry_key: &str,
    err: &QuetzalcoatlError,
    now_ms: u64,
) -> WebhookPullFailure {
    let attempts = retry.attempts.get(retry_key).copied().unwrap_or(0) + 1;
    let mut dead = false;
    if attempts >= MAX_ATTEMPTS {
        let payload = json!({
            "kind": "channel.dead_letter",
            "channel": envelope.channel,
            "event_id": envelope.event_id,
            "attempts": attempts,
            "error_code": err.code().as_str(),
        })
        .to_string();
        // 只有审计写成功才允许死信；存储瞬时失败不消耗一次性重试额度。
        if engine
            .append_event(PackCompartment::ExternalChannel, &payload, now_ms)
            .is_ok()
        {
            retry.attempts.remove(retry_key);
            dead = true;
        }
    } else {
        retry.attempts.insert(String::from(retry_key), attempts);
    }
    WebhookPullFailure {
        event_id: envelope.event_id.clone(),
        channel: envelope.channel.clone(),
        error_code: String::from(err.code().as_str()),
        detail: err.to_string(),
        dead_lettered: dead,
    }
}
