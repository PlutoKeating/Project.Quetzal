use std::collections::BTreeMap;

use ed25519_dalek::{Signer, SigningKey};
use quetzalcoatl_crypto::{AccountRootKey, hex_decode_fixed, hex_encode, verify_ed25519_signature};
use quetzalcoatl_types::{ArtifactId, QuetzalcoatlError, Result, ThreadId};
use serde::{Deserialize, Serialize};

const DIRECTIVE_HASH_CONTEXT: &str = "quetzalcoatl/v2/conscience-directive-v1";
const MANIFEST_SIGN_CONTEXT: &str = "quetzalcoatl/v2/conscience-manifest-v1";
const OPERATOR_DELEGATION_CONTEXT: &str = "quetzalcoatl/v2/conscience-operator-key-v1";

#[derive(Copy, Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[repr(u8)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Authority {
    Untrusted = 0,
    Context = 10,
    Memory = 30,
    UserPref = 40,
    SelfSoft = 50,
    Relation = 55,
    SelfCore = 70,
    Operator = 80,
    Root = 100,
}

impl Authority {
    #[must_use]
    pub const fn numeric(self) -> u8 {
        self as u8
    }

    #[must_use]
    pub const fn is_absolute_tier(self) -> bool {
        matches!(self, Self::Root | Self::Operator | Self::SelfCore)
    }

    #[must_use]
    pub const fn is_bounded_tier(self) -> bool {
        matches!(
            self,
            Self::Relation | Self::SelfSoft | Self::UserPref | Self::Memory
        )
    }

    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Root => "ROOT",
            Self::Operator => "OPERATOR",
            Self::SelfCore => "SELF_CORE",
            Self::Relation => "RELATION",
            Self::SelfSoft => "SELF_SOFT",
            Self::UserPref => "USER_PREF",
            Self::Memory => "MEMORY",
            Self::Context => "CONTEXT",
            Self::Untrusted => "UNTRUSTED",
        }
    }
}

#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum SignalKind {
    S1,
    S2,
    S3,
    S4,
    S5,
    S6,
    S7,
    S8,
    S9,
}

#[derive(Copy, Clone, Debug, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PeerKind {
    #[default]
    Human,
    Bot,
    System,
}

#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelRole {
    Primary,
    Reflector,
    Judge,
    Embedder,
    Simulator,
    Probe,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ModelRef {
    pub role: ModelRole,
    pub reference: String,
    pub provider_hash: Option<String>,
    pub model_hash: Option<String>,
    pub params_b: Option<f64>,
    pub is_on_device_small: bool,
}

impl ModelRef {
    /// 防坑规范 #16：判定是否为 `<=8B` 端侧小模型（如 3B Apple FoundationModels）。
    #[must_use]
    pub fn is_small_on_device(&self) -> bool {
        self.is_on_device_small || self.params_b.is_some_and(|p| p <= 8.0)
    }
}

#[derive(Copy, Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MutabilityMode {
    Locked,
    SupersedeOnly,
    Free,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Mutability {
    pub mode: MutabilityMode,
    pub min_evidence: usize,
    pub min_sessions: usize,
    pub min_days: u64,
    pub cooldown_days: u64,
    pub max_pressure_ratio: f64,
    pub reflector_agreement: usize,
    pub prior: f64,
    pub budget_per_episode: f64,
    pub budget_total: f64,
    pub budget_spent: f64,
}

impl Mutability {
    #[must_use]
    pub const fn locked() -> Self {
        Self {
            mode: MutabilityMode::Locked,
            min_evidence: usize::MAX,
            min_sessions: usize::MAX,
            min_days: u64::MAX,
            cooldown_days: u64::MAX,
            max_pressure_ratio: 0.0,
            reflector_agreement: usize::MAX,
            prior: 1.0,
            budget_per_episode: 0.0,
            budget_total: 0.0,
            budget_spent: 0.0,
        }
    }

    #[must_use]
    pub const fn self_core_default() -> Self {
        Self {
            mode: MutabilityMode::SupersedeOnly,
            min_evidence: 5,
            min_sessions: 3,
            min_days: 7,
            cooldown_days: 14,
            max_pressure_ratio: 0.2,
            reflector_agreement: 2,
            prior: 1.0,
            budget_per_episode: 0.0,
            budget_total: 0.0,
            budget_spent: 0.0,
        }
    }

