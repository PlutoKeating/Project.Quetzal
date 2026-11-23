use std::io::{Read, Write};

use chacha20poly1305::{
    KeyInit, XChaCha20Poly1305, XNonce,
    aead::{Aead, Payload},
};
use quetzalcoatl_types::{
    AgentId, ArtifactId, DeviceId, Epoch, HlcTimestamp, QuetzalcoatlError, Result,
};
use rand_core::{OsRng, RngCore};
use serde::{Deserialize, Serialize};
use zeroize::Zeroize;

use crate::keys::EpochKey;

/// Packfile `zstd` 最大窗口对数（`2^20 = 1 MiB`，守护 iOS `<12MB` NSE 内存预算）。
pub const ZSTD_MAX_WINDOW_LOG: u32 = 20;
/// Packfile `zstd` 最大滑动窗口字节数（`1_048_576 B`）。
pub const ZSTD_MAX_WINDOW_BYTES: usize = 1_048_576;
/// 解压单包未压缩上限保护（`16 MiB`，防止压缩炸弹 OOM）。
const MAX_DECOMPRESSED_PACK_BYTES: u64 = 16 * 1024 * 1024;
/// CRIME 防侧信道最小 2 的幂次分桶长度（`256 B`）。
pub const MIN_BUCKET_BYTES: usize = 256;
/// 单写者脊柱事件 BLAKE3 派生上下文常量。
pub const SPINE_EVENT_HASH_CONTEXT: &str = "quetzalcoatl/v2/spine-event-v1";

const ZSTD_MAGIC_LE: [u8; 4] = [0x28, 0xb5, 0x2f, 0xfd];

fn integrity_err(detail: impl Into<String>) -> QuetzalcoatlError {
    QuetzalcoatlError::IntegrityViolation {
        detail: detail.into(),
    }
}

/// 敏感核心状态与外部不可信通道消息物理分包隔离域（防坑规范 #9）。
#[derive(Copy, Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PackCompartment {
    Core,
    ExternalChannel,
}

impl PackCompartment {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Core => "core",
            Self::ExternalChannel => "external_channel",
        }
    }
}

/// 结构化规范 `AAD`（严格按字段字典序编码以逐字节对齐 `spec/vectors/spine_pack_aad.json`）。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PackAad {
    pub agent_id: AgentId,
    pub compartment: PackCompartment,
    pub device_id: DeviceId,
    pub epoch: u64,
    pub first_seq: u64,
    pub last_seq: u64,
    pub max_hlc: HlcTimestamp,
    pub min_hlc: HlcTimestamp,
    pub padded_len: usize,
    pub uncompressed_blake3: ArtifactId,
    pub v: u32,
}

impl PackAad {
    #[must_use]
    pub fn to_canonical_json(&self) -> String {
        format!(
            "{{\"agent_id\":\"{}\",\"compartment\":\"{}\",\"device_id\":\"{}\",\"epoch\":{},\"first_seq\":{},\"last_seq\":{},\"max_hlc\":\"{}\",\"min_hlc\":\"{}\",\"padded_len\":{},\"uncompressed_blake3\":\"{}\",\"v\":{}}}",
            self.agent_id,
            self.compartment.as_str(),
            self.device_id,
            self.epoch,
            self.first_seq,
            self.last_seq,
            self.max_hlc.to_hex(),
            self.min_hlc.to_hex(),
            self.padded_len,
            self.uncompressed_blake3.to_hex(),
            self.v,
        )
    }
}

/// 密封完成的 E2EE 状态脊柱 Packfile。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SealedPackfile {
    pub pack_id: ArtifactId,
    pub aad: PackAad,
    pub aad_utf8: String,
    pub dek_wrap_nonce: [u8; 24],
    pub wrapped_dek: Vec<u8>,
    pub pack_nonce: [u8; 24],
    pub ciphertext: Vec<u8>,
}

