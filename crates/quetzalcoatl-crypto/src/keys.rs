use std::collections::BTreeMap;

use argon2::{Algorithm, Argon2, Params, Version};
use chacha20poly1305::{
    ChaCha20Poly1305, KeyInit, XChaCha20Poly1305, XNonce,
    aead::{Aead, Payload},
};
use curve25519_dalek::{
    constants::RISTRETTO_BASEPOINT_POINT,
    ristretto::{CompressedRistretto, RistrettoPoint},
    scalar::Scalar,
};
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use ml_kem::{
    B32, EncapsulateDeterministic, Encoded, EncodedSizeUser, KemCore, MlKem768, MlKem768Params,
    kem::{Decapsulate, DecapsulationKey, EncapsulationKey},
};
use quetzalcoatl_types::{AgentId, ArtifactId, DeviceId, Epoch, QuetzalcoatlError, Result};
use rand_core::{OsRng, RngCore};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256, Sha512};
use sha3::Sha3_256;
use x25519_dalek::{PublicKey as X25519PublicKey, StaticSecret as X25519StaticSecret};
use zeroize::{Zeroize, ZeroizeOnDrop};

/// X-Wing 混合抗量子公钥字节长度（ML-KEM-768 1184B + X25519 32B）。
pub const XWING_PK_LEN: usize = 1216;
/// X-Wing 封装密文字节长度（ML-KEM-768 1088B + X25519 32B）。
pub const XWING_ENC_LEN: usize = 1120;
/// X-Wing 组合器标签 `\.//^\`。
pub const XWING_COMBINER_LABEL: &[u8; 6] = b"\\.//^\\";

/// 纪元密钥 HPKE 封装 `info` 域分离标签。
pub const EPOCH_KEY_WRAP_INFO: &[u8] = b"quetzalcoatl/v2/epoch-key-wrap";
/// 公网零知识 Webhook HPKE 入站 `info` 域分离标签。
pub const WEBHOOK_INGRESS_INFO: &[u8] = b"quetzalcoatl/v2/webhook-ingress";
/// 扫码配对根密钥 HPKE 封装 `info` 域分离标签。
pub const PAIRING_WRAP_INFO: &[u8] = b"quetzalcoatl/v2/pairing-root-wrap";

const HPKE_SUITE_ID_XWING: &[u8; 10] = b"HPKE\x64\x7a\x00\x01\x00\x03";
const OPRF_DST_HASH_TO_GROUP: &[u8] = b"HashToGroup-OPRFV1-\x00-ristretto255-SHA512";
const SLOT4_KDF_INFO: &[u8] = b"Quetzalcoatl-Slot4-RootKeyWrap-v1";
const MEMBERSHIP_DOMAIN_CONTEXT: &str = "quetzalcoatl/v2/root-membership-v1";
const SHAMIR_COMMITMENT_CONTEXT: &str = "quetzalcoatl/v2/shamir-root-commitment-v1";

type HmacSha256 = Hmac<Sha256>;
type HmacSha512 = Hmac<Sha512>;

fn fill_random(buf: &mut [u8]) {
    OsRng.fill_bytes(buf);
}

fn integrity_err(detail: impl Into<String>) -> QuetzalcoatlError {
    QuetzalcoatlError::IntegrityViolation {
        detail: detail.into(),
    }
}

fn shake256_expand_96(seed: &[u8; 32]) -> [u8; 96] {
    use sha3::digest::{ExtendableOutput, Update, XofReader};
    let mut hasher = sha3::Shake256::default();
    hasher.update(seed);
    let mut reader = hasher.finalize_xof();
    let mut out = [0u8; 96];
    reader.read(&mut out);
    out
}

fn xwing_combine(ss_m: &[u8; 32], ss_x: &[u8; 32], ct_x: &[u8; 32], pk_x: &[u8; 32]) -> [u8; 32] {
    let mut hasher = Sha3_256::new();
    hasher.update(ss_m);
    hasher.update(ss_x);
    hasher.update(ct_x);
    hasher.update(pk_x);
    hasher.update(XWING_COMBINER_LABEL);
    let digest = hasher.finalize();
    let mut out = [0u8; 32];
    out.copy_from_slice(&digest);
    out
}

/// X-Wing 密钥派生与封装调试分解产物（对齐 `spec/vectors/hpke_xwing.json`）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct XWingEncapDebug {
    pub enc: [u8; XWING_ENC_LEN],
    pub shared_secret: [u8; 32],
    pub mlkem768_ss: [u8; 32],
    pub x25519_ct: [u8; 32],
    pub x25519_ss: [u8; 32],
}

/// X-Wing (`MLKEM768X25519`, HPKE KEM `0x647a`) 密钥对。
#[derive(Clone, Zeroize, ZeroizeOnDrop)]
pub struct XWingKeyPair {
    sk_seed: [u8; 32],
    expanded_96: [u8; 96],
    #[zeroize(skip)]
    pk_bytes: [u8; XWING_PK_LEN],
}

impl XWingKeyPair {
    pub fn generate() -> Result<Self> {
        let mut seed = [0u8; 32];
        fill_random(&mut seed);
        let res = Self::from_seed(seed);
        seed.zeroize();
        res
    }

    pub fn from_seed(sk_seed: [u8; 32]) -> Result<Self> {
        let expanded_96 = shake256_expand_96(&sk_seed);
        let mut d_arr = [0u8; 32];
        let mut z_arr = [0u8; 32];
        let mut sk_x_arr = [0u8; 32];
        d_arr.copy_from_slice(&expanded_96[0..32]);
        z_arr.copy_from_slice(&expanded_96[32..64]);
        sk_x_arr.copy_from_slice(&expanded_96[64..96]);

        let d: B32 = d_arr.into();
        let z: B32 = z_arr.into();
        let (_dk_m, ek_m) = MlKem768::generate_deterministic(&d, &z);
        let ek_m_bytes = ek_m.as_bytes();

        let sk_x = X25519StaticSecret::from(sk_x_arr);
        let pk_x = X25519PublicKey::from(&sk_x);

        let mut pk_bytes = [0u8; XWING_PK_LEN];
        pk_bytes[0..1184].copy_from_slice(ek_m_bytes.as_slice());
        pk_bytes[1184..1216].copy_from_slice(pk_x.as_bytes());

        d_arr.zeroize();
        z_arr.zeroize();
        sk_x_arr.zeroize();

        Ok(Self {
            sk_seed,
            expanded_96,
            pk_bytes,
        })
    }

    #[must_use]
    pub const fn seed(&self) -> &[u8; 32] {
        &self.sk_seed
    }

    #[must_use]
    pub const fn expanded_shake256_96(&self) -> &[u8; 96] {
        &self.expanded_96
    }

    #[must_use]
    pub const fn public_key_bytes(&self) -> &[u8; XWING_PK_LEN] {
        &self.pk_bytes
    }

    #[must_use]
    pub fn x25519_public_key_bytes(&self) -> [u8; 32] {
        let mut out = [0u8; 32];
        out.copy_from_slice(&self.pk_bytes[1184..1216]);
        out
    }

    pub fn encapsulate_deterministic(
        pk_bytes: &[u8; XWING_PK_LEN],
        encap_seed_64: &[u8; 64],
    ) -> Result<XWingEncapDebug> {
        let mut ek_m_raw = Encoded::<EncapsulationKey<MlKem768Params>>::default();
        ek_m_raw.as_mut_slice().copy_from_slice(&pk_bytes[0..1184]);
        let ek_m = EncapsulationKey::<MlKem768Params>::from_bytes(&ek_m_raw);

        let mut pk_x_arr = [0u8; 32];
        pk_x_arr.copy_from_slice(&pk_bytes[1184..1216]);
        let pk_x = X25519PublicKey::from(pk_x_arr);

        let mut m_arr = [0u8; 32];
        let mut ek_x_arr = [0u8; 32];
        m_arr.copy_from_slice(&encap_seed_64[0..32]);
        ek_x_arr.copy_from_slice(&encap_seed_64[32..64]);

        let m_b32: B32 = m_arr.into();
        let (ct_m, ss_m_b32) = ek_m
            .encapsulate_deterministic(&m_b32)
            .map_err(|()| integrity_err("ML-KEM-768 确定性封装失败"))?;

        let ek_x = X25519StaticSecret::from(ek_x_arr);
        let ct_x_pub = X25519PublicKey::from(&ek_x);
        let ss_x_secret = ek_x.diffie_hellman(&pk_x);

        let mut mlkem768_ss = [0u8; 32];
        mlkem768_ss.copy_from_slice(ss_m_b32.as_slice());
        let x25519_ct = *ct_x_pub.as_bytes();
        let x25519_ss = *ss_x_secret.as_bytes();

        let shared_secret = xwing_combine(&mlkem768_ss, &x25519_ss, &x25519_ct, &pk_x_arr);

        let mut enc = [0u8; XWING_ENC_LEN];
        enc[0..1088].copy_from_slice(ct_m.as_slice());
        enc[1088..1120].copy_from_slice(&x25519_ct);

        m_arr.zeroize();
        ek_x_arr.zeroize();

        Ok(XWingEncapDebug {
            enc,
            shared_secret,
            mlkem768_ss,
            x25519_ct,
            x25519_ss,
        })
    }

    pub fn encapsulate(pk_bytes: &[u8; XWING_PK_LEN]) -> Result<([u8; XWING_ENC_LEN], [u8; 32])> {
        let mut seed64 = [0u8; 64];
        fill_random(&mut seed64);
        let res = Self::encapsulate_deterministic(pk_bytes, &seed64);
        seed64.zeroize();
        let debug = res?;
        Ok((debug.enc, debug.shared_secret))
    }

    pub fn decapsulate(&self, enc: &[u8; XWING_ENC_LEN]) -> Result<[u8; 32]> {
        let mut d_arr = [0u8; 32];
        let mut z_arr = [0u8; 32];
        let mut sk_x_arr = [0u8; 32];
        d_arr.copy_from_slice(&self.expanded_96[0..32]);
        z_arr.copy_from_slice(&self.expanded_96[32..64]);
        sk_x_arr.copy_from_slice(&self.expanded_96[64..96]);

        let d: B32 = d_arr.into();
        let z: B32 = z_arr.into();
        let (dk_m, _ek_m): (DecapsulationKey<MlKem768Params>, _) =
            MlKem768::generate_deterministic(&d, &z);

        let mut ct_m = ml_kem::Ciphertext::<MlKem768>::default();
        ct_m.as_mut_slice().copy_from_slice(&enc[0..1088]);
        let ss_m_b32 = dk_m
            .decapsulate(&ct_m)
            .map_err(|()| integrity_err("ML-KEM-768 解封装失败"))?;

        let mut ct_x_arr = [0u8; 32];
        ct_x_arr.copy_from_slice(&enc[1088..1120]);
        let ct_x_pub = X25519PublicKey::from(ct_x_arr);

        let sk_x = X25519StaticSecret::from(sk_x_arr);
        let ss_x_secret = sk_x.diffie_hellman(&ct_x_pub);

        let mut ss_m = [0u8; 32];
        ss_m.copy_from_slice(ss_m_b32.as_slice());
        let ss_x = *ss_x_secret.as_bytes();
        let pk_x = self.x25519_public_key_bytes();

        d_arr.zeroize();
        z_arr.zeroize();
        sk_x_arr.zeroize();

        Ok(xwing_combine(&ss_m, &ss_x, &ct_x_arr, &pk_x))
    }
}

