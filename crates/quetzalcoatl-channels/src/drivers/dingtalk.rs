use std::sync::Arc;

use serde_json::json;

use crate::{
    ChannelDescriptor, ChannelDriver, ChannelEnvelope, ChannelError, ChannelLimits,
    ChannelTransport, OutboundMessage, RawInbound, RenderedPart, TransportKind,
    enforce_inbound_limit, json_str, parse_json, render_parts, split_text_bytes,
    validate_inbound_text,
};

#[must_use]
pub fn descriptor() -> ChannelDescriptor {
    ChannelDescriptor {
        id: String::from("dingtalk"),
        display_name: String::from("钉钉"),
        transport: TransportKind::WebSocket,
        requires_credentials: true,
        long_lived: true,
        local_only: false,
        limits: ChannelLimits {
            max_inbound_bytes: 2 * 1024 * 1024,
            max_outbound_bytes: 20_000,
            max_text_chars: 20_000,
            max_subject_chars: 0,
            max_attachments: 5,
            max_attachment_bytes: 20 * 1024 * 1024,
        },
    }
}

/// 钉钉机器人驱动。
pub struct DingTalkDriver {
    descriptor: ChannelDescriptor,
    transport: Arc<dyn ChannelTransport>,
}

impl DingTalkDriver {
    #[must_use]
    pub fn new(transport: Arc<dyn ChannelTransport>) -> Self {
        Self {
            descriptor: descriptor(),
            transport,
        }
    }
}

impl ChannelDriver for DingTalkDriver {
    fn descriptor(&self) -> &ChannelDescriptor {
        &self.descriptor
    }

    fn normalize(&self, raw: &RawInbound) -> Result<ChannelEnvelope, ChannelError> {
        enforce_inbound_limit(&self.descriptor, &raw.body)?;
        let root = parse_json(&raw.body, "dingtalk_event")?;
        let text = json_str(&root, &["text", "content"])
            .or_else(|| json_str(&root, &["content"]))
            .unwrap_or("");
        validate_inbound_text(&self.descriptor, text)?;
        let external_id =
            json_str(&root, &["msgId"]).ok_or(ChannelError::InvalidPayload("msgId"))?;
        let sender = json_str(&root, &["senderId"])
            .or_else(|| json_str(&root, &["senderStaffId"]))
            .ok_or(ChannelError::InvalidPayload("senderId"))?;
        Ok(ChannelEnvelope {
            channel: self.descriptor.id.clone(),
            external_id: external_id.to_owned(),
            sender: sender.to_owned(),
            text: text.to_owned(),
            attachments: Vec::new(),
            received_at_ms: raw.received_at_ms,
            thread_hint: json_str(&root, &["conversationId"]).map(str::to_owned),
        })
    }

    fn render(&self, message: &OutboundMessage) -> Result<Vec<RenderedPart>, ChannelError> {
        self.check_attachments(message)?;
        let segments = split_text_bytes(&message.text, self.descriptor.limits.max_outbound_bytes);
        Ok(render_parts(segments, |_index, text| {
            json!({"msgtype": "markdown", "markdown": {"title": "Quetzalcoatl", "text": text}})
                .to_string()
        }))
    }

    fn transport(&self) -> &dyn ChannelTransport {
        self.transport.as_ref()
    }
}
