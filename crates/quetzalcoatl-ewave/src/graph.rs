use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet};

use quetzalcoatl_types::{QuetzalcoatlError, Result};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use unicode_normalization::UnicodeNormalization;

use crate::align::SayItSessionRecord;

pub type NodeId = String;

pub const DEFAULT_EMB_MODEL_ID: &str = "ewave-fnv1a-utf16-64-v1";
pub const DEFAULT_EMB_DIM: usize = 64;

const MAX_SAFE_JS_INT: f64 = 9_007_199_254_740_991.0;

#[allow(clippy::cast_possible_truncation)]
fn serialize_js_f64<S: Serializer>(
    val: &f64,
    serializer: S,
) -> std::result::Result<S::Ok, S::Error> {
    if val.is_finite() && val.fract() == 0.0 && (-MAX_SAFE_JS_INT..=MAX_SAFE_JS_INT).contains(val) {
        let int_val = if *val == 0.0 { 0_i64 } else { *val as i64 };
        serializer.serialize_i64(int_val)
    } else {
        serializer.serialize_f64(*val)
    }
}

#[allow(clippy::cast_possible_truncation)]
fn serialize_js_opt_vec<S: Serializer>(
    opt: &Option<Vec<f64>>,
    serializer: S,
) -> std::result::Result<S::Ok, S::Error> {
    use serde::ser::SerializeSeq;
    match opt {
        None => serializer.serialize_none(),
        Some(vec) => {
            let mut seq = serializer.serialize_seq(Some(vec.len()))?;
            for &val in vec {
                if val.is_finite()
                    && val.fract() == 0.0
                    && (-MAX_SAFE_JS_INT..=MAX_SAFE_JS_INT).contains(&val)
                {
                    let int_val = if val == 0.0 { 0_i64 } else { val as i64 };
                    seq.serialize_element(&int_val)?;
                } else {
                    seq.serialize_element(&val)?;
                }
            }
            seq.end()
        }
    }
}

pub(crate) fn cmp_f64_asc(a: f64, b: f64) -> Ordering {
    if a == b {
        Ordering::Equal
    } else {
        a.total_cmp(&b)
    }
}

pub(crate) fn cmp_f64_desc(a: f64, b: f64) -> Ordering {
    cmp_f64_asc(b, a)
}

#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NodeKind {
    Root,
    Branch,
    Leaf,
}

#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EdgeKind {
    Hierarchy,
    Link,
}

#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash)]
pub enum LogicPolarity {
    Positive,
    Negative,
}

impl LogicPolarity {
    #[must_use]
    pub const fn as_i8(self) -> i8 {
        match self {
            Self::Positive => 1,
            Self::Negative => -1,
        }
    }

    #[must_use]
    pub const fn as_f64(self) -> f64 {
        match self {
            Self::Positive => 1.0,
            Self::Negative => -1.0,
        }
    }
}

impl Serialize for LogicPolarity {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        serializer.serialize_i8(self.as_i8())
    }
}

impl<'de> Deserialize<'de> for LogicPolarity {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Self, D::Error> {
        let v = i8::deserialize(deserializer)?;
        match v {
            1 => Ok(Self::Positive),
            -1 => Ok(Self::Negative),
            other => Err(serde::de::Error::custom(format!(
                "invalid polarity {other}, expected 1 or -1"
            ))),
        }
    }
}

#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LockMode {
    ReadOnly,
    StructureFrozen,
}

#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LockActor {
    Owner,
    Operator,
    Arbiter,
}

