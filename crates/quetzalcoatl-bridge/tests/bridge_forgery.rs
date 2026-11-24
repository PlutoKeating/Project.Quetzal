#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]

use std::error::Error;

use quetzalcoatl_bridge::{BridgeKey, BridgeRole, SpineBridge};
use quetzalcoatl_crypto::{AccountRootKey, DeviceIdentity, EpochKeyRing, PackCompartment};
use quetzalcoatl_spine::{RusqliteWalStore, SpineEngine};
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
