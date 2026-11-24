#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]

//! `quetzalcoatld` 群房间运行时：每加入一个群即构造独立 `GroupRoomEngine` + `AnpP9FloorGate` +
//! `UnreadWatermarkBarrier`，经 Hub `/v1/groups/*` 原子定序密文提交，并把 MLS 状态确定性持久化进脊柱。

use std::collections::BTreeMap;
use std::fs;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use quetzalcoatl_fabric::{GroupCommitRecord, HubClient, HubClientConfig};
use quetzalcoatl_group::commit_barrier::{
    GroupHead, InterveningEvent, SubmittedCommit, UnreadWatermarkBarrier,
};
use quetzalcoatl_group::facilitator::FacilitatorHolder;
use quetzalcoatl_group::floor_control::{AnpP9FloorGate, FloorInput, Mention, SenderKind};
use quetzalcoatl_group::mls_room::{GroupRoomEngine, MlsIdentity, PendingJoin};
use quetzalcoatl_group::steward::{StewardGrant, StewardRegistry};
use quetzalcoatl_spine::MaterializedStore;
use quetzalcoatl_types::{AgentId, DeviceId, QuetzalcoatlError, Result};
use serde::{Deserialize, Serialize};

const REGISTRY_REL_PATH: &str = "group-rooms/registry.json";

/// Hub 群日志里的 MLS 控制消息 kind（Hub 保持零知识：只存密文与元数据）。
pub const MLS_COMMIT_KIND: &str = "mls_commit";

fn storage_error(context: &str, err: impl std::fmt::Display) -> QuetzalcoatlError {
    QuetzalcoatlError::StorageError {
        detail: format!("{context}: {err}"),
    }
}

fn derive_identity_seed(device_seed_hex: &str, room_id: &str) -> Result<[u8; 32]> {
    let mut hasher = blake3::Hasher::new_derive_key("quetzalcoatl/v2/group-mls-identity-v1");
    hasher.update(device_seed_hex.as_bytes());
    hasher.update(room_id.as_bytes());
    Ok(*hasher.finalize().as_bytes())
}

const BASE64_ALPHABET: &[u8; 64] =
    b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

#[must_use]
pub fn base64_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0];
        let b1 = chunk.get(1).copied().unwrap_or(0);
        let b2 = chunk.get(2).copied().unwrap_or(0);
        out.push(char::from(BASE64_ALPHABET[usize::from(b0 >> 2)]));
        out.push(char::from(
            BASE64_ALPHABET[usize::from(((b0 & 0b11) << 4) | (b1 >> 4))],
        ));
        if chunk.len() > 1 {
            out.push(char::from(
                BASE64_ALPHABET[usize::from(((b1 & 0b1111) << 2) | (b2 >> 6))],
            ));
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(char::from(BASE64_ALPHABET[usize::from(b2 & 0b11_1111)]));
        } else {
            out.push('=');
        }
    }
    out
}

fn base64_value(byte: u8) -> Option<u8> {
    match byte {
        b'A'..=b'Z' => Some(byte - b'A'),
        b'a'..=b'z' => Some(byte - b'a' + 26),
        b'0'..=b'9' => Some(byte - b'0' + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    }
}

pub fn base64_decode(raw: &str) -> Result<Vec<u8>> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || !trimmed.len().is_multiple_of(4) {
        return Err(QuetzalcoatlError::SerializationError {
            detail: String::from("base64 长度非法"),
        });
    }
    let mut out = Vec::with_capacity(trimmed.len() / 4 * 3);
    let raw = trimmed.as_bytes();
    for base in (0..raw.len()).step_by(4) {
        let chunk = &raw[base..base + 4];
        let pad = chunk.iter().filter(|byte| **byte == b'=').count();
        if pad > 2 {
            return Err(QuetzalcoatlError::SerializationError {
                detail: String::from("base64 填充非法"),
            });
        }
        let mut vals = [0u8; 4];
        for (idx, byte) in chunk.iter().enumerate() {
            if *byte == b'=' {
                vals[idx] = 0;
            } else {
                vals[idx] =
                    base64_value(*byte).ok_or_else(|| QuetzalcoatlError::SerializationError {
                        detail: String::from("base64 包含非法字符"),
                    })?;
            }
        }
        out.push((vals[0] << 2) | (vals[1] >> 4));
        if pad < 2 {
            out.push((vals[1] << 4) | (vals[2] >> 2));
        }
        if pad < 1 {
            out.push((vals[2] << 6) | vals[3]);
        }
    }
    Ok(out)
}

/// 群房间对外状态摘要。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct GroupRoomSummary {
    pub room_id: String,
    pub mls_epoch: u64,
    pub members: Vec<String>,
    pub secrecy_level: u8,
    /// 语义已消费水位线（屏障唯一依据）。
    pub last_seen_group_seq: u64,
    /// 已应用并持久化的 MLS 消息游标（心跳/同步的拉取起点）。
    pub mls_cursor_group_seq: u64,
    /// 本机自己发布到的最大 server_seq（不参与已读判定）。
    pub own_published_group_seq: u64,
    /// 最早的未消费语义行；`Some` 时发送必须冲突直到显式消费。
    pub pending_semantic_group_seq: Option<u64>,
    /// 本机是否是群主（负责提交离群提案）。
    pub is_owner: bool,
    pub hub_connected: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct GroupMemberView {
    pub identity: String,
    pub is_self: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct GroupInviteOutcome {
    pub room_id: String,
    pub key_package_b64: Option<String>,
    pub welcome_b64: Option<String>,
    pub ratchet_tree_b64: Option<String>,
    pub commit_b64: Option<String>,
    pub mls_epoch: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct GroupSendOutcome {
    pub room_id: String,
    pub mls_epoch: u64,
    pub floor_action: String,
    pub authority_envelope: String,
    pub ciphertext_b64: Option<String>,
    pub server_seq: Option<u64>,
    pub causal_parent_seq: Option<u64>,
    pub watermark_resolution: Option<String>,
}

/// 在持有全局状态锁时完成的纯本地发送准备（零网络 I/O）。
pub struct PreparedSend {
    pub room_id: String,
    pub mls_ciphertext: Vec<u8>,
    pub local_epoch: u64,
    pub last_seen_group_seq: u64,
    pub floor_action: String,
    pub authority_envelope: String,
    pub should_speak: bool,
    pub mentions: Vec<Mention>,
    pub kind: String,
    pub author_kind: String,
    pub parent_seq: u64,
    pub hub_client: Option<HubClient>,
    pub agent_id: AgentId,
    pub device_id: DeviceId,
}

/// 阶段 1 同步计划：只含房间与 Hub 客户端快照，绝不携带 MLS 状态。
pub struct SyncPlan {
    pub room_id: String,
    /// 拉取起点 = MLS 游标，而不是语义水位线。
    pub after_seq: u64,
    pub client: HubClient,
}

/// 阶段 2 产物：截止 Hub 真头的提交页（已在零锁阶段拉全）。
pub struct PreparedSync {
    pub room_id: String,
    pub commits: Vec<GroupCommitRecord>,
    pub head_group_seq: u64,
    pub after_seq: u64,
}

/// 群主提交暂存提案的计划（短锁创建 → 零锁发布 → 短锁合并）。
pub struct OwnerCommitPlan {
    pub room_id: String,
    pub mls_epoch: u64,
    pub parent_seq: u64,
    pub commit: Vec<u8>,
    pub client: Option<HubClient>,
    pub agent_id: AgentId,
    pub device_id: DeviceId,
}

/// Hub 原子定序结果（网络阶段产出，重新加锁后应用）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AppliedSend {
    pub server_seq: u64,
    pub causal_parent_seq: Option<u64>,
    pub watermark_resolution: String,
    pub submitted_epoch: u64,
    /// 真正提交到 Hub 的密文字节（发送结果必须回报它，而非本地待发布副本）。
    pub appended_ciphertext: Vec<u8>,
}

/// 纪元写入决策：只区分“持平直发”与“本地恰领先 1 的纯密钥轮换”。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EpochWritePlan {
    /// 本地与 Hub 纪元一致：直接发布 MLS 密文本体。
    PublishCurrent { epoch: u64 },
    /// 本地恰领先 1：标记 `reencrypt_only`，由 Hub 原子推进纪元。
    PublishAdvance { epoch: u64 },
}