/// RFC 9180 HPKE Base 模式密钥派生结果（`KEM=0x647a, KDF=0x0001, AEAD=0x0003`）。
#[derive(Clone, Debug, PartialEq, Eq, Zeroize, ZeroizeOnDrop)]
pub struct HpkeBaseSchedule {
    pub aead_key: [u8; 32],
    pub base_nonce: [u8; 12],
    pub exporter_secret: [u8; 32],
}

/// RFC 9180 HPKE 密封信封。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct HpkeSealedBox {
    pub enc: Vec<u8>,
    pub ciphertext: Vec<u8>,
}

fn hpke_labeled_extract(salt: &[u8], label: &[u8], ikm: &[u8]) -> Result<[u8; 32]> {
    let effective_salt = if salt.is_empty() {
        &[0u8; 32][..]
    } else {
        salt
    };
    let mut mac = <HmacSha256 as Mac>::new_from_slice(effective_salt)
        .map_err(|e| integrity_err(format!("HMAC-SHA256 初始化失败: {e}")))?;
    mac.update(b"HPKE-v1");
    mac.update(HPKE_SUITE_ID_XWING);
    mac.update(label);
    mac.update(ikm);
    let result = mac.finalize().into_bytes();
    let mut out = [0u8; 32];
    out.copy_from_slice(&result);
    Ok(out)
}

fn hpke_labeled_expand<const L: usize>(
    prk: &[u8; 32],
    label: &[u8],
    info: &[u8],
) -> Result<[u8; L]> {
    let len_u16 =
        u16::try_from(L).map_err(|_| integrity_err("HPKE LabeledExpand 输出长度超出 u16"))?;
    let hk = Hkdf::<Sha256>::from_prk(prk)
        .map_err(|e| integrity_err(format!("HKDF-SHA256 PRK 无效: {e}")))?;
    let mut labeled_info =
        Vec::with_capacity(2 + 7 + HPKE_SUITE_ID_XWING.len() + label.len() + info.len());
    labeled_info.extend_from_slice(&len_u16.to_be_bytes());
    labeled_info.extend_from_slice(b"HPKE-v1");
    labeled_info.extend_from_slice(HPKE_SUITE_ID_XWING);
    labeled_info.extend_from_slice(label);
    labeled_info.extend_from_slice(info);

    let mut out = [0u8; L];
    hk.expand(&labeled_info, &mut out)
        .map_err(|e| integrity_err(format!("HKDF-SHA256 Expand 失败: {e}")))?;
    Ok(out)
}

pub fn hpke_key_schedule_base(shared_secret: &[u8; 32], info: &[u8]) -> Result<HpkeBaseSchedule> {
    let psk_id_hash = hpke_labeled_extract(b"", b"psk_id_hash", b"")?;
    let info_hash = hpke_labeled_extract(b"", b"info_hash", info)?;

    let mut ks_context = [0u8; 65];
    ks_context[0] = 0x00; // mode_base
    ks_context[1..33].copy_from_slice(&psk_id_hash);
    ks_context[33..65].copy_from_slice(&info_hash);

    let mut secret = hpke_labeled_extract(shared_secret, b"secret", b"")?;
    let aead_key = hpke_labeled_expand::<32>(&secret, b"key", &ks_context)?;
    let base_nonce = hpke_labeled_expand::<12>(&secret, b"base_nonce", &ks_context)?;
    let exporter_secret = hpke_labeled_expand::<32>(&secret, b"exp", &ks_context)?;
    secret.zeroize();

    Ok(HpkeBaseSchedule {
        aead_key,
        base_nonce,
        exporter_secret,
    })
}

pub fn hpke_xwing_seal_with_context(
    shared_secret: &[u8; 32],
    info: &[u8],
    aad: &[u8],
    plaintext: &[u8],
) -> Result<(HpkeBaseSchedule, Vec<u8>)> {
    let schedule = hpke_key_schedule_base(shared_secret, info)?;
    let cipher = ChaCha20Poly1305::new((&schedule.aead_key).into());
    let nonce = (&schedule.base_nonce).into();
    let ciphertext = cipher
        .encrypt(
            nonce,
            Payload {
                msg: plaintext,
                aad,
            },
        )
        .map_err(|_| integrity_err("HPKE ChaCha20Poly1305 密封失败"))?;
    Ok((schedule, ciphertext))
}

pub fn hpke_xwing_seal_deterministic(
    pk_bytes: &[u8; XWING_PK_LEN],
    info: &[u8],
    aad: &[u8],
    plaintext: &[u8],
    encap_seed_64: &[u8; 64],
) -> Result<HpkeSealedBox> {
    let debug = XWingKeyPair::encapsulate_deterministic(pk_bytes, encap_seed_64)?;
    let (_schedule, ciphertext) =
        hpke_xwing_seal_with_context(&debug.shared_secret, info, aad, plaintext)?;
    Ok(HpkeSealedBox {
        enc: debug.enc.to_vec(),
        ciphertext,
    })
}

pub fn hpke_xwing_seal(
    pk_bytes: &[u8; XWING_PK_LEN],
    info: &[u8],
    aad: &[u8],
    plaintext: &[u8],
) -> Result<HpkeSealedBox> {
    let (enc, mut ss) = XWingKeyPair::encapsulate(pk_bytes)?;
    let res = hpke_xwing_seal_with_context(&ss, info, aad, plaintext);
    ss.zeroize();
    let (_schedule, ciphertext) = res?;
    Ok(HpkeSealedBox {
        enc: enc.to_vec(),
        ciphertext,
    })
}

pub fn hpke_xwing_open(
    recipient: &XWingKeyPair,
    info: &[u8],
    aad: &[u8],
    sealed: &HpkeSealedBox,
) -> Result<Vec<u8>> {
    if sealed.enc.len() != XWING_ENC_LEN {
        return Err(integrity_err(format!(
            "HPKE X-Wing enc 长度非法: 期望 {XWING_ENC_LEN}，实际 {}",
            sealed.enc.len()
        )));
    }
    let mut enc_arr = [0u8; XWING_ENC_LEN];
    enc_arr.copy_from_slice(&sealed.enc);
    let mut ss = recipient.decapsulate(&enc_arr)?;
    let schedule_res = hpke_key_schedule_base(&ss, info);
    ss.zeroize();
    let schedule = schedule_res?;

    let cipher = ChaCha20Poly1305::new((&schedule.aead_key).into());
    let nonce = (&schedule.base_nonce).into();
    cipher
        .decrypt(
            nonce,
            Payload {
                msg: &sealed.ciphertext,
                aad,
            },
        )
        .map_err(|_| integrity_err("HPKE ChaCha20Poly1305 解密认证失败"))
}

/// 授权设备公开记录。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DevicePublicRecord {
    pub device_id: DeviceId,
    pub ed25519_pubkey: [u8; 32],
    pub xwing_pubkey: Vec<u8>,
}

/// 授权设备本地私钥身份（Ed25519 单写者签名 + X-Wing HPKE 解封）。
#[derive(Clone, Zeroize, ZeroizeOnDrop)]
pub struct DeviceIdentity {
    #[zeroize(skip)]
    device_id: DeviceId,
    ed25519_seed: [u8; 32],
    #[zeroize(skip)]
    ed25519_pubkey: [u8; 32],
    xwing: XWingKeyPair,
}

impl DeviceIdentity {
    pub fn generate(device_id: DeviceId) -> Result<Self> {
        let mut ed_seed = [0u8; 32];
        let mut xw_seed = [0u8; 32];
        fill_random(&mut ed_seed);
        fill_random(&mut xw_seed);
        let res = Self::from_seeds(device_id, ed_seed, xw_seed);
        ed_seed.zeroize();
        xw_seed.zeroize();
        res
    }

    pub fn from_seeds(
        device_id: DeviceId,
        ed25519_seed: [u8; 32],
        xwing_seed: [u8; 32],
    ) -> Result<Self> {
        let signing_key = SigningKey::from_bytes(&ed25519_seed);
        let ed25519_pubkey = signing_key.verifying_key().to_bytes();
        let xwing = XWingKeyPair::from_seed(xwing_seed)?;
        Ok(Self {
            device_id,
            ed25519_seed,
            ed25519_pubkey,
            xwing,
        })
    }

    #[must_use]
    pub const fn device_id(&self) -> DeviceId {
        self.device_id
    }

    #[must_use]
    pub const fn ed25519_seed(&self) -> &[u8; 32] {
        &self.ed25519_seed
    }

    #[must_use]
    pub const fn ed25519_public_key(&self) -> &[u8; 32] {
        &self.ed25519_pubkey
    }

    #[must_use]
    pub const fn xwing_seed(&self) -> &[u8; 32] {
        self.xwing.seed()
    }

    #[must_use]
    pub const fn xwing_keypair(&self) -> &XWingKeyPair {
        &self.xwing
    }

    #[must_use]
    pub const fn xwing_public_key(&self) -> &[u8; XWING_PK_LEN] {
        self.xwing.public_key_bytes()
    }

    #[must_use]
    pub fn public_record(&self) -> DevicePublicRecord {
        DevicePublicRecord {
            device_id: self.device_id,
            ed25519_pubkey: self.ed25519_pubkey,
            xwing_pubkey: self.xwing.public_key_bytes().to_vec(),
        }
    }

    pub fn sign_bytes(&self, message: &[u8]) -> Result<[u8; 64]> {
        let signing_key = SigningKey::from_bytes(&self.ed25519_seed);
        let sig: Signature = signing_key.sign(message);
        Ok(sig.to_bytes())
    }
}

pub fn verify_ed25519_signature(
    pubkey: &[u8; 32],
    message: &[u8],
    signature: &[u8; 64],
) -> Result<()> {
    let vk = VerifyingKey::from_bytes(pubkey)
        .map_err(|e| integrity_err(format!("Ed25519 公钥格式无效: {e}")))?;
    let sig = Signature::from_bytes(signature);
    vk.verify(message, &sig)
        .map_err(|_| integrity_err("Ed25519 签名校验失败"))
}

