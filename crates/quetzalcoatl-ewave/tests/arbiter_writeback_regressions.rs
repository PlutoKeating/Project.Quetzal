#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]

//! 写回回路依赖的两处仲裁器行为：
//! 没有引用相处记录的提案不得因为「证据摘要恒定」而被误判为重复；
//! 有界段的修正预算约束的是短期内的漂移幅度，条目稳定一个巩固周期后重新计起。

use std::collections::BTreeMap;
use std::error::Error;
use std::fs;
use std::path::PathBuf;

use quetzalcoatl_crypto::{AccountRootKey, DeviceIdentity, EpochKeyRing};
use quetzalcoatl_ewave::{
    Authority, Conscience, ConscienceArbiter, ConscienceManifest, Episode, FocusConfig,
    GraphOptions, ModelRef, ModelRole, Proposal, ProposalStatus, ProtectedDirective,
    SerpentineGraph, SignalKind,
};
use quetzalcoatl_spine::{RusqliteWalStore, SpineEngine};
use quetzalcoatl_types::{AgentId, DeviceId, Epoch, HlcTimestamp, ThreadId};

type TestResult = Result<(), Box<dyn Error>>;

const BASE_MS: u64 = 1_795_400_000_000;
const HOUR_MS: u64 = 3_600_000;
const DAY_MS: u64 = 24 * HOUR_MS;

struct TempDbGuard(PathBuf);

