//! `openmls` 端到端加密群房间引擎：建群、KeyPackage 邀请、欢迎加入、踢人纪元轮换、
//! 应用消息加解密与确定性脊柱持久化。

use std::collections::BTreeMap;

use ed25519_dalek::SigningKey;
use openmls::prelude::{
    BasicCredential, Ciphersuite, Credential, CredentialType, CredentialWithKey, GroupId, MlsGroup,
    MlsGroupCreateConfig, MlsGroupJoinConfig, MlsMessageIn, MlsMessageOut, ProcessedMessageContent,
    RatchetTreeIn, StagedWelcome,
    tls_codec::{Deserialize as _, DeserializeBytes as _, Serialize as _},
};
use openmls_memory_storage::MemoryStorage;
use openmls_rust_crypto::RustCrypto;
use openmls_traits::{
    OpenMlsProvider,
    signatures::{Signer, SignerError},
};
use quetzalcoatl_crypto::hex_encode;
use quetzalcoatl_spine::MaterializedStore;
use quetzalcoatl_types::{AgentId, QuetzalcoatlError, Result};
use rand_core::OsRng;
use serde::{Deserialize, Serialize};

/// 处理入站 MLS 控制消息后的结果。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IncomingMlsOutcome {
    /// 合并了一个 Commit，群纪元已推进。
    CommitApplied,
    /// 暂存了一个提案，群纪元不变（需群主提交后才生效）。
    ProposalStaged,
}

const GROUP_CIPHERSUITE: Ciphersuite = Ciphersuite::MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519;
const EPOCH_SECRET_LABEL: &str = "quetzalcoatl/v2/group-epoch-key-v1";
const PERSIST_VERSION: u32 = 1;
const STATE_DOC_PREFIX: &str = "groups/mls";

fn mls_error(context: &str, err: impl std::fmt::Display) -> QuetzalcoatlError {
    QuetzalcoatlError::IntegrityViolation {
        detail: format!("{context}: {err}"),
    }
}

/// MLS 签名的 Ed25519 身份（身份字符串即 openmls BasicCredential identity）。
#[derive(Clone)]
pub struct MlsIdentity {
    identity: String,
    signing_key: SigningKey,
}

impl std::fmt::Debug for MlsIdentity {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MlsIdentity")
            .field("identity", &self.identity)
            .field("public_key_hex", &self.public_key_hex())
            .finish_non_exhaustive()
    }
}

impl MlsIdentity {
    /// 由操作系统 CSPRNG 生成全新的群成员身份。
    pub fn generate(identity: &str) -> Result<Self> {
        if identity.trim().is_empty() {
            return Err(QuetzalcoatlError::invalid_id(
                "MlsIdentity",
                "群成员身份字符串不能为空",
            ));
        }
        Ok(Self {
            identity: identity.to_owned(),
            signing_key: SigningKey::generate(&mut OsRng),
        })
    }

    /// 由固定 32 字节种子确定性重建身份（测试与跨重启恢复）。
    pub fn from_seed(identity: &str, seed: [u8; 32]) -> Result<Self> {
        if identity.trim().is_empty() {
            return Err(QuetzalcoatlError::invalid_id(
                "MlsIdentity",
                "群成员身份字符串不能为空",
            ));
        }
        Ok(Self {
            identity: identity.to_owned(),
            signing_key: SigningKey::from_bytes(&seed),
        })
    }

    #[must_use]
    pub fn name(&self) -> &str {
        &self.identity
    }

    #[must_use]
    pub fn identity_bytes(&self) -> Vec<u8> {
        self.identity.as_bytes().to_vec()
    }

    /// 由 MLS 公钥确定性派生的 Agent 标识符（1 Agent = 1 独占脊柱）。
    #[must_use]
    pub fn agent_identity(&self) -> AgentId {
        let digest = blake3::hash(&self.identity_bytes());
        let mut raw = [0u8; 16];
        raw.copy_from_slice(&digest.as_bytes()[..16]);
        AgentId::from_bytes(raw)
    }

    #[must_use]
    pub fn public_key_hex(&self) -> String {
        hex_encode(&self.verifying_key_bytes())
    }

    #[must_use]
    fn verifying_key_bytes(&self) -> [u8; 32] {
        self.signing_key.verifying_key().to_bytes()
    }

    #[must_use]
    pub fn signing_key(&self) -> &SigningKey {
        &self.signing_key
    }

