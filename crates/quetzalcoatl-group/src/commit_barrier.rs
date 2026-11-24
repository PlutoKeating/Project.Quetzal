//! 两层式群组提交屏障（Pitfall #21）：
//!
//! * Layer 1（Hub）：纯密钥轮换导致的 `mls_epoch` 不匹配 → 用 `GroupEpochKey[e+1]` 重加密同一密文重发，
//!   **绝不重跑大模型**；
//! * Layer 2（Router）：语义控场屏障——仅当 `(last_seen_group_seq, head_seq]` 增量包含点名本 Agent、
//!   `@agents`、同父话题追问或 `cancel/steer` 时才强制重读重算；无关闲聊/表情直接快进并附挂因果父序号。

use chacha20poly1305::{
    ChaCha20Poly1305, Nonce,
    aead::{Aead, KeyInit},
};
use quetzalcoatl_types::{AgentId, QuetzalcoatlError, Result};
use serde::{Deserialize, Serialize};

use crate::floor_control::{Mention, MentionKind};

const COMMIT_AAD_CONTEXT: &[u8] = b"quetzalcoatl/v2/group-commit-epoch-v1";

#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum BarrierResolution {
    ReencryptWithNewMlsEpoch,
    FastForwardCausalParent,
    RejectWatermarkRecompute,
    UpToDate,
}

impl BarrierResolution {
    /// 与 `spec/vectors/anp_p9_mentions.json` 完全一致的线格式字符串。
    #[must_use]
    pub const fn as_wire_str(self) -> &'static str {
        match self {
            Self::ReencryptWithNewMlsEpoch => "REENCRYPT_WITH_NEW_MLS_EPOCH",
            Self::FastForwardCausalParent => "FAST_FORWARD_CAUSAL_PARENT",
            Self::RejectWatermarkRecompute => "REJECT_WATERMARK_RECOMPUTE",
            Self::UpToDate => "UP_TO_DATE",
        }
    }
}

/// Hub 侧群头视图。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GroupHead {
    pub group_id: String,
    pub head_group_seq: u64,
    pub current_mls_epoch: u64,
}

/// Router 侧待提交产物。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SubmittedCommit {
    pub last_seen_group_seq: u64,
    pub mls_epoch: u64,
    pub submitting_agent_id: AgentId,
}

/// `(last_seen_group_seq, head_seq]` 区间内的群事件（仅元数据，零明文）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InterveningEvent {
    pub seq: u64,
    pub kind: String,
    pub mentions: Vec<Mention>,
    pub parent_seq: Option<u64>,
    pub summary: Option<String>,
    pub emoji: Option<String>,
    /// 事件作者；作者本人的既往提交不需要重读（`None` 视为他人，保守判语义）。
    pub sender_agent_id: Option<AgentId>,
}

