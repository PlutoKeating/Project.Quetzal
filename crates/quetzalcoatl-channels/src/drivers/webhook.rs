use std::sync::Arc;

use serde_json::json;

use crate::{
    AttachmentRef, ChannelDescriptor, ChannelDriver, ChannelEnvelope, ChannelError, ChannelLimits,
    ChannelTransport, OutboundMessage, RawInbound, RenderedPart, TransportKind,
    enforce_inbound_limit, json_str, json_value, parse_json, render_parts, split_text_bytes,
    validate_inbound_text,
};

#[must_use]
pub fn descriptor() -> ChannelDescriptor {
    ChannelDescriptor {
        id: String::from("webhook"),
        display_name: String::from("公网 Webhook"),
        transport: TransportKind::Webhook,
        requires_credentials: true,
        long_lived: false,
        local_only: false,
        limits: ChannelLimits {
            max_inbound_bytes: 256 * 1024,
            max_outbound_bytes: 64 * 1024,
            max_text_chars: 60_000,
            max_subject_chars: 0,
            max_attachments: 5,
            max_attachment_bytes: 10 * 1024 * 1024,
        },
    }
}

/// 公网 Webhook 驱动：入站由 Hub 内存验签并 HPKE 密封，出站为 HTTP POST。
pub struct WebhookDriver {
    descriptor: ChannelDescriptor,
    transport: Arc<dyn ChannelTransport>,
}

impl WebhookDriver {
    #[must_use]
    pub fn new(transport: Arc<dyn ChannelTransport>) -> Self {
        Self {
            descriptor: descriptor(),
            transport,
        }
    }
}

impl ChannelDriver for WebhookDriver {
    fn descriptor(&self) -> &ChannelDescriptor {
        &self.descriptor
    }

    fn normalize(&self, raw: &RawInbound) -> Result<ChannelEnvelope, ChannelError> {
        enforce_inbound_limit(&self.descriptor, &raw.body)?;
        let root = parse_json(&raw.body, "webhook_event")?;
        let text = json_str(&root, &["text"])
            .or_else(|| json_str(&root, &["message"]))
            .unwrap_or("");
        validate_inbound_text(&self.descriptor, text)?;
        let external_id = json_str(&root, &["event_id"])
            .or_else(|| json_str(&root, &["id"]))
            .ok_or(ChannelError::InvalidPayload("event_id"))?;
        let sender = json_str(&root, &["sender"])
            .or_else(|| json_str(&root, &["from"]))
            .unwrap_or("anonymous");
        let attachments = root
            .get("attachments")
            .and_then(serde_json::Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .map(|a| AttachmentRef {
                        name: json_str(a, &["name"]).unwrap_or("attachment").to_owned(),
                        mime: json_str(a, &["mime"])
                            .unwrap_or("application/octet-stream")
                            .to_owned(),
                        size_bytes: json_value(a, &["size_bytes"])
                            .and_then(serde_json::Value::as_u64)
                            .and_then(|v| usize::try_from(v).ok())
                            .unwrap_or(0),
                        url: json_str(a, &["url"]).map(str::to_owned),
                    })
                    .collect()
            })
            .unwrap_or_default();
        Ok(ChannelEnvelope {
            channel: self.descriptor.id.clone(),
            external_id: external_id.to_owned(),
            sender: sender.to_owned(),
            text: text.to_owned(),
            attachments,
            received_at_ms: raw.received_at_ms,
            thread_hint: json_str(&root, &["thread_hint"]).map(str::to_owned),
        })
    }

    fn render(&self, message: &OutboundMessage) -> Result<Vec<RenderedPart>, ChannelError> {
        self.check_attachments(message)?;
        let segments = split_text_bytes(&message.text, self.descriptor.limits.max_outbound_bytes);
        Ok(render_parts(segments, |index, text| {
            json!({
                "event_id": format!("out_{index}"),
                "text": text,
                "thread_hint": message.thread_hint,
            })
            .to_string()
        }))
    }

    fn transport(&self) -> &dyn ChannelTransport {
        self.transport.as_ref()
    }
}