/// 纪元写入门禁（fail closed）。
///
/// 只有两种情形允许外发：
/// * `local_epoch == hub_epoch`：正常提交；
/// * `local_epoch == hub_epoch + 1`：本地已完成一次纯密钥轮换。
///
/// `hub_epoch > local_epoch` 说明本机尚未处理 Hub 的轮换 Commit，**没有** `EpochKey[e+1]`，
/// 此时任何“重封”都会发布接收方无法解开的字节，因此必须返回 `WatermarkConflict`，
/// 待拉取并处理 Commit 后再发。更大的本地领先同样视为真分歧。
pub fn plan_epoch_write(
    local_epoch: u64,
    hub_epoch: u64,
    last_seen_seq: u64,
    head_seq: u64,
) -> Result<EpochWritePlan> {
    let conflict = || QuetzalcoatlError::WatermarkConflict {
        last_seen_seq,
        head_seq,
    };
    if hub_epoch > local_epoch {
        return Err(conflict());
    }
    match local_epoch - hub_epoch {
        0 => Ok(EpochWritePlan::PublishCurrent { epoch: hub_epoch }),
        1 => Ok(EpochWritePlan::PublishAdvance { epoch: local_epoch }),
        _ => Err(conflict()),
    }
}

/// 只有同一台设备才能把“本机待定 Commit”当作已发布行合并；跨设备合并会静默分叉。
#[must_use]
pub fn pending_commit_belongs_to_device(sender_device_id: &str, self_device: DeviceId) -> bool {
    sender_device_id == self_device.to_string()
}