    #[must_use]
    pub const fn self_soft_default() -> Self {
        Self {
            mode: MutabilityMode::SupersedeOnly,
            min_evidence: 1,
            min_sessions: 1,
            min_days: 0,
            cooldown_days: 0,
            max_pressure_ratio: 1.0,
            reflector_agreement: 1,
            prior: 1.0,
            budget_per_episode: 0.1,
            budget_total: 0.5,
            budget_spent: 0.0,
        }
    }

    #[must_use]
    pub const fn user_pref_default() -> Self {
        Self {
            mode: MutabilityMode::SupersedeOnly,
            min_evidence: 1,
            min_sessions: 1,
            min_days: 0,
            cooldown_days: 0,
            max_pressure_ratio: 1.0,
            reflector_agreement: 1,
            prior: 1.0,
            budget_per_episode: 0.05,
            budget_total: 0.3,
            budget_spent: 0.0,
        }
    }

    #[must_use]
    pub const fn relation_default() -> Self {
        Self {
            mode: MutabilityMode::SupersedeOnly,
            min_evidence: 3,
            min_sessions: 1,
            min_days: 0,
            cooldown_days: 0,
            max_pressure_ratio: 0.5,
            reflector_agreement: 1,
            prior: 1.0,
            budget_per_episode: 0.05,
            budget_total: 0.3,
            budget_spent: 0.0,
        }
    }

