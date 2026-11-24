#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]

//! Task 3.3 端到端契约：
//! 1. `SayIt` v2.1 子树吸纳四条铁律（异源嵌入、角色粒度、重归属双时态失效、字节稳定）；
//! 2. `Role::Bridge` 受限键的越权写入拦截与审计；
//! 3. 七大通道监管器与 mock 传输的离线协作。

use std::error::Error;
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;

use quetzalcoatl_bridge::{BridgeKey, BridgeRole, SpineBridge};
use quetzalcoatl_capabilities::{SayItIngestor, SayItSnapshotMeta, SayItTarget, SovereignScope};
use quetzalcoatl_channels::{
    ChannelSupervisor, MockTransport, OutboundMessage, drivers_with_transport,
};
use quetzalcoatl_crypto::{AccountRootKey, DeviceIdentity, EpochKeyRing, PackCompartment};
use quetzalcoatl_daemon::ChannelRuntime;
use quetzalcoatl_ewave::{AddOptions, BranchOptions, GraphOptions, SerpentineGraph};
use quetzalcoatl_spine::{RusqliteWalStore, SpineEngine};
use quetzalcoatl_types::{AgentId, DeviceId, ErrorCode, HlcTimestamp, QuetzalcoatlError};
use uuid::Uuid;

type TestResult = Result<(), Box<dyn Error>>;

fn temp_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("qz_t33_{tag}_{}", Uuid::new_v4().simple()));
    let _ = fs::create_dir_all(&dir);
    dir
}

fn graph(emb_model_id: &str, emb_dim: usize) -> Result<SerpentineGraph, Box<dyn Error>> {
    Ok(SerpentineGraph::new(GraphOptions {
        emb_model_id: String::from(emb_model_id),
        emb_dim,
        name: Some(String::from("sayit-test")),
        ..GraphOptions::default()
    })?)
}

fn snapshot_with_role(
    emb_model_id: &str,
    emb_dim: usize,
    role: &str,
    leaf_text: &str,
) -> Result<String, Box<dyn Error>> {
    let mut g = graph(emb_model_id, emb_dim)?;
    let branch = g.add_branch(BranchOptions {
        label: Some(String::from("会诊纪要")),
        data: Some(serde_json::json!({"role": role})),
        ..BranchOptions::default()
    })?;
    g.add(
        serde_json::json!({"role": "record", "text": leaf_text}),
        AddOptions {
            text: Some(String::from(leaf_text)),
            label: Some(String::from("纪要条目")),
            parent: Some(branch.id),
            ..AddOptions::default()
        },
    )?;
    Ok(g.to_json_v2()?)
}

fn personal_target() -> SayItTarget {
    SayItTarget {
        agent_id: AgentId::new_v4(),
        scope: SovereignScope::PersonalSovereign,
    }
}

#[test]
fn sayit_foreign_embedding_offline_alignment_queues_reembed() -> TestResult {
    let target = personal_target();
    let mut ingestor = SayItIngestor::new(target.clone())?;
    let incoming = snapshot_with_role("foreign/embedder-v9", 8, "record", "异源向量条目")?;
    let receipt = ingestor.ingest_snapshot(
        &incoming,
        &SayItSnapshotMeta {
            sayit_user_hash: String::from("u_hash_1"),
            slice_id: String::from("slice_1"),
            session_id: String::from("session_1"),
            snapshot_sha256: String::from("sha_a"),
        },
        1_795_400_000_100,
        false,
    )?;
    assert!(receipt.offline_lexical_fallback, "离线必须走词法+结构对齐");
    assert!(receipt.reembedded_foreign_vectors || receipt.queued_reembed > 0);
    assert!(
        !ingestor.graph().pending_reembed_ids().is_empty(),
        "离线吸纳必须排队 reembed()"
    );
    ingestor.graph_mut().set_embedder_online(true);
    let reembedded = ingestor.graph_mut().reembed_pending()?;
    assert!(reembedded > 0, "恢复在线后必须补算规范嵌入");
    Ok(())
}

#[test]
fn sayit_branch_alignment_respects_role_granularity() -> TestResult {
    let target = personal_target();
    let mut ingestor = SayItIngestor::new(target)?;
    let project = snapshot_with_role(
        quetzalcoatl_ewave::DEFAULT_EMB_MODEL_ID,
        quetzalcoatl_ewave::DEFAULT_EMB_DIM,
        "project",
        "项目级摘要",
    )?;
    ingestor.ingest_snapshot(
        &project,
        &SayItSnapshotMeta {
            sayit_user_hash: String::from("u_hash_2"),
            slice_id: String::from("slice_2"),
            session_id: String::from("session_2"),
            snapshot_sha256: String::from("sha_project"),
        },
        1_795_400_000_200,
        true,
    )?;
    let before = ingestor
        .graph()
        .branches(None)
        .iter()
        .filter(|n| n.label.as_deref() == Some("会诊纪要"))
        .count();
    let record = snapshot_with_role(
        quetzalcoatl_ewave::DEFAULT_EMB_MODEL_ID,
        quetzalcoatl_ewave::DEFAULT_EMB_DIM,
        "record",
        "记录级摘要",
    )?;
    ingestor.ingest_snapshot(
        &record,
        &SayItSnapshotMeta {
            sayit_user_hash: String::from("u_hash_2"),
            slice_id: String::from("slice_2"),
            session_id: String::from("session_3"),
            snapshot_sha256: String::from("sha_record"),
        },
        1_795_400_000_300,
        true,
    )?;
    let after = ingestor
        .graph()
        .branches(None)
        .iter()
        .filter(|n| n.label.as_deref() == Some("会诊纪要"))
        .count();
    assert!(
        after > before,
        "role=record 与 role=project 不得跨粒度合并（before={before}, after={after}）"
    );
    Ok(())
}

