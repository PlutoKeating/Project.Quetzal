use std::collections::BTreeMap;

use ed25519_dalek::{Signer, SigningKey};
use quetzalcoatl_crypto::{AccountRootKey, hex_decode_fixed, hex_encode, verify_ed25519_signature};
use quetzalcoatl_types::{ArtifactId, QuetzalcoatlError, Result, ThreadId};
use serde::{Deserialize, Serialize};

const DIRECTIVE_HASH_CONTEXT: &str = "quetzalcoatl/v2/conscience-directive-v1";
const ROOT_MANIFEST_SIGN_CONTEXT: &str = "quetzalcoatl/v2/conscience-root-manifest-v1";
const OPERATOR_MANIFEST_SIGN_CONTEXT: &str = "quetzalcoatl/v2/conscience-operator-manifest-v1";
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
    pub root_hashes: BTreeMap<String, ArtifactId>,
    pub root_signed_at_ms: u64,
    pub root_manifest_sig_hex: String,
    pub operator_ed25519_pubkey: Option<[u8; 32]>,
    pub operator_delegation_sig_hex: Option<String>,
    pub operator_hashes: BTreeMap<String, ArtifactId>,
    pub operator_signed_at_ms: u64,
    pub operator_manifest_sig_hex: String,
}

impl ConscienceManifest {
    fn root_signing_digest(
        owner_ed25519_pubkey: &[u8; 32],
        root_hashes: &BTreeMap<String, ArtifactId>,
        root_signed_at_ms: u64,
    ) -> [u8; 32] {
        let mut hasher = blake3::Hasher::new_derive_key(ROOT_MANIFEST_SIGN_CONTEXT);
        hasher.update(owner_ed25519_pubkey);
        hasher.update(&root_signed_at_ms.to_be_bytes());
        hasher.update(&(root_hashes.len() as u64).to_be_bytes());
        for (id, digest) in root_hashes {
            let id_b = id.as_bytes();
            hasher.update(&(id_b.len() as u64).to_be_bytes());
            hasher.update(id_b);
            hasher.update(digest.as_bytes());
        }
        *hasher.finalize().as_bytes()
    }