/// 计算 CRIME 防侧信道 2 的幂次分桶长度：`max(256, next_power_of_two(4 + compressed_len))`。
pub fn compute_bucket_len(compressed_len: usize) -> Result<usize> {
    let total = compressed_len
        .checked_add(4)
        .ok_or_else(|| integrity_err("压缩负载长度加法溢出"))?;
    let pow2 = total
        .checked_next_power_of_two()
        .ok_or_else(|| integrity_err("压缩负载分桶长度超出 usize 2 的幂次上限"))?;
    Ok(pow2.max(MIN_BUCKET_BYTES))
}

/// 构造 `u32_be(compressed_len) || zstd_bytes || zero_pad_to_pow2_bucket` 分桶明文帧。
pub fn build_padded_frame(zstd_compressed: &[u8]) -> Result<Vec<u8>> {
    let len_u32 = u32::try_from(zstd_compressed.len())
        .map_err(|_| integrity_err("zstd 压缩长度超出 u32::MAX"))?;
    let bucket_len = compute_bucket_len(zstd_compressed.len())?;
    let mut frame = vec![0u8; bucket_len];
    frame[0..4].copy_from_slice(&len_u32.to_be_bytes());
    frame[4..4 + zstd_compressed.len()].copy_from_slice(zstd_compressed);
    Ok(frame)
}

/// 拆解并严格核验分桶填充帧（含零字节尾部填充全零校验，防止侧信道隐写污染）。
pub fn parse_padded_frame(padded_frame: &[u8]) -> Result<&[u8]> {
    if padded_frame.len() < MIN_BUCKET_BYTES || !padded_frame.len().is_power_of_two() {
        return Err(integrity_err(format!(
            "分桶明文长度非法: {}（必须 >= 256 且为 2 的幂）",
            padded_frame.len()
        )));
    }
    let mut len_bytes = [0u8; 4];
    len_bytes.copy_from_slice(&padded_frame[0..4]);
    let compressed_len = u32::from_be_bytes(len_bytes) as usize;
    let end_offset = 4usize
        .checked_add(compressed_len)
        .ok_or_else(|| integrity_err("分桶头部声明长度溢出"))?;
    if end_offset > padded_frame.len() {
        return Err(integrity_err(format!(
            "分桶头部声明长度 ({compressed_len}) 超出帧总长 ({})",
            padded_frame.len()
        )));
    }
    if compute_bucket_len(compressed_len)? != padded_frame.len() {
        return Err(integrity_err("分桶长度与最小规范 2 的幂次桶不匹配"));
    }
    if padded_frame[end_offset..].iter().any(|&b| b != 0) {
        return Err(integrity_err("分桶填充区包含非零字节"));
    }
    Ok(&padded_frame[4..end_offset])
}