impl InterveningEvent {
    fn is_semantic_for(&self, submitting_agent_id: AgentId, last_seen_group_seq: u64) -> bool {
        if self.sender_agent_id == Some(submitting_agent_id) {
            // 自己写的消息不构成需要重读的新约束。
            return false;
        }
        let normalized_kind = self.kind.trim().to_ascii_lowercase();
        if matches!(
            normalized_kind.as_str(),
            "constraint_update" | "cancel" | "steer" | "constraint" | "steering"
        ) {
            return true;
        }
        let mentions_self_or_all = self.mentions.iter().any(|mention| match mention.kind {
            MentionKind::AllAgents => true,
            MentionKind::Addressee => mention.target_agent_id == Some(submitting_agent_id),
            MentionKind::Cc | MentionKind::AllHumans => false,
        });
        if mentions_self_or_all {
            return true;
        }
        // 同父话题的**实质追问/约束**才强制重读；普通 chatter 即便同父也必须快进，
        // 否则并发闲聊会被误判为恒定冲突（WATERMARK_CONFLICT 风暴）。
        self.parent_seq == Some(last_seen_group_seq)
            && matches!(
                normalized_kind.as_str(),
                "question" | "follow_up" | "followup" | "constraint"
            )
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BarrierOutcome {
    pub resolution: BarrierResolution,
    /// Layer 1 与快进路径都为 false；只有语义冲突被拒后才需要重新推理。
    pub requires_model_rerun: bool,
    pub reencrypt_only: bool,
    pub attached_causal_parent_seq: Option<u64>,
    pub reencrypt_epoch: Option<u64>,
}

/// `last_seen_group_seq` CAS 未读水位线屏障。
pub struct UnreadWatermarkBarrier;

impl UnreadWatermarkBarrier {
    pub fn resolve(
        head: &GroupHead,
        submitted: &SubmittedCommit,
        intervening_events: &[InterveningEvent],
    ) -> Result<BarrierOutcome> {
        if submitted.last_seen_group_seq > head.head_group_seq {
            return Err(QuetzalcoatlError::PermissionDenied {
                detail: format!(
                    "本地未读水位线 {} 超前于 Hub 群头 {}（伪造或脑裂）",
                    submitted.last_seen_group_seq, head.head_group_seq
                ),
            });
        }

        let delta: Vec<&InterveningEvent> = intervening_events
            .iter()
            .filter(|event| {
                event.seq > submitted.last_seen_group_seq && event.seq <= head.head_group_seq
            })
            .collect();

        // Layer 2 语义控场优先：存在关键约束/点名/追问/cancel/steer 时必须拒绝旧水位线产物。
        if delta.iter().any(|event| {
            event.is_semantic_for(submitted.submitting_agent_id, submitted.last_seen_group_seq)
        }) {
            return Err(QuetzalcoatlError::WatermarkConflict {
                last_seen_seq: submitted.last_seen_group_seq,
                head_seq: head.head_group_seq,
            });
        }

        // Layer 1：纯密钥轮换 → 同一密文换新纪元密钥重发，零模型重跑。
        if submitted.mls_epoch != head.current_mls_epoch {
            return Ok(BarrierOutcome {
                resolution: BarrierResolution::ReencryptWithNewMlsEpoch,
                requires_model_rerun: false,
                reencrypt_only: true,
                attached_causal_parent_seq: Some(submitted.last_seen_group_seq),
                reencrypt_epoch: Some(head.current_mls_epoch),
            });
        }

        // Layer 2 快进：增量只有无关闲聊/表情，直接附挂因果父序号提交。
        if head.head_group_seq > submitted.last_seen_group_seq {
            return Ok(BarrierOutcome {
                resolution: BarrierResolution::FastForwardCausalParent,
                requires_model_rerun: false,
                reencrypt_only: false,
                attached_causal_parent_seq: Some(submitted.last_seen_group_seq),
                reencrypt_epoch: None,
            });
        }

        Ok(BarrierOutcome {
            resolution: BarrierResolution::UpToDate,
            requires_model_rerun: false,
            reencrypt_only: false,
            attached_causal_parent_seq: Some(submitted.last_seen_group_seq),
            reencrypt_epoch: None,
        })
    }
}

/// 已用某纪元密钥密封的提交密文。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct EpochCiphertext {
    pub epoch: u64,
    pub nonce: [u8; 12],
    pub ciphertext: Vec<u8>,
}

fn derive_epoch_key(master_key: &[u8; 32], epoch: u64) -> [u8; 32] {
    let mut hasher = blake3::Hasher::new_derive_key("quetzalcoatl/v2/epoch-key-derive-v1");
    hasher.update(master_key);
    hasher.update(&epoch.to_be_bytes());
    *hasher.finalize().as_bytes()
}

fn epoch_nonce(key: &[u8; 32], epoch: u64, plaintext_or_ciphertext: &[u8]) -> [u8; 12] {
    let mut hasher = blake3::Hasher::new_derive_key("quetzalcoatl/v2/epoch-nonce-v1");
    hasher.update(key);
    hasher.update(&epoch.to_be_bytes());
    hasher.update(plaintext_or_ciphertext);
    let digest = hasher.finalize();
    let mut nonce = [0u8; 12];
    nonce.copy_from_slice(&digest.as_bytes()[..12]);
    nonce
}

fn cipher_for(epoch_key: &[u8; 32]) -> Result<ChaCha20Poly1305> {
    ChaCha20Poly1305::new_from_slice(epoch_key).map_err(|_| QuetzalcoatlError::IntegrityViolation {
        detail: String::from("群纪元密钥长度非法，无法构造 AEAD"),
    })
}

fn epoch_aad(epoch: u64) -> Vec<u8> {
    let mut aad = COMMIT_AAD_CONTEXT.to_vec();
    aad.extend_from_slice(&epoch.to_be_bytes());
    aad
}

/// 用 `GroupEpochKey[e]` 密封提交密文（AEAD + 纪元绑定 AAD）。
pub fn seal_with_epoch_key(
    master_key: &[u8; 32],
    epoch: u64,
    plaintext: &[u8],
) -> Result<EpochCiphertext> {
    let epoch_key = derive_epoch_key(master_key, epoch);
    let cipher = cipher_for(&epoch_key)?;
    let nonce = epoch_nonce(&epoch_key, epoch, plaintext);
    let ciphertext = cipher
        .encrypt(
            Nonce::from_slice(&nonce),
            chacha20poly1305::aead::Payload {
                msg: plaintext,
                aad: &epoch_aad(epoch),
            },
        )
        .map_err(|_| QuetzalcoatlError::IntegrityViolation {
            detail: String::from("群提交密文 AEAD 密封失败"),
        })?;
    Ok(EpochCiphertext {
        epoch,
        nonce,
        ciphertext,
    })
}

/// 用指定纪元密钥解密提交密文（纪元必须与 AAD 绑定一致）。
pub fn decrypt_with_epoch_key(master_key: &[u8; 32], sealed: &EpochCiphertext) -> Result<Vec<u8>> {
    let epoch_key = derive_epoch_key(master_key, sealed.epoch);
    let cipher = cipher_for(&epoch_key)?;
    cipher
        .decrypt(
            Nonce::from_slice(&sealed.nonce),
            chacha20poly1305::aead::Payload {
                msg: sealed.ciphertext.as_slice(),
                aad: &epoch_aad(sealed.epoch),
            },
        )
        .map_err(|_| QuetzalcoatlError::IntegrityViolation {
            detail: format!(
                "群纪元 {} 密钥无法解密提交密文（前向安全或纪元不匹配）",
                sealed.epoch
            ),
        })
}

/// Layer 1 重加密：用旧纪元密钥解开同一密文，再用 `GroupEpochKey[e+1]` 重新密封。
///
/// 全程不触碰模型：调用方仅需重发返回的密文块。
pub fn reencrypt_with_new_epoch(
    old_master_key: &[u8; 32],
    new_master_key: &[u8; 32],
    new_epoch: u64,
    sealed: &EpochCiphertext,
) -> Result<EpochCiphertext> {
    let plaintext = decrypt_with_epoch_key(old_master_key, sealed)?;
    seal_with_epoch_key(new_master_key, new_epoch, &plaintext)
}