/// 成员设备授权变更类型。
#[derive(Copy, Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MemberOperation {
    AddDevice,
    RevokeDevice,
}

impl MemberOperation {
    const fn as_str(self) -> &'static str {
        match self {
            Self::AddDevice => "add_device",
            Self::RevokeDevice => "revoke_device",
        }
    }
}

/// 由 `AccountRootKey` 签名的成员设备增删授权记录。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SignedMembershipChange {
    pub agent_id: AgentId,
    pub epoch: Epoch,
    pub op: MemberOperation,
    pub device_id: DeviceId,
    pub ed25519_pubkey: [u8; 32],
    pub xwing_pubkey_blake3: ArtifactId,
    pub root_signature: Vec<u8>,
}

impl SignedMembershipChange {
    fn signing_digest(
        agent_id: AgentId,
        epoch: Epoch,
        op: MemberOperation,
        device_id: DeviceId,
        ed25519_pubkey: &[u8; 32],
        xwing_pubkey_blake3: &ArtifactId,
    ) -> [u8; 32] {
        let canonical = format!(
            "{{\"agent_id\":\"{}\",\"device_id\":\"{}\",\"ed25519_pubkey\":\"{}\",\"epoch\":{},\"op\":\"{}\",\"xwing_pubkey_blake3\":\"{}\"}}",
            agent_id,
            device_id,
            crate::hex_encode(ed25519_pubkey),
            epoch.get(),
            op.as_str(),
            xwing_pubkey_blake3
        );
        blake3::derive_key(MEMBERSHIP_DOMAIN_CONTEXT, canonical.as_bytes())
    }
}

/// 5 种零门槛主权根密钥恢复槽位（对齐 D-18）。
#[derive(Copy, Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RootWrapSlot {
    PasskeyPrf,
    QrPairingHpke,
    GuardianShamir,
    OpaquePin,
    HardwareLocal,
}

impl RootWrapSlot {
    const fn as_str(self) -> &'static str {
        match self {
            Self::PasskeyPrf => "passkey_prf",
            Self::QrPairingHpke => "qr_pairing_hpke",
            Self::GuardianShamir => "guardian_shamir",
            Self::OpaquePin => "opaque_pin",
            Self::HardwareLocal => "hardware_local",
        }
    }
}

/// 通用根密钥封装槽位记录。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct WrappedRootKeySlot {
    pub slot: RootWrapSlot,
    pub aad_utf8: String,
    pub nonce: [u8; 24],
    pub ciphertext: Vec<u8>,
    pub hpke_enc: Option<Vec<u8>>,
}

/// Shamir 门限监护分片（Slot 3）。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
pub struct ShamirShare {
    pub index: u8,
    pub threshold: u8,
    pub value: [u8; 32],
    #[zeroize(skip)]
    pub commitment_blake3: ArtifactId,
}

/// Slot 4（RFC 9807 OPAQUE 导出密钥包裹根密钥）密文记录。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Slot4WrappedRootKey {
    pub aad_utf8: String,
    pub nonce: [u8; 24],
    pub kek_debug_only: Option<[u8; 32]>,
    pub ciphertext: Vec<u8>,
}

/// RFC 9807 Argon2id MHF 参数。
#[derive(Copy, Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct OpaqueMhfParams {
    pub memory_kib: u32,
    pub iterations: u32,
    pub parallelism: u32,
    pub salt: [u8; 16],
}

impl Default for OpaqueMhfParams {
    fn default() -> Self {
        Self {
            memory_kib: 65_536,
            iterations: 3,
            parallelism: 1,
            salt: [0u8; 16],
        }
    }
}

/// RFC 9807 `OPAQUE-Ristretto255-SHA512` 注册信封与中间派生量。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OpaqueEnvelopeBundle {
    pub oprf_output: [u8; 64],
    pub hardened_output: [u8; 64],
    pub randomized_pwd: [u8; 64],
    pub masking_key: [u8; 64],
    pub export_key: [u8; 64],
    pub auth_key: [u8; 64],
    pub client_private_scalar: [u8; 32],
    pub client_public_key: [u8; 32],
    pub server_public_key: [u8; 32],
    pub cleartext_credentials: Vec<u8>,
    pub envelope_nonce: [u8; 32],
    pub envelope_auth_tag: [u8; 64],
    pub envelope: Vec<u8>,
    pub masked_response: Vec<u8>,
}

/// RFC 9807 3DH AKE 握手派生输出。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OpaqueAkeTranscript {
    pub ke1: Vec<u8>,
    pub credential_response: Vec<u8>,
    pub preamble: Vec<u8>,
    pub preamble_sha512: [u8; 64],
    pub dh_ikm: [u8; 96],
    pub prk: [u8; 64],
    pub handshake_secret: [u8; 64],
    pub session_key: [u8; 64],
    pub km2: [u8; 64],
    pub km3: [u8; 64],
    pub server_mac: [u8; 64],
    pub client_mac: [u8; 64],
}

// --- RFC 9380 / RFC 9497 / RFC 9807 辅助原语 ---

fn expand_message_xmd_sha512_64(msg: &[u8], dst: &[u8]) -> Result<[u8; 64]> {
    let dst_len = u8::try_from(dst.len())
        .map_err(|_| integrity_err("expand_message_xmd DST 长度超过 255"))?;
    let mut dst_prime = Vec::with_capacity(dst.len() + 1);
    dst_prime.extend_from_slice(dst);
    dst_prime.push(dst_len);

    // SHA-512 block size s_in_bytes = 128, len_in_bytes = 64 (0x0040)
    let mut h0 = Sha512::new();
    h0.update([0u8; 128]);
    h0.update(msg);
    h0.update(64u16.to_be_bytes());
    h0.update([0u8]);
    h0.update(&dst_prime);
    let b0 = h0.finalize();

    let mut h1 = Sha512::new();
    h1.update(b0);
    h1.update([1u8]);
    h1.update(&dst_prime);
    let b1 = h1.finalize();

    let mut out = [0u8; 64];
    out.copy_from_slice(&b1);
    Ok(out)
}

fn oprf_hash_to_ristretto(input: &[u8]) -> Result<RistrettoPoint> {
    let uniform = expand_message_xmd_sha512_64(input, OPRF_DST_HASH_TO_GROUP)?;
    Ok(RistrettoPoint::from_uniform_bytes(&uniform))
}

fn decode_canonical_scalar(kind: &str, bytes_le: &[u8; 32]) -> Result<Scalar> {
    Option::<Scalar>::from(Scalar::from_canonical_bytes(*bytes_le))
        .ok_or_else(|| integrity_err(format!("{kind} 不是规范 Ristretto255 标量")))
}

fn decode_non_identity_ristretto(kind: &str, bytes: &[u8; 32]) -> Result<RistrettoPoint> {
    let pt = CompressedRistretto(*bytes)
        .decompress()
        .ok_or_else(|| integrity_err(format!("{kind} Ristretto255 点解压缩失败")))?;
    if pt.compress().to_bytes() == [0u8; 32] {
        return Err(integrity_err(format!("{kind} 不允许为单位元")));
    }
    Ok(pt)
}

fn hkdf_extract_sha512(salt: &[u8], ikm: &[u8]) -> Result<[u8; 64]> {
    let effective_salt = if salt.is_empty() {
        &[0u8; 64][..]
    } else {
        salt
    };
    let mut mac = <HmacSha512 as Mac>::new_from_slice(effective_salt)
        .map_err(|e| integrity_err(format!("HMAC-SHA512 初始化失败: {e}")))?;
    mac.update(ikm);
    let digest = mac.finalize().into_bytes();
    let mut out = [0u8; 64];
    out.copy_from_slice(&digest);
    Ok(out)
}

fn hkdf_expand_sha512(prk: &[u8; 64], info: &[u8], out_len: usize) -> Result<Vec<u8>> {
    let hk = Hkdf::<Sha512>::from_prk(prk)
        .map_err(|e| integrity_err(format!("HKDF-SHA512 PRK 无效: {e}")))?;
    let mut out = vec![0u8; out_len];
    hk.expand(info, &mut out)
        .map_err(|e| integrity_err(format!("HKDF-SHA512 Expand 失败: {e}")))?;
    Ok(out)
}

fn hkdf_expand_sha512_fixed<const N: usize>(prk: &[u8; 64], info: &[u8]) -> Result<[u8; N]> {
    let vec = hkdf_expand_sha512(prk, info, N)?;
    let mut out = [0u8; N];
    out.copy_from_slice(&vec);
    Ok(out)
}

fn opaque_expand_label_64(secret: &[u8; 64], label: &[u8], context: &[u8]) -> Result<[u8; 64]> {
    let opaque_label_len = 7usize.saturating_add(label.len());
    let label_u8 = u8::try_from(opaque_label_len)
        .map_err(|_| integrity_err("OPAQUE ExpandLabel label 长度超限"))?;
    let ctx_u8 = u8::try_from(context.len())
        .map_err(|_| integrity_err("OPAQUE ExpandLabel context 长度超限"))?;

    let mut custom_label = Vec::with_capacity(2 + 1 + opaque_label_len + 1 + context.len());
    custom_label.extend_from_slice(&64u16.to_be_bytes());
    custom_label.push(label_u8);
    custom_label.extend_from_slice(b"OPAQUE-");
    custom_label.extend_from_slice(label);
    custom_label.push(ctx_u8);
    custom_label.extend_from_slice(context);

    hkdf_expand_sha512_fixed::<64>(secret, &custom_label)
}

fn append_u16_prefixed(buf: &mut Vec<u8>, item: &[u8]) -> Result<()> {
    let len_u16 =
        u16::try_from(item.len()).map_err(|_| integrity_err("OPAQUE 长度前缀字段超出 u16::MAX"))?;
    buf.extend_from_slice(&len_u16.to_be_bytes());
    buf.extend_from_slice(item);
    Ok(())
}

fn build_cleartext_credentials(
    server_public_key: &[u8; 32],
    client_public_key: &[u8; 32],
    server_identity: &[u8],
    client_identity: &[u8],
) -> Result<Vec<u8>> {
    let effective_server_id = if server_identity.is_empty() {
        &server_public_key[..]
    } else {
        server_identity
    };
    let effective_client_id = if client_identity.is_empty() {
        &client_public_key[..]
    } else {
        client_identity
    };

    let mut out =
        Vec::with_capacity(32 + 2 + effective_server_id.len() + 2 + effective_client_id.len());
    out.extend_from_slice(server_public_key);
    append_u16_prefixed(&mut out, effective_server_id)?;
    append_u16_prefixed(&mut out, effective_client_id)?;
    Ok(out)
}

