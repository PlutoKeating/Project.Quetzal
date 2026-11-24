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
        id: String::from("feishu"),
        display_name: String::from("飞书"),
        transport: TransportKind::WebSocket,
        requires_credentials: true,
        long_lived: true,
        local_only: false,
        limits: ChannelLimits {
            max_inbound_bytes: 1024 * 1024,
            max_outbound_bytes: 30_000,
            max_text_chars: 30_000,
            max_subject_chars: 0,
            max_attachments: 10,
            max_attachment_bytes: 30 * 1024 * 1024,
        },
    }
}

/// 飞书长连接驱动（卡片/文本事件）。
pub struct FeishuDriver {
    descriptor: ChannelDescriptor,
    transport: Arc<dyn ChannelTransport>,
}

impl FeishuDriver {
    #[must_use]
    pub fn new(transport: Arc<dyn ChannelTransport>) -> Self {
        Self {
            descriptor: descriptor(),
            transport,
        }
    }
}

fn parse_attachments(value: &serde_json::Value) -> Vec<AttachmentRef> {
    value
        .as_array()
        .map(|items| {
            items
                .iter()
                .map(|a| AttachmentRef {
                    name: json_str(a, &["file_name"])
                        .unwrap_or("attachment")
                        .to_owned(),
                    mime: json_str(a, &["mime_type"])
                        .unwrap_or("application/octet-stream")
                        .to_owned(),
                    size_bytes: json_value(a, &["size"])
                        .and_then(serde_json::Value::as_u64)
                        .and_then(|v| usize::try_from(v).ok())
                        .unwrap_or(0),
                    url: json_str(a, &["url"]).map(str::to_owned),
                })
                .collect()
        })
        .unwrap_or_default()
}

impl ChannelDriver for FeishuDriver {
    fn descriptor(&self) -> &ChannelDescriptor {
        &self.descriptor
    }

    fn normalize(&self, raw: &RawInbound) -> Result<ChannelEnvelope, ChannelError> {
        enforce_inbound_limit(&self.descriptor, &raw.body)?;
        let root = parse_json(&raw.body, "feishu_event")?;
        let message = json_value(&root, &["event", "message"])
            .ok_or(ChannelError::InvalidPayload("event.message"))?;
        let content_raw = json_str(message, &["content"])
            .ok_or(ChannelError::InvalidPayload("event.message.content"))?;
        let content: serde_json::Value = serde_json::from_str(content_raw)
            .map_err(|_| ChannelError::InvalidPayload("event.message.content"))?;
        let text = json_str(&content, &["text"]).unwrap_or("").to_owned();
        validate_inbound_text(&self.descriptor, &text)?;
        let external_id = json_str(message, &["message_id"])
            .or_else(|| json_str(&root, &["header", "event_id"]))
            .ok_or(ChannelError::InvalidPayload("event.message.message_id"))?;
        let sender = json_str(&root, &["event", "sender", "sender_id", "open_id"])
            .or_else(|| json_str(&root, &["event", "sender", "sender_id", "user_id"]))
            .ok_or(ChannelError::InvalidPayload("event.sender.sender_id"))?;
        Ok(ChannelEnvelope {
            channel: self.descriptor.id.clone(),
            external_id: external_id.to_owned(),
            sender: sender.to_owned(),
            text,
            attachments: message
                .get("attachments")
                .map(parse_attachments)
                .unwrap_or_default(),
            received_at_ms: raw.received_at_ms,
            thread_hint: json_str(message, &["chat_id"]).map(str::to_owned),
        })
    }

    fn render(&self, message: &OutboundMessage) -> Result<Vec<RenderedPart>, ChannelError> {
        self.check_attachments(message)?;
        let segments = split_text_bytes(&message.text, self.descriptor.limits.max_outbound_bytes);
        Ok(render_parts(segments, |index, text| {
            json!({
                "msg_type": "interactive",
                "card": {
                    "header": {"title": {"tag": "plain_text", "content": "Quetzalcoatl"}},
                    "elements": [
                        {"tag": "div", "text": {"tag": "lark_md", "content": text}},
                        {"tag": "note", "elements": [{"tag": "plain_text", "content": format!("part {index}")}]}
                    ]
                }
            })
            .to_string()
        }))
    }

    fn transport(&self) -> &dyn ChannelTransport {
        self.transport.as_ref()
    }
}
