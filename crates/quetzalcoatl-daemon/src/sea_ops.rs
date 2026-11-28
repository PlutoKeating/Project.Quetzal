//! 对海的写入。
//!
//! 写入只有两个来源，各走各的门：
//! - **本人的直接修改**：用户亲口说的「记住 / 不对，应该是 / 别再提 / 忘掉」，以及在治理面上的亲手改动。
//!   本人是有界层之上的权威，这些修改直接生效；但只碰往事（记忆条目），永远碰不到核心与底线。
//! - **模型自发的写入**：宿主里的模型自己提出要记点什么。它走仲裁器，按不可信的信号处理：
//!   只能落成普通记忆，并且标成「只作参考」。
//!
//! 两个来源都经同一个变更日志落盘：先写成脊柱事件，写不进去就把内存恢复原样。

use std::collections::BTreeSet;
use std::path::Path;

use quetzalcoatl_ewave::{
    Authority, Conscience, MemoryEntry, MemoryKind, ModelRef, ModelRole, Mutability,
    ObserveOptions, Proposal, ProposalStatus, ProvenanceRecord, SignalKind,
};
use quetzalcoatl_spine::{MaterializedMemory, MaterializedStore};
use quetzalcoatl_types::{Epoch, QuetzalcoatlError, Result};
use uuid::Uuid;

use crate::daemon::{DaemonMutableState, SEA_ACTOR_SYSTEM, save_graph_snapshot};

/// 变更事件里的执行者标记：本人亲手。
pub(crate) const SEA_ACTOR_OWNER: &str = "owner";
/// 变更事件里的执行者标记：仲裁器放行的模型提案。
pub(crate) const SEA_ACTOR_ARBITER: &str = "arbiter";

/// 单条往事的正文上限（字符）。更长的内容不该当成一条往事记下。
pub(crate) const MAX_ENTRY_CHARS: usize = 4_000;

/// 一次写入的结果，供回执使用。
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct WrittenEntry {
    pub id: String,
    /// 所在的层（`MEMORY` / `USER_PREF`）。
    pub layer: String,
    pub text: String,
    /// 这次改动在脊柱里的序号。
    pub audit_seq: Option<u64>,
}

fn invalid(detail: impl Into<String>) -> QuetzalcoatlError {
    QuetzalcoatlError::StorageError {
        detail: detail.into(),
    }
}

fn clean_text(text: &str) -> Result<String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err(invalid("要记下的内容是空的。"));
    }
    if trimmed.chars().count() > MAX_ENTRY_CHARS {
        return Err(invalid(format!(
            "这段内容太长了（超过 {MAX_ENTRY_CHARS} 个字符），请先概括成一条。"
        )));
    }
    Ok(trimmed.to_owned())
}

fn new_memory_id() -> String {
    format!("mem-{}", Uuid::new_v4().simple())
}

fn category_of(authority: Authority) -> &'static str {
    if authority == Authority::UserPref {
        "user_pref"
    } else {
        "memory"
    }
}

/// 宿主里的模型：模型自发写入时的提案来源。
fn host_model_ref(source: &str) -> ModelRef {
    ModelRef {
        role: ModelRole::Primary,
        reference: String::from(source),
        provider_hash: None,
        model_hash: None,
        params_b: None,
        is_on_device_small: false,
    }
}

/// 同一层里编号重复时（旧版本失效后，新版本沿用了同一个编号），把失效的旧版本改名为
/// `编号@失效时刻`。变更日志按「层 + 编号」记条目，编号必须唯一。
fn give_superseded_versions_their_own_ids(conscience: &mut Conscience) {
    let mut seen: BTreeSet<String> = BTreeSet::new();
    // 从后往前：最新的版本保留原编号。
    for entry in conscience.memories.iter_mut().rev() {
        if !seen.insert(entry.id.clone()) {
            let stamp = entry.invalid_at_ms.unwrap_or(entry.valid_from_ms);
            let mut renamed = format!("{}@{stamp}", entry.id);
            let mut bump = 1u32;
            while !seen.insert(renamed.clone()) {
                renamed = format!("{}@{stamp}_{bump}", entry.id);
                bump += 1;
            }
            entry.id = renamed;
        }
    }
    seen.clear();
    for entry in conscience.values.iter_mut().rev() {
        if !seen.insert(entry.id.clone()) {
            let stamp = entry.invalid_at_ms.unwrap_or(entry.valid_from_ms);
            let mut renamed = format!("{}@{stamp}", entry.id);
            let mut bump = 1u32;
            while !seen.insert(renamed.clone()) {
                renamed = format!("{}@{stamp}_{bump}", entry.id);
                bump += 1;
            }
            entry.id = renamed;
        }
    }
}