pub fn opaque_oprf_blind_deterministic(
    password: &[u8],
    blind_scalar_le: &[u8; 32],
) -> Result<[u8; 32]> {
    let blind = decode_canonical_scalar("blind_scalar", blind_scalar_le)?;
    if blind == Scalar::ZERO {
        return Err(integrity_err("OPRF blind 标量不能为零"));
    }
    let h_pwd = oprf_hash_to_ristretto(password)?;
    let blinded = (h_pwd * blind).compress().to_bytes();
    if blinded == [0u8; 32] {
        return Err(integrity_err("OPRF 盲化点退化为单位元"));
    }
    Ok(blinded)
}

pub fn opaque_evaluate_oprf(
    blinded_element: &[u8; 32],
    oprf_key_scalar_le: &[u8; 32],
) -> Result<[u8; 32]> {
    let pt = decode_non_identity_ristretto("blinded_element", blinded_element)?;
    let key = decode_canonical_scalar("oprf_key_scalar", oprf_key_scalar_le)?;
    if key == Scalar::ZERO {
        return Err(integrity_err("OPRF 私钥标量不能为零"));
    }
    Ok((pt * key).compress().to_bytes())
}

pub fn opaque_finalize_oprf(
    password: &[u8],
    blind_scalar_le: &[u8; 32],
    evaluated_element: &[u8; 32],
) -> Result<[u8; 64]> {
    let blind = decode_canonical_scalar("blind_scalar", blind_scalar_le)?;
    if blind == Scalar::ZERO {
        return Err(integrity_err("OPRF blind 标量不能为零"));
    }
    let eval_pt = decode_non_identity_ristretto("evaluated_element", evaluated_element)?;
    let unblinded = (eval_pt * blind.invert()).compress().to_bytes();

    let mut transcript = Vec::with_capacity(2 + password.len() + 2 + 32 + 8);
    append_u16_prefixed(&mut transcript, password)?;
    append_u16_prefixed(&mut transcript, &unblinded)?;
    transcript.extend_from_slice(b"Finalize");

    let digest = Sha512::digest(&transcript);
    let mut out = [0u8; 64];
    out.copy_from_slice(&digest);
    Ok(out)
}

#[allow(clippy::too_many_arguments)]
pub fn opaque_build_envelope_deterministic(
    oprf_output: &[u8; 64],
    mhf: &OpaqueMhfParams,
    envelope_nonce: &[u8; 32],
    masking_nonce: &[u8; 32],
    server_private_scalar_le: &[u8; 32],
    server_identity: &[u8],
    client_identity: &[u8],
) -> Result<OpaqueEnvelopeBundle> {
    let params = Params::new(mhf.memory_kib, mhf.iterations, mhf.parallelism, Some(64))
        .map_err(|e| integrity_err(format!("Argon2id 参数无效: {e}")))?;
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut hardened_output = [0u8; 64];
    argon2
        .hash_password_into(oprf_output, &mhf.salt, &mut hardened_output)
        .map_err(|e| integrity_err(format!("Argon2id 派生失败: {e}")))?;

    let mut concat_pwd = [0u8; 128];
    concat_pwd[0..64].copy_from_slice(oprf_output);
    concat_pwd[64..128].copy_from_slice(&hardened_output);
    let randomized_pwd = hkdf_extract_sha512(b"", &concat_pwd)?;
    concat_pwd.zeroize();

    let masking_key = hkdf_expand_sha512_fixed::<64>(&randomized_pwd, b"MaskingKey")?;

    let mut export_info = Vec::with_capacity(32 + 9);
    export_info.extend_from_slice(envelope_nonce);
    export_info.extend_from_slice(b"ExportKey");
    let export_key = hkdf_expand_sha512_fixed::<64>(&randomized_pwd, &export_info)?;

    let mut auth_info = Vec::with_capacity(32 + 7);
    auth_info.extend_from_slice(envelope_nonce);
    auth_info.extend_from_slice(b"AuthKey");
    let auth_key = hkdf_expand_sha512_fixed::<64>(&randomized_pwd, &auth_info)?;

    let mut priv_info = Vec::with_capacity(32 + 10);
    priv_info.extend_from_slice(envelope_nonce);
    priv_info.extend_from_slice(b"PrivateKey");
    let mut priv_wide = hkdf_expand_sha512_fixed::<64>(&randomized_pwd, &priv_info)?;
    let client_sk = Scalar::from_bytes_mod_order_wide(&priv_wide);
    priv_wide.zeroize();
    let client_private_scalar = client_sk.to_bytes();
    let client_public_key = (RISTRETTO_BASEPOINT_POINT * client_sk)
        .compress()
        .to_bytes();

    let server_sk = decode_canonical_scalar("server_private_scalar", server_private_scalar_le)?;
    let server_public_key = (RISTRETTO_BASEPOINT_POINT * server_sk)
        .compress()
        .to_bytes();

    let cleartext_credentials = build_cleartext_credentials(
        &server_public_key,
        &client_public_key,
        server_identity,
        client_identity,
    )?;

    let mut mac = <HmacSha512 as Mac>::new_from_slice(&auth_key)
        .map_err(|e| integrity_err(format!("Envelope HMAC 初始化失败: {e}")))?;
    mac.update(envelope_nonce);
    mac.update(&cleartext_credentials);
    let tag_bytes = mac.finalize().into_bytes();
    let mut envelope_auth_tag = [0u8; 64];
    envelope_auth_tag.copy_from_slice(&tag_bytes);

    let mut envelope = Vec::with_capacity(96);
    envelope.extend_from_slice(envelope_nonce);
    envelope.extend_from_slice(&envelope_auth_tag);

    let mut pad_info = Vec::with_capacity(32 + 21);
    pad_info.extend_from_slice(masking_nonce);
    pad_info.extend_from_slice(b"CredentialResponsePad");
    let pad = hkdf_expand_sha512(&masking_key, &pad_info, 32 + envelope.len())?;

    let mut plain_resp = Vec::with_capacity(32 + envelope.len());
    plain_resp.extend_from_slice(&server_public_key);
    plain_resp.extend_from_slice(&envelope);

    let masked_response: Vec<u8> = plain_resp
        .iter()
        .zip(pad.iter())
        .map(|(&a, &b)| a ^ b)
        .collect();

    Ok(OpaqueEnvelopeBundle {
        oprf_output: *oprf_output,
        hardened_output,
        randomized_pwd,
        masking_key,
        export_key,
        auth_key,
        client_private_scalar,
        client_public_key,
        server_public_key,
        cleartext_credentials,
        envelope_nonce: *envelope_nonce,
        envelope_auth_tag,
        envelope,
        masked_response,
    })
}

pub fn opaque_open_envelope(
    randomized_pwd: &[u8; 64],
    evaluated_element: &[u8; 32],
    masking_nonce: &[u8; 32],
    masked_response: &[u8],
    server_identity: &[u8],
    client_identity: &[u8],
) -> Result<([u8; 64], [u8; 32], [u8; 32])> {
    let _ = decode_non_identity_ristretto("evaluated_element", evaluated_element)?;
    if masked_response.len() != 128 {
        return Err(integrity_err(format!(
            "OPAQUE masked_response 长度非法: 期望 128，实际 {}",
            masked_response.len()
        )));
    }

    let masking_key = hkdf_expand_sha512_fixed::<64>(randomized_pwd, b"MaskingKey")?;
    let mut pad_info = Vec::with_capacity(32 + 21);
    pad_info.extend_from_slice(masking_nonce);
    pad_info.extend_from_slice(b"CredentialResponsePad");
    let pad = hkdf_expand_sha512(&masking_key, &pad_info, 128)?;

    let unmasked: Vec<u8> = masked_response
        .iter()
        .zip(pad.iter())
        .map(|(&a, &b)| a ^ b)
        .collect();

    let mut server_public_key = [0u8; 32];
    let mut envelope_nonce = [0u8; 32];
    server_public_key.copy_from_slice(&unmasked[0..32]);
    envelope_nonce.copy_from_slice(&unmasked[32..64]);
    let auth_tag_slice = &unmasked[64..128];

    let _ = decode_non_identity_ristretto("server_public_key", &server_public_key)?;

    let mut export_info = Vec::with_capacity(32 + 9);
    export_info.extend_from_slice(&envelope_nonce);
    export_info.extend_from_slice(b"ExportKey");
    let export_key = hkdf_expand_sha512_fixed::<64>(randomized_pwd, &export_info)?;

    let mut auth_info = Vec::with_capacity(32 + 7);
    auth_info.extend_from_slice(&envelope_nonce);
    auth_info.extend_from_slice(b"AuthKey");
    let auth_key = hkdf_expand_sha512_fixed::<64>(randomized_pwd, &auth_info)?;

    let mut priv_info = Vec::with_capacity(32 + 10);
    priv_info.extend_from_slice(&envelope_nonce);
    priv_info.extend_from_slice(b"PrivateKey");
    let mut priv_wide = hkdf_expand_sha512_fixed::<64>(randomized_pwd, &priv_info)?;
    let client_sk = Scalar::from_bytes_mod_order_wide(&priv_wide);
    priv_wide.zeroize();
    let client_private_scalar = client_sk.to_bytes();
    let client_public_key = (RISTRETTO_BASEPOINT_POINT * client_sk)
        .compress()
        .to_bytes();

    let cleartext_credentials = build_cleartext_credentials(
        &server_public_key,
        &client_public_key,
        server_identity,
        client_identity,
    )?;

    let mut mac = <HmacSha512 as Mac>::new_from_slice(&auth_key)
        .map_err(|e| integrity_err(format!("Envelope HMAC 初始化失败: {e}")))?;
    mac.update(&envelope_nonce);
    mac.update(&cleartext_credentials);
    mac.verify_slice(auth_tag_slice)
        .map_err(|_| integrity_err("OPAQUE Envelope 认证标签校验失败"))?;

    Ok((export_key, client_private_scalar, server_public_key))
}

