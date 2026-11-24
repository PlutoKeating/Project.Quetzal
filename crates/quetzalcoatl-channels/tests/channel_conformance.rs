#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]

use std::collections::BTreeMap;
use std::error::Error;
use std::path::PathBuf;
use std::sync::Arc;

use quetzalcoatl_channels::{
    ChannelCredentials, ChannelError, ChannelSupervisor, MockTransport, OutboundMessage,
    RawInbound, TRUNCATION_INDICATOR, drivers_with_transport,
};

type TestResult = Result<(), Box<dyn Error>>;

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(std::path::Path::parent)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

#[test]
fn seven_packages_have_real_descriptors_matching_code() -> TestResult {
    let channels = drivers_with_transport(Arc::new(MockTransport::new()));
    assert_eq!(channels.len(), 7, "必须交付七大标准通道族");
    for (id, driver) in &channels {
        let path = repo_root()
            .join("packages/channels")
            .join(id)
            .join("channel.json");
        let raw = std::fs::read_to_string(&path)?;
        let from_disk: quetzalcoatl_channels::ChannelDescriptor = serde_json::from_str(&raw)?;
        assert_eq!(&from_disk, driver.descriptor(), "描述符与代码不一致: {id}");
        assert_eq!(from_disk.id, *id);
    }
    let local = channels
        .get("system-intents")
        .ok_or("缺少 system-intents")?
        .descriptor();
    assert!(local.local_only && !local.requires_credentials);
    assert!(channels["feishu"].descriptor().long_lived);
    assert!(channels["wecom"].descriptor().long_lived);
    assert!(channels["dingtalk"].descriptor().long_lived);
    Ok(())
}

struct Fixture {
    id: &'static str,
    inbound: &'static str,
    expected_text: &'static str,
    expected_sender: &'static str,
}

const FIXTURES: &[Fixture] = &[
    Fixture {
        id: "feishu",
        inbound: r#"{"header":{"event_id":"ev_feishu_1"},"event":{"sender":{"sender_id":{"open_id":"ou_feishu"}},"message":{"message_id":"om_1","chat_id":"oc_1","content":"{\"text\":\"飞书合成消息\"}"}}}"#,
        expected_text: "飞书合成消息",
        expected_sender: "ou_feishu",
    },
    Fixture {
        id: "wecom",
        inbound: "<xml><MsgId>wx_1</MsgId><FromUserName>user_wecom</FromUserName><AgentID>agent_1</AgentID><Content><![CDATA[企业微信合成消息]]></Content></xml>",
        expected_text: "企业微信合成消息",
        expected_sender: "user_wecom",
    },
    Fixture {
        id: "dingtalk",
        inbound: r#"{"msgId":"ding_1","senderId":"user_ding","conversationId":"cid_1","text":{"content":"钉钉合成消息"}}"#,
        expected_text: "钉钉合成消息",
        expected_sender: "user_ding",
    },
    Fixture {
        id: "telegram",
        inbound: r#"{"update_id":9001,"message":{"message_id":77,"from":{"id":12345,"username":"tg_user"},"chat":{"id":12345},"text":"Telegram 合成消息"}}"#,
        expected_text: "Telegram 合成消息",
        expected_sender: "12345",
    },
    Fixture {
        id: "email",
        inbound: "From: Alice <alice@example.test>\r\nSubject: Synthetic\r\nMessage-ID: <msg-1@example.test>\r\n\r\n邮件正文合成内容",
        expected_text: "Synthetic\n\n邮件正文合成内容",
        expected_sender: "Alice <alice@example.test>",
    },
    Fixture {
        id: "webhook",
        inbound: r#"{"event_id":"wh_1","sender":"wh_user","text":"Webhook 合成消息","thread_hint":"t-1"}"#,
        expected_text: "Webhook 合成消息",
        expected_sender: "wh_user",
    },
    Fixture {
        id: "system-intents",
        inbound: r#"{"intent_id":"intent_1","text":"本地系统合成意图","thread_hint":"local"}"#,
        expected_text: "本地系统合成意图",
        expected_sender: "local-system",
    },
];