#[test]
fn sayit_refile_same_session_bitemporally_invalidates_old_nodes() -> TestResult {
    let target = personal_target();
    let mut ingestor = SayItIngestor::new(target)?;
    let meta = SayItSnapshotMeta {
        sayit_user_hash: String::from("u_hash_3"),
        slice_id: String::from("slice_3"),
        session_id: String::from("session_refile"),
        snapshot_sha256: String::from("sha_v1"),
    };
    let v1 = snapshot_with_role(
        quetzalcoatl_ewave::DEFAULT_EMB_MODEL_ID,
        quetzalcoatl_ewave::DEFAULT_EMB_DIM,
        "record",
        "第一版纪要内容",
    )?;
    let first = ingestor.ingest_snapshot(&v1, &meta, 1_795_400_000_400, true)?;
    assert_eq!(first.status, "ingested_new");
    let v2 = snapshot_with_role(
        quetzalcoatl_ewave::DEFAULT_EMB_MODEL_ID,
        quetzalcoatl_ewave::DEFAULT_EMB_DIM,
        "record",
        "第二版纪要内容（用户改归属后重编译）",
    )?;
    let second = ingestor.ingest_snapshot(
        &v2,
        &SayItSnapshotMeta {
            snapshot_sha256: String::from("sha_v2"),
            ..meta.clone()
        },
        1_795_400_000_500,
        true,
    )?;
    assert_eq!(second.status, "refiled_updated");
    assert!(
        !second.invalidated_node_ids.is_empty(),
        "同 sessionId 重归属必须先双时态 invalidate 旧独占节点"
    );
    let active_old = first
        .exclusive_node_ids
        .iter()
        .filter(|id| ingestor.graph().get(id).is_some_and(|n| n.is_valid()))
        .count();
    assert_eq!(active_old, 0, "旧独占节点必须全部失效");
    Ok(())
}

#[test]
fn sayit_ingest_is_byte_stable_across_two_runs_and_rejects_shared_role_agent() -> TestResult {
    let snapshot = snapshot_with_role(
        quetzalcoatl_ewave::DEFAULT_EMB_MODEL_ID,
        quetzalcoatl_ewave::DEFAULT_EMB_DIM,
        "record",
        "确定性字节稳定条目",
    )?;
    let meta = SayItSnapshotMeta {
        sayit_user_hash: String::from("u_hash_4"),
        slice_id: String::from("slice_4"),
        session_id: String::from("session_4"),
        snapshot_sha256: String::from("sha_stable"),
    };
    let mut a = SayItIngestor::new(personal_target())?;
    a.ingest_snapshot(&snapshot, &meta, 1_795_400_000_600, true)?;
    let mut b = SayItIngestor::new(personal_target())?;
    b.ingest_snapshot(&snapshot, &meta, 1_795_400_000_600, true)?;
    assert_eq!(a.graph().to_json_v2()?, b.graph().to_json_v2()?);

    let shared = SayItIngestor::new(SayItTarget {
        agent_id: AgentId::new_v4(),
        scope: SovereignScope::SharedRole {
            group_id: String::from("group-synthetic"),
        },
    });
    let err = shared.err().ok_or("共享角色 Agent 必须拒绝 SayIt 吸纳")?;
    assert_eq!(err.code(), ErrorCode::PermissionDenied);
    Ok(())
}

fn bridge_fixture() -> Result<(SpineEngine<RusqliteWalStore>, BridgeKey), Box<dyn Error>> {
    let dir = temp_dir("bridge");
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
    Ok((
        engine,
        BridgeKey {
            role: BridgeRole::Bridge,
            agent_id,
            body_id: String::from("hermes-body-1"),
        },
    ))
}

