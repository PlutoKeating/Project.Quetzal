pub mod dingtalk;
pub mod email;
pub mod feishu;
pub mod system_intents;
pub mod telegram;
pub mod webhook;
pub mod wecom;

use std::collections::BTreeMap;
use std::sync::Arc;

use crate::{ChannelDescriptor, ChannelDriver, ChannelTransport};

#[must_use]
pub fn all_descriptors() -> Vec<ChannelDescriptor> {
    vec![
        feishu::descriptor(),
        wecom::descriptor(),
        dingtalk::descriptor(),
        telegram::descriptor(),
        email::descriptor(),
        webhook::descriptor(),
        system_intents::descriptor(),
    ]
}

#[must_use]
pub fn build_all(transport: Arc<dyn ChannelTransport>) -> BTreeMap<String, Arc<dyn ChannelDriver>> {
    let mut out: BTreeMap<String, Arc<dyn ChannelDriver>> = BTreeMap::new();
    let t = Arc::clone(&transport);
    out.insert(
        String::from("feishu"),
        Arc::new(feishu::FeishuDriver::new(t)),
    );
    let t = Arc::clone(&transport);
    out.insert(String::from("wecom"), Arc::new(wecom::WeComDriver::new(t)));
    let t = Arc::clone(&transport);
    out.insert(
        String::from("dingtalk"),
        Arc::new(dingtalk::DingTalkDriver::new(t)),
    );
    let t = Arc::clone(&transport);
    out.insert(
        String::from("telegram"),
        Arc::new(telegram::TelegramDriver::new(t)),
    );
    let t = Arc::clone(&transport);
    out.insert(String::from("email"), Arc::new(email::EmailDriver::new(t)));
    let t = Arc::clone(&transport);
    out.insert(
        String::from("webhook"),
        Arc::new(webhook::WebhookDriver::new(t)),
    );
    out.insert(
        String::from("system-intents"),
        Arc::new(system_intents::SystemIntentsDriver::new(transport)),
    );
    out
}
