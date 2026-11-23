use quetzalcoatl_crypto::{
    DeviceIdentity, SPINE_EVENT_HASH_CONTEXT, hex_decode_fixed, hex_encode,
    verify_ed25519_signature,
};
use quetzalcoatl_types::{
    AgentId, ArtifactId, DeviceId, Epoch, HlcTimestamp, QuetzalcoatlError, Result, RunId,
};
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;

/// 默认满 500 条未封包事件自动打包为 `SealedPackfile`。
pub const AUTO_PACK_EVENT_THRESHOLD: usize = 500;

/// 单写者签名事件规范头（严格对齐 `spec/vectors/spine_pack_aad.json` `canonical_header_utf8`）。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SpineEventHeader {
    pub agent_id: AgentId,
    pub device_id: DeviceId,
    pub epoch: u64,
    pub hlc: HlcTimestamp,
    pub payload_blake3: ArtifactId,
    pub prev_blake3: ArtifactId,
    pub seq: u64,
}

impl SpineEventHeader {
    #[must_use]
    pub fn to_canonical_json(&self) -> String {
        format!(
            "{{\"agent_id\":\"{}\",\"device_id\":\"{}\",\"epoch\":{},\"hlc\":\"{}\",\"payload_blake3\":\"{}\",\"prev_blake3\":\"{}\",\"seq\":{}}}",
            self.agent_id,
            self.device_id,
            self.epoch,
            self.hlc.to_hex(),
            self.payload_blake3.to_hex(),
            self.prev_blake3.to_hex(),
            self.seq,
        )
    }
}

/// 单写者签名脊柱事件。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SpineEvent {
    pub header: SpineEventHeader,
    pub event_blake3: ArtifactId,
    pub sig_hex: String,
    pub payload_utf8: String,
}

#[derive(Deserialize)]
struct WireJsonlEvent {
    header: SpineEventHeader,
    event_blake3: ArtifactId,
    sig: String,
    payload: Box<RawValue>,
}

impl SpineEvent {
    pub fn sign_new(
        agent_id: AgentId,
        device: &DeviceIdentity,
        epoch: Epoch,
        seq: u64,
        prev_blake3: ArtifactId,
        hlc: HlcTimestamp,
        payload_utf8: &str,
    ) -> Result<Self> {
        if seq == 0 {
            return Err(QuetzalcoatlError::IntegrityViolation {
                detail: String::from("脊柱事件序号 seq 必须从 1 开始递增"),
            });
        }
        if seq == 1 && prev_blake3 != ArtifactId::ZERO {
            return Err(QuetzalcoatlError::IntegrityViolation {
                detail: String::from("首条设备链事件 seq=1 的 prev_blake3 必须为全零摘要"),
            });
        }
        let _: Box<RawValue> = serde_json::from_str(payload_utf8).map_err(|e| {
            QuetzalcoatlError::SerializationError {
                detail: format!("脊柱事件 payload 不是合法 JSON: {e}"),
            }
        })?;
        if payload_utf8.contains('\n') || payload_utf8.contains('\r') {
            return Err(QuetzalcoatlError::SerializationError {
                detail: String::from("脊柱事件单行 JSONL payload 不得包含未转义换行符"),
            });
        }

        let payload_blake3 =
            ArtifactId::from_bytes(*blake3::hash(payload_utf8.as_bytes()).as_bytes());
        let header = SpineEventHeader {
            agent_id,
            device_id: device.device_id(),
            epoch: epoch.get(),
            hlc,
            payload_blake3,
            prev_blake3,
            seq,
        };
        let canonical = header.to_canonical_json();
        let event_blake3 = compute_event_blake3(&canonical);
        let sig_bytes = device.sign_bytes(event_blake3.as_bytes())?;

        Ok(Self {
            header,
            event_blake3,
            sig_hex: hex_encode(&sig_bytes),
            payload_utf8: payload_utf8.to_owned(),
        })
    }

    pub fn verify(&self, device_ed25519_pubkey: &[u8; 32]) -> Result<()> {
        if self.header.seq == 0 {
            return Err(QuetzalcoatlError::IntegrityViolation {
                detail: String::from("脊柱事件序号 seq=0 非法"),
            });
        }
        if self.header.seq == 1 && self.header.prev_blake3 != ArtifactId::ZERO {
            return Err(QuetzalcoatlError::IntegrityViolation {
                detail: String::from("seq=1 事件的 prev_blake3 不为全零"),
            });
        }
        let actual_payload_b3 =
            ArtifactId::from_bytes(*blake3::hash(self.payload_utf8.as_bytes()).as_bytes());
        if actual_payload_b3 != self.header.payload_blake3 {
            return Err(QuetzalcoatlError::IntegrityViolation {
                detail: String::from("脊柱事件 payload_blake3 与明文负载不匹配"),
            });
        }
        let expected_event_b3 = compute_event_blake3(&self.header.to_canonical_json());
        if expected_event_b3 != self.event_blake3 {
            return Err(QuetzalcoatlError::IntegrityViolation {
                detail: String::from("脊柱事件 event_blake3 与规范头不匹配"),
            });
        }
        let sig_bytes = hex_decode_fixed::<64>("SpineEvent.sig", &self.sig_hex)?;
        verify_ed25519_signature(
            device_ed25519_pubkey,
            self.event_blake3.as_bytes(),
            &sig_bytes,
        )
    }

    pub fn to_pack_jsonl_line(&self) -> Result<String> {
        let _: Box<RawValue> = serde_json::from_str(&self.payload_utf8).map_err(|e| {
            QuetzalcoatlError::SerializationError {
                detail: format!("序列化 JSONL 时发现非法 payload JSON: {e}"),
            }
        })?;
        Ok(format!(
            "{{\"header\":{},\"event_blake3\":\"{}\",\"sig\":\"{}\",\"payload\":{}}}",
            self.header.to_canonical_json(),
            self.event_blake3.to_hex(),
            self.sig_hex,
            self.payload_utf8,
        ))
    }
}

/// 持久化封包检查点记录。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SpineCheckpoint {
    pub checkpoint_id: ArtifactId,
    pub agent_id: AgentId,
    pub device_id: DeviceId,
    pub epoch: Epoch,
    pub hlc: HlcTimestamp,
    pub last_seq: u64,
    pub last_event_blake3: ArtifactId,
    pub run_id: Option<RunId>,
    pub pack_ids: Vec<ArtifactId>,
}

#[must_use]
pub fn compute_event_blake3(canonical_header_utf8: &str) -> ArtifactId {
    ArtifactId::from_bytes(blake3::derive_key(
        SPINE_EVENT_HASH_CONTEXT,
        canonical_header_utf8.as_bytes(),
    ))
}

pub fn encode_events_jsonl(events: &[SpineEvent]) -> Result<String> {
    let mut out = String::new();
    for ev in events {
        let line = ev.to_pack_jsonl_line()?;
        out.push_str(&line);
        out.push('\n');
    }
    Ok(out)
}

pub fn parse_events_jsonl(jsonl: &str) -> Result<Vec<SpineEvent>> {
    let mut events = Vec::new();
    for (line_idx, line) in jsonl.lines().enumerate() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let wire: WireJsonlEvent =
            serde_json::from_str(trimmed).map_err(|e| QuetzalcoatlError::SerializationError {
                detail: format!("解析 Packfile JSONL 第 {} 行失败: {e}", line_idx + 1),
            })?;
        events.push(SpineEvent {
            header: wire.header,
            event_blake3: wire.event_blake3,
            sig_hex: wire.sig,
            payload_utf8: wire.payload.get().to_owned(),
        });
    }
    Ok(events)
}
