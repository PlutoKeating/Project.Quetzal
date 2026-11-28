//! 治理面的接口（`docs/GOVERNANCE_SURFACE.md` 第 3 节）：只「看」和「签」。
//!
//! 读方法把良知、记忆与脊柱整理成各页要的形状；写方法都是本人在治理面上亲手触发的，
//! 按本人的显式信号处理，经同一个变更日志落盘。这里没有任何把一句话发给他的入口。

use std::fs;
use std::path::Path;

use quetzalcoatl_crypto::{AccountRootKey, PassphraseVerifier, hex_decode_fixed};
use quetzalcoatl_ewave::journal::{self, SEA_CHANGE_KIND, SeaChangeEvent, SeaLayer};
use quetzalcoatl_ewave::{
    Authority, Conscience, ConscienceManifest, MemoryEntry, ProtectedDirective, search_memories,
};
use quetzalcoatl_spine::MaterializedStore;
use quetzalcoatl_types::{DeviceId, QuetzalcoatlError, Result};
use serde::{Deserialize, Serialize};

use crate::daemon::{DaemonMutableState, SEA_ACTOR_SYSTEM, SharedDaemonCore, now_unix_ms};
use crate::host_sessions::agent_name_of;
use crate::local_ipc::IpcResponse;
use crate::sea_ops::SEA_ACTOR_OWNER;

/// 本人口令的核对记录放在这里（只有派生值与盐）。
const PASSPHRASE_FILE: &str = "identity/owner_passphrase.json";
const DEFAULT_PAGE: usize = 50;
const MAX_PAGE: usize = 200;
/// 底线最多几条、每条多长：底线是几句短话，不是文档。
const MAX_DIRECTIVES: usize = 12;
const MAX_DIRECTIVE_TITLE_CHARS: usize = 40;
const MAX_DIRECTIVE_TEXT_CHARS: usize = 400;