#[allow(clippy::too_many_arguments)]
pub fn opaque_3dh_derive(
    context: &[u8],
    client_identity: &[u8],
    server_identity: &[u8],
    blinded_element: &[u8; 32],
    client_nonce: &[u8; 32],
    client_private_scalar_le: &[u8; 32],
    client_ephemeral_scalar_le: &[u8; 32],
    evaluated_element: &[u8; 32],
    masking_nonce: &[u8; 32],
    masked_response: &[u8],
    server_nonce: &[u8; 32],
    server_private_scalar_le: &[u8; 32],
    server_ephemeral_scalar_le: &[u8; 32],
) -> Result<OpaqueAkeTranscript> {
    let client_sk = decode_canonical_scalar("client_private_scalar", client_private_scalar_le)?;
    let client_eph_sk =
        decode_canonical_scalar("client_ephemeral_scalar", client_ephemeral_scalar_le)?;
    let server_sk = decode_canonical_scalar("server_private_scalar", server_private_scalar_le)?;
    let server_eph_sk =
        decode_canonical_scalar("server_ephemeral_scalar", server_ephemeral_scalar_le)?;

    let client_pk = (RISTRETTO_BASEPOINT_POINT * client_sk)
        .compress()
        .to_bytes();
    let client_eph_pk_pt = RISTRETTO_BASEPOINT_POINT * client_eph_sk;
    let client_eph_pk = client_eph_pk_pt.compress().to_bytes();

    let server_pk_pt = RISTRETTO_BASEPOINT_POINT * server_sk;
    let server_pk = server_pk_pt.compress().to_bytes();
    let server_eph_pk_pt = RISTRETTO_BASEPOINT_POINT * server_eph_sk;
    let server_eph_pk = server_eph_pk_pt.compress().to_bytes();

    let mut ke1 = Vec::with_capacity(96);
    ke1.extend_from_slice(blinded_element);
    ke1.extend_from_slice(client_nonce);
    ke1.extend_from_slice(&client_eph_pk);

    let mut credential_response = Vec::with_capacity(64 + masked_response.len());
    credential_response.extend_from_slice(evaluated_element);
    credential_response.extend_from_slice(masking_nonce);
    credential_response.extend_from_slice(masked_response);

    let effective_client_id = if client_identity.is_empty() {
        &client_pk[..]
    } else {
        client_identity
    };
    let effective_server_id = if server_identity.is_empty() {
        &server_pk[..]
    } else {
        server_identity
    };

    // RFC 9807 Preamble = "RFC9807" || u16(context) || u16(client_id) || ke1 || u16(server_id) || credential_response || server_nonce || server_ephemeral_pk
    let mut preamble = Vec::new();
    preamble.extend_from_slice(b"RFC9807");
    append_u16_prefixed(&mut preamble, context)?;
    append_u16_prefixed(&mut preamble, effective_client_id)?;
    preamble.extend_from_slice(&ke1);
    append_u16_prefixed(&mut preamble, effective_server_id)?;
    preamble.extend_from_slice(&credential_response);
    preamble.extend_from_slice(server_nonce);
    preamble.extend_from_slice(&server_eph_pk);

    let preamble_digest = Sha512::digest(&preamble);
    let mut preamble_sha512 = [0u8; 64];
    preamble_sha512.copy_from_slice(&preamble_digest);

    // 3DH IKM = DH1(client_eph, server_eph) || DH2(client_eph, server_static) || DH3(client_static, server_eph)
    let dh1 = (server_eph_pk_pt * client_eph_sk).compress().to_bytes();
    let dh2 = (server_pk_pt * client_eph_sk).compress().to_bytes();
    let dh3 = (server_eph_pk_pt * client_sk).compress().to_bytes();

    let mut dh_ikm = [0u8; 96];
    dh_ikm[0..32].copy_from_slice(&dh1);
    dh_ikm[32..64].copy_from_slice(&dh2);
    dh_ikm[64..96].copy_from_slice(&dh3);

    let prk = hkdf_extract_sha512(b"", &dh_ikm)?;
    let handshake_secret = opaque_expand_label_64(&prk, b"HandshakeSecret", &preamble_sha512)?;
    let session_key = opaque_expand_label_64(&prk, b"SessionKey", &preamble_sha512)?;
    let km2 = opaque_expand_label_64(&handshake_secret, b"ServerMAC", b"")?;
    let km3 = opaque_expand_label_64(&handshake_secret, b"ClientMAC", b"")?;

    let mut mac_s = <HmacSha512 as Mac>::new_from_slice(&km2)
        .map_err(|e| integrity_err(format!("ServerMAC 初始化失败: {e}")))?;
    mac_s.update(&preamble_sha512);
    let s_mac_bytes = mac_s.finalize().into_bytes();
    let mut server_mac = [0u8; 64];
    server_mac.copy_from_slice(&s_mac_bytes);

    let mut transcript3_hasher = Sha512::new();
    transcript3_hasher.update(&preamble);
    transcript3_hasher.update(server_mac);
    let transcript3_hash = transcript3_hasher.finalize();

    let mut mac_c = <HmacSha512 as Mac>::new_from_slice(&km3)
        .map_err(|e| integrity_err(format!("ClientMAC 初始化失败: {e}")))?;
    mac_c.update(&transcript3_hash);
    let c_mac_bytes = mac_c.finalize().into_bytes();
    let mut client_mac = [0u8; 64];
    client_mac.copy_from_slice(&c_mac_bytes);

    Ok(OpaqueAkeTranscript {
        ke1,
        credential_response,
        preamble,
        preamble_sha512,
        dh_ikm,
        prk,
        handshake_secret,
        session_key,
        km2,
        km3,
        server_mac,
        client_mac,
    })
}

/// 生成随机规范非零 Ristretto255 标量及其压缩公钥点 `(scalar_le, public_point)`。
#[must_use]
pub fn opaque_random_scalar_and_point() -> ([u8; 32], [u8; 32]) {
    loop {
        let mut wide = [0u8; 64];
        fill_random(&mut wide);
        let sc = Scalar::from_bytes_mod_order_wide(&wide);
        wide.zeroize();
        if sc != Scalar::ZERO {
            let pk = (RISTRETTO_BASEPOINT_POINT * sc).compress().to_bytes();
            return (sc.to_bytes(), pk);
        }
    }
}

/// 客户端执行 Argon2id 硬化并提取 `randomized_pwd`。
pub fn opaque_harden_randomized_pwd(
    oprf_output: &[u8; 64],
    mhf: &OpaqueMhfParams,
) -> Result<[u8; 64]> {
    let params = Params::new(mhf.memory_kib, mhf.iterations, mhf.parallelism, Some(64))
        .map_err(|e| integrity_err(format!("Argon2id 参数无效: {e}")))?;
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut hardened_output = [0u8; 64];
    argon2
        .hash_password_into(oprf_output, &mhf.salt, &mut hardened_output)
        .map_err(|e| integrity_err(format!("Argon2id 派生失败: {e}")))?;

    let mut concat_pwd = [0u8; 128];
    concat_pwd[0..64].copy_from_slice(oprf_output);
    concat_pwd[64..128].copy_from_slice(&hardened_output);
    let randomized_pwd = hkdf_extract_sha512(b"", &concat_pwd)?;
    concat_pwd.zeroize();
    hardened_output.zeroize();
    Ok(randomized_pwd)
}

/// 客户端注册阶段构造 RFC 9807 `OpaqueEnvelopeBundle`（仅依赖服务端返回的 `server_public_key`，无需服务端私标量）。
pub fn opaque_client_build_registration(
    oprf_output: &[u8; 64],
    mhf: &OpaqueMhfParams,
    server_public_key: &[u8; 32],
    server_identity: &[u8],
    client_identity: &[u8],
) -> Result<OpaqueEnvelopeBundle> {
    let _ = decode_non_identity_ristretto("server_public_key", server_public_key)?;
    let params = Params::new(mhf.memory_kib, mhf.iterations, mhf.parallelism, Some(64))
        .map_err(|e| integrity_err(format!("Argon2id 参数无效: {e}")))?;
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut hardened_output = [0u8; 64];
    argon2
        .hash_password_into(oprf_output, &mhf.salt, &mut hardened_output)
        .map_err(|e| integrity_err(format!("Argon2id 派生失败: {e}")))?;

    let mut concat_pwd = [0u8; 128];
    concat_pwd[0..64].copy_from_slice(oprf_output);
    concat_pwd[64..128].copy_from_slice(&hardened_output);
    let randomized_pwd = hkdf_extract_sha512(b"", &concat_pwd)?;
    concat_pwd.zeroize();

    let mut envelope_nonce = [0u8; 32];
    let mut masking_nonce = [0u8; 32];
    fill_random(&mut envelope_nonce);
    fill_random(&mut masking_nonce);

    let masking_key = hkdf_expand_sha512_fixed::<64>(&randomized_pwd, b"MaskingKey")?;

    let mut export_info = Vec::with_capacity(32 + 9);
    export_info.extend_from_slice(&envelope_nonce);
    export_info.extend_from_slice(b"ExportKey");
    let export_key = hkdf_expand_sha512_fixed::<64>(&randomized_pwd, &export_info)?;

    let mut auth_info = Vec::with_capacity(32 + 7);
    auth_info.extend_from_slice(&envelope_nonce);
    auth_info.extend_from_slice(b"AuthKey");
    let auth_key = hkdf_expand_sha512_fixed::<64>(&randomized_pwd, &auth_info)?;

    let mut priv_info = Vec::with_capacity(32 + 10);
    priv_info.extend_from_slice(&envelope_nonce);
    priv_info.extend_from_slice(b"PrivateKey");
    let mut priv_wide = hkdf_expand_sha512_fixed::<64>(&randomized_pwd, &priv_info)?;
    let client_sk = Scalar::from_bytes_mod_order_wide(&priv_wide);
    priv_wide.zeroize();
    let client_private_scalar = client_sk.to_bytes();
    let client_public_key = (RISTRETTO_BASEPOINT_POINT * client_sk)
        .compress()
        .to_bytes();

    let cleartext_credentials = build_cleartext_credentials(
        server_public_key,
        &client_public_key,
        server_identity,
        client_identity,
    )?;

    let mut mac = <HmacSha512 as Mac>::new_from_slice(&auth_key)
        .map_err(|e| integrity_err(format!("Envelope HMAC 初始化失败: {e}")))?;
    mac.update(&envelope_nonce);
    mac.update(&cleartext_credentials);
    let tag_bytes = mac.finalize().into_bytes();
    let mut envelope_auth_tag = [0u8; 64];
    envelope_auth_tag.copy_from_slice(&tag_bytes);

    let mut envelope = Vec::with_capacity(96);
    envelope.extend_from_slice(&envelope_nonce);
    envelope.extend_from_slice(&envelope_auth_tag);

    let mut pad_info = Vec::with_capacity(32 + 21);
    pad_info.extend_from_slice(&masking_nonce);
    pad_info.extend_from_slice(b"CredentialResponsePad");
    let pad = hkdf_expand_sha512(&masking_key, &pad_info, 32 + envelope.len())?;

    let mut plain_resp = Vec::with_capacity(32 + envelope.len());
    plain_resp.extend_from_slice(server_public_key);
    plain_resp.extend_from_slice(&envelope);

    let masked_response: Vec<u8> = plain_resp
        .iter()
        .zip(pad.iter())
        .map(|(&a, &b)| a ^ b)
        .collect();

    Ok(OpaqueEnvelopeBundle {
        oprf_output: *oprf_output,
        hardened_output,
        randomized_pwd,
        masking_key,
        export_key,
        auth_key,
        client_private_scalar,
        client_public_key,
        server_public_key: *server_public_key,
        cleartext_credentials,
        envelope_nonce,
        envelope_auth_tag,
        envelope,
        masked_response,
    })
}