    fn credential_with_key(&self) -> CredentialWithKey {
        CredentialWithKey {
            credential: Credential::new(CredentialType::Basic, self.identity_bytes()),
            signature_key: self.verifying_key_bytes().to_vec().into(),
        }
    }
}

/// `openmls` 提供商：显式公开 `MemoryStorage`，以便对群状态做确定性快照与脊柱持久化。
#[derive(Default)]
pub struct RoomProvider {
    storage: MemoryStorage,
    crypto: RustCrypto,
}

impl OpenMlsProvider for RoomProvider {
    type CryptoProvider = RustCrypto;
    type RandProvider = RustCrypto;
    type StorageProvider = MemoryStorage;

    fn storage(&self) -> &Self::StorageProvider {
        &self.storage
    }

    fn crypto(&self) -> &Self::CryptoProvider {
        &self.crypto
    }

    fn rand(&self) -> &Self::RandProvider {
        &self.crypto
    }
}

impl RoomProvider {
    /// 按 `(key, value)` 字典序生成确定性快照，供 `quetzalcoatl-spine` 物化存储。
    fn snapshot_entries(&self) -> Result<Vec<(String, String)>> {
        let guard = self
            .storage
            .values
            .read()
            .map_err(|_| QuetzalcoatlError::StorageError {
                detail: String::from("MLS MemoryStorage 读锁中毒"),
            })?;
        let mut entries: BTreeMap<String, String> = BTreeMap::new();
        for (key, value) in guard.iter() {
            entries.insert(hex_encode(key), hex_encode(value));
        }
        Ok(entries.into_iter().collect())
    }

    fn restore_from(entries: &[(String, String)]) -> Result<Self> {
        let provider = Self::default();
        {
            let mut guard =
                provider
                    .storage
                    .values
                    .write()
                    .map_err(|_| QuetzalcoatlError::StorageError {
                        detail: String::from("MLS MemoryStorage 写锁中毒"),
                    })?;
            for (key_hex, value_hex) in entries {
                let key = decode_hex(key_hex)?;
                let value = decode_hex(value_hex)?;
                guard.insert(key, value);
            }
        }
        Ok(provider)
    }
}

fn decode_hex(raw: &str) -> Result<Vec<u8>> {
    let bytes = raw.as_bytes();
    if !bytes.len().is_multiple_of(2) {
        return Err(QuetzalcoatlError::SerializationError {
            detail: String::from("MLS 持久化快照包含奇数长度十六进制"),
        });
    }
    let mut out = Vec::with_capacity(bytes.len() / 2);
    for idx in (0..bytes.len()).step_by(2) {
        let hi =
            decode_nibble(bytes[idx]).ok_or_else(|| QuetzalcoatlError::SerializationError {
                detail: String::from("MLS 持久化快照包含非法十六进制字符"),
            })?;
        let lo =
            decode_nibble(bytes[idx + 1]).ok_or_else(|| QuetzalcoatlError::SerializationError {
                detail: String::from("MLS 持久化快照包含非法十六进制字符"),
            })?;
        out.push((hi << 4) | lo);
    }
    Ok(out)
}

const fn decode_nibble(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

struct RoomSigner {
    key: SigningKey,
}

impl Signer for RoomSigner {
    fn sign(&self, payload: &[u8]) -> std::result::Result<Vec<u8>, SignerError> {
        use ed25519_dalek::Signer as _;
        Ok(self.key.sign(payload).to_bytes().to_vec())
    }

    fn signature_scheme(&self) -> openmls_traits::types::SignatureScheme {
        openmls_traits::types::SignatureScheme::ED25519
    }
}

/// 邀请/加人交接载荷：提交、欢迎消息与（可选）棘轮树。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct JoinHandoff {
    pub commit: Vec<u8>,
    pub welcome: Vec<u8>,
    pub ratchet_tree: Vec<u8>,
    /// 被邀请成员的 openmls BasicCredential identity（用于绑定 `StewardGrant`）。
    pub member_identity: Vec<u8>,
    pub epoch: u64,
}

/// 踢人交接载荷。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RemovalHandoff {
    pub commit: Vec<u8>,
    pub epoch: u64,
}

/// 已生成 KeyPackage 但尚未处理 Welcome 的入群等待态。
///
/// 必须复用同一 `RoomProvider` 才能找回 KeyPackage 私钥材料，因此入群是两阶段的。
pub struct PendingJoin {
    room_id: String,
    identity: MlsIdentity,
    provider: RoomProvider,
    key_package_bytes: Vec<u8>,
}

