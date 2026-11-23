use std::collections::{BTreeMap, BTreeSet};

use quetzalcoatl_types::Result;
use serde::{Deserialize, Serialize};

use crate::graph::{
    EdgeKind, EwaveSnapshot, GraphEdge, GraphNode, LockActor, LockMode, NodeId, NodeKind,
    ObserveOptions, SerpentineGraph, TemporalFilter, TemporalInput, WriteOp, cmp_f64_desc,
    cmp_utf16, cosine_distance, cosine_similarity, hash_embed, lexical_jaccard,
    normalize_nfkc_lower_trim,
};

#[derive(Clone, Debug)]
pub struct AlignOptions {
    pub threshold: f64,
    pub semantic_weight: f64,
    pub structural_weight: f64,
    pub lexical_weight: f64,
    pub same_kind_only: bool,
    pub filter: Option<TemporalFilter>,
    pub offline_fallback: bool,
}

impl Default for AlignOptions {
    fn default() -> Self {
        Self {
            threshold: 0.42,
            semantic_weight: 0.62,
            structural_weight: 0.23,
            lexical_weight: 0.15,
            same_kind_only: true,
            filter: None,
            offline_fallback: false,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlignmentPair {
    pub source_id: NodeId,
    pub target_id: NodeId,
    pub kind: NodeKind,
    pub score: f64,
    pub semantic: f64,
    pub structural: f64,
    pub lexical: f64,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlignmentResult {
    pub pairs: Vec<AlignmentPair>,
    pub source_to_target: BTreeMap<NodeId, NodeId>,
    pub unmatched_source_ids: Vec<NodeId>,
    pub reembedded_foreign_vectors: bool,
    pub used_offline_lexical_fallback: bool,
}

#[derive(Clone, Debug)]
pub struct MergeOptions {
    pub align: AlignOptions,
    pub branch_threshold: f64,
    pub duplicate_distance: f64,
    pub deduplicate: bool,
    pub route_unmatched_root_leaves: bool,
    pub target_slice_id: Option<String>,
    pub actor: LockActor,
}

impl Default for MergeOptions {
    fn default() -> Self {
        Self {
            align: AlignOptions::default(),
            branch_threshold: 0.48,
            duplicate_distance: 0.08,
            deduplicate: true,
            route_unmatched_root_leaves: false,
            target_slice_id: None,
            actor: LockActor::Arbiter,
        }
    }
}

#[derive(Clone, Debug)]
pub struct MergeResult {
    pub alignment: AlignmentResult,
    pub node_map: BTreeMap<NodeId, NodeId>,
    pub added_branches: Vec<GraphNode>,
    pub merged_branches: Vec<GraphNode>,
    pub added_leaves: Vec<GraphNode>,
    pub deduplicated_leaves: Vec<GraphNode>,
    pub added_edges: usize,
    pub queued_reembed_ids: Vec<NodeId>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SayItSessionRecord {
    pub sayit_user_hash: String,
    pub slice_id: String,
    pub session_id: String,
    pub snapshot_sha256: String,
    pub exclusive_node_ids: Vec<NodeId>,
    pub ingested_at_ms: u64,
}

#[derive(Clone, Debug)]
pub struct SayItIngestContext {
    pub sayit_user_hash: String,
    pub slice_id: String,
    pub session_id: String,
    pub snapshot_sha256: String,
    pub now_ms: u64,
    pub merge_options: MergeOptions,
}

#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum SayItIngestStatus {
    IngestedNew,
    DuplicateNoOp,
    RefiledUpdated,
}

#[derive(Clone, Debug)]
pub struct SayItIngestResult {
    pub status: SayItIngestStatus,
    pub invalidated_node_ids: Vec<NodeId>,
    pub merge_result: Option<MergeResult>,
}

fn extract_node_role(node: &GraphNode) -> Option<&str> {
    node.data
        .as_object()
        .and_then(|obj| obj.get("role"))
        .and_then(serde_json::Value::as_str)
        .or_else(|| node.meta.get("role").and_then(serde_json::Value::as_str))
}

fn branches_role_compatible(src: &GraphNode, tgt: &GraphNode, tgt_root_id: &str) -> bool {
    if src.kind != NodeKind::Branch || tgt.kind != NodeKind::Branch {
        return true;
    }
    match (extract_node_role(src), extract_node_role(tgt)) {
        (Some(sr), Some(tr)) => sr == tr,
        (Some(sr), None) => {
            if matches!(sr, "record" | "section")
                && tgt.primary_parent.as_deref() == Some(tgt_root_id)
            {
                return false;
            }
            true
        }
        (None, Some(tr)) => !matches!(tr, "record" | "section"),
        (None, None) => true,
    }
}

impl SerpentineGraph {
    fn expected_dim(&self) -> usize {
        self.dimension.unwrap_or(self.options.emb_dim).max(8)
    }

    fn is_foreign_space(&self, other: &Self) -> bool {
        let target_dim = self.expected_dim();
        let other_dim = other.dimension.unwrap_or(other.options.emb_dim);
        if other_dim != target_dim {
            return true;
        }
        let other_model = other
            .options
            .meta
            .get("emb_model_id")
            .and_then(serde_json::Value::as_str)
            .unwrap_or(&other.options.emb_model_id);
        other_model != self.options.emb_model_id
    }

    fn prepare_foreign_source_for_spine(
        &self,
        other: &Self,
        force_offline: bool,
    ) -> Result<(Self, bool, bool)> {
        if !self.is_foreign_space(other) && !force_offline {
            return Ok((other.clone(), false, false));
        }

        if self.embedder_online && !force_offline {
            let mut adapted = other.clone();
            let target_dim = self.expected_dim();
            adapted.dimension = Some(target_dim);
            adapted.options.emb_dim = target_dim;
            adapted.options.emb_model_id = self.options.emb_model_id.clone();

            let ids: Vec<NodeId> = adapted.nodes.keys().cloned().collect();
            for id in ids {
                let (kind, seed_opt) = match adapted.nodes.get(&id) {
                    Some(n) => (
                        n.kind,
                        n.text
                            .clone()
                            .or_else(|| n.label.clone())
                            .filter(|s| !s.trim().is_empty()),
                    ),
                    None => continue,
                };
                if kind == NodeKind::Root {
                    continue;
                }
                if let Some(seed) = seed_opt {
                    let vec = hash_embed(&seed, target_dim)?;
                    if let Some(node) = adapted.nodes.get_mut(&id) {
                        node.embedding = Some(vec);
                    }
                } else if let Some(node) = adapted.nodes.get_mut(&id) {
                    node.embedding = None;
                }
            }
            adapted.rebuild()?;
            return Ok((adapted, true, false));
        }

        // 离线回退：不调用规范嵌入器，剥离异源维度向量以免触发 EWAVE_DIMENSION，改走词法+结构对齐
        let mut stripped = other.clone();
        stripped.dimension = None;
        for node in stripped.nodes.values_mut() {
            if node.kind != NodeKind::Root {
                node.embedding = None;
                node.centroid = None;
                node.ls = None;
                node.ss = 0.0;
            }
        }
        stripped.rebuild()?;
        Ok((stripped, false, true))
    }

    /// 计算输入不完整子树 `other` 与当前图的结构 + 语义 + 词法对齐映射（纯只读不改图）。
    pub fn align(&self, other: &Self, options: AlignOptions) -> Result<AlignmentResult> {
        other.verify_strict()?;
        let (prepared_other, reembedded, offline_fallback) =
            self.prepare_foreign_source_for_spine(other, options.offline_fallback)?;

        let (w_sem, w_struct, w_lex) = if offline_fallback || options.semantic_weight <= 0.0 {
            let non_sem_sum = options.structural_weight + options.lexical_weight;
            let total_orig =
                options.semantic_weight + options.structural_weight + options.lexical_weight;
            if non_sem_sum > 0.0 && total_orig > 0.0 {
                (
                    0.0,
                    options.structural_weight * (total_orig / non_sem_sum),
                    options.lexical_weight * (total_orig / non_sem_sum),
                )
            } else {
                (0.0, 0.6, 0.4)
            }
        } else {
            (
                options.semantic_weight,
                options.structural_weight,
                options.lexical_weight,
            )
        };

        let source_nodes: Vec<&GraphNode> = prepared_other
            .all(None)
            .into_iter()
            .filter(|n| n.kind != NodeKind::Root && n.is_valid())
            .collect();
        let target_nodes: Vec<&GraphNode> = self
            .all(options.filter.as_ref())
            .into_iter()
            .filter(|n| n.kind != NodeKind::Root)
            .collect();

        let mut base_sem: BTreeMap<(String, String), f64> = BTreeMap::new();
        let mut base_lex: BTreeMap<(String, String), f64> = BTreeMap::new();
        let mut sim0: BTreeMap<(String, String), f64> = BTreeMap::new();

        for s in &source_nodes {
            for t in &target_nodes {
                if options.same_kind_only && s.kind != t.kind {
                    continue;
                }
                if !branches_role_compatible(s, t, &self.root_id) {
                    continue;
                }
                let key = (s.id.clone(), t.id.clone());
                let sem = if w_sem > 0.0
                    && let (Some(sc), Some(tc)) = (&s.centroid, &t.centroid)
                    && sc.len() == tc.len()
                {
                    cosine_similarity(sc, tc)?.max(0.0)
                } else {
                    0.0
                };
                let lex = lexical_jaccard(s.label.as_deref(), t.label.as_deref())
                    .max(lexical_jaccard(
                        Some(s.display_name()),
                        Some(t.display_name()),
                    ))
                    .max(lexical_jaccard(s.text.as_deref(), t.text.as_deref()));
                let init_sim = if w_sem > 0.0 {
                    0.8 * sem + 0.2 * lex
                } else {
                    lex
                };
                base_sem.insert(key.clone(), sem);
                base_lex.insert(key.clone(), lex);
                sim0.insert(key, init_sim);
            }
        }

        let best_match_avg = |s_ids: &[NodeId],
                              t_ids: &[NodeId],
                              src_root: &str,
                              tgt_root: &str,
                              table: &BTreeMap<(String, String), f64>|
         -> f64 {
            if s_ids.is_empty() || t_ids.is_empty() {
                return 0.0;
            }
            let mut sum = 0.0_f64;
            let mut count = 0usize;
            for sid in s_ids {
                if sid == src_root {
                    continue;
                }
                let mut best = 0.0_f64;
                for tid in t_ids {
                    if tid == tgt_root {
                        continue;
                    }
                    let val = table
                        .get(&(sid.clone(), tid.clone()))
                        .copied()
                        .unwrap_or(0.0);
                    if val > best {
                        best = val;
                    }
                }
                sum += best;
                count += 1;
            }
            if count == 0 {
                0.0
            } else {
                #[allow(clippy::cast_precision_loss)]
                {
                    sum / (count as f64)
                }
            }
        };

        let mut current_sim = sim0;
        let mut struct_scores: BTreeMap<(String, String), f64> = BTreeMap::new();
        for _round in 0..2 {
            let mut next_sim = BTreeMap::new();
            for s in &source_nodes {
                for t in &target_nodes {
                    if options.same_kind_only && s.kind != t.kind {
                        continue;
                    }
                    if !branches_role_compatible(s, t, &self.root_id) {
                        continue;
                    }
                    let key = (s.id.clone(), t.id.clone());
                    let parent_sim = best_match_avg(
                        &s.parents,
                        &t.parents,
                        &prepared_other.root_id,
                        &self.root_id,
                        &current_sim,
                    );
                    let child_sim = best_match_avg(
                        &s.children,
                        &t.children,
                        &prepared_other.root_id,
                        &self.root_id,
                        &current_sim,
                    );
                    let link_sim = best_match_avg(
                        &s.links,
                        &t.links,
                        &prepared_other.root_id,
                        &self.root_id,
                        &current_sim,
                    );

                    let mut parts = Vec::with_capacity(3);
                    if s.parents.iter().any(|id| id != &prepared_other.root_id)
                        && t.parents.iter().any(|id| id != &self.root_id)
                    {
                        parts.push(parent_sim);
                    }
                    if !s.children.is_empty() && !t.children.is_empty() {
                        parts.push(child_sim);
                    }
                    if !s.links.is_empty() && !t.links.is_empty() {
                        parts.push(link_sim);
                    }

                    let prev = current_sim.get(&key).copied().unwrap_or(0.0);
                    let st = if parts.is_empty() {
                        prev
                    } else {
                        #[allow(clippy::cast_precision_loss)]
                        {
                            parts.iter().sum::<f64>() / (parts.len() as f64)
                        }
                    };
                    struct_scores.insert(key.clone(), st);
                    next_sim.insert(key, 0.65 * prev + 0.35 * st);
                }
            }
            current_sim = next_sim;
        }

        let mut candidates = Vec::new();
        for s in &source_nodes {
            for t in &target_nodes {
                if options.same_kind_only && s.kind != t.kind {
                    continue;
                }
                if !branches_role_compatible(s, t, &self.root_id) {
                    continue;
                }
                let key = (s.id.clone(), t.id.clone());
                let semantic = base_sem.get(&key).copied().unwrap_or(0.0);
                let structural = struct_scores.get(&key).copied().unwrap_or(0.0);
                let lexical = base_lex.get(&key).copied().unwrap_or(0.0);
                let score = w_sem * semantic + w_struct * structural + w_lex * lexical;
                if score >= options.threshold {
                    candidates.push(AlignmentPair {
                        source_id: s.id.clone(),
                        target_id: t.id.clone(),
                        kind: s.kind,
                        score,
                        semantic,
                        structural,
                        lexical,
                    });
                }
            }
        }

        candidates.sort_by(|a, b| {
            cmp_f64_desc(a.score, b.score)
                .then_with(|| cmp_utf16(&a.source_id, &b.source_id))
                .then_with(|| cmp_utf16(&a.target_id, &b.target_id))
        });

        let mut used_source = BTreeSet::new();
        let mut used_target = BTreeSet::new();
        let mut pairs = Vec::new();
        let mut source_to_target = BTreeMap::new();
        source_to_target.insert(prepared_other.root_id.clone(), self.root_id.clone());

        for pair in candidates {
            if used_source.contains(&pair.source_id) || used_target.contains(&pair.target_id) {
                continue;
            }
            used_source.insert(pair.source_id.clone());
            used_target.insert(pair.target_id.clone());
            source_to_target.insert(pair.source_id.clone(), pair.target_id.clone());
            pairs.push(pair);
        }

        let unmatched_source_ids = source_nodes
            .into_iter()
            .map(|n| n.id.clone())
            .filter(|id| !used_source.contains(id))
            .collect();

        Ok(AlignmentResult {
            pairs,
            source_to_target,
            unmatched_source_ids,
            reembedded_foreign_vectors: reembedded,
            used_offline_lexical_fallback: offline_fallback,
        })
    }

    /// 将外部不完整子树合并入当前主图（保留多父归属、时间切片与正负逻辑边，并兑现防坑 #11 ①②④）。
    pub fn merge(&mut self, other: &Self, options: MergeOptions) -> Result<MergeResult> {
        other.verify_strict()?;
        let (prepared_other, reembedded, offline_fallback) =
            self.prepare_foreign_source_for_spine(other, options.align.offline_fallback)?;

        let mut align_opts = options.align.clone();
        if offline_fallback {
            align_opts.offline_fallback = true;
        }
        let mut alignment = self.align(&prepared_other, align_opts)?;
        alignment.reembedded_foreign_vectors = reembedded;
        alignment.used_offline_lexical_fallback = offline_fallback;

        let mut node_map: BTreeMap<NodeId, NodeId> = BTreeMap::new();
        node_map.insert(prepared_other.root_id.clone(), self.root_id.clone());

        let mut added_branches = Vec::new();
        let mut merged_branches = Vec::new();
        let mut added_leaves = Vec::new();
        let mut deduplicated_leaves = Vec::new();
        let mut queued_reembed_ids = Vec::new();
        let mut added_edges = 0usize;

        let pair_by_source: BTreeMap<NodeId, &AlignmentPair> = alignment
            .pairs
            .iter()
            .map(|p| (p.source_id.clone(), p))
            .collect();

        // 1. Top-down depth-ordered branch merge
        let mut src_branches: Vec<(&GraphNode, usize)> = prepared_other
            .branches(None)
            .into_iter()
            .filter(|n| n.kind == NodeKind::Branch && n.is_valid())
            .map(|n| {
                let d = prepared_other.path(&n.id).map_or(0, |p| p.len());
                (n, d)
            })
            .collect();
        src_branches.sort_by(|(a, da), (b, db)| da.cmp(db).then_with(|| cmp_utf16(&a.id, &b.id)));

        for (src_branch, _) in src_branches {
            let mapped_parent_id = src_branch
                .primary_parent
                .as_ref()
                .and_then(|pp| node_map.get(pp))
                .cloned()
                .unwrap_or_else(|| self.root_id.clone());

            let src_norm_label =
                normalize_nfkc_lower_trim(src_branch.label.as_deref().unwrap_or(""));
            let mut matched_target_id: Option<NodeId> = None;

            if !src_norm_label.is_empty()
                && let Some(mp) = self.nodes.get(&mapped_parent_id)
            {
                for cid in &mp.children {
                    if let Some(cand) = self.nodes.get(cid)
                        && cand.kind == NodeKind::Branch
                        && branches_role_compatible(src_branch, cand, &self.root_id)
                        && normalize_nfkc_lower_trim(cand.label.as_deref().unwrap_or(""))
                            == src_norm_label
                    {
                        matched_target_id = Some(cand.id.clone());
                        break;
                    }
                }
            }

            if matched_target_id.is_none()
                && let Some(aligned) = pair_by_source.get(&src_branch.id)
                && aligned.score >= options.branch_threshold
                && let Some(cand) = self.nodes.get(&aligned.target_id)
                && cand.kind == NodeKind::Branch
                && branches_role_compatible(src_branch, cand, &self.root_id)
                && self.lock_mode(&cand.id) != Some(LockMode::ReadOnly)
            {
                matched_target_id = Some(cand.id.clone());
            }

            if let Some(tid) = matched_target_id {
                node_map.insert(src_branch.id.clone(), tid.clone());
                if let Some(mnode) = self.nodes.get(&tid) {
                    merged_branches.push(mnode.clone());
                }
            } else {
                self.check_write_lock(&mapped_parent_id, WriteOp::Branch)?;
                let src_pp = src_branch
                    .primary_parent
                    .as_deref()
                    .unwrap_or(&prepared_other.root_id);
                let edge_weight = prepared_other
                    .edge(src_pp, &src_branch.id, EdgeKind::Hierarchy)
                    .map_or(1.0, |e| e.weight);
                let mut meta = src_branch.meta.clone();
                if offline_fallback {
                    meta.insert(
                        String::from("reembed_pending"),
                        serde_json::Value::Bool(true),
                    );
                }
                let mut time = src_branch.time.clone();
                if let Some(ts) = &options.target_slice_id {
                    time.slice_id = ts.clone();
                }
                let emb = match &src_branch.embedding {
                    Some(raw) => Some(self.validate_and_lock_embedding(raw)?),
                    None => None,
                };
                let created = self.make_node(
                    None,
                    NodeKind::Branch,
                    src_branch.data.clone(),
                    src_branch.text.clone(),
                    src_branch.label.clone(),
                    emb,
                    time,
                    meta,
                )?;
                let cid = created.id.clone();
                self.nodes.insert(cid.clone(), created.clone());
                self.attach_internal(
                    &cid,
                    &mapped_parent_id,
                    true,
                    true,
                    edge_weight,
                    None,
                    BTreeMap::new(),
                )?;
                if offline_fallback {
                    self.pending_reembed.push(cid.clone());
                    queued_reembed_ids.push(cid.clone());
                }
                node_map.insert(src_branch.id.clone(), cid);
                added_branches.push(created);
                added_edges += 1;
            }
        }

        // 2. Leaves
        let mut src_leaves: Vec<&GraphNode> = prepared_other
            .leaves(None)
            .into_iter()
            .filter(|n| n.is_valid())
            .collect();
        src_leaves.sort_by(|a, b| cmp_utf16(&a.id, &b.id));

        for src_leaf in src_leaves {
            let src_pp = src_leaf
                .primary_parent
                .as_deref()
                .unwrap_or(&prepared_other.root_id);
            let mapped_parent_id = node_map
                .get(src_pp)
                .cloned()
                .unwrap_or_else(|| self.root_id.clone());

            if options.deduplicate {
                let src_text = normalize_nfkc_lower_trim(
                    src_leaf
                        .text
                        .as_deref()
                        .or(src_leaf.label.as_deref())
                        .unwrap_or(""),
                );
                let mut dup_id: Option<NodeId> = None;
                if let Some(mp) = self.nodes.get(&mapped_parent_id) {
                    for cid in &mp.children {
                        let Some(child) = self.nodes.get(cid) else {
                            continue;
                        };
                        if child.kind != NodeKind::Leaf || !child.is_valid() {
                            continue;
                        }
                        let child_text = normalize_nfkc_lower_trim(
                            child
                                .text
                                .as_deref()
                                .or(child.label.as_deref())
                                .unwrap_or(""),
                        );
                        if let (Some(se), Some(ce)) = (&src_leaf.embedding, &child.embedding)
                            && se.len() == ce.len()
                        {
                            let dist = cosine_distance(se, ce)?;
                            if dist <= options.duplicate_distance {
                                let is_dup = if !src_text.is_empty() || !child_text.is_empty() {
                                    src_text == child_text
                                        || lexical_jaccard(Some(&src_text), Some(&child_text))
                                            >= 0.85
                                } else {
                                    dist <= 1e-4
                                };
                                if is_dup {
                                    dup_id = Some(child.id.clone());
                                    break;
                                }
                            }
                        } else if offline_fallback && !src_text.is_empty() && src_text == child_text
                        {
                            dup_id = Some(child.id.clone());
                            break;
                        }
                    }
                }
                if let Some(did) = dup_id {
                    node_map.insert(src_leaf.id.clone(), did.clone());
                    if let Some(dnode) = self.nodes.get(&did) {
                        deduplicated_leaves.push(dnode.clone());
                    }
                    continue;
                }
            }

            if src_pp == prepared_other.root_id
                && options.route_unmatched_root_leaves
                && let Some(emb) = &src_leaf.embedding
            {
                let obs = self.observe(
                    src_leaf.data.clone(),
                    ObserveOptions {
                        text: src_leaf.text.clone(),
                        label: src_leaf.label.clone(),
                        embedding: Some(emb.clone()),
                        time: Some(TemporalInput {
                            at: Some(src_leaf.time.at),
                            end_at: src_leaf.time.end_at,
                            slice_id: Some(
                                options
                                    .target_slice_id
                                    .clone()
                                    .unwrap_or_else(|| src_leaf.time.slice_id.clone()),
                            ),
                            valid_from: Some(src_leaf.time.valid_from),
                            invalid_at: src_leaf.time.invalid_at,
                        }),
                        meta: src_leaf.meta.clone(),
                        ..ObserveOptions::default()
                    },
                )?;
                node_map.insert(src_leaf.id.clone(), obs.node.id.clone());
                added_leaves.push(obs.node);
                added_edges += 1;
                continue;
            }

            self.check_write_lock(&mapped_parent_id, WriteOp::Add)?;
            let edge_weight = prepared_other
                .edge(src_pp, &src_leaf.id, EdgeKind::Hierarchy)
                .map_or(1.0, |e| e.weight);
            let mut meta = src_leaf.meta.clone();
            if offline_fallback {
                meta.insert(
                    String::from("reembed_pending"),
                    serde_json::Value::Bool(true),
                );
            }
            let mut time = src_leaf.time.clone();
            if let Some(ts) = &options.target_slice_id {
                time.slice_id = ts.clone();
            }
            let emb = match &src_leaf.embedding {
                Some(raw) => Some(self.validate_and_lock_embedding(raw)?),
                None => None,
            };
            let created = self.make_node(
                None,
                NodeKind::Leaf,
                src_leaf.data.clone(),
                src_leaf.text.clone(),
                src_leaf.label.clone(),
                emb,
                time,
                meta,
            )?;
            let cid = created.id.clone();
            self.nodes.insert(cid.clone(), created.clone());
            self.attach_internal(
                &cid,
                &mapped_parent_id,
                true,
                true,
                edge_weight,
                None,
                BTreeMap::new(),
            )?;
            if offline_fallback {
                self.pending_reembed.push(cid.clone());
                queued_reembed_ids.push(cid.clone());
            }
            node_map.insert(src_leaf.id.clone(), cid);
            added_leaves.push(created);
            added_edges += 1;
        }

        // 3. Replay secondary multi-parent hierarchy edges
        for edge in prepared_other.edges_for(None, Some(EdgeKind::Hierarchy), None) {
            let (Some(pid), Some(cid)) = (node_map.get(&edge.from), node_map.get(&edge.to)) else {
                continue;
            };
            if pid == cid {
                continue;
            }
            let valid_kinds = match (self.nodes.get(pid), self.nodes.get(cid)) {
                (Some(p), Some(c)) => p.kind != NodeKind::Leaf && c.kind != NodeKind::Root,
                _ => false,
            };
            if !valid_kinds {
                continue;
            }
            if self.edges.contains_key(&format!("hierarchy:{pid}>{cid}")) {
                continue;
            }
            if self.reaches(pid, cid) {
                continue;
            }
            if self.lock_mode(pid).is_some() || self.lock_mode(cid).is_some() {
                continue;
            }
            self.attach_internal(
                cid,
                pid,
                false,
                true,
                edge.weight,
                edge.relation.clone(),
                edge.meta.clone(),
            )?;
            added_edges += 1;
        }

        // 4. Replay directed weighted & signed logic edges (+1 / -1)
        for edge in prepared_other.edges_for(None, Some(EdgeKind::Link), None) {
            let (Some(fid), Some(tid)) = (node_map.get(&edge.from), node_map.get(&edge.to)) else {
                continue;
            };
            if fid == tid || !self.nodes.contains_key(fid) || !self.nodes.contains_key(tid) {
                continue;
            }
            if self.lock_mode(fid) == Some(LockMode::ReadOnly)
                || self.lock_mode(tid) == Some(LockMode::ReadOnly)
            {
                continue;
            }
            let key = format!("link:{fid}>{tid}");
            if !self.edges.contains_key(&key) {
                added_edges += 1;
            }
            let now = self.tick_now();
            self.edges.insert(
                key,
                GraphEdge {
                    from: fid.clone(),
                    to: tid.clone(),
                    kind: EdgeKind::Link,
                    weight: edge.weight,
                    polarity: edge.polarity,
                    relation: edge.relation.clone(),
                    created_at: now,
                    meta: edge.meta.clone(),
                },
            );
            if let Some(f) = self.nodes.get_mut(fid) {
                f.add_out_link(tid);
            }
            if let Some(t) = self.nodes.get_mut(tid) {
                t.add_in_link(fid);
            }
        }

        self.rebuild()?;
        let _ = options.actor;

        Ok(MergeResult {
            alignment,
            node_map,
            added_branches,
            merged_branches,
            added_leaves,
            deduplicated_leaves,
            added_edges,
            queued_reembed_ids,
        })
    }

    /// 吸纳 `SayIt`（`sayit-handoff.md` v2.1）子树快照（防坑规范 #11 ①②③④）：
    /// - 同一 `(sayit_user_hash, slice_id, session_id, snapshot_sha256)` 严格幂等无操作；
    /// - 同 `sessionId` 因用户改归属重编译产生新 `snapshot_sha256` 时，先双时态 `invalidate()` 旧版独占节点再合并新版。
    pub fn ingest_sayit_subtree(
        &mut self,
        snapshot: EwaveSnapshot,
        ctx: SayItIngestContext,
    ) -> Result<SayItIngestResult> {
        let record_key = (ctx.sayit_user_hash.clone(), ctx.session_id.clone());
        let mut invalidated_node_ids = Vec::new();
        let is_refile;

        if let Some(existing) = self.sayit_records.get(&record_key).cloned() {
            if existing.snapshot_sha256 == ctx.snapshot_sha256 && existing.slice_id == ctx.slice_id
            {
                return Ok(SayItIngestResult {
                    status: SayItIngestStatus::DuplicateNoOp,
                    invalidated_node_ids: Vec::new(),
                    merge_result: None,
                });
            }
            is_refile = true;
            let exclusive_set: BTreeSet<NodeId> =
                existing.exclusive_node_ids.iter().cloned().collect();

            // 1) 先使旧版独占叶节点双时态失效
            for old_id in &existing.exclusive_node_ids {
                if let Some(node) = self.nodes.get(old_id)
                    && node.kind == NodeKind::Leaf
                    && node.is_valid()
                    && self.lock_mode(old_id).is_none()
                {
                    let _ = self.invalidate(old_id, ctx.now_ms)?;
                    invalidated_node_ids.push(old_id.clone());
                }
            }
            // 2) 再自底向上使无其他活跃子节点的旧独占分支失效（绝不误伤已被共享的项目分支）
            let mut branch_candidates: Vec<(NodeId, usize)> = existing
                .exclusive_node_ids
                .iter()
                .filter_map(|id| {
                    let n = self.nodes.get(id)?;
                    if n.kind == NodeKind::Branch && n.is_valid() {
                        let depth = self.path(id).map_or(0, |p| p.len());
                        Some((id.clone(), depth))
                    } else {
                        None
                    }
                })
                .collect();
            branch_candidates.sort_by(|(a, da), (b, db)| db.cmp(da).then_with(|| cmp_utf16(a, b)));

            for (bid, _) in branch_candidates {
                let has_external_active_child = self.nodes.get(&bid).is_some_and(|b| {
                    b.children.iter().any(|cid| {
                        self.nodes
                            .get(cid)
                            .is_some_and(|c| c.is_valid() && !exclusive_set.contains(cid))
                    })
                });
                if !has_external_active_child && self.lock_mode(&bid).is_none() {
                    let _ = self.invalidate(&bid, ctx.now_ms)?;
                    invalidated_node_ids.push(bid);
                }
            }
        } else {
            is_refile = false;
        }

        let incoming = Self::from_snapshot(snapshot)?;
        let merge_res = self.merge(&incoming, ctx.merge_options)?;

        let mut new_exclusive_ids: Vec<NodeId> = Vec::new();
        for leaf in &merge_res.added_leaves {
            new_exclusive_ids.push(leaf.id.clone());
        }
        for branch in &merge_res.added_branches {
            new_exclusive_ids.push(branch.id.clone());
        }

        self.sayit_records.insert(
            record_key,
            SayItSessionRecord {
                sayit_user_hash: ctx.sayit_user_hash,
                slice_id: ctx.slice_id,
                session_id: ctx.session_id,
                snapshot_sha256: ctx.snapshot_sha256,
                exclusive_node_ids: new_exclusive_ids,
                ingested_at_ms: ctx.now_ms,
            },
        );

        let status = if is_refile {
            SayItIngestStatus::RefiledUpdated
        } else {
            SayItIngestStatus::IngestedNew
        };

        Ok(SayItIngestResult {
            status,
            invalidated_node_ids,
            merge_result: Some(merge_res),
        })
    }
}