/// 未读语义冲突范围：保证 `head >= last_seen`，客户端做 `head - last_seen` 绝不溢出。
fn pending_conflict(semantic_read: u64, pending: u64) -> QuetzalcoatlError {
    QuetzalcoatlError::WatermarkConflict {
        last_seen_seq: semantic_read.min(pending.saturating_sub(1)),
        head_seq: pending,
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct GroupRevokeOutcome {
    pub room_id: String,
    pub grant_id: String,
    pub revoked_identity: String,
    pub rotated_epoch: u64,
    pub dropped_management_rights: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct GroupLeaveOutcome {
    pub room_id: String,
    pub left: bool,
}

/// Hub 连接绑定（复用 `qz login` 持久化会话）。
#[derive(Clone)]
pub struct GroupHubBinding {
    pub base_url: String,
    pub session_token: Option<String>,
    pub custom_ca_certs_der: Vec<Vec<u8>>,
}

impl std::fmt::Debug for GroupHubBinding {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("GroupHubBinding")
            .field("base_url", &self.base_url)
            .field(
                "has_session_token",
                &self.session_token.as_ref().is_some_and(|t| !t.is_empty()),
            )
            .finish_non_exhaustive()
    }
}

struct ManagedRoom {
    engine: GroupRoomEngine,
    identity: MlsIdentity,
    gate: AnpP9FloorGate,
    secrecy_level: u8,
    /// 语义已消费水位线：只有显式消费才前进，心跳同步绝不越过未读约束。
    semantic_read_seq: u64,
    /// MLS 消息游标：已应用并持久化的最大 server_seq。
    mls_cursor_seq: u64,
    /// 最早的未消费语义行（约束/点名追问/打断等）。
    pending_semantic_seq: Option<u64>,
    /// 本机自己发布到的最大 server_seq（仅诊断/去重，不参与已读判定）。
    own_published_seq: u64,
    /// 本机是否是群主（群主负责提交离群提案，使其真正生效）。
    is_owner: bool,
}

/// 群房间运行时（守护进程内单实例，天然满足 Pitfall #13 单写者约束）。
pub struct GroupRoomRuntime {
    home: PathBuf,
    agent_id: AgentId,
    device_id: DeviceId,
    device_seed_hex: String,
    rooms: BTreeMap<String, ManagedRoom>,
    pending_joins: BTreeMap<String, PendingJoin>,
    stewards: StewardRegistry,
    hub: Option<GroupHubBinding>,
    hub_client: Option<HubClient>,
}

impl GroupRoomRuntime {
    #[must_use]
    pub fn new(
        home: PathBuf,
        agent_id: AgentId,
        device_id: DeviceId,
        device_seed_hex: String,
    ) -> Self {
        Self {
            home,
            agent_id,
            device_id,
            device_seed_hex,
            rooms: BTreeMap::new(),
            pending_joins: BTreeMap::new(),
            stewards: StewardRegistry::new(),
            hub: None,
            hub_client: None,
        }
    }

    pub fn with_hub(&mut self, hub: GroupHubBinding) -> Result<()> {
        let client = HubClient::new(HubClientConfig {
            base_url: hub.base_url.clone(),
            session_token: hub.session_token.clone(),
            custom_ca_certs_der: hub.custom_ca_certs_der.clone(),
        })?;
        self.hub = Some(hub);
        self.hub_client = Some(client);
        Ok(())
    }

    /// 惰性刷新 Hub 会话令牌：`qz login` 在守护进程启动后才完成时也能立即生效。
    fn refresh_hub_session(&mut self) -> Result<()> {
        let Some(binding) = &self.hub else {
            return Ok(());
        };
        let token = crate::fabric::load_persisted_session(&self.home)
            .filter(|session| session.hub_url == binding.base_url)
            .map(|session| session.session_token);
        if token
            == self
                .hub_client
                .as_ref()
                .and_then(|c| c.session_token().map(str::to_owned))
        {
            return Ok(());
        }
        let client = HubClient::new(HubClientConfig {
            base_url: binding.base_url.clone(),
            session_token: token,
            custom_ca_certs_der: binding.custom_ca_certs_der.clone(),
        })?;
        self.hub_client = Some(client);
        Ok(())
    }

    #[must_use]
    pub fn room_count(&self) -> usize {
        self.rooms.len()
    }

    /// 把一条序列化的 MLS proposal/commit 作为不透明密文发布到 Hub 群日志。
    ///
    /// 返回 Hub 分配的 server_seq；未配置 Hub 时返回 `None`（纯本地模式）。
    /// Hub 只看到 `kind = mls_commit` 与服务端派生的 `hop = 0`，绝不解析 MLS 明文。
    fn publish_mls_message(
        &self,
        room_id: &str,
        mls_epoch: u64,
        parent_seq: u64,
        message_bytes: &[u8],
        reencrypt_only: bool,
    ) -> Result<Option<u64>> {
        let Some(client) = self
            .hub_client
            .as_ref()
            .filter(|client| client.session_token().is_some())
        else {
            return Ok(None);
        };
        let receipt = block_on(client.append_group_commit(
            room_id,
            self.agent_id,
            self.device_id,
            mls_epoch,
            parent_seq,
            &serde_json::json!([]),
            &base64_encode(message_bytes),
            MLS_COMMIT_KIND,
            "agent",
            reencrypt_only,
        ))?;
        Ok(Some(receipt.server_seq))
    }

    fn note_published_seq(&mut self, room_id: &str, seq: Option<u64>) {
        if let (Some(seq), Some(room)) = (seq, self.rooms.get_mut(room_id)) {
            // 自己发布的行只计入“己方已发布”游标：绝不推进 MLS 扫描游标或语义水位线，
            // 否则会跳过同步尚未扫描到的对端约束（历史缺陷）。
            room.own_published_seq = room.own_published_seq.max(seq);
        }
    }

    /// 发布失败时丢弃待定 Commit，保证重试不会卡在 `PendingCommitExists`。
    fn discard_pending_on(&mut self, room_id: &str) {
        if let Some(room) = self.rooms.get_mut(room_id) {
            let _ = room.engine.discard_pending_commit();
        }
    }

    #[must_use]
    pub const fn device_id(&self) -> DeviceId {
        self.device_id
    }

    fn identity_for(&self, room_id: &str) -> Result<MlsIdentity> {
        let seed = derive_identity_seed(&self.device_seed_hex, room_id)?;
        MlsIdentity::from_seed(&format!("agent:{}", self.agent_id), seed)
    }

    fn registry_path(&self) -> PathBuf {
        self.home.join(REGISTRY_REL_PATH)
    }

    fn persist_registry(&self) -> Result<()> {
        self.write_registry(None)
    }

    /// 写入“排除某房间”的注册表（先落盘、再从内存移除，失败时内存原样保留可重试）。
    fn persist_registry_excluding(&self, skip_room: &str) -> Result<()> {
        self.write_registry(Some(skip_room))
    }

    fn write_registry(&self, skip_room: Option<&str>) -> Result<()> {
        let entries: Vec<RegistryEntry> = self
            .rooms
            .iter()
            .filter(|(room_id, _)| skip_room != Some(room_id.as_str()))
            .map(|(room_id, room)| RegistryEntry {
                room_id: room_id.clone(),
                secrecy_level: room.secrecy_level,
                last_seen_group_seq: room.semantic_read_seq,
                mls_cursor_group_seq: room.mls_cursor_seq,
                pending_semantic_group_seq: room.pending_semantic_seq,
                own_published_group_seq: room.own_published_seq,
                is_owner: room.is_owner,
            })
            .collect();
        let registry = RoomRegistry {
            version: 1,
            rooms: entries,
            stewards: self.stewards.list_all().into_iter().cloned().collect(),
        };
        let bytes = serde_json::to_vec_pretty(&registry).map_err(|err| {
            QuetzalcoatlError::SerializationError {
                detail: format!("编码群房间注册表失败: {err}"),
            }
        })?;
        crate::daemon::write_private_file(&self.registry_path(), &bytes)
    }

    /// 从脊柱快照恢复全部已加入群（重启继续同一 group/epoch 状态）。
    pub fn restore<S: MaterializedStore + ?Sized>(&mut self, store: &S) -> Result<()> {
        let path = self.registry_path();
        let Ok(raw) = fs::read(&path) else {
            return Ok(());
        };
        let registry: RoomRegistry =
            serde_json::from_slice(&raw).map_err(|err| QuetzalcoatlError::SerializationError {
                detail: format!("解析群房间注册表失败: {err}"),
            })?;
        for grant in registry.stewards {
            let _ = self.stewards.issue(grant);
        }
        for entry in registry.rooms {
            let identity = self.identity_for(&entry.room_id)?;
            let Ok(engine) = GroupRoomEngine::restore(&entry.room_id, &identity, store) else {
                continue;
            };
            self.rooms.insert(
                entry.room_id.clone(),
                ManagedRoom {
                    gate: AnpP9FloorGate::new(entry.room_id),
                    engine,
                    identity,
                    secrecy_level: entry.secrecy_level,
                    semantic_read_seq: entry.last_seen_group_seq,
                    mls_cursor_seq: entry.mls_cursor_group_seq,
                    pending_semantic_seq: entry.pending_semantic_group_seq,
                    own_published_seq: entry.own_published_group_seq,
                    is_owner: entry.is_owner,
                },
            );
        }
        Ok(())
    }

    pub fn create<S: MaterializedStore + ?Sized>(
        &mut self,
        room_id: &str,
        secrecy_level: u8,
        store: &mut S,
    ) -> Result<GroupRoomSummary> {
        if self.rooms.contains_key(room_id) {
            return Err(QuetzalcoatlError::DeliveryRefused {
                detail: format!("群房间 {room_id} 已加入"),
            });
        }
        self.refresh_hub_session()?;
        let identity = self.identity_for(room_id)?;
        let engine = GroupRoomEngine::create(room_id, &identity)?;
        // Hub 登记必须先成功（owner 由 Hub 原子写入），随后才落本地 MLS 快照与注册表，
        // 避免 Hub 失败后留下“有脊柱快照、无注册表”的孤儿房间。
        if let Some(client) = &self.hub_client
            && client.session_token().is_some()
        {
            block_on(client.create_group_room(room_id, self.agent_id, secrecy_level))?;
        }
        engine.persist_to(store)?;
        self.rooms.insert(
            room_id.to_owned(),
            ManagedRoom {
                gate: AnpP9FloorGate::new(room_id),
                engine,
                identity,
                secrecy_level,
                semantic_read_seq: 0,
                mls_cursor_seq: 0,
                pending_semantic_seq: None,
                own_published_seq: 0,
                is_owner: true,
            },
        );
        self.persist_registry()?;
        self.summary(room_id)
    }

    /// 无参 `invite`：打印本成员一次性 KeyPackage，供群主验签加群。
    pub fn invite_key_package(&mut self, room_id: &str) -> Result<GroupInviteOutcome> {
        if self.rooms.contains_key(room_id) {
            return Err(QuetzalcoatlError::DeliveryRefused {
                detail: format!("本 Agent 已在群 {room_id} 中"),
            });
        }
        let identity = self.identity_for(room_id)?;
        let pending = GroupRoomEngine::prepare_join(room_id, &identity)?;
        let key_package_b64 = base64_encode(pending.key_package_bytes());
        self.pending_joins.insert(room_id.to_owned(), pending);
        Ok(GroupInviteOutcome {
            room_id: room_id.to_owned(),
            key_package_b64: Some(key_package_b64),
            welcome_b64: None,
            ratchet_tree_b64: None,
            commit_b64: None,
            mls_epoch: 0,
        })
    }

    /// 群主消费远端 KeyPackage：本地推进纪元并返回 Welcome 交接载荷。
    #[allow(clippy::too_many_arguments)]
    pub fn add_member<S: MaterializedStore + ?Sized>(
        &mut self,
        room_id: &str,
        key_package_b64: &str,
        agent_id: AgentId,
        as_steward: bool,
        store: &mut S,
    ) -> Result<GroupInviteOutcome> {
        self.refresh_hub_session()?;
        let key_package = base64_decode(key_package_b64)?;
        let (handoff, parent_seq) = {
            let room =
                self.rooms
                    .get_mut(room_id)
                    .ok_or_else(|| QuetzalcoatlError::PermissionDenied {
                        detail: format!("群 {room_id} 尚未在本机创建/加入"),
                    })?;
            let parent_seq = room.semantic_read_seq;
            (room.engine.add_member(&key_package)?, parent_seq)
        };
        // 先把待定 Commit 落盘：发布后崩溃可在重启时合并待定状态收敛。
        if let Some(room) = self.rooms.get(room_id) {
            room.engine.persist_to(store)?;
        }
        // 再把同一份 MLS Commit 发布到 Hub 群日志，成功后才在本地推进纪元；
        // 发布失败则丢弃待定 Commit，让重试能重新生成而不是卡在 PendingCommitExists。
        match self.publish_mls_message(room_id, handoff.epoch, parent_seq, &handoff.commit, true) {
            Ok(seq) => self.note_published_seq(room_id, seq),
            Err(err) => {
                self.discard_pending_on(room_id);
                return Err(err);
            }
        }
        let room =
            self.rooms
                .get_mut(room_id)
                .ok_or_else(|| QuetzalcoatlError::PermissionDenied {
                    detail: format!("群 {room_id} 尚未在本机创建/加入"),
                })?;
        room.engine.commit_pending()?;
        room.engine.persist_to(store)?;
        let mls_epoch = room.engine.mls_epoch();
        if as_steward {
            let steward = StewardGrant::new(
                room_id,
                agent_id,
                handoff.member_identity.clone(),
                self.agent_id,
                mls_epoch,
                crate::daemon::now_unix_ms(),
            )?;
            // 授予可吊销托管权；`revoke-steward` 会立即剥夺并轮换纪元。
            self.stewards.issue(steward)?;
        }
        if let Some(client) = &self.hub_client
            && client.session_token().is_some()
        {
            let role = if as_steward { "steward" } else { "member" };
            block_on(client.add_group_member(room_id, agent_id, role))?;
        }
        self.persist_registry()?;
        Ok(GroupInviteOutcome {
            room_id: room_id.to_owned(),
            key_package_b64: None,
            welcome_b64: Some(base64_encode(&handoff.welcome)),
            ratchet_tree_b64: Some(base64_encode(&handoff.ratchet_tree)),
            commit_b64: Some(base64_encode(&handoff.commit)),
            mls_epoch,
        })
    }

    pub fn join<S: MaterializedStore + ?Sized>(
        &mut self,
        room_id: &str,
        welcome_b64: &str,
        ratchet_tree_b64: &str,
        store: &mut S,
    ) -> Result<GroupRoomSummary> {
        let pending = self
            .pending_joins
            .remove(room_id)
            .ok_or_else(|| QuetzalcoatlError::PermissionDenied {
                detail: format!(
                    "缺少群 {room_id} 的待入群 KeyPackage 私钥材料，请先执行 `qz group invite --room {room_id}` 获取 KeyPackage"
                ),
            })?;
        let welcome = base64_decode(welcome_b64)?;
        let ratchet_tree = base64_decode(ratchet_tree_b64)?;
        let engine = GroupRoomEngine::join(pending, &welcome, &ratchet_tree)?;
        engine.persist_to(store)?;
        let identity = self.identity_for(room_id)?;
        self.rooms.insert(
            room_id.to_owned(),
            ManagedRoom {
                gate: AnpP9FloorGate::new(room_id),
                engine,
                identity,
                secrecy_level: 1,
                semantic_read_seq: 0,
                mls_cursor_seq: 0,
                pending_semantic_seq: None,
                own_published_seq: 0,
                is_owner: false,
            },
        );
        self.persist_registry()?;
        self.summary(room_id)
    }

    pub fn leave<S: MaterializedStore + ?Sized>(
        &mut self,
        room_id: &str,
        store: &mut S,
    ) -> Result<GroupLeaveOutcome> {
        self.refresh_hub_session()?;
        if !self.rooms.contains_key(room_id) {
            return Ok(GroupLeaveOutcome {
                room_id: room_id.to_owned(),
                left: false,
            });
        }
        // Hub 先行：成员行未删掉就绝不丢弃本地房间，否则重试只会得到 left:false 而 Hub 权限仍在。
        // 删除是幂等的（Hub 404 视为成功），因此“Hub 已删、本地未清”的崩溃可由下次调用收敛。
        if let Some(client) = &self.hub_client
            && client.session_token().is_some()
        {
            block_on(client.remove_group_member(room_id, self.agent_id))?;
        }
        // 尾步骤全部先于“移出内存”完成：任一失败都能原地重试，绝不返回 left:false。
        let (proposal, local_epoch, parent_seq) = {
            let room =
                self.rooms
                    .get_mut(room_id)
                    .ok_or_else(|| QuetzalcoatlError::PermissionDenied {
                        detail: format!("群 {room_id} 未加入"),
                    })?;
            let parent_seq = room.semantic_read_seq;
            let proposal = room.engine.leave_proposal()?;
            (proposal, room.engine.mls_epoch(), parent_seq)
        };
        // 离群提案同样要进 Hub 群日志，其余成员才能在同步时应用。
        // 已被踢出的成员重试时 Hub 会 403/409：此时提案无人需要，视为已完成。
        match self.publish_mls_message(room_id, local_epoch, parent_seq, &proposal, false) {
            Ok(seq) => self.note_published_seq(room_id, seq),
            Err(err @ QuetzalcoatlError::PermissionDenied { .. })
            | Err(err @ QuetzalcoatlError::WatermarkConflict { .. }) => {
                let _ = err;
            }
            Err(err) => return Err(err),
        }
        let proposal_path = format!("groups/leave/{room_id}");
        store.put_private_blob(&proposal_path, &base64_encode(&proposal))?;
        let room =
            self.rooms
                .get_mut(room_id)
                .ok_or_else(|| QuetzalcoatlError::PermissionDenied {
                    detail: format!("群 {room_id} 未加入"),
                })?;
        room.engine.persist_to(store)?;
        // 先写“不含该房间”的注册表，成功后才从内存移除：写盘失败则内存原样保留可重试。
        self.persist_registry_excluding(room_id)?;
        self.rooms.remove(room_id);
        Ok(GroupLeaveOutcome {
            room_id: room_id.to_owned(),
            left: true,
        })
    }

    /// 重新读取截止 Hub 真头的水位线（用于冲突后人工确认已重读全部增量）。
    pub fn sync_watermark<S: MaterializedStore + ?Sized>(
        &mut self,
        room_id: &str,
        store: &mut S,
    ) -> Result<GroupRoomSummary> {
        let Some(plan) = self.sync_plan(room_id)? else {
            return self.summary(room_id);
        };
        let prepared = Self::fetch_sync(&plan)?;
        self.apply_sync(prepared, store)?;
        // 群主顺带提交已暂存的提案（如成员离群），使轮换对全体成员生效。
        if let Some(owner_plan) = self.plan_owner_commit(room_id, store)? {
            let published = Self::publish_owner_commit(&owner_plan);
            self.finish_owner_commit(owner_plan, published, store)?;
        }
        self.summary(room_id)
    }

    /// 阶段 1（短锁）：快照同步计划，绝不在此发起网络 I/O。
    pub fn sync_plan(&mut self, room_id: &str) -> Result<Option<SyncPlan>> {
        self.refresh_hub_session()?;
        let Some(client) = self
            .hub_client
            .as_ref()
            .filter(|client| client.session_token().is_some())
            .cloned()
        else {
            return Ok(None);
        };
        let room = self
            .rooms
            .get(room_id)
            .ok_or_else(|| QuetzalcoatlError::PermissionDenied {
                detail: format!("群 {room_id} 未加入"),
            })?;
        Ok(Some(SyncPlan {
            room_id: room_id.to_owned(),
            after_seq: room.mls_cursor_seq,
            client,
        }))
    }

    /// 阶段 2（零锁）：分页拉取截止真头的全部提交。
    pub fn fetch_sync(plan: &SyncPlan) -> Result<PreparedSync> {
        let (commits, head_group_seq, _) =
            fetch_commits_until_head(&plan.client, &plan.room_id, plan.after_seq)?;
        Ok(PreparedSync {
            room_id: plan.room_id.clone(),
            commits,
            head_group_seq,
            after_seq: plan.after_seq,
        })
    }

    /// 阶段 3（短锁）：按 `server_seq` 顺序应用 MLS 消息，并登记未消费的语义行。
    ///
    /// 绝不允许乱序：出现缺口立即冲突；重复序号直接跳过；已被本地纪元包含的
    /// 提交（例如入群 Welcome 已带到某纪元）也跳过，避免回放历史 Commit。
    ///
    /// 关键：本方法只推进 **MLS 游标**，绝不推进语义已读水位线。任何未消费的
    /// 约束/点名追问/打断都会被登记为 `pending_semantic_seq`，心跳无法把它冲掉。
    pub fn apply_sync<S: MaterializedStore + ?Sized>(
        &mut self,
        prepared: PreparedSync,
        store: &mut S,
    ) -> Result<GroupRoomSummary> {
        let self_agent = self.agent_id;
        let self_agent_str = self_agent.to_string();
        let mut applied_any = false;
        {
            let room = self.rooms.get_mut(&prepared.room_id).ok_or_else(|| {
                QuetzalcoatlError::PermissionDenied {
                    detail: format!("群 {} 未加入", prepared.room_id),
                }
            })?;
            let mut expected = prepared.after_seq.saturating_add(1);
            for commit in &prepared.commits {
                if commit.server_seq < expected {
                    continue;
                }
                if commit.server_seq != expected {
                    return Err(QuetzalcoatlError::WatermarkConflict {
                        last_seen_seq: expected.saturating_sub(1),
                        head_seq: prepared.head_group_seq,
                    });
                }
                if commit.kind == MLS_COMMIT_KIND {
                    let local_epoch = room.engine.mls_epoch();
                    let from_self = commit.sender_agent_id == self_agent_str;
                    // 只有“同设备”的待定 Commit 才能本地合并；跨设备合并会静默分叉。
                    let same_device =
                        pending_commit_belongs_to_device(&commit.sender_device_id, self.device_id);
                    if commit.mls_epoch > local_epoch {
                        if commit.mls_epoch != local_epoch.saturating_add(1) {
                            // MLS 纪元不得跳步应用：宁可冲突让上层重读，也不乱序合入。
                            return Err(QuetzalcoatlError::WatermarkConflict {
                                last_seen_seq: commit.server_seq.saturating_sub(1),
                                head_seq: prepared.head_group_seq,
                            });
                        }
                        if from_self && same_device && room.engine.has_pending_commit() {
                            // 本机（同一设备）发布后崩溃：待定 Commit 就是这一行。
                            room.engine.commit_pending()?;
                        } else {
                            room.engine
                                .process_incoming(&base64_decode(&commit.ciphertext_b64)?)?;
                        }
                        applied_any = true;
                    } else if commit.mls_epoch == local_epoch {
                        if from_self {
                            // 本机已发布的提交/提案在本地早已生效；同设备仍挂待定则合并收敛。
                            if same_device && room.engine.has_pending_commit() {
                                room.engine.commit_pending()?;
                                applied_any = true;
                            }
                        } else {
                            // 对端当前纪元：先解析（损坏载荷立即 fail closed），
                            // 提案处理失败必须上抛；已合入的历史 Commit 允许幂等重放。
                            use quetzalcoatl_group::mls_room::IncomingMlsKind;
                            let decoded = base64_decode(&commit.ciphertext_b64)?;
                            let kind =
                                quetzalcoatl_group::mls_room::GroupRoomEngine::inspect_incoming(
                                    &decoded,
                                )?;
                            match (kind, room.engine.process_incoming(&decoded)) {
                                (IncomingMlsKind::Proposal, Ok(_)) => applied_any = true,
                                (IncomingMlsKind::Proposal, Err(err)) => return Err(err),
                                (IncomingMlsKind::Commit, Ok(_)) => applied_any = true,
                                (IncomingMlsKind::Commit, Err(_)) => {
                                    // 已在本纪元的 Commit（Welcome/本地合并已包含）：幂等重放。
                                }
                                (IncomingMlsKind::Application, _) => {}
                            }
                        }
                    }
                } else if commit.server_seq > room.semantic_read_seq {
                    // 语义行：登记未读，绝不推进水位线。
                    if let Ok(event) = commit_to_event(commit)
                        && event.is_semantic_for(self_agent, room.semantic_read_seq)
                    {
                        let pending = room
                            .pending_semantic_seq
                            .map_or(commit.server_seq, |seq| seq.min(commit.server_seq));
                        room.pending_semantic_seq = Some(pending);
                    }
                }
                expected = commit.server_seq.saturating_add(1);
            }
            // 提案入队同样属于必须持久化的状态（否则重启后 server_seq 已标记已读却丢提案）。
            if applied_any {
                room.engine.persist_to(store)?;
            }
            room.mls_cursor_seq = prepared.head_group_seq;
        }
        self.persist_registry()?;
        self.summary(&prepared.room_id)
    }

    /// 本房间是否仍有已暂存但未提交的 MLS 提案（诊断/测试用）。
    #[must_use]
    pub fn has_staged_proposals(&self, room_id: &str) -> bool {
        self.rooms
            .get(room_id)
            .is_some_and(|room| room.engine.has_staged_proposals())
    }

    /// 显式消费未读语义水位线：只有在用户/Agent 确认已读之后，发送才恢复。
    pub fn consume_semantic_watermark(&mut self, room_id: &str) -> Result<GroupRoomSummary> {
        {
            let room =
                self.rooms
                    .get_mut(room_id)
                    .ok_or_else(|| QuetzalcoatlError::PermissionDenied {
                        detail: format!("群 {room_id} 未加入"),
                    })?;
            room.semantic_read_seq = room.mls_cursor_seq;
            room.pending_semantic_seq = None;
        }
        self.persist_registry()?;
        self.summary(room_id)
    }

    /// 短锁阶段：群主把已暂存的提案（如成员离群）组装成 Commit，并先持久化待定状态。
    pub fn plan_owner_commit<S: MaterializedStore + ?Sized>(
        &mut self,
        room_id: &str,
        store: &mut S,
    ) -> Result<Option<OwnerCommitPlan>> {
        self.refresh_hub_session()?;
        let client = self
            .hub_client
            .as_ref()
            .filter(|client| client.session_token().is_some())
            .cloned();
        let Some(room) = self.rooms.get_mut(room_id) else {
            return Ok(None);
        };
        if !room.is_owner || !room.engine.has_staged_proposals() || room.engine.has_pending_commit()
        {
            return Ok(None);
        }
        let mls_epoch = room.engine.mls_epoch().saturating_add(1);
        let parent_seq = room.semantic_read_seq;
        let commit = room.engine.commit_pending_proposals()?;
        // 先落盘待定状态：发布后崩溃可在重启时通过合并待定 Commit 收敛。
        room.engine.persist_to(store)?;
        Ok(Some(OwnerCommitPlan {
            room_id: room_id.to_owned(),
            mls_epoch,
            parent_seq,
            commit,
            client,
            agent_id: self.agent_id,
            device_id: self.device_id,
        }))
    }

    /// 零锁阶段：把群主 Commit 发布到 Hub 群日志（无 Hub 时返回 `None`）。
    pub fn publish_owner_commit(plan: &OwnerCommitPlan) -> Result<Option<u64>> {
        let Some(client) = &plan.client else {
            return Ok(None);
        };
        let receipt = block_on(client.append_group_commit(
            &plan.room_id,
            plan.agent_id,
            plan.device_id,
            plan.mls_epoch,
            plan.parent_seq,
            &serde_json::json!([]),
            &base64_encode(&plan.commit),
            MLS_COMMIT_KIND,
            "agent",
            true,
        ))?;
        Ok(Some(receipt.server_seq))
    }

    /// 短锁阶段：合并群主 Commit（发布失败则丢弃待定状态，提案仍在队列里可重试）。
    pub fn finish_owner_commit<S: MaterializedStore + ?Sized>(
        &mut self,
        plan: OwnerCommitPlan,
        published: Result<Option<u64>>,
        store: &mut S,
    ) -> Result<()> {
        match published {
            Ok(seq) => {
                if let Some(room) = self.rooms.get_mut(&plan.room_id) {
                    room.engine.commit_pending()?;
                    room.engine.persist_to(store)?;
                }
                self.note_published_seq(&plan.room_id, seq);
                Ok(())
            }
            Err(err) => {
                self.discard_pending_on(&plan.room_id);
                Err(err)
            }
        }
    }

    /// 解密一条群应用消息（仅在已应用对应纪元 Commit 后可解）。
    ///
    /// `consume = true`（默认行为）时同时把语义水位线推进到本次已扫描的位置：
    /// 自动化循环“读 → 发”不再需要额外调用 `group consume`。`peek` 则只读不消费。
    pub fn decrypt_room_message<S: MaterializedStore + ?Sized>(
        &mut self,
        room_id: &str,
        ciphertext_b64: &str,
        consume: bool,
        store: &mut S,
    ) -> Result<String> {
        let bytes = base64_decode(ciphertext_b64)?;
        let plaintext = {
            let room =
                self.rooms
                    .get_mut(room_id)
                    .ok_or_else(|| QuetzalcoatlError::PermissionDenied {
                        detail: format!("群 {room_id} 未加入"),
                    })?;
            let plaintext = room.engine.decrypt_application(&bytes)?;
            room.engine.persist_to(store)?;
            plaintext
        };
        let text =
            String::from_utf8(plaintext).map_err(|_| QuetzalcoatlError::SerializationError {
                detail: String::from("群应用消息不是合法 UTF-8"),
            })?;
        if consume {
            self.consume_semantic_watermark(room_id)?;
        }
        Ok(text)
    }

    /// 确认本机是群主（旧注册表升级用）：Hub 建群对同 owner 幂等返回，据此补写 `is_owner`。
    pub fn claim_owner(&mut self, room_id: &str) -> Result<GroupRoomSummary> {
        self.refresh_hub_session()?;
        let secrecy_level = self
            .rooms
            .get(room_id)
            .ok_or_else(|| QuetzalcoatlError::PermissionDenied {
                detail: format!("群 {room_id} 未加入"),
            })?
            .secrecy_level;
        let Some(client) = self
            .hub_client
            .as_ref()
            .filter(|client| client.session_token().is_some())
        else {
            return Err(QuetzalcoatlError::StorageError {
                detail: String::from("未配置 Hub 会话，无法确认群主身份"),
            });
        };
        block_on(client.create_group_room(room_id, self.agent_id, secrecy_level))?;
        if let Some(room) = self.rooms.get_mut(room_id) {
            room.is_owner = true;
        }
        self.persist_registry()?;
        self.summary(room_id)
    }

    pub fn summaries(&self) -> Vec<GroupRoomSummary> {
        self.rooms
            .keys()
            .filter_map(|room_id| self.summary(room_id).ok())
            .collect()
    }

    pub fn summary(&self, room_id: &str) -> Result<GroupRoomSummary> {
        let room = self
            .rooms
            .get(room_id)
            .ok_or_else(|| QuetzalcoatlError::PermissionDenied {
                detail: format!("群 {room_id} 未加入"),
            })?;
        Ok(GroupRoomSummary {
            room_id: room_id.to_owned(),
            mls_epoch: room.engine.mls_epoch(),
            members: room.engine.members(),
            secrecy_level: room.secrecy_level,
            last_seen_group_seq: room.semantic_read_seq,
            mls_cursor_group_seq: room.mls_cursor_seq,
            own_published_group_seq: room.own_published_seq,
            pending_semantic_group_seq: room.pending_semantic_seq,
            is_owner: room.is_owner,
            hub_connected: self
                .hub_client
                .as_ref()
                .is_some_and(|client| client.session_token().is_some()),
        })
    }

    pub fn members(&self, room_id: &str) -> Result<Vec<GroupMemberView>> {
        let room = self
            .rooms
            .get(room_id)
            .ok_or_else(|| QuetzalcoatlError::PermissionDenied {
                detail: format!("群 {room_id} 未加入"),
            })?;
        let self_identity = room.identity.name().to_owned();
        Ok(room
            .engine
            .members()
            .into_iter()
            .map(|identity| GroupMemberView {
                is_self: identity == self_identity,
                identity,
            })
            .collect())
    }

    /// 协调席持有者视图（由 `FencedLeaseCoordinator` 的 `ActiveRouter` 状态派生）。
    #[must_use]
    pub fn facilitator_holder(witness_epoch: Option<u64>) -> Option<FacilitatorHolder> {
        witness_epoch.map(|witness_epoch| FacilitatorHolder {
            device_id: DeviceId::nil(),
            witness_epoch,
        })
    }

    /// 纯本地发送准备：判定发言权并加密，绝不做任何 Hub 网络 I/O。
    #[allow(clippy::too_many_arguments)]
    pub fn prepare_send(
        &mut self,
        room_id: &str,
        text: &str,
        mentions: Vec<Mention>,
        sender_kind: SenderKind,
        consecutive_agent_hops: u32,
        human_typing_active: bool,
        kind: &str,
        parent_seq: u64,
    ) -> Result<PreparedSend> {
        self.refresh_hub_session()?;
        let room =
            self.rooms
                .get_mut(room_id)
                .ok_or_else(|| QuetzalcoatlError::PermissionDenied {
                    detail: format!("群 {room_id} 未加入"),
                })?;
        // 未消费的语义行（约束/点名追问/打断）必须先显式消费，绝不静默快进。
        if let Some(pending) = room.pending_semantic_seq {
            return Err(pending_conflict(room.semantic_read_seq, pending));
        }
        let floor = room.gate.evaluate(&FloorInput {
            room_id: room_id.to_owned(),
            agent_id: self.agent_id,
            agent_is_owner_instance: true,
            sender_kind,
            sender_signature_verified: sender_kind == SenderKind::OwnerHuman,
            mentions: mentions.clone(),
            consecutive_agent_hops,
            human_typing_active,
            sender_peer_id: self.agent_id.to_string(),
            content: text.to_owned(),
        })?;
        let should_speak = matches!(
            floor.floor_action,
            quetzalcoatl_group::floor_control::FloorAction::Respond
                | quetzalcoatl_group::floor_control::FloorAction::RespondStructuredCardOnce
        );
        let mls_ciphertext = if should_speak {
            room.engine.encrypt_application(text.as_bytes())?
        } else {
            Vec::new()
        };
        let local_epoch = room.engine.mls_epoch();
        let author_kind = match sender_kind {
            SenderKind::PeerAgent => "agent",
            SenderKind::OwnerHuman | SenderKind::OtherHuman => "human",
        };
        Ok(PreparedSend {
            room_id: room_id.to_owned(),
            mls_ciphertext,
            local_epoch,
            last_seen_group_seq: room.semantic_read_seq,
            floor_action: floor.floor_action.as_wire_str().to_owned(),
            authority_envelope: floor.authority_envelope.as_wire_str().to_owned(),
            should_speak,
            mentions,
            kind: kind.to_owned(),
            author_kind: author_kind.to_owned(),
            parent_seq,
            hub_client: self
                .hub_client
                .clone()
                .filter(|c| c.session_token().is_some()),
            agent_id: self.agent_id,
            device_id: self.device_id,
        })
    }

    /// 重新加锁后应用 Hub 定序结果、持久化 MLS 状态与水位线。
    pub fn finish_send<S: MaterializedStore + ?Sized>(
        &mut self,
        prepared: PreparedSend,
        applied: Option<AppliedSend>,
        store: &mut S,
    ) -> Result<GroupSendOutcome> {
        let applied_success = applied.is_some();
        let outcome = {
            let room = self.rooms.get_mut(&prepared.room_id).ok_or_else(|| {
                QuetzalcoatlError::PermissionDenied {
                    detail: format!("群 {} 未加入", prepared.room_id),
                }
            })?;
            if let Some(ref result) = applied {
                room.engine.persist_to(store)?;
                // 自己发出的消息只记入己方游标：绝不越过尚未扫描的对端行。
                room.own_published_seq = room.own_published_seq.max(result.server_seq);
            }
            GroupSendOutcome {
                room_id: prepared.room_id,
                mls_epoch: room.engine.mls_epoch(),
                floor_action: prepared.floor_action,
                authority_envelope: prepared.authority_envelope,
                ciphertext_b64: if prepared.should_speak {
                    let published = applied
                        .as_ref()
                        .map_or(prepared.mls_ciphertext.as_slice(), |result| {
                            result.appended_ciphertext.as_slice()
                        });
                    Some(base64_encode(published))
                } else {
                    None
                },
                server_seq: applied.as_ref().map(|a| a.server_seq),
                causal_parent_seq: applied.as_ref().and_then(|a| a.causal_parent_seq),
                watermark_resolution: applied.as_ref().map(|a| a.watermark_resolution.clone()),
            }
        };
        if applied_success {
            self.persist_registry()?;
        }
        Ok(outcome)
    }

    /// 兼容本地（无 Hub）与单元测试的一体化发送：与 `GroupSend` IPC 完全同一条
    /// prepared → 网络 → finish 路径，绝不静默跳过 Hub 提交。
    #[allow(clippy::too_many_arguments)]
    pub fn send<S: MaterializedStore + ?Sized>(
        &mut self,
        room_id: &str,
        text: &str,
        mentions: Vec<Mention>,
        sender_kind: SenderKind,
        consecutive_agent_hops: u32,
        human_typing_active: bool,
        store: &mut S,
    ) -> Result<GroupSendOutcome> {
        let prepared = self.prepare_send(
            room_id,
            text,
            mentions,
            sender_kind,
            consecutive_agent_hops,
            human_typing_active,
            "message",
            0,
        )?;
        let pushed = push_prepared_to_hub(&prepared);
        let applied = pushed.as_ref().ok().and_then(Clone::clone);
        let outcome = self.finish_send(prepared, applied, store)?;
        pushed?;
        Ok(outcome)
    }

    /// 吊销协管授权：踢出 MLS 成员并轮换 `EpochKey[e+1]`。
    pub fn revoke_steward<S: MaterializedStore + ?Sized>(
        &mut self,
        room_id: &str,
        mls_identity: &[u8],
        store: &mut S,
    ) -> Result<GroupRevokeOutcome> {
        self.refresh_hub_session()?;
        let matching: Vec<StewardGrant> = self
            .stewards
            .list_for_group(room_id)
            .into_iter()
            .filter(|grant| grant.mls_identity == mls_identity)
            .cloned()
            .collect();
        let identity_name = String::from_utf8(mls_identity.to_vec()).map_err(|_| {
            QuetzalcoatlError::invalid_id("revoke-steward", "MLS 成员身份不是合法 UTF-8")
        })?;
        // 可能被重复邀请：必须选**最新的有效**授权，绝不能拿旧吊销记录冒充“已完成”。
        let newest_active = matching
            .iter()
            .filter(|grant| grant.is_active())
            .max_by(|left, right| {
                left.granted_at_ms
                    .cmp(&right.granted_at_ms)
                    .then_with(|| left.grant_id.cmp(&right.grant_id))
            })
            .cloned();
        let Some(grant) = newest_active else {
            if matching.is_empty() {
                return Err(QuetzalcoatlError::PermissionDenied {
                    detail: String::from("目标成员不存在有效协管授权"),
                });
            }
            // 没有有效授权但有历史记录：上一轮已撤销，补写注册表即收敛（幂等尾步骤）。
            self.persist_registry()?;
            let rotated_epoch = self
                .rooms
                .get(room_id)
                .map_or(0, |room| room.engine.mls_epoch());
            return Ok(GroupRevokeOutcome {
                room_id: room_id.to_owned(),
                grant_id: matching[0].grant_id.clone(),
                revoked_identity: identity_name,
                rotated_epoch,
                dropped_management_rights: true,
            });
        };
        // Hub 先行：成员行还活着就绝不先踢 MLS/轮换纪元，否则 Hub 失败会让重试死在
        // “目标成员不在群”，Hub 授权永久残留。DELETE 幂等（404 视为成功）保证重试收敛。
        if let Some(client) = &self.hub_client
            && client.session_token().is_some()
        {
            block_on(client.remove_group_member(room_id, grant.steward_agent_id))?;
        }
        // MLS 踢人 + 纪元轮换；若上次已踢成功（成员已不在群），则跳过以避免重复操作。
        let (pending_commit, new_epoch, revoked_epoch, parent_seq) = {
            let room =
                self.rooms
                    .get_mut(room_id)
                    .ok_or_else(|| QuetzalcoatlError::PermissionDenied {
                        detail: format!("群 {room_id} 未加入"),
                    })?;
            let current = room.engine.mls_epoch();
            if room
                .engine
                .members()
                .iter()
                .any(|member| member == &identity_name)
            {
                let handoff = room.engine.remove_member(&identity_name)?;
                (
                    Some(handoff.commit),
                    handoff.epoch,
                    current,
                    room.semantic_read_seq,
                )
            } else {
                (None, current, current, room.semantic_read_seq)
            }
        };
        if let Some(commit) = &pending_commit {
            // 先把待定 Commit 落盘：发布后崩溃可在重启时合并待定状态收敛。
            if let Some(room) = self.rooms.get(room_id) {
                room.engine.persist_to(store)?;
            }
            // 再把同一份 MLS Commit 发布到 Hub，成功后才在本地推进纪元。
            match self.publish_mls_message(room_id, new_epoch, parent_seq, commit, true) {
                Ok(seq) => self.note_published_seq(room_id, seq),
                Err(err) => {
                    self.discard_pending_on(room_id);
                    return Err(err);
                }
            }
            let room =
                self.rooms
                    .get_mut(room_id)
                    .ok_or_else(|| QuetzalcoatlError::PermissionDenied {
                        detail: format!("群 {room_id} 未加入"),
                    })?;
            room.engine.commit_pending()?;
            room.engine.persist_to(store)?;
        }
        let rotated_epoch = self
            .rooms
            .get(room_id)
            .map_or(new_epoch, |room| room.engine.mls_epoch());
        let revocation =
            self.stewards
                .revoke(&grant.grant_id, revoked_epoch, crate::daemon::now_unix_ms())?;
        self.persist_registry()?;
        Ok(GroupRevokeOutcome {
            room_id: room_id.to_owned(),
            grant_id: revocation.grant_id,
            revoked_identity: identity_name,
            rotated_epoch,
            dropped_management_rights: revocation.dropped_management_rights,
        })
    }
}

fn commit_to_event(commit: &GroupCommitRecord) -> Result<InterveningEvent> {
    // 任何解析失败或未知 kind 一律按“语义约束”处理（fail closed），绝不放行旧水位线。
    let mentions: Vec<Mention> = match serde_json::from_value(commit.mentions.clone()) {
        Ok(parsed) => parsed,
        Err(_) => vec![Mention {
            kind: quetzalcoatl_group::floor_control::MentionKind::AllAgents,
            target_agent_id: None,
        }],
    };
    let kind = match commit.kind.as_str() {
        "message" | "chatter" | "reaction" | "question" | "constraint_update" | "cancel"
        | "steer" | "mls_commit" => commit.kind.clone(),
        _ => String::from("constraint_update"),
    };
    Ok(InterveningEvent {
        seq: commit.server_seq,
        kind,
        mentions,
        parent_seq: Some(commit.causal_parent_seq),
        summary: None,
        emoji: None,
        sender_agent_id: commit.sender_agent_id.parse().ok(),
    })
}

/// 分页拉取截止 `last_seen` 之后的全部提交；任何缺口/截断一律 fail closed。
fn fetch_commits_until_head(
    client: &HubClient,
    room_id: &str,
    last_seen: u64,
) -> Result<(Vec<GroupCommitRecord>, u64, u64)> {
    let mut all = Vec::new();
    let mut cursor = last_seen;
    let mut head;
    let mut epoch;
    loop {
        let (page, page_head, page_epoch) =
            block_on(client.list_group_commits(room_id, cursor, 200))?;
        head = page_head;
        epoch = page_epoch;
        if page.is_empty() {
            break;
        }
        if page
            .first()
            .is_some_and(|first| first.server_seq > cursor.saturating_add(1))
        {
            return Err(QuetzalcoatlError::WatermarkConflict {
                last_seen_seq: cursor,
                head_seq: head,
            });
        }
        let Some(last) = page.last() else {
            break;
        };
        cursor = last.server_seq;
        all.extend(page);
        if cursor >= head {
            break;
        }
    }
    if head > cursor {
        return Err(QuetzalcoatlError::WatermarkConflict {
            last_seen_seq: cursor,
            head_seq: head,
        });
    }
    Ok((all, head, epoch))
}

/// 网络阶段（不持有守护进程全局状态锁）：拉取群头、跑水位线屏障、必要时重加密后提交。
pub fn push_prepared_to_hub(prepared: &PreparedSend) -> Result<Option<AppliedSend>> {
    let Some(client) = &prepared.hub_client else {
        return Ok(None);
    };
    if !prepared.should_speak {
        return Ok(None);
    }
    let (commits, head_seq, hub_epoch) =
        fetch_commits_until_head(client, &prepared.room_id, prepared.last_seen_group_seq)?;
    let events: Vec<InterveningEvent> = commits
        .iter()
        .map(commit_to_event)
        .collect::<Result<Vec<_>>>()?;
    let head = GroupHead {
        group_id: prepared.room_id.clone(),
        head_group_seq: head_seq,
        current_mls_epoch: hub_epoch,
    };
    let submitted = SubmittedCommit {
        last_seen_group_seq: prepared.last_seen_group_seq,
        mls_epoch: prepared.local_epoch,
        submitting_agent_id: prepared.agent_id,
    };
    let barrier = UnreadWatermarkBarrier::resolve(&head, &submitted, &events)?;

    // Layer 1：纪元门禁 fail closed。Hub 领先说明本机还没处理轮换 Commit，缺 `EpochKey[e+1]`，
    // 此时任何重封都会发布接收方无法解开的字节 → 必须冲突待重读；本地领先超过 1 同为真分歧。
    // 只有“持平直发”与“本地恰领先 1 的纯密钥轮换”允许上线。
    let plan = plan_epoch_write(
        prepared.local_epoch,
        hub_epoch,
        prepared.last_seen_group_seq,
        head_seq,
    )?;
    let (target_epoch, reencrypt_only) = match plan {
        EpochWritePlan::PublishCurrent { epoch } => (epoch, false),
        EpochWritePlan::PublishAdvance { epoch } => (epoch, true),
    };
    // 两条可发布路径提交的都是 MLS 本体密文，绝不丢弃 nonce/epoch 再重封；
    // 若将来必须重封，只能发布 `frame_epoch_ciphertext` 的自描述封套。
    let payload = prepared.mls_ciphertext.clone();
    let mentions_json = serde_json::to_value(&prepared.mentions).map_err(|err| {
        QuetzalcoatlError::SerializationError {
            detail: err.to_string(),
        }
    })?;
    let causal_parent = if prepared.parent_seq > 0 {
        prepared.parent_seq
    } else {
        barrier.attached_causal_parent_seq.unwrap_or(0)
    };
    let receipt = block_on(client.append_group_commit(
        &prepared.room_id,
        prepared.agent_id,
        prepared.device_id,
        target_epoch,
        causal_parent,
        &mentions_json,
        &base64_encode(&payload),
        &prepared.kind,
        &prepared.author_kind,
        reencrypt_only,
    ))?;
    Ok(Some(AppliedSend {
        server_seq: receipt.server_seq,
        causal_parent_seq: Some(causal_parent),
        watermark_resolution: barrier.resolution.as_wire_str().to_owned(),
        submitted_epoch: target_epoch,
        appended_ciphertext: payload,
    }))
}

fn hub_runtime() -> Result<&'static tokio::runtime::Runtime> {
    static RUNTIME: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
    if let Some(runtime) = RUNTIME.get() {
        return Ok(runtime);
    }
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|err| storage_error("构造 Hub 群组同步运行时失败", err))?;
    let _ = RUNTIME.set(runtime);
    RUNTIME
        .get()
        .ok_or_else(|| storage_error("Hub 群组同步运行时初始化失败", "OnceLock 未就绪"))
}