/// 客户端登录阶段完成 3DH 密钥协商并输出 `(client_mac_ke3, expected_server_mac)`（对齐 Go `OpaqueClientFinish3DH`）。
#[allow(clippy::too_many_arguments)]
pub fn opaque_client_finish_3dh(
    context: &[u8],
    client_identity: &[u8],
    server_identity: &[u8],
    ke1: &[u8],
    client_private_scalar_le: &[u8; 32],
    client_ephemeral_scalar_le: &[u8; 32],
    credential_response: &[u8],
    server_nonce: &[u8; 32],
    server_public_key: &[u8; 32],
    server_ephemeral_pk: &[u8; 32],
) -> Result<([u8; 64], [u8; 64])> {
    if ke1.len() != 96 || credential_response.len() != 192 {
        return Err(integrity_err("OPAQUE KE1 或 CredentialResponse 长度非法"));
    }
    let client_sk = decode_canonical_scalar("client_private_scalar", client_private_scalar_le)?;
    let client_eph_sk =
        decode_canonical_scalar("client_ephemeral_scalar", client_ephemeral_scalar_le)?;
    let server_pk_pt = decode_non_identity_ristretto("server_public_key", server_public_key)?;
    let server_eph_pt = decode_non_identity_ristretto("server_ephemeral_pk", server_ephemeral_pk)?;

    let client_pk = (RISTRETTO_BASEPOINT_POINT * client_sk)
        .compress()
        .to_bytes();
    let effective_client_id = if client_identity.is_empty() {
        &client_pk[..]
    } else {
        client_identity
    };
    let effective_server_id = if server_identity.is_empty() {
        &server_public_key[..]
    } else {
        server_identity
    };

    let mut preamble = Vec::new();
    preamble.extend_from_slice(b"RFC9807");
    append_u16_prefixed(&mut preamble, context)?;
    append_u16_prefixed(&mut preamble, effective_client_id)?;
    preamble.extend_from_slice(ke1);
    append_u16_prefixed(&mut preamble, effective_server_id)?;
    preamble.extend_from_slice(credential_response);
    preamble.extend_from_slice(server_nonce);
    preamble.extend_from_slice(server_ephemeral_pk);

    let preamble_digest = Sha512::digest(&preamble);
    let mut preamble_sha512 = [0u8; 64];
    preamble_sha512.copy_from_slice(&preamble_digest);

    let dh1 = (server_eph_pt * client_eph_sk).compress().to_bytes();
    let dh2 = (server_pk_pt * client_eph_sk).compress().to_bytes();
    let dh3 = (server_eph_pt * client_sk).compress().to_bytes();
    let mut dh_ikm = [0u8; 96];
    dh_ikm[0..32].copy_from_slice(&dh1);
    dh_ikm[32..64].copy_from_slice(&dh2);
    dh_ikm[64..96].copy_from_slice(&dh3);

    let prk = hkdf_extract_sha512(b"", &dh_ikm)?;
    dh_ikm.zeroize();
    let hs = opaque_expand_label_64(&prk, b"HandshakeSecret", &preamble_sha512)?;
    let km2 = opaque_expand_label_64(&hs, b"ServerMAC", b"")?;
    let km3 = opaque_expand_label_64(&hs, b"ClientMAC", b"")?;

    let mut mac_s = <HmacSha512 as Mac>::new_from_slice(&km2)
        .map_err(|e| integrity_err(format!("ServerMAC 初始化失败: {e}")))?;
    mac_s.update(&preamble_sha512);
    let mut server_mac = [0u8; 64];
    server_mac.copy_from_slice(&mac_s.finalize().into_bytes());

    let mut h3 = Sha512::new();
    h3.update(&preamble);
    h3.update(server_mac);
    let t3_hash = h3.finalize();

    let mut mac_c = <HmacSha512 as Mac>::new_from_slice(&km3)
        .map_err(|e| integrity_err(format!("ClientMAC 初始化失败: {e}")))?;
    mac_c.update(&t3_hash);
    let mut client_mac = [0u8; 64];
    client_mac.copy_from_slice(&mac_c.finalize().into_bytes());

    Ok((client_mac, server_mac))
}

// --- GF(256) Shamir Secret Sharing (AES Irreducible Polynomial 0x11B) ---

const fn gf256_add(a: u8, b: u8) -> u8 {
    a ^ b
}

const fn gf256_mul(mut a: u8, mut b: u8) -> u8 {
    let mut acc = 0u8;
    let mut i = 0;
    while i < 8 {
        let mask = 0u8.wrapping_sub(b & 1);
        acc ^= a & mask;
        let hi_bit = a & 0x80;
        a <<= 1;
        let red_mask = 0u8.wrapping_sub(hi_bit >> 7);
        a ^= 0x1b & red_mask;
        b >>= 1;
        i += 1;
    }
    acc
}

fn gf256_inv(x: u8) -> Result<u8> {
    if x == 0 {
        return Err(integrity_err("GF(256) 零元不存在乘法逆元"));
    }
    // x^254 in GF(2^8) via square-and-multiply
    let mut res = 1u8;
    let mut base = x;
    let mut exp = 254u8;
    while exp > 0 {
        if (exp & 1) != 0 {
            res = gf256_mul(res, base);
        }
        base = gf256_mul(base, base);
        exp >>= 1;
    }
    Ok(res)
}

fn gf256_eval_poly(coeffs: &[u8], x: u8) -> u8 {
    let mut acc = 0u8;
    for &c in coeffs.iter().rev() {
        acc = gf256_add(gf256_mul(acc, x), c);
    }
    acc
}

fn derive_hkdf_256_key(ikm: &[u8], info: &[u8]) -> Result<[u8; 32]> {
    let hk = Hkdf::<Sha256>::new(None, ikm);
    let mut out = [0u8; 32];
    hk.expand(info, &mut out)
        .map_err(|e| integrity_err(format!("HKDF-SHA256 派生槽位密钥失败: {e}")))?;
    Ok(out)
}

fn canonical_slot_aad(agent_id: AgentId, slot: RootWrapSlot) -> String {
    format!(
        "{{\"agent_id\":\"{}\",\"slot\":\"{}\",\"v\":2}}",
        agent_id,
        slot.as_str()
    )
}

/// 单 Agent 主权根密钥（Ed25519 根签名权 + 5 槽位包裹与恢复）。
#[derive(Clone, PartialEq, Eq, Zeroize, ZeroizeOnDrop)]
pub struct AccountRootKey {
    secret: [u8; 32],
}

impl AccountRootKey {
    pub fn generate() -> Result<Self> {
        let mut secret = [0u8; 32];
        fill_random(&mut secret);
        Ok(Self { secret })
    }

    #[must_use]
    pub const fn from_bytes(secret: [u8; 32]) -> Self {
        Self { secret }
    }

    #[must_use]
    pub const fn as_bytes(&self) -> &[u8; 32] {
        &self.secret
    }

    pub fn verifying_key_bytes(&self) -> Result<[u8; 32]> {
        let sk = SigningKey::from_bytes(&self.secret);
        Ok(sk.verifying_key().to_bytes())
    }

    pub fn sign_membership_change(
        &self,
        agent_id: AgentId,
        epoch: Epoch,
        op: MemberOperation,
        device: &DevicePublicRecord,
    ) -> Result<SignedMembershipChange> {
        let xwing_b3 = ArtifactId::from_bytes(*blake3::hash(&device.xwing_pubkey).as_bytes());
        let digest = SignedMembershipChange::signing_digest(
            agent_id,
            epoch,
            op,
            device.device_id,
            &device.ed25519_pubkey,
            &xwing_b3,
        );
        let sk = SigningKey::from_bytes(&self.secret);
        let sig = sk.sign(&digest);
        Ok(SignedMembershipChange {
            agent_id,
            epoch,
            op,
            device_id: device.device_id,
            ed25519_pubkey: device.ed25519_pubkey,
            xwing_pubkey_blake3: xwing_b3,
            root_signature: sig.to_bytes().to_vec(),
        })
    }

    pub fn verify_membership_change(
        root_verifying_key: &[u8; 32],
        change: &SignedMembershipChange,
    ) -> Result<()> {
        if change.root_signature.len() != 64 {
            return Err(integrity_err("成员变更根签名长度不为 64 字节"));
        }
        let mut sig_arr = [0u8; 64];
        sig_arr.copy_from_slice(&change.root_signature);
        let digest = SignedMembershipChange::signing_digest(
            change.agent_id,
            change.epoch,
            change.op,
            change.device_id,
            &change.ed25519_pubkey,
            &change.xwing_pubkey_blake3,
        );
        verify_ed25519_signature(root_verifying_key, &digest, &sig_arr)
    }

    fn wrap_symmetric_slot(
        &self,
        agent_id: AgentId,
        slot: RootWrapSlot,
        kek: &[u8; 32],
    ) -> Result<WrappedRootKeySlot> {
        let aad_utf8 = canonical_slot_aad(agent_id, slot);
        let mut nonce = [0u8; 24];
        fill_random(&mut nonce);
        let cipher = XChaCha20Poly1305::new(kek.into());
        let ciphertext = cipher
            .encrypt(
                XNonce::from_slice(&nonce),
                Payload {
                    msg: &self.secret,
                    aad: aad_utf8.as_bytes(),
                },
            )
            .map_err(|_| integrity_err("根密钥槽位加密失败"))?;
        Ok(WrappedRootKeySlot {
            slot,
            aad_utf8,
            nonce,
            ciphertext,
            hpke_enc: None,
        })
    }

    fn unwrap_symmetric_slot(
        agent_id: AgentId,
        expected_slot: RootWrapSlot,
        kek: &[u8; 32],
        slot: &WrappedRootKeySlot,
    ) -> Result<Self> {
        if slot.slot != expected_slot {
            return Err(integrity_err("根密钥槽位类型不匹配"));
        }
        let expected_aad = canonical_slot_aad(agent_id, expected_slot);
        if slot.aad_utf8 != expected_aad {
            return Err(integrity_err("根密钥槽位 AAD 与目标 Agent 不一致"));
        }
        let cipher = XChaCha20Poly1305::new(kek.into());
        let mut plain = cipher
            .decrypt(
                XNonce::from_slice(&slot.nonce),
                Payload {
                    msg: &slot.ciphertext,
                    aad: slot.aad_utf8.as_bytes(),
                },
            )
            .map_err(|_| integrity_err("根密钥槽位解密认证失败"))?;
        if plain.len() != 32 {
            plain.zeroize();
            return Err(integrity_err("解密后的根密钥长度非法"));
        }
        let mut secret = [0u8; 32];
        secret.copy_from_slice(&plain);
        plain.zeroize();
        Ok(Self { secret })
    }