impl PendingJoin {
    #[must_use]
    pub fn key_package_bytes(&self) -> &[u8] {
        &self.key_package_bytes
    }

    #[must_use]
    pub fn room_id(&self) -> &str {
        &self.room_id
    }

    /// 本成员在 MLS 群内的身份字节（与 `StewardGrant` 绑定同一成员身份）。
    #[must_use]
    pub fn identity_bytes(&self) -> Vec<u8> {
        self.identity.identity_bytes()
    }

    #[must_use]
    pub fn identity_name(&self) -> &str {
        self.identity.name()
    }
}

/// `openmls` 群房间引擎。
pub struct GroupRoomEngine {
    room_id: String,
    identity: MlsIdentity,
    provider: RoomProvider,
    group: MlsGroup,
    signer: RoomSigner,
}

impl std::fmt::Debug for GroupRoomEngine {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("GroupRoomEngine")
            .field("room_id", &self.room_id)
            .field("epoch", &self.group.epoch().as_u64())
            .field("members", &self.members())
            .finish_non_exhaustive()
    }
}

impl GroupRoomEngine {
    fn group_id(room_id: &str) -> GroupId {
        GroupId::from_slice(room_id.as_bytes())
    }

    fn build_group(
        provider: &RoomProvider,
        signer: &RoomSigner,
        identity: &MlsIdentity,
        room_id: &str,
    ) -> Result<MlsGroup> {
        let create_config = MlsGroupCreateConfig::builder()
            .ciphersuite(GROUP_CIPHERSUITE)
            .use_ratchet_tree_extension(true)
            .build();
        MlsGroup::new_with_group_id(
            provider,
            signer,
            &create_config,
            Self::group_id(room_id),
            identity.credential_with_key(),
        )
        .map_err(|err| mls_error("创建 MLS 群失败", err))
    }

    /// 建群（创建者即为唯一初始成员）。
    pub fn create(room_id: &str, identity: &MlsIdentity) -> Result<Self> {
        if room_id.trim().is_empty() {
            return Err(QuetzalcoatlError::invalid_id(
                "GroupRoomEngine",
                "群房间 ID 不能为空",
            ));
        }
        let provider = RoomProvider::default();
        let signer = RoomSigner {
            key: identity.signing_key().clone(),
        };
        let group = Self::build_group(&provider, &signer, identity, room_id)?;
        Ok(Self {
            room_id: room_id.to_owned(),
            identity: identity.clone(),
            provider,
            group,
            signer,
        })
    }

    /// 阶段一：生成本成员一次性 KeyPackage（邀请交接给群主）。
    pub fn prepare_join(room_id: &str, identity: &MlsIdentity) -> Result<PendingJoin> {
        let provider = RoomProvider::default();
        let signer = RoomSigner {
            key: identity.signing_key().clone(),
        };
        let bundle = openmls::prelude::KeyPackage::builder()
            .build(
                GROUP_CIPHERSUITE,
                &provider,
                &signer,
                identity.credential_with_key(),
            )
            .map_err(|err| mls_error("生成 KeyPackage 失败", err))?;
        let key_package_bytes = bundle
            .key_package()
            .tls_serialize_detached()
            .map_err(|err| mls_error("序列化 KeyPackage 失败", err))?;
        Ok(PendingJoin {
            room_id: room_id.to_owned(),
            identity: identity.clone(),
            provider,
            key_package_bytes,
        })
    }

    /// 阶段二：消费群主下发的 Welcome，加入群房间。
    pub fn join(
        pending: PendingJoin,
        welcome_bytes: &[u8],
        ratchet_tree_bytes: &[u8],
    ) -> Result<Self> {
        let mut welcome_cursor = welcome_bytes;
        let welcome_message = MlsMessageIn::tls_deserialize(&mut welcome_cursor)
            .map_err(|err| mls_error("解析 Welcome 失败", err))?;
        let welcome = match welcome_message.extract() {
            openmls::prelude::MlsMessageBodyIn::Welcome(welcome) => welcome,
            _ => {
                return Err(QuetzalcoatlError::IntegrityViolation {
                    detail: String::from("入群消息不是 MLS Welcome"),
                });
            }
        };
        let ratchet_tree = if ratchet_tree_bytes.is_empty() {
            None
        } else {
            Some(
                RatchetTreeIn::tls_deserialize_exact_bytes(ratchet_tree_bytes)
                    .map_err(|err| mls_error("解析棘轮树失败", err))?,
            )
        };
        let join_config = MlsGroupJoinConfig::builder()
            .use_ratchet_tree_extension(true)
            .build();
        let group =
            StagedWelcome::new_from_welcome(&pending.provider, &join_config, welcome, ratchet_tree)
                .map_err(|err| mls_error("Welcome 校验失败", err))?
                .into_group(&pending.provider)
                .map_err(|err| mls_error("落库入群状态失败", err))?;
        let signer = RoomSigner {
            key: pending.identity.signing_key().clone(),
        };
        Ok(Self {
            room_id: pending.room_id,
            identity: pending.identity,
            provider: pending.provider,
            group,
            signer,
        })
    }

