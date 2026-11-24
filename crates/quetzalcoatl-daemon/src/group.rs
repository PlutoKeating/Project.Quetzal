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
    GroupHead, InterveningEvent, SubmittedCommit, UnreadWatermarkBarrier, reencrypt_with_new_epoch,
    seal_with_epoch_key,
};
use quetzalcoatl_group::facilitator::FacilitatorHolder;
use quetzalcoatl_group::floor_control::{AnpP9FloorGate, FloorInput, Mention, SenderKind};
use quetzalcoatl_group::mls_room::{GroupRoomEngine, MlsIdentity, PendingJoin};
use quetzalcoatl_group::steward::{StewardGrant, StewardRegistry};
use quetzalcoatl_spine::MaterializedStore;
use quetzalcoatl_types::{AgentId, DeviceId, QuetzalcoatlError, Result};
use serde::{Deserialize, Serialize};

const REGISTRY_REL_PATH: &str = "group-rooms/registry.json";

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
    pub last_seen_group_seq: u64,
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
    pub epoch_master: [u8; 32],
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

/// Hub 原子定序结果（网络阶段产出，重新加锁后应用）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AppliedSend {
    pub server_seq: u64,
    pub causal_parent_seq: Option<u64>,
    pub watermark_resolution: String,
    pub submitted_epoch: u64,
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
    last_seen_group_seq: u64,
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
        let entries: Vec<RegistryEntry> = self
            .rooms
            .iter()
            .map(|(room_id, room)| RegistryEntry {
                room_id: room_id.clone(),
                secrecy_level: room.secrecy_level,
                last_seen_group_seq: room.last_seen_group_seq,
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
                    last_seen_group_seq: entry.last_seen_group_seq,
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
                last_seen_group_seq: 0,
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
        let room =
            self.rooms
                .get_mut(room_id)
                .ok_or_else(|| QuetzalcoatlError::PermissionDenied {
                    detail: format!("群 {room_id} 尚未在本机创建/加入"),
                })?;
        let handoff = room.engine.add_member(&key_package)?;
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
                last_seen_group_seq: 0,
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
        let Some(mut room) = self.rooms.remove(room_id) else {
            return Ok(GroupLeaveOutcome {
                room_id: room_id.to_owned(),
                left: false,
            });
        };
        // MLS 自我移除必须以离群提案表达（协议禁止自提交移除）；Hub 成员行同步删除。
        let proposal = room.engine.leave_proposal()?;
        let proposal_path = format!("groups/leave/{room_id}");
        store.put_private_blob(&proposal_path, &base64_encode(&proposal))?;
        room.engine.persist_to(store)?;
        if let Some(client) = &self.hub_client
            && client.session_token().is_some()
        {
            // 已被踢出的成员再次 leave 属幂等成功；仅真正的授权错误才上抛。
            match block_on(client.remove_group_member(room_id, self.agent_id)) {
                Ok(()) | Err(QuetzalcoatlError::PermissionDenied { .. }) => {}
                Err(err) => return Err(err),
            }
        }
        self.persist_registry()?;
        Ok(GroupLeaveOutcome {
            room_id: room_id.to_owned(),
            left: true,
        })
    }

    /// 重新读取截止 Hub 真头的水位线（用于冲突后人工确认已重读全部增量）。
    pub fn sync_watermark(&mut self, room_id: &str) -> Result<GroupRoomSummary> {
        self.refresh_hub_session()?;
        let Some(client) = self
            .hub_client
            .clone()
            .filter(|client| client.session_token().is_some())
        else {
            return self.summary(room_id);
        };
        let last_seen = self
            .rooms
            .get(room_id)
            .ok_or_else(|| QuetzalcoatlError::PermissionDenied {
                detail: format!("群 {room_id} 未加入"),
            })?
            .last_seen_group_seq;
        let (_, head, _) = fetch_commits_until_head(&client, room_id, last_seen)?;
        if let Some(room) = self.rooms.get_mut(room_id) {
            room.last_seen_group_seq = head;
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
            last_seen_group_seq: room.last_seen_group_seq,
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
        let epoch_master = room.engine.epoch_secret()?;
        let author_kind = match sender_kind {
            SenderKind::PeerAgent => "agent",
            SenderKind::OwnerHuman | SenderKind::OtherHuman => "human",
        };
        Ok(PreparedSend {
            room_id: room_id.to_owned(),
            mls_ciphertext,
            local_epoch,
            epoch_master,
            last_seen_group_seq: room.last_seen_group_seq,
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
                room.last_seen_group_seq = result.server_seq;
            }
            GroupSendOutcome {
                room_id: prepared.room_id,
                mls_epoch: room.engine.mls_epoch(),
                floor_action: prepared.floor_action,
                authority_envelope: prepared.authority_envelope,
                ciphertext_b64: if prepared.should_speak {
                    Some(base64_encode(&prepared.mls_ciphertext))
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

    /// 兼容本地（无 Hub）与单元测试的一体化发送。
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
        self.finish_send(prepared, None, store)
    }

    /// 吊销协管授权：踢出 MLS 成员并轮换 `EpochKey[e+1]`。
    pub fn revoke_steward<S: MaterializedStore + ?Sized>(
        &mut self,
        room_id: &str,
        mls_identity: &[u8],
        store: &mut S,
    ) -> Result<GroupRevokeOutcome> {
        self.refresh_hub_session()?;
        let grant = self
            .stewards
            .list_for_group(room_id)
            .into_iter()
            .find(|grant| grant.mls_identity == mls_identity && grant.is_active())
            .cloned()
            .ok_or_else(|| QuetzalcoatlError::PermissionDenied {
                detail: String::from("目标成员不存在有效协管授权"),
            })?;
        let identity_name = String::from_utf8(mls_identity.to_vec()).map_err(|_| {
            QuetzalcoatlError::invalid_id("revoke-steward", "MLS 成员身份不是合法 UTF-8")
        })?;
        // 顺序：先 MLS 踢人 + 纪元轮换，再删除 Hub 成员行，最后持久化授权状态。
        let (rotated_epoch, revoked_epoch) = {
            let room =
                self.rooms
                    .get_mut(room_id)
                    .ok_or_else(|| QuetzalcoatlError::PermissionDenied {
                        detail: format!("群 {room_id} 未加入"),
                    })?;
            let revoked_epoch = room.engine.mls_epoch();
            room.engine.remove_member(&identity_name)?;
            room.engine.commit_pending()?;
            room.engine.persist_to(store)?;
            (room.engine.mls_epoch(), revoked_epoch)
        };
        if let Some(client) = &self.hub_client
            && client.session_token().is_some()
        {
            block_on(client.remove_group_member(room_id, grant.steward_agent_id))?;
        }
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
        | "steer" => commit.kind.clone(),
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

    // Layer 1：真正把同一密文换封到目标纪元密钥；绝不重跑模型。
    // 目标纪元 = max(本地, Hub)：Hub 领先 → 重封到 Hub 新纪元；本地领先 → 显式标记纯密钥轮换。
    let target_epoch = prepared.local_epoch.max(hub_epoch);
    let reencrypt_only = target_epoch != hub_epoch;
    let payload = if target_epoch != prepared.local_epoch {
        let sealed_local = seal_with_epoch_key(
            &prepared.epoch_master,
            prepared.local_epoch,
            &prepared.mls_ciphertext,
        )?;
        reencrypt_with_new_epoch(
            &prepared.epoch_master,
            &prepared.epoch_master,
            target_epoch,
            &sealed_local,
        )?
        .ciphertext
    } else {
        prepared.mls_ciphertext.clone()
    };
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
    last_seen_group_seq: u64,
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
#[allow(clippy::expect_used)]
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