    /// Slot 1: WebAuthn Passkey `prf` 输出封装。
    pub fn wrap_with_passkey_prf(
        &self,
        agent_id: AgentId,
        prf_output: &[u8; 32],
    ) -> Result<WrappedRootKeySlot> {
        let mut kek = derive_hkdf_256_key(prf_output, b"Quetzalcoatl-Slot1-PasskeyPRF-v1")?;
        let res = self.wrap_symmetric_slot(agent_id, RootWrapSlot::PasskeyPrf, &kek);
        kek.zeroize();
        res
    }

    pub fn unwrap_with_passkey_prf(
        agent_id: AgentId,
        prf_output: &[u8; 32],
        slot: &WrappedRootKeySlot,
    ) -> Result<Self> {
        let mut kek = derive_hkdf_256_key(prf_output, b"Quetzalcoatl-Slot1-PasskeyPRF-v1")?;
        let res = Self::unwrap_symmetric_slot(agent_id, RootWrapSlot::PasskeyPrf, &kek, slot);
        kek.zeroize();
        res
    }

    /// Slot 2: Signal 式扫码抗量子混合 X-Wing HPKE 配对封装。
    pub fn wrap_with_pairing_hpke(
        &self,
        agent_id: AgentId,
        peer_xwing_pk: &[u8; XWING_PK_LEN],
    ) -> Result<WrappedRootKeySlot> {
        let aad_utf8 = canonical_slot_aad(agent_id, RootWrapSlot::QrPairingHpke);
        let sealed = hpke_xwing_seal(
            peer_xwing_pk,
            PAIRING_WRAP_INFO,
            aad_utf8.as_bytes(),
            &self.secret,
        )?;
        Ok(WrappedRootKeySlot {
            slot: RootWrapSlot::QrPairingHpke,
            aad_utf8,
            nonce: [0u8; 24],
            ciphertext: sealed.ciphertext,
            hpke_enc: Some(sealed.enc),
        })
    }

    pub fn unwrap_with_pairing_hpke(
        agent_id: AgentId,
        peer_xwing_kp: &XWingKeyPair,
        slot: &WrappedRootKeySlot,
    ) -> Result<Self> {
        if slot.slot != RootWrapSlot::QrPairingHpke {
            return Err(integrity_err("配对 HPKE 槽位类型不匹配"));
        }
        let expected_aad = canonical_slot_aad(agent_id, RootWrapSlot::QrPairingHpke);
        if slot.aad_utf8 != expected_aad {
            return Err(integrity_err("配对 HPKE 槽位 AAD 不匹配"));
        }
        let enc = slot
            .hpke_enc
            .as_ref()
            .ok_or_else(|| integrity_err("配对 HPKE 槽位缺少封装头部"))?;
        let sealed = HpkeSealedBox {
            enc: enc.clone(),
            ciphertext: slot.ciphertext.clone(),
        };
        let mut plain = hpke_xwing_open(
            peer_xwing_kp,
            PAIRING_WRAP_INFO,
            slot.aad_utf8.as_bytes(),
            &sealed,
        )?;
        if plain.len() != 32 {
            plain.zeroize();
            return Err(integrity_err("配对解封后的根密钥长度非法"));
        }
        let mut secret = [0u8; 32];
        secret.copy_from_slice(&plain);
        plain.zeroize();
        Ok(Self { secret })
    }

    /// Slot 3: 家庭/团队监护人 GF(256) Shamir 门限分片拆分与重组。
    pub fn split_shamir_shares(&self, threshold: u8, total: u8) -> Result<Vec<ShamirShare>> {
        if threshold < 2 || total < threshold {
            return Err(integrity_err(format!(
                "无效 Shamir 门限参数: threshold={threshold}, total={total}"
            )));
        }
        let commitment_blake3 =
            ArtifactId::from_bytes(blake3::derive_key(SHAMIR_COMMITMENT_CONTEXT, &self.secret));
        let degree = usize::from(threshold - 1);
        let mut share_values = vec![[0u8; 32]; usize::from(total)];

        let mut coeffs = vec![0u8; degree + 1];
        for (byte_idx, &secret_byte) in self.secret.iter().enumerate() {
            coeffs[0] = secret_byte;
            fill_random(&mut coeffs[1..]);
            for (share_idx, share_slot) in share_values.iter_mut().enumerate() {
                let x = u8::try_from(share_idx + 1)
                    .map_err(|_| integrity_err("Shamir 分片索引超出 u8"))?;
                share_slot[byte_idx] = gf256_eval_poly(&coeffs, x);
            }
        }
        coeffs.zeroize();

        let mut out = Vec::with_capacity(usize::from(total));
        for (idx, val) in share_values.into_iter().enumerate() {
            let index =
                u8::try_from(idx + 1).map_err(|_| integrity_err("Shamir 分片编号超出范围"))?;
            out.push(ShamirShare {
                index,
                threshold,
                value: val,
                commitment_blake3,
            });
        }
        Ok(out)
    }

    pub fn reconstruct_shamir_shares(shares: &[ShamirShare]) -> Result<Self> {
        let first = shares
            .first()
            .ok_or_else(|| integrity_err("Shamir 分片列表为空"))?;
        let k = usize::from(first.threshold);
        if k < 2 || shares.len() < k {
            return Err(integrity_err(format!(
                "提供的 Shamir 分片数 ({}) 低于门限要求 ({k})",
                shares.len()
            )));
        }

        let used = &shares[0..k];
        for (i, s) in used.iter().enumerate() {
            if s.index == 0 {
                return Err(integrity_err("Shamir 分片横坐标不能为 0"));
            }
            if s.threshold != first.threshold || s.commitment_blake3 != first.commitment_blake3 {
                return Err(integrity_err("Shamir 分片不归属同一门限承诺集"));
            }
            for other in &used[i + 1..] {
                if s.index == other.index {
                    return Err(integrity_err("Shamir 分片存在重复横坐标"));
                }
            }
        }

        let mut secret = [0u8; 32];
        for (byte_idx, slot) in secret.iter_mut().enumerate() {
            let mut acc = 0u8;
            for (i, si) in used.iter().enumerate() {
                let mut num = 1u8;
                let mut den = 1u8;
                for (j, sj) in used.iter().enumerate() {
                    if i == j {
                        continue;
                    }
                    num = gf256_mul(num, sj.index);
                    den = gf256_mul(den, gf256_add(si.index, sj.index));
                }
                let basis = gf256_mul(num, gf256_inv(den)?);
                acc = gf256_add(acc, gf256_mul(si.value[byte_idx], basis));
            }
            *slot = acc;
        }

        let verify_commitment =
            ArtifactId::from_bytes(blake3::derive_key(SHAMIR_COMMITMENT_CONTEXT, &secret));
        if verify_commitment != first.commitment_blake3 {
            secret.zeroize();
            return Err(integrity_err("Shamir 门限重组后的 BLAKE3 承诺校验失败"));
        }
        Ok(Self { secret })
    }

    /// Slot 4: RFC 9807 `OPAQUE` 导出密钥包裹根密钥（确定性 Nonce 供跨语言向量核验）。
    pub fn wrap_slot4_deterministic(
        &self,
        agent_id: AgentId,
        opaque_export_key: &[u8; 64],
        nonce: &[u8; 24],
    ) -> Result<Slot4WrappedRootKey> {
        let mut kek = hkdf_expand_sha512_fixed::<32>(opaque_export_key, SLOT4_KDF_INFO)?;
        let aad_utf8 = canonical_slot_aad(agent_id, RootWrapSlot::OpaquePin);
        let cipher = XChaCha20Poly1305::new((&kek).into());
        let ciphertext = cipher
            .encrypt(
                XNonce::from_slice(nonce),
                Payload {
                    msg: &self.secret,
                    aad: aad_utf8.as_bytes(),
                },
            )
            .map_err(|_| integrity_err("Slot4 XChaCha20-Poly1305 加密失败"))?;
        let kek_copy = kek;
        kek.zeroize();
        Ok(Slot4WrappedRootKey {
            aad_utf8,
            nonce: *nonce,
            kek_debug_only: Some(kek_copy),
            ciphertext,
        })
    }

    pub fn wrap_slot4(
        &self,
        agent_id: AgentId,
        opaque_export_key: &[u8; 64],
    ) -> Result<Slot4WrappedRootKey> {
        let mut nonce = [0u8; 24];
        fill_random(&mut nonce);
        let mut wrapped = self.wrap_slot4_deterministic(agent_id, opaque_export_key, &nonce)?;
        wrapped.kek_debug_only = None;
        Ok(wrapped)
    }

    pub fn unwrap_slot4(
        agent_id: AgentId,
        opaque_export_key: &[u8; 64],
        wrapped: &Slot4WrappedRootKey,
    ) -> Result<Self> {
        let expected_aad = canonical_slot_aad(agent_id, RootWrapSlot::OpaquePin);
        if wrapped.aad_utf8 != expected_aad {
            return Err(integrity_err("Slot4 AAD 与目标 Agent 不一致"));
        }
        let mut kek = hkdf_expand_sha512_fixed::<32>(opaque_export_key, SLOT4_KDF_INFO)?;
        let cipher = XChaCha20Poly1305::new((&kek).into());
        let plain_res = cipher.decrypt(
            XNonce::from_slice(&wrapped.nonce),
            Payload {
                msg: &wrapped.ciphertext,
                aad: wrapped.aad_utf8.as_bytes(),
            },
        );
        kek.zeroize();
        let mut plain = plain_res.map_err(|_| integrity_err("Slot4 根密钥解密认证失败"))?;
        if plain.len() != 32 {
            plain.zeroize();
            return Err(integrity_err("Slot4 解密后的根密钥长度非法"));
        }
        let mut secret = [0u8; 32];
        secret.copy_from_slice(&plain);
        plain.zeroize();
        Ok(Self { secret })
    }