/// 按 RFC 8878 §3.1.1.1 预扫描 Zstandard 帧头：
/// 1. 严格计算 `Window_Descriptor` 与 `Dictionary_ID` 字节偏移后再读取 `Frame_Content_Size`；
/// 2. 严禁滑动窗口或声明内容长度 `> 1 MiB`（守护 `<12MB` iOS NSE）；
/// 3. 严禁非零 `Dictionary_ID_flag`（脊柱 Packfile 绝不依赖外部字典）。
fn inspect_zstd_frame_header_window(compressed: &[u8]) -> Result<()> {
    if compressed.len() < 6 || compressed[0..4] != ZSTD_MAGIC_LE {
        return Err(integrity_err("Zstd 魔数或最小帧头长度校验失败"));
    }
    let fhd = compressed[4];
    let fcs_flag = fhd >> 6;
    let single_segment = ((fhd >> 5) & 1) != 0;
    let reserved_bit = ((fhd >> 3) & 1) != 0;
    let dict_id_flag = fhd & 0x03;
    if reserved_bit {
        return Err(integrity_err("Zstd 帧头包含非零保留位"));
    }

    let mut offset: usize = 5;
    if !single_segment {
        if compressed.len() <= offset {
            return Err(integrity_err("Zstd 多段帧缺少 Window_Descriptor"));
        }
        let wd = compressed[offset];
        offset += 1;
        let exponent = u32::from(wd >> 3) + 10;
        let mantissa = u64::from(wd & 0x07);
        if exponent > 30 {
            return Err(integrity_err(format!(
                "Zstd 窗口指数过大: exponent={exponent}"
            )));
        }
        let window_base = 1u64 << exponent;
        let window_size = window_base + (window_base >> 3) * mantissa;
        if window_size > ZSTD_MAX_WINDOW_BYTES as u64 {
            return Err(integrity_err(format!(
                "Zstd 帧请求窗口 ({window_size} B) 超出 1MiB 安全上限 ({ZSTD_MAX_WINDOW_BYTES} B)"
            )));
        }
    }

    let dict_id_len: usize = match dict_id_flag {
        0 => 0,
        1 => 1,
        2 => 2,
        _ => 4,
    };
    if compressed.len() < offset + dict_id_len {
        return Err(integrity_err("Zstd 帧头缺少完整的 Dictionary_ID 字段"));
    }
    offset += dict_id_len;

    let fcs_field_len: usize = match (fcs_flag, single_segment) {
        (0, false) => 0,
        (0, true) => 1,
        (1, _) => 2,
        (2, _) => 4,
        _ => 8,
    };
    if fcs_field_len > 0 {
        if compressed.len() < offset + fcs_field_len {
            return Err(integrity_err("Zstd 帧头缺少完整的 Frame_Content_Size 字段"));
        }
        let s = &compressed[offset..offset + fcs_field_len];
        let fcs: u64 = match fcs_field_len {
            1 => u64::from(s[0]),
            2 => u64::from(u16::from_le_bytes([s[0], s[1]])) + 256,
            4 => u64::from(u32::from_le_bytes([s[0], s[1], s[2], s[3]])),
            _ => u64::from_le_bytes([s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7]]),
        };
        if single_segment && fcs > ZSTD_MAX_WINDOW_BYTES as u64 {
            return Err(integrity_err(format!(
                "Zstd 单段帧内容窗口 ({fcs} B) 超出 1MiB 安全上限"
            )));
        }
        if fcs > MAX_DECOMPRESSED_PACK_BYTES {
            return Err(integrity_err(format!(
                "Zstd 帧声明内容大小 ({fcs} B) 超出单包解压上限"
            )));
        }
    }

    if dict_id_flag != 0 {
        return Err(integrity_err(
            "Zstd 帧禁止携带外部字典标识 (Dictionary_ID_flag != 0)",
        ));
    }

    Ok(())
}

/// 使用 `zstd` 压缩并强制约束 `windowLog <= 20`（最大 `1 MiB` 窗口）。
pub fn zstd_compress_1mib(uncompressed: &[u8]) -> Result<Vec<u8>> {
    let mut encoder = zstd::stream::write::Encoder::new(Vec::new(), 3)
        .map_err(|e| integrity_err(format!("Zstd 编码器初始化失败: {e}")))?;
    encoder
        .window_log(ZSTD_MAX_WINDOW_LOG)
        .map_err(|e| integrity_err(format!("Zstd 设置 windowLog<=20 失败: {e}")))?;
    encoder
        .write_all(uncompressed)
        .map_err(|e| integrity_err(format!("Zstd 压缩写入失败: {e}")))?;
    encoder
        .finish()
        .map_err(|e| integrity_err(format!("Zstd 压缩收尾失败: {e}")))
}

/// 解压 `zstd` 数据，执行帧头预检 + `window_log_max(20)` 双重拦截。
pub fn zstd_decompress_1mib_guarded(compressed: &[u8]) -> Result<Vec<u8>> {
    inspect_zstd_frame_header_window(compressed)?;
    let mut decoder = zstd::stream::read::Decoder::new(compressed)
        .map_err(|e| integrity_err(format!("Zstd 解码器初始化失败: {e}")))?;
    decoder
        .window_log_max(ZSTD_MAX_WINDOW_LOG)
        .map_err(|e| integrity_err(format!("Zstd 设置 window_log_max(20) 失败: {e}")))?;

    let mut out = Vec::new();
    let mut limited = decoder.take(MAX_DECOMPRESSED_PACK_BYTES + 1);
    limited
        .read_to_end(&mut out)
        .map_err(|e| integrity_err(format!("Zstd 解压失败或窗口超限: {e}")))?;
    if out.len() as u64 > MAX_DECOMPRESSED_PACK_BYTES {
        return Err(integrity_err("Zstd 解压输出超出单包上限"));
    }
    Ok(out)
}

