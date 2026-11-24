use std::sync::Arc;

use serde_json::json;

use crate::{
    ChannelDescriptor, ChannelDriver, ChannelEnvelope, ChannelError, ChannelLimits,
    ChannelTransport, OutboundMessage, RawInbound, RenderedPart, TransportKind,
    enforce_inbound_limit, render_parts, split_text_bytes, validate_inbound_text, xml_tag,
};

#[must_use]
pub fn descriptor() -> ChannelDescriptor {
    ChannelDescriptor {
        id: String::from("wecom"),
        display_name: String::from("企业微信"),
        transport: TransportKind::WebSocket,
        requires_credentials: true,
        long_lived: true,
        local_only: false,
        limits: ChannelLimits {
            max_inbound_bytes: 2 * 1024 * 1024,
            max_outbound_bytes: 4096,
            max_text_chars: 4096,
            max_subject_chars: 0,
            max_attachments: 5,
            max_attachment_bytes: 20 * 1024 * 1024,
        },
    }
}

/// 企业微信回调（XML）+ 应用消息（markdown）驱动。
pub struct WeComDriver {
    descriptor: ChannelDescriptor,
    transport: Arc<dyn ChannelTransport>,
}

impl WeComDriver {
    #[must_use]
    pub fn new(transport: Arc<dyn ChannelTransport>) -> Self {
        Self {
            descriptor: descriptor(),
            transport,
        }
    }
}

impl ChannelDriver for WeComDriver {
    fn descriptor(&self) -> &ChannelDescriptor {
        &self.descriptor
    }

    fn normalize(&self, raw: &RawInbound) -> Result<ChannelEnvelope, ChannelError> {
        enforce_inbound_limit(&self.descriptor, &raw.body)?;
        let body = std::str::from_utf8(&raw.body)
            .map_err(|_| ChannelError::InvalidPayload("wecom_xml_utf8"))?;
        let external_id = xml_tag(body, "MsgId").ok_or(ChannelError::InvalidPayload("MsgId"))?;
        let sender =
            xml_tag(body, "FromUserName").ok_or(ChannelError::InvalidPayload("FromUserName"))?;
        let text = xml_tag(body, "Content").unwrap_or("");
        validate_inbound_text(&self.descriptor, text)?;
        Ok(ChannelEnvelope {
            channel: self.descriptor.id.clone(),
            external_id: external_id.to_owned(),
            sender: sender.to_owned(),
            text: text.to_owned(),
            attachments: Vec::new(),
            received_at_ms: raw.received_at_ms,
            thread_hint: xml_tag(body, "AgentID").map(str::to_owned),
        })
    }

    fn render(&self, message: &OutboundMessage) -> Result<Vec<RenderedPart>, ChannelError> {
        self.check_attachments(message)?;
        let segments = split_text_bytes(&message.text, self.descriptor.limits.max_outbound_bytes);
        Ok(render_parts(segments, |_index, text| {
            json!({"msgtype": "markdown", "markdown": {"content": text}}).to_string()
        }))
    }

    fn transport(&self) -> &dyn ChannelTransport {
        self.transport.as_ref()
    }
}