fn block_on<F, T>(future: F) -> Result<T>
where
    F: Future<Output = Result<T>>,
{
    hub_runtime()?.block_on(future)
}

#[derive(Serialize, Deserialize)]
struct RegistryEntry {
    room_id: String,
    secrecy_level: u8,
    /// 语义已消费水位线（旧注册表缺省 0）。
    #[serde(default)]
    last_seen_group_seq: u64,
    /// MLS 已应用游标（旧注册表缺省 0，安全地从头重读）。
    #[serde(default)]
    mls_cursor_group_seq: u64,
    /// 未消费的语义行（旧注册表缺省 None）。
    #[serde(default)]
    pending_semantic_group_seq: Option<u64>,
    /// 己方发布游标（旧注册表缺省 0）。
    #[serde(default)]
    own_published_group_seq: u64,
    /// 群主标记（旧注册表缺省 false，绝不擅自替用户提交提案）。
    #[serde(default)]
    is_owner: bool,
}

#[derive(Serialize, Deserialize)]
struct RoomRegistry {
    version: u32,
    rooms: Vec<RegistryEntry>,
    stewards: Vec<StewardGrant>,
}

impl RoomRegistry {
    #[allow(dead_code)]
    fn empty() -> Self {
        Self {
            version: 1,
            rooms: Vec::new(),
            stewards: Vec::new(),
        }
    }
}