impl Drop for TempDbGuard {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

type Rig = (
    SpineEngine<RusqliteWalStore>,
    Conscience,
    SerpentineGraph,
    TempDbGuard,
);

fn rig(tag: &str) -> Result<Rig, Box<dyn Error>> {
    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR"))
        .join(format!("qz_arbiter_writeback_{tag}_{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir)?;
    let agent_id = AgentId::new_v4();
    let root_key = AccountRootKey::from_bytes([0x42u8; 32]);
    let device = DeviceIdentity::from_seeds(DeviceId::new_v4(), [0x11u8; 32], [0x22u8; 32])?;
    let ring = EpochKeyRing::new_genesis(agent_id, &root_key, device.public_record())?;
    let store = RusqliteWalStore::open(&dir.join("spine.sqlite"))?;
    let spine = SpineEngine::new(
        agent_id,
        device,
        ring,
        HlcTimestamp::from_parts(BASE_MS, 0, 1),
        store,
    )?;
    let root_directives: Vec<ProtectedDirective> = Vec::new();
    let operator_directives: Vec<ProtectedDirective> = Vec::new();
    let manifest = ConscienceManifest::sign_with_root(
        &root_key,
        &root_directives,
        &operator_directives,
        BASE_MS,
    )?;
    let conscience = Conscience {
        schema_version: String::from("ewave-conscience/v1"),
        root_directives,
        operator_directives,
        manifest,
        identity: Vec::new(),
        values: Vec::new(),
        relationships: Vec::new(),
        memories: Vec::new(),
        focus: FocusConfig::default(),
        grants_given: Vec::new(),
        grants_received: Vec::new(),
        episodes: Vec::new(),
        peer_links: BTreeMap::new(),
        pending_disclosures: Vec::new(),
    };
    let graph = SerpentineGraph::new(GraphOptions::default())?;
    Ok((spine, conscience, graph, TempDbGuard(dir)))
}

fn host_model() -> ModelRef {
    ModelRef {
        role: ModelRole::Primary,
        reference: String::from("host:claude-code"),
        provider_hash: None,
        model_hash: None,
        params_b: None,
        is_on_device_small: false,
    }
}

fn proposal(
    id: &str,
    target: &str,
    authority: Authority,
    value: &str,
    signal: SignalKind,
    evidence: &[&str],
    at_ms: u64,
) -> Proposal {
    Proposal {
        id: String::from(id),
        target_id: String::from(target),
        target_authority: authority,
        new_value: String::from(value),
        rationale: None,
        signal,
        evidence_episode_ids: evidence.iter().map(|e| String::from(*e)).collect(),
        reflector: host_model(),
        additional_agreements: Vec::new(),
        evidence_hash: String::new(),
        policy_version: String::from("v1"),
        origin_is_group_non_owner: false,
        owner_device_sig_verified: true,
        supersedes: None,
        created_at_ms: at_ms,
    }
}

#[test]
fn proposals_without_evidence_are_deduplicated_by_content_not_by_an_empty_digest() -> TestResult {
    let (mut spine, mut conscience, mut graph, _guard) = rig("dedupe")?;
    let mut arbiter = ConscienceArbiter::new(Epoch::new(1));
    let mut status_of = |prop: Proposal, at_ms: u64| -> Result<ProposalStatus, Box<dyn Error>> {
        let report = arbiter.evaluate_proposals(
            Epoch::new(1),
            &[prop],
            &mut conscience,
            &mut graph,
            &mut spine,
            at_ms,
        )?;
        Ok(report.evaluations[0].status)
    };

    let first = proposal(
        "p1",
        "mem-note",
        Authority::Memory,
        "发布日是周四",
        SignalKind::S8,
        &[],
        BASE_MS,
    );
    assert_eq!(status_of(first.clone(), BASE_MS)?, ProposalStatus::Accepted);

    let revised = proposal(
        "p2",
        "mem-note",
        Authority::Memory,
        "发布日改到周五",
        SignalKind::S8,
        &[],
        BASE_MS + 1_000,
    );
    assert_eq!(
        status_of(revised, BASE_MS + 1_000)?,
        ProposalStatus::Accepted,
        "同一条目的第二次不同修改必须被接受"
    );

    assert_eq!(
        status_of(first, BASE_MS + 2_000)?,
        ProposalStatus::DuplicateIgnored,
        "内容完全相同的重复提交仍然被忽略"
    );
    Ok(())
}

#[test]
fn bounded_budget_refills_after_the_entry_has_been_stable_for_a_consolidation_window() -> TestResult
{
    let (mut spine, mut conscience, mut graph, _guard) = rig("budget")?;
    for idx in 0..10u64 {
        conscience.episodes.push(Episode {
            id: format!("ep-{idx}"),
            thread_id: ThreadId::new_v4(),
            peer_ids: vec![String::from("owner")],
            channel: String::from("host:claude-code"),
            session_id: Some(format!("s-{idx}")),
            started_at_ms: BASE_MS + idx * HOUR_MS,
            ended_at_ms: Some(BASE_MS + idx * HOUR_MS + 60_000),
            pressure_flags: Vec::new(),
            s4_command_source_id: Some(format!("cmd-{idx}")),
            pending_cloud_consolidation: false,
        });
    }
    let mut arbiter = ConscienceArbiter::new(Epoch::new(1));
    let mut change = |idx: u64, at_ms: u64| -> Result<ProposalStatus, Box<dyn Error>> {
        let evidence = format!("ep-{idx}");
        let prop = proposal(
            &format!("p-{idx}"),
            "pref-summary-style",
            Authority::UserPref,
            &format!("总结风格第 {idx} 版"),
            SignalKind::S4,
            &[evidence.as_str()],
            at_ms,
        );
        let report = arbiter.evaluate_proposals(
            Epoch::new(1),
            &[prop],
            &mut conscience,
            &mut graph,
            &mut spine,
            at_ms,
        )?;
        Ok(report.evaluations[0].status)
    };

    // 短时间内连续修改：预算内的被接受，耗尽后被拒绝。
    let mut accepted = 0u64;
    let mut rejected_at = None;
    for idx in 0..8u64 {
        match change(idx, BASE_MS + idx * HOUR_MS)? {
            ProposalStatus::Accepted => accepted += 1,
            ProposalStatus::Rejected => {
                rejected_at = Some(idx);
                break;
            }
            other => return Err(format!("意外的状态 {other:?}").into()),
        }
    }
    assert!(accepted >= 1, "预算内的修改必须被接受");
    let rejected_at = rejected_at.ok_or("短期内连续修改最终必须耗尽预算")?;

    // 这一条稳定了一个巩固周期之后，又可以改了。
    assert_eq!(
        change(
            rejected_at + 1,
            BASE_MS + rejected_at * HOUR_MS + 31 * DAY_MS
        )?,
        ProposalStatus::Accepted,
        "稳定满一个巩固周期后预算重新计起"
    );
    Ok(())
}
