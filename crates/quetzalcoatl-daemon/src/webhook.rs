#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]

//! `qz webhook pull` 的本地解密与脊柱落盘管线。
//!
//! Hub 只保存 HPKE 密封信封；本机用自身 X-Wing 私钥解封后，以
//! `channel.ingress` 事件写入 `ExternalChannel` 分舱（绝不与核心良知状态混舱），
//! 仅在成功落盘后向 Hub ack 删除对应密文行。绝不输出平台正文或密钥到日志。

use quetzalcoatl_crypto::{
    HpkeSealedBox, PackCompartment, WEBHOOK_INGRESS_INFO, XWING_ENC_LEN, hex_decode,
    hpke_xwing_open,
};
use quetzalcoatl_fabric::WebhookIngressEnvelope;
use quetzalcoatl_spine::{RusqliteWalStore, SpineEngine};
use quetzalcoatl_types::{QuetzalcoatlError, Result};
use serde::{Deserialize, Serialize};
use serde_json::json;

/// 单条已解封并落盘的通道入站事件（不含正文）。
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

/// 单条解封失败（不含正文）。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebhookPullFailure {
    pub event_id: String,
    pub error_code: String,
    pub detail: String,
}

/// 一次拉取/解封/落盘/确认的完整回执。
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebhookPullReport {
    pub pulled: usize,
    pub persisted: usize,
    pub acked: u64,
    pub next_cursor: i64,
    pub queue_depth: u64,
    pub events: Vec<WebhookPulledEvent>,
    pub failures: Vec<WebhookPullFailure>,
}

/// 解封并写入脊柱，返回应 ack 的 event_id 列表与报告。
pub fn decrypt_and_persist(
    engine: &mut SpineEngine<RusqliteWalStore>,
    envelopes: &[WebhookIngressEnvelope],
    now_ms: u64,
) -> (Vec<String>, WebhookPullReport) {
    let mut report = WebhookPullReport {
        pulled: envelopes.len(),
        ..WebhookPullReport::default()
    };
    let mut ack_ids = Vec::new();
    let device = engine.local_device().clone();
    for envelope in envelopes {
        match decrypt_one(&device, envelope) {
            Ok(plaintext) => {
                let payload = json!({
                    "kind": "channel.ingress",
                    "channel": envelope.channel,
                    "received_at_ms": envelope.received_at_ms,
                    "external_event_id": envelope.event_id,
                    "body": plaintext,
                })
                .to_string();
                match engine.append_event(PackCompartment::ExternalChannel, &payload, now_ms) {
                    Ok(event) => {
                        report.persisted += 1;
                        report.events.push(WebhookPulledEvent {
                            event_id: envelope.event_id.clone(),
                            channel: envelope.channel.clone(),
                            received_at_ms: envelope.received_at_ms,
                            sealed_bytes: envelope.ciphertext_hex.len() / 2,
                            plaintext_bytes: plaintext.len(),
                            spine_seq: event.header.seq,
                        });
                        ack_ids.push(envelope.event_id.clone());
                    }
                    Err(err) => report.failures.push(WebhookPullFailure {
                        event_id: envelope.event_id.clone(),
                        error_code: String::from(err.code().as_str()),
                        detail: err.to_string(),
                    }),
                }
            }
            Err(err) => report.failures.push(WebhookPullFailure {
                event_id: envelope.event_id.clone(),
                error_code: String::from(err.code().as_str()),
                detail: err.to_string(),
            }),
        }
    }
    (ack_ids, report)
}

fn decrypt_one(
    device: &quetzalcoatl_crypto::DeviceIdentity,
    envelope: &WebhookIngressEnvelope,
) -> Result<String> {
    let enc_raw = hex_decode("webhook_enc", &envelope.enc_hex)?;
    if enc_raw.len() != XWING_ENC_LEN {
        return Err(QuetzalcoatlError::IntegrityViolation {
            detail: String::from("webhook enc 长度非法"),
        });
    }
    let mut enc = [0u8; XWING_ENC_LEN];
    enc.copy_from_slice(&enc_raw);
    let ciphertext = hex_decode("webhook_ciphertext", &envelope.ciphertext_hex)?;
    let sealed = HpkeSealedBox {
        enc: enc.to_vec(),
        ciphertext,
    };
    let plaintext = hpke_xwing_open(
        device.xwing_keypair(),
        WEBHOOK_INGRESS_INFO,
        envelope.aad_json.as_bytes(),
        &sealed,
    )?;
    String::from_utf8(plaintext).map_err(|_| QuetzalcoatlError::SerializationError {
        detail: String::from("webhook 明文不是合法 UTF-8"),
    })
}