    /// Slot 5: 纯离线本机安全芯片派生密钥封装。
    pub fn wrap_with_hardware_secret(
        &self,
        agent_id: AgentId,
        hw_secret: &[u8; 32],
    ) -> Result<WrappedRootKeySlot> {
        let mut kek = derive_hkdf_256_key(hw_secret, b"Quetzalcoatl-Slot5-HardwareSecret-v1")?;
        let res = self.wrap_symmetric_slot(agent_id, RootWrapSlot::HardwareLocal, &kek);
        kek.zeroize();
        res
    }

    pub fn unwrap_with_hardware_secret(
        agent_id: AgentId,
        hw_secret: &[u8; 32],
        slot: &WrappedRootKeySlot,
    ) -> Result<Self> {
        let mut kek = derive_hkdf_256_key(hw_secret, b"Quetzalcoatl-Slot5-HardwareSecret-v1")?;
        let res = Self::unwrap_symmetric_slot(agent_id, RootWrapSlot::HardwareLocal, &kek, slot);
        kek.zeroize();
        res
    }
}

/// 纪元对称主密钥 `EpochKey[e]`（用于包裹每包随机 `PerPackDEK`）。
#[derive(Clone, PartialEq, Eq, Zeroize, ZeroizeOnDrop)]
pub struct EpochKey([u8; 32]);

impl EpochKey {
    pub fn generate() -> Result<Self> {
        let mut bytes = [0u8; 32];
        fill_random(&mut bytes);
        Ok(Self(bytes))
    }

    #[must_use]
    pub const fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }

    #[must_use]
    pub const fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }
}

/// 面向单台激活设备 X-Wing HPKE 封装的纪元密钥信封。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct WrappedEpochKeyEntry {
    pub agent_id: AgentId,
    pub device_id: DeviceId,
    pub epoch: Epoch,
    pub aad_utf8: String,
    pub sealed: HpkeSealedBox,
}

fn canonical_epoch_wrap_aad(agent_id: AgentId, device_id: DeviceId, epoch: Epoch) -> String {
    format!(
        "{{\"agent_id\":\"{}\",\"device_id\":\"{}\",\"epoch\":{}}}",
        agent_id,
        device_id,
        epoch.get()
    )
}

fn wrap_epoch_key_for_device(
    agent_id: AgentId,
    epoch: Epoch,
    epoch_key: &EpochKey,
    device: &DevicePublicRecord,
) -> Result<WrappedEpochKeyEntry> {
    if device.xwing_pubkey.len() != XWING_PK_LEN {
        return Err(integrity_err(format!(
            "设备 X-Wing 公钥长度非法: {}",
            device.xwing_pubkey.len()
        )));
    }
    let mut pk_arr = [0u8; XWING_PK_LEN];
    pk_arr.copy_from_slice(&device.xwing_pubkey);
    let aad_utf8 = canonical_epoch_wrap_aad(agent_id, device.device_id, epoch);
    let sealed = hpke_xwing_seal(
        &pk_arr,
        EPOCH_KEY_WRAP_INFO,
        aad_utf8.as_bytes(),
        epoch_key.as_bytes(),
    )?;
    Ok(WrappedEpochKeyEntry {
        agent_id,
        device_id: device.device_id,
        epoch,
        aad_utf8,
        sealed,
    })
}

/// Agent 纪元密钥环（管理激活设备表、成员签名审计链与踢人前向轮换 `EpochKey[e+1]`）。
#[derive(Clone)]
pub struct EpochKeyRing {
    agent_id: AgentId,
    root_verifying_key: [u8; 32],
    current_epoch: Epoch,
    epoch_keys: BTreeMap<Epoch, EpochKey>,
    active_devices: BTreeMap<DeviceId, DevicePublicRecord>,
    membership_log: Vec<SignedMembershipChange>,
    wrapped_entries: BTreeMap<(Epoch, DeviceId), WrappedEpochKeyEntry>,
}

impl EpochKeyRing {
    pub fn new_genesis(
        agent_id: AgentId,
        root_key: &AccountRootKey,
        initial_device: DevicePublicRecord,
    ) -> Result<Self> {
        let root_verifying_key = root_key.verifying_key_bytes()?;
        let epoch1 = Epoch::new(1);
        let key1 = EpochKey::generate()?;

        let signed = root_key.sign_membership_change(
            agent_id,
            epoch1,
            MemberOperation::AddDevice,
            &initial_device,
        )?;
        let wrapped = wrap_epoch_key_for_device(agent_id, epoch1, &key1, &initial_device)?;

        let mut epoch_keys = BTreeMap::new();
        epoch_keys.insert(epoch1, key1);

        let mut active_devices = BTreeMap::new();
        let dev_id = initial_device.device_id;
        active_devices.insert(dev_id, initial_device);

        let mut wrapped_entries = BTreeMap::new();
        wrapped_entries.insert((epoch1, dev_id), wrapped);

        Ok(Self {
            agent_id,
            root_verifying_key,
            current_epoch: epoch1,
            epoch_keys,
            active_devices,
            membership_log: vec![signed],
            wrapped_entries,
        })
    }

    #[must_use]
    pub const fn agent_id(&self) -> AgentId {
        self.agent_id
    }

    #[must_use]
    pub const fn current_epoch(&self) -> Epoch {
        self.current_epoch
    }

    #[must_use]
    pub const fn root_verifying_key(&self) -> &[u8; 32] {
        &self.root_verifying_key
    }

    #[must_use]
    pub fn current_epoch_key(&self) -> Option<&EpochKey> {
        self.epoch_keys.get(&self.current_epoch)
    }

    #[must_use]
    pub fn epoch_key(&self, epoch: Epoch) -> Option<&EpochKey> {
        self.epoch_keys.get(&epoch)
    }

    pub fn insert_epoch_key(&mut self, epoch: Epoch, key: EpochKey) {
        if epoch > self.current_epoch {
            self.current_epoch = epoch;
        }
        self.epoch_keys.insert(epoch, key);
    }

    #[must_use]
    pub fn is_device_active(&self, device_id: DeviceId) -> bool {
        self.active_devices.contains_key(&device_id)
    }

    #[must_use]
    pub fn active_device_pubkey(&self, device_id: DeviceId) -> Option<&[u8; 32]> {
        self.active_devices
            .get(&device_id)
            .map(|r| &r.ed25519_pubkey)
    }

    #[must_use]
    pub fn active_devices(&self) -> &BTreeMap<DeviceId, DevicePublicRecord> {
        &self.active_devices
    }

    #[must_use]
    pub fn membership_log(&self) -> &[SignedMembershipChange] {
        &self.membership_log
    }

    #[must_use]
    pub fn wrapped_entry_for(
        &self,
        epoch: Epoch,
        device_id: DeviceId,
    ) -> Option<&WrappedEpochKeyEntry> {
        self.wrapped_entries.get(&(epoch, device_id))
    }

    fn verify_root_owner(&self, root_key: &AccountRootKey) -> Result<()> {
        if root_key.verifying_key_bytes()? != self.root_verifying_key {
            return Err(QuetzalcoatlError::PermissionDenied {
                detail: String::from("提供的 AccountRootKey 与当前主权脊柱根公钥不匹配"),
            });
        }
        Ok(())
    }

    /// 授权新设备加入当前主权脊柱并封装当前纪元密钥。
    pub fn add_device(
        &mut self,
        root_key: &AccountRootKey,
        device: DevicePublicRecord,
    ) -> Result<SignedMembershipChange> {
        self.verify_root_owner(root_key)?;
        let current_key = self
            .epoch_keys
            .get(&self.current_epoch)
            .ok_or_else(|| integrity_err("当前纪元密钥缺失"))?
            .clone();

        let change = root_key.sign_membership_change(
            self.agent_id,
            self.current_epoch,
            MemberOperation::AddDevice,
            &device,
        )?;
        let wrapped =
            wrap_epoch_key_for_device(self.agent_id, self.current_epoch, &current_key, &device)?;

        let dev_id = device.device_id;
        self.active_devices.insert(dev_id, device);
        self.wrapped_entries
            .insert((self.current_epoch, dev_id), wrapped);
        self.membership_log.push(change.clone());
        Ok(change)
    }

    /// 吊销丢失或失陷设备：立即推进至 `Epoch[e+1]` 并生成全新 `EpochKey[e+1]`，仅向剩余激活设备封装。
    pub fn revoke_device(
        &mut self,
        root_key: &AccountRootKey,
        revoked_device_id: DeviceId,
    ) -> Result<(Epoch, SignedMembershipChange)> {
        self.verify_root_owner(root_key)?;
        let removed = self
            .active_devices
            .remove(&revoked_device_id)
            .ok_or_else(|| integrity_err("待吊销设备不在当前激活设备集合中"))?;
        if self.active_devices.is_empty() {
            // 回滚防止主权脊柱零存活设备死锁
            self.active_devices.insert(revoked_device_id, removed);
            return Err(QuetzalcoatlError::PermissionDenied {
                detail: String::from("不允许吊销最后一台存活授权设备"),
            });
        }

        let next_epoch = self.current_epoch.next()?;
        let new_epoch_key = EpochKey::generate()?;
        let change = root_key.sign_membership_change(
            self.agent_id,
            next_epoch,
            MemberOperation::RevokeDevice,
            &removed,
        )?;

        for (&dev_id, dev_record) in &self.active_devices {
            let wrapped =
                wrap_epoch_key_for_device(self.agent_id, next_epoch, &new_epoch_key, dev_record)?;
            self.wrapped_entries.insert((next_epoch, dev_id), wrapped);
        }

        self.current_epoch = next_epoch;
        self.epoch_keys.insert(next_epoch, new_epoch_key);
        self.membership_log.push(change.clone());
        Ok((next_epoch, change))
    }

    /// 供设备使用自身 `DeviceIdentity` 解封属于该设备的 `EpochKey[e]`。
    pub fn unwrap_for_device(
        device: &DeviceIdentity,
        entry: &WrappedEpochKeyEntry,
    ) -> Result<EpochKey> {
        let expected_aad =
            canonical_epoch_wrap_aad(entry.agent_id, device.device_id(), entry.epoch);
        if entry.device_id != device.device_id() || entry.aad_utf8 != expected_aad {
            return Err(integrity_err(
                "WrappedEpochKeyEntry 设备标识或 AAD 与当前设备不匹配",
            ));
        }
        let mut plain = hpke_xwing_open(
            device.xwing_keypair(),
            EPOCH_KEY_WRAP_INFO,
            entry.aad_utf8.as_bytes(),
            &entry.sealed,
        )?;
        if plain.len() != 32 {
            plain.zeroize();
            return Err(integrity_err("解封后的纪元密钥长度不为 32 字节"));
        }
        let mut key_bytes = [0u8; 32];
        key_bytes.copy_from_slice(&plain);
        plain.zeroize();
        Ok(EpochKey(key_bytes))
    }
}
