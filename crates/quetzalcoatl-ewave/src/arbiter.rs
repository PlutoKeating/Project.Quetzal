use std::collections::{BTreeMap, BTreeSet};

use quetzalcoatl_crypto::{PackCompartment, hex_encode};
use quetzalcoatl_spine::{MaterializedMemory, MaterializedStore, SpineEngine};
use quetzalcoatl_types::{Epoch, QuetzalcoatlError, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::conscience::{
    Authority, Conscience, DisclosureNotice, Episode, MemoryEntry, MemoryKind, ModelRef,
    Mutability, ProvenanceRecord, SignalKind, ValueEntry,
};
use crate::graph::{
    BranchOptions, LockActor, LockMode, ObserveOptions, SerpentineGraph, cmp_utf16,
    normalize_nfkc_lower_trim,
};

const DAY_MS: u64 = 86_400_000;
const HOUR_MS: u64 = 3_600_000;

#[derive(Copy, Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ArbiterMode {
    Observe,
    ManualApproval,
    IndependentJudge,
    #[default]
    AutoC,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SelfCorePolicy {
    pub min_evidence: usize,
    pub min_sessions: usize,
    pub min_days: u64,
    pub max_pressure_ratio: f64,
    pub cooldown_days: u64,
    pub reflector_agreement: usize,
    pub max_core_changes_per_cooldown: usize,
    pub requires_disclosure: bool,
    pub min_gap_hours: u64,
}

impl Default for SelfCorePolicy {
    fn default() -> Self {
        Self {
            min_evidence: 5,
            min_sessions: 3,
            min_days: 7,
            max_pressure_ratio: 0.2,
            cooldown_days: 14,
            reflector_agreement: 2,
            max_core_changes_per_cooldown: 1,
            requires_disclosure: true,
            min_gap_hours: 12,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ReflectorAttestation {
    pub reflector: ModelRef,
    pub run_id: String,
    pub at_ms: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Proposal {
    pub id: String,
    pub target_id: String,
    pub target_authority: Authority,
    pub new_value: String,
    pub rationale: Option<String>,
    pub signal: SignalKind,
    pub evidence_episode_ids: Vec<String>,
    pub reflector: ModelRef,
    pub additional_agreements: Vec<ReflectorAttestation>,
    pub evidence_hash: String,
    pub policy_version: String,
    pub origin_is_group_non_owner: bool,
    pub owner_device_sig_verified: bool,
    pub supersedes: Option<String>,
    pub created_at_ms: u64,
}

/// 计算排序去重后 `evidence_episode_ids` 的确定性 SHA-256 十六进制摘要（`architecture-v1.md` §5.3）。
#[must_use]
pub fn compute_evidence_hash(episode_ids: &[String]) -> String {
    let mut sorted: Vec<&str> = episode_ids.iter().map(String::as_str).collect();
    sorted.sort_by(|a, b| cmp_utf16(a, b));
    sorted.dedup();
    let mut sha = Sha256::new();
    for (idx, id) in sorted.iter().enumerate() {
        if idx > 0 {
            sha.update(b"\n");
        }
        sha.update(id.as_bytes());
    }
    hex_encode(&sha.finalize())
}

#[derive(Copy, Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProposalStatus {
    Accepted,
    Observed,
    DuplicateIgnored,
    PendingCloudConsolidation,
    PendingReflectorAgreement,
    PendingIndependentEvidence,
    Rejected,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProposalEvaluation {
    pub proposal_id: String,
    pub target_id: String,
    pub target_authority: Authority,
    pub status: ProposalStatus,
    pub reason: String,
    pub spine_event_seq: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ArbiterBatchReport {
    pub router_epoch: Epoch,
    pub evaluations: Vec<ProposalEvaluation>,
    pub accepted_count: usize,
    pub parked_cloud_count: usize,
    pub rejected_count: usize,
    pub duplicate_count: usize,
}

fn episodes_are_independent(a: &Episode, b: &Episode, min_gap_ms: u64) -> bool {
    if a.thread_id == b.thread_id {
        return false;
    }
    if let (Some(sa), Some(sb)) = (&a.s4_command_source_id, &b.s4_command_source_id)
        && sa == sb
    {
        return false;
    }
    let diff_peer = {
        let mut pa = a.peer_ids.clone();
        let mut pb = b.peer_ids.clone();
        pa.sort_by(|x, y| cmp_utf16(x, y));
        pb.sort_by(|x, y| cmp_utf16(x, y));
        pa != pb
    };
    let diff_channel = a.channel != b.channel;
    let gap_ok = a.started_at_ms.abs_diff(b.started_at_ms) >= min_gap_ms;
    diff_peer || diff_channel || gap_ok
}

fn signal_allows_target(signal: SignalKind, authority: Authority) -> bool {
    match signal {
        SignalKind::S1 => matches!(authority, Authority::Memory | Authority::UserPref),
        SignalKind::S2 => matches!(authority, Authority::Memory | Authority::Relation),
        SignalKind::S3 => matches!(
            authority,
            Authority::Memory | Authority::SelfSoft | Authority::SelfCore
        ),
        SignalKind::S4 => matches!(authority, Authority::Memory | Authority::UserPref),
        SignalKind::S5 | SignalKind::S8 => authority == Authority::Memory,
        SignalKind::S6 | SignalKind::S9 => authority == Authority::Relation,
        SignalKind::S7 => false,
    }
}

fn reflector_identity_key(m: &ModelRef) -> String {
    m.model_hash.clone().unwrap_or_else(|| m.reference.clone())
}

pub struct ConscienceArbiter {
    current_epoch: Epoch,
    mode: ArbiterMode,
    policy: SelfCorePolicy,
    primary_model_hash: Option<String>,
    processed_keys: BTreeMap<(String, String, String), ProposalStatus>,
    accepted_evidence_keys: BTreeMap<(String, String), u64>,
    reflector_agreements: BTreeMap<(String, String), Vec<ReflectorAttestation>>,
    pending_cloud_queue: Vec<Proposal>,
    last_core_change_by_target: BTreeMap<String, u64>,
    core_change_history_ms: Vec<u64>,
}

impl ConscienceArbiter {
    #[must_use]
    pub fn new(initial_epoch: Epoch) -> Self {
        Self {
            current_epoch: initial_epoch,
            mode: ArbiterMode::AutoC,
            policy: SelfCorePolicy::default(),
            primary_model_hash: None,
            processed_keys: BTreeMap::new(),
            accepted_evidence_keys: BTreeMap::new(),
            reflector_agreements: BTreeMap::new(),
            pending_cloud_queue: Vec::new(),
            last_core_change_by_target: BTreeMap::new(),
            core_change_history_ms: Vec::new(),
        }
    }

    pub fn set_mode(&mut self, mode: ArbiterMode) {
        self.mode = mode;
    }

    pub fn set_policy(&mut self, policy: SelfCorePolicy) {
        self.policy = policy;
    }

    pub fn set_primary_model_hash(&mut self, hash: impl Into<String>) {
        self.primary_model_hash = Some(hash.into());
    }

    #[must_use]
    pub const fn current_epoch(&self) -> Epoch {
        self.current_epoch
    }

    pub fn advance_lease_epoch(&mut self, new_epoch: Epoch) -> Result<()> {
        if new_epoch < self.current_epoch {
            return Err(QuetzalcoatlError::StaleLeaseEpoch {
                provided: new_epoch.get(),
                current: self.current_epoch.get(),
            });
        }
        self.current_epoch = new_epoch;
        Ok(())
    }

    #[must_use]
    pub fn pending_cloud_proposals(&self) -> &[Proposal] {
        &self.pending_cloud_queue
    }

    pub fn drain_pending_cloud_proposals(&mut self) -> Vec<Proposal> {
        std::mem::take(&mut self.pending_cloud_queue)
    }

    /// 按 `architecture-v1.md` §6.3 精确定义计算最大两两独立 Episode 簇数：
    /// 属于不同 `ThreadId`，不含相同 `S4` 指令源，且满足（`peer` 不同 || `channel` 不同 || 起始时间差 `>= min_gap_hours`）。
    #[must_use]
    pub fn count_independent_episode_clusters(episodes: &[Episode], min_gap_hours: u64) -> usize {
        if episodes.is_empty() {
            return 0;
        }
        let min_gap_ms = min_gap_hours.saturating_mul(HOUR_MS);
        let mut ordered = episodes.to_vec();
        ordered.sort_by(|a, b| {
            a.started_at_ms
                .cmp(&b.started_at_ms)
                .then_with(|| cmp_utf16(&a.id, &b.id))
        });

        // 当规模 <= 32 时用分支定界精确求解最大两两独立团，超大规模退回确定性贪心
        if ordered.len() <= 32 {
            fn search_clique(
                idx: usize,
                chosen: &mut Vec<usize>,
                best: &mut usize,
                items: &[Episode],
                min_gap_ms: u64,
            ) {
                if chosen.len() > *best {
                    *best = chosen.len();
                }
                if idx >= items.len() || chosen.len() + (items.len() - idx) <= *best {
                    return;
                }
                let compatible = chosen
                    .iter()
                    .all(|&prev| episodes_are_independent(&items[prev], &items[idx], min_gap_ms));
                if compatible {
                    chosen.push(idx);
                    search_clique(idx + 1, chosen, best, items, min_gap_ms);
                    chosen.pop();
                }
                search_clique(idx + 1, chosen, best, items, min_gap_ms);
            }
            let mut chosen = Vec::new();
            let mut best = 0usize;
            search_clique(0, &mut chosen, &mut best, &ordered, min_gap_ms);
            return best;
        }

        let mut selected: Vec<&Episode> = Vec::new();
        for ep in &ordered {
            if selected
                .iter()
                .all(|prev| episodes_are_independent(prev, ep, min_gap_ms))
            {
                selected.push(ep);
            }
        }
        selected.len()
    }

    fn append_audit_event<S: MaterializedStore>(
        spine: &mut SpineEngine<S>,
        action: &str,
        proposal: &Proposal,
        reason: &str,
        now_ms: u64,
    ) -> Result<u64> {
        let payload = serde_json::json!({
            "kind": "ewave_conscience_audit",
            "action": action,
            "proposal_id": proposal.id,
            "target_id": proposal.target_id,
            "target_authority": proposal.target_authority.as_str(),
            "signal": proposal.signal,
            "reflector_ref": proposal.reflector.reference,
            "reason": reason,
        })
        .to_string();
        let ev = spine.append_event(PackCompartment::Core, &payload, now_ms)?;
        Ok(ev.header.seq)
    }

    fn is_valid_heterogeneous_reflector(&self, model: &ModelRef) -> bool {
        if model.is_small_on_device() {
            return false;
        }
        if let (Some(primary), Some(m_hash)) = (&self.primary_model_hash, &model.model_hash)
            && primary == m_hash
        {
            return false;
        }
        true
    }

    fn sync_graph_entry(
        graph: &mut SerpentineGraph,
        branch_id: &str,
        branch_label: &str,
        lock_mode: Option<LockMode>,
        entry_id: &str,
        content: &str,
        now_ms: u64,
    ) -> Result<()> {
        if !graph.has(branch_id) {
            let _ = graph.add_branch(BranchOptions {
                id: Some(String::from(branch_id)),
                label: Some(String::from(branch_label)),
                text: Some(String::from(branch_label)),
                at: Some(now_ms),
                ..BranchOptions::default()
            })?;
        }
        if let Some(mode) = lock_mode
            && graph.lock_mode(branch_id).is_none()
        {
            let _ = graph.lock(branch_id, mode, LockActor::Arbiter, "conscience tier lock")?;
        }
        let leaf_node_id = if graph.has(entry_id) {
            format!("{entry_id}@{now_ms}")
        } else {
            String::from(entry_id)
        };
        let _ = graph.add(
            serde_json::json!({ "conscience_id": entry_id }),
            ObserveOptions {
                id: Some(leaf_node_id),
                text: Some(String::from(content)),
                label: Some(String::from(entry_id)),
                parent: Some(String::from(branch_id)),
                at: Some(now_ms),
                ..ObserveOptions::default()
            },
        )?;
        Ok(())
    }

    /// 单写者租约围栏与两段式良知提案仲裁入口：
    /// 1. 拒绝过期 `router_epoch < current_epoch`（`StaleLeaseEpoch`）；
    /// 2. 拒绝任何触及 `ROOT (100)` / `OPERATOR (80)` 的 LLM 提案（`ConscienceViolation`）；
    /// 3. 拦截 `<=8B` 端侧小模型审议 `>= USER_PREF` 写回并挂起为 `PendingCloudConsolidation`（防坑 #16）；
    /// 4. 按 `(target_id, evidence_hash)` 执行严格幂等；
    /// 5. 预算内零弹窗即时放行 `MEMORY (30)` / `SELF_SOFT (50)`，对 `SELF_CORE (70)` 强制执行 C 档多独立证据 + 冷却期 + 异构双 Reflector 门槛，并将审计链写入 `SpineEngine`。
    pub fn evaluate_proposals<S: MaterializedStore>(
        &mut self,
        router_epoch: Epoch,
        proposals: &[Proposal],
        conscience: &mut Conscience,
        graph: &mut SerpentineGraph,
        spine: &mut SpineEngine<S>,
        now_ms: u64,
    ) -> Result<ArbiterBatchReport> {
        // Gate 0: 单写者租约纪元围栏
        if router_epoch < self.current_epoch {
            return Err(QuetzalcoatlError::StaleLeaseEpoch {
                provided: router_epoch.get(),
                current: self.current_epoch.get(),
            });
        }
        self.current_epoch = router_epoch;

        // 提交前核验受保护 ROOT / OPERATOR 签名清单未被篡改
        conscience.verify_signature_and_hashes()?;

        // Gate 1: 严禁任何 LLM Proposal 触及 ROOT (100) 或 OPERATOR (80)
        for prop in proposals {
            if prop.target_authority >= Authority::Operator
                || conscience
                    .manifest
                    .protected_hashes
                    .contains_key(&prop.target_id)
            {
                let _ = Self::append_audit_event(
                    spine,
                    "root_write_rejected",
                    prop,
                    "拒绝通过 LLM Proposal 写入 ROOT/OPERATOR 受签名保护段",
                    now_ms,
                )?;
                return Err(QuetzalcoatlError::ConscienceViolation {
                    detail: format!(
                        "良知绝对根保护：禁止通过提案 {} 修改 {} ({})",
                        prop.id,
                        prop.target_id,
                        prop.target_authority.as_str()
                    ),
                });
            }
        }

        let mut evaluations = Vec::with_capacity(proposals.len());
        let mut accepted_count = 0usize;
        let mut parked_cloud_count = 0usize;
        let mut rejected_count = 0usize;
        let mut duplicate_count = 0usize;

        for prop in proposals {
            let ev_hash = if prop.evidence_hash.trim().is_empty() {
                compute_evidence_hash(&prop.evidence_episode_ids)
            } else {
                prop.evidence_hash.clone()
            };
            let refl_key = reflector_identity_key(&prop.reflector);
            let full_idem_key = (prop.target_id.clone(), ev_hash.clone(), refl_key.clone());
            let accepted_key = (prop.target_id.clone(), ev_hash.clone());

            // Gate 2: (target_id, evidence_hash) 幂等检查
            if self.accepted_evidence_keys.contains_key(&accepted_key)
                || self.processed_keys.contains_key(&full_idem_key)
            {
                duplicate_count += 1;
                evaluations.push(ProposalEvaluation {
                    proposal_id: prop.id.clone(),
                    target_id: prop.target_id.clone(),
                    target_authority: prop.target_authority,
                    status: ProposalStatus::DuplicateIgnored,
                    reason: String::from("幂等键 (target_id, evidence_hash) 已处理，跳过重复提交"),
                    spine_event_seq: None,
                });
                continue;
            }

            // Gate 3: 防坑规范 #16 — <=8B 端侧小模型严禁审议 >= USER_PREF / SELF_CORE 写回
            if prop.reflector.is_small_on_device() && prop.target_authority >= Authority::UserPref {
                let ref_set: BTreeSet<&str> = prop
                    .evidence_episode_ids
                    .iter()
                    .map(String::as_str)
                    .collect();
                for ep in &mut conscience.episodes {
                    if ref_set.contains(ep.id.as_str()) {
                        ep.pending_cloud_consolidation = true;
                    }
                }
                self.pending_cloud_queue.push(prop.clone());
                self.processed_keys
                    .insert(full_idem_key, ProposalStatus::PendingCloudConsolidation);
                let seq = Self::append_audit_event(
                    spine,
                    "parked_pending_cloud_consolidation",
                    prop,
                    "端侧 <=8B 小模型禁止审议 >= USER_PREF 写回，已挂起等待云端或桌面大模型巩固",
                    now_ms,
                )?;
                parked_cloud_count += 1;
                evaluations.push(ProposalEvaluation {
                    proposal_id: prop.id.clone(),
                    target_id: prop.target_id.clone(),
                    target_authority: prop.target_authority,
                    status: ProposalStatus::PendingCloudConsolidation,
                    reason: String::from("端侧 <=8B 模型挂起等待云端巩固"),
                    spine_event_seq: Some(seq),
                });
                continue;
            }

            // Gate 4: 信号天花板与群聊非主人冒充拦截（§6.1 & 防坑规范 #20）
            if prop.origin_is_group_non_owner
                && !prop.owner_device_sig_verified
                && prop.target_authority > Authority::Memory
            {
                self.processed_keys
                    .insert(full_idem_key, ProposalStatus::Rejected);
                let seq = Self::append_audit_event(
                    spine,
                    "group_spoofing_rejected",
                    prop,
                    "群聊非主人未签名发言严禁写入 > MEMORY 层",
                    now_ms,
                )?;
                rejected_count += 1;
                evaluations.push(ProposalEvaluation {
                    proposal_id: prop.id.clone(),
                    target_id: prop.target_id.clone(),
                    target_authority: prop.target_authority,
                    status: ProposalStatus::Rejected,
                    reason: String::from("群聊非主人消息仅允许 S8 untrusted 记忆"),
                    spine_event_seq: Some(seq),
                });
                continue;
            }

            if !signal_allows_target(prop.signal, prop.target_authority) {
                self.processed_keys
                    .insert(full_idem_key, ProposalStatus::Rejected);
                let seq = Self::append_audit_event(
                    spine,
                    "signal_ceiling_rejected",
                    prop,
                    "信号类型超出目标权威段上限",
                    now_ms,
                )?;
                rejected_count += 1;
                evaluations.push(ProposalEvaluation {
                    proposal_id: prop.id.clone(),
                    target_id: prop.target_id.clone(),
                    target_authority: prop.target_authority,
                    status: ProposalStatus::Rejected,
                    reason: format!(
                        "信号 {:?} 不允许修改 {}",
                        prop.signal,
                        prop.target_authority.as_str()
                    ),
                    spine_event_seq: Some(seq),
                });
                continue;
            }

            let ev_id_set: BTreeSet<&str> = prop
                .evidence_episode_ids
                .iter()
                .map(String::as_str)
                .collect();
            let referenced_episodes: Vec<Episode> = conscience
                .episodes
                .iter()
                .filter(|ep| ev_id_set.contains(ep.id.as_str()))
                .cloned()
                .collect();

            // Gate 5: 有界段即时自演化（MEMORY = 30, USER_PREF = 40, SELF_SOFT = 50, RELATION = 55）
            if prop.target_authority == Authority::Memory {
                if let Some(sup_id) = &prop.supersedes {
                    for m in &mut conscience.memories {
                        if m.id == *sup_id && m.invalid_at_ms.is_none() {
                            m.invalid_at_ms = Some(now_ms);
                        }
                    }
                }
                let untrusted = prop.signal == SignalKind::S8 || prop.origin_is_group_non_owner;
                conscience.memories.push(MemoryEntry {
                    id: prop.target_id.clone(),
                    kind: MemoryKind::Fact,
                    topic: None,
                    content: prop.new_value.clone(),
                    about: Vec::new(),
                    salience: 0.7,
                    evidence_count: referenced_episodes.len().max(1),
                    constant: false,
                    untrusted,
                    pressure_flags: Vec::new(),
                    authority: Authority::Memory,
                    mutability: Mutability::memory_free(),
                    valid_from_ms: now_ms,
                    invalid_at_ms: None,
                    triggers: Vec::new(),
                    provenance: ProvenanceRecord {
                        written_by: String::from("agent_reflection"),
                        at_ms: now_ms,
                        source_event_ids: prop.evidence_episode_ids.clone(),
                        model: Some(prop.reflector.clone()),
                        supersedes: prop.supersedes.clone(),
                    },
                });
                Self::sync_graph_entry(
                    graph,
                    "b_memory",
                    "MEMORY",
                    None,
                    &prop.target_id,
                    &prop.new_value,
                    now_ms,
                )?;
                let seq = Self::append_audit_event(
                    spine,
                    "memory_committed",
                    prop,
                    "MEMORY 自由段零弹窗即时写入",
                    now_ms,
                )?;
                let updated_hlc = spine.local_hlc();
                spine.store_mut().upsert_memory(&MaterializedMemory {
                    memory_id: prop.target_id.clone(),
                    category: String::from("memory"),
                    authority: Authority::Memory.numeric(),
                    content: prop.new_value.clone(),
                    updated_hlc,
                })?;

                self.processed_keys
                    .insert(full_idem_key, ProposalStatus::Accepted);
                self.accepted_evidence_keys.insert(accepted_key, now_ms);
                accepted_count += 1;
                evaluations.push(ProposalEvaluation {
                    proposal_id: prop.id.clone(),
                    target_id: prop.target_id.clone(),
                    target_authority: prop.target_authority,
                    status: ProposalStatus::Accepted,
                    reason: String::from("MEMORY 写入生效"),
                    spine_event_seq: Some(seq),
                });
                continue;
            }

            if matches!(
                prop.target_authority,
                Authority::UserPref | Authority::SelfSoft | Authority::Relation
            ) {
                // §6.2 反向门：全部证据来自同一 Thread 且含 S5 施压 -> 挂起等待独立证据
                if !referenced_episodes.is_empty() {
                    let unique_threads: BTreeSet<_> =
                        referenced_episodes.iter().map(|e| e.thread_id).collect();
                    let any_s5 = referenced_episodes.iter().any(Episode::has_s5_pressure);
                    if unique_threads.len() <= 1 && any_s5 {
                        self.processed_keys
                            .insert(full_idem_key, ProposalStatus::PendingIndependentEvidence);
                        let seq = Self::append_audit_event(
                            spine,
                            "bounded_s5_reverse_gate",
                            prop,
                            "单线程含 S5 施压，挂起等待独立证据",
                            now_ms,
                        )?;
                        evaluations.push(ProposalEvaluation {
                            proposal_id: prop.id.clone(),
                            target_id: prop.target_id.clone(),
                            target_authority: prop.target_authority,
                            status: ProposalStatus::PendingIndependentEvidence,
                            reason: String::from("单会话含 S5 压力信号，需跨会话独立证据"),
                            spine_event_seq: Some(seq),
                        });
                        continue;
                    }
                }

                let default_mut = match prop.target_authority {
                    Authority::UserPref => Mutability::user_pref_default(),
                    Authority::SelfSoft => Mutability::self_soft_default(),
                    _ => Mutability::relation_default(),
                };
                let mut existing_mut = conscience
                    .values
                    .iter()
                    .find(|v| v.id == prop.target_id && v.invalid_at_ms.is_none())
                    .map_or(default_mut, |v| v.mutability.clone());

                if referenced_episodes.len() < existing_mut.min_evidence {
                    self.processed_keys
                        .insert(full_idem_key, ProposalStatus::PendingIndependentEvidence);
                    let seq = Self::append_audit_event(
                        spine,
                        "bounded_insufficient_evidence",
                        prop,
                        "有界段证据条数未达 min_evidence",
                        now_ms,
                    )?;
                    evaluations.push(ProposalEvaluation {
                        proposal_id: prop.id.clone(),
                        target_id: prop.target_id.clone(),
                        target_authority: prop.target_authority,
                        status: ProposalStatus::PendingIndependentEvidence,
                        reason: format!(
                            "证据数 {} < min_evidence {}",
                            referenced_episodes.len(),
                            existing_mut.min_evidence
                        ),
                        spine_event_seq: Some(seq),
                    });
                    continue;
                }

                if existing_mut.budget_spent + existing_mut.budget_per_episode
                    > existing_mut.budget_total + 1e-12
                {
                    self.processed_keys
                        .insert(full_idem_key, ProposalStatus::Rejected);
                    let seq = Self::append_audit_event(
                        spine,
                        "bounded_budget_exhausted",
                        prop,
                        "有界段巩固周期修正预算已耗尽",
                        now_ms,
                    )?;
                    rejected_count += 1;
                    evaluations.push(ProposalEvaluation {
                        proposal_id: prop.id.clone(),
                        target_id: prop.target_id.clone(),
                        target_authority: prop.target_authority,
                        status: ProposalStatus::Rejected,
                        reason: String::from("有界段修正预算已耗尽"),
                        spine_event_seq: Some(seq),
                    });
                    continue;
                }

                existing_mut.budget_spent += existing_mut.budget_per_episode;
                for v in &mut conscience.values {
                    if (v.id == prop.target_id || prop.supersedes.as_deref() == Some(v.id.as_str()))
                        && v.invalid_at_ms.is_none()
                    {
                        v.invalid_at_ms = Some(now_ms);
                    }
                }
                conscience.values.push(ValueEntry {
                    id: prop.target_id.clone(),
                    statement: prop.new_value.clone(),
                    rationale: prop.rationale.clone(),
                    authority: prop.target_authority,
                    negotiable_in_conversation: true,
                    examples: Vec::new(),
                    mutability: existing_mut,
                    provenance: ProvenanceRecord {
                        written_by: String::from("agent_reflection"),
                        at_ms: now_ms,
                        source_event_ids: prop.evidence_episode_ids.clone(),
                        model: Some(prop.reflector.clone()),
                        supersedes: prop.supersedes.clone(),
                    },
                    valid_from_ms: now_ms,
                    invalid_at_ms: None,
                });

                Self::sync_graph_entry(
                    graph,
                    "b_bounded_self",
                    "BOUNDED_TIER",
                    None,
                    &prop.target_id,
                    &prop.new_value,
                    now_ms,
                )?;
                let seq = Self::append_audit_event(
                    spine,
                    "bounded_tier_committed",
                    prop,
                    "有界段预算内零弹窗即时演化提交",
                    now_ms,
                )?;
                let updated_hlc = spine.local_hlc();
                spine.store_mut().upsert_memory(&MaterializedMemory {
                    memory_id: prop.target_id.clone(),
                    category: prop.target_authority.as_str().to_ascii_lowercase(),
                    authority: prop.target_authority.numeric(),
                    content: prop.new_value.clone(),
                    updated_hlc,
                })?;

                self.processed_keys
                    .insert(full_idem_key, ProposalStatus::Accepted);
                self.accepted_evidence_keys.insert(accepted_key, now_ms);
                accepted_count += 1;
                evaluations.push(ProposalEvaluation {
                    proposal_id: prop.id.clone(),
                    target_id: prop.target_id.clone(),
                    target_authority: prop.target_authority,
                    status: ProposalStatus::Accepted,
                    reason: String::from("有界段写入生效"),
                    spine_event_seq: Some(seq),
                });
                continue;
            }

            // Gate 6: SELF_CORE (70) C 档全自动多独立证据 + 冷却期 + 异构双 Reflector 门槛（§6.3）
            if !self.is_valid_heterogeneous_reflector(&prop.reflector) {
                self.processed_keys
                    .insert(full_idem_key, ProposalStatus::Rejected);
                let seq = Self::append_audit_event(
                    spine,
                    "self_core_reflector_invalid",
                    prop,
                    "Reflector 必须与主模型异构且不得为端侧小模型",
                    now_ms,
                )?;
                rejected_count += 1;
                evaluations.push(ProposalEvaluation {
                    proposal_id: prop.id.clone(),
                    target_id: prop.target_id.clone(),
                    target_authority: prop.target_authority,
                    status: ProposalStatus::Rejected,
                    reason: String::from("Reflector 与 Primary 同模型或不符合异构审计要求"),
                    spine_event_seq: Some(seq),
                });
                continue;
            }

            let ev_count = referenced_episodes.len();
            let cluster_count = Self::count_independent_episode_clusters(
                &referenced_episodes,
                self.policy.min_gap_hours,
            );
            let min_ts = referenced_episodes
                .iter()
                .map(|e| e.started_at_ms)
                .min()
                .unwrap_or(now_ms);
            let max_ts = referenced_episodes
                .iter()
                .map(|e| e.started_at_ms)
                .max()
                .unwrap_or(now_ms);
            let span_ms = max_ts.saturating_sub(min_ts);
            let s5_count = referenced_episodes
                .iter()
                .filter(|e| e.has_s5_pressure())
                .count();
            #[allow(clippy::cast_precision_loss)]
            let pressure_ratio = if ev_count == 0 {
                1.0
            } else {
                (s5_count as f64) / (ev_count as f64)
            };

            let target_last_changed_opt = self
                .last_core_change_by_target
                .get(&prop.target_id)
                .copied()
                .or_else(|| {
                    conscience
                        .values
                        .iter()
                        .filter(|v| v.id == prop.target_id && v.authority == Authority::SelfCore)
                        .map(|v| v.valid_from_ms)
                        .max()
                });
            let cooldown_ms = self.policy.cooldown_days.saturating_mul(DAY_MS);
            let entry_cooldown_ok = target_last_changed_opt
                .is_none_or(|last_ts| now_ms.saturating_sub(last_ts) >= cooldown_ms);

            let recent_core_changes = self
                .core_change_history_ms
                .iter()
                .filter(|&&ts| now_ms.saturating_sub(ts) < cooldown_ms)
                .count();
            let global_quota_ok = recent_core_changes < self.policy.max_core_changes_per_cooldown;

            let min_span_ms = self.policy.min_days.saturating_mul(DAY_MS);

            if ev_count < self.policy.min_evidence
                || cluster_count < self.policy.min_sessions
                || span_ms < min_span_ms
                || pressure_ratio > self.policy.max_pressure_ratio + 1e-12
                || !entry_cooldown_ok
                || !global_quota_ok
            {
                let fail_reason = format!(
                    "SELF_CORE C档门槛未满足: ev={ev_count}/{}, clusters={cluster_count}/{}, span_days={}/{}, s5_ratio={pressure_ratio:.2}/{:.2}, cooldown_ok={entry_cooldown_ok}, quota_ok={global_quota_ok}",
                    self.policy.min_evidence,
                    self.policy.min_sessions,
                    span_ms / DAY_MS,
                    self.policy.min_days,
                    self.policy.max_pressure_ratio,
                );
                self.processed_keys
                    .insert(full_idem_key, ProposalStatus::Rejected);
                let seq = Self::append_audit_event(
                    spine,
                    "self_core_gate_rejected",
                    prop,
                    &fail_reason,
                    now_ms,
                )?;
                rejected_count += 1;
                evaluations.push(ProposalEvaluation {
                    proposal_id: prop.id.clone(),
                    target_id: prop.target_id.clone(),
                    target_authority: prop.target_authority,
                    status: ProposalStatus::Rejected,
                    reason: fail_reason,
                    spine_event_seq: Some(seq),
                });
                continue;
            }

            // 统计独立异构 Reflector 一致性（reflector_agreement >= 2）
            let norm_val = normalize_nfkc_lower_trim(&prop.new_value);
            let agree_bucket_key = (prop.target_id.clone(), norm_val);
            let mut candidates_to_record = vec![ReflectorAttestation {
                reflector: prop.reflector.clone(),
                run_id: prop.id.clone(),
                at_ms: prop.created_at_ms,
            }];
            for extra in &prop.additional_agreements {
                if self.is_valid_heterogeneous_reflector(&extra.reflector) {
                    candidates_to_record.push(extra.clone());
                }
            }

            let agreement_count = {
                let bucket = self
                    .reflector_agreements
                    .entry(agree_bucket_key)
                    .or_default();
                for cand in candidates_to_record {
                    let cand_key = reflector_identity_key(&cand.reflector);
                    if !bucket
                        .iter()
                        .any(|existing| reflector_identity_key(&existing.reflector) == cand_key)
                    {
                        bucket.push(cand);
                    }
                }
                bucket.len()
            };

            if agreement_count < self.policy.reflector_agreement {
                self.processed_keys
                    .insert(full_idem_key, ProposalStatus::PendingReflectorAgreement);
                let seq = Self::append_audit_event(
                    spine,
                    "self_core_pending_agreement",
                    prop,
                    "等待二次独立异构 Reflector 复核达成一致",
                    now_ms,
                )?;
                evaluations.push(ProposalEvaluation {
                    proposal_id: prop.id.clone(),
                    target_id: prop.target_id.clone(),
                    target_authority: prop.target_authority,
                    status: ProposalStatus::PendingReflectorAgreement,
                    reason: format!(
                        "当前异构 Reflector 一致数 {agreement_count}/{}",
                        self.policy.reflector_agreement
                    ),
                    spine_event_seq: Some(seq),
                });
                continue;
            }

            if self.mode == ArbiterMode::Observe || self.mode == ArbiterMode::ManualApproval {
                self.processed_keys
                    .insert(full_idem_key, ProposalStatus::Observed);
                let action_label = if self.mode == ArbiterMode::Observe {
                    "self_core_observed"
                } else {
                    "self_core_pending_manual_approval"
                };
                let seq = Self::append_audit_event(
                    spine,
                    action_label,
                    prop,
                    "非自动提交模式：满足门槛后写入审计，不自动改写 SELF_CORE",
                    now_ms,
                )?;
                evaluations.push(ProposalEvaluation {
                    proposal_id: prop.id.clone(),
                    target_id: prop.target_id.clone(),
                    target_authority: prop.target_authority,
                    status: ProposalStatus::Observed,
                    reason: String::from("观察或人工审批档记录完成"),
                    spine_event_seq: Some(seq),
                });
                continue;
            }

            // C 档全自动升格正式提交！
            for v in &mut conscience.values {
                if (v.id == prop.target_id || prop.supersedes.as_deref() == Some(v.id.as_str()))
                    && v.authority == Authority::SelfCore
                    && v.invalid_at_ms.is_none()
                {
                    v.invalid_at_ms = Some(now_ms);
                }
            }
            conscience.values.push(ValueEntry {
                id: prop.target_id.clone(),
                statement: prop.new_value.clone(),
                rationale: prop.rationale.clone(),
                authority: Authority::SelfCore,
                negotiable_in_conversation: false,
                examples: Vec::new(),
                mutability: Mutability::self_core_default(),
                provenance: ProvenanceRecord {
                    written_by: String::from("agent_reflection"),
                    at_ms: now_ms,
                    source_event_ids: prop.evidence_episode_ids.clone(),
                    model: Some(prop.reflector.clone()),
                    supersedes: prop.supersedes.clone(),
                },
                valid_from_ms: now_ms,
                invalid_at_ms: None,
            });

            if self.policy.requires_disclosure {
                conscience.pending_disclosures.push(DisclosureNotice {
                    target_id: prop.target_id.clone(),
                    summary: prop.new_value.clone(),
                    source_episode_ids: prop.evidence_episode_ids.clone(),
                    created_at_ms: now_ms,
                });
            }

            Self::sync_graph_entry(
                graph,
                "b_self_core",
                "SELF_CORE",
                Some(LockMode::StructureFrozen),
                &prop.target_id,
                &prop.new_value,
                now_ms,
            )?;

            let seq = Self::append_audit_event(
                spine,
                "self_core_promoted",
                prop,
                "满足 C 档多独立证据 + 冷却期 + 异构双 Reflector 门槛，自动升格 SELF_CORE",
                now_ms,
            )?;
            let updated_hlc = spine.local_hlc();
            spine.store_mut().upsert_memory(&MaterializedMemory {
                memory_id: prop.target_id.clone(),
                category: String::from("self_core"),
                authority: Authority::SelfCore.numeric(),
                content: prop.new_value.clone(),
                updated_hlc,
            })?;

            self.last_core_change_by_target
                .insert(prop.target_id.clone(), now_ms);
            self.core_change_history_ms.push(now_ms);
            self.processed_keys
                .insert(full_idem_key, ProposalStatus::Accepted);
            self.accepted_evidence_keys.insert(accepted_key, now_ms);
            accepted_count += 1;

            evaluations.push(ProposalEvaluation {
                proposal_id: prop.id.clone(),
                target_id: prop.target_id.clone(),
                target_authority: prop.target_authority,
                status: ProposalStatus::Accepted,
                reason: String::from("SELF_CORE C档自动升格已提交并入账脊柱"),
                spine_event_seq: Some(seq),
            });
        }

        Ok(ArbiterBatchReport {
            router_epoch,
            evaluations,
            accepted_count,
            parked_cloud_count,
            rejected_count,
            duplicate_count,
        })
    }
}