impl DaemonMutableState {
    /// 提交对良知的改动，并把本机的检索索引存盘。写不进脊柱时内存恢复原样。
    pub(crate) fn finish_sea_write(
        &mut self,
        qz_home: &Path,
        before: Conscience,
        actor: &str,
        epoch: Epoch,
        summary: &str,
        now_ms: u64,
    ) -> Result<Option<u64>> {
        give_superseded_versions_their_own_ids(&mut self.conscience);
        let seq = self.commit_sea(before, actor, epoch, summary, now_ms)?;
        let DaemonMutableState {
            ref mut persisted,
            ref graph,
            ..
        } = *self;
        // 检索索引存盘失败不回滚：它可以由良知重建，良知已经安全地在脊柱里了。
        let _ = save_graph_snapshot(qz_home, persisted, graph);
        Ok(seq)
    }

    /// 本人亲手做的改动：经变更日志落盘，返回审计序号。
    pub(crate) fn finish_owner_write(
        &mut self,
        qz_home: &Path,
        before: Conscience,
        epoch: Epoch,
        summary: &str,
        now_ms: u64,
    ) -> Result<Option<u64>> {
        self.finish_sea_write(qz_home, before, SEA_ACTOR_OWNER, epoch, summary, now_ms)
    }

    fn insert_memory(&mut self, entry: MemoryEntry) -> Result<()> {
        let updated_hlc = self.kernel.spine().local_hlc();
        self.kernel
            .spine_mut()
            .store_mut()
            .upsert_memory(&MaterializedMemory {
                memory_id: entry.id.clone(),
                category: String::from(category_of(entry.authority)),
                authority: entry.authority.numeric(),
                content: entry.content.clone(),
                updated_hlc,
            })?;
        let _ = self.graph.observe(
            serde_json::json!({"memory_id": entry.id}),
            ObserveOptions {
                id: Some(entry.id.clone()),
                text: Some(entry.content.clone()),
                at: Some(entry.valid_from_ms),
                ..Default::default()
            },
        );
        self.conscience.memories.push(entry);
        Ok(())
    }

    /// 本人让他记下一件事。`about_user` 为真时落在「关于我」这一层。
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn owner_remember(
        &mut self,
        qz_home: &Path,
        text: &str,
        about_user: bool,
        topic: Option<&str>,
        source: &str,
        epoch: Epoch,
        now_ms: u64,
    ) -> Result<WrittenEntry> {
        let text = clean_text(text)?;
        let before = self.conscience.clone();
        let authority = if about_user {
            Authority::UserPref
        } else {
            Authority::Memory
        };
        let entry = MemoryEntry {
            id: new_memory_id(),
            kind: MemoryKind::Fact,
            topic: topic
                .map(str::trim)
                .filter(|t| !t.is_empty())
                .map(String::from),
            content: text.clone(),
            about: if about_user {
                vec![String::from("user")]
            } else {
                Vec::new()
            },
            salience: 0.9,
            evidence_count: 1,
            constant: false,
            untrusted: false,
            muted: false,
            pressure_flags: Vec::new(),
            authority,
            mutability: if about_user {
                Mutability::user_pref_default()
            } else {
                Mutability::memory_free()
            },
            valid_from_ms: now_ms,
            invalid_at_ms: None,
            triggers: Vec::new(),
            provenance: ProvenanceRecord {
                written_by: String::from(SEA_ACTOR_OWNER),
                at_ms: now_ms,
                source_event_ids: vec![String::from(source)],
                model: None,
                supersedes: None,
            },
        };
        let written = WrittenEntry {
            id: entry.id.clone(),
            layer: String::from(authority.as_str()),
            text,
            audit_seq: None,
        };
        if let Err(err) = self.insert_memory(entry) {
            self.conscience = before;
            return Err(err);
        }
        let mut written = written;
        written.audit_seq = self.finish_sea_write(
            qz_home,
            before,
            SEA_ACTOR_OWNER,
            epoch,
            "本人让他记下一条",
            now_ms,
        )?;
        Ok(written)
    }

