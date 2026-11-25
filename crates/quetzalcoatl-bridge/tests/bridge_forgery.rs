#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]

use std::error::Error;

use quetzalcoatl_bridge::{BridgeKey, BridgeRole, SpineBridge};
use quetzalcoatl_crypto::{AccountRootKey, DeviceIdentity, EpochKeyRing, PackCompartment};
use quetzalcoatl_spine::{MaterializedStore, RusqliteWalStore, SpineEngine};
use quetzalcoatl_types::{AgentId, DeviceId, ErrorCode, HlcTimestamp};
use uuid::Uuid;

type TestResult = Result<(), Box<dyn Error>>;

fn engine() -> Result<(SpineEngine<RusqliteWalStore>, AgentId), Box<dyn Error>> {
    let dir = std::env::temp_dir().join(format!("qz_bridge_{}", Uuid::new_v4().simple()));
    std::fs::create_dir_all(&dir)?;
    let agent_id = AgentId::new_v4();
    let root = AccountRootKey::generate()?;
    let device = DeviceIdentity::generate(DeviceId::new_v4())?;
    let ring = EpochKeyRing::new_genesis(agent_id, &root, device.public_record())?;
    let store = RusqliteWalStore::open(&dir.join("spine.sqlite"))?;
    let engine = SpineEngine::new(
        agent_id,
        device.clone(),
        ring,
        HlcTimestamp::from_parts(1_795_400_000_000, 0, device.device_id().hlc_node_tag()),
        store,
    )?;
    Ok((engine, agent_id))
}

#[test]
fn bridge_allows_only_own_body_memory_and_journal() -> TestResult {
    let (mut engine, agent_id) = engine()?;
    engine.append_event(
        PackCompartment::Core,
        r#"{"kind":"memory.observe","body":"other-body"}"#,
        1,
    )?;
    let key = BridgeKey {
        role: BridgeRole::Bridge,
        agent_id,
        body_id: String::from("hermes-1"),
    };
    let mut bridge = SpineBridge::new(&mut engine, key);
    bridge.append(
        "memory.observe",
        "hermes-1",
        r#"{"kind":"memory.observe","body":"hermes-1","summary":"ok"}"#,
        2,
    )?;
    bridge.append(
        "journal.note",
        "hermes-1",
        r#"{"kind":"journal.note","body":"hermes-1","summary":"ok"}"#,
        3,
    )?;
    let own = bridge.read_own()?;
    assert_eq!(own.len(), 2);
    assert!(own.iter().all(|e| e.body_id == "hermes-1"));
    assert_eq!(bridge.audit_log().len(), 2);
    assert!(bridge.audit_log().iter().all(|a| a.allowed));
    Ok(())
}