#[test]
fn all_channels_normalize_inbound_fixtures_and_enforce_limits() -> TestResult {
    let channels = drivers_with_transport(Arc::new(MockTransport::new()));
    for fixture in FIXTURES {
        let driver = channels.get(fixture.id).ok_or("missing channel")?;
        let envelope = driver.normalize(&RawInbound::new(
            fixture.inbound.as_bytes(),
            1_795_400_000_000,
        ))?;
        assert_eq!(envelope.channel, fixture.id);
        assert_eq!(envelope.text, fixture.expected_text);
        assert_eq!(envelope.sender, fixture.expected_sender);
        assert!(!envelope.external_id.is_empty());

        let oversized = vec![b'x'; driver.descriptor().limits.max_inbound_bytes + 1];
        let err = driver
            .normalize(&RawInbound::new(oversized, 1_795_400_000_000))
            .err()
            .ok_or("oversized inbound must be rejected")?;
        assert_eq!(err, ChannelError::PayloadTooLarge, "{}", fixture.id);
    }
    Ok(())
}

#[test]
fn outbound_limits_split_with_visible_indicator_never_silent_loss() -> TestResult {
    let channels = drivers_with_transport(Arc::new(MockTransport::new()));
    for fixture in FIXTURES {
        let driver = channels.get(fixture.id).ok_or("missing channel")?;
        let limits = &driver.descriptor().limits;
        let text_len = limits.max_text_chars.max(limits.max_outbound_bytes) * 2 + 17;
        let long_text: String = std::iter::repeat_n('灵', text_len).collect();
        let parts = driver.render(&OutboundMessage::text_only(long_text.clone()))?;
        assert!(parts.len() >= 2, "{} 超限必须显式分片", fixture.id);
        let mut saw_indicator = false;
        for part in &parts {
            assert!(
                part.payload.len() <= limits.max_outbound_bytes + 1024,
                "{} 片段超出字节上限",
                fixture.id
            );
            if part.truncated {
                saw_indicator = part.payload.contains(TRUNCATION_INDICATOR);
            }
        }
        assert!(
            saw_indicator,
            "{} 截断片段必须携带可见标记，绝不静默丢字",
            fixture.id
        );

        let transport = MockTransport::new();
        let driver = quetzalcoatl_channels::drivers_with_transport(Arc::new(transport));
        let report = driver.get(fixture.id).ok_or("missing")?.deliver(
            "synthetic-destination",
            &OutboundMessage::text_only(long_text),
        )?;
        assert!(report.parts >= 2);
    }
    Ok(())
}

#[test]
fn supervisor_moves_long_lived_channel_ownership_with_witness_epoch() -> TestResult {
    let transport = Arc::new(MockTransport::new());
    let mut supervisor = ChannelSupervisor::new(quetzalcoatl_channels::drivers_with_transport(
        Arc::clone(&transport) as Arc<dyn quetzalcoatl_channels::ChannelTransport>,
    ));
    supervisor.enable("feishu")?;
    supervisor.enable("system-intents")?;
    assert!(supervisor.is_enabled("feishu"));
    assert!(!supervisor.is_enabled("webhook"));

    assert_eq!(
        supervisor.reconcile_lease(1, "device-a"),
        vec![String::from("feishu")]
    );
    assert_eq!(
        supervisor.reconcile_lease(1, "device-a"),
        Vec::<String>::new()
    );
    assert_eq!(
        supervisor.reconcile_lease(2, "device-b"),
        vec![String::from("feishu")]
    );
    assert!(transport.is_closed(), "租约漂移必须先关闭旧长连接");
    let health = supervisor.health();
    let feishu = health
        .iter()
        .find(|h| h.channel == "feishu")
        .ok_or("missing health")?;
    assert_eq!(feishu.bound_witness_epoch, Some(2));
    assert_eq!(feishu.holder_device_id.as_deref(), Some("device-b"));

    assert!(supervisor.disable("feishu")?);
    assert!(supervisor.reconcile_lease(2, "").is_empty());
    Ok(())
}