    /// 本人纠正一条往事：旧的那条到此为止（留作历史），新的一条接替它。
    pub(crate) fn owner_correct(
        &mut self,
        qz_home: &Path,
        id: &str,
        text: &str,
        source: &str,
        epoch: Epoch,
        now_ms: u64,
    ) -> Result<WrittenEntry> {
        let text = clean_text(text)?;
        let before = self.conscience.clone();
        let Some(old) = self
            .conscience
            .memories
            .iter_mut()
            .find(|m| m.id == id && m.invalid_at_ms.is_none())
        else {
            return Err(invalid(format!(
                "没有找到编号为 {id} 的往事（它可能已经过期或被抹除）。"
            )));
        };
        old.invalid_at_ms = Some(now_ms);
        let mut replacement = old.clone();
        replacement.id = new_memory_id();
        replacement.content = text.clone();
        replacement.valid_from_ms = now_ms;
        replacement.invalid_at_ms = None;
        replacement.untrusted = false;
        replacement.salience = replacement.salience.max(0.9);
        replacement.provenance = ProvenanceRecord {
            written_by: String::from(SEA_ACTOR_OWNER),
            at_ms: now_ms,
            source_event_ids: vec![String::from(source)],
            model: None,
            supersedes: Some(String::from(id)),
        };
        let written = WrittenEntry {
            id: replacement.id.clone(),
            layer: String::from(replacement.authority.as_str()),
            text,
            audit_seq: None,
        };
        // 旧版本不再参与检索；它的文字留在良知里作历史，不留在检索索引里。
        let _ = self.graph.redact_entry(id, now_ms);
        if let Err(err) = self.insert_memory(replacement) {
            self.conscience = before;
            return Err(err);
        }
        let mut written = written;
        written.audit_seq = self.finish_sea_write(
            qz_home,
            before,
            SEA_ACTOR_OWNER,
            epoch,
            "本人纠正了一条",
            now_ms,
        )?;
        Ok(written)
    }

    /// 本人要求某条往事「不主动提」，或者解除这个要求。
    pub(crate) fn owner_set_muted(
        &mut self,
        qz_home: &Path,
        id: &str,
        muted: bool,
        epoch: Epoch,
        now_ms: u64,
    ) -> Result<WrittenEntry> {
        let before = self.conscience.clone();
        let Some(entry) = self.conscience.memories.iter_mut().find(|m| m.id == id) else {
            return Err(invalid(format!("没有找到编号为 {id} 的往事。")));
        };
        entry.muted = muted;
        let written = WrittenEntry {
            id: entry.id.clone(),
            layer: String::from(entry.authority.as_str()),
            text: entry.content.clone(),
            audit_seq: None,
        };
        let summary = if muted {
            "本人要求一条往事不主动提"
        } else {
            "本人解除了一条往事的不主动提"
        };
        let mut written = written;
        written.audit_seq =
            self.finish_sea_write(qz_home, before, SEA_ACTOR_OWNER, epoch, summary, now_ms)?;
        Ok(written)
    }