fn compute_pack_id(ciphertext: &[u8]) -> ArtifactId {
    ArtifactId::from_bytes(*blake3::hash(ciphertext).as_bytes())
}

#[allow(clippy::too_many_arguments)]
pub fn seal_packfile_with_materials(
    agent_id: AgentId,
    device_id: DeviceId,
    compartment: PackCompartment,
    epoch: Epoch,
    epoch_key: &EpochKey,
    first_seq: u64,
    last_seq: u64,
    min_hlc: HlcTimestamp,
    max_hlc: HlcTimestamp,
    uncompressed_bytes: &[u8],
    precompressed_override: Option<&[u8]>,
    per_pack_dek: &[u8; 32],
    dek_wrap_nonce: &[u8; 24],
    pack_nonce: &[u8; 24],
) -> Result<SealedPackfile> {
    if first_seq == 0 || first_seq > last_seq || min_hlc > max_hlc {
        return Err(integrity_err(
            "Packfile AAD 边界非法（必须满足 1 <= first_seq <= last_seq 且 min_hlc <= max_hlc）",
        ));
    }
    let owned_compressed;
    let zstd_bytes: &[u8] = if let Some(pre) = precompressed_override {
        inspect_zstd_frame_header_window(pre)?;
        pre
    } else {
        owned_compressed = zstd_compress_1mib(uncompressed_bytes)?;
        &owned_compressed
    };

    let mut padded_frame = build_padded_frame(zstd_bytes)?;
    let uncompressed_blake3 = ArtifactId::from_bytes(*blake3::hash(uncompressed_bytes).as_bytes());

    let aad = PackAad {
        agent_id,
        compartment,
        device_id,
        epoch: epoch.get(),
        first_seq,
        last_seq,
        max_hlc,
        min_hlc,
        padded_len: padded_frame.len(),
        uncompressed_blake3,
        v: 2,
    };
    let aad_utf8 = aad.to_canonical_json();

    let dek_wrapper = XChaCha20Poly1305::new(epoch_key.as_bytes().into());
    let wrapped_dek = dek_wrapper
        .encrypt(
            XNonce::from_slice(dek_wrap_nonce),
            Payload {
                msg: per_pack_dek,
                aad: aad_utf8.as_bytes(),
            },
        )
        .map_err(|_| integrity_err("包裹 PerPackDEK 失败"))?;

    let pack_cipher = XChaCha20Poly1305::new(per_pack_dek.into());
    let ciphertext_res = pack_cipher.encrypt(
        XNonce::from_slice(pack_nonce),
        Payload {
            msg: &padded_frame,
            aad: aad_utf8.as_bytes(),
        },
    );
    padded_frame.zeroize();
    let ciphertext = ciphertext_res.map_err(|_| integrity_err("加密 Packfile 分桶帧失败"))?;

    let pack_id = compute_pack_id(&ciphertext);

    Ok(SealedPackfile {
        pack_id,
        aad,
        aad_utf8,
        dek_wrap_nonce: *dek_wrap_nonce,
        wrapped_dek,
        pack_nonce: *pack_nonce,
        ciphertext,
    })
}

#[allow(clippy::too_many_arguments)]
pub fn seal_packfile(
    agent_id: AgentId,
    device_id: DeviceId,
    compartment: PackCompartment,
    epoch: Epoch,
    epoch_key: &EpochKey,
    first_seq: u64,
    last_seq: u64,
    min_hlc: HlcTimestamp,
    max_hlc: HlcTimestamp,
    uncompressed_bytes: &[u8],
) -> Result<SealedPackfile> {
    let mut per_pack_dek = [0u8; 32];
    let mut dek_wrap_nonce = [0u8; 24];
    let mut pack_nonce = [0u8; 24];
    OsRng.fill_bytes(&mut per_pack_dek);
    OsRng.fill_bytes(&mut dek_wrap_nonce);
    OsRng.fill_bytes(&mut pack_nonce);

    let res = seal_packfile_with_materials(
        agent_id,
        device_id,
        compartment,
        epoch,
        epoch_key,
        first_seq,
        last_seq,
        min_hlc,
        max_hlc,
        uncompressed_bytes,
        None,
        &per_pack_dek,
        &dek_wrap_nonce,
        &pack_nonce,
    );
    per_pack_dek.zeroize();
    res
}

