#![forbid(unsafe_code)]
#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

//! 三档认知密度差分视图：补丁幂等重放、差分确定性与层级裁剪。

use quetzalcoatl_client_core::view_models::{
    CognitionDensity, PatchError, ViewOp, ViewPatch, ViewRow, ViewState,
};

fn row(key: &str, summary: &str, detail: &str, raw: &str) -> ViewRow {
    ViewRow::new(key, "spine.event", summary)
        .with_detail(detail)
        .with_raw_json(raw)
        .with_updated_rev(0)
}

fn state_after(rev: u64, rows: &[ViewRow]) -> ViewState {
    let mut state = ViewState::empty(rev, CognitionDensity::Workbench);
    for r in rows {
        state.rows.insert(r.key.clone(), r.clone());
    }
    state
}

#[test]
fn patch_replay_reconstructs_full_snapshot_deterministically() {
    let a = row("agent/status", "在线", "pid=42", "{\"pid\":42}");
    let b = row("spine/head", "head=7", "hlc=0x1234", "{\"head\":7}");
    let c = row(
        "fabric/lease",
        "witness_epoch=3",
        "connected",
        "{\"epoch\":3}",
    );

    let base = state_after(10, std::slice::from_ref(&a));
    let mid = state_after(11, &[a.clone(), b.clone()]);
    let target = state_after(12, &[b.clone(), c.clone()]);

    let p1 = base.diff(&mid).expect("diff 1");
    let p2 = mid.diff(&target).expect("diff 2");
    assert_eq!(p1.from_rev, 10);
    assert_eq!(p1.to_rev, 11);
    assert_eq!(p2.to_rev, 12);

    // 差异操作必须按 key 确定性排序（同输入必同输出）。
    let p1_again = base.diff(&mid).expect("diff 1 again");
    assert_eq!(p1, p1_again);
    let keys: Vec<&str> = p1
        .ops
        .iter()
        .map(|op| match op {
            ViewOp::Upsert { row } => row.key.as_str(),
            ViewOp::Remove { key } => key.as_str(),
        })
        .collect();
    let mut sorted = keys.clone();
    sorted.sort_unstable();
    assert_eq!(keys, sorted, "补丁操作必须按 key 排序: {keys:?}");

    let replayed = ViewState::replay(&base, &[p1.clone(), p2.clone()]).expect("replay");
    assert_eq!(replayed, target, "补丁重放必须得到完整目标快照");
    assert_eq!(replayed.rows.len(), 2, "旧行必须被补丁删除");

    // 同一补丁重复应用必须幂等（可安全重发）。
    let mut twice = base.clone();
    twice.apply(&p1).expect("apply p1");
    twice.apply(&p1).expect("apply p1 idempotent");
    twice.apply(&p2).expect("apply p2");
    assert_eq!(twice, target);
}

#[test]
fn out_of_sequence_patch_is_rejected_not_silently_merged() {
    let mut base = state_after(20, &[]);
    let stale = ViewPatch {
        from_rev: 18,
        to_rev: 19,
        density: CognitionDensity::Companion,
        ops: vec![ViewOp::Upsert {
            row: row("stale/row", "旧", "旧", "{}"),
        }],
    };
    let err = base.clone().apply(&stale).err();
    assert_eq!(
        err,
        Some(PatchError::OutOfSequence {
            expected: 20,
            actual: 18
        })
    );

    let malformed = ViewPatch {
        from_rev: 21,
        to_rev: 20,
        density: CognitionDensity::Companion,
        ops: Vec::new(),
    };
    assert_eq!(
        base.apply(&malformed).err(),
        Some(PatchError::InvalidRevision {
            from_rev: 21,
            to_rev: 20
        })
    );
}

#[test]
fn three_cognition_densities_project_strictly_nested_layers() {
    let full = state_after(
        5,
        &[
            row("a/1", "摘要", "细节", "{\"raw\":1}"),
            row("a/2", "摘要2", "细节2", "{\"raw\":2}"),
        ],
    );

    let companion = full.projected_rows(CognitionDensity::Companion);
    let workbench = full.projected_rows(CognitionDensity::Workbench);
    let inspector = full.projected_rows(CognitionDensity::Inspector);

    assert!(
        companion
            .iter()
            .all(|r| r.detail.is_none() && r.raw_json.is_none())
    );
    assert!(companion.iter().all(|r| !r.summary.is_empty()));

    assert!(workbench.iter().all(|r| r.detail.is_some()));
    assert!(workbench.iter().all(|r| r.raw_json.is_none()));

    assert!(inspector.iter().all(|r| r.raw_json.is_some()));
    assert_eq!(inspector.len(), 2);
    assert_eq!(
        inspector
            .iter()
            .map(|r| r.summary.as_str())
            .collect::<Vec<_>>(),
        vec!["摘要", "摘要2"],
        "投影必须保持确定性 key 序"
    );
    assert_eq!(
        CognitionDensity::Companion.layers(),
        &[quetzalcoatl_client_core::DetailLayer::Summary]
    );
    assert!(CognitionDensity::Inspector.includes(quetzalcoatl_client_core::DetailLayer::Raw));
    assert!(!CognitionDensity::Workbench.includes(quetzalcoatl_client_core::DetailLayer::Raw));
}

#[test]
fn density_switch_is_itself_a_replayable_patch() {
    let base = state_after(7, &[row("a/1", "摘要", "细节", "{}")]);
    let inspector = base.projected_snapshot(CognitionDensity::Inspector);
    assert_eq!(inspector.density, CognitionDensity::Inspector);
    assert!(inspector.rows.values().all(|r| r.raw_json.is_some()));

    let patch = base.density_patch(CognitionDensity::Companion);
    assert_eq!(patch.ops.len(), 0, "纯密度切换不应产生行操作");
    let mut switched = base.clone();
    switched.apply(&patch).expect("apply density patch");
    switched
        .apply(&patch)
        .expect("apply density patch idempotent");
    assert_eq!(switched.density, CognitionDensity::Companion);
    assert!(switched.project().iter().all(|r| r.detail.is_none()));
}