    /// 本人抹除一条往事：从良知、物化视图与检索索引里拿掉，并销毁它的钥匙。不可恢复。
    pub(crate) fn owner_erase(
        &mut self,
        qz_home: &Path,
        id: &str,
        epoch: Epoch,
        now_ms: u64,
    ) -> Result<Option<u64>> {
        if !self.conscience.memories.iter().any(|m| m.id == id) {
            return Err(invalid(format!("没有找到编号为 {id} 的往事。")));
        }
        let before = self.conscience.clone();
        self.conscience.memories.retain(|m| m.id != id);
        self.kernel.spine_mut().store_mut().delete_memory(id)?;
        let _ = self.graph.redact_entry(id, now_ms);
        // 别的设备上的那一把钥匙也要删：记下来，下次联网时在 Hub 上删掉寄给所有设备的那一份。
        crate::sea_sync::queue_remote_key_delete(
            qz_home,
            &quetzalcoatl_ewave::journal::entry_key_blob_name(
                quetzalcoatl_ewave::journal::SeaLayer::Memory,
                id,
            ),
        );
        self.finish_sea_write(
            qz_home,
            before,
            SEA_ACTOR_OWNER,
            epoch,
            "本人抹除了一条",
            now_ms,
        )
    }

    /// 撤回一次纠正时用：让被接替的那一条重新生效。
    pub(crate) fn restore_superseded(
        &mut self,
        qz_home: &Path,
        id: &str,
        epoch: Epoch,
        now_ms: u64,
    ) -> Result<()> {
        let before = self.conscience.clone();
        let Some(entry) = self
            .conscience
            .memories
            .iter_mut()
            .find(|m| m.id == id && m.invalid_at_ms.is_some())
        else {
            return Ok(());
        };
        entry.invalid_at_ms = None;
        let restored = entry.clone();
        let _ = self.graph.observe(
            serde_json::json!({"memory_id": restored.id}),
            ObserveOptions {
                text: Some(restored.content.clone()),
                at: Some(now_ms),
                ..Default::default()
            },
        );
        self.finish_sea_write(
            qz_home,
            before,
            SEA_ACTOR_SYSTEM,
            epoch,
            "撤回了一次无法核对的纠正",
            now_ms,
        )
        .map(|_| ())
    }

    /// 模型自己提出要记的事。经仲裁器按不可信信号处理；被放行时返回写下的条目。
    pub(crate) fn model_remember(
        &mut self,
        qz_home: &Path,
        text: &str,
        source: &str,
        epoch: Epoch,
        now_ms: u64,
    ) -> Result<Option<WrittenEntry>> {
        let text = clean_text(text)?;
        let before = self.conscience.clone();
        let target_id = new_memory_id();
        let proposal = Proposal {
            id: format!("prop-{}", Uuid::new_v4().simple()),
            target_id: target_id.clone(),
            target_authority: Authority::Memory,
            new_value: text.clone(),
            rationale: None,
            signal: SignalKind::S8,
            evidence_episode_ids: Vec::new(),
            reflector: host_model_ref(source),
            additional_agreements: Vec::new(),
            evidence_hash: String::new(),
            policy_version: String::from("host-session/v1"),
            origin_is_group_non_owner: false,
            owner_device_sig_verified: false,
            supersedes: None,
            created_at_ms: now_ms,
        };
        let DaemonMutableState {
            ref mut arbiter,
            ref mut conscience,
            ref mut graph,
            ref mut kernel,
            ..
        } = *self;
        let report = match arbiter.evaluate_proposals(
            epoch,
            &[proposal],
            conscience,
            graph,
            kernel.spine_mut(),
            now_ms,
        ) {
            Ok(report) => report,
            Err(err) => {
                self.conscience = before;
                return Err(err);
            }
        };
        let accepted = report
            .evaluations
            .first()
            .is_some_and(|evaluation| evaluation.status == ProposalStatus::Accepted);
        if !accepted {
            self.conscience = before;
            return Ok(None);
        }
        self.finish_sea_write(
            qz_home,
            before,
            SEA_ACTOR_ARBITER,
            epoch,
            "模型提出的一条记忆（只作参考）",
            now_ms,
        )?;
        Ok(Some(WrittenEntry {
            id: target_id,
            layer: String::from(Authority::Memory.as_str()),
            text,
            audit_seq: None,
        }))
    }
}