pub fn open_packfile(pack: &SealedPackfile, epoch_key: &EpochKey) -> Result<Vec<u8>> {
    if pack.aad.first_seq == 0
        || pack.aad.first_seq > pack.aad.last_seq
        || pack.aad.min_hlc > pack.aad.max_hlc
    {
        return Err(integrity_err("Packfile AAD 序号或 HLC 区间非法"));
    }
    let expected_canonical_aad = pack.aad.to_canonical_json();
    if pack.aad_utf8 != expected_canonical_aad {
        return Err(integrity_err("Packfile AAD 字符串与结构化 AAD 字段不一致"));
    }

    let dek_wrapper = XChaCha20Poly1305::new(epoch_key.as_bytes().into());
    let mut dek_vec = dek_wrapper
        .decrypt(
            XNonce::from_slice(&pack.dek_wrap_nonce),
            Payload {
                msg: &pack.wrapped_dek,
                aad: pack.aad_utf8.as_bytes(),
            },
        )
        .map_err(|_| integrity_err("解封 PerPackDEK 失败（AAD 或包裹密文已被篡改）"))?;

    if dek_vec.len() != 32 {
        dek_vec.zeroize();
        return Err(integrity_err("PerPackDEK 长度不为 32 字节"));
    }
    let mut dek_arr = [0u8; 32];
    dek_arr.copy_from_slice(&dek_vec);
    dek_vec.zeroize();

    let pack_cipher = XChaCha20Poly1305::new((&dek_arr).into());
    let padded_res = pack_cipher.decrypt(
        XNonce::from_slice(&pack.pack_nonce),
        Payload {
            msg: &pack.ciphertext,
            aad: pack.aad_utf8.as_bytes(),
        },
    );
    dek_arr.zeroize();
    let mut padded_frame =
        padded_res.map_err(|_| integrity_err("Packfile 密文认证标签校验失败"))?;

    let expected_pack_id = compute_pack_id(&pack.ciphertext);
    if pack.pack_id != expected_pack_id {
        padded_frame.zeroize();
        return Err(integrity_err("Packfile pack_id BLAKE3 校验失败"));
    }

    if padded_frame.len() != pack.aad.padded_len {
        padded_frame.zeroize();
        return Err(integrity_err("解密后的分桶帧长度与 AAD 声明不一致"));
    }

    let decompressed_res = parse_padded_frame(&padded_frame).and_then(zstd_decompress_1mib_guarded);
    padded_frame.zeroize();
    let uncompressed = decompressed_res?;

    let actual_b3 = ArtifactId::from_bytes(*blake3::hash(&uncompressed).as_bytes());
    if actual_b3 != pack.aad.uncompressed_blake3 {
        return Err(integrity_err("解压后明文 BLAKE3 摘要与 AAD 不匹配"));
    }

    Ok(uncompressed)
}

/// 密封归档清单信封（用于 `.quetzalcoatl-spine/manifest.json`，零敏感明文落盘）。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SealedManifestEnvelope {
    pub v: u32,
    pub agent_id: AgentId,
    pub epoch: u64,
    pub padded_len: usize,
    pub uncompressed_blake3: ArtifactId,
    pub aad_utf8: String,
    pub nonce_hex: String,
    pub ciphertext_hex: String,
}

fn canonical_manifest_aad(
    agent_id: AgentId,
    epoch: u64,
    padded_len: usize,
    uncompressed_blake3: ArtifactId,
    v: u32,
) -> String {
    format!(
        "{{\"agent_id\":\"{}\",\"epoch\":{},\"padded_len\":{},\"purpose\":\"spine_archive_manifest\",\"uncompressed_blake3\":\"{}\",\"v\":{}}}",
        agent_id,
        epoch,
        padded_len,
        uncompressed_blake3.to_hex(),
        v,
    )
}