    #[must_use]
    pub fn room_id(&self) -> &str {
        &self.room_id
    }

    /// 本成员在 MLS 群内的身份字节（与 `StewardGrant` 绑定同一成员身份）。
    #[must_use]
    pub fn identity_bytes(&self) -> Vec<u8> {
        self.identity.identity_bytes()
    }

    #[must_use]
    pub fn identity_name(&self) -> &str {
        self.identity.name()
    }

    #[must_use]
    pub fn mls_epoch(&self) -> u64 {
        self.group.epoch().as_u64()
    }

    /// 当前 `EpochKey[e]` 导出的 32 字节群纪元密钥（用于 Hub Layer 1 重加密与清洗核对）。
    pub fn epoch_secret(&self) -> Result<[u8; 32]> {
        let raw = self
            .group
            .export_secret(
                self.provider.crypto(),
                EPOCH_SECRET_LABEL,
                self.room_id.as_bytes(),
                32,
            )
            .map_err(|err| mls_error("导出群纪元密钥失败", err))?;
        let mut out = [0u8; 32];
        if raw.len() != out.len() {
            return Err(QuetzalcoatlError::IntegrityViolation {
                detail: format!("导出的群纪元密钥长度异常: {}", raw.len()),
            });
        }
        out.copy_from_slice(&raw);
        Ok(out)
    }

    /// 当前成员身份列表（按字典序稳定排序）。
    #[must_use]
    pub fn members(&self) -> Vec<String> {
        let mut names: Vec<String> = self
            .group
            .members()
            .filter_map(|member| {
                BasicCredential::try_from(member.credential.clone())
                    .ok()
                    .and_then(|basic| String::from_utf8(basic.identity().to_vec()).ok())
            })
            .collect();
        names.sort();
        names
    }

    /// 邀请新成员：生成待合并 Commit，并返回 Welcome 交接载荷。
    pub fn add_member(&mut self, key_package_bytes: &[u8]) -> Result<JoinHandoff> {
        let key_package =
            openmls::prelude::KeyPackageIn::tls_deserialize_exact_bytes(key_package_bytes)
                .map_err(|err| mls_error("解析 KeyPackage 失败", err))?
                .validate(
                    self.provider.crypto(),
                    openmls::prelude::ProtocolVersion::Mls10,
                )
                .map_err(|err| mls_error("KeyPackage 验签失败", err))?;
        let member_identity =
            BasicCredential::try_from(key_package.leaf_node().credential().clone())
                .map_err(|err| mls_error("KeyPackage 凭据类型非法", err))?
                .identity()
                .to_vec();
        let (commit, welcome, _group_info) = self
            .group
            .add_members(
                &self.provider,
                &self.signer,
                std::slice::from_ref(&key_package),
            )
            .map_err(|err| mls_error("添加群成员失败", err))?;
        let commit_bytes = serialize_message(&commit)?;
        let welcome_bytes = serialize_message(&welcome)?;
        let ratchet_tree = self
            .group
            .export_ratchet_tree()
            .tls_serialize_detached()
            .map_err(|err| mls_error("序列化棘轮树失败", err))?;
        Ok(JoinHandoff {
            commit: commit_bytes,
            welcome: welcome_bytes,
            ratchet_tree,
            member_identity,
            epoch: self.mls_epoch().saturating_add(1),
        })
    }

    /// 提交本地待定 Commit（加人/踢人后必须调用，纪元才正式推进）。
    pub fn commit_pending(&mut self) -> Result<u64> {
        self.group
            .merge_pending_commit(&self.provider)
            .map_err(|err| mls_error("合并待定 Commit 失败", err))?;
        Ok(self.mls_epoch())
    }

    /// 丢弃本地待定 Commit（发布到 Hub 失败时回滚，保证重试不会卡在 PendingCommitExists）。
    pub fn discard_pending_commit(&mut self) -> Result<()> {
        self.group
            .clear_pending_commit(self.provider.storage())
            .map_err(|err| mls_error("丢弃待定 Commit 失败", err))
    }