impl LockActor {
    const fn rank(self) -> u8 {
        match self {
            Self::Owner => 0,
            Self::Operator => 1,
            Self::Arbiter => 2,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeLock {
    pub scope_root: NodeId,
    pub mode: LockMode,
    pub set_by: LockActor,
    pub reason: String,
    pub created_at: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TemporalTag {
    pub at: u64,
    pub end_at: Option<u64>,
    pub slice_id: String,
    pub valid_from: u64,
    pub invalid_at: Option<u64>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TemporalInput {
    pub at: Option<u64>,
    pub end_at: Option<u64>,
    pub slice_id: Option<String>,
    pub valid_from: Option<u64>,
    pub invalid_at: Option<u64>,
}

#[derive(Copy, Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TemporalMode {
    #[default]
    Sliced,
    Collapsed,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TemporalFilter {
    pub slice_ids: Option<Vec<String>>,
    pub from: Option<u64>,
    pub to: Option<u64>,
    pub include_invalid: bool,
    pub mode: TemporalMode,
    pub cross_slice_links: bool,
}

impl Default for TemporalFilter {
    fn default() -> Self {
        Self {
            slice_ids: None,
            from: None,
            to: None,
            include_invalid: false,
            mode: TemporalMode::Sliced,
            cross_slice_links: true,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct ClusteringFeature {
    pub n: f64,
    pub ls: Vec<f64>,
    pub ss: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeSnapshot {
    pub id: NodeId,
    pub kind: NodeKind,
    pub data: serde_json::Value,
    pub text: Option<String>,
    pub label: Option<String>,
    #[serde(serialize_with = "serialize_js_opt_vec")]
    pub embedding: Option<Vec<f64>>,
    pub parents: Vec<NodeId>,
    pub primary_parent: Option<NodeId>,
    pub children: Vec<NodeId>,
    pub links: Vec<NodeId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub out_links: Option<Vec<NodeId>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub in_links: Option<Vec<NodeId>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub time: Option<TemporalTag>,
    pub created_at: u64,
    pub updated_at: u64,
    #[serde(default)]
    pub meta: BTreeMap<String, serde_json::Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EdgeSnapshot {
    pub from: NodeId,
    pub to: NodeId,
    pub kind: EdgeKind,
    #[serde(serialize_with = "serialize_js_f64")]
    pub weight: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub polarity: Option<LogicPolarity>,
    #[serde(default)]
    pub relation: Option<String>,
    pub created_at: u64,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub meta: BTreeMap<String, serde_json::Value>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EwaveSnapshot {
    pub format: String,
    pub version: u8,
    pub name: Option<String>,
    pub created_at: u64,
    pub updated_at: u64,
    pub nodes: Vec<NodeSnapshot>,
    #[serde(default)]
    pub edges: Vec<EdgeSnapshot>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub locks: Option<Vec<NodeLock>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub meta: Option<BTreeMap<String, serde_json::Value>>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct GraphNode {
    pub id: NodeId,
    pub kind: NodeKind,
    pub data: serde_json::Value,
    pub text: Option<String>,
    pub label: Option<String>,
    pub embedding: Option<Vec<f64>>,
    pub centroid: Option<Vec<f64>>,
    pub count: usize,
    pub member_count: f64,
    pub ls: Option<Vec<f64>>,
    pub ss: f64,
    pub radius: f64,
    pub cusum: f64,
    pub parents: Vec<NodeId>,
    pub primary_parent: Option<NodeId>,
    pub children: Vec<NodeId>,
    pub links: Vec<NodeId>,
    pub out_links: Vec<NodeId>,
    pub in_links: Vec<NodeId>,
    pub time: TemporalTag,
    pub created_at: u64,
    pub updated_at: u64,
    pub meta: BTreeMap<String, serde_json::Value>,
    pub(crate) drift_count: u64,
    pub(crate) drift_mean: f64,
    pub(crate) ph_sum: f64,
    pub(crate) ph_min: f64,
}

impl GraphNode {
    #[must_use]
    pub const fn is_valid(&self) -> bool {
        self.time.invalid_at.is_none()
    }

    #[must_use]
    pub fn slice_id(&self) -> &str {
        &self.time.slice_id
    }

    #[must_use]
    pub fn display_name(&self) -> &str {
        if let Some(lbl) = &self.label {
            lbl
        } else if let Some(txt) = &self.text {
            txt
        } else {
            &self.id
        }
    }

    #[must_use]
    pub fn to_snapshot(&self) -> NodeSnapshot {
        NodeSnapshot {
            id: self.id.clone(),
            kind: self.kind,
            data: self.data.clone(),
            text: self.text.clone(),
            label: self.label.clone(),
            embedding: self.embedding.clone(),
            parents: self.parents.clone(),
            primary_parent: self.primary_parent.clone(),
            children: self.children.clone(),
            links: self.links.clone(),
            out_links: Some(self.out_links.clone()),
            in_links: Some(self.in_links.clone()),
            time: Some(self.time.clone()),
            created_at: self.created_at,
            updated_at: self.updated_at,
            meta: self.meta.clone(),
        }
    }

    pub(crate) fn step_drift(&mut self, residual: f64, delta: f64) -> f64 {
        self.drift_count = self.drift_count.saturating_add(1);
        #[allow(clippy::cast_precision_loss)]
        let cnt = self.drift_count as f64;
        self.drift_mean += (residual - self.drift_mean) / cnt;
        self.ph_sum += residual - self.drift_mean - delta;
        if self.ph_sum < self.ph_min {
            self.ph_min = self.ph_sum;
        }
        self.cusum = (self.ph_sum - self.ph_min).max(0.0);
        self.cusum
    }

    pub(crate) fn reset_drift(&mut self) {
        self.drift_count = 0;
        self.drift_mean = 0.0;
        self.ph_sum = 0.0;
        self.ph_min = 0.0;
        self.cusum = 0.0;
    }

    pub(crate) fn add_parent(&mut self, parent_id: &str) {
        if !self.parents.iter().any(|p| p == parent_id) {
            self.parents.push(String::from(parent_id));
        }
    }

    pub(crate) fn remove_parent(&mut self, parent_id: &str) {
        if let Some(pos) = self.parents.iter().position(|p| p == parent_id) {
            self.parents.remove(pos);
        }
    }

    pub(crate) fn add_child(&mut self, child_id: &str) {
        if !self.children.iter().any(|c| c == child_id) {
            self.children.push(String::from(child_id));
        }
    }

    pub(crate) fn remove_child(&mut self, child_id: &str) {
        if let Some(pos) = self.children.iter().position(|c| c == child_id) {
            self.children.remove(pos);
        }
    }

    pub(crate) fn add_out_link(&mut self, target_id: &str) {
        if !self.out_links.iter().any(|x| x == target_id) {
            self.out_links.push(String::from(target_id));
        }
        if !self.links.iter().any(|x| x == target_id) {
            self.links.push(String::from(target_id));
        }
    }

    pub(crate) fn add_in_link(&mut self, source_id: &str) {
        if !self.in_links.iter().any(|x| x == source_id) {
            self.in_links.push(String::from(source_id));
        }
        if !self.links.iter().any(|x| x == source_id) {
            self.links.push(String::from(source_id));
        }
    }

    pub(crate) fn remove_out_link(&mut self, target_id: &str) {
        if let Some(pos) = self.out_links.iter().position(|x| x == target_id) {
            self.out_links.remove(pos);
        }
        if !self.out_links.iter().any(|x| x == target_id)
            && !self.in_links.iter().any(|x| x == target_id)
            && let Some(lpos) = self.links.iter().position(|x| x == target_id)
        {
            self.links.remove(lpos);
        }
    }

    pub(crate) fn remove_in_link(&mut self, source_id: &str) {
        if let Some(pos) = self.in_links.iter().position(|x| x == source_id) {
            self.in_links.remove(pos);
        }
        if !self.out_links.iter().any(|x| x == source_id)
            && !self.in_links.iter().any(|x| x == source_id)
            && let Some(lpos) = self.links.iter().position(|x| x == source_id)
        {
            self.links.remove(lpos);
        }
    }

    pub(crate) fn remove_all_links_with(&mut self, other_id: &str) {
        self.out_links.retain(|x| x != other_id);
        self.in_links.retain(|x| x != other_id);
        self.links.retain(|x| x != other_id);
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct GraphEdge {
    pub from: NodeId,
    pub to: NodeId,
    pub kind: EdgeKind,
    pub weight: f64,
    pub polarity: LogicPolarity,
    pub relation: Option<String>,
    pub created_at: u64,
    pub meta: BTreeMap<String, serde_json::Value>,
}

impl GraphEdge {
    #[must_use]
    pub fn signed_weight(&self) -> f64 {
        self.weight * self.polarity.as_f64()
    }

    #[must_use]
    pub fn key(&self) -> String {
        match self.kind {
            EdgeKind::Link => format!("link:{}>{}", self.from, self.to),
            EdgeKind::Hierarchy => format!("hierarchy:{}>{}", self.from, self.to),
        }
    }

    #[must_use]
    pub fn to_snapshot(&self) -> EdgeSnapshot {
        EdgeSnapshot {
            from: self.from.clone(),
            to: self.to.clone(),
            kind: self.kind,
            weight: self.weight,
            polarity: Some(self.polarity),
            relation: self.relation.clone(),
            created_at: self.created_at,
            meta: self.meta.clone(),
        }
    }
}

#[derive(Clone, Debug)]
pub struct GraphOptions {
    pub name: Option<String>,
    pub emb_model_id: String,
    pub emb_dim: usize,
    pub threshold: f64,
    pub split_threshold: f64,
    pub min_children: usize,
    pub auto_split: bool,
    pub adaptive_threshold: bool,
    pub tau_alpha: f64,
    pub tau_min: f64,
    pub tau_max: f64,
    pub grow_branch_on_far: bool,
    pub drift_delta: f64,
    pub drift_lambda: f64,
    pub default_slice_id: String,
    pub slice_window_ms: Option<u64>,
    pub slice_routing: bool,
    pub initial_now_ms: u64,
    pub meta: BTreeMap<String, serde_json::Value>,
}

impl Default for GraphOptions {
    fn default() -> Self {
        Self {
            name: None,
            emb_model_id: String::from(DEFAULT_EMB_MODEL_ID),
            emb_dim: DEFAULT_EMB_DIM,
            threshold: 0.38,
            split_threshold: 0.75,
            min_children: 4,
            auto_split: true,
            adaptive_threshold: false,
            tau_alpha: 1.2,
            tau_min: 0.05,
            tau_max: 0.6,
            grow_branch_on_far: false,
            drift_delta: 0.01,
            drift_lambda: 0.5,
            default_slice_id: String::from("default"),
            slice_window_ms: None,
            slice_routing: false,
            initial_now_ms: 1_795_400_000_000,
            meta: BTreeMap::new(),
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct ObserveOptions {
    pub id: Option<NodeId>,
    pub embedding: Option<Vec<f64>>,
    pub text: Option<String>,
    pub label: Option<String>,
    pub parent: Option<NodeId>,
    pub weight: Option<f64>,
    pub at: Option<u64>,
    pub end_at: Option<u64>,
    pub slice_id: Option<String>,
    pub time: Option<TemporalInput>,
    pub route_in_slice: Option<bool>,
    pub grow_branch: Option<bool>,
    pub meta: BTreeMap<String, serde_json::Value>,
}

pub type AddOptions = ObserveOptions;

#[derive(Clone, Debug, Default)]
pub struct BranchOptions {
    pub id: Option<NodeId>,
    pub label: Option<String>,
    pub text: Option<String>,
    pub data: Option<serde_json::Value>,
    pub embedding: Option<Vec<f64>>,
    pub parent: Option<NodeId>,
    pub weight: Option<f64>,
    pub at: Option<u64>,
    pub end_at: Option<u64>,
    pub slice_id: Option<String>,
    pub time: Option<TemporalInput>,
    pub meta: BTreeMap<String, serde_json::Value>,
}

#[derive(Clone, Debug, Default)]
pub struct AttachOptions {
    pub primary: bool,
    pub weight: Option<f64>,
    pub relation: Option<String>,
    pub meta: BTreeMap<String, serde_json::Value>,
}

#[derive(Clone, Debug)]
pub struct LinkOptions {
    pub weight: f64,
    pub polarity: LogicPolarity,
    pub relation: Option<String>,
    pub meta: BTreeMap<String, serde_json::Value>,
}

impl Default for LinkOptions {
    fn default() -> Self {
        Self {
            weight: 1.0,
            polarity: LogicPolarity::Positive,
            relation: None,
            meta: BTreeMap::new(),
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct SplitOptions {
    pub min_group: Option<usize>,
}

#[derive(Clone, Debug)]
pub struct ActivateOptions {
    pub k: usize,
    pub depth: usize,
    pub filter: TemporalFilter,
}

impl Default for ActivateOptions {
    fn default() -> Self {
        Self {
            k: 3,
            depth: 1,
            filter: TemporalFilter::default(),
        }
    }
}

#[derive(Clone, Debug)]
pub struct CollapseTimeOptions {
    pub slice_id: String,
    pub merge_branches: bool,
    pub branch_merge_threshold: f64,
    pub exclude_invalid: bool,
}

impl Default for CollapseTimeOptions {
    fn default() -> Self {
        Self {
            slice_id: String::from("alpha_T"),
            merge_branches: true,
            branch_merge_threshold: 0.18,
            exclude_invalid: true,
        }
    }
}

#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum ObserveAction {
    Attached,
    Branched,
    Forced,
}

#[derive(Clone, Debug)]
pub struct SplitResult {
    pub node: GraphNode,
    pub branches: [GraphNode; 2],
    pub moved: Vec<GraphNode>,
}

#[derive(Clone, Debug)]
pub struct ObserveResult {
    pub node: GraphNode,
    pub parent: GraphNode,
    pub action: ObserveAction,
    pub split: Option<SplitResult>,
}

#[derive(Clone, Debug)]
pub struct ScoredNode {
    pub node: GraphNode,
    pub score: f64,
}

#[derive(Clone, Debug)]
pub struct ScoredEdgeNode {
    pub node: GraphNode,
    pub from: NodeId,
    pub to: NodeId,
    pub weight: f64,
    pub polarity: LogicPolarity,
    pub relation: Option<String>,
    pub score: f64,
}

#[derive(Clone, Debug)]
pub struct ActivatedRegion {
    pub anchor: GraphNode,
    pub score: f64,
    pub path: Vec<GraphNode>,
    pub parents: Vec<GraphNode>,
    pub nodes: Vec<GraphNode>,
    pub labels: Vec<String>,
    pub supporting: Vec<ScoredEdgeNode>,
    pub conflicting: Vec<ScoredEdgeNode>,
    pub slices: Vec<String>,
}

#[derive(Clone, Debug)]
pub struct TimeSliceSummary {
    pub slice_id: String,
    pub start_at: u64,
    pub end_at: u64,
    pub nodes: usize,
    pub leaves: usize,
    pub branches: usize,
    pub node_ids: Vec<NodeId>,
    pub centroid: Option<Vec<f64>>,
    pub radius: f64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GraphStats {
    pub name: Option<String>,
    pub nodes: usize,
    pub leaves: usize,
    pub branches: usize,
    pub links: usize,
    pub positive_links: usize,
    pub negative_links: usize,
    pub slices: usize,
    pub locks: usize,
    pub depth: usize,
    pub created_at: u64,
    pub updated_at: u64,
}

#[derive(Clone, Debug)]
pub enum QueryInput {
    Text(String),
    Vector(Vec<f64>),
}

impl From<&str> for QueryInput {
    fn from(value: &str) -> Self {
        Self::Text(String::from(value))
    }
}

impl From<String> for QueryInput {
    fn from(value: String) -> Self {
        Self::Text(value)
    }
}

impl From<Vec<f64>> for QueryInput {
    fn from(value: Vec<f64>) -> Self {
        Self::Vector(value)
    }
}

impl From<&[f64]> for QueryInput {
    fn from(value: &[f64]) -> Self {
        Self::Vector(value.to_vec())
    }
}

/// 跨语言确定性 UTF-16 FNV-1a 32-bit 哈希（与 `@plutokeating/ewave` `embed.ts` 完全同构）。
#[must_use]
pub fn fnv1a_utf16(text: &str) -> u32 {
    let mut hash: u32 = 0x811c_9dc5;
    for unit in text.encode_utf16() {
        hash ^= u32::from(unit);
        hash = hash.wrapping_mul(0x0100_0193);
    }
    hash
}

/// 确定性 UTF-16 码元字典序（防坑规范 #11 ④：彻底消除宿主区域相关 `localeCompare` 差异）。
#[must_use]
pub fn cmp_utf16(a: &str, b: &str) -> Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

/// NFKC 归一化 + 小写化 + 去首尾空白。
#[must_use]
pub fn normalize_nfkc_lower_trim(input: &str) -> String {
    let normalized: String = input.nfkc().collect();
    normalized.to_lowercase().trim().to_string()
}

const fn is_ewave_cjk(c: char) -> bool {
    matches!(
        c,
        '\u{3040}'..='\u{30ff}'
            | '\u{3400}'..='\u{4dbf}'
            | '\u{4e00}'..='\u{9fff}'
            | '\u{ac00}'..='\u{d7af}'
    )
}

const fn is_latin_alnum(c: char) -> bool {
    c.is_ascii_lowercase() || c.is_ascii_digit()
}

fn tokens_of(input: &str) -> Vec<(String, f64)> {
    let text = normalize_nfkc_lower_trim(input);
    if text.is_empty() {
        return Vec::new();
    }

    let chars: Vec<char> = text.chars().collect();
    let mut tokens: Vec<(String, f64)> = Vec::new();

    // 1. Latin words: /[a-z0-9]+(?:['\u2019-][a-z0-9]+)*/g
    let mut idx = 0;
    while idx < chars.len() {
        if is_latin_alnum(chars[idx]) {
            let start = idx;
            idx += 1;
            while idx < chars.len() && is_latin_alnum(chars[idx]) {
                idx += 1;
            }
            while idx + 1 < chars.len()
                && matches!(chars[idx], '\'' | '\u{2019}' | '-')
                && is_latin_alnum(chars[idx + 1])
            {
                idx += 2;
                while idx < chars.len() && is_latin_alnum(chars[idx]) {
                    idx += 1;
                }
            }
            let word: String = chars[start..idx].iter().collect();
            tokens.push((format!("w:{word}"), 1.0));
        } else {
            idx += 1;
        }
    }

    // 2. CJK runs: /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]+/g
    let mut cjk_idx = 0;
    while cjk_idx < chars.len() {
        if is_ewave_cjk(chars[cjk_idx]) {
            let start = cjk_idx;
            cjk_idx += 1;
            while cjk_idx < chars.len() && is_ewave_cjk(chars[cjk_idx]) {
                cjk_idx += 1;
            }
            let run = &chars[start..cjk_idx];
            for &ch in run {
                tokens.push((format!("c:{ch}"), 1.2));
            }
            for pair in run.windows(2) {
                tokens.push((format!("b:{}{}", pair[0], pair[1]), 1.8));
            }
        } else {
            cjk_idx += 1;
        }
    }

    // 3. Fallback `s:<text>`
    if tokens.is_empty() {
        tokens.push((format!("s:{text}"), 1.0));
    }

    tokens
}

/// 校验并单位化实数向量（拒绝空向量、NaN/Inf 与全零向量）。
pub fn normalize_vector(input: &[f64]) -> Result<Vec<f64>> {
    if input.is_empty() {
        return Err(QuetzalcoatlError::SerializationError {
            detail: String::from("EWAVE_VECTOR: embedding 不能为空向量"),
        });
    }
    let mut sum = 0.0_f64;
    for (i, &v) in input.iter().enumerate() {
        if !v.is_finite() {
            return Err(QuetzalcoatlError::SerializationError {
                detail: format!("EWAVE_VECTOR: embedding[{i}] 不是有限实数"),
            });
        }
        sum += v * v;
    }
    let norm = sum.sqrt();
    if norm == 0.0 {
        return Err(QuetzalcoatlError::SerializationError {
            detail: String::from("EWAVE_VECTOR: embedding 不能为全零向量"),
        });
    }
    if (norm - 1.0).abs() <= 1e-12 {
        return Ok(input
            .iter()
            .map(|&v| if v == 0.0 { 0.0 } else { v })
            .collect());
    }
    Ok(input
        .iter()
        .map(|&v| {
            let scaled = v / norm;
            if scaled == 0.0 { 0.0 } else { scaled }
        })
        .collect())
}

/// 与 `@plutokeating/ewave@0.2.0` 完全一致的确定性词法哈希向量器。
pub fn hash_embed(text: &str, dimensions: usize) -> Result<Vec<f64>> {
    if dimensions < 8 {
        return Err(QuetzalcoatlError::SerializationError {
            detail: format!("hash_embed: dimensions 必须 >= 8，实际为 {dimensions}"),
        });
    }
    let mut vector = vec![0.0_f64; dimensions];
    for (token, weight) in tokens_of(text) {
        let hash = fnv1a_utf16(&token);
        let index = (hash as usize) % dimensions;
        let sign = if ((hash >> 17) & 1) != 0 { 1.0 } else { -1.0 };
        vector[index] += sign * weight;
    }
    normalize_vector(&vector)
}

/// 默认 64 维词法哈希向量器。
pub fn hash_embed_64(text: &str) -> Result<Vec<f64>> {
    hash_embed(text, DEFAULT_EMB_DIM)
}

/// 余弦距离 `[0, 2]`。
pub fn cosine_distance(a: &[f64], b: &[f64]) -> Result<f64> {
    if a.len() != b.len() {
        return Err(QuetzalcoatlError::SerializationError {
            detail: format!(
                "EWAVE_DIMENSION: 向量维度不匹配 ({} vs {})",
                a.len(),
                b.len()
            ),
        });
    }
    let mut dot = 0.0_f64;
    let mut na = 0.0_f64;
    let mut nb = 0.0_f64;
    for (&x, &y) in a.iter().zip(b.iter()) {
        dot += x * y;
        na += x * x;
        nb += y * y;
    }
    if na == 0.0 || nb == 0.0 {
        return Ok(1.0);
    }
    let sim = (dot / (na * nb).sqrt()).clamp(-1.0, 1.0);
    Ok(1.0 - sim)
}

/// 余弦相似度 `[-1, 1]`。
pub fn cosine_similarity(a: &[f64], b: &[f64]) -> Result<f64> {
    Ok(1.0 - cosine_distance(a, b)?)
}

pub(crate) fn weighted_mean(items: &[(&[f64], f64)]) -> Result<Vec<f64>> {
    let Some((first_vec, _)) = items.first() else {
        return Err(QuetzalcoatlError::SerializationError {
            detail: String::from("EWAVE_VECTOR: 无法对空集合求加权均值"),
        });
    };
    let dim = first_vec.len();
    let mut sum = vec![0.0_f64; dim];
    let mut total = 0.0_f64;
    for &(vec, weight) in items {
        if vec.len() != dim {
            return Err(QuetzalcoatlError::SerializationError {
                detail: format!(
                    "EWAVE_DIMENSION: 加权均值维度不匹配 ({} vs {dim})",
                    vec.len()
                ),
            });
        }
        total += weight;
        for (slot, &v) in sum.iter_mut().zip(vec.iter()) {
            *slot += v * weight;
        }
    }
    if total == 0.0 {
        return Err(QuetzalcoatlError::SerializationError {
            detail: String::from("EWAVE_VECTOR: 总权重不能为 0"),
        });
    }
    for slot in &mut sum {
        *slot /= total;
    }
    normalize_vector(&sum)
}

pub(crate) fn rms_radius(items: &[(&[f64], f64, f64)], centroid: &[f64]) -> f64 {
    if items.is_empty() {
        return 0.0;
    }
    let mut total = 0.0_f64;
    let mut variance = 0.0_f64;
    for &(vec, weight, child_radius) in items {
        total += weight;
        let mut squared = child_radius * child_radius;
        for (&v, &c) in vec.iter().zip(centroid.iter()) {
            let delta = v - c;
            squared += delta * delta;
        }
        variance += squared * weight;
    }
    if total == 0.0 {
        0.0
    } else {
        (variance / total).sqrt()
    }
}

/// 词元与双字符 gram Jaccard 相似度 `[0, 1]`（对齐 `vector.ts::lexicalJaccard`）。
#[must_use]
pub fn lexical_jaccard(a: Option<&str>, b: Option<&str>) -> f64 {
    let clean_a = normalize_nfkc_lower_trim(a.unwrap_or(""));
    let clean_b = normalize_nfkc_lower_trim(b.unwrap_or(""));
    if clean_a.is_empty() || clean_b.is_empty() {
        return 0.0;
    }
    if clean_a == clean_b {
        return 1.0;
    }

    let build_grams = |text: &str| -> BTreeSet<String> {
        let mut out = BTreeSet::new();
        for tok in text.split_whitespace() {
            if !tok.is_empty() {
                out.insert(format!("t:{tok}"));
            }
        }
        let stripped_units: Vec<u16> = text
            .chars()
            .filter(|c| !c.is_whitespace())
            .flat_map(|c| {
                let mut buf = [0_u16; 2];
                c.encode_utf16(&mut buf).to_vec()
            })
            .collect();
        if stripped_units.len() == 1 {
            out.insert(format!("c:{}", String::from_utf16_lossy(&stripped_units)));
        } else {
            for win in stripped_units.windows(2) {
                out.insert(format!("g:{}", String::from_utf16_lossy(win)));
            }
        }
        out
    };

    let set_a = build_grams(&clean_a);
    let set_b = build_grams(&clean_b);
    if set_a.is_empty() || set_b.is_empty() {
        return 0.0;
    }
    let inter = set_a.intersection(&set_b).count();
    let union = set_a.len() + set_b.len() - inter;
    if union == 0 {
        0.0
    } else {
        #[allow(clippy::cast_precision_loss)]
        {
            (inter as f64) / (union as f64)
        }
    }
}

/// 从单位向量构建 BIRCH 聚类特征（CF）。
pub fn cf_from_vector(vector: &[f64], weight: f64) -> Result<ClusteringFeature> {
    let unit = normalize_vector(vector)?;
    let w = weight.max(0.0);
    let ls: Vec<f64> = unit.iter().map(|&v| v * w).collect();
    let norm_sq: f64 = unit.iter().map(|&v| v * v).sum();
    Ok(ClusteringFeature {
        n: w,
        ls,
        ss: w * norm_sq,
    })
}

/// 合并多个加权子树聚类特征（CF）。
pub fn cf_combine(features: &[(&ClusteringFeature, f64)]) -> Result<Option<ClusteringFeature>> {
    let Some((first_cf, _)) = features.first() else {
        return Ok(None);
    };
    let dim = first_cf.ls.len();
    let mut ls = vec![0.0_f64; dim];
    let mut n = 0.0_f64;
    let mut ss = 0.0_f64;
    for &(cf, weight) in features {
        if cf.ls.len() != dim {
            return Err(QuetzalcoatlError::SerializationError {
                detail: format!(
                    "EWAVE_DIMENSION: CF 合并维度不匹配 ({} vs {dim})",
                    cf.ls.len()
                ),
            });
        }
        if weight <= 0.0 || cf.n <= 0.0 {
            continue;
        }
        n += cf.n * weight;
        ss += cf.ss * weight;
        for (slot, &v) in ls.iter_mut().zip(cf.ls.iter()) {
            *slot += v * weight;
        }
    }
    if n <= 0.0 {
        Ok(None)
    } else {
        Ok(Some(ClusteringFeature { n, ls, ss }))
    }
}

/// 从 CF 导出单位质心向量。
#[must_use]
pub fn cf_centroid(cf: &ClusteringFeature) -> Option<Vec<f64>> {
    if cf.n <= 0.0 || cf.ls.is_empty() {
        return None;
    }
    let norm_sq: f64 = cf.ls.iter().map(|&v| v * v).sum();
    if norm_sq == 0.0 {
        return None;
    }
    let inv = 1.0 / norm_sq.sqrt();
    Some(
        cf.ls
            .iter()
            .map(|&v| {
                let s = v * inv;
                if s == 0.0 { 0.0 } else { s }
            })
            .collect(),
    )
}

fn format_base36_padded4(mut val: u64) -> String {
    const DIGITS: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if val == 0 {
        return String::from("0000");
    }
    let mut chars = Vec::new();
    while val > 0 {
        let rem = (val % 36) as usize;
        chars.push(char::from(DIGITS[rem]));
        val /= 36;
    }
    chars.reverse();
    let raw: String = chars.into_iter().collect();
    if raw.len() >= 4 {
        raw
    } else {
        format!("{raw:0>4}")
    }
}

fn parse_generated_seq(id: &str) -> Option<u64> {
    let suffix = id.strip_prefix("b_").or_else(|| id.strip_prefix("n_"))?;
    if suffix.is_empty()
        || !suffix
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
    {
        return None;
    }
    u64::from_str_radix(suffix, 36).ok()
}

#[derive(Clone, Debug)]
struct NearestCandidate {
    id: NodeId,
    kind: NodeKind,
    primary_parent: Option<NodeId>,
    distance: f64,
}

#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub(crate) enum WriteOp {
    Observe,
    Add,
    Branch,
    Promote,
    Attach,
    Detach,
    Link,
    Unlink,
    Split,
    Invalidate,
}

#[derive(Clone, Debug)]
pub struct SerpentineGraph {
    pub(crate) options: GraphOptions,
    pub(crate) nodes: BTreeMap<NodeId, GraphNode>,
    pub(crate) edges: BTreeMap<String, GraphEdge>,
    pub(crate) locks: BTreeMap<NodeId, NodeLock>,
    pub(crate) root_id: NodeId,
    pub(crate) dimension: Option<usize>,
    pub(crate) sequence: u64,
    pub(crate) clock_ms: u64,
    pub(crate) created_at: u64,
    pub(crate) updated_at: u64,
    pub(crate) embedder_online: bool,
    pub(crate) pending_reembed: Vec<NodeId>,
    pub(crate) sayit_records: BTreeMap<(String, String, String), SayItSessionRecord>,
}

impl Default for SerpentineGraph {
    fn default() -> Self {
        let mut opts = GraphOptions::default();
        opts.min_children = opts.min_children.max(2);
        let now = opts.initial_now_ms;
        let root_node = GraphNode {
            id: String::from("root"),
            kind: NodeKind::Root,
            data: serde_json::Value::Null,
            text: None,
            label: None,
            embedding: None,
            centroid: None,
            count: 0,
            member_count: 0.0,
            ls: None,
            ss: 0.0,
            radius: 0.0,
            cusum: 0.0,
            parents: Vec::new(),
            primary_parent: None,
            children: Vec::new(),
            links: Vec::new(),
            out_links: Vec::new(),
            in_links: Vec::new(),
            time: TemporalTag {
                at: now,
                end_at: None,
                slice_id: opts.default_slice_id.clone(),
                valid_from: now,
                invalid_at: None,
            },
            created_at: now,
            updated_at: now,
            meta: BTreeMap::new(),
            drift_count: 0,
            drift_mean: 0.0,
            ph_sum: 0.0,
            ph_min: 0.0,
        };
        let mut nodes = BTreeMap::new();
        nodes.insert(String::from("root"), root_node);
        Self {
            options: opts,
            nodes,
            edges: BTreeMap::new(),
            locks: BTreeMap::new(),
            root_id: String::from("root"),
            dimension: None,
            sequence: 0,
            clock_ms: now,
            created_at: now,
            updated_at: now,
            embedder_online: true,
            pending_reembed: Vec::new(),
            sayit_records: BTreeMap::new(),
        }
    }
}

impl SerpentineGraph {
    pub fn new(mut options: GraphOptions) -> Result<Self> {
        if !(0.0..=2.0).contains(&options.threshold) {
            return Err(QuetzalcoatlError::SerializationError {
                detail: String::from("EWAVE_OPTIONS: threshold 必须在 [0, 2] 范围内"),
            });
        }
        if options.split_threshold <= 0.0 {
            return Err(QuetzalcoatlError::SerializationError {
                detail: String::from("EWAVE_OPTIONS: split_threshold 必须 > 0"),
            });
        }
        if options.emb_dim < 2 {
            return Err(QuetzalcoatlError::SerializationError {
                detail: String::from("EWAVE_OPTIONS: emb_dim 必须 >= 2"),
            });
        }
        options.min_children = options.min_children.max(2);

        let now = options.initial_now_ms;
        let root_node = GraphNode {
            id: String::from("root"),
            kind: NodeKind::Root,
            data: serde_json::Value::Null,
            text: None,
            label: None,
            embedding: None,
            centroid: None,
            count: 0,
            member_count: 0.0,
            ls: None,
            ss: 0.0,
            radius: 0.0,
            cusum: 0.0,
            parents: Vec::new(),
            primary_parent: None,
            children: Vec::new(),
            links: Vec::new(),
            out_links: Vec::new(),
            in_links: Vec::new(),
            time: TemporalTag {
                at: now,
                end_at: None,
                slice_id: options.default_slice_id.clone(),
                valid_from: now,
                invalid_at: None,
            },
            created_at: now,
            updated_at: now,
            meta: BTreeMap::new(),
            drift_count: 0,
            drift_mean: 0.0,
            ph_sum: 0.0,
            ph_min: 0.0,
        };
        let mut nodes = BTreeMap::new();
        nodes.insert(String::from("root"), root_node);
        Ok(Self {
            options,
            nodes,
            edges: BTreeMap::new(),
            locks: BTreeMap::new(),
            root_id: String::from("root"),
            dimension: None,
            sequence: 0,
            clock_ms: now,
            created_at: now,
            updated_at: now,
            embedder_online: true,
            pending_reembed: Vec::new(),
            sayit_records: BTreeMap::new(),
        })
    }

    pub(crate) fn tick_now(&mut self) -> u64 {
        self.clock_ms = self.clock_ms.saturating_add(1);
        self.updated_at = self.clock_ms;
        self.clock_ms
    }

    pub(crate) fn next_node_id(&mut self, kind: NodeKind) -> NodeId {
        if kind == NodeKind::Root {
            return String::from("root");
        }
        let prefix = if kind == NodeKind::Branch { "b" } else { "n" };
        loop {
            self.sequence = self.sequence.saturating_add(1);
            let candidate = format!("{prefix}_{}", format_base36_padded4(self.sequence));
            if !self.nodes.contains_key(&candidate) {
                return candidate;
            }
        }
    }

    #[must_use]
    pub fn get(&self, id: &str) -> Option<&GraphNode> {
        self.nodes.get(id)
    }

    #[must_use]
    pub fn has(&self, id: &str) -> bool {
        self.nodes.contains_key(id)
    }

    #[must_use]
    pub fn size(&self) -> usize {
        self.nodes.len()
    }

    #[must_use]
    pub const fn dimension(&self) -> Option<usize> {
        self.dimension
    }

    #[must_use]
    pub fn emb_model_id(&self) -> &str {
        &self.options.emb_model_id
    }

    #[must_use]
    pub const fn emb_dim(&self) -> usize {
        self.options.emb_dim
    }

    #[must_use]
    pub const fn is_embedder_online(&self) -> bool {
        self.embedder_online
    }

    pub fn set_embedder_online(&mut self, online: bool) {
        self.embedder_online = online;
    }

    #[must_use]
    pub fn pending_reembed_ids(&self) -> &[NodeId] {
        &self.pending_reembed
    }

    /// 当规范嵌入器恢复在线后，批量对离线合并入队的异源节点补算向量并重建全图 CF。
    pub fn reembed_pending(&mut self) -> Result<usize> {
        if !self.embedder_online {
            return Err(QuetzalcoatlError::PartitionRestricted {
                detail: String::from("规范嵌入器仍处于离线状态，无法执行 reembed_pending"),
            });
        }
        let target_dim = self.dimension.unwrap_or(self.options.emb_dim).max(8);
        let queued = std::mem::take(&mut self.pending_reembed);
        let mut count = 0usize;
        for id in queued {
            let text_opt = self.nodes.get(&id).and_then(|n| {
                n.text
                    .clone()
                    .or_else(|| n.label.clone())
                    .filter(|s| !s.trim().is_empty())
            });
            if let Some(seed_text) = text_opt {
                let vec = hash_embed(&seed_text, target_dim)?;
                let validated = self.validate_and_lock_embedding(&vec)?;
                if let Some(node) = self.nodes.get_mut(&id) {
                    node.embedding = Some(validated);
                    node.meta.remove("reembed_pending");
                    count += 1;
                }
            }
        }
        if count > 0 {
            self.rebuild()?;
        }
        Ok(count)
    }

    pub fn root(&self) -> Result<&GraphNode> {
        self.nodes
            .get(&self.root_id)
            .ok_or_else(|| QuetzalcoatlError::IntegrityViolation {
                detail: String::from("根节点缺失"),
            })
    }

    #[must_use]
    pub fn all(&self, filter: Option<&TemporalFilter>) -> Vec<&GraphNode> {
        let mut list: Vec<&GraphNode> = self
            .nodes
            .values()
            .filter(|n| match filter {
                Some(f) => self.matches_filter(n, Some(f)),
                None => true,
            })
            .collect();
        list.sort_by(|a, b| cmp_utf16(&a.id, &b.id));
        list
    }

    #[must_use]
    pub fn leaves(&self, filter: Option<&TemporalFilter>) -> Vec<&GraphNode> {
        self.all(filter)
            .into_iter()
            .filter(|n| n.kind == NodeKind::Leaf)
            .collect()
    }

    #[must_use]
    pub fn branches(&self, filter: Option<&TemporalFilter>) -> Vec<&GraphNode> {
        self.all(filter)
            .into_iter()
            .filter(|n| n.kind != NodeKind::Leaf)
            .collect()
    }

    #[must_use]
    pub fn project_roots(&self, filter: Option<&TemporalFilter>) -> Vec<&GraphNode> {
        let Some(root) = self.nodes.get(&self.root_id) else {
            return Vec::new();
        };
        root.children
            .iter()
            .filter_map(|id| self.nodes.get(id))
            .filter(|node| {
                node.kind == NodeKind::Branch
                    && match filter {
                        Some(f) => self.matches_filter(node, Some(f)),
                        None => true,
                    }
            })
            .collect()
    }

    #[must_use]
    pub fn tau(&self, node: &GraphNode) -> f64 {
        if !self.options.adaptive_threshold || node.radius <= 0.0 {
            return self.options.threshold;
        }
        (self.options.tau_alpha * node.radius).clamp(self.options.tau_min, self.options.tau_max)
    }

    #[must_use]
    pub fn edge(&self, from_id: &str, to_id: &str, kind: EdgeKind) -> Option<&GraphEdge> {
        let key = match kind {
            EdgeKind::Link => format!("link:{from_id}>{to_id}"),
            EdgeKind::Hierarchy => format!("hierarchy:{from_id}>{to_id}"),
        };
        self.edges.get(&key)
    }

    #[must_use]
    pub fn edges_for(
        &self,
        node_id: Option<&str>,
        kind: Option<EdgeKind>,
        polarity: Option<LogicPolarity>,
    ) -> Vec<&GraphEdge> {
        let mut out: Vec<&GraphEdge> = self
            .edges
            .values()
            .filter(|e| {
                if let Some(k) = kind
                    && e.kind != k
                {
                    return false;
                }
                if let Some(p) = polarity
                    && e.polarity != p
                {
                    return false;
                }
                if let Some(nid) = node_id
                    && e.from != nid
                    && e.to != nid
                {
                    return false;
                }
                true
            })
            .collect();
        out.sort_by(|a, b| cmp_utf16(&a.key(), &b.key()));
        out
    }

    pub(crate) fn validate_weight(weight: f64) -> Result<f64> {
        if !weight.is_finite() || weight <= 0.0 {
            return Err(QuetzalcoatlError::SerializationError {
                detail: format!("EWAVE_WEIGHT: 边权重必须为有限正数，实际为 {weight}"),
            });
        }
        Ok(weight)
    }

    pub(crate) fn validate_and_lock_embedding(&mut self, input: &[f64]) -> Result<Vec<f64>> {
        let vec = normalize_vector(input)?;
        match self.dimension {
            None => {
                self.dimension = Some(vec.len());
            }
            Some(expected) if expected != vec.len() => {
                return Err(QuetzalcoatlError::SerializationError {
                    detail: format!(
                        "EWAVE_DIMENSION: 期望维度 {expected}，实际收到 {}",
                        vec.len()
                    ),
                });
            }
            Some(_) => {}
        }
        Ok(vec)
    }

    pub(crate) fn resolve_embedding(
        &mut self,
        explicit: Option<&[f64]>,
        text: &str,
    ) -> Result<Option<Vec<f64>>> {
        if let Some(raw) = explicit {
            return self.validate_and_lock_embedding(raw).map(Some);
        }
        if text.trim().is_empty() {
            return Ok(None);
        }
        let dim = self.dimension.unwrap_or(self.options.emb_dim).max(8);
        let embedded = hash_embed(text, dim)?;
        self.validate_and_lock_embedding(&embedded).map(Some)
    }

    pub(crate) fn resolve_query_vector(&self, query: QueryInput) -> Result<Vec<f64>> {
        let vec = match query {
            QueryInput::Text(s) => {
                if s.trim().is_empty() {
                    return Err(QuetzalcoatlError::SerializationError {
                        detail: String::from("EWAVE_INPUT: query 不能为空字符串"),
                    });
                }
                let dim = self.dimension.unwrap_or(self.options.emb_dim).max(8);
                hash_embed(&s, dim)?
            }
            QueryInput::Vector(v) => normalize_vector(&v)?,
        };
        if let Some(expected) = self.dimension
            && expected != vec.len()
        {
            return Err(QuetzalcoatlError::SerializationError {
                detail: format!(
                    "EWAVE_DIMENSION: 查询维度 {} != 图维度 {expected}",
                    vec.len()
                ),
            });
        }
        Ok(vec)
    }

    pub(crate) fn resolve_slice_id(&self, at: u64, explicit: Option<&str>) -> String {
        if let Some(s) = explicit {
            let trimmed = s.trim();
            if !trimmed.is_empty() {
                return String::from(trimmed);
            }
        }
        if let Some(win) = self.options.slice_window_ms
            && win > 0
        {
            return format!("t_{}", at / win);
        }
        self.options.default_slice_id.clone()
    }

    pub(crate) fn resolve_time(
        &mut self,
        at: Option<u64>,
        end_at: Option<u64>,
        slice_id: Option<&str>,
        time: Option<&TemporalInput>,
    ) -> TemporalTag {
        let now = self.tick_now();
        let resolved_at = time.and_then(|t| t.at).or(at).unwrap_or(now);
        let resolved_end = time.and_then(|t| t.end_at).or(end_at);
        let explicit_slice = time.and_then(|t| t.slice_id.as_deref()).or(slice_id);
        let resolved_slice = self.resolve_slice_id(resolved_at, explicit_slice);
        let valid_from = time.and_then(|t| t.valid_from).unwrap_or(resolved_at);
        let invalid_at = time.and_then(|t| t.invalid_at);
        TemporalTag {
            at: resolved_at,
            end_at: resolved_end,
            slice_id: resolved_slice,
            valid_from,
            invalid_at,
        }
    }

    pub(crate) fn active_lock_for(&self, id: &str) -> Option<&NodeLock> {
        let mut stack = vec![String::from(id)];
        let mut seen = BTreeSet::new();
        let mut freeze_hit: Option<&NodeLock> = None;
        while let Some(curr) = stack.pop() {
            if !seen.insert(curr.clone()) {
                continue;
            }
            if let Some(lock) = self.locks.get(&curr) {
                if lock.mode == LockMode::ReadOnly {
                    return Some(lock);
                }
                if freeze_hit.is_none() {
                    freeze_hit = Some(lock);
                }
            }
            if let Some(node) = self.nodes.get(&curr) {
                for p in &node.parents {
                    stack.push(p.clone());
                }
            }
        }
        freeze_hit
    }

    pub(crate) fn check_write_lock(&self, id: &str, op: WriteOp) -> Result<()> {
        let Some(lock) = self.active_lock_for(id) else {
            return Ok(());
        };
        match lock.mode {
            LockMode::ReadOnly => Err(QuetzalcoatlError::PermissionDenied {
                detail: format!(
                    "节点 {id} 受 read_only 机械锁保护 (scope={})",
                    lock.scope_root
                ),
            }),
            LockMode::StructureFrozen => {
                let allowed = matches!(
                    op,
                    WriteOp::Observe | WriteOp::Add | WriteOp::Link | WriteOp::Unlink
                );
                if allowed {
                    Ok(())
                } else {
                    Err(QuetzalcoatlError::PermissionDenied {
                        detail: format!(
                            "节点 {id} 受 structure_frozen 锁保护 (scope={})，禁止执行 {op:?}",
                            lock.scope_root
                        ),
                    })
                }
            }
        }
    }

    pub(crate) fn matches_filter(&self, node: &GraphNode, filter: Option<&TemporalFilter>) -> bool {
        let Some(f) = filter else {
            return node.is_valid();
        };
        if !f.include_invalid && !node.is_valid() {
            return false;
        }
        if let Some(from) = f.from
            && node.time.at < from
        {
            return false;
        }
        if let Some(to) = f.to
            && node.time.at > to
        {
            return false;
        }
        if f.mode != TemporalMode::Collapsed
            && let Some(allowed) = &f.slice_ids
            && !allowed.iter().any(|s| s == node.slice_id())
        {
            if node.kind == NodeKind::Branch {
                let has_desc = self.descendants(&node.id).into_iter().any(|desc| {
                    (f.include_invalid || desc.is_valid())
                        && allowed.iter().any(|s| s == desc.slice_id())
                });
                if !has_desc {
                    return false;
                }
            } else {
                return false;
            }
        }
        true
    }

    pub(crate) fn reaches(&self, start_id: &str, target_id: &str) -> bool {
        let mut stack = vec![String::from(start_id)];
        let mut seen = BTreeSet::new();
        while let Some(curr) = stack.pop() {
            if curr == target_id {
                return true;
            }
            if !seen.insert(curr.clone()) {
                continue;
            }
            if let Some(node) = self.nodes.get(&curr) {
                for p in &node.parents {
                    stack.push(p.clone());
                }
            }
        }
        false
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn make_node(
        &mut self,
        explicit_id: Option<NodeId>,
        kind: NodeKind,
        data: serde_json::Value,
        text: Option<String>,
        label: Option<String>,
        embedding: Option<Vec<f64>>,
        time: TemporalTag,
        meta: BTreeMap<String, serde_json::Value>,
    ) -> Result<GraphNode> {
        let id = match explicit_id {
            Some(eid) => {
                if self.nodes.contains_key(&eid) {
                    return Err(QuetzalcoatlError::SerializationError {
                        detail: format!("EWAVE_DUPLICATE: 重复节点 ID {eid}"),
                    });
                }
                eid
            }
            None => self.next_node_id(kind),
        };
        let now = self.tick_now();
        let centroid = if kind != NodeKind::Root {
            embedding.clone()
        } else {
            None
        };
        let ls = if kind != NodeKind::Root {
            embedding.clone()
        } else {
            None
        };
        let ss = if kind != NodeKind::Root && embedding.is_some() {
            1.0
        } else {
            0.0
        };
        let count = usize::from(kind == NodeKind::Leaf && time.invalid_at.is_none());
        let member_count = if kind == NodeKind::Leaf && time.invalid_at.is_none() {
            1.0
        } else {
            0.0
        };

        Ok(GraphNode {
            id,
            kind,
            data,
            text,
            label,
            embedding,
            centroid,
            count,
            member_count,
            ls,
            ss,
            radius: 0.0,
            cusum: 0.0,
            parents: Vec::new(),
            primary_parent: None,
            children: Vec::new(),
            links: Vec::new(),
            out_links: Vec::new(),
            in_links: Vec::new(),
            time,
            created_at: now,
            updated_at: now,
            meta,
            drift_count: 0,
            drift_mean: 0.0,
            ph_sum: 0.0,
            ph_min: 0.0,
        })
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn attach_internal(
        &mut self,
        child_id: &str,
        parent_id: &str,
        primary: bool,
        silent: bool,
        weight: f64,
        relation: Option<String>,
        meta: BTreeMap<String, serde_json::Value>,
    ) -> Result<()> {
        if child_id == parent_id {
            return Err(QuetzalcoatlError::SerializationError {
                detail: String::from("EWAVE_ATTACH: 禁止将节点挂载为自身的父节点"),
            });
        }
        let parent_kind = self
            .nodes
            .get(parent_id)
            .ok_or_else(|| {
                QuetzalcoatlError::invalid_id("NodeId", format!("未知父节点 {parent_id}"))
            })?
            .kind;
        if parent_kind == NodeKind::Leaf {
            return Err(QuetzalcoatlError::SerializationError {
                detail: format!("EWAVE_PARENT: 叶节点 {parent_id} 不能作为父节点"),
            });
        }
        let child_kind = self
            .nodes
            .get(child_id)
            .ok_or_else(|| {
                QuetzalcoatlError::invalid_id("NodeId", format!("未知子节点 {child_id}"))
            })?
            .kind;
        if child_kind == NodeKind::Root {
            return Err(QuetzalcoatlError::SerializationError {
                detail: String::from("EWAVE_ROOT: 根节点不能挂载父节点"),
            });
        }
        if self.reaches(parent_id, child_id) {
            return Err(QuetzalcoatlError::IntegrityViolation {
                detail: format!("EWAVE_CYCLE: 将 {child_id} 挂在 {parent_id} 下会形成环路"),
            });
        }

        let key = format!("hierarchy:{parent_id}>{child_id}");
        if let Some(existing) = self.edges.get_mut(&key) {
            existing.weight = weight;
            if relation.is_some() {
                existing.relation = relation;
            }
            for (k, v) in meta {
                existing.meta.insert(k, v);
            }
            if primary && let Some(c) = self.nodes.get_mut(child_id) {
                c.primary_parent = Some(String::from(parent_id));
            }
            if !silent {
                self.rebuild()?;
            }
            return Ok(());
        }

        let now = self.tick_now();
        if let Some(child) = self.nodes.get_mut(child_id) {
            let no_prev_primary = child.primary_parent.is_none();
            child.add_parent(parent_id);
            if primary || no_prev_primary {
                child.primary_parent = Some(String::from(parent_id));
            }
            child.updated_at = now;
        }
        if let Some(parent) = self.nodes.get_mut(parent_id) {
            parent.add_child(child_id);
            parent.updated_at = now;
        }
        self.edges.insert(
            key,
            GraphEdge {
                from: String::from(parent_id),
                to: String::from(child_id),
                kind: EdgeKind::Hierarchy,
                weight,
                polarity: LogicPolarity::Positive,
                relation,
                created_at: now,
                meta,
            },
        );

        if !silent {
            self.rebuild()?;
        }
        Ok(())
    }

    pub(crate) fn detach_internal(
        &mut self,
        child_id: &str,
        parent_id: &str,
        silent: bool,
        allow_last: bool,
    ) -> Result<bool> {
        let key = format!("hierarchy:{parent_id}>{child_id}");
        if !self.edges.contains_key(&key) {
            return Ok(false);
        }
        let (child_kind, parent_len, was_primary, child_centroid, remaining_parents) = {
            let child = self.nodes.get(child_id).ok_or_else(|| {
                QuetzalcoatlError::invalid_id("NodeId", format!("未知子节点 {child_id}"))
            })?;
            let rem: Vec<String> = child
                .parents
                .iter()
                .filter(|p| p.as_str() != parent_id)
                .cloned()
                .collect();
            (
                child.kind,
                child.parents.len(),
                child.primary_parent.as_deref() == Some(parent_id),
                child.centroid.clone(),
                rem,
            )
        };
        if !allow_last && child_kind != NodeKind::Root && parent_len <= 1 {
            return Err(QuetzalcoatlError::SerializationError {
                detail: String::from("EWAVE_PRIMARY: 不能移除最后一个父节点"),
            });
        }

        let now = self.tick_now();
        self.edges.remove(&key);
        if let Some(parent) = self.nodes.get_mut(parent_id) {
            parent.remove_child(child_id);
            parent.updated_at = now;
        }

        let new_primary = if was_primary {
            let mut candidates: Vec<(String, f64)> = remaining_parents
                .into_iter()
                .filter(|pid| self.nodes.contains_key(pid))
                .map(|pid| {
                    let dist = match (
                        &child_centroid,
                        self.nodes.get(&pid).and_then(|p| p.centroid.as_ref()),
                    ) {
                        (Some(cc), Some(pc)) if cc.len() == pc.len() => {
                            cosine_distance(cc, pc).unwrap_or(f64::INFINITY)
                        }
                        _ => f64::INFINITY,
                    };
                    (pid, dist)
                })
                .collect();
            candidates.sort_by(|(id_a, da), (id_b, db)| {
                cmp_f64_asc(*da, *db).then_with(|| cmp_utf16(id_a, id_b))
            });
            candidates.into_iter().next().map(|(pid, _)| pid)
        } else {
            None
        };

        if let Some(child) = self.nodes.get_mut(child_id) {
            child.remove_parent(parent_id);
            if was_primary {
                child.primary_parent = new_primary;
            }
            child.updated_at = now;
        }

        if !silent {
            self.rebuild()?;
        }
        Ok(true)
    }

    fn nearest(
        &self,
        vector: &[f64],
        filter: Option<&TemporalFilter>,
    ) -> Result<Option<NearestCandidate>> {
        let mut best: Option<NearestCandidate> = None;
        for node in self.nodes.values() {
            if node.kind == NodeKind::Root {
                continue;
            }
            let Some(centroid) = &node.centroid else {
                continue;
            };
            if !self.matches_filter(node, filter) {
                continue;
            }
            let dist = cosine_distance(vector, centroid)?;
            let replace = match &best {
                None => true,
                Some(prev) => {
                    dist < prev.distance
                        || (dist == prev.distance
                            && cmp_utf16(&node.id, &prev.id) == Ordering::Less)
                }
            };
            if replace {
                best = Some(NearestCandidate {
                    id: node.id.clone(),
                    kind: node.kind,
                    primary_parent: node.primary_parent.clone(),
                    distance: dist,
                });
            }
        }
        Ok(best)
    }

    fn step_ancestor_drift(&mut self, start_parent_id: &str, residual: f64) {
        let delta = self.options.drift_delta;
        let mut current_opt = Some(String::from(start_parent_id));
        let mut seen = BTreeSet::new();
        while let Some(curr_id) = current_opt {
            if !seen.insert(curr_id.clone()) {
                break;
            }
            let next_parent = if let Some(node) = self.nodes.get_mut(&curr_id) {
                if node.kind != NodeKind::Leaf {
                    node.step_drift(residual, delta);
                }
                node.primary_parent.clone()
            } else {
                None
            };
            current_opt = next_parent;
        }
    }

    fn maybe_split(&mut self, start_parent_id: &str) -> Result<Option<SplitResult>> {
        if !self.options.auto_split {
            return Ok(None);
        }
        let mut current_opt = Some(String::from(start_parent_id));
        let mut seen = BTreeSet::new();
        while let Some(curr_id) = current_opt {
            if !seen.insert(curr_id.clone()) {
                break;
            }
            let (should_try, next_parent) = if let Some(node) = self.nodes.get(&curr_id) {
                let primary_children = node
                    .children
                    .iter()
                    .filter(|cid| {
                        self.nodes
                            .get(*cid)
                            .is_some_and(|c| c.primary_parent.as_deref() == Some(curr_id.as_str()))
                    })
                    .count();
                let radius_trigger = node.radius > self.options.split_threshold;
                let drift_trigger = self.options.adaptive_threshold
                    && node.cusum > self.options.drift_lambda
                    && node.radius > self.options.tau_min;
                let trigger = self.lock_mode(&curr_id).is_none()
                    && node.kind != NodeKind::Leaf
                    && primary_children >= self.options.min_children
                    && (radius_trigger || drift_trigger);
                (trigger, node.primary_parent.clone())
            } else {
                (false, None)
            };

            if should_try && let Some(res) = self.split(&curr_id, SplitOptions::default())? {
                return Ok(Some(res));
            }
            current_opt = next_parent;
        }
        Ok(None)
    }

    /// 观测并增量路由入图：近则归并更新 CF，远则生长分支，持续偏移触发分裂。
    pub fn observe(
        &mut self,
        data: serde_json::Value,
        options: ObserveOptions,
    ) -> Result<ObserveResult> {
        let inferred_text = options
            .text
            .clone()
            .or_else(|| data.as_str().map(String::from))
            .unwrap_or_default();
        let embedding = self
            .resolve_embedding(options.embedding.as_deref(), &inferred_text)?
            .ok_or_else(|| QuetzalcoatlError::SerializationError {
                detail: String::from("EWAVE_INPUT: observe() 需要提供非空 text 或 embedding"),
            })?;
        let time = self.resolve_time(
            options.at,
            options.end_at,
            options.slice_id.as_deref(),
            options.time.as_ref(),
        );
        let weight = Self::validate_weight(options.weight.unwrap_or(1.0))?;

        let root_children_empty = self.root()?.children.is_empty();
        let (parent_id, action, residual) = if let Some(explicit_parent) = &options.parent {
            self.check_write_lock(explicit_parent, WriteOp::Observe)?;
            let parent_node = self.nodes.get(explicit_parent).ok_or_else(|| {
                QuetzalcoatlError::invalid_id("NodeId", format!("未知父节点 {explicit_parent}"))
            })?;
            if parent_node.kind == NodeKind::Leaf {
                return Err(QuetzalcoatlError::SerializationError {
                    detail: format!("EWAVE_PARENT: 叶节点 {explicit_parent} 不能作为父节点"),
                });
            }
            let res = match &parent_node.centroid {
                Some(c) => cosine_distance(&embedding, c)?,
                None => 0.0,
            };
            (explicit_parent.clone(), ObserveAction::Forced, res)
        } else if root_children_empty {
            let rid = self.root_id.clone();
            self.check_write_lock(&rid, WriteOp::Observe)?;
            (rid, ObserveAction::Attached, 0.0)
        } else {
            let route_in_slice = options.route_in_slice.unwrap_or(self.options.slice_routing);
            let slice_filter = if route_in_slice {
                Some(TemporalFilter {
                    slice_ids: Some(vec![time.slice_id.clone()]),
                    mode: TemporalMode::Sliced,
                    ..TemporalFilter::default()
                })
            } else {
                None
            };
            let nearest = self.nearest(&embedding, slice_filter.as_ref())?;
            let limit = match &nearest {
                Some(hit) => self
                    .nodes
                    .get(&hit.id)
                    .map_or(self.options.threshold, |n| self.tau(n)),
                None => self.options.threshold,
            };
            if let Some(hit) = &nearest
                && hit.distance <= limit
            {
                let target_pid = if hit.kind == NodeKind::Leaf {
                    hit.primary_parent
                        .clone()
                        .unwrap_or_else(|| self.root_id.clone())
                } else {
                    hit.id.clone()
                };
                self.check_write_lock(&target_pid, WriteOp::Observe)?;
                (target_pid, ObserveAction::Attached, hit.distance)
            } else {
                let res = nearest.as_ref().map_or(0.0, |hit| hit.distance);
                let rid = self.root_id.clone();
                self.check_write_lock(&rid, WriteOp::Observe)?;
                if options
                    .grow_branch
                    .unwrap_or(self.options.grow_branch_on_far)
                {
                    let branch = self.make_node(
                        None,
                        NodeKind::Branch,
                        serde_json::Value::Null,
                        None,
                        options.label.clone(),
                        Some(embedding.clone()),
                        time.clone(),
                        BTreeMap::new(),
                    )?;
                    let bid = branch.id.clone();
                    self.nodes.insert(bid.clone(), branch);
                    self.attach_internal(&bid, &rid, true, true, 1.0, None, BTreeMap::new())?;
                    (bid, ObserveAction::Branched, res)
                } else {
                    (rid, ObserveAction::Branched, res)
                }
            }
        };

        let leaf_text = if inferred_text.is_empty() {
            None
        } else {
            Some(inferred_text)
        };
        let leaf = self.make_node(
            options.id,
            NodeKind::Leaf,
            data,
            leaf_text,
            options.label,
            Some(embedding),
            time,
            options.meta,
        )?;
        let leaf_id = leaf.id.clone();
        self.nodes.insert(leaf_id.clone(), leaf);
        self.attach_internal(
            &leaf_id,
            &parent_id,
            true,
            true,
            weight,
            None,
            BTreeMap::new(),
        )?;
        self.rebuild()?;
        self.step_ancestor_drift(&parent_id, residual);
        let split = self.maybe_split(&parent_id)?;

        let final_node = self.nodes.get(&leaf_id).cloned().ok_or_else(|| {
            QuetzalcoatlError::IntegrityViolation {
                detail: String::from("observe 插入节点丢失"),
            }
        })?;
        let final_parent = self.nodes.get(&parent_id).cloned().ok_or_else(|| {
            QuetzalcoatlError::IntegrityViolation {
                detail: String::from("observe 父节点丢失"),
            }
        })?;

        Ok(ObserveResult {
            node: final_node,
            parent: final_parent,
            action,
            split,
        })
    }

    /// 在显式父节点（默认 `root`）下直接新增叶节点。
    pub fn add(&mut self, data: serde_json::Value, options: AddOptions) -> Result<GraphNode> {
        let parent_id = options
            .parent
            .clone()
            .unwrap_or_else(|| self.root_id.clone());
        self.check_write_lock(&parent_id, WriteOp::Add)?;
        let parent_kind = self
            .nodes
            .get(&parent_id)
            .ok_or_else(|| {
                QuetzalcoatlError::invalid_id("NodeId", format!("未知父节点 {parent_id}"))
            })?
            .kind;
        if parent_kind == NodeKind::Leaf {
            return Err(QuetzalcoatlError::SerializationError {
                detail: format!("EWAVE_PARENT: 叶节点 {parent_id} 不能作为父节点"),
            });
        }

        let inferred_text = options
            .text
            .clone()
            .or_else(|| data.as_str().map(String::from))
            .unwrap_or_default();
        let weight = Self::validate_weight(options.weight.unwrap_or(1.0))?;
        let embedding = self.resolve_embedding(options.embedding.as_deref(), &inferred_text)?;
        let time = self.resolve_time(
            options.at,
            options.end_at,
            options.slice_id.as_deref(),
            options.time.as_ref(),
        );
        let text_opt = if inferred_text.is_empty() {
            None
        } else {
            Some(inferred_text)
        };
        let node = self.make_node(
            options.id,
            NodeKind::Leaf,
            data,
            text_opt,
            options.label,
            embedding,
            time,
            options.meta,
        )?;
        let nid = node.id.clone();
        self.nodes.insert(nid.clone(), node);
        self.attach_internal(&nid, &parent_id, true, true, weight, None, BTreeMap::new())?;
        self.rebuild()?;
        self.nodes
            .get(&nid)
            .cloned()
            .ok_or_else(|| QuetzalcoatlError::IntegrityViolation {
                detail: String::from("add 插入节点丢失"),
            })
    }

    /// 显式创建分支节点（支持项目根、记录分支或篇章分支）。
    pub fn add_branch(&mut self, options: BranchOptions) -> Result<GraphNode> {
        let parent_id = options
            .parent
            .clone()
            .unwrap_or_else(|| self.root_id.clone());
        self.check_write_lock(&parent_id, WriteOp::Branch)?;
        let parent_kind = self
            .nodes
            .get(&parent_id)
            .ok_or_else(|| {
                QuetzalcoatlError::invalid_id("NodeId", format!("未知父节点 {parent_id}"))
            })?
            .kind;
        if parent_kind == NodeKind::Leaf {
            return Err(QuetzalcoatlError::SerializationError {
                detail: format!("EWAVE_PARENT: 叶节点 {parent_id} 不能作为父节点"),
            });
        }

        let seed_text = options
            .text
            .as_deref()
            .or(options.label.as_deref())
            .unwrap_or("");
        let embedding = self.resolve_embedding(options.embedding.as_deref(), seed_text)?;
        let weight = Self::validate_weight(options.weight.unwrap_or(1.0))?;
        let time = self.resolve_time(
            options.at,
            options.end_at,
            options.slice_id.as_deref(),
            options.time.as_ref(),
        );
        let node = self.make_node(
            options.id,
            NodeKind::Branch,
            options.data.unwrap_or(serde_json::Value::Null),
            options.text,
            options.label,
            embedding,
            time,
            options.meta,
        )?;
        let bid = node.id.clone();
        self.nodes.insert(bid.clone(), node);
        self.attach_internal(&bid, &parent_id, true, true, weight, None, BTreeMap::new())?;
        self.rebuild()?;
        self.nodes
            .get(&bid)
            .cloned()
            .ok_or_else(|| QuetzalcoatlError::IntegrityViolation {
                detail: String::from("add_branch 节点丢失"),
            })
    }

    /// 将叶节点原地升格为分支节点，保留全部多父归属、逻辑边与向量。
    pub fn promote(&mut self, id: &str) -> Result<GraphNode> {
        let kind = self
            .nodes
            .get(id)
            .ok_or_else(|| QuetzalcoatlError::invalid_id("NodeId", format!("未知节点 {id}")))?
            .kind;
        if kind == NodeKind::Leaf {
            self.check_write_lock(id, WriteOp::Promote)?;
            let now = self.tick_now();
            if let Some(node) = self.nodes.get_mut(id) {
                node.kind = NodeKind::Branch;
                node.updated_at = now;
            }
            self.rebuild()?;
        }
        self.nodes
            .get(id)
            .cloned()
            .ok_or_else(|| QuetzalcoatlError::invalid_id("NodeId", format!("未知节点 {id}")))
    }

    /// 为已有节点挂载次级或新的主干归属父节点（多父有向无环图）。
    pub fn attach(
        &mut self,
        child_id: &str,
        parent_id: &str,
        options: AttachOptions,
    ) -> Result<()> {
        self.check_write_lock(child_id, WriteOp::Attach)?;
        self.check_write_lock(parent_id, WriteOp::Attach)?;
        let weight = Self::validate_weight(options.weight.unwrap_or(1.0))?;
        self.attach_internal(
            child_id,
            parent_id,
            options.primary,
            false,
            weight,
            options.relation,
            options.meta,
        )
    }

    /// 移除非主干的多父归属边。
    pub fn detach(&mut self, child_id: &str, parent_id: &str) -> Result<()> {
        self.check_write_lock(child_id, WriteOp::Detach)?;
        self.check_write_lock(parent_id, WriteOp::Detach)?;
        let is_primary = self
            .nodes
            .get(child_id)
            .ok_or_else(|| {
                QuetzalcoatlError::invalid_id("NodeId", format!("未知子节点 {child_id}"))
            })?
            .primary_parent
            .as_deref()
            == Some(parent_id);
        if is_primary {
            return Err(QuetzalcoatlError::SerializationError {
                detail: String::from("EWAVE_PRIMARY: 不能直接 detach 主干父节点"),
            });
        }
        let _ = self.detach_internal(child_id, parent_id, false, false)?;
        Ok(())
    }

    /// 创建或更新有向有权正负逻辑边（`polarity: +1 | -1`）。
    pub fn link(&mut self, from_id: &str, to_id: &str, options: LinkOptions) -> Result<()> {
        if from_id == to_id {
            return Err(QuetzalcoatlError::SerializationError {
                detail: String::from("EWAVE_LINK: 禁止创建自环逻辑边"),
            });
        }
        if !self.nodes.contains_key(from_id) || !self.nodes.contains_key(to_id) {
            return Err(QuetzalcoatlError::invalid_id(
                "NodeId",
                format!("逻辑边引用未知节点 {from_id}->{to_id}"),
            ));
        }
        self.check_write_lock(from_id, WriteOp::Link)?;
        self.check_write_lock(to_id, WriteOp::Link)?;
        let weight = Self::validate_weight(options.weight)?;
        let now = self.tick_now();
        let key = format!("link:{from_id}>{to_id}");

        if let Some(existing) = self.edges.get_mut(&key) {
            existing.weight = weight;
            existing.polarity = options.polarity;
            existing.relation = options.relation;
            for (k, v) in options.meta {
                existing.meta.insert(k, v);
            }
        } else {
            self.edges.insert(
                key,
                GraphEdge {
                    from: String::from(from_id),
                    to: String::from(to_id),
                    kind: EdgeKind::Link,
                    weight,
                    polarity: options.polarity,
                    relation: options.relation,
                    created_at: now,
                    meta: options.meta,
                },
            );
            if let Some(from) = self.nodes.get_mut(from_id) {
                from.add_out_link(to_id);
            }
            if let Some(to) = self.nodes.get_mut(to_id) {
                to.add_in_link(from_id);
            }
        }

        if let Some(from) = self.nodes.get_mut(from_id) {
            from.updated_at = now;
        }
        if let Some(to) = self.nodes.get_mut(to_id) {
            to.updated_at = now;
        }
        Ok(())
    }

    /// 移除有向逻辑边。
    pub fn unlink(&mut self, from_id: &str, to_id: &str) -> Result<()> {
        self.check_write_lock(from_id, WriteOp::Unlink)?;
        self.check_write_lock(to_id, WriteOp::Unlink)?;
        let forward_key = format!("link:{from_id}>{to_id}");
        let reverse_key = format!("link:{to_id}>{from_id}");
        let now = self.tick_now();
        if self.edges.remove(&forward_key).is_some() {
            if let Some(from) = self.nodes.get_mut(from_id) {
                from.remove_out_link(to_id);
                from.updated_at = now;
            }
            if let Some(to) = self.nodes.get_mut(to_id) {
                to.remove_in_link(from_id);
                to.updated_at = now;
            }
        } else if self.edges.remove(&reverse_key).is_some() {
            if let Some(to) = self.nodes.get_mut(to_id) {
                to.remove_out_link(from_id);
                to.updated_at = now;
            }
            if let Some(from) = self.nodes.get_mut(from_id) {
                from.remove_in_link(to_id);
                from.updated_at = now;
            }
        }
        Ok(())
    }

    /// 基于最远点对（无随机数）对分支执行确定性二分分裂。
    pub fn split(&mut self, id: &str, options: SplitOptions) -> Result<Option<SplitResult>> {
        let (node_kind, node_slice, child_ids) = {
            let node = self
                .nodes
                .get(id)
                .ok_or_else(|| QuetzalcoatlError::invalid_id("NodeId", format!("未知节点 {id}")))?;
            if node.kind == NodeKind::Leaf {
                return Err(QuetzalcoatlError::SerializationError {
                    detail: format!("EWAVE_SPLIT: 不能分裂叶节点 {id}"),
                });
            }
            (node.kind, node.time.slice_id.clone(), node.children.clone())
        };
        let _ = node_kind;
        self.check_write_lock(id, WriteOp::Split)?;

        let min_group = options.min_group.unwrap_or(2).max(1);
        let eligible: Vec<(NodeId, Vec<f64>)> = child_ids
            .into_iter()
            .filter_map(|cid| {
                let c = self.nodes.get(&cid)?;
                if c.primary_parent.as_deref() == Some(id)
                    && (c.count > 0 || c.member_count > 0.0)
                    && let Some(cent) = &c.centroid
                {
                    Some((cid, cent.clone()))
                } else {
                    None
                }
            })
            .collect();

        if eligible.len() < (2 * min_group).max(self.options.min_children) {
            return Ok(None);
        }

        let mut left_idx = 0usize;
        let mut right_idx = 1usize;
        let mut farthest = -1.0_f64;
        for i in 0..eligible.len() {
            for j in (i + 1)..eligible.len() {
                let dist = cosine_distance(&eligible[i].1, &eligible[j].1)?;
                if dist > farthest {
                    farthest = dist;
                    left_idx = i;
                    right_idx = j;
                }
            }
        }

        let left_cent = &eligible[left_idx].1;
        let right_cent = &eligible[right_idx].1;
        let mut group_a: Vec<NodeId> = Vec::new();
        let mut group_b: Vec<NodeId> = Vec::new();

        for (cid, cent) in &eligible {
            let da = cosine_distance(cent, left_cent)?;
            let db = cosine_distance(cent, right_cent)?;
            if da < db {
                group_a.push(cid.clone());
            } else if db < da {
                group_b.push(cid.clone());
            } else if group_a.len() <= group_b.len() {
                group_a.push(cid.clone());
            } else {
                group_b.push(cid.clone());
            }
        }

        if group_a.len() < min_group || group_b.len() < min_group {
            return Ok(None);
        }

        let time_a = self.resolve_time(None, None, Some(&node_slice), None);
        let branch_a = self.make_node(
            None,
            NodeKind::Branch,
            serde_json::Value::Null,
            None,
            None,
            None,
            time_a,
            BTreeMap::new(),
        )?;
        let aid = branch_a.id.clone();
        self.nodes.insert(aid.clone(), branch_a);
        self.attach_internal(&aid, id, true, true, 1.0, None, BTreeMap::new())?;

        let time_b = self.resolve_time(None, None, Some(&node_slice), None);
        let branch_b = self.make_node(
            None,
            NodeKind::Branch,
            serde_json::Value::Null,
            None,
            None,
            None,
            time_b,
            BTreeMap::new(),
        )?;
        let bid = branch_b.id.clone();
        self.nodes.insert(bid.clone(), branch_b);
        self.attach_internal(&bid, id, true, true, 1.0, None, BTreeMap::new())?;

        for (group, target_bid) in [(&group_a, &aid), (&group_b, &bid)] {
            for cid in group {
                let prev_weight = self
                    .edges
                    .get(&format!("hierarchy:{id}>{cid}"))
                    .map_or(1.0, |e| e.weight);
                let _ = self.detach_internal(cid, id, true, true)?;
                self.attach_internal(
                    cid,
                    target_bid,
                    true,
                    true,
                    prev_weight,
                    None,
                    BTreeMap::new(),
                )?;
            }
        }

        if let Some(parent_node) = self.nodes.get_mut(id) {
            parent_node.reset_drift();
        }
        self.rebuild()?;

        let split_parent =
            self.nodes
                .get(id)
                .cloned()
                .ok_or_else(|| QuetzalcoatlError::IntegrityViolation {
                    detail: String::from("split 父节点丢失"),
                })?;
        let final_a =
            self.nodes
                .get(&aid)
                .cloned()
                .ok_or_else(|| QuetzalcoatlError::IntegrityViolation {
                    detail: String::from("split 左分支丢失"),
                })?;
        let final_b =
            self.nodes
                .get(&bid)
                .cloned()
                .ok_or_else(|| QuetzalcoatlError::IntegrityViolation {
                    detail: String::from("split 右分支丢失"),
                })?;
        let mut moved = Vec::with_capacity(group_a.len() + group_b.len());
        for cid in group_a.iter().chain(group_b.iter()) {
            if let Some(m) = self.nodes.get(cid) {
                moved.push(m.clone());
            }
        }

        Ok(Some(SplitResult {
            node: split_parent,
            branches: [final_a, final_b],
            moved,
        }))
    }

    /// 双时态墓碑失效：保留结构拓扑与历史轨迹，将其从默认检索、激活及 CF 聚合中剔除。
    pub fn invalidate(&mut self, id: &str, at_ms: u64) -> Result<GraphNode> {
        let kind = self
            .nodes
            .get(id)
            .ok_or_else(|| QuetzalcoatlError::invalid_id("NodeId", format!("未知节点 {id}")))?
            .kind;
        if kind == NodeKind::Root {
            return Err(QuetzalcoatlError::SerializationError {
                detail: String::from("EWAVE_ROOT: 禁止使根节点失效"),
            });
        }
        self.check_write_lock(id, WriteOp::Invalidate)?;
        if let Some(node) = self.nodes.get_mut(id) {
            node.time.invalid_at = Some(at_ms);
            node.updated_at = at_ms;
        }
        self.updated_at = self.updated_at.max(at_ms);
        self.rebuild()?;
        self.nodes
            .get(id)
            .cloned()
            .ok_or_else(|| QuetzalcoatlError::invalid_id("NodeId", format!("未知节点 {id}")))
    }

    /// 设置子树机械锁（`read_only` 或 `structure_frozen`）。
    pub fn lock(
        &mut self,
        scope_root: &str,
        mode: LockMode,
        set_by: LockActor,
        reason: &str,
    ) -> Result<NodeLock> {
        if !self.nodes.contains_key(scope_root) {
            return Err(QuetzalcoatlError::invalid_id(
                "NodeId",
                format!("未知锁作用域节点 {scope_root}"),
            ));
        }
        if let Some(existing) = self.locks.get(scope_root)
            && set_by.rank() > existing.set_by.rank()
        {
            return Err(QuetzalcoatlError::PermissionDenied {
                detail: format!(
                    "{set_by:?} 无权覆盖 {:?} 在 {scope_root} 设置的锁",
                    existing.set_by
                ),
            });
        }
        let now = self.tick_now();
        let entry = NodeLock {
            scope_root: String::from(scope_root),
            mode,
            set_by,
            reason: String::from(reason),
            created_at: now,
        };
        self.locks.insert(String::from(scope_root), entry.clone());
        Ok(entry)
    }

    /// 释放机械锁（要求同级或更高权限设置者）。
    pub fn unlock(&mut self, scope_root: &str, actor: LockActor) -> Result<bool> {
        let Some(existing) = self.locks.get(scope_root) else {
            return Ok(false);
        };
        if actor.rank() > existing.set_by.rank() {
            return Err(QuetzalcoatlError::PermissionDenied {
                detail: format!(
                    "{actor:?} 无权解除 {:?} 在 {scope_root} 设置的锁",
                    existing.set_by
                ),
            });
        }
        self.locks.remove(scope_root);
        let _ = self.tick_now();
        Ok(true)
    }

    #[must_use]
    pub fn lock_mode(&self, id: &str) -> Option<LockMode> {
        self.active_lock_for(id).map(|l| l.mode)
    }

    /// 沿 `primaryParent` 返回根到目标节点的路径。
    pub fn path(&self, id: &str) -> Result<Vec<GraphNode>> {
        let mut out = Vec::new();
        let mut seen = BTreeSet::new();
        let mut curr_opt = Some(String::from(id));
        while let Some(curr_id) = curr_opt {
            if !seen.insert(curr_id.clone()) {
                return Err(QuetzalcoatlError::IntegrityViolation {
                    detail: format!("EWAVE_CYCLE: primaryParent 链在 {curr_id} 处成环"),
                });
            }
            let node = self.nodes.get(&curr_id).ok_or_else(|| {
                QuetzalcoatlError::invalid_id("NodeId", format!("未知路径节点 {curr_id}"))
            })?;
            out.push(node.clone());
            curr_opt = node.primary_parent.clone();
        }
        out.reverse();
        Ok(out)
    }

    #[must_use]
    pub fn descendants(&self, id: &str) -> Vec<&GraphNode> {
        let Some(start) = self.nodes.get(id) else {
            return Vec::new();
        };
        let mut out = Vec::new();
        let mut seen = BTreeSet::new();
        let mut queue = std::collections::VecDeque::new();
        queue.push_back(start);
        while let Some(curr) = queue.pop_front() {
            for cid in &curr.children {
                if seen.insert(cid.clone())
                    && let Some(child) = self.nodes.get(cid)
                {
                    out.push(child);
                    queue.push_back(child);
                }
            }
        }
        out
    }

    fn score_all(
        &self,
        vector: &[f64],
        filter: Option<&TemporalFilter>,
    ) -> Result<Vec<ScoredNode>> {
        let mut scored = Vec::new();
        for node in self.nodes.values() {
            if node.kind == NodeKind::Root {
                continue;
            }
            let Some(centroid) = &node.centroid else {
                continue;
            };
            if !self.matches_filter(node, filter) {
                continue;
            }
            scored.push(ScoredNode {
                node: node.clone(),
                score: cosine_similarity(vector, centroid)?,
            });
        }
        scored.sort_by(|a, b| {
            cmp_f64_desc(a.score, b.score).then_with(|| cmp_utf16(&a.node.id, &b.node.id))
        });
        Ok(scored)
    }

    /// 按余弦相似度检索前 `k` 个节点。
    pub fn search(
        &self,
        query: impl Into<QueryInput>,
        k: usize,
        filter: Option<&TemporalFilter>,
    ) -> Result<Vec<ScoredNode>> {
        if k == 0 {
            return Ok(Vec::new());
        }
        let vec = self.resolve_query_vector(query.into())?;
        let mut scored = self.score_all(&vec, filter)?;
        scored.truncate(k);
        Ok(scored)
    }

    /// 沿主干下钻 + 1 跳多父与逻辑邻居路由锚点。
    pub fn route(
        &self,
        query: impl Into<QueryInput>,
        k: usize,
        filter: Option<&TemporalFilter>,
    ) -> Result<Vec<ScoredNode>> {
        let vec = self.resolve_query_vector(query.into())?;
        let limit = k.max(1);
        let mut candidates = BTreeSet::new();

        let mut curr_opt = Some(self.root_id.clone());
        let mut visited = BTreeSet::new();
        while let Some(curr_id) = curr_opt {
            if !visited.insert(curr_id.clone()) {
                break;
            }
            let Some(curr) = self.nodes.get(&curr_id) else {
                break;
            };
            if curr.kind != NodeKind::Root && self.matches_filter(curr, filter) {
                candidates.insert(curr.id.clone());
            }
            let mut primary_kids: Vec<(&GraphNode, f64)> = Vec::new();
            for cid in &curr.children {
                if let Some(child) = self.nodes.get(cid)
                    && child.primary_parent.as_deref() == Some(curr_id.as_str())
                    && let Some(cent) = &child.centroid
                {
                    primary_kids.push((child, cosine_distance(&vec, cent)?));
                }
            }
            if primary_kids.is_empty() {
                break;
            }
            primary_kids.sort_by(|(a, da), (b, db)| {
                cmp_f64_asc(*da, *db).then_with(|| cmp_utf16(&a.id, &b.id))
            });
            for &(kid, _) in &primary_kids {
                if self.matches_filter(kid, filter) {
                    candidates.insert(kid.id.clone());
                }
            }
            curr_opt = Some(primary_kids[0].0.id.clone());
        }

        let seed_ids: Vec<NodeId> = candidates.iter().cloned().collect();
        let allow_cross = filter.is_none_or(|f| f.cross_slice_links);
        let include_invalid = filter.is_some_and(|f| f.include_invalid);
        for id in seed_ids {
            let Some(node) = self.nodes.get(&id) else {
                continue;
            };
            for cid in &node.children {
                if let Some(child) = self.nodes.get(cid)
                    && self.matches_filter(child, filter)
                {
                    candidates.insert(child.id.clone());
                }
            }
            for pid in &node.parents {
                if let Some(parent) = self.nodes.get(pid)
                    && parent.kind != NodeKind::Root
                    && self.matches_filter(parent, filter)
                {
                    candidates.insert(parent.id.clone());
                }
            }
            if allow_cross {
                for lid in &node.links {
                    if let Some(linked) = self.nodes.get(lid)
                        && (include_invalid || linked.is_valid())
                    {
                        candidates.insert(linked.id.clone());
                    }
                }
            }
        }

        let mut scored = Vec::new();
        for id in candidates {
            if let Some(node) = self.nodes.get(&id)
                && node.kind != NodeKind::Root
                && let Some(cent) = &node.centroid
            {
                scored.push(ScoredNode {
                    node: node.clone(),
                    score: cosine_similarity(&vec, cent)?,
                });
            }
        }
        scored.sort_by(|a, b| {
            cmp_f64_desc(a.score, b.score).then_with(|| cmp_utf16(&a.node.id, &b.node.id))
        });
        scored.truncate(limit);
        Ok(scored)
    }

    /// 激活只读区域集合：显式分离 `+1` `supporting` 与 `-1` `conflicting` 逻辑边邻居。
    pub fn activate(
        &self,
        query: impl Into<QueryInput>,
        options: ActivateOptions,
    ) -> Result<Vec<ActivatedRegion>> {
        let vec = self.resolve_query_vector(query.into())?;
        let mut anchors = self.score_all(&vec, Some(&options.filter))?;
        anchors.truncate(options.k.max(1));
        let allow_cross = options.filter.cross_slice_links;
        let include_invalid = options.filter.include_invalid;

        let mut regions = Vec::with_capacity(anchors.len());
        for ScoredNode {
            node: anchor,
            score,
        } in anchors
        {
            let path = self.path(&anchor.id)?;
            let mut ordered_ids: Vec<NodeId> = Vec::new();
            let mut seen_ids: BTreeSet<NodeId> = BTreeSet::new();
            fn push_unique_id(
                ordered: &mut Vec<NodeId>,
                seen: &mut BTreeSet<NodeId>,
                nid: &NodeId,
            ) {
                if seen.insert(nid.clone()) {
                    ordered.push(nid.clone());
                }
            }

            for p in &path {
                push_unique_id(&mut ordered_ids, &mut seen_ids, &p.id);
            }
            let parents: Vec<GraphNode> = anchor
                .parents
                .iter()
                .filter_map(|pid| self.nodes.get(pid).cloned())
                .collect();
            for p in &parents {
                push_unique_id(&mut ordered_ids, &mut seen_ids, &p.id);
            }

            let mut link_source_ids = vec![anchor.id.clone()];
            let mut frontier = vec![anchor.id.clone()];
            for _ in 0..options.depth {
                let mut next = Vec::new();
                for curr_id in &frontier {
                    if let Some(curr) = self.nodes.get(curr_id) {
                        for cid in &curr.children {
                            if seen_ids.contains(cid) {
                                continue;
                            }
                            if let Some(child) = self.nodes.get(cid)
                                && (include_invalid || child.is_valid())
                            {
                                push_unique_id(&mut ordered_ids, &mut seen_ids, &child.id);
                                link_source_ids.push(child.id.clone());
                                next.push(child.id.clone());
                            }
                        }
                    }
                }
                frontier = next;
            }

            if let Some(pp_id) = &anchor.primary_parent
                && let Some(pp) = self.nodes.get(pp_id)
            {
                for sib_id in &pp.children {
                    if let Some(sib) = self.nodes.get(sib_id)
                        && (include_invalid || sib.is_valid())
                    {
                        push_unique_id(&mut ordered_ids, &mut seen_ids, &sib.id);
                    }
                }
            }

            let mut supporting = Vec::new();
            let mut conflicting = Vec::new();
            let mut seen_logic_edges = BTreeSet::new();

            for src_id in &link_source_ids {
                for edge in self.edges_for(Some(src_id), Some(EdgeKind::Link), None) {
                    let key = edge.key();
                    if !seen_logic_edges.insert(key) {
                        continue;
                    }
                    let other_id = if edge.from == *src_id {
                        &edge.to
                    } else {
                        &edge.from
                    };
                    let Some(other) = self.nodes.get(other_id) else {
                        continue;
                    };
                    if !include_invalid && !other.is_valid() {
                        continue;
                    }
                    if !allow_cross
                        && options.filter.mode != TemporalMode::Collapsed
                        && options.filter.slice_ids.is_some()
                        && !self.matches_filter(other, Some(&options.filter))
                    {
                        continue;
                    }
                    push_unique_id(&mut ordered_ids, &mut seen_ids, &other.id);
                    let item = ScoredEdgeNode {
                        node: other.clone(),
                        from: edge.from.clone(),
                        to: edge.to.clone(),
                        weight: edge.weight,
                        polarity: edge.polarity,
                        relation: edge.relation.clone(),
                        score: score * edge.weight,
                    };
                    if edge.polarity == LogicPolarity::Negative {
                        conflicting.push(item);
                    } else {
                        supporting.push(item);
                    }
                }
            }

            supporting.sort_by(|a, b| {
                cmp_f64_desc(a.score, b.score).then_with(|| cmp_utf16(&a.node.id, &b.node.id))
            });
            conflicting.sort_by(|a, b| {
                cmp_f64_desc(a.score, b.score).then_with(|| cmp_utf16(&a.node.id, &b.node.id))
            });

            let nodes: Vec<GraphNode> = ordered_ids
                .iter()
                .filter_map(|nid| self.nodes.get(nid).cloned())
                .collect();
            let labels: Vec<String> = nodes
                .iter()
                .map(|n| String::from(n.display_name()))
                .collect();
            let mut slices: Vec<String> = nodes
                .iter()
                .filter(|n| n.kind != NodeKind::Root)
                .map(|n| n.time.slice_id.clone())
                .collect();
            slices.sort_by(|a, b| cmp_utf16(a, b));
            slices.dedup();

            regions.push(ActivatedRegion {
                anchor,
                score,
                path,
                parents,
                nodes,
                labels,
                supporting,
                conflicting,
                slices,
            });
        }
        Ok(regions)
    }

    /// 按时间顺序汇总所有有效时间切片空间 `α_t`。
    #[must_use]
    pub fn slices(&self) -> Vec<TimeSliceSummary> {
        let mut groups: BTreeMap<String, Vec<&GraphNode>> = BTreeMap::new();
        for node in self.nodes.values() {
            if node.kind == NodeKind::Root || !node.is_valid() {
                continue;
            }
            groups
                .entry(node.time.slice_id.clone())
                .or_default()
                .push(node);
        }

        let mut summaries = Vec::with_capacity(groups.len());
        for (slice_id, group_nodes) in groups {
            let mut start_at = u64::MAX;
            let mut end_at = 0_u64;
            let mut leaves = 0usize;
            let mut branches = 0usize;
            let mut vec_items: Vec<(&[f64], f64)> = Vec::new();
            let mut radius_items: Vec<(&[f64], f64, f64)> = Vec::new();

            for node in &group_nodes {
                start_at = start_at.min(node.time.at);
                end_at = end_at.max(node.time.end_at.unwrap_or(node.time.at));
                if node.kind == NodeKind::Leaf {
                    leaves += 1;
                    if let Some(emb) = &node.embedding {
                        vec_items.push((emb.as_slice(), 1.0));
                        radius_items.push((emb.as_slice(), 1.0, 0.0));
                    }
                } else {
                    branches += 1;
                    if node.children.is_empty()
                        && let Some(emb) = &node.embedding
                    {
                        vec_items.push((emb.as_slice(), 1.0));
                        radius_items.push((emb.as_slice(), 1.0, 0.0));
                    }
                }
            }

            let centroid = if vec_items.is_empty() {
                None
            } else {
                weighted_mean(&vec_items).ok()
            };
            let radius = match &centroid {
                Some(c) => rms_radius(&radius_items, c),
                None => 0.0,
            };
            let mut node_ids: Vec<NodeId> = group_nodes.iter().map(|n| n.id.clone()).collect();
            node_ids.sort_by(|a, b| cmp_utf16(a, b));

            summaries.push(TimeSliceSummary {
                slice_id,
                start_at: if start_at == u64::MAX {
                    self.created_at
                } else {
                    start_at
                },
                end_at: if end_at == 0 { self.updated_at } else { end_at },
                nodes: group_nodes.len(),
                leaves,
                branches,
                node_ids,
                centroid,
                radius,
            });
        }

        summaries.sort_by(|a, b| {
            a.start_at
                .cmp(&b.start_at)
                .then_with(|| cmp_utf16(&a.slice_id, &b.slice_id))
        });
        summaries
    }

    /// 提取特定时间切片 `α_t` 视图。
    pub fn slice_view(&self, slice_ids: &[String], include_cross_links: bool) -> Result<Self> {
        let filter = TemporalFilter {
            slice_ids: Some(slice_ids.to_vec()),
            mode: TemporalMode::Sliced,
            ..TemporalFilter::default()
        };
        let mut keep = BTreeSet::new();
        keep.insert(self.root_id.clone());
        for node in self.nodes.values() {
            if node.kind == NodeKind::Root {
                continue;
            }
            if self.matches_filter(node, Some(&filter)) {
                keep.insert(node.id.clone());
                for anc in self.path(&node.id)? {
                    keep.insert(anc.id);
                }
                if include_cross_links {
                    for lid in &node.links {
                        if let Some(linked) = self.nodes.get(lid)
                            && linked.is_valid()
                        {
                            keep.insert(linked.id.clone());
                            for anc in self.path(&linked.id)? {
                                keep.insert(anc.id);
                            }
                        }
                    }
                }
            }
        }
        self.induce_subgraph(&keep, Some(slice_ids.join("+")))
    }

    /// 提取以 `root_id` 为根的不完整子树（对齐 SayIt 分项目导出）。
    pub fn extract_subtree(
        &self,
        subtree_root_id: &str,
        slice_id: Option<&str>,
        include_cross_links: bool,
    ) -> Result<Self> {
        let target = self.nodes.get(subtree_root_id).ok_or_else(|| {
            QuetzalcoatlError::invalid_id("NodeId", format!("未知子树根 {subtree_root_id}"))
        })?;
        if target.id == self.root_id {
            return match slice_id {
                Some(sid) => self.slice_view(&[String::from(sid)], include_cross_links),
                None => Self::from_snapshot(self.to_snapshot()),
            };
        }
        let mut keep = BTreeSet::new();
        keep.insert(self.root_id.clone());
        keep.insert(target.id.clone());
        for anc in self.path(&target.id)? {
            keep.insert(anc.id);
        }
        for desc in self.descendants(&target.id) {
            if slice_id.is_none_or(|s| desc.slice_id() == s) {
                keep.insert(desc.id.clone());
                for anc in self.path(&desc.id)? {
                    keep.insert(anc.id);
                }
            }
        }
        if include_cross_links {
            let current: Vec<NodeId> = keep.iter().cloned().collect();
            for id in current {
                if let Some(node) = self.nodes.get(&id)
                    && node.kind != NodeKind::Root
                {
                    for lid in &node.links {
                        if let Some(other) = self.nodes.get(lid)
                            && other.is_valid()
                        {
                            keep.insert(other.id.clone());
                            for anc in self.path(&other.id)? {
                                keep.insert(anc.id);
                            }
                        }
                    }
                }
            }
        }
        self.induce_subgraph(&keep, Some(String::from(target.display_name())))
    }

    /// 压缩多个时间切片空间 `{α_t}` 为单一时间不变空间 `α_T`（合并跨切片同名或近质心分支）。
    pub fn collapse_time(&self, options: CollapseTimeOptions) -> Result<Self> {
        let mut valid_ids = BTreeSet::new();
        valid_ids.insert(self.root_id.clone());
        for node in self.nodes.values() {
            if node.kind == NodeKind::Root {
                continue;
            }
            if options.exclude_invalid && !node.is_valid() {
                continue;
            }
            valid_ids.insert(node.id.clone());
        }

        let collapsed_name = match &self.options.name {
            Some(n) => format!("{n}:alpha_T"),
            None => String::from("alpha_T"),
        };
        let mut projected = self.induce_subgraph(&valid_ids, Some(collapsed_name))?;
        for node in projected.nodes.values_mut() {
            node.time.slice_id = options.slice_id.clone();
        }

        if options.merge_branches {
            let mut merged_any = true;
            while merged_any {
                merged_any = false;
                let mut branch_ids: Vec<(NodeId, usize)> = projected
                    .nodes
                    .values()
                    .filter(|n| n.kind == NodeKind::Branch)
                    .map(|n| {
                        let depth = projected.path(&n.id).map_or(0, |p| p.len());
                        (n.id.clone(), depth)
                    })
                    .collect();
                branch_ids.sort_by(|(a, da), (b, db)| da.cmp(db).then_with(|| cmp_utf16(a, b)));

                'outer: for i in 0..branch_ids.len() {
                    for j in (i + 1)..branch_ids.len() {
                        let b1_id = &branch_ids[i].0;
                        let b2_id = &branch_ids[j].0;
                        let should_merge = {
                            let (Some(b1), Some(b2)) =
                                (projected.nodes.get(b1_id), projected.nodes.get(b2_id))
                            else {
                                continue;
                            };
                            if b1.primary_parent != b2.primary_parent {
                                false
                            } else {
                                let norm1 =
                                    normalize_nfkc_lower_trim(b1.label.as_deref().unwrap_or(""));
                                let norm2 =
                                    normalize_nfkc_lower_trim(b2.label.as_deref().unwrap_or(""));
                                let same_label = !norm1.is_empty() && norm1 == norm2;
                                let close_centroid = match (&b1.centroid, &b2.centroid) {
                                    (Some(c1), Some(c2)) if c1.len() == c2.len() => {
                                        cosine_distance(c1, c2)? <= options.branch_merge_threshold
                                            && (norm1.is_empty() || norm2.is_empty() || same_label)
                                    }
                                    _ => false,
                                };
                                same_label || close_centroid
                            }
                        };
                        if should_merge {
                            projected.absorb_branch(b1_id, b2_id)?;
                            merged_any = true;
                            break 'outer;
                        }
                    }
                }
            }
        }

        projected.rebuild()?;
        Ok(projected)
    }

    fn absorb_branch(&mut self, keeper_id: &str, absorbed_id: &str) -> Result<()> {
        let absorbed_children = self
            .nodes
            .get(absorbed_id)
            .map_or_else(Vec::new, |n| n.children.clone());
        for cid in absorbed_children {
            let was_primary = self
                .nodes
                .get(&cid)
                .is_some_and(|c| c.primary_parent.as_deref() == Some(absorbed_id));
            let weight = self
                .edges
                .get(&format!("hierarchy:{absorbed_id}>{cid}"))
                .map_or(1.0, |e| e.weight);
            let _ = self.detach_internal(&cid, absorbed_id, true, true)?;
            if cid != keeper_id && !self.reaches(keeper_id, &cid) {
                self.attach_internal(
                    &cid,
                    keeper_id,
                    was_primary,
                    true,
                    weight,
                    None,
                    BTreeMap::new(),
                )?;
            }
        }

        let absorbed_parents = self
            .nodes
            .get(absorbed_id)
            .map_or_else(Vec::new, |n| n.parents.clone());
        for pid in absorbed_parents {
            if pid == keeper_id {
                continue;
            }
            let weight = self
                .edges
                .get(&format!("hierarchy:{pid}>{absorbed_id}"))
                .map_or(1.0, |e| e.weight);
            if !self
                .edges
                .contains_key(&format!("hierarchy:{pid}>{keeper_id}"))
                && !self.reaches(&pid, keeper_id)
            {
                self.attach_internal(keeper_id, &pid, false, true, weight, None, BTreeMap::new())?;
            }
        }

        let absorbed_links: Vec<GraphEdge> = self
            .edges_for(Some(absorbed_id), Some(EdgeKind::Link), None)
            .into_iter()
            .cloned()
            .collect();
        for edge in absorbed_links {
            let from_id = if edge.from == absorbed_id {
                String::from(keeper_id)
            } else {
                edge.from
            };
            let to_id = if edge.to == absorbed_id {
                String::from(keeper_id)
            } else {
                edge.to
            };
            if from_id != to_id {
                let key = format!("link:{from_id}>{to_id}");
                if !self.edges.contains_key(&key)
                    && self.nodes.contains_key(&from_id)
                    && self.nodes.contains_key(&to_id)
                {
                    self.edges.insert(
                        key,
                        GraphEdge {
                            from: from_id.clone(),
                            to: to_id.clone(),
                            kind: EdgeKind::Link,
                            weight: edge.weight,
                            polarity: edge.polarity,
                            relation: edge.relation,
                            created_at: edge.created_at,
                            meta: edge.meta,
                        },
                    );
                    if let Some(f) = self.nodes.get_mut(&from_id) {
                        f.add_out_link(&to_id);
                    }
                    if let Some(t) = self.nodes.get_mut(&to_id) {
                        t.add_in_link(&from_id);
                    }
                }
            }
        }

        self.delete_node_internal(absorbed_id)?;
        Ok(())
    }

    fn delete_node_internal(&mut self, id: &str) -> Result<()> {
        self.locks.remove(id);
        let parents = self
            .nodes
            .get(id)
            .map_or_else(Vec::new, |n| n.parents.clone());
        for pid in parents {
            let _ = self.detach_internal(id, &pid, true, true)?;
        }
        let out_links = self
            .nodes
            .get(id)
            .map_or_else(Vec::new, |n| n.out_links.clone());
        for oid in out_links {
            self.edges.remove(&format!("link:{id}>{oid}"));
            if let Some(target) = self.nodes.get_mut(&oid) {
                target.remove_in_link(id);
            }
        }
        let in_links = self
            .nodes
            .get(id)
            .map_or_else(Vec::new, |n| n.in_links.clone());
        for iid in in_links {
            self.edges.remove(&format!("link:{iid}>{id}"));
            if let Some(source) = self.nodes.get_mut(&iid) {
                source.remove_out_link(id);
            }
        }
        let links = self
            .nodes
            .get(id)
            .map_or_else(Vec::new, |n| n.links.clone());
        for lid in links {
            if let Some(other) = self.nodes.get_mut(&lid) {
                other.remove_all_links_with(id);
            }
        }
        self.edges.retain(|_, e| e.from != id && e.to != id);
        self.nodes.remove(id);
        Ok(())
    }

    fn induce_subgraph(&self, keep: &BTreeSet<NodeId>, name: Option<String>) -> Result<Self> {
        let mut nodes_vec: Vec<NodeSnapshot> = self
            .nodes
            .values()
            .filter(|n| keep.contains(&n.id))
            .map(|node| {
                let mut snap = node.to_snapshot();
                snap.parents.retain(|pid| keep.contains(pid));
                let mut primary = snap
                    .primary_parent
                    .filter(|pp| keep.contains(pp))
                    .or_else(|| snap.parents.first().cloned());
                if snap.kind != NodeKind::Root && primary.is_none() {
                    snap.parents.push(self.root_id.clone());
                    primary = Some(self.root_id.clone());
                }
                snap.primary_parent = primary;
                snap.children.retain(|cid| keep.contains(cid));
                snap.links.retain(|lid| keep.contains(lid));
                if let Some(out_l) = &mut snap.out_links {
                    out_l.retain(|lid| keep.contains(lid));
                }
                if let Some(in_l) = &mut snap.in_links {
                    in_l.retain(|lid| keep.contains(lid));
                }
                snap
            })
            .collect();
        nodes_vec.sort_by(|a, b| cmp_utf16(&a.id, &b.id));

        let parent_additions: Vec<(NodeId, NodeId)> = nodes_vec
            .iter()
            .flat_map(|n| n.parents.iter().map(move |pid| (pid.clone(), n.id.clone())))
            .collect();
        for (pid, cid) in parent_additions {
            if let Some(parent_snap) = nodes_vec.iter_mut().find(|n| n.id == pid)
                && !parent_snap.children.contains(&cid)
            {
                parent_snap.children.push(cid);
            }
        }

        let mut edges_vec: Vec<EdgeSnapshot> = self
            .edges
            .values()
            .filter(|e| keep.contains(&e.from) && keep.contains(&e.to))
            .map(GraphEdge::to_snapshot)
            .collect();
        edges_vec.sort_by(|a, b| {
            let ka = match a.kind {
                EdgeKind::Link => format!("link:{}>{}", a.from, a.to),
                EdgeKind::Hierarchy => format!("hierarchy:{}>{}", a.from, a.to),
            };
            let kb = match b.kind {
                EdgeKind::Link => format!("link:{}>{}", b.from, b.to),
                EdgeKind::Hierarchy => format!("hierarchy:{}>{}", b.from, b.to),
            };
            cmp_utf16(&ka, &kb)
        });

        let mut induced = Self::from_snapshot_with_options(
            EwaveSnapshot {
                format: String::from("ewave"),
                version: 2,
                name,
                created_at: self.created_at,
                updated_at: self.updated_at,
                nodes: nodes_vec,
                edges: edges_vec,
                locks: None,
                meta: None,
            },
            self.options.clone(),
        )?;
        induced.embedder_online = self.embedder_online;
        Ok(induced)
    }

    pub(crate) fn refresh_node(&mut self, id: &str) -> Result<()> {
        let (kind, is_valid, embedding_opt, children) = {
            let Some(node) = self.nodes.get(id) else {
                return Ok(());
            };
            (
                node.kind,
                node.is_valid(),
                node.embedding.clone(),
                node.children.clone(),
            )
        };

        if kind == NodeKind::Leaf {
            if !is_valid {
                if let Some(node) = self.nodes.get_mut(id) {
                    node.count = 0;
                    node.member_count = 0.0;
                    node.centroid = embedding_opt;
                    node.ls = None;
                    node.ss = 0.0;
                    node.radius = 0.0;
                }
                return Ok(());
            }
            let cf_opt = match &embedding_opt {
                Some(emb) => Some(cf_from_vector(emb, 1.0)?),
                None => None,
            };
            if let Some(node) = self.nodes.get_mut(id) {
                node.count = 1;
                node.member_count = 1.0;
                node.centroid = embedding_opt;
                node.ls = cf_opt.as_ref().map(|c| c.ls.clone());
                node.ss = cf_opt.map_or(0.0, |c| c.ss);
                node.radius = 0.0;
            }
            return Ok(());
        }

        // 1. Primary spine leaf count (strictly conserved)
        let mut primary_count = 0usize;
        for cid in &children {
            if let Some(child) = self.nodes.get(cid)
                && child.primary_parent.as_deref() == Some(id)
                && child.is_valid()
            {
                primary_count += child.count;
            }
        }

        // 2. Multi-parent CF aggregation across all valid attributed children
        struct AttributedChild {
            centroid: Vec<f64>,
            radius: f64,
            edge_weight: f64,
            effective_weight: f64,
            cf: ClusteringFeature,
        }
        let mut attributed: Vec<AttributedChild> = Vec::new();
        for cid in &children {
            let Some(child) = self.nodes.get(cid) else {
                continue;
            };
            if !child.is_valid() {
                continue;
            }
            let Some(child_cent) = &child.centroid else {
                continue;
            };
            let edge_weight = self
                .edges
                .get(&format!("hierarchy:{id}>{cid}"))
                .map_or(1.0, |e| e.weight);
            let child_weight = if child.member_count > 0.0 {
                child.member_count
            } else {
                1.0
            };
            let effective_weight = edge_weight * child_weight;
            let child_cf = match &child.ls {
                Some(ls_vec) if ls_vec.len() == child_cent.len() && child.ss > 0.0 => {
                    ClusteringFeature {
                        n: child_weight,
                        ls: ls_vec.clone(),
                        ss: child.ss,
                    }
                }
                _ => cf_from_vector(child_cent, child_weight)?,
            };
            attributed.push(AttributedChild {
                centroid: child_cent.clone(),
                radius: child.radius,
                edge_weight,
                effective_weight,
                cf: child_cf,
            });
        }

        if attributed.is_empty() {
            if kind == NodeKind::Branch
                && is_valid
                && let Some(emb) = embedding_opt
            {
                let seed_cf = cf_from_vector(&emb, 1.0)?;
                if let Some(node) = self.nodes.get_mut(id) {
                    node.count = primary_count;
                    node.member_count = 0.0;
                    node.centroid = Some(emb);
                    node.ls = Some(seed_cf.ls);
                    node.ss = seed_cf.ss;
                    node.radius = 0.0;
                }
            } else if let Some(node) = self.nodes.get_mut(id) {
                node.count = primary_count;
                node.member_count = 0.0;
                node.centroid = None;
                node.ls = None;
                node.ss = 0.0;
                node.radius = 0.0;
            }
            return Ok(());
        }

        let cf_refs: Vec<(&ClusteringFeature, f64)> = attributed
            .iter()
            .map(|item| (&item.cf, item.edge_weight))
            .collect();
        let combined_cf = cf_combine(&cf_refs)?;
        let member_count: f64 = attributed.iter().map(|i| i.effective_weight).sum();
        let centroid = match combined_cf.as_ref().and_then(cf_centroid) {
            Some(c) => c,
            None => {
                let mean_refs: Vec<(&[f64], f64)> = attributed
                    .iter()
                    .map(|i| (i.centroid.as_slice(), i.effective_weight))
                    .collect();
                weighted_mean(&mean_refs)?
            }
        };
        let radius_refs: Vec<(&[f64], f64, f64)> = attributed
            .iter()
            .map(|i| (i.centroid.as_slice(), i.effective_weight, i.radius))
            .collect();
        let radius = rms_radius(&radius_refs, &centroid);

        if let Some(node) = self.nodes.get_mut(id) {
            node.count = primary_count;
            node.member_count = member_count;
            node.ls = Some(
                combined_cf
                    .as_ref()
                    .map_or_else(|| centroid.clone(), |c| c.ls.clone()),
            );
            node.ss = combined_cf.as_ref().map_or(member_count, |c| c.ss);
            node.centroid = Some(centroid);
            node.radius = radius;
        }
        Ok(())
    }

    pub(crate) fn rebuild(&mut self) -> Result<()> {
        let mut visited = BTreeSet::new();
        let mut order = Vec::with_capacity(self.nodes.len());

        fn dfs(
            id: &str,
            nodes: &BTreeMap<NodeId, GraphNode>,
            visited: &mut BTreeSet<NodeId>,
            order: &mut Vec<NodeId>,
        ) {
            if !visited.insert(String::from(id)) {
                return;
            }
            if let Some(node) = nodes.get(id) {
                for cid in &node.children {
                    if !visited.contains(cid) {
                        dfs(cid, nodes, visited, order);
                    }
                }
            }
            order.push(String::from(id));
        }

        let rid = self.root_id.clone();
        dfs(&rid, &self.nodes, &mut visited, &mut order);
        let all_ids: Vec<NodeId> = self.nodes.keys().cloned().collect();
        for id in all_ids {
            if !visited.contains(&id) {
                dfs(&id, &self.nodes, &mut visited, &mut order);
            }
        }
        for id in order {
            self.refresh_node(&id)?;
        }
        Ok(())
    }

    #[must_use]
    pub fn stats(&self) -> GraphStats {
        let mut leaves = 0usize;
        let mut branches = 0usize;
        let mut links = 0usize;
        let mut positive_links = 0usize;
        let mut negative_links = 0usize;
        let mut depth = 0usize;
        let mut slice_set = BTreeSet::new();

        for node in self.nodes.values() {
            if node.kind == NodeKind::Leaf {
                leaves += 1;
            } else {
                branches += 1;
            }
            if node.kind != NodeKind::Root && node.is_valid() {
                slice_set.insert(node.time.slice_id.clone());
            }
            if let Ok(p) = self.path(&node.id) {
                depth = depth.max(p.len().saturating_sub(1));
            }
        }
        for edge in self.edges.values() {
            if edge.kind == EdgeKind::Link {
                links += 1;
                if edge.polarity == LogicPolarity::Negative {
                    negative_links += 1;
                } else {
                    positive_links += 1;
                }
            }
        }

        GraphStats {
            name: self.options.name.clone(),
            nodes: self.nodes.len(),
            leaves,
            branches,
            links,
            positive_links,
            negative_links,
            slices: slice_set.len(),
            locks: self.locks.len(),
            depth,
            created_at: self.created_at,
            updated_at: self.updated_at,
        }
    }

    /// 校验全图结构不变量（I1 无环、I2 单主干、I3 根可达、邻接对称、叶计数守恒、维度一致）。返回空数组表示完全健康。
    #[must_use]
    pub fn verify(&self) -> Vec<String> {
        let mut violations = Vec::new();
        match self.nodes.get(&self.root_id) {
            None => violations.push(String::from("root node is missing")),
            Some(root) => {
                if root.kind != NodeKind::Root {
                    violations.push(String::from("root node has the wrong kind"));
                }
                if !root.parents.is_empty() {
                    violations.push(String::from("root must not have parents"));
                }
                if root.primary_parent.is_some() {
                    violations.push(String::from("root must not have a primary parent"));
                }
            }
        }

        let has_dups = |items: &[NodeId]| -> bool {
            let set: BTreeSet<&NodeId> = items.iter().collect();
            set.len() != items.len()
        };

        for node in self.nodes.values() {
            if node.kind == NodeKind::Leaf && !node.children.is_empty() {
                violations.push(format!("{}: leaf has children", node.id));
            }
            if node.kind != NodeKind::Root && node.primary_parent.is_none() {
                violations.push(format!("{}: non-root node has no primary parent", node.id));
            }
            if let Some(pp) = &node.primary_parent
                && !node.parents.contains(pp)
            {
                violations.push(format!("{}: primary parent is not in parents", node.id));
            }
            if has_dups(&node.parents) {
                violations.push(format!("{}: duplicate parent", node.id));
            }
            if has_dups(&node.children) {
                violations.push(format!("{}: duplicate child", node.id));
            }
            if has_dups(&node.links) {
                violations.push(format!("{}: duplicate link", node.id));
            }
            if has_dups(&node.out_links) {
                violations.push(format!("{}: duplicate outLink", node.id));
            }
            if has_dups(&node.in_links) {
                violations.push(format!("{}: duplicate inLink", node.id));
            }

            for pid in &node.parents {
                match self.nodes.get(pid) {
                    None => violations.push(format!("{}: missing parent {pid}", node.id)),
                    Some(parent) => {
                        if !parent.children.contains(&node.id) {
                            violations.push(format!("{}: parent {pid} does not list it", node.id));
                        }
                        if !self
                            .edges
                            .contains_key(&format!("hierarchy:{pid}>{}", node.id))
                        {
                            violations
                                .push(format!("{}: missing hierarchy edge from {pid}", node.id));
                        }
                    }
                }
            }
            for cid in &node.children {
                match self.nodes.get(cid) {
                    None => violations.push(format!("{}: missing child {cid}", node.id)),
                    Some(child) => {
                        if !child.parents.contains(&node.id) {
                            violations.push(format!("{}: child {cid} does not list it", node.id));
                        }
                    }
                }
            }
            for oid in &node.out_links {
                match self.nodes.get(oid) {
                    None => violations.push(format!("{}: missing outLink target {oid}", node.id)),
                    Some(target) => {
                        if !target.in_links.contains(&node.id) {
                            violations.push(format!(
                                "{}: outLink {oid} missing reciprocal inLink",
                                node.id
                            ));
                        }
                        if !self.edges.contains_key(&format!("link:{}>{oid}", node.id)) {
                            violations
                                .push(format!("{}: missing directed link edge to {oid}", node.id));
                        }
                    }
                }
            }
            for iid in &node.in_links {
                match self.nodes.get(iid) {
                    None => violations.push(format!("{}: missing inLink source {iid}", node.id)),
                    Some(source) => {
                        if !source.out_links.contains(&node.id) {
                            violations.push(format!(
                                "{}: inLink {iid} missing reciprocal outLink",
                                node.id
                            ));
                        }
                        if !self.edges.contains_key(&format!("link:{iid}>{}", node.id)) {
                            violations.push(format!(
                                "{}: missing directed link edge from {iid}",
                                node.id
                            ));
                        }
                    }
                }
            }
            for lid in &node.links {
                match self.nodes.get(lid) {
                    None => violations.push(format!("{}: missing link {lid}", node.id)),
                    Some(other) => {
                        if !other.links.contains(&node.id) {
                            violations.push(format!(
                                "{}: link {lid} is not symmetric in links[]",
                                node.id
                            ));
                        }
                        if !self.edges.contains_key(&format!("link:{}>{lid}", node.id))
                            && !self.edges.contains_key(&format!("link:{lid}>{}", node.id))
                        {
                            violations.push(format!("{}: missing link edge with {lid}", node.id));
                        }
                    }
                }
            }

            if let (Some(cent), Some(dim)) = (&node.centroid, self.dimension)
                && cent.len() != dim
            {
                violations.push(format!("{}: centroid dimension mismatch", node.id));
            }
            if let (Some(emb), Some(dim)) = (&node.embedding, self.dimension)
                && emb.len() != dim
            {
                violations.push(format!("{}: embedding dimension mismatch", node.id));
            }

            if node.kind == NodeKind::Leaf {
                let expected = usize::from(node.is_valid());
                if node.count != expected {
                    violations.push(format!("{}: leaf count is not {expected}", node.id));
                }
                if node.radius != 0.0 {
                    violations.push(format!("{}: leaf radius is not 0", node.id));
                }
                if node.centroid.is_some() && node.embedding.is_none() {
                    violations.push(format!("{}: leaf centroid without embedding", node.id));
                }
            } else {
                let mut sum_count = 0usize;
                for cid in &node.children {
                    if let Some(child) = self.nodes.get(cid)
                        && child.primary_parent.as_deref() == Some(node.id.as_str())
                        && child.is_valid()
                    {
                        sum_count += child.count;
                    }
                }
                if node.count != sum_count {
                    violations.push(format!(
                        "{}: aggregate count {} != {sum_count}",
                        node.id, node.count
                    ));
                }
            }
        }

        for edge in self.edges.values() {
            if !edge.weight.is_finite() || edge.weight <= 0.0 {
                violations.push(format!(
                    "edge {}: invalid weight {}",
                    edge.key(),
                    edge.weight
                ));
            }
        }

        // I1: Hierarchy DAG cycle detection
        let mut colors: BTreeMap<&str, u8> = BTreeMap::new();
        fn check_dag<'a>(
            id: &'a str,
            nodes: &'a BTreeMap<NodeId, GraphNode>,
            colors: &mut BTreeMap<&'a str, u8>,
            violations: &mut Vec<String>,
        ) {
            match colors.get(id).copied().unwrap_or(0) {
                1 => {
                    violations.push(format!("cycle detected at {id}"));
                    return;
                }
                2 => return,
                _ => {}
            }
            colors.insert(id, 1);
            if let Some(n) = nodes.get(id) {
                for cid in &n.children {
                    check_dag(cid, nodes, colors, violations);
                }
            }
            colors.insert(id, 2);
        }
        for id in self.nodes.keys() {
            check_dag(id, &self.nodes, &mut colors, &mut violations);
        }

        // I3: Primary spine reachability to root
        for node in self.nodes.values() {
            if node.kind == NodeKind::Root {
                continue;
            }
            let mut curr_opt = Some(node);
            let mut seen = BTreeSet::new();
            while let Some(curr) = curr_opt {
                if curr.kind == NodeKind::Root {
                    break;
                }
                if !seen.insert(&curr.id) {
                    violations.push(format!("{}: primary chain cycles", node.id));
                    break;
                }
                curr_opt = curr
                    .primary_parent
                    .as_ref()
                    .and_then(|pp| self.nodes.get(pp));
            }
            if curr_opt.map(|c| c.kind) != Some(NodeKind::Root) {
                violations.push(format!(
                    "{}: not reachable from the root via primary edges",
                    node.id
                ));
            }
        }

        violations
    }

    pub fn verify_strict(&self) -> Result<()> {
        let violations = self.verify();
        if violations.is_empty() {
            Ok(())
        } else {
            Err(QuetzalcoatlError::IntegrityViolation {
                detail: format!(
                    "SerpentineGraph 结构不变量校验失败: {}",
                    violations.join("; ")
                ),
            })
        }
    }

    /// 导出 `@plutokeating/ewave@0.2.0` 兼容的 `EwaveSnapshot`（节点与边均按确定性 UTF-16 码元序排列）。
    #[must_use]
    pub fn to_snapshot(&self) -> EwaveSnapshot {
        let pending_set: BTreeSet<&str> = self.pending_reembed.iter().map(String::as_str).collect();
        let mut node_list: Vec<&GraphNode> = self.nodes.values().collect();
        node_list.sort_by(|a, b| cmp_utf16(&a.id, &b.id));
        let mut nodes: Vec<NodeSnapshot> = node_list
            .into_iter()
            .map(|n| {
                let mut snap = n.to_snapshot();
                if pending_set.contains(snap.id.as_str()) {
                    snap.meta.insert(
                        String::from("reembed_pending"),
                        serde_json::Value::Bool(true),
                    );
                }
                snap
            })
            .collect();

        if !self.sayit_records.is_empty() {
            let mut records: Vec<&SayItSessionRecord> = self.sayit_records.values().collect();
            records.sort_by(|a, b| {
                cmp_utf16(&a.sayit_user_hash, &b.sayit_user_hash)
                    .then_with(|| cmp_utf16(&a.slice_id, &b.slice_id))
                    .then_with(|| cmp_utf16(&a.session_id, &b.session_id))
            });
            if let Ok(serialized_records) = serde_json::to_value(&records)
                && let Some(root_snap) = nodes.iter_mut().find(|n| n.id == self.root_id)
            {
                root_snap
                    .meta
                    .insert(String::from("qz_sayit_records"), serialized_records);
            }
        }

        let mut edge_list: Vec<&GraphEdge> = self.edges.values().collect();
        edge_list.sort_by(|a, b| cmp_utf16(&a.key(), &b.key()));
        let edges = edge_list.into_iter().map(GraphEdge::to_snapshot).collect();

        let mut lock_list: Vec<NodeLock> = self.locks.values().cloned().collect();
        lock_list.sort_by(|a, b| cmp_utf16(&a.scope_root, &b.scope_root));
        let locks = if lock_list.is_empty() {
            None
        } else {
            Some(lock_list)
        };

        let meta = if self.options.meta.is_empty() {
            None
        } else {
            Some(self.options.meta.clone())
        };

        EwaveSnapshot {
            format: String::from("ewave"),
            version: 2,
            name: self.options.name.clone(),
            created_at: self.created_at,
            updated_at: self.updated_at,
            nodes,
            edges,
            locks,
            meta,
        }
    }

    /// 导出带显式 `{ emb_model_id, emb_dim }` 元数据的快照（防坑规范 #11 ①）。
    #[must_use]
    pub fn to_snapshot_with_emb_meta(&self) -> EwaveSnapshot {
        let mut snap = self.to_snapshot();
        let mut meta = snap.meta.unwrap_or_default();
        meta.insert(
            String::from("emb_model_id"),
            serde_json::json!(self.options.emb_model_id),
        );
        meta.insert(
            String::from("emb_dim"),
            serde_json::json!(self.dimension.unwrap_or(self.options.emb_dim)),
        );
        snap.meta = Some(meta);
        snap
    }

    pub(crate) fn from_snapshot_with_options(
        snapshot: EwaveSnapshot,
        mut options: GraphOptions,
    ) -> Result<Self> {
        if snapshot.format != "ewave" || (snapshot.version != 1 && snapshot.version != 2) {
            return Err(QuetzalcoatlError::SerializationError {
                detail: format!(
                    "EWAVE_SNAPSHOT: 不支持的快照格式 format={}, version={}",
                    snapshot.format, snapshot.version
                ),
            });
        }
        if snapshot.nodes.is_empty() {
            return Err(QuetzalcoatlError::SerializationError {
                detail: String::from("EWAVE_SNAPSHOT: 快照不包含任何节点"),
            });
        }

        if options.name.is_none() {
            options.name = snapshot.name.clone();
        }
        if let Some(snap_meta) = &snapshot.meta {
            if let Some(mid) = snap_meta.get("emb_model_id").and_then(|v| v.as_str()) {
                options.emb_model_id = String::from(mid);
            }
            if let Some(edim) = snap_meta.get("emb_dim").and_then(serde_json::Value::as_u64) {
                #[allow(clippy::cast_possible_truncation)]
                {
                    options.emb_dim = edim as usize;
                }
            }
            options.meta = snap_meta.clone();
        }

        let mut graph = Self::new(options)?;
        graph.nodes.clear();
        graph.edges.clear();
        graph.locks.clear();
        graph.dimension = None;
        graph.sequence = 0;
        graph.created_at = snapshot.created_at;
        graph.updated_at = snapshot.updated_at;
        graph.clock_ms = snapshot.updated_at.max(snapshot.created_at);

        for item in snapshot.nodes {
            if graph.nodes.contains_key(&item.id) {
                return Err(QuetzalcoatlError::SerializationError {
                    detail: format!("EWAVE_SNAPSHOT: 重复节点 ID {}", item.id),
                });
            }
            let validated_emb = match &item.embedding {
                Some(raw) => Some(graph.validate_and_lock_embedding(raw)?),
                None => None,
            };
            if let Some(seq) = parse_generated_seq(&item.id)
                && seq > graph.sequence
            {
                graph.sequence = seq;
            }

            let out_links = item.out_links.unwrap_or_default();
            let in_links = item.in_links.unwrap_or_default();
            let mut links = Vec::new();
            let mut push_unique = |lid: &NodeId| {
                if !links.iter().any(|x| x == lid) {
                    links.push(lid.clone());
                }
            };
            for lid in &item.links {
                push_unique(lid);
            }
            for lid in &out_links {
                push_unique(lid);
            }
            for lid in &in_links {
                push_unique(lid);
            }

            let time = item.time.unwrap_or_else(|| TemporalTag {
                at: item.created_at,
                end_at: None,
                slice_id: graph.options.default_slice_id.clone(),
                valid_from: item.created_at,
                invalid_at: None,
            });
            let is_valid = time.invalid_at.is_none();

            let node = GraphNode {
                id: item.id.clone(),
                kind: item.kind,
                data: item.data,
                text: item.text,
                label: item.label,
                embedding: validated_emb.clone(),
                centroid: None,
                count: usize::from(item.kind == NodeKind::Leaf && is_valid),
                member_count: if item.kind == NodeKind::Leaf && is_valid {
                    1.0
                } else {
                    0.0
                },
                ls: validated_emb,
                ss: 0.0,
                radius: 0.0,
                cusum: 0.0,
                parents: item.parents,
                primary_parent: item.primary_parent,
                children: item.children,
                links,
                out_links,
                in_links,
                time,
                created_at: item.created_at,
                updated_at: item.updated_at,
                meta: item.meta,
                drift_count: 0,
                drift_mean: 0.0,
                ph_sum: 0.0,
                ph_min: 0.0,
            };
            graph.nodes.insert(item.id, node);
        }

        let root_id = graph
            .nodes
            .values()
            .find(|n| n.kind == NodeKind::Root)
            .map(|n| n.id.clone())
            .ok_or_else(|| QuetzalcoatlError::SerializationError {
                detail: String::from("EWAVE_SNAPSHOT: 快照缺少 root 节点"),
            })?;
        graph.root_id = root_id;
        if let Some(dim) = graph.dimension {
            graph.options.emb_dim = dim;
        }

        // 恢复持久化的 SayIt 归档会话账本（若存在于 root.meta["qz_sayit_records"]）
        let raw_sayit_records = graph
            .nodes
            .get_mut(&graph.root_id)
            .and_then(|root| root.meta.remove("qz_sayit_records"));
        if let Some(val) = raw_sayit_records {
            let parsed_records: Vec<SayItSessionRecord> =
                serde_json::from_value(val).map_err(|e| QuetzalcoatlError::SerializationError {
                    detail: format!("EWAVE_SNAPSHOT: 解析 qz_sayit_records 失败: {e}"),
                })?;
            for rec in parsed_records {
                graph.sayit_records.insert(
                    (
                        rec.sayit_user_hash.clone(),
                        rec.slice_id.clone(),
                        rec.session_id.clone(),
                    ),
                    rec,
                );
            }
        }

        // 按确定性 UTF-16 序重建离线待重算向量队列 pending_reembed
        let mut pending_ids: Vec<NodeId> = graph
            .nodes
            .values()
            .filter(|n| {
                n.kind != NodeKind::Root
                    && n.meta.get("reembed_pending") == Some(&serde_json::Value::Bool(true))
            })
            .map(|n| n.id.clone())
            .collect();
        pending_ids.sort_by(|a, b| cmp_utf16(a, b));
        graph.pending_reembed = pending_ids;

        let mut hierarchy_meta: BTreeMap<String, EdgeSnapshot> = BTreeMap::new();
        let mut link_edges: Vec<EdgeSnapshot> = Vec::new();
        for edge in snapshot.edges {
            match edge.kind {
                EdgeKind::Hierarchy => {
                    hierarchy_meta.insert(format!("hierarchy:{}>{}", edge.from, edge.to), edge);
                }
                EdgeKind::Link => {
                    link_edges.push(edge);
                }
            }
        }

        let all_parent_children: Vec<(NodeId, Vec<NodeId>)> = graph
            .nodes
            .values()
            .map(|n| (n.id.clone(), n.children.clone()))
            .collect();
        for (nid, children) in all_parent_children {
            for cid in children {
                let child =
                    graph
                        .nodes
                        .get(&cid)
                        .ok_or_else(|| QuetzalcoatlError::SerializationError {
                            detail: format!("EWAVE_SNAPSHOT: 节点 {nid} 引用缺失子节点 {cid}"),
                        })?;
                if !child.parents.contains(&nid) {
                    return Err(QuetzalcoatlError::SerializationError {
                        detail: format!("EWAVE_SNAPSHOT: 子节点 {cid} 未记录父节点 {nid}"),
                    });
                }
                let key = format!("hierarchy:{nid}>{cid}");
                let emeta = hierarchy_meta.get(&key);
                graph.edges.insert(
                    key,
                    GraphEdge {
                        from: nid.clone(),
                        to: cid,
                        kind: EdgeKind::Hierarchy,
                        weight: emeta.map_or(1.0, |m| m.weight),
                        polarity: emeta
                            .and_then(|m| m.polarity)
                            .unwrap_or(LogicPolarity::Positive),
                        relation: emeta.and_then(|m| m.relation.clone()),
                        created_at: emeta.map_or(graph.created_at, |m| m.created_at),
                        meta: emeta.map_or_else(BTreeMap::new, |m| m.meta.clone()),
                    },
                );
            }
        }

        for le in link_edges {
            if !graph.nodes.contains_key(&le.from) || !graph.nodes.contains_key(&le.to) {
                return Err(QuetzalcoatlError::SerializationError {
                    detail: format!("EWAVE_SNAPSHOT: 逻辑边引用缺失节点 {}->{}", le.from, le.to),
                });
            }
            let edge = GraphEdge {
                from: le.from.clone(),
                to: le.to.clone(),
                kind: EdgeKind::Link,
                weight: le.weight,
                polarity: le.polarity.unwrap_or(LogicPolarity::Positive),
                relation: le.relation,
                created_at: le.created_at,
                meta: le.meta,
            };
            graph.edges.insert(edge.key(), edge);
            if let Some(f) = graph.nodes.get_mut(&le.from) {
                f.add_out_link(&le.to);
            }
            if let Some(t) = graph.nodes.get_mut(&le.to) {
                t.add_in_link(&le.from);
            }
        }

        // Backfill legacy v1 node-declared links
        let legacy_pairs: Vec<(NodeId, Vec<NodeId>, Vec<NodeId>)> = graph
            .nodes
            .values()
            .map(|n| (n.id.clone(), n.out_links.clone(), n.links.clone()))
            .collect();
        for (nid, out_links, sym_links) in legacy_pairs {
            for oid in out_links {
                if graph.nodes.contains_key(&oid) {
                    if let Some(t) = graph.nodes.get_mut(&oid) {
                        t.add_in_link(&nid);
                    }
                    let key = format!("link:{nid}>{oid}");
                    graph.edges.entry(key).or_insert_with(|| GraphEdge {
                        from: nid.clone(),
                        to: oid,
                        kind: EdgeKind::Link,
                        weight: 1.0,
                        polarity: LogicPolarity::Positive,
                        relation: None,
                        created_at: graph.created_at,
                        meta: BTreeMap::new(),
                    });
                }
            }
            for lid in sym_links {
                if !graph.nodes.contains_key(&lid) {
                    continue;
                }
                let fkey = format!("link:{nid}>{lid}");
                let rkey = format!("link:{lid}>{nid}");
                if !graph.edges.contains_key(&fkey) && !graph.edges.contains_key(&rkey) {
                    let (from_id, to_id) = if cmp_utf16(&nid, &lid) == Ordering::Less {
                        (nid.clone(), lid)
                    } else {
                        (lid, nid.clone())
                    };
                    let key = format!("link:{from_id}>{to_id}");
                    graph.edges.insert(
                        key,
                        GraphEdge {
                            from: from_id.clone(),
                            to: to_id.clone(),
                            kind: EdgeKind::Link,
                            weight: 1.0,
                            polarity: LogicPolarity::Positive,
                            relation: None,
                            created_at: graph.created_at,
                            meta: BTreeMap::new(),
                        },
                    );
                    if let Some(f) = graph.nodes.get_mut(&from_id) {
                        f.add_out_link(&to_id);
                    }
                    if let Some(t) = graph.nodes.get_mut(&to_id) {
                        t.add_in_link(&from_id);
                    }
                }
            }
        }

        for lock in snapshot.locks.unwrap_or_default() {
            if graph.nodes.contains_key(&lock.scope_root) {
                graph.locks.insert(lock.scope_root.clone(), lock);
            }
        }

        graph.rebuild()?;
        graph.verify_strict()?;
        Ok(graph)
    }

    /// 从 `EwaveSnapshot` 还原并严格校验不变量。
    pub fn from_snapshot(snapshot: EwaveSnapshot) -> Result<Self> {
        Self::from_snapshot_with_options(snapshot, GraphOptions::default())
    }

    /// 导出格式化的 JSON-v2 字符串。
    pub fn to_json_v2(&self) -> Result<String> {
        serde_json::to_string_pretty(&self.to_snapshot()).map_err(|e| {
            QuetzalcoatlError::SerializationError {
                detail: format!("序列化 EwaveSnapshot JSON-v2 失败: {e}"),
            }
        })
    }

    /// 从 `@plutokeating/ewave@0.2.0` JSON-v2 字符串解析并还原图实例。
    pub fn from_json_v2(json_str: &str) -> Result<Self> {
        let snap: EwaveSnapshot =
            serde_json::from_str(json_str).map_err(|e| QuetzalcoatlError::SerializationError {
                detail: format!("解析 EwaveSnapshot JSON-v2 失败: {e}"),
            })?;
        Self::from_snapshot(snap)
    }
}