#[test]
fn spine_bridge_rejects_every_forged_privileged_write_and_audits() -> TestResult {
    let (mut engine, key) = bridge_fixture()?;
    // 预置另一个 body 的合法事件，验证读回严格按 body 隔离。
    engine.append_event(
        PackCompartment::Core,
        r#"{"kind":"memory.observe","body":"other-body","summary":"他人记忆"}"#,
        1_795_400_000_050,
    )?;
    let own_agent = key.agent_id;
    let own_body = key.body_id.clone();
    let mut bridge = SpineBridge::new(&mut engine, key);

    bridge.append(
        "memory.observe",
        &own_body,
        r#"{"kind":"memory.observe","body":"hermes-body-1","summary":"桥接写入"}"#,
        1_795_400_000_100,
    )?;
    bridge.append(
        "journal.note",
        &own_body,
        r#"{"kind":"journal.note","body":"hermes-body-1","summary":"日志写入"}"#,
        1_795_400_000_110,
    )?;

    let forgeries = [
        ("conscience.update", own_body.clone()),
        ("SELF_CORE.promote", own_body.clone()),
        ("ROOT.override", own_body.clone()),
        ("OPERATOR.escalate", own_body.clone()),
        ("membership.add", own_body.clone()),
        ("lease.acquire", own_body.clone()),
        ("memory.observe", String::from("other-body")),
        ("journal.note", String::from("other-body")),
    ];
    for (kind, body) in &forgeries {
        let payload = format!(r#"{{"kind":"{kind}","body":"{body}","summary":"forged"}}"#);
        let err = bridge
            .append(kind, body, &payload, 1_795_400_000_200)
            .err()
            .ok_or_else(|| format!("越权写入 {kind}/{body} 必须被拒绝"))?;
        assert_eq!(err.code(), ErrorCode::PermissionDenied, "{kind}/{body}");
    }
    // 伪造 Agent 归属也必须拒绝。
    let other_agent = AgentId::new_v4();
    let err = bridge
        .append_for_agent(
            other_agent,
            "memory.observe",
            &own_body,
            r#"{"kind":"memory.observe","body":"hermes-body-1"}"#,
            1_795_400_000_210,
        )
        .err()
        .ok_or("跨 Agent 写入必须拒绝")?;
    assert_eq!(err.code(), ErrorCode::PermissionDenied);

    let events = bridge.read_own()?;
    assert_eq!(events.len(), 2, "只可读回自身 body 的 memory/journal 事件");
    assert!(events.iter().all(|e| e.body_id == own_body));
    assert!(bridge.audit_log().iter().any(|a| !a.allowed));
    assert_eq!(
        bridge.audit_log().iter().filter(|a| !a.allowed).count(),
        forgeries.len() + 1
    );

    // 审计日志不得包含正文内容。
    for entry in bridge.audit_log() {
        assert!(!entry.kind.contains("forged"));
    }
    let _ = own_agent;
    Ok(())
}

#[test]
fn channels_and_sayit_supervisor_smoke_with_mock_transport() -> TestResult {
    let transport = Arc::new(MockTransport::new());
    let mut supervisor = ChannelSupervisor::new(drivers_with_transport(
        Arc::clone(&transport) as Arc<dyn quetzalcoatl_channels::ChannelTransport>
    ));
    supervisor.enable("feishu")?;
    assert_eq!(
        supervisor.reconcile_lease(7, "device-owner"),
        vec![String::from("feishu")]
    );
    let driver = supervisor.driver("feishu").ok_or("missing feishu")?;
    let report = driver.deliver(
        "synthetic-chat",
        &OutboundMessage::text_only("通道协作测试"),
    )?;
    assert_eq!(report.parts, 1);
    assert_eq!(
        transport.sent_destinations(),
        vec![String::from("synthetic-chat")]
    );
    let _ = QuetzalcoatlError::PermissionDenied {
        detail: String::from("unused"),
    };
    Ok(())
}

#[test]
fn channel_runtime_is_opt_in_by_default_and_persists_only_enabled_ids() -> TestResult {
    let home = temp_dir("channel_runtime");
    let mut runtime = ChannelRuntime::load(&home)?;
    let initial = runtime.health();
    assert_eq!(initial.len(), 7);
    assert!(initial.iter().all(|h| !h.enabled), "默认必须全部关闭");
    let enabled = runtime.enable("feishu")?;
    assert!(enabled.enabled);
    assert!(runtime.is_enabled("feishu"));
    let reloaded = ChannelRuntime::load(&home)?;
    assert!(reloaded.is_enabled("feishu"), "显式 opt-in 必须持久化");
    assert!(!reloaded.is_enabled("telegram"));
    let mut reloaded = reloaded;
    assert!(!reloaded.disable("feishu")?.enabled);
    assert!(
        ChannelRuntime::load(&home)?
            .health()
            .iter()
            .all(|h| !h.enabled)
    );
    let _ = fs::remove_dir_all(&home);
    Ok(())
}

#[test]
fn qz_cli_surfaces_channel_and_sayit_commands() -> TestResult {
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_qz"))
        .arg("help")
        .output()?;
    assert!(output.status.success());
    let text = String::from_utf8_lossy(&output.stdout);
    assert!(text.contains("channel"));
    assert!(text.contains("sayit"));
    Ok(())
}