    #[must_use]
    pub const fn memory_free() -> Self {
        Self {
            mode: MutabilityMode::Free,
            min_evidence: 1,
            min_sessions: 1,
            min_days: 0,
            cooldown_days: 0,
            max_pressure_ratio: 1.0,
            reflector_agreement: 1,
            prior: 1.0,
            budget_per_episode: 1.0,
            budget_total: 1.0,
            budget_spent: 0.0,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ProvenanceRecord {
    pub written_by: String,
    pub at_ms: u64,
    pub source_event_ids: Vec<String>,
    pub model: Option<ModelRef>,
    pub supersedes: Option<String>,
}

/// 所有者签署的 `ROOT (100)` 或部署者签署的 `OPERATOR (80)` 受保护指令条目。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProtectedDirective {
    pub id: String,
    pub authority: Authority,
    pub title: String,
    pub content: String,
    pub created_at_ms: u64,
}

/// 规范化文本字节（统一 LF 换行、去除每行尾部空白与首尾空行，对齐 `architecture-v1.md` §3.1）。
#[must_use]
pub fn canonicalize_protected_text(raw: &str) -> String {
    let normalized = raw.replace("\r\n", "\n").replace('\r', "\n");
    let lines: Vec<&str> = normalized.lines().map(str::trim_end).collect();
    lines.join("\n").trim().to_string()
}

/// 计算受保护 `ROOT` / `OPERATOR` 条目的域分离 BLAKE3 摘要。
#[must_use]
pub fn compute_directive_blake3(directive: &ProtectedDirective) -> ArtifactId {
    let mut hasher = blake3::Hasher::new_derive_key(DIRECTIVE_HASH_CONTEXT);
    let id_bytes = directive.id.as_bytes();
    hasher.update(&(id_bytes.len() as u64).to_be_bytes());
    hasher.update(id_bytes);
    hasher.update(&[directive.authority.numeric()]);

    let canon_title = canonicalize_protected_text(&directive.title);
    hasher.update(&(canon_title.len() as u64).to_be_bytes());
    hasher.update(canon_title.as_bytes());

    let canon_content = canonicalize_protected_text(&directive.content);
    hasher.update(&(canon_content.len() as u64).to_be_bytes());
    hasher.update(canon_content.as_bytes());

    ArtifactId::from_bytes(*hasher.finalize().as_bytes())
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConscienceManifest {
    pub owner_ed25519_pubkey: [u8; 32],
    pub operator_ed25519_pubkey: Option<[u8; 32]>,
    pub operator_key_owner_sig_hex: Option<String>,
    pub protected_hashes: BTreeMap<String, ArtifactId>,
    pub signed_at_ms: u64,
    pub manifest_sig_hex: String,
}

impl ConscienceManifest {
    fn signing_digest(
        owner_ed25519_pubkey: &[u8; 32],
        operator_ed25519_pubkey: Option<&[u8; 32]>,
        protected_hashes: &BTreeMap<String, ArtifactId>,
        signed_at_ms: u64,
    ) -> [u8; 32] {
        let mut hasher = blake3::Hasher::new_derive_key(MANIFEST_SIGN_CONTEXT);
        hasher.update(owner_ed25519_pubkey);
        match operator_ed25519_pubkey {
            Some(op_pk) => {
                hasher.update(&[1u8]);
                hasher.update(op_pk);
            }
            None => {
                hasher.update(&[0u8]);
            }
        }
        hasher.update(&signed_at_ms.to_be_bytes());
        hasher.update(&(protected_hashes.len() as u64).to_be_bytes());
        for (id, digest) in protected_hashes {
            let id_b = id.as_bytes();
            hasher.update(&(id_b.len() as u64).to_be_bytes());
            hasher.update(id_b);
            hasher.update(digest.as_bytes());
        }
        *hasher.finalize().as_bytes()
    }

    fn operator_delegation_digest(owner_pk: &[u8; 32], operator_pk: &[u8; 32]) -> [u8; 32] {
        let mut hasher = blake3::Hasher::new_derive_key(OPERATOR_DELEGATION_CONTEXT);
        hasher.update(owner_pk);
        hasher.update(operator_pk);
        *hasher.finalize().as_bytes()
    }

    /// 使用所有者的 `AccountRootKey` 对全部 `ROOT` 与 `OPERATOR` 条目计算 BLAKE3 清单并生成 Ed25519 签名。
    pub fn sign_with_root(
        root_key: &AccountRootKey,
        root_directives: &[ProtectedDirective],
        operator_directives: &[ProtectedDirective],
        signed_at_ms: u64,
    ) -> Result<Self> {
        let mut protected_hashes = BTreeMap::new();
        for dir in root_directives {
            if dir.authority != Authority::Root {
                return Err(QuetzalcoatlError::ConscienceViolation {
                    detail: format!("ROOT 列表中出现非 ROOT 权威等级条目: {}", dir.id),
                });
            }
            if protected_hashes
                .insert(dir.id.clone(), compute_directive_blake3(dir))
                .is_some()
            {
                return Err(QuetzalcoatlError::ConscienceViolation {
                    detail: format!("受保护良知条目 ID 重复: {}", dir.id),
                });
            }
        }
        for dir in operator_directives {
            if dir.authority != Authority::Operator {
                return Err(QuetzalcoatlError::ConscienceViolation {
                    detail: format!("OPERATOR 列表中出现非 OPERATOR 权威等级条目: {}", dir.id),
                });
            }
            if protected_hashes
                .insert(dir.id.clone(), compute_directive_blake3(dir))
                .is_some()
            {
                return Err(QuetzalcoatlError::ConscienceViolation {
                    detail: format!("受保护良知条目 ID 重复: {}", dir.id),
                });
            }
        }

        let owner_pk = root_key.verifying_key_bytes()?;
        let digest = Self::signing_digest(&owner_pk, None, &protected_hashes, signed_at_ms);
        let sk = SigningKey::from_bytes(root_key.as_bytes());
        let sig = sk.sign(&digest);

        Ok(Self {
            owner_ed25519_pubkey: owner_pk,
            operator_ed25519_pubkey: None,
            operator_key_owner_sig_hex: None,
            protected_hashes,
            signed_at_ms,
            manifest_sig_hex: hex_encode(&sig.to_bytes()),
        })
    }

    /// 绑定由所有者签署授权的二级 Operator 公钥（两级信任链，`architecture-v1.md` §3.1）。
    pub fn with_delegated_operator_key(
        mut self,
        root_key: &AccountRootKey,
        operator_pubkey: [u8; 32],
    ) -> Result<Self> {
        let owner_pk = root_key.verifying_key_bytes()?;
        if owner_pk != self.owner_ed25519_pubkey {
            return Err(QuetzalcoatlError::ConscienceViolation {
                detail: String::from("签名根密钥与清单 owner_ed25519_pubkey 不匹配"),
            });
        }
        let sk = SigningKey::from_bytes(root_key.as_bytes());
        let del_digest = Self::operator_delegation_digest(&owner_pk, &operator_pubkey);
        let del_sig = sk.sign(&del_digest);

        self.operator_ed25519_pubkey = Some(operator_pubkey);
        self.operator_key_owner_sig_hex = Some(hex_encode(&del_sig.to_bytes()));

        let manifest_digest = Self::signing_digest(
            &self.owner_ed25519_pubkey,
            Some(&operator_pubkey),
            &self.protected_hashes,
            self.signed_at_ms,
        );
        let m_sig = sk.sign(&manifest_digest);
        self.manifest_sig_hex = hex_encode(&m_sig.to_bytes());
        Ok(self)
    }

    /// 验证清单自身的 Ed25519 根签名（及可选的二级 Operator 授权签名）。
    pub fn verify_manifest_signature(&self) -> Result<()> {
        let sig_bytes = hex_decode_fixed::<64>("conscience_manifest_sig", &self.manifest_sig_hex)
            .map_err(|e| QuetzalcoatlError::ConscienceViolation {
            detail: format!("良知清单签名格式非法: {e}"),
        })?;
        let signing_pk = self
            .operator_ed25519_pubkey
            .as_ref()
            .unwrap_or(&self.owner_ed25519_pubkey);

        if let Some(op_pk) = &self.operator_ed25519_pubkey {
            let op_sig_hex = self.operator_key_owner_sig_hex.as_deref().ok_or_else(|| {
                QuetzalcoatlError::ConscienceViolation {
                    detail: String::from("缺少所有者对 operator_ed25519_pubkey 的二级授权签名"),
                }
            })?;
            let op_sig =
                hex_decode_fixed::<64>("operator_delegation_sig", op_sig_hex).map_err(|e| {
                    QuetzalcoatlError::ConscienceViolation {
                        detail: format!("二级授权签名格式非法: {e}"),
                    }
                })?;
            let del_digest = Self::operator_delegation_digest(&self.owner_ed25519_pubkey, op_pk);
            verify_ed25519_signature(&self.owner_ed25519_pubkey, &del_digest, &op_sig).map_err(
                |e| QuetzalcoatlError::ConscienceViolation {
                    detail: format!("Operator 二级信任链签名校验失败: {e}"),
                },
            )?;
        }

        let digest = Self::signing_digest(
            &self.owner_ed25519_pubkey,
            self.operator_ed25519_pubkey.as_ref(),
            &self.protected_hashes,
            self.signed_at_ms,
        );
        verify_ed25519_signature(signing_pk, &digest, &sig_bytes).map_err(|e| {
            QuetzalcoatlError::ConscienceViolation {
                detail: format!("ROOT/OPERATOR 良知清单 Ed25519 签名校验失败: {e}"),
            }
        })
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct IdentityBlock {
    pub id: String,
    pub label: String,
    pub description: String,
    pub value: String,
    pub char_limit: usize,
    pub authority: Authority,
    pub mutability: Mutability,
    pub pinned: bool,
    pub provenance: ProvenanceRecord,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ValueEntry {
    pub id: String,
    pub statement: String,
    pub rationale: Option<String>,
    pub authority: Authority,
    pub negotiable_in_conversation: bool,
    pub examples: Vec<String>,
    pub mutability: Mutability,
    pub provenance: ProvenanceRecord,
    pub valid_from_ms: u64,
    pub invalid_at_ms: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Episode {
    pub id: String,
    pub thread_id: ThreadId,
    pub peer_ids: Vec<String>,
    pub channel: String,
    pub session_id: Option<String>,
    pub started_at_ms: u64,
    pub ended_at_ms: Option<u64>,
    pub pressure_flags: Vec<String>,
    pub s4_command_source_id: Option<String>,
    pub pending_cloud_consolidation: bool,
}

impl Episode {
    #[must_use]
    pub fn has_s5_pressure(&self) -> bool {
        self.pressure_flags.iter().any(|f| f == "S5")
    }
}

#[derive(Copy, Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GrantScope {
    Read,
    ReadAndCite,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PersonaGrant {
    pub id: String,
    pub grantor_peer: String,
    pub grantee_peer: String,
    pub fields: Vec<String>,
    pub scope: GrantScope,
    pub purpose: String,
    pub expires_at_ms: Option<u64>,
    pub revoked_at_ms: Option<u64>,
    pub grantor_ed25519_pubkey: [u8; 32],
    pub sig_hex: String,
}

impl PersonaGrant {
    #[must_use]
    pub fn is_active_at(&self, now_ms: u64) -> bool {
        self.revoked_at_ms.is_none() && self.expires_at_ms.is_none_or(|exp| exp > now_ms)
    }

    #[must_use]
    pub fn touches_forbidden_absolute_field(&self) -> bool {
        self.fields.iter().any(|f| {
            let lower = f.trim().to_ascii_lowercase();
            lower.starts_with("root") || lower.starts_with("operator")
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SharedField {
    pub path: String,
    pub value: String,
    pub grant_id: String,
    pub fetched_at_ms: u64,
    pub invalid_at_ms: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Relationship {
    pub id: String,
    pub with_peer: String,
    pub kind: String,
    pub peer_kind: PeerKind,
    pub shared_commitments: Vec<String>,
    pub my_model_of_them: Vec<String>,
    pub their_model_of_me: Vec<String>,
    pub peer_shared: Vec<SharedField>,
    pub trust: f64,
    pub authority: Authority,
    pub mutability: Mutability,
    pub provenance: ProvenanceRecord,
}

#[derive(Copy, Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MemoryKind {
    Fact,
    Episode,
    Procedure,
    Feedback,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MemoryEntry {
    pub id: String,
    pub kind: MemoryKind,
    pub topic: Option<String>,
    pub content: String,
    pub about: Vec<String>,
    pub salience: f64,
    pub evidence_count: usize,
    pub constant: bool,
    pub untrusted: bool,
    pub pressure_flags: Vec<String>,
    pub authority: Authority,
    pub mutability: Mutability,
    pub valid_from_ms: u64,
    pub invalid_at_ms: Option<u64>,
    pub triggers: Vec<String>,
    pub provenance: ProvenanceRecord,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct FocusConfig {
    pub weights: BTreeMap<String, f64>,
    pub drift_rate_per_episode: f64,
    pub floor_self: f64,
    pub floor_self_locked_by_root: bool,
    pub ceiling_per_peer: f64,
    pub owner_visible: bool,
    pub owner_editable: bool,
    pub last_shift: Option<ProvenanceRecord>,
}

impl Default for FocusConfig {
    fn default() -> Self {
        let mut weights = BTreeMap::new();
        weights.insert(String::from("self"), 1.0);
        Self {
            weights,
            drift_rate_per_episode: 0.02,
            floor_self: 0.4,
            floor_self_locked_by_root: true,
            ceiling_per_peer: 0.5,
            owner_visible: true,
            owner_editable: true,
            last_shift: None,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum FocusShiftOutcome {
    Shifted {
        before: f64,
        after: f64,
        self_weight: f64,
    },
    RefusedPressureS5,
    RefusedNonHumanPeer,
    NoChange,
}

impl FocusConfig {
    /// 执行 `architecture-v1.md` §8.3 的关系权重有界漂移规则：
    /// - `bot` / `system` 权重上限强制为 0；
    /// - 含 `S5` 施压信号一律拒绝漂移（`RefusedPressureS5`）；
    /// - `weights["self"]` 永远不低于 `floor_self`（默认 `0.4`），单一对象不超过 `ceiling_per_peer`（默认 `0.5`）。
    pub fn apply_s6_drift(
        &mut self,
        peer_id: &str,
        peer_kind: PeerKind,
        s6_strength: f64,
        has_s5_pressure: bool,
        provenance: Option<ProvenanceRecord>,
    ) -> FocusShiftOutcome {
        let key = if peer_id.starts_with("relationship:") {
            String::from(peer_id)
        } else {
            format!("relationship:{peer_id}")
        };

        if peer_kind != PeerKind::Human {
            self.weights.remove(&key);
            let others: f64 = self
                .weights
                .iter()
                .filter(|(k, _)| k.as_str() != "self")
                .map(|(_, v)| *v)
                .sum();
            self.weights
                .insert(String::from("self"), (1.0 - others).max(self.floor_self));
            return FocusShiftOutcome::RefusedNonHumanPeer;
        }

        if has_s5_pressure {
            return FocusShiftOutcome::RefusedPressureS5;
        }

        if !s6_strength.is_finite() || s6_strength == 0.0 {
            return FocusShiftOutcome::NoChange;
        }

        let before = self.weights.get(&key).copied().unwrap_or(0.0);
        let other_peers_sum: f64 = self
            .weights
            .iter()
            .filter(|(k, _)| k.as_str() != "self" && k.as_str() != key.as_str())
            .map(|(_, v)| *v)
            .sum();

        let available_room = (1.0 - self.floor_self - other_peers_sum).max(0.0);
        let max_allowed = self.ceiling_per_peer.min(available_room);
        let delta = self.drift_rate_per_episode * s6_strength.signum();
        let after = (before + delta).clamp(0.0, max_allowed);

        if (after - before).abs() < 1e-12 {
            return FocusShiftOutcome::NoChange;
        }

        if after == 0.0 {
            self.weights.remove(&key);
        } else {
            self.weights.insert(key, after);
        }
        let sum_all_peers: f64 = self
            .weights
            .iter()
            .filter(|(k, _)| k.as_str() != "self")
            .map(|(_, v)| *v)
            .sum();
        let self_weight = (1.0 - sum_all_peers).max(self.floor_self);
        self.weights.insert(String::from("self"), self_weight);
        self.last_shift = provenance;

        FocusShiftOutcome::Shifted {
            before,
            after,
            self_weight,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DisclosureNotice {
    pub target_id: String,
    pub summary: String,
    pub source_episode_ids: Vec<String>,
    pub created_at_ms: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Conscience {
    pub schema_version: String,
    pub root_directives: Vec<ProtectedDirective>,
    pub operator_directives: Vec<ProtectedDirective>,
    pub manifest: ConscienceManifest,
    pub identity: Vec<IdentityBlock>,
    pub values: Vec<ValueEntry>,
    pub relationships: Vec<Relationship>,
    pub memories: Vec<MemoryEntry>,
    pub focus: FocusConfig,
    pub grants_given: Vec<PersonaGrant>,
    pub grants_received: Vec<PersonaGrant>,
    pub episodes: Vec<Episode>,
    pub peer_links: BTreeMap<String, String>,
    pub pending_disclosures: Vec<DisclosureNotice>,
}

impl Conscience {
    /// O(N) 比对全部 `ROOT` 与 `OPERATOR` 条目的 BLAKE3 哈希与清单一致性（每次上下文组装前必跑，`§3.2 #2`）。
    pub fn verify_manifest_hashes(&self) -> Result<()> {
        let expected_total = self.root_directives.len() + self.operator_directives.len();
        if self.manifest.protected_hashes.len() != expected_total {
            return Err(QuetzalcoatlError::ConscienceViolation {
                detail: format!(
                    "受保护良知条目数量不匹配：清单记录 {} 条，实际为 {expected_total} 条",
                    self.manifest.protected_hashes.len()
                ),
            });
        }

        for dir in &self.root_directives {
            if dir.authority != Authority::Root {
                return Err(QuetzalcoatlError::ConscienceViolation {
                    detail: format!("ROOT 槽位存在非 ROOT 权威条目: {}", dir.id),
                });
            }
            let Some(expected) = self.manifest.protected_hashes.get(&dir.id) else {
                return Err(QuetzalcoatlError::ConscienceViolation {
                    detail: format!("未在签名清单中登记的 ROOT 条目: {}", dir.id),
                });
            };
            let actual = compute_directive_blake3(dir);
            if actual != *expected {
                return Err(QuetzalcoatlError::ConscienceViolation {
                    detail: format!(
                        "检测到 ROOT 条目 {} 内容被篡改 (expected={expected}, actual={actual})",
                        dir.id
                    ),
                });
            }
        }

        for dir in &self.operator_directives {
            if dir.authority != Authority::Operator {
                return Err(QuetzalcoatlError::ConscienceViolation {
                    detail: format!("OPERATOR 槽位存在非 OPERATOR 权威条目: {}", dir.id),
                });
            }
            let Some(expected) = self.manifest.protected_hashes.get(&dir.id) else {
                return Err(QuetzalcoatlError::ConscienceViolation {
                    detail: format!("未在签名清单中登记的 OPERATOR 条目: {}", dir.id),
                });
            };
            let actual = compute_directive_blake3(dir);
            if actual != *expected {
                return Err(QuetzalcoatlError::ConscienceViolation {
                    detail: format!(
                        "检测到 OPERATOR 条目 {} 内容被篡改 (expected={expected}, actual={actual})",
                        dir.id
                    ),
                });
            }
        }

        Ok(())
    }

    /// 完整验证 Ed25519 清单签名与全部 `ROOT` / `OPERATOR` BLAKE3 摘要（加载时与提交前校验，`§3.2 #1/#3`）。
    pub fn verify_signature_and_hashes(&self) -> Result<()> {
        self.verify_manifest_hashes()?;
        self.manifest.verify_manifest_signature()
    }

    /// 取出并清空已向所有者披露的通知队列。
    pub fn take_disclosures(&mut self) -> Vec<DisclosureNotice> {
        std::mem::take(&mut self.pending_disclosures)
    }
}