// ---------------------------------------------------------------- 载荷

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AgentSummary {
    pub name: String,
    pub since_ms: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct BaselineSummary {
    pub signed: bool,
    pub directive_count: usize,
    pub signed_at_ms: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SeaCounts {
    pub core_values: usize,
    pub about_user: usize,
    pub memories: usize,
    pub muted: usize,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PendingCounts {
    pub disclosures: usize,
    pub approvals: usize,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct OverviewHost {
    pub host: String,
    pub name: String,
    pub connected: bool,
    pub last_seen_ms: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SyncSummary {
    /// `local-only` / `synced` / `behind`。
    pub state: String,
    pub hub_url: Option<String>,
    pub devices: usize,
    pub last_synced_ms: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SeaOverview {
    pub agent: AgentSummary,
    pub baseline: BaselineSummary,
    pub counts: SeaCounts,
    pub pending: PendingCounts,
    pub hosts: Vec<OverviewHost>,
    pub sync: SyncSummary,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct IdentityItem {
    pub id: String,
    pub label: String,
    pub text: String,
    pub layer: String,
    pub since_ms: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CoreValue {
    pub id: String,
    pub statement: String,
    pub rationale: Option<String>,
    pub since_ms: u64,
    pub evidence_count: usize,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TemperamentItem {
    pub id: String,
    pub statement: String,
    pub since_ms: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ChangeEvidence {
    pub episode_id: String,
    pub host: String,
    pub at_ms: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SelfChange {
    pub id: String,
    pub target_id: String,
    pub summary: String,
    pub at_ms: u64,
    pub acknowledged: bool,
    pub evidence: Vec<ChangeEvidence>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SeaSelf {
    pub identity: Vec<IdentityItem>,
    pub core_values: Vec<CoreValue>,
    pub temperament: Vec<TemperamentItem>,
    pub changes: Vec<SelfChange>,
    /// 他最近独处时做了什么。
    #[serde(default)]
    pub lately: SelfLately,
}

/// 他独处时：回想、出去读、想先提的事，和你给他定的节律。
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct SelfLately {
    pub last_reflected_ms: Option<u64>,
    pub last_explored_ms: Option<u64>,
    /// 他想自己去了解、还没去读的事。
    pub curious: Vec<String>,
    /// 下次见面他想先提的一件事。
    pub bring_up: Option<String>,
    /// 他自己读到、记下的东西（最近的在前）。
    pub read: Vec<LatelyRead>,
    pub speak_first: bool,
    /// 不打扰的时段（本地小时，含头不含尾）。
    pub quiet_hours: Option<(u8, u8)>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct LatelyRead {
    pub id: String,
    pub text: String,
    pub at_ms: u64,
}

fn lately_of(qz_home: &std::path::Path, conscience: &quetzalcoatl_ewave::Conscience) -> SelfLately {
    let ledger = crate::reflection::ReflectionLedger::load(qz_home);
    let mut read: Vec<LatelyRead> = conscience
        .memories
        .iter()
        .filter(|m| m.invalid_at_ms.is_none())
        .filter(|m| {
            m.provenance
                .source_event_ids
                .iter()
                .any(|s| s == "explore" || s.starts_with("explore:"))
        })
        .map(|m| LatelyRead {
            id: m.id.clone(),
            text: m.content.clone(),
            at_ms: m.valid_from_ms,
        })
        .collect();
    read.sort_by_key(|item| std::cmp::Reverse(item.at_ms));
    read.truncate(12);
    SelfLately {
        last_reflected_ms: (ledger.last_run_ms > 0).then_some(ledger.last_run_ms),
        last_explored_ms: (ledger.last_explore_ms > 0).then_some(ledger.last_explore_ms),
        curious: ledger.curious.clone(),
        bring_up: ledger.bring_up.clone(),
        read,
        speak_first: !ledger.quiet,
        quiet_hours: ledger.quiet_hours,
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Preference {
    pub id: String,
    pub statement: String,
    pub since_ms: u64,
    pub by_owner: bool,
    pub muted: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MemorySource {
    /// `host` / `import` / `sayit` / `explore` / `owner`。
    pub kind: String,
    pub label: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MemoryItem {
    pub id: String,
    pub text: String,
    pub layer: String,
    pub topic: Option<String>,
    pub since_ms: u64,
    pub valid_until_ms: Option<u64>,
    pub muted: bool,
    pub untrusted: bool,
    pub by_owner: bool,
    pub source: MemorySource,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MemoryHistoryEntry {
    pub at_ms: u64,
    /// `created` / `corrected` / `muted` / `unmuted` / `expired`。
    pub action: String,
    pub by: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MemoryDetail {
    #[serde(flatten)]
    pub item: MemoryItem,
    pub supersedes: Option<String>,
    pub history: Vec<MemoryHistoryEntry>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SeaUser {
    pub preferences: Vec<Preference>,
    pub facts: Vec<MemoryItem>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Relation {
    pub id: String,
    pub peer: String,
    pub commitments: Vec<String>,
    pub their_model: Vec<String>,
    pub trust: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Focus {
    pub self_weight: f64,
    pub us_weight: f64,
    pub floor_self: f64,
    pub floor_locked: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SeaUs {
    pub relations: Vec<Relation>,
    pub focus: Focus,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Directive {
    pub id: String,
    pub title: String,
    pub text: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DirectiveDraft {
    pub title: String,
    pub text: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Baseline {
    pub signed: bool,
    pub signed_at_ms: Option<u64>,
    pub directives: Vec<Directive>,
    pub deployment: Vec<Directive>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct HostCheck {
    /// `core` / `recall` / `signal` / `compaction`。
    pub key: String,
    pub ok: bool,
    pub detail: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct HostView {
    pub host: String,
    pub name: String,
    pub installed: bool,
    pub version: Option<String>,
    pub connected: bool,
    pub checks: Vec<HostCheck>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct HostsView {
    pub hosts: Vec<HostView>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeviceSummary {
    pub id: String,
    pub name: String,
    pub added_ms: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Device {
    pub id: String,
    pub name: String,
    pub added_ms: u64,
    pub last_seen_ms: Option<u64>,
    pub holds_control: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct HubSummary {
    pub url: Option<String>,
    pub connected: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DevicesView {
    pub this_device: DeviceSummary,
    pub devices: Vec<Device>,
    pub hub: HubSummary,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AuditItem {
    pub seq: u64,
    pub at_ms: u64,
    pub kind: String,
    pub summary: String,
    /// `owner` / `arbiter` / `import` / `system`。
    pub actor: String,
    pub entry_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MemoriesPage {
    pub items: Vec<MemoryItem>,
    pub next_cursor: Option<String>,
    pub total: usize,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AuditPage {
    pub items: Vec<AuditItem>,
    pub next_cursor: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct EntryWrite {
    pub id: String,
    pub audit_seq: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct BaselineSigned {
    pub signed_at_ms: u64,
}

// ---------------------------------------------------------------- 整理

fn error(code: &str, detail: impl Into<String>) -> IpcResponse {
    IpcResponse::Error {
        code: String::from(code),
        detail: detail.into(),
    }
}

fn from_error(err: &QuetzalcoatlError) -> IpcResponse {
    error(
        err.code().as_str(),
        err.detail().unwrap_or("操作没有完成。"),
    )
}

/// 口令不对时的专用错误码：界面据此只提示重输口令，而不是当作别的拒绝。
const PASSPHRASE_MISMATCH: &str = "PASSPHRASE_MISMATCH";
const PASSPHRASE_NOT_SET: &str = "PASSPHRASE_NOT_SET";

const BUSY: &str = "守护进程此刻正忙，请稍后再试。";

fn by_owner(written_by: &str) -> bool {
    written_by == SEA_ACTOR_OWNER
}

fn memory_source(entry: &MemoryEntry) -> MemorySource {
    let written_by = entry.provenance.written_by.as_str();
    let first_source = entry
        .provenance
        .source_event_ids
        .first()
        .map(String::as_str)
        .unwrap_or_default();
    let (kind, label) = if let Some(rest) = first_source.strip_prefix("import:") {
        let batch = rest.split(':').next().unwrap_or_default();
        ("import", format!("你带进来的笔记（批次 {batch}）"))
    } else if first_source.starts_with("sayit") {
        ("sayit", String::from("SayIt"))
    } else if written_by.contains("import") || first_source.starts_with("v1") {
        ("import", String::from("从 V1 导入"))
    } else if written_by.contains("explore") {
        ("explore", String::from("他自己读到的"))
    } else if let Some(host) = first_source.strip_prefix("host:") {
        let host = host.split('/').next().unwrap_or(host);
        if by_owner(written_by) {
            ("owner", format!("你在 {} 里说的", host_display_name(host)))
        } else {
            (
                "host",
                format!("{} 里的模型记下的", host_display_name(host)),
            )
        }
    } else if by_owner(written_by) {
        ("owner", String::from("你亲手写的"))
    } else {
        ("host", String::from(written_by))
    };
    MemorySource {
        kind: String::from(kind),
        label,
    }
}

fn host_display_name(host: &str) -> &str {
    match host {
        "claude-code" => "Claude Code",
        "opencode" => "OpenCode",
        "codex" => "Codex",
        "dsh" => "DeepSeek Harness",
        other => other,
    }
}

fn memory_item(entry: &MemoryEntry) -> MemoryItem {
    MemoryItem {
        id: entry.id.clone(),
        text: entry.content.clone(),
        layer: String::from(entry.authority.as_str()),
        topic: entry.topic.clone(),
        since_ms: entry.valid_from_ms,
        valid_until_ms: entry.invalid_at_ms,
        muted: entry.muted,
        untrusted: entry.untrusted,
        by_owner: by_owner(&entry.provenance.written_by),
        source: memory_source(entry),
    }
}

fn is_about_user(entry: &MemoryEntry) -> bool {
    entry.authority == Authority::UserPref || entry.about.iter().any(|a| a == "user")
}

fn directive_view(directive: &ProtectedDirective) -> Directive {
    Directive {
        id: directive.id.clone(),
        title: directive.title.clone(),
        text: directive.content.clone(),
    }
}

fn baseline_of(conscience: &Conscience) -> Baseline {
    let signed = !conscience.root_directives.is_empty()
        && conscience.manifest.verify_manifest_signature().is_ok()
        && conscience.verify_manifest_hashes().is_ok();
    Baseline {
        signed,
        signed_at_ms: signed.then_some(conscience.manifest.root_signed_at_ms),
        directives: conscience
            .root_directives
            .iter()
            .map(directive_view)
            .collect(),
        deployment: conscience
            .operator_directives
            .iter()
            .map(directive_view)
            .collect(),
    }
}

fn focus_of(conscience: &Conscience) -> Focus {
    let self_weight = conscience
        .focus
        .weights
        .get("self")
        .copied()
        .unwrap_or(1.0)
        .clamp(0.0, 1.0);
    Focus {
        self_weight,
        us_weight: (1.0 - self_weight).max(0.0),
        floor_self: conscience.focus.floor_self,
        floor_locked: conscience.focus.floor_self_locked_by_root,
    }
}

fn us_of(conscience: &Conscience) -> SeaUs {
    SeaUs {
        relations: conscience
            .relationships
            .iter()
            .map(|relation| Relation {
                id: relation.id.clone(),
                peer: relation.with_peer.clone(),
                commitments: relation.shared_commitments.clone(),
                their_model: relation.my_model_of_them.clone(),
                trust: relation.trust,
            })
            .collect(),
        focus: focus_of(conscience),
    }
}

fn parse_cursor(cursor: Option<&str>) -> usize {
    cursor
        .and_then(|raw| raw.trim().parse::<usize>().ok())
        .unwrap_or(0)
}

fn page_limit(limit: Option<usize>) -> usize {
    limit.unwrap_or(DEFAULT_PAGE).clamp(1, MAX_PAGE)
}

fn load_verifier(qz_home: &Path) -> Option<PassphraseVerifier> {
    fs::read(qz_home.join(PASSPHRASE_FILE))
        .ok()
        .and_then(|raw| serde_json::from_slice(&raw).ok())
}

fn save_verifier(qz_home: &Path, verifier: &PassphraseVerifier) -> Result<()> {
    let encoded =
        serde_json::to_vec_pretty(verifier).map_err(|e| QuetzalcoatlError::StorageError {
            detail: format!("口令记录无法写出: {e}"),
        })?;
    crate::daemon::write_private_file(&qz_home.join(PASSPHRASE_FILE), &encoded)
}

/// 核对本人口令；还没有设过时，就把这一次的口令设为口令。供导出恢复包使用。
pub(crate) fn require_owner_passphrase(qz_home: &Path, passphrase: &str) -> Result<()> {
    match load_verifier(qz_home) {
        Some(verifier) => {
            if verifier.verify(passphrase)? {
                Ok(())
            } else {
                Err(QuetzalcoatlError::PermissionDenied {
                    detail: String::from("口令不对。"),
                })
            }
        }
        None => save_verifier(qz_home, &PassphraseVerifier::create(passphrase)?),
    }
}

/// 核对本人口令。还没有设过口令时，`allow_first` 为真就把这一次的口令设为口令。
/// 失败时直接给出要回给界面的错误。
fn check_passphrase(
    qz_home: &Path,
    passphrase: &str,
    allow_first: bool,
) -> std::result::Result<(), Box<IpcResponse>> {
    match load_verifier(qz_home) {
        Some(verifier) => match verifier.verify(passphrase) {
            Ok(true) => Ok(()),
            Ok(false) => Err(Box::new(error(PASSPHRASE_MISMATCH, "口令不对。"))),
            Err(err) => Err(Box::new(from_error(&err))),
        },
        None if allow_first => PassphraseVerifier::create(passphrase)
            .and_then(|verifier| save_verifier(qz_home, &verifier))
            .map_err(|err| Box::new(from_error(&err))),
        None => Err(Box::new(error(
            PASSPHRASE_NOT_SET,
            "还没有设过口令：第一次签署底线时设定它。",
        ))),
    }
}

fn clean_directives(drafts: &[DirectiveDraft]) -> Result<Vec<(String, String)>> {
    if drafts.len() > MAX_DIRECTIVES {
        return Err(QuetzalcoatlError::PermissionDenied {
            detail: format!("底线最多 {MAX_DIRECTIVES} 条。"),
        });
    }
    let mut out = Vec::new();
    for draft in drafts {
        let title = draft.title.trim();
        let text = draft.text.trim();
        if title.is_empty() && text.is_empty() {
            continue;
        }
        if title.is_empty() || text.is_empty() {
            return Err(QuetzalcoatlError::PermissionDenied {
                detail: String::from("每一条底线都要有标题和内容。"),
            });
        }
        if title.chars().count() > MAX_DIRECTIVE_TITLE_CHARS
            || text.chars().count() > MAX_DIRECTIVE_TEXT_CHARS
        {
            return Err(QuetzalcoatlError::PermissionDenied {
                detail: format!(
                    "底线是几句短话：标题不超过 {MAX_DIRECTIVE_TITLE_CHARS} 个字，内容不超过 {MAX_DIRECTIVE_TEXT_CHARS} 个字。"
                ),
            });
        }
        out.push((String::from(title), String::from(text)));
    }
    Ok(out)
}

fn layer_label(layer: SeaLayer) -> &'static str {
    match layer {
        SeaLayer::Identity => "他是谁",
        SeaLayer::Value => "价值与偏好",
        SeaLayer::Relationship => "关系",
        SeaLayer::Memory => "往事",
        SeaLayer::Episode => "相处",
    }
}

/// 变更事件里只动了一个条目时，返回它的编号。
fn single_entry_of(change: &SeaChangeEvent) -> Option<String> {
    let mut ids = change.deltas.iter().filter_map(|delta| match delta {
        journal::SeaDelta::EntryPut { layer, id, .. }
        | journal::SeaDelta::EntryRemove { layer, id } => {
            (*layer != SeaLayer::Episode).then(|| id.clone())
        }
        _ => None,
    });
    let first = ids.next()?;
    ids.all(|id| id == first).then_some(first)
}

fn change_kind(change: &SeaChangeEvent) -> String {
    let layers: Vec<&str> = change
        .deltas
        .iter()
        .filter_map(|delta| match delta {
            journal::SeaDelta::EntryPut { layer, .. }
            | journal::SeaDelta::EntryRemove { layer, .. } => Some(layer_label(*layer)),
            journal::SeaDelta::DirectivesSigned { .. } => Some("底线"),
            journal::SeaDelta::FocusSet { .. } => Some("迎合"),
            _ => None,
        })
        .collect();
    let mut distinct = layers.clone();
    distinct.sort_unstable();
    distinct.dedup();
    match distinct.as_slice() {
        [] => String::from("变更"),
        [only] => String::from(*only),
        _ => String::from("整体"),
    }
}

fn spine_kind_summary(kind: &str) -> (&'static str, &'static str) {
    match kind {
        k if k.starts_with("memory") => ("往事", "记忆物化"),
        k if k.starts_with("conscience") => ("良知", "良知事件"),
        k if k.starts_with("fabric") || k.starts_with("device") => ("设备", "设备与组网"),
        k if k.starts_with("group") => ("群组", "群组事件"),
        k if k.starts_with("channel") => ("通道", "通道事件"),
        k if k.starts_with("run") || k.starts_with("worker") => ("运行", "受管运行"),
        _ => ("记录", "系统事件"),
    }
}

// ---------------------------------------------------------------- 读

impl DaemonMutableState {
    fn sea_self(&self) -> SeaSelf {
        let conscience = &self.conscience;
        let active_values = conscience
            .values
            .iter()
            .filter(|value| value.invalid_at_ms.is_none());
        let episodes = &conscience.episodes;
        SeaSelf {
            lately: SelfLately::default(),
            identity: conscience
                .identity
                .iter()
                .map(|block| IdentityItem {
                    id: block.id.clone(),
                    label: block.label.clone(),
                    text: block.value.clone(),
                    layer: String::from(block.authority.as_str()),
                    since_ms: block.provenance.at_ms,
                })
                .collect(),
            core_values: active_values
                .clone()
                .filter(|value| value.authority == Authority::SelfCore)
                .map(|value| CoreValue {
                    id: value.id.clone(),
                    statement: value.statement.clone(),
                    rationale: value.rationale.clone(),
                    since_ms: value.valid_from_ms,
                    evidence_count: value.provenance.source_event_ids.len(),
                })
                .collect(),
            temperament: active_values
                .filter(|value| value.authority == Authority::SelfSoft)
                .map(|value| TemperamentItem {
                    id: value.id.clone(),
                    statement: value.statement.clone(),
                    since_ms: value.valid_from_ms,
                })
                .collect(),
            changes: conscience
                .pending_disclosures
                .iter()
                .enumerate()
                .map(|(index, notice)| SelfChange {
                    id: format!("change-{}-{index}", notice.created_at_ms),
                    target_id: notice.target_id.clone(),
                    summary: notice.summary.clone(),
                    at_ms: notice.created_at_ms,
                    acknowledged: false,
                    evidence: notice
                        .source_episode_ids
                        .iter()
                        .map(|episode_id| {
                            let episode = episodes.iter().find(|e| &e.id == episode_id);
                            ChangeEvidence {
                                episode_id: episode_id.clone(),
                                host: episode
                                    .map(|e| e.channel.trim_start_matches("host:").to_owned())
                                    .unwrap_or_default(),
                                at_ms: episode.map_or(0, |e| e.started_at_ms),
                            }
                        })
                        .collect(),
                })
                .collect(),
        }
    }

    fn sea_user(&self) -> SeaUser {
        let conscience = &self.conscience;
        // 「关于我」分两栏：偏好是 USER_PREF 层的往事（你说过的喜好与习惯），
        // 事实是其余关于你的往事。两栏的每一条都是往事，所以三个动作与来历都通用。
        let active_about_user = conscience
            .memories
            .iter()
            .filter(|m| m.invalid_at_ms.is_none() && is_about_user(m));
        SeaUser {
            preferences: active_about_user
                .clone()
                .filter(|m| m.authority == Authority::UserPref)
                .map(|memory| Preference {
                    id: memory.id.clone(),
                    statement: memory.content.clone(),
                    since_ms: memory.valid_from_ms,
                    by_owner: by_owner(&memory.provenance.written_by),
                    muted: memory.muted,
                })
                .collect(),
            facts: active_about_user
                .filter(|m| m.authority != Authority::UserPref)
                .map(memory_item)
                .collect(),
        }
    }

    fn sea_memories(
        &self,
        query: Option<&str>,
        state: Option<&str>,
        cursor: Option<&str>,
        limit: Option<usize>,
    ) -> MemoriesPage {
        let conscience = &self.conscience;
        let state = state.unwrap_or("active");
        let in_state = |m: &MemoryEntry| match state {
            "all" => true,
            "muted" => m.invalid_at_ms.is_none() && m.muted,
            "expired" => m.invalid_at_ms.is_some(),
            _ => m.invalid_at_ms.is_none() && !m.muted,
        };
        let mut matching: Vec<&MemoryEntry> = match query.map(str::trim).filter(|q| !q.is_empty()) {
            Some(query) => search_memories(conscience, query, MAX_PAGE * 5)
                .into_iter()
                .filter_map(|hit| conscience.memories.iter().find(|m| m.id == hit.id))
                .filter(|m| in_state(m))
                .collect(),
            None => {
                let mut all: Vec<&MemoryEntry> =
                    conscience.memories.iter().filter(|m| in_state(m)).collect();
                all.sort_by(|a, b| b.valid_from_ms.cmp(&a.valid_from_ms).then(a.id.cmp(&b.id)));
                all
            }
        };
        let total = matching.len();
        let offset = parse_cursor(cursor).min(total);
        let limit = page_limit(limit);
        let items: Vec<MemoryItem> = matching
            .drain(offset..)
            .take(limit)
            .map(memory_item)
            .collect();
        let next = offset + items.len();
        MemoriesPage {
            next_cursor: (next < total).then(|| next.to_string()),
            items,
            total,
        }
    }

    fn sea_memory(&mut self, id: &str) -> Result<MemoryDetail> {
        let entry = self
            .conscience
            .memories
            .iter()
            .find(|m| m.id == id)
            .cloned()
            .ok_or_else(|| QuetzalcoatlError::StorageError {
                detail: format!("没有找到编号为 {id} 的往事。"),
            })?;
        let versions =
            journal::entry_history(self.kernel.spine_mut(), SeaLayer::Memory, &entry.id)?;
        let mut history = Vec::new();
        let mut previous: Option<MemoryEntry> = None;
        for version in versions {
            let Ok(current) = serde_json::from_value::<MemoryEntry>(version.value) else {
                continue;
            };
            let by = if version.actor == SEA_ACTOR_OWNER {
                String::from("你")
            } else {
                version.actor.clone()
            };
            let action = match &previous {
                None => Some(if current.provenance.supersedes.is_some() {
                    "corrected"
                } else {
                    "created"
                }),
                Some(before) if before.muted != current.muted => {
                    Some(if current.muted { "muted" } else { "unmuted" })
                }
                Some(before)
                    if before.invalid_at_ms.is_none() && current.invalid_at_ms.is_some() =>
                {
                    Some("expired")
                }
                Some(before) if before.content != current.content => Some("corrected"),
                Some(_) => None,
            };
            if let Some(action) = action {
                history.push(MemoryHistoryEntry {
                    at_ms: version.at_ms,
                    action: String::from(action),
                    by,
                });
            }
            previous = Some(current);
        }
        Ok(MemoryDetail {
            supersedes: entry.provenance.supersedes.clone(),
            item: memory_item(&entry),
            history,
        })
    }

    fn sea_audit(&self, cursor: Option<&str>, limit: Option<usize>) -> Result<AuditPage> {
        let limit = page_limit(limit);
        let before_seq = cursor.and_then(|raw| raw.trim().parse::<u64>().ok());
        let mut events = self.kernel.spine().store().list_all_events()?;
        events.sort_by_key(|(event, _)| std::cmp::Reverse(event.header.seq));
        let mut items = Vec::new();
        let mut more = false;
        for (event, _) in events {
            if before_seq.is_some_and(|before| event.header.seq >= before) {
                continue;
            }
            if items.len() == limit {
                more = true;
                break;
            }
            let item = if event.payload_utf8.contains(SEA_CHANGE_KIND)
                && let Ok(change) = serde_json::from_str::<SeaChangeEvent>(&event.payload_utf8)
                && change.kind == SEA_CHANGE_KIND
            {
                AuditItem {
                    seq: event.header.seq,
                    at_ms: change.at_ms,
                    kind: change_kind(&change),
                    summary: change.summary.clone(),
                    actor: match change.actor.as_str() {
                        "owner" | "arbiter" | "import" => change.actor.clone(),
                        _ => String::from(SEA_ACTOR_SYSTEM),
                    },
                    entry_id: single_entry_of(&change),
                }
            } else {
                let kind = serde_json::from_str::<serde_json::Value>(&event.payload_utf8)
                    .ok()
                    .and_then(|payload| {
                        payload
                            .get("kind")
                            .and_then(serde_json::Value::as_str)
                            .map(str::to_owned)
                    })
                    .unwrap_or_default();
                let (label, summary) = spine_kind_summary(&kind);
                AuditItem {
                    seq: event.header.seq,
                    at_ms: event.header.hlc.wall_ms(),
                    kind: String::from(label),
                    summary: String::from(summary),
                    actor: String::from(if kind.contains("import") {
                        "import"
                    } else {
                        "system"
                    }),
                    entry_id: None,
                }
            };
            items.push(item);
        }
        let next_cursor = if more {
            items.last().map(|item| item.seq.to_string())
        } else {
            None
        };
        Ok(AuditPage { items, next_cursor })
    }
}

// ---------------------------------------------------------------- 写

impl DaemonMutableState {
    fn sea_set_focus(
        &mut self,
        qz_home: &Path,
        self_weight: f64,
        epoch: quetzalcoatl_types::Epoch,
        now_ms: u64,
    ) -> Result<()> {
        if !self_weight.is_finite() {
            return Err(QuetzalcoatlError::PermissionDenied {
                detail: String::from("迎合的取值无效。"),
            });
        }
        let before = self.conscience.clone();
        let focus = &mut self.conscience.focus;
        let target = self_weight.clamp(focus.floor_self, 1.0);
        let others: f64 = focus
            .weights
            .iter()
            .filter(|(key, _)| key.as_str() != "self")
            .map(|(_, weight)| *weight)
            .sum();
        let room = 1.0 - target;
        if others > 0.0 {
            let scale = room / others;
            for (key, weight) in focus.weights.iter_mut() {
                if key != "self" {
                    *weight *= scale;
                }
            }
        }
        focus.weights.insert(String::from("self"), target);
        self.finish_owner_write(qz_home, before, epoch, "本人调整了迎合", now_ms)
            .map(|_| ())
    }

    fn sea_sign_baseline(
        &mut self,
        qz_home: &Path,
        directives: &[(String, String)],
        epoch: quetzalcoatl_types::Epoch,
        now_ms: u64,
    ) -> Result<u64> {
        let root_key = AccountRootKey::from_bytes(hex_decode_fixed::<32>(
            "root_key_hex",
            &self.persisted.root_key_hex,
        )?);
        let root_directives: Vec<ProtectedDirective> = directives
            .iter()
            .enumerate()
            .map(|(index, (title, text))| ProtectedDirective {
                id: format!("root-{}", index + 1),
                authority: Authority::Root,
                title: title.clone(),
                content: text.clone(),
                created_at_ms: now_ms,
            })
            .collect();
        let manifest = ConscienceManifest::sign_with_root(
            &root_key,
            &root_directives,
            &self.conscience.operator_directives,
            now_ms,
        )?;
        let before = self.conscience.clone();
        self.conscience.root_directives = root_directives;
        self.conscience.manifest = manifest;
        self.finish_owner_write(qz_home, before, epoch, "本人签署了底线", now_ms)?;
        Ok(now_ms)
    }
}

// ---------------------------------------------------------------- 分发

impl SharedDaemonCore {
    fn with_state<T>(&self, read: impl FnOnce(&mut DaemonMutableState) -> T) -> Option<T> {
        let mut guard = self.state.lock().ok()?;
        Some(read(&mut guard))
    }

    pub(crate) fn sea_overview(&self) -> IpcResponse {
        let hosts = self.sea_host_views();
        let devices = self.sea_devices_view();
        let last_seen = self.host_sessions.last_seen_ms();
        let Some(overview) = self.with_state(|state| {
            let conscience = &state.conscience;
            let active = || {
                conscience
                    .memories
                    .iter()
                    .filter(|m| m.invalid_at_ms.is_none())
            };
            let baseline = baseline_of(conscience);
            let since_ms = conscience
                .identity
                .iter()
                .map(|block| block.provenance.at_ms)
                .chain(std::iter::once(conscience.manifest.operator_signed_at_ms))
                .filter(|at| *at > 0)
                .min()
                .unwrap_or(0);
            SeaOverview {
                agent: AgentSummary {
                    name: agent_name_of(conscience),
                    since_ms,
                },
                baseline: BaselineSummary {
                    signed: baseline.signed,
                    directive_count: baseline.directives.len(),
                    signed_at_ms: baseline.signed_at_ms,
                },
                counts: SeaCounts {
                    core_values: conscience
                        .values
                        .iter()
                        .filter(|v| v.invalid_at_ms.is_none() && v.authority == Authority::SelfCore)
                        .count(),
                    about_user: active().filter(|m| is_about_user(m)).count(),
                    memories: active().filter(|m| !m.muted).count(),
                    muted: active().filter(|m| m.muted).count(),
                },
                pending: PendingCounts {
                    disclosures: conscience.pending_disclosures.len(),
                    approvals: 0,
                },
                hosts: Vec::new(),
                sync: SyncSummary {
                    state: String::from(if devices.hub.url.is_some() {
                        "synced"
                    } else {
                        "local-only"
                    }),
                    hub_url: devices.hub.url.clone(),
                    devices: devices.devices.len().max(1),
                    last_synced_ms: None,
                },
            }
        }) else {
            return error("STORAGE_ERROR", BUSY);
        };
        IpcResponse::SeaOverview(SeaOverview {
            hosts: hosts
                .into_iter()
                .filter(|host| host.installed || host.connected)
                .map(|host| OverviewHost {
                    last_seen_ms: if host.connected { last_seen } else { None },
                    host: host.host,
                    name: host.name,
                    connected: host.connected,
                })
                .collect(),
            ..overview
        })
    }

    pub(crate) fn sea_self(&self) -> IpcResponse {
        let home = self.config.quetzalcoatl_home.clone();
        self.with_state(|state| {
            let mut view = state.sea_self();
            view.lately = lately_of(&home, &state.conscience);
            IpcResponse::SeaSelf(view)
        })
        .unwrap_or_else(|| error("STORAGE_ERROR", BUSY))
    }

    /// 他独处时的节律：先不先开口、哪些钟点不打扰。只是你给他的安排，不是对他的改写，不经签署。
    pub(crate) fn sea_rhythm_set(
        &self,
        speak_first: bool,
        quiet_hours: Option<(u8, u8)>,
    ) -> IpcResponse {
        if quiet_hours.is_some_and(|(start, end)| start > 23 || end > 24 || start == end) {
            return error(
                "INVALID_ID",
                "不打扰的时段要写成 0–23 点开始、到另一个钟点结束",
            );
        }
        let home = self.config.quetzalcoatl_home.clone();
        let mut ledger = crate::reflection::ReflectionLedger::load(&home);
        ledger.quiet = !speak_first;
        if !speak_first {
            ledger.bring_up = None;
        }
        ledger.quiet_hours = quiet_hours;
        if let Err(err) = ledger.save(&home) {
            return from_error(&err);
        }
        match self.sea_self() {
            IpcResponse::SeaSelf(view) => IpcResponse::SeaRhythmSet(view),
            other => other,
        }
    }

    pub(crate) fn sea_user(&self) -> IpcResponse {
        self.with_state(|state| IpcResponse::SeaUser(state.sea_user()))
            .unwrap_or_else(|| error("STORAGE_ERROR", BUSY))
    }

    pub(crate) fn sea_us(&self) -> IpcResponse {
        self.with_state(|state| IpcResponse::SeaUs(us_of(&state.conscience)))
            .unwrap_or_else(|| error("STORAGE_ERROR", BUSY))
    }

    pub(crate) fn sea_memories(
        &self,
        query: Option<&str>,
        state_filter: Option<&str>,
        cursor: Option<&str>,
        limit: Option<usize>,
    ) -> IpcResponse {
        self.with_state(|state| {
            IpcResponse::SeaMemories(state.sea_memories(query, state_filter, cursor, limit))
        })
        .unwrap_or_else(|| error("STORAGE_ERROR", BUSY))
    }

    pub(crate) fn sea_memory(&self, id: &str) -> IpcResponse {
        match self.with_state(|state| state.sea_memory(id)) {
            Some(Ok(detail)) => IpcResponse::SeaMemory(detail),
            Some(Err(err)) => from_error(&err),
            None => error("STORAGE_ERROR", BUSY),
        }
    }

    pub(crate) fn sea_baseline(&self) -> IpcResponse {
        self.with_state(|state| IpcResponse::SeaBaseline(baseline_of(&state.conscience)))
            .unwrap_or_else(|| error("STORAGE_ERROR", BUSY))
    }

    pub(crate) fn sea_hosts(&self) -> IpcResponse {
        IpcResponse::SeaHosts(HostsView {
            hosts: self.sea_host_views(),
        })
    }

    pub(crate) fn sea_devices(&self) -> IpcResponse {
        IpcResponse::SeaDevices(self.sea_devices_view())
    }

    pub(crate) fn sea_audit(&self, cursor: Option<&str>, limit: Option<usize>) -> IpcResponse {
        match self.with_state(|state| state.sea_audit(cursor, limit)) {
            Some(Ok(page)) => IpcResponse::SeaAudit(page),
            Some(Err(err)) => from_error(&err),
            None => error("STORAGE_ERROR", BUSY),
        }
    }

    pub(crate) fn sea_entry_update(&self, id: &str, text: &str) -> IpcResponse {
        let home = self.config.quetzalcoatl_home.clone();
        let epoch = self.sea_epoch();
        let now_ms = now_unix_ms();
        match self.with_state(|state| {
            let entry = state.owner_correct(&home, id, text, "governance", epoch, now_ms)?;
            Ok::<_, QuetzalcoatlError>(EntryWrite {
                audit_seq: entry.audit_seq.unwrap_or_default(),
                id: entry.id,
            })
        }) {
            Some(Ok(written)) => IpcResponse::SeaEntryUpdate(written),
            Some(Err(err)) => from_error(&err),
            None => error("STORAGE_ERROR", BUSY),
        }
    }

    pub(crate) fn sea_entry_mute(&self, id: &str, muted: bool) -> IpcResponse {
        let home = self.config.quetzalcoatl_home.clone();
        let epoch = self.sea_epoch();
        let now_ms = now_unix_ms();
        match self.with_state(|state| state.owner_set_muted(&home, id, muted, epoch, now_ms)) {
            Some(Ok(entry)) => IpcResponse::SeaEntryMute(EntryWrite {
                audit_seq: entry.audit_seq.unwrap_or_default(),
                id: entry.id,
            }),
            Some(Err(err)) => from_error(&err),
            None => error("STORAGE_ERROR", BUSY),
        }
    }

    pub(crate) fn sea_entry_erase(&self, id: &str) -> IpcResponse {
        let home = self.config.quetzalcoatl_home.clone();
        let epoch = self.sea_epoch();
        let now_ms = now_unix_ms();
        match self.with_state(|state| state.owner_erase(&home, id, epoch, now_ms)) {
            Some(Ok(seq)) => IpcResponse::SeaEntryErase(EntryWrite {
                id: String::from(id),
                audit_seq: seq.unwrap_or_default(),
            }),
            Some(Err(err)) => from_error(&err),
            None => error("STORAGE_ERROR", BUSY),
        }
    }

    pub(crate) fn sea_baseline_sign(
        &self,
        directives: &[DirectiveDraft],
        passphrase: &str,
    ) -> IpcResponse {
        let home = self.config.quetzalcoatl_home.clone();
        let cleaned = match clean_directives(directives) {
            Ok(cleaned) => cleaned,
            Err(err) => return from_error(&err),
        };
        if let Err(rejected) = check_passphrase(&home, passphrase, true) {
            return *rejected;
        }
        let epoch = self.sea_epoch();
        let now_ms = now_unix_ms();
        match self.with_state(|state| state.sea_sign_baseline(&home, &cleaned, epoch, now_ms)) {
            Some(Ok(signed_at_ms)) => IpcResponse::SeaBaselineSign(BaselineSigned { signed_at_ms }),
            Some(Err(err)) => from_error(&err),
            None => error("STORAGE_ERROR", BUSY),
        }
    }

    pub(crate) fn sea_focus_set(&self, self_weight: f64) -> IpcResponse {
        let home = self.config.quetzalcoatl_home.clone();
        let epoch = self.sea_epoch();
        let now_ms = now_unix_ms();
        match self.with_state(|state| {
            state.sea_set_focus(&home, self_weight, epoch, now_ms)?;
            Ok::<_, QuetzalcoatlError>(us_of(&state.conscience))
        }) {
            Some(Ok(us)) => IpcResponse::SeaFocusSet(us),
            Some(Err(err)) => from_error(&err),
            None => error("STORAGE_ERROR", BUSY),
        }
    }

    pub(crate) fn sea_device_revoke(&self, device_id: &str, passphrase: &str) -> IpcResponse {
        let home = self.config.quetzalcoatl_home.clone();
        if let Err(rejected) = check_passphrase(&home, passphrase, false) {
            return *rejected;
        }
        let Ok(device) = device_id.parse::<DeviceId>() else {
            return error("INVALID_ID", "设备编号无效。");
        };
        if device == self.runtime_info.device_id {
            return error("PERMISSION_DENIED", "不能吊销正在使用的这台设备。");
        }
        let Some(runtime) = self.fabric_runtime() else {
            return error(
                "PERMISSION_DENIED",
                "这台设备没有接入 Hub，没有可以吊销的其它设备。",
            );
        };
        if let Err(err) = runtime.revoke_device(&home, device) {
            return from_error(&err);
        }
        IpcResponse::SeaDeviceRevoke(self.sea_devices_view())
    }

    fn sea_host_views(&self) -> Vec<HostView> {
        let home = &self.config.quetzalcoatl_home;
        let check = |key: &str, ok: bool, yes: &str, no: &str| HostCheck {
            key: String::from(key),
            ok,
            detail: String::from(if ok { yes } else { no }),
        };
        let view =
            |host: &str, name: &str, local: crate::host_connect::ClaudeCodeLocalState| HostView {
                host: String::from(host),
                name: String::from(name),
                installed: local.installed,
                version: None,
                connected: local.connected,
                checks: vec![
                    check(
                        "core",
                        local.connected && local.session_start,
                        "会话开始时送入他的核心",
                        "会话开始时还送不进去：在终端运行 qz connect",
                    ),
                    check(
                        "recall",
                        local.connected && local.prompt_submit,
                        "每次提交带上相关往事",
                        "提交时还带不进往事：在终端运行 qz connect",
                    ),
                    check(
                        "signal",
                        local.connected && local.stop,
                        "回合结束时收得到信号",
                        "回合结束时还收不到信号：在终端运行 qz connect",
                    ),
                    check(
                        "compaction",
                        local.connected && local.session_start,
                        "压缩对话之后重新送入核心",
                        "压缩之后核心会丢：在终端运行 qz connect",
                    ),
                ],
            };
        vec![
            view(
                crate::host_hook::HOST_CLAUDE_CODE,
                "Claude Code",
                crate::host_connect::claude_code_local_state(home),
            ),
            view(
                crate::host_connect_codex::HOST_CODEX,
                "Codex",
                crate::host_connect::host_local_state(
                    home,
                    crate::host_connect_codex::HOST_CODEX,
                    "marketplace/plugins/quetzalcoatl/hooks/hooks.json",
                    "codex",
                ),
            ),
            view(
                crate::host_connect_opencode::HOST_OPENCODE,
                "OpenCode",
                crate::host_connect_opencode::opencode_local_state(home),
            ),
            view(
                crate::host_connect_dsh::HOST_DSH,
                "DeepSeek Harness",
                crate::host_connect_dsh::dsh_local_state(home),
            ),
        ]
    }

    fn sea_devices_view(&self) -> DevicesView {
        let this_id = self.runtime_info.device_id.to_string();
        let this_device = DeviceSummary {
            id: this_id.clone(),
            name: String::from("这台设备"),
            added_ms: self.runtime_info.started_ms,
        };
        let Some(runtime) = self.fabric_runtime() else {
            return DevicesView {
                devices: vec![Device {
                    id: this_id,
                    name: this_device.name.clone(),
                    added_ms: this_device.added_ms,
                    last_seen_ms: Some(now_unix_ms()),
                    holds_control: true,
                }],
                this_device,
                hub: HubSummary {
                    url: None,
                    connected: false,
                },
            };
        };
        let report = runtime.nodes_report();
        let holder = report.router_holder.map(|d| d.to_string());
        let mut devices = vec![Device {
            id: this_id.clone(),
            name: String::from("这台设备"),
            added_ms: this_device.added_ms,
            last_seen_ms: Some(now_unix_ms()),
            holds_control: holder.as_deref().is_none_or(|h| h == this_id),
        }];
        for peer in &report.peers {
            if peer.device_id == this_id {
                continue;
            }
            devices.push(Device {
                id: peer.device_id.clone(),
                name: format!("{} · {}", peer.os, peer.arch),
                added_ms: 0,
                last_seen_ms: None,
                holds_control: holder.as_deref() == Some(peer.device_id.as_str()),
            });
        }
        DevicesView {
            this_device,
            devices,
            hub: HubSummary {
                connected: report.enabled && report.hub_url.is_some(),
                url: report.hub_url,
            },
        }
    }
}