#[test]
fn bridge_rejects_conscience_self_root_operator_membership_lease_and_other_body() -> TestResult {
    let (mut engine, agent_id) = engine()?;
    let key = BridgeKey {
        role: BridgeRole::Bridge,
        agent_id,
        body_id: String::from("hermes-1"),
    };
    let mut bridge = SpineBridge::new(&mut engine, key);
    let forgeries = [
        "conscience.update",
        "SELF_CORE.promote",
        "SELF_SOFT.evolve",
        "ROOT.override",
        "OPERATOR.escalate",
        "membership.add",
        "lease.acquire",
        "steward.grant",
        "group.rotate",
    ];
    for kind in forgeries {
        let payload = format!(r#"{{"kind":"{kind}","body":"hermes-1"}}"#);
        let err = bridge
            .append(kind, "hermes-1", &payload, 10)
            .err()
            .ok_or_else(|| format!("{kind} 必须被拒绝"))?;
        assert_eq!(err.code(), ErrorCode::PermissionDenied, "{kind}");
    }
    for body in ["other-body", "hermes-2"] {
        let err = bridge
            .append(
                "memory.observe",
                body,
                r#"{"kind":"memory.observe","body":"other-body"}"#,
                11,
            )
            .err()
            .ok_or("其他 body 必须被拒绝")?;
        assert_eq!(err.code(), ErrorCode::PermissionDenied);
    }
    let err = bridge
        .append_for_agent(
            AgentId::new_v4(),
            "journal.note",
            "hermes-1",
            r#"{"kind":"journal.note","body":"hermes-1"}"#,
            12,
        )
        .err()
        .ok_or("其他 Agent 必须被拒绝")?;
    assert_eq!(err.code(), ErrorCode::PermissionDenied);

    assert!(bridge.read_own()?.is_empty());
    let denied = bridge.audit_log().iter().filter(|a| !a.allowed).count();
    assert_eq!(denied, forgeries.len() + 3);
    assert!(
        bridge
            .audit_log()
            .iter()
            .all(|a| !a.reason.contains("hermes-2"))
    );
    Ok(())
}

#[test]
fn bridge_rejects_payload_body_and_agent_forgery() -> TestResult {
    let (mut engine, agent_id) = engine()?;
    let key = BridgeKey {
        role: BridgeRole::Bridge,
        agent_id,
        body_id: String::from("hermes-1"),
    };
    let mut bridge = SpineBridge::new(&mut engine, key);
    let forged_body = r#"{"kind":"memory.observe","body":"other-body"}"#;
    assert_eq!(
        bridge
            .append("memory.observe", "hermes-1", forged_body, 20)
            .err()
            .ok_or("payload body 伪造必须拒绝")?
            .code(),
        ErrorCode::PermissionDenied
    );
    let forged_kind = r#"{"kind":"conscience.update","body":"hermes-1"}"#;
    assert_eq!(
        bridge
            .append("memory.observe", "hermes-1", forged_kind, 21)
            .err()
            .ok_or("payload kind 伪造必须拒绝")?
            .code(),
        ErrorCode::PermissionDenied
    );
    assert_eq!(bridge.audit_log().iter().filter(|a| !a.allowed).count(), 2);
    Ok(())
}

#[test]
fn bridge_audit_never_contains_payload_text() -> TestResult {
    let (mut engine, agent_id) = engine()?;
    let key = BridgeKey {
        role: BridgeRole::Bridge,
        agent_id,
        body_id: String::from("hermes-1"),
    };
    let mut bridge = SpineBridge::new(&mut engine, key);
    let canary_body = "CANARY-BRIDGE-BODY-998877";
    let payload =
        format!(r#"{{"kind":"memory.observe","body":"hermes-1","summary":"{canary_body}"}}"#);
    bridge.append("memory.observe", "hermes-1", &payload, 30)?;
    let audit = format!("{:?}", bridge.audit_log());
    assert!(!audit.contains(canary_body), "审计日志绝不可包含正文");
    Ok(())
}

#[test]
fn bridge_rejects_payload_level_forgery_at_any_depth() -> TestResult {
    let (mut engine, agent_id) = engine()?;
    let key = BridgeKey {
        role: BridgeRole::Bridge,
        agent_id,
        body_id: String::from("hermes-1"),
    };
    let mut bridge = SpineBridge::new(&mut engine, key);
    let cases = [
        r#"{"kind":"memory.observe","summary":"missing body"}"#,
        r#"{"body":"hermes-1","summary":"missing kind"}"#,
        r#"{"kind":"memory.observe","body":"other-body"}"#,
        r#"{"kind":"memory.observe","body":"hermes-1","payload":{"conscience":"override"}}"#,
        r#"{"kind":"memory.observe","body":"hermes-1","payload":{"nested":{"SELF_CORE":"promote"}}}"#,
        r#"{"kind":"memory.observe","body":"hermes-1","payload":{"deep":[[[{"root":"escalate"}]]]}}"#,
        r#"{"kind":"memory.observe","body":"hermes-1","payload":{"relationship":"owner"}}"#,
        r#"{"kind":"memory.observe","body":"hermes-1","payload":{"path":"/etc/passwd"}}"#,
        r#"{"kind":"memory.observe","body":"hermes-1","api_key":"sk-live-canary"}"#,
    ];
    for payload in cases {
        let err = bridge
            .append("memory.observe", "hermes-1", payload, 40)
            .err()
            .ok_or_else(|| format!("payload forgery must be denied: {payload}"))?;
        assert_eq!(err.code(), ErrorCode::PermissionDenied, "{payload}");
    }
    assert_eq!(
        bridge.audit_log().iter().filter(|a| !a.allowed).count(),
        cases.len()
    );
    let audit = format!("{:?}", bridge.audit_log());
    assert!(!audit.contains("sk-live-canary"));
    assert!(!audit.contains("/etc/passwd"));
    assert!(bridge.read_own()?.is_empty());
    Ok(())
}

#[test]
fn bridge_events_are_isolated_in_external_channel_compartment() -> TestResult {
    let (mut engine, agent_id) = engine()?;
    engine.append_event(
        PackCompartment::Core,
        r#"{"kind":"memory.observe","body":"other-body"}"#,
        50,
    )?;
    let key = BridgeKey {
        role: BridgeRole::Bridge,
        agent_id,
        body_id: String::from("hermes-1"),
    };
    {
        let mut bridge = SpineBridge::new(&mut engine, key);
        bridge.append(
            "journal.note",
            "hermes-1",
            r#"{"kind":"journal.note","body":"hermes-1","summary":"ok"}"#,
            51,
        )?;
    }
    let mut saw_bridge_external = false;
    for (event, compartment) in engine.store().list_all_events()? {
        if event.payload_utf8.contains("hermes-1") {
            assert_eq!(compartment, PackCompartment::ExternalChannel);
            saw_bridge_external = true;
        }
        if event.payload_utf8.contains("other-body") {
            assert_eq!(compartment, PackCompartment::Core);
        }
    }
    assert!(saw_bridge_external);
    Ok(())
}

#[test]
fn bridge_allows_benign_prose_containing_authority_words() -> TestResult {
    let (mut engine, agent_id) = engine()?;
    let key = BridgeKey {
        role: BridgeRole::Bridge,
        agent_id,
        body_id: String::from("hermes-1"),
    };
    let mut bridge = SpineBridge::new(&mut engine, key);
    let payload = format!(
        r#"{{"kind":"memory.observe","body":"hermes-1","summary":"root cause analysis of the group chat lease renewal relationship note","agent_id":"{agent_id}"}}"#
    );
    bridge.append("memory.observe", "hermes-1", &payload, 60)?;
    assert_eq!(bridge.read_own()?.len(), 1);
    Ok(())
}

#[test]
fn bridge_reads_legacy_core_events_for_own_agent_and_body_only() -> TestResult {
    let (mut engine, agent_id) = engine()?;
    let legacy_own = format!(
        r#"{{"kind":"journal.note","body":"hermes-1","agent_id":"{agent_id}","summary":"legacy"}}"#
    );
    engine.append_event(PackCompartment::Core, &legacy_own, 70)?;
    engine.append_event(
        PackCompartment::Core,
        r#"{"kind":"journal.note","body":"hermes-1","agent_id":"other-agent","summary":"legacy other"}"#,
        71,
    )?;
    let key = BridgeKey {
        role: BridgeRole::Bridge,
        agent_id,
        body_id: String::from("hermes-1"),
    };
    let bridge = SpineBridge::new(&mut engine, key);
    let own = bridge.read_own()?;
    assert_eq!(
        own.len(),
        1,
        "legacy Core rows only readable for own agent/body"
    );
    assert_eq!(own[0].kind, "journal.note");
    Ok(())
}

#[test]
fn bridge_rejects_embedded_secret_markers_and_absolute_path_tokens() -> TestResult {
    let (mut engine, agent_id) = engine()?;
    let key = BridgeKey {
        role: BridgeRole::Bridge,
        agent_id,
        body_id: String::from("hermes-1"),
    };
    let mut bridge = SpineBridge::new(&mut engine, key);
    let cases = [
        r#"{"kind":"memory.observe","body":"hermes-1","note":"note: -----BEGIN RSA PRIVATE KEY----- abc"}"#,
        r#"{"kind":"memory.observe","body":"hermes-1","note":"token sk-abc"}"#,
        r#"{"kind":"memory.observe","body":"hermes-1","note":"/etc/passwd is here"}"#,
        r#"{"kind":"memory.observe","body":"hermes-1","note":"see C:\\Windows\\system32"}"#,
        r#"{"kind":"memory.observe","body":"hermes-1","note":"ghp_abcdef"}"#,
    ];
    for payload in cases {
        let err = bridge
            .append("memory.observe", "hermes-1", payload, 80)
            .err()
            .ok_or_else(|| format!("embedded secret/path must be denied: {payload}"))?;
        assert_eq!(err.code(), ErrorCode::PermissionDenied);
    }
    let benign = r#"{"kind":"memory.observe","body":"hermes-1","note":"root cause of group chat lease renewal relationship"}"#;
    bridge.append("memory.observe", "hermes-1", benign, 81)?;
    assert_eq!(bridge.read_own()?.len(), 1);
    Ok(())
}