    fn operator_signing_digest(
        owner_ed25519_pubkey: &[u8; 32],
        operator_ed25519_pubkey: Option<&[u8; 32]>,
        operator_hashes: &BTreeMap<String, ArtifactId>,
        operator_signed_at_ms: u64,
    ) -> [u8; 32] {
        let mut hasher = blake3::Hasher::new_derive_key(OPERATOR_MANIFEST_SIGN_CONTEXT);
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
        hasher.update(&operator_signed_at_ms.to_be_bytes());
        hasher.update(&(operator_hashes.len() as u64).to_be_bytes());
        for (id, digest) in operator_hashes {
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

    #[must_use]
    pub fn contains_protected_id(&self, id: &str) -> bool {
        self.root_hashes.contains_key(id) || self.operator_hashes.contains_key(id)
    }

    /// 使用所有者的 `AccountRootKey` 分别对 `ROOT (100)` 与初始 `OPERATOR (80)` 指令计算隔离哈希表并生成双签名。
    pub fn sign_with_root(
        root_key: &AccountRootKey,
        root_directives: &[ProtectedDirective],
        operator_directives: &[ProtectedDirective],
        signed_at_ms: u64,
    ) -> Result<Self> {
        let mut root_hashes = BTreeMap::new();
        for dir in root_directives {
            if dir.authority != Authority::Root {
                return Err(QuetzalcoatlError::ConscienceViolation {
                    detail: format!("ROOT 列表中出现非 ROOT 权威等级条目: {}", dir.id),
                });
            }
            if root_hashes
                .insert(dir.id.clone(), compute_directive_blake3(dir))
                .is_some()
            {
                return Err(QuetzalcoatlError::ConscienceViolation {
                    detail: format!("受保护 ROOT 条目 ID 重复: {}", dir.id),
                });
            }
        }

        let mut operator_hashes = BTreeMap::new();
        for dir in operator_directives {
            if dir.authority != Authority::Operator {
                return Err(QuetzalcoatlError::ConscienceViolation {
                    detail: format!("OPERATOR 列表中出现非 OPERATOR 权威等级条目: {}", dir.id),
                });
            }
            if root_hashes.contains_key(&dir.id) {
                return Err(QuetzalcoatlError::ConscienceViolation {
                    detail: format!("OPERATOR 条目 ID {} 与 ROOT 条目冲突", dir.id),
                });
            }
            if operator_hashes
                .insert(dir.id.clone(), compute_directive_blake3(dir))
                .is_some()
            {
                return Err(QuetzalcoatlError::ConscienceViolation {
                    detail: format!("受保护 OPERATOR 条目 ID 重复: {}", dir.id),
                });
            }
        }

        let owner_pk = root_key.verifying_key_bytes()?;
        let sk = SigningKey::from_bytes(root_key.as_bytes());
        let root_digest = Self::root_signing_digest(&owner_pk, &root_hashes, signed_at_ms);
        let op_digest =
            Self::operator_signing_digest(&owner_pk, None, &operator_hashes, signed_at_ms);

        let root_sig = sk.sign(&root_digest);
        let op_sig = sk.sign(&op_digest);

        Ok(Self {
            owner_ed25519_pubkey: owner_pk,
            root_hashes,
            root_signed_at_ms: signed_at_ms,
            root_manifest_sig_hex: hex_encode(&root_sig.to_bytes()),
            operator_ed25519_pubkey: None,
            operator_delegation_sig_hex: None,
            operator_hashes,
            operator_signed_at_ms: signed_at_ms,
            operator_manifest_sig_hex: hex_encode(&op_sig.to_bytes()),
        })
    }

    /// 所有者签署授权二级 Operator 公钥（两级信任链第一跳，不接触 Operator 私钥）。
    pub fn delegate_operator_pubkey(
        &self,
        root_key: &AccountRootKey,
        operator_pubkey: [u8; 32],
    ) -> Result<String> {
        let owner_pk = root_key.verifying_key_bytes()?;
        if owner_pk != self.owner_ed25519_pubkey {
            return Err(QuetzalcoatlError::ConscienceViolation {
                detail: String::from("签名根密钥与清单 owner_ed25519_pubkey 不匹配"),
            });
        }
        let sk = SigningKey::from_bytes(root_key.as_bytes());
        let del_digest = Self::operator_delegation_digest(&owner_pk, &operator_pubkey);
        let del_sig = sk.sign(&del_digest);
        Ok(hex_encode(&del_sig.to_bytes()))
    }

    /// 部署者（Operator）仅使用自身私钥重签 `OPERATOR (80)` 指令集；
    /// `root_hashes` 与 `root_manifest_sig_hex` 原封不动，彻底杜绝 `OPERATOR -> ROOT` 提权篡改。
    pub fn sign_operator_directives(
        &self,
        operator_signing_seed: &[u8; 32],
        operator_delegation_sig_hex: String,
        operator_directives: &[ProtectedDirective],
        operator_signed_at_ms: u64,
    ) -> Result<Self> {
        let op_sk = SigningKey::from_bytes(operator_signing_seed);
        let op_pk = op_sk.verifying_key().to_bytes();

        let del_sig_bytes =
            hex_decode_fixed::<64>("operator_delegation_sig", &operator_delegation_sig_hex)
                .map_err(|e| QuetzalcoatlError::ConscienceViolation {
                    detail: format!("Operator 二级授权签名格式非法: {e}"),
                })?;
        let del_digest = Self::operator_delegation_digest(&self.owner_ed25519_pubkey, &op_pk);
        verify_ed25519_signature(&self.owner_ed25519_pubkey, &del_digest, &del_sig_bytes).map_err(
            |e| QuetzalcoatlError::ConscienceViolation {
                detail: format!("未经 Owner 有效签署授权的 Operator 公钥: {e}"),
            },
        )?;

        let mut operator_hashes = BTreeMap::new();
        for dir in operator_directives {
            if dir.authority != Authority::Operator {
                return Err(QuetzalcoatlError::ConscienceViolation {
                    detail: format!("Operator 仅允许签署 OPERATOR (80) 条目，拒绝 {}", dir.id),
                });
            }
            if self.root_hashes.contains_key(&dir.id) {
                return Err(QuetzalcoatlError::ConscienceViolation {
                    detail: format!("Operator 严禁覆盖同名 ROOT 条目 {}", dir.id),
                });
            }
            if operator_hashes
                .insert(dir.id.clone(), compute_directive_blake3(dir))
                .is_some()
            {
                return Err(QuetzalcoatlError::ConscienceViolation {
                    detail: format!("OPERATOR 条目 ID 重复: {}", dir.id),
                });
            }
        }

        let op_digest = Self::operator_signing_digest(
            &self.owner_ed25519_pubkey,
            Some(&op_pk),
            &operator_hashes,
            operator_signed_at_ms,
        );
        let op_sig = op_sk.sign(&op_digest);

        let mut updated = self.clone();
        updated.operator_ed25519_pubkey = Some(op_pk);
        updated.operator_delegation_sig_hex = Some(operator_delegation_sig_hex);
        updated.operator_hashes = operator_hashes;
        updated.operator_signed_at_ms = operator_signed_at_ms;
        updated.operator_manifest_sig_hex = hex_encode(&op_sig.to_bytes());
        Ok(updated)
    }

    /// 分别独立验证 `ROOT (100)` 所有者根签名与 `OPERATOR (80)`（直接根签或两级委托签）。
    pub fn verify_manifest_signature(&self) -> Result<()> {
        for k in self.operator_hashes.keys() {
            if self.root_hashes.contains_key(k) {
                return Err(QuetzalcoatlError::ConscienceViolation {
                    detail: format!("清单中 ROOT 与 OPERATOR 哈希表存在冲突键: {k}"),
                });
            }
        }

        // 1. ROOT (100) 清单永远只能由 owner_ed25519_pubkey 验签
        let root_sig = hex_decode_fixed::<64>("root_manifest_sig", &self.root_manifest_sig_hex)
            .map_err(|e| QuetzalcoatlError::ConscienceViolation {
                detail: format!("ROOT 良知清单签名格式非法: {e}"),
            })?;
        let root_digest = Self::root_signing_digest(
            &self.owner_ed25519_pubkey,
            &self.root_hashes,
            self.root_signed_at_ms,
        );
        verify_ed25519_signature(&self.owner_ed25519_pubkey, &root_digest, &root_sig).map_err(
            |e| QuetzalcoatlError::ConscienceViolation {
                detail: format!("ROOT (100) 所有者根签名校验失败: {e}"),
            },
        )?;

        // 2. OPERATOR (80) 清单：委托时验两级信任链并用 operator_pubkey 验签；未委托时用 owner_pubkey 验签
        let op_sig =
            hex_decode_fixed::<64>("operator_manifest_sig", &self.operator_manifest_sig_hex)
                .map_err(|e| QuetzalcoatlError::ConscienceViolation {
                    detail: format!("OPERATOR 良知清单签名格式非法: {e}"),
                })?;

        let op_signing_pk = match &self.operator_ed25519_pubkey {
            Some(op_pk) => {
                let del_sig_hex = self.operator_delegation_sig_hex.as_deref().ok_or_else(|| {
                    QuetzalcoatlError::ConscienceViolation {
                        detail: String::from("缺少所有者对 operator_ed25519_pubkey 的二级授权签名"),
                    }
                })?;
                let del_sig = hex_decode_fixed::<64>("operator_delegation_sig", del_sig_hex)
                    .map_err(|e| QuetzalcoatlError::ConscienceViolation {
                        detail: format!("二级授权签名格式非法: {e}"),
                    })?;
                let del_digest =
                    Self::operator_delegation_digest(&self.owner_ed25519_pubkey, op_pk);
                verify_ed25519_signature(&self.owner_ed25519_pubkey, &del_digest, &del_sig)
                    .map_err(|e| QuetzalcoatlError::ConscienceViolation {
                        detail: format!("Operator 二级信任链签名校验失败: {e}"),
                    })?;
                op_pk
            }
            None => &self.owner_ed25519_pubkey,
        };

        let op_digest = Self::operator_signing_digest(
            &self.owner_ed25519_pubkey,
            self.operator_ed25519_pubkey.as_ref(),
            &self.operator_hashes,
            self.operator_signed_at_ms,
        );
        verify_ed25519_signature(op_signing_pk, &op_digest, &op_sig).map_err(|e| {
            QuetzalcoatlError::ConscienceViolation {
                detail: format!("OPERATOR (80) 清单 Ed25519 签名校验失败: {e}"),
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

    /// 校验共享字段路径是否显式落在 `grant.fields` 授权范围内（支持精确匹配、`prefix/*` 与 `prefix/*.suffix`，严禁 `root*`/`operator*`）。
    #[must_use]
    pub fn allows_field(&self, field_path: &str) -> bool {
        let clean = field_path.trim();
        if clean.is_empty() {
            return false;
        }
        let lower = clean.to_ascii_lowercase();
        if lower.starts_with("root") || lower.starts_with("operator") {
            return false;
        }
        self.fields.iter().any(|pattern| {
            let pat = pattern.trim();
            if pat.is_empty() {
                return false;
            }
            let lower_pat = pat.to_ascii_lowercase();
            if lower_pat.starts_with("root") || lower_pat.starts_with("operator") {
                return false;
            }
            if pat == clean {
                return true;
            }
            if let Some(prefix) = pat.strip_suffix("/*") {
                return clean.starts_with(&format!("{prefix}/"));
            }
            if let Some((prefix, suffix)) = pat.split_once("/*.") {
                let head = format!("{prefix}/");
                let tail = format!(".{suffix}");
                return clean.starts_with(&head)
                    && clean.ends_with(&tail)
                    && clean.len() > head.len() + tail.len();
            }
            false
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
    /// O(N) 物理隔离比对 `ROOT (100)` 与 `OPERATOR (80)` 哈希表与指令集一致性（每次上下文组装前必跑，`§3.2 #2`）。
    pub fn verify_manifest_hashes(&self) -> Result<()> {
        if self.manifest.root_hashes.len() != self.root_directives.len() {
            return Err(QuetzalcoatlError::ConscienceViolation {
                detail: format!(
                    "受保护 ROOT 条目数量不匹配：清单记录 {} 条，实际为 {} 条",
                    self.manifest.root_hashes.len(),
                    self.root_directives.len()
                ),
            });
        }
        if self.manifest.operator_hashes.len() != self.operator_directives.len() {
            return Err(QuetzalcoatlError::ConscienceViolation {
                detail: format!(
                    "受保护 OPERATOR 条目数量不匹配：清单记录 {} 条，实际为 {} 条",
                    self.manifest.operator_hashes.len(),
                    self.operator_directives.len()
                ),
            });
        }

        for dir in &self.root_directives {
            if dir.authority != Authority::Root {
                return Err(QuetzalcoatlError::ConscienceViolation {
                    detail: format!("ROOT 槽位存在非 ROOT 权威条目: {}", dir.id),
                });
            }
            let Some(expected) = self.manifest.root_hashes.get(&dir.id) else {
                return Err(QuetzalcoatlError::ConscienceViolation {
                    detail: format!("未在 ROOT 签名清单中登记的条目: {}", dir.id),
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
            if self.manifest.root_hashes.contains_key(&dir.id) {
                return Err(QuetzalcoatlError::ConscienceViolation {
                    detail: format!("OPERATOR 条目 {} 与 ROOT 条目 ID 冲突", dir.id),
                });
            }
            let Some(expected) = self.manifest.operator_hashes.get(&dir.id) else {
                return Err(QuetzalcoatlError::ConscienceViolation {
                    detail: format!("未在 OPERATOR 签名清单中登记的条目: {}", dir.id),
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
