use std::sync::Arc;

use serde_json::json;

use crate::{
    ChannelDescriptor, ChannelDriver, ChannelEnvelope, ChannelError, ChannelLimits,
    ChannelTransport, OutboundMessage, RawInbound, RenderedPart, TransportKind,
    enforce_inbound_limit, json_str, json_value, parse_json, render_parts, split_text_chars,
    validate_inbound_text,
};

#[must_use]
pub fn descriptor() -> ChannelDescriptor {
    ChannelDescriptor {
        id: String::from("telegram"),
        display_name: String::from("Telegram"),
        transport: TransportKind::Webhook,
        requires_credentials: true,
        long_lived: false,
        local_only: false,
        limits: ChannelLimits {
            max_inbound_bytes: 1024 * 1024,
            max_outbound_bytes: 100_000,
            max_text_chars: 4096,
            max_subject_chars: 0,
            max_attachments: 10,
            max_attachment_bytes: 50 * 1024 * 1024,
        },
    }
}

/// Telegram Bot API 驱动（4096 字符硬上限）。
pub struct TelegramDriver {
    descriptor: ChannelDescriptor,
    transport: Arc<dyn ChannelTransport>,
}

impl TelegramDriver {
    #[must_use]
    pub fn new(transport: Arc<dyn ChannelTransport>) -> Self {
        Self {
            descriptor: descriptor(),
            transport,
        }
    }
}

impl ChannelDriver for TelegramDriver {
    fn descriptor(&self) -> &ChannelDescriptor {
        &self.descriptor
    }

    fn normalize(&self, raw: &RawInbound) -> Result<ChannelEnvelope, ChannelError> {
        enforce_inbound_limit(&self.descriptor, &raw.body)?;
        let root = parse_json(&raw.body, "telegram_update")?;
        let message = json_value(&root, &["message"])
            .or_else(|| json_value(&root, &["edited_message"]))
            .ok_or(ChannelError::InvalidPayload("message"))?;
        let text = json_str(message, &["text"])
            .or_else(|| json_str(message, &["caption"]))
            .unwrap_or("");
        validate_inbound_text(&self.descriptor, text)?;
        let external_id = json_value(message, &["message_id"])
            .and_then(serde_json::Value::as_i64)
            .map(|v| v.to_string())
            .or_else(|| {
                json_value(&root, &["update_id"])
                    .and_then(serde_json::Value::as_i64)
                    .map(|v| v.to_string())
            })
            .ok_or(ChannelError::InvalidPayload("message.message_id"))?;
        let sender = json_value(message, &["from", "id"])
            .and_then(serde_json::Value::as_i64)
            .map(|v| v.to_string())
            .or_else(|| json_str(message, &["from", "username"]).map(str::to_owned))
            .ok_or(ChannelError::InvalidPayload("message.from.id"))?;
        Ok(ChannelEnvelope {
            channel: self.descriptor.id.clone(),
            external_id,
            sender,
            text: text.to_owned(),
            attachments: Vec::new(),
            received_at_ms: raw.received_at_ms,
            thread_hint: json_value(message, &["chat", "id"])
                .and_then(serde_json::Value::as_i64)
                .map(|v| v.to_string()),
        })
    }

    fn render(&self, message: &OutboundMessage) -> Result<Vec<RenderedPart>, ChannelError> {
        self.check_attachments(message)?;
        let segments = split_text_chars(&message.text, self.descriptor.limits.max_text_chars);
        Ok(render_parts(segments, |_index, text| {
            json!({"text": text, "disable_web_page_preview": true}).to_string()
        }))
    }

    fn transport(&self) -> &dyn ChannelTransport {
        self.transport.as_ref()
    }
}