    /// 生成 MLS `Leave`（SelfRemove/Remove）提案；自我移除必须由其他成员提交，
    /// 因此本方法只产出提案，Hub 侧成员撤销由守护进程另行执行。
    pub fn leave_proposal(&mut self) -> Result<Vec<u8>> {
        let proposal = self
            .group
            .leave_group(&self.provider, &self.signer)
            .map_err(|err| mls_error("生成离群提案失败", err))?;
        serialize_message(&proposal)
    }

    /// 踢出成员：生成待合并 Commit 并返回新纪元编号。
    pub fn remove_member(&mut self, member_identity: &str) -> Result<RemovalHandoff> {
        let target = member_identity.as_bytes();
        let index = self
            .group
            .members()
            .find(|member| {
                BasicCredential::try_from(member.credential.clone())
                    .ok()
                    .is_some_and(|basic| basic.identity() == target)
            })
            .map(|member| member.index)
            .ok_or_else(|| QuetzalcoatlError::PermissionDenied {
                detail: format!(
                    "目标成员 {member_identity} 不在群 {room}",
                    room = self.room_id
                ),
            })?;
        let (commit, _welcome, _group_info) = self
            .group
            .remove_members(&self.provider, &self.signer, &[index])
            .map_err(|err| mls_error("移除群成员失败", err))?;
        Ok(RemovalHandoff {
            commit: serialize_message(&commit)?,
            epoch: self.mls_epoch().saturating_add(1),
        })
    }

    /// 处理其他成员下发的 Commit / Proposal。
    pub fn process_incoming(&mut self, message_bytes: &[u8]) -> Result<IncomingMlsOutcome> {
        let mut message_cursor = message_bytes;
        let message = MlsMessageIn::tls_deserialize(&mut message_cursor)
            .map_err(|err| mls_error("解析群消息失败", err))?;
        let protocol_message = message
            .try_into_protocol_message()
            .map_err(|err| mls_error("群消息不是可处理协议消息", err))?;
        let processed = self
            .group
            .process_message(&self.provider, protocol_message)
            .map_err(|err| mls_error("处理群消息失败", err))?;
        match processed.into_content() {
            ProcessedMessageContent::StagedCommitMessage(staged) => {
                self.group
                    .merge_staged_commit(&self.provider, *staged)
                    .map_err(|err| mls_error("合并群 Commit 失败", err))?;
                Ok(IncomingMlsOutcome::CommitApplied)
            }
            ProcessedMessageContent::ProposalMessage(proposal) => {
                // openmls 不自动入队：必须显式存储提案，后续由群主提交生效。
                self.group
                    .store_pending_proposal(self.provider.storage(), *proposal)
                    .map_err(|err| mls_error("暂存群提案失败", err))?;
                Ok(IncomingMlsOutcome::ProposalStaged)
            }
            ProcessedMessageContent::ExternalJoinProposalMessage(_) => {
                Ok(IncomingMlsOutcome::ProposalStaged)
            }
            _ => Err(QuetzalcoatlError::IntegrityViolation {
                detail: String::from("群同步消息不是可应用的 Commit/Proposal"),
            }),
        }
    }

    /// 本地是否持有尚未合并的待定 Commit（发布后崩溃的恢复入口）。
    #[must_use]
    pub fn has_pending_commit(&self) -> bool {
        self.group.pending_commit().is_some()
    }

    /// 本地是否持有已暂存、待提交的提案（群主据此提交离群等提案）。
    #[must_use]
    pub fn has_staged_proposals(&self) -> bool {
        self.group.pending_proposals().next().is_some()
    }

    /// 把已暂存的提案组装成一次 Commit（群主提交离群提案用），返回序列化消息。
    pub fn commit_pending_proposals(&mut self) -> Result<Vec<u8>> {
        let (commit, _welcome, _group_info) = self
            .group
            .commit_to_pending_proposals(&self.provider, &self.signer)
            .map_err(|err| mls_error("提交暂存提案失败", err))?;
        serialize_message(&commit)
    }

    /// 加密应用消息（仅密文，永不写 Hub 明文）。
    pub fn encrypt_application(&mut self, plaintext: &[u8]) -> Result<Vec<u8>> {
        let message = self
            .group
            .create_message(&self.provider, &self.signer, plaintext)
            .map_err(|err| mls_error("加密应用消息失败", err))?;
        serialize_message(&message)
    }

