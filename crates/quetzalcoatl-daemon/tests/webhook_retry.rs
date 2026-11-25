#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]

use std::error::Error;

use quetzalcoatl_crypto::{
    AccountRootKey, DeviceIdentity, EpochKeyRing, WEBHOOK_INGRESS_INFO, hex_encode, hpke_xwing_seal,
};
use quetzalcoatl_daemon::{ChannelIngressKey, ChannelRuntime};
use quetzalcoatl_fabric::WebhookIngressEnvelope;
use quetzalcoatl_spine::{MaterializedStore, RusqliteWalStore, SpineEngine};
use quetzalcoatl_types::{AgentId, DeviceId, HlcTimestamp};
use uuid::Uuid;

type TestResult = Result<(), Box<dyn Error>>;

type Fixture = (
    SpineEngine<RusqliteWalStore>,
    ChannelIngressKey,
    ChannelRuntime,
    std::path::PathBuf,
    std::path::PathBuf,
);

fn fixture() -> Result<Fixture, Box<dyn Error>> {
    let home = std::env::temp_dir().join(format!("qz_wretry_{}", Uuid::new_v4().simple()));
    std::fs::create_dir_all(&home)?;
    let data = home.join("data");
    std::fs::create_dir_all(&data)?;
    let agent_id = AgentId::new_v4();
    let root = AccountRootKey::generate()?;
    let device = DeviceIdentity::generate(DeviceId::new_v4())?;
    let ring = EpochKeyRing::new_genesis(agent_id, &root, device.public_record())?;
    let epoch_key = ring.current_epoch_key().cloned().ok_or("epoch key")?;
    let store = RusqliteWalStore::open(&data.join("spine.sqlite"))?;
    let engine = SpineEngine::new(
        agent_id,
        device.clone(),
        ring,
        HlcTimestamp::from_parts(1_795_400_000_000, 0, device.device_id().hlc_node_tag()),
        store,
    )?;
    let key = ChannelIngressKey::load_or_derive(&home, &epoch_key, device.device_id())?;
    let runtime = ChannelRuntime::load(&home)?;
    Ok((engine, key, runtime, home, data))
}

fn envelope(
    key: &ChannelIngressKey,
    event_id: &str,
    body: &[u8],
) -> Result<WebhookIngressEnvelope, Box<dyn Error>> {
    let aad = r#"{"agent_id":"018f4a90-7c20-4d31-8b12-9a0b1c2d3e4f","channel":"webhook","received_at_ms":1795400000000}"#;
    let sealed = hpke_xwing_seal(key.public_key(), WEBHOOK_INGRESS_INFO, aad.as_bytes(), body)?;
    Ok(WebhookIngressEnvelope {
        event_id: String::from(event_id),
        cursor: 1,
        target_device_id: String::new(),
        channel: String::from("webhook"),
        received_at_ms: 1_795_400_000_000,
        enc_hex: hex_encode(&sealed.enc),
        ciphertext_hex: hex_encode(&sealed.ciphertext),
        aad_json: String::from(aad),
    })
}

#[test]
fn sealed_plaintext_is_decrypted_normalized_and_persisted_as_channel_message() -> TestResult {
    let (mut engine, key, runtime, home, _data) = fixture()?;
    let body = br#"{"event_id":"ev_pipeline","sender":"ou_synthetic","text":"pipeline body"}"#;
    let envelopes = vec![envelope(&key, "ev_pipeline_hash", body)?];
    let (ack, report) = quetzalcoatl_daemon::webhook::decrypt_and_persist(
        &mut engine,
        &key,
        &runtime,
        &home,
        &envelopes,
        1_795_400_000_100,
    );
    assert_eq!(report.persisted, 1, "{report:?}");
    assert_eq!(ack.len(), 1);
    let payloads: Vec<String> = engine
        .store()
        .list_all_events()?
        .into_iter()
        .map(|(e, _)| e.payload_utf8)
        .collect();
    assert!(
        payloads
            .iter()
            .any(|p| p.contains("channel.ingress.sealed"))
    );
    let decoded = payloads
        .iter()
        .find(|p| p.contains("channel.message"))
        .ok_or("missing channel.message")?;
    assert!(decoded.contains("pipeline body"));
    assert!(decoded.contains("ou_synthetic"));
    Ok(())
}

#[test]
fn corrupt_ciphertext_dead_letters_after_bounded_retries_instead_of_blocking() -> TestResult {
    let (mut engine, key, runtime, home, _data) = fixture()?;
    let mut bad = envelope(&key, "ev_bad_hash", b"{}")?;
    bad.ciphertext_hex = hex_encode(&[0u8; 24]);
    let mut last = None;
    for attempt in 0..3 {
        let (ack, report) = quetzalcoatl_daemon::webhook::decrypt_and_persist(
            &mut engine,
            &key,
            &runtime,
            &home,
            std::slice::from_ref(&bad),
            1_795_400_000_200 + attempt,
        );
        last = Some((ack, report));
    }
    let (ack, report) = last.ok_or("missing last report")?;
    assert_eq!(report.persisted, 0);
    assert_eq!(report.dead_lettered, 1);
    assert_eq!(ack.len(), 1, "dead letter must be acked to unblock queue");
    assert!(report.failures.iter().all(|f| f.dead_lettered));
    let dead = engine
        .store()
        .list_all_events()?
        .into_iter()
        .any(|(e, _)| e.payload_utf8.contains("channel.dead_letter"));
    assert!(dead, "dead letter audit event must be persisted");
    Ok(())
}

#[test]
fn legacy_empty_target_row_uses_device_identity_key_once_and_audits() -> TestResult {
    let (mut engine, key, runtime, home, _data) = fixture()?;
    let legacy_device = engine.local_device().clone();
    let aad = r#"{"agent_id":"018f4a90-7c20-4d31-8b12-9a0b1c2d3e4f","channel":"webhook","received_at_ms":1795400000000}"#;
    let body = br#"{"event_id":"ev_legacy","sender":"ou_legacy","text":"legacy payload"}"#;
    let sealed = hpke_xwing_seal(
        legacy_device.xwing_public_key(),
        WEBHOOK_INGRESS_INFO,
        aad.as_bytes(),
        body,
    )?;
    let envelope = WebhookIngressEnvelope {
        event_id: String::from("ev_legacy_hash"),
        cursor: 7,
        target_device_id: String::new(),
        channel: String::from("webhook"),
        received_at_ms: 1_795_400_000_000,
        enc_hex: hex_encode(&sealed.enc),
        ciphertext_hex: hex_encode(&sealed.ciphertext),
        aad_json: String::from(aad),
    };
    let (ack, report) = quetzalcoatl_daemon::webhook::decrypt_and_persist(
        &mut engine,
        &key,
        &runtime,
        &home,
        &[envelope],
        1_795_400_000_300,
    );
    assert_eq!(
        report.persisted, 1,
        "legacy device key fallback must succeed: {report:?}"
    );
    assert_eq!(ack.len(), 1);
    let payloads: Vec<String> = engine
        .store()
        .list_all_events()?
        .into_iter()
        .map(|(e, _)| e.payload_utf8)
        .collect();
    assert!(
        payloads
            .iter()
            .any(|p| p.contains("channel.legacy_ingress_key"))
    );
    Ok(())
}
