use std::sync::Arc;

use serde_json::json;

use crate::{
    ChannelDescriptor, ChannelDriver, ChannelEnvelope, ChannelError, ChannelLimits,
    ChannelTransport, OutboundMessage, RawInbound, RenderedPart, TRUNCATION_INDICATOR,
    TransportKind, enforce_inbound_limit, render_parts, split_text_bytes, truncate_chars,
    validate_inbound_text,
};

#[must_use]
pub fn descriptor() -> ChannelDescriptor {
    ChannelDescriptor {
        id: String::from("email"),
        display_name: String::from("电子邮件"),
        transport: TransportKind::Smtp,
        requires_credentials: true,
        long_lived: false,
        local_only: false,
        limits: ChannelLimits {
            max_inbound_bytes: 10 * 1024 * 1024,
            max_outbound_bytes: 1024 * 1024,
            max_text_chars: 100_000,
            max_subject_chars: 255,
            max_attachments: 20,
            max_attachment_bytes: 25 * 1024 * 1024,
        },
    }
}

/// 电子邮件驱动（RFC 5322 头部 + 纯文本正文）。
pub struct EmailDriver {
    descriptor: ChannelDescriptor,
    transport: Arc<dyn ChannelTransport>,
}

impl EmailDriver {
    #[must_use]
    pub fn new(transport: Arc<dyn ChannelTransport>) -> Self {
        Self {
            descriptor: descriptor(),
            transport,
        }
    }
}

fn header<'a>(head: &'a str, name: &str) -> Option<&'a str> {
    head.lines().find_map(|line| {
        let (key, value) = line.split_once(':')?;
        if key.trim().eq_ignore_ascii_case(name) {
            Some(value.trim())
        } else {
            None
        }
    })
}

impl ChannelDriver for EmailDriver {
    fn descriptor(&self) -> &ChannelDescriptor {
        &self.descriptor
    }

    fn normalize(&self, raw: &RawInbound) -> Result<ChannelEnvelope, ChannelError> {
        enforce_inbound_limit(&self.descriptor, &raw.body)?;
        let text = std::str::from_utf8(&raw.body)
            .map_err(|_| ChannelError::InvalidPayload("email_utf8"))?;
        let (head, body) = text
            .split_once("\r\n\r\n")
            .or_else(|| text.split_once("\n\n"))
            .ok_or(ChannelError::InvalidPayload("email_headers"))?;
        let subject = header(head, "Subject").unwrap_or("");
        if subject.chars().count() > self.descriptor.limits.max_subject_chars {
            return Err(ChannelError::PayloadTooLarge);
        }
        let body_trimmed = body.trim_end_matches(['\r', '\n']);
        validate_inbound_text(&self.descriptor, body_trimmed)?;
        let external_id = header(head, "Message-ID")
            .or_else(|| header(head, "Message-Id"))
            .ok_or(ChannelError::InvalidPayload("Message-ID"))?;
        let sender = header(head, "From").ok_or(ChannelError::InvalidPayload("From"))?;
        let text_out = if subject.is_empty() {
            String::from(body_trimmed)
        } else {
            format!("{subject}\n\n{body_trimmed}")
        };
        validate_inbound_text(&self.descriptor, &text_out)?;
        Ok(ChannelEnvelope {
            channel: self.descriptor.id.clone(),
            external_id: external_id.trim_matches(['<', '>']).to_owned(),
            sender: sender.to_owned(),
            text: text_out,
            attachments: Vec::new(),
            received_at_ms: raw.received_at_ms,
            thread_hint: header(head, "In-Reply-To").map(|v| v.trim_matches(['<', '>']).to_owned()),
        })
    }

    fn render(&self, message: &OutboundMessage) -> Result<Vec<RenderedPart>, ChannelError> {
        self.check_attachments(message)?;
        let raw_subject = message.subject.as_deref().unwrap_or("Quetzalcoatl");
        let (subject, subject_truncated) =
            truncate_chars(raw_subject, self.descriptor.limits.max_subject_chars);
        if subject.is_empty() {
            return Err(ChannelError::InvalidPayload("subject"));
        }
        let segments = split_text_bytes(&message.text, self.descriptor.limits.max_outbound_bytes);
        let parts = render_parts(segments, |index, text| {
            let part_subject = if index == 0 {
                subject.clone()
            } else {
                format!("{subject} ({})", index + 1)
            };
            json!({"subject": part_subject, "body": text}).to_string()
        });
        Ok(parts
            .into_iter()
            .map(|mut p| {
                if p.index == 0 && subject_truncated {
                    p.truncated = true;
                }
                p
            })
            .collect())
    }

    fn transport(&self) -> &dyn ChannelTransport {
        self.transport.as_ref()
    }
}

#[must_use]
pub fn truncation_marker() -> &'static str {
    TRUNCATION_INDICATOR
}