#[allow(dead_code)]
fn hub_debug(binding: &GroupHubBinding) -> String {
    format!("{binding:?}")
}

/// 供守护进程状态摘要使用的最小路径引用。
#[allow(dead_code)]
pub fn registry_path_for(home: &Path) -> PathBuf {
    home.join(REGISTRY_REL_PATH)
}

#[cfg(test)]
#[allow(clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;
    use quetzalcoatl_group::floor_control::MentionKind;

    fn record(kind: &str, mentions: serde_json::Value) -> GroupCommitRecord {
        GroupCommitRecord {
            group_id: String::from("room"),
            server_seq: 7,
            mls_epoch: 1,
            causal_parent_seq: 3,
            sender_agent_id: String::from("not-a-valid-agent-id"),
            sender_device_id: String::from("dev"),
            mentions,
            ciphertext_b64: String::from("Y3Q="),
            kind: String::from(kind),
            author_kind: String::from("agent"),
            hop: 2,
            created_at_ms: 0,
        }
    }

    #[test]
    fn epoch_write_plan_fails_closed_and_only_allows_single_step_advance() {
        assert_eq!(
            plan_epoch_write(0, 0, 3, 3),
            Ok(EpochWritePlan::PublishCurrent { epoch: 0 })
        );
        assert_eq!(
            plan_epoch_write(4, 4, 3, 3),
            Ok(EpochWritePlan::PublishCurrent { epoch: 4 })
        );
        assert_eq!(
            plan_epoch_write(5, 4, 3, 3),
            Ok(EpochWritePlan::PublishAdvance { epoch: 5 })
        );
        // Hub 领先：本机没有 EpochKey[e+1]，绝不能重封后上线。
        for (local, hub) in [(4u64, 5u64), (1, 9), (0, u64::MAX)] {
            match plan_epoch_write(local, hub, 7, 11) {
                Err(QuetzalcoatlError::WatermarkConflict {
                    last_seen_seq,
                    head_seq,
                }) => {
                    assert_eq!((last_seen_seq, head_seq), (7, 11));
                }
                other => panic!("hub-ahead must conflict, got {other:?}"),
            }
        }
        // 本地领先超过 1：真分歧，同样冲突。
        for (local, hub) in [(2u64, 0u64), (9, 4)] {
            assert!(matches!(
                plan_epoch_write(local, hub, 1, 2),
                Err(QuetzalcoatlError::WatermarkConflict { .. })
            ));
        }
    }

    #[test]
    fn unknown_kind_and_unparseable_mentions_fail_closed_to_semantic() {
        // 未知 kind 绝不能被当成 chatter 快进：升格为语义约束。
        let event = commit_to_event(&record("totally_unknown", serde_json::json!([])))
            .expect("event conversion must succeed");
        assert_eq!(event.kind, "constraint_update");

        // mentions 解析失败也必须保守地视为 @all_agents。
        let event = commit_to_event(&record("message", serde_json::json!("not-an-array")))
            .expect("event conversion must succeed");
        assert_eq!(event.mentions.len(), 1);
        assert_eq!(event.mentions[0].kind, MentionKind::AllAgents);

        // 发送者 ID 不可解析时视为他人（None），不得据以豁免重读。
        assert!(event.sender_agent_id.is_none());
    }
}