#[test]
fn credentials_are_redacted_in_debug_and_never_in_errors() -> TestResult {
    let mut values = BTreeMap::new();
    values.insert(
        String::from("token"),
        String::from("CANARY-CHANNEL-TOKEN-998877"),
    );
    let creds = ChannelCredentials::new("telegram", values);
    let debug = format!("{creds:?}");
    assert!(!debug.contains("CANARY-CHANNEL-TOKEN-998877"));
    assert!(debug.contains("[REDACTED]"));
    let err = ChannelError::MissingCredential(String::from("telegram"));
    assert!(!err.to_string().contains("CANARY-CHANNEL-TOKEN-998877"));
    Ok(())
}

#[test]
fn outbound_request_builder_templates_urls_headers_and_tokens() -> TestResult {
    use quetzalcoatl_channels::{ChannelCredentials, build_http_request};

    let mut tg = BTreeMap::new();
    tg.insert(String::from("token"), String::from("123:ABC"));
    let spec = build_http_request(
        "telegram",
        &ChannelCredentials::new("telegram", tg),
        "-10042",
        r#"{"text":"hi"}"#,
    )?;
    assert_eq!(spec.url, "https://api.telegram.org/bot123:ABC/sendMessage");
    assert!(spec.body.contains("\"chat_id\":\"-10042\""));

    let mut feishu = BTreeMap::new();
    feishu.insert(String::from("token"), String::from("tenant-token"));
    feishu.insert(
        String::from("url"),
        String::from("https://open.feishu.cn/open-apis/bot/v2/hook/synthetic"),
    );
    let spec = build_http_request(
        "feishu",
        &ChannelCredentials::new("feishu", feishu),
        "",
        "{}",
    )?;
    assert_eq!(
        spec.headers.get("Authorization").map(String::as_str),
        Some("Bearer tenant-token")
    );
    assert!(spec.url.ends_with("/hook/synthetic"));

    let mut ding = BTreeMap::new();
    ding.insert(String::from("access_token"), String::from("ding-token"));
    ding.insert(String::from("secret"), String::from("ding-secret"));
    ding.insert(String::from("timestamp_ms"), String::from("1795400000000"));
    let spec = build_http_request(
        "dingtalk",
        &ChannelCredentials::new("dingtalk", ding),
        "",
        "{}",
    )?;
    assert!(
        spec.url
            .starts_with("https://oapi.dingtalk.com/robot/send?access_token=ding-token")
    );
    assert!(spec.url.contains("timestamp=1795400000000"));
    assert!(spec.url.contains("sign="));

    let mut wh = BTreeMap::new();
    wh.insert(
        String::from("url"),
        String::from("https://example.test/hook"),
    );
    wh.insert(String::from("secret"), String::from("hook-secret"));
    let spec = build_http_request(
        "webhook",
        &ChannelCredentials::new("webhook", wh),
        "",
        r#"{"event_id":"out"}"#,
    )?;
    let sig = spec
        .headers
        .get("X-QZ-Signature")
        .ok_or("missing signature")?;
    use hmac::{Hmac, Mac};
    use sha2::Sha256;
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(b"hook-secret")?;
    mac.update(br#"{"event_id":"out"}"#);
    let mut want = String::from("sha256=");
    for byte in mac.finalize().into_bytes() {
        want.push_str(&format!("{byte:02x}"));
    }
    assert_eq!(sig, &want);
    Ok(())
}

#[test]
fn outbound_request_builder_fails_closed_without_credentials() -> TestResult {
    use quetzalcoatl_channels::{ChannelCredentials, ChannelError, build_http_request};
    let empty = ChannelCredentials::new("webhook", BTreeMap::new());
    let err = build_http_request("webhook", &empty, "", "{}")
        .err()
        .ok_or("missing webhook url must fail")?;
    assert!(matches!(err, ChannelError::MissingCredential(_)));
    let err = build_http_request("email", &empty, "", "{}")
        .err()
        .ok_or("email SMTP transport is not wired")?;
    assert_eq!(err, ChannelError::TransportUnavailable);
    Ok(())
}