    /// 解密应用消息。
    pub fn decrypt_application(&mut self, ciphertext: &[u8]) -> Result<Vec<u8>> {
        let mut ciphertext_cursor = ciphertext;
        let message = MlsMessageIn::tls_deserialize(&mut ciphertext_cursor)
            .map_err(|err| mls_error("解析应用密文失败", err))?;
        let protocol_message = message
            .try_into_protocol_message()
            .map_err(|err| mls_error("应用密文不是可处理协议消息", err))?;
        let processed = self
            .group
            .process_message(&self.provider, protocol_message)
            .map_err(|err| mls_error("解密应用消息失败", err))?;
        match processed.into_content() {
            ProcessedMessageContent::ApplicationMessage(application) => {
                Ok(application.into_bytes())
            }
            _ => Err(QuetzalcoatlError::IntegrityViolation {
                detail: String::from("群消息不是应用数据明文"),
            }),
        }
    }

    fn state_doc_path(room_id: &str) -> String {
        format!("{STATE_DOC_PREFIX}/{room_id}")
    }

    /// 将完整 MLS 状态（含发送棘轮、纪元密钥与棘轮树）确定性落盘至 `quetzalcoatl-spine`。
    pub fn persist_to<S: MaterializedStore + ?Sized>(&self, store: &mut S) -> Result<()> {
        let doc = PersistedGroupState {
            version: PERSIST_VERSION,
            room_id: self.room_id.clone(),
            identity: self.identity.name().to_owned(),
            epoch: self.mls_epoch(),
            entries: self.provider.snapshot_entries()?,
        };
        let body =
            serde_json::to_string(&doc).map_err(|err| QuetzalcoatlError::SerializationError {
                detail: format!("序列化 MLS 群状态失败: {err}"),
            })?;
        store
            .put_private_blob(&Self::state_doc_path(&self.room_id), &body)
            .map_err(|err| QuetzalcoatlError::StorageError {
                detail: format!("写入 MLS 群状态快照失败: {err}"),
            })
    }

    /// 从脊柱快照恢复同一群状态（重启后继续同一纪元与发送棘轮）。
    pub fn restore<S: MaterializedStore + ?Sized>(
        room_id: &str,
        identity: &MlsIdentity,
        store: &S,
    ) -> Result<Self> {
        let path = Self::state_doc_path(room_id);
        let raw = store
            .get_private_blob(&path)
            .map_err(|err| QuetzalcoatlError::StorageError {
                detail: format!("读取私有 MLS 群状态失败: {err}"),
            })?
            .ok_or_else(|| QuetzalcoatlError::StorageError {
                detail: format!("未找到群 {room_id} 的 MLS 状态快照"),
            })?;
        let doc: PersistedGroupState =
            serde_json::from_str(&raw).map_err(|err| QuetzalcoatlError::SerializationError {
                detail: format!("解析 MLS 群状态快照失败: {err}"),
            })?;
        if doc.version != PERSIST_VERSION || doc.room_id != room_id {
            return Err(QuetzalcoatlError::IntegrityViolation {
                detail: String::from("MLS 群状态快照版本或房间标识不匹配"),
            });
        }
        if doc.identity != identity.name() {
            return Err(QuetzalcoatlError::IntegrityViolation {
                detail: String::from("MLS 群状态快照身份与本地身份不匹配"),
            });
        }
        let provider = RoomProvider::restore_from(&doc.entries)?;
        let group = MlsGroup::load(provider.storage(), &Self::group_id(room_id))
            .map_err(|err| mls_error("加载 MLS 群状态失败", err))?
            .ok_or_else(|| QuetzalcoatlError::StorageError {
                detail: String::from("MLS 存储中不存在目标群"),
            })?;
        if group.epoch().as_u64() != doc.epoch {
            return Err(QuetzalcoatlError::IntegrityViolation {
                detail: String::from("MLS 群状态快照纪元与加载纪元不一致"),
            });
        }
        let signer = RoomSigner {
            key: identity.signing_key().clone(),
        };
        Ok(Self {
            room_id: room_id.to_owned(),
            identity: identity.clone(),
            provider,
            group,
            signer,
        })
    }
}

#[derive(Serialize, Deserialize)]
struct PersistedGroupState {
    version: u32,
    room_id: String,
    identity: String,
    epoch: u64,
    entries: Vec<(String, String)>,
}

fn serialize_message(message: &MlsMessageOut) -> Result<Vec<u8>> {
    message
        .tls_serialize_detached()
        .map_err(|err| mls_error("序列化 MLS 消息失败", err))
}
