#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]

//! SayIt v2.1 四条交接规则的独立契约测试（合成快照夹具，零真实数据）。

use std::error::Error;
use std::path::{Path, PathBuf};

use quetzalcoatl_capabilities::{SayItIngestor, SayItSnapshotMeta, SayItTarget, SovereignScope};
use quetzalcoatl_types::{AgentId, ErrorCode};

type TestResult = Result<(), Box<dyn Error>>;

fn fixtures() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}

fn personal() -> SayItTarget {
    SayItTarget {
        agent_id: AgentId::new_v4(),
        scope: SovereignScope::PersonalSovereign,
    }
}

fn read(path: &Path) -> Result<String, Box<dyn Error>> {
    Ok(std::fs::read_to_string(path)?)
}

#[test]
fn rule1_foreign_embedding_offline_fallback_and_queued_reembed() -> TestResult {
    let path = fixtures().join("u/demo/subtrees/slice-a/session-a.ewave.json");
    let mut ingestor = SayItIngestor::new(personal())?;
    let receipt = ingestor.ingest_file(&path, 1_795_400_000_100, false)?;
    assert!(receipt.offline_lexical_fallback);
    assert!(receipt.queued_reembed > 0);
    assert!(!ingestor.graph().pending_reembed_ids().is_empty());
    ingestor.graph_mut().set_embedder_online(true);
    assert!(ingestor.graph_mut().reembed_pending()? > 0);
    Ok(())
}

#[test]
fn rule2_role_granularity_blocks_project_record_cross_merge() -> TestResult {
    let mut ingestor = SayItIngestor::new(personal())?;
    let project = fixtures().join("u/demo/subtrees/slice-a/session-b.ewave.json");
    ingestor.ingest_file(&project, 1_795_400_000_200, true)?;
    let before = ingestor
        .graph()
        .branches(None)
        .iter()
        .filter(|n| n.label.as_deref() == Some("会诊纪要"))
        .count();
    let record = fixtures().join("u/demo/subtrees/slice-a/session-c.ewave.json");
    ingestor.ingest_file(&record, 1_795_400_000_300, true)?;
    let after = ingestor
        .graph()
        .branches(None)
        .iter()
        .filter(|n| n.label.as_deref() == Some("会诊纪要"))
        .count();
    assert!(after > before, "project 与 record 不得跨粒度合并");
    Ok(())
}

#[test]
fn rule3_refile_same_session_invalidates_before_merge() -> TestResult {
    let v1_path = fixtures().join("u/demo/subtrees/slice-b/session-refile-v1.ewave.json");
    let v2_path = fixtures().join("u/demo/subtrees/slice-b/session-refile-v2.ewave.json");
    let v1 = read(&v1_path)?;
    let v2 = read(&v2_path)?;
    let meta = SayItSnapshotMeta {
        sayit_user_hash: String::from("u-demo"),
        slice_id: String::from("slice-b"),
        session_id: String::from("session-refile"),
        snapshot_sha256: String::from("sha-v1"),
    };
    let mut ingestor = SayItIngestor::new(personal())?;
    let first = ingestor.ingest_snapshot(&v1, &meta, 1_795_400_000_400, true)?;
    assert_eq!(first.status, "ingested_new");
    let second = ingestor.ingest_snapshot(
        &v2,
        &SayItSnapshotMeta {
            snapshot_sha256: String::from("sha-v2"),
            ..meta
        },
        1_795_400_000_500,
        true,
    )?;
    assert_eq!(second.status, "refiled_updated");
    assert!(!second.invalidated_node_ids.is_empty());
    let still_active = first
        .exclusive_node_ids
        .iter()
        .filter(|id| ingestor.graph().get(id).is_some_and(|n| n.is_valid()))
        .count();
    assert_eq!(still_active, 0, "旧独占节点必须双时态失效");
    Ok(())
}

#[test]
fn rule4_deterministic_utf16_byte_stable_and_shared_role_rejected() -> TestResult {
    let path = fixtures().join("u/demo/subtrees/slice-d/session-stable.ewave.json");
    let mut a = SayItIngestor::new(personal())?;
    a.ingest_file(&path, 1_795_400_000_600, true)?;
    let mut b = SayItIngestor::new(personal())?;
    b.ingest_file(&path, 1_795_400_000_600, true)?;
    assert_eq!(a.graph().to_json_v2()?, b.graph().to_json_v2()?);
    assert_eq!(
        a.graph().to_snapshot().nodes.len(),
        b.graph().to_snapshot().nodes.len()
    );

    let err = SayItIngestor::new(SayItTarget {
        agent_id: AgentId::new_v4(),
        scope: SovereignScope::SharedRole {
            group_id: String::from("synthetic-group"),
        },
    })
    .err()
    .ok_or("共享角色 Agent 必须被拒绝")?;
    assert_eq!(err.code(), ErrorCode::PermissionDenied);
    Ok(())
}

#[test]
fn path_derived_meta_uses_slice_session_and_snapshot_hash() -> TestResult {
    let path = fixtures().join("u/demo/subtrees/slice-a/session-c.ewave.json");
    let mut ingestor = SayItIngestor::new(personal())?;
    let receipt = ingestor.ingest_file(&path, 1_795_400_000_700, true)?;
    assert_eq!(receipt.status, "ingested_new");
    // 同一文件再次吸纳必须幂等无操作（相同路径派生 sha256）。
    let again = ingestor.ingest_file(&path, 1_795_400_000_800, true)?;
    assert_eq!(again.status, "duplicate_no_op");
    assert!(again.invalidated_node_ids.is_empty());
    Ok(())
}

#[test]
fn rule3b_different_slice_same_session_stays_independent() -> TestResult {
    let path = fixtures().join("u/demo/subtrees/slice-b/session-refile-v1.ewave.json");
    let snapshot = read(&path)?;
    let meta = SayItSnapshotMeta {
        sayit_user_hash: String::from("u-demo"),
        slice_id: String::from("slice-b"),
        session_id: String::from("same-session"),
        snapshot_sha256: String::from("sha-b"),
    };
    let mut ingestor = SayItIngestor::new(personal())?;
    let first = ingestor.ingest_snapshot(&snapshot, &meta, 1_795_400_000_900, true)?;
    assert_eq!(first.status, "ingested_new");
    let other_slice = SayItSnapshotMeta {
        slice_id: String::from("slice-c"),
        snapshot_sha256: String::from("sha-c"),
        ..meta
    };
    let second = ingestor.ingest_snapshot(&snapshot, &other_slice, 1_795_400_001_000, true)?;
    assert_eq!(second.status, "ingested_new", "不同 slice 不得视为重归属");
    assert!(
        second.invalidated_node_ids.is_empty(),
        "不同 slice 同 session 必须独立记录，不得失效其他切片"
    );
    let active_first = first
        .exclusive_node_ids
        .iter()
        .filter(|id| ingestor.graph().get(id).is_some_and(|n| n.is_valid()))
        .count();
    assert!(active_first > 0, "原切片的独占节点必须保持有效");
    Ok(())
}