/// 使用 `EpochKey[epoch]` 对归档清单负载执行 `zstd(<=1MiB)` + 2 的幂次分桶填充 + `XChaCha20-Poly1305` 密封。
pub fn seal_manifest_envelope(
    agent_id: AgentId,
    epoch: Epoch,
    epoch_key: &EpochKey,
    plaintext_bytes: &[u8],
) -> Result<SealedManifestEnvelope> {
    let compressed = zstd_compress_1mib(plaintext_bytes)?;
    let mut padded = build_padded_frame(&compressed)?;
    let uncompressed_blake3 = ArtifactId::from_bytes(*blake3::hash(plaintext_bytes).as_bytes());
    let aad_utf8 =
        canonical_manifest_aad(agent_id, epoch.get(), padded.len(), uncompressed_blake3, 2);

    let mut nonce = [0u8; 24];
    OsRng.fill_bytes(&mut nonce);
    let cipher = XChaCha20Poly1305::new(epoch_key.as_bytes().into());
    let ct_res = cipher.encrypt(
        XNonce::from_slice(&nonce),
        Payload {
            msg: &padded,
            aad: aad_utf8.as_bytes(),
        },
    );
    padded.zeroize();
    let ct = ct_res.map_err(|_| integrity_err("加密归档 manifest 信封失败"))?;

    Ok(SealedManifestEnvelope {
        v: 2,
        agent_id,
        epoch: epoch.get(),
        padded_len: compute_bucket_len(compressed.len())?,
        uncompressed_blake3,
        aad_utf8,
        nonce_hex: crate::hex_encode(&nonce),
        ciphertext_hex: crate::hex_encode(&ct),
    })
}

/// 校验并解封 `.quetzalcoatl-spine/manifest.json` 加密信封，任何篡改一律报错 `IntegrityViolation`。
pub fn open_manifest_envelope(
    expected_agent_id: AgentId,
    envelope: &SealedManifestEnvelope,
    epoch_key: &EpochKey,
) -> Result<Vec<u8>> {
    if envelope.v != 2 || envelope.agent_id != expected_agent_id {
        return Err(integrity_err("归档 manifest 信封版本或 AgentId 不匹配"));
    }
    let expected_aad = canonical_manifest_aad(
        envelope.agent_id,
        envelope.epoch,
        envelope.padded_len,
        envelope.uncompressed_blake3,
        envelope.v,
    );
    if envelope.aad_utf8 != expected_aad {
        return Err(integrity_err("归档 manifest AAD 与头部元数据不一致"));
    }

    let nonce = crate::hex_decode_fixed::<24>("manifest.nonce", &envelope.nonce_hex)
        .map_err(|e| integrity_err(format!("归档 manifest nonce 非法: {e}")))?;
    let ct = crate::hex_decode("manifest.ciphertext", &envelope.ciphertext_hex)
        .map_err(|e| integrity_err(format!("归档 manifest 密文十六进制非法: {e}")))?;

    let cipher = XChaCha20Poly1305::new(epoch_key.as_bytes().into());
    let mut padded = cipher
        .decrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: &ct,
                aad: envelope.aad_utf8.as_bytes(),
            },
        )
        .map_err(|_| integrity_err("归档 manifest 密文认证标签校验失败"))?;

    if padded.len() != envelope.padded_len {
        padded.zeroize();
        return Err(integrity_err("归档 manifest 分桶长度与 AAD 不一致"));
    }
    let decompressed_res = parse_padded_frame(&padded).and_then(zstd_decompress_1mib_guarded);
    padded.zeroize();
    let plain = decompressed_res?;

    let actual_b3 = ArtifactId::from_bytes(*blake3::hash(&plain).as_bytes());
    if actual_b3 != envelope.uncompressed_blake3 {
        return Err(integrity_err("归档 manifest 解压明文 BLAKE3 校验失败"));
    }
    Ok(plain)
}
