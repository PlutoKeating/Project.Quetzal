#![forbid(unsafe_code)]
#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

//! UniFFI 视图会话语义：行修订号必须保真、密度补丁不得隐式改写会话状态、`rev()` 必须可失败。

use quetzalcoatl_uniffi::{
    FfiCognitionDensity, FfiViewOp, FfiViewPatch, FfiViewRow, FfiViewSession,
};

fn row(updated_rev: u64) -> FfiViewRow {
    FfiViewRow {
        key: String::from("agent/status"),
        kind: String::from("agent"),
        summary: String::from("在线"),
        detail: Some(String::from("pid=42")),
        raw_json: Some(String::from("{\"pid\":42}")),
        updated_rev,
    }
}

fn seed(session: &FfiViewSession, updated_rev: u64) {
    session
        .apply_patch(FfiViewPatch {
            from_rev: 0,
            to_rev: 3,
            density: FfiCognitionDensity::Workbench,
            ops: vec![FfiViewOp::Upsert {
                row: row(updated_rev),
            }],
        })
        .expect("apply seed patch");
}

#[test]
fn projected_rows_preserve_updated_rev_and_agree_with_snapshot() {
    let session = FfiViewSession::new(FfiCognitionDensity::Workbench);
    seed(&session, 7);

    let snapshot = session.snapshot().expect("snapshot");
    assert_eq!(snapshot.rev, 3);
    assert_eq!(snapshot.rows.len(), 1);
    assert_eq!(
        snapshot.rows[0].updated_rev, 7,
        "快照必须保留该行真实修订号"
    );

    let projected = session.projected_rows().expect("projected rows");
    assert_eq!(projected.len(), 1);
    assert_eq!(
        projected[0].updated_rev, 7,
        "projected_rows 不得用会话 rev 覆盖行自身修订号"
    );
    assert_eq!(projected[0].key, snapshot.rows[0].key);
    assert_eq!(projected[0].kind, snapshot.rows[0].kind);
    assert_eq!(projected[0].summary, snapshot.rows[0].summary);
    assert_eq!(
        projected[0].detail, snapshot.rows[0].detail,
        "Workbench 密度下两接口必须逐字段一致"
    );
}

#[test]
fn projected_rows_keep_revision_while_hiding_layers() {
    let session = FfiViewSession::new(FfiCognitionDensity::Companion);
    seed(&session, 11);
    // 补丁携带自身的 density 字段；显式切到 Companion 后再投影。
    session
        .apply_patch(
            session
                .density_patch(FfiCognitionDensity::Companion)
                .expect("density patch"),
        )
        .expect("apply companion density");
    let projected = session.projected_rows().expect("projected rows");
    assert_eq!(projected[0].updated_rev, 11);
    assert_eq!(projected[0].detail, None);
    assert_eq!(projected[0].raw_json, None);
}

#[test]
fn density_patch_is_pure_and_apply_switches_density() {
    let session = FfiViewSession::new(FfiCognitionDensity::Workbench);
    seed(&session, 7);
    let rev_before = session.rev().expect("rev");
    let density_before = session.density().expect("density");
    assert_eq!(rev_before, 3);
    assert_eq!(density_before, FfiCognitionDensity::Workbench);

    let patch = session
        .density_patch(FfiCognitionDensity::Companion)
        .expect("density patch");
    assert_eq!(patch.from_rev, rev_before);
    assert_eq!(patch.to_rev, rev_before + 1);
    assert!(patch.ops.is_empty(), "纯密度补丁不得携带行操作");
    assert_eq!(patch.density, FfiCognitionDensity::Companion);

    // 生成补丁不得隐式改写会话状态。
    assert_eq!(session.rev().expect("rev after"), rev_before);
    assert_eq!(
        session.density().expect("density after"),
        FfiCognitionDensity::Workbench
    );

    session.apply_patch(patch).expect("apply density patch");
    assert_eq!(
        session.density().expect("density applied"),
        FfiCognitionDensity::Companion
    );
    assert_eq!(session.rev().expect("rev applied"), rev_before + 1);
}

#[test]
fn snapshot_honors_active_density_without_leaking_raw_payload() {
    let session = FfiViewSession::new(FfiCognitionDensity::Companion);
    seed(&session, 9);
    // 补丁自带 density 字段：显式切回 Companion 后再取快照。
    session
        .apply_patch(
            session
                .density_patch(FfiCognitionDensity::Companion)
                .expect("density patch"),
        )
        .expect("apply companion density");

    let companion = session.snapshot().expect("companion snapshot");
    assert_eq!(companion.density, FfiCognitionDensity::Companion);
    assert_eq!(companion.rows.len(), 1);
    assert_eq!(
        companion.rows[0].detail, None,
        "Companion 快照不得包含细节层"
    );
    assert_eq!(
        companion.rows[0].raw_json, None,
        "Companion 快照不得包含原始载荷"
    );

    let projected = session.projected_rows().expect("projected rows");
    assert_eq!(
        companion.rows[0].detail, projected[0].detail,
        "同一密度下 snapshot 与 projected_rows 必须逐字段一致"
    );
    assert_eq!(companion.rows[0].raw_json, projected[0].raw_json);

    // Workbench：允许 detail，仍不得泄露 raw。
    session
        .apply_patch(
            session
                .density_patch(FfiCognitionDensity::Workbench)
                .expect("workbench patch"),
        )
        .expect("apply workbench density");
    let workbench = session.snapshot().expect("workbench snapshot");
    assert!(workbench.rows[0].detail.is_some());
    assert_eq!(workbench.rows[0].raw_json, None);

    // Inspector：全量。
    session
        .apply_patch(
            session
                .density_patch(FfiCognitionDensity::Inspector)
                .expect("inspector patch"),
        )
        .expect("apply inspector density");
    let inspector = session.snapshot().expect("inspector snapshot");
    assert!(inspector.rows[0].detail.is_some());
    assert!(inspector.rows[0].raw_json.is_some());
}
