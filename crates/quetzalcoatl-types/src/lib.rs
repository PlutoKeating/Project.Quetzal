#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]

//! `quetzalcoatl-types` — Quetzalcoatl V2 共享强类型标识符、混合逻辑时钟（HLC）与机器可读错误码原语。
//!
//! 本 crate 零 I/O、零 `unsafe`、零供应商耦合，作为盲微内核、密码学状态脊柱、`quetzalcoatl-ewave`、
//! 群组协同与跨端 FFI 的最底层类型契约。

use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Deserializer, Serialize, Serializer};
use thiserror::Error;
use uuid::Uuid;

/// 统一 `Result` 别名。
pub type Result<T> = std::result::Result<T, QuetzalcoatlError>;

const HEX_LOWER: &[u8; 16] = b"0123456789abcdef";

fn encode_hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        out.push(char::from(HEX_LOWER[usize::from(b >> 4)]));
        out.push(char::from(HEX_LOWER[usize::from(b & 0x0f)]));
    }
    out
}

const fn decode_nibble(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn decode_hex_fixed<const N: usize>(kind: &'static str, input: &str) -> Result<[u8; N]> {
    let raw = input.as_bytes();
    if raw.len() != N * 2 {
        return Err(QuetzalcoatlError::InvalidId {
            kind,
            detail: format!("期望 {} 个十六进制字符，实际收到 {} 个", N * 2, raw.len()),
        });
    }
    let mut out = [0u8; N];
    for (idx, slot) in out.iter_mut().enumerate() {
        let hi = decode_nibble(raw[idx * 2]).ok_or_else(|| QuetzalcoatlError::InvalidId {
            kind,
            detail: format!("位置 {} 处包含非法十六进制字符", idx * 2),
        })?;
        let lo = decode_nibble(raw[idx * 2 + 1]).ok_or_else(|| QuetzalcoatlError::InvalidId {
            kind,
            detail: format!("位置 {} 处包含非法十六进制字符", idx * 2 + 1),
        })?;
        *slot = (hi << 4) | lo;
    }
    Ok(out)
}

/// 跨语言稳定、机器可读的顶层错误分类码（对齐 `spec/vectors/*.json`）。
#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ErrorCode {
    InvalidId,
    IntegrityViolation,
    ClockDriftExceeded,
    HlcCounterOverflow,
    EpochOverflow,
    StaleLeaseEpoch,
    PartitionRestricted,
    DeliveryRefused,
    PermissionDenied,
    VerificationFailed,
    ConscienceViolation,
    WatermarkConflict,
    FloorSilenced,
    CredentialRejected,
    SandboxViolation,
    SerializationError,
    StorageError,
}

impl ErrorCode {
    /// 返回与 `SCREAMING_SNAKE_CASE` JSON 表示一致的静态字符串。
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::InvalidId => "INVALID_ID",
            Self::IntegrityViolation => "INTEGRITY_VIOLATION",
            Self::ClockDriftExceeded => "CLOCK_DRIFT_EXCEEDED",
            Self::HlcCounterOverflow => "HLC_COUNTER_OVERFLOW",
            Self::EpochOverflow => "EPOCH_OVERFLOW",
            Self::StaleLeaseEpoch => "STALE_LEASE_EPOCH",
            Self::PartitionRestricted => "PARTITION_RESTRICTED",
            Self::DeliveryRefused => "DELIVERY_REFUSED",
            Self::PermissionDenied => "PERMISSION_DENIED",
            Self::VerificationFailed => "VERIFICATION_FAILED",
            Self::ConscienceViolation => "CONSCIENCE_VIOLATION",
            Self::WatermarkConflict => "WATERMARK_CONFLICT",
            Self::FloorSilenced => "FLOOR_SILENCED",
            Self::CredentialRejected => "CREDENTIAL_REJECTED",
            Self::SandboxViolation => "SANDBOX_VIOLATION",
            Self::SerializationError => "SERIALIZATION_ERROR",
            Self::StorageError => "STORAGE_ERROR",
        }
    }
}

impl fmt::Display for ErrorCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Quetzalcoatl V2 核心结构化错误枚举。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Error)]
#[serde(tag = "code", rename_all = "SCREAMING_SNAKE_CASE")]
pub enum QuetzalcoatlError {
    #[error("无效标识符 ({kind}): {detail}")]
    InvalidId { kind: &'static str, detail: String },

    #[error("密码学完整性或审计链校验失败: {detail}")]
    IntegrityViolation { detail: String },

    #[error(
        "远端 HLC 物理时钟超出容忍漂移上限 (remote={remote_wall_ms}ms, local={local_wall_ms}ms, max_drift={max_drift_ms}ms)"
    )]
    ClockDriftExceeded {
        remote_wall_ms: u64,
        local_wall_ms: u64,
        max_drift_ms: u64,
    },

    #[error("HLC 单毫秒逻辑计数器溢出")]
    HlcCounterOverflow,

    #[error("纪元编号 Epoch 递增溢出")]
    EpochOverflow,

    #[error("过期的租约纪元 (provided={provided}, current={current})")]
    StaleLeaseEpoch { provided: u64, current: u64 },

    #[error("断网分区受限租约禁止非幂等公网外发: {detail}")]
    PartitionRestricted { detail: String },

    #[error("投递被内核门禁拒绝: {detail}")]
    DeliveryRefused { detail: String },

    #[error("能力授权不足: {detail}")]
    PermissionDenied { detail: String },

    #[error("洁净室客观校验未通过: {detail}")]
    VerificationFailed { detail: String },

    #[error("良知权威段保护拦截: {detail}")]
    ConscienceViolation { detail: String },

    #[error("群组未读水位线冲突 (last_seen={last_seen_seq}, head={head_seq})")]
    WatermarkConflict { last_seen_seq: u64, head_seq: u64 },

    #[error("ANP-P9 群组发言门禁静默拦截: {detail}")]
    FloorSilenced { detail: String },

    #[error("零凭据代理拒绝请求: {detail}")]
    CredentialRejected { detail: String },

    #[error("沙箱隔离边界违规: {detail}")]
    SandboxViolation { detail: String },

    #[error("序列化或反序列化错误: {detail}")]
    SerializationError { detail: String },

    #[error("存储层错误: {detail}")]
    StorageError { detail: String },
}

impl QuetzalcoatlError {
    /// 提取机器可读的顶层 `ErrorCode`。
    #[must_use]
    pub const fn code(&self) -> ErrorCode {
        match self {
            Self::InvalidId { .. } => ErrorCode::InvalidId,
            Self::IntegrityViolation { .. } => ErrorCode::IntegrityViolation,
            Self::ClockDriftExceeded { .. } => ErrorCode::ClockDriftExceeded,
            Self::HlcCounterOverflow => ErrorCode::HlcCounterOverflow,
            Self::EpochOverflow => ErrorCode::EpochOverflow,
            Self::StaleLeaseEpoch { .. } => ErrorCode::StaleLeaseEpoch,
            Self::PartitionRestricted { .. } => ErrorCode::PartitionRestricted,
            Self::DeliveryRefused { .. } => ErrorCode::DeliveryRefused,
            Self::PermissionDenied { .. } => ErrorCode::PermissionDenied,
            Self::VerificationFailed { .. } => ErrorCode::VerificationFailed,
            Self::ConscienceViolation { .. } => ErrorCode::ConscienceViolation,
            Self::WatermarkConflict { .. } => ErrorCode::WatermarkConflict,
            Self::FloorSilenced { .. } => ErrorCode::FloorSilenced,
            Self::CredentialRejected { .. } => ErrorCode::CredentialRejected,
            Self::SandboxViolation { .. } => ErrorCode::SandboxViolation,
            Self::SerializationError { .. } => ErrorCode::SerializationError,
            Self::StorageError { .. } => ErrorCode::StorageError,
        }
    }
}

macro_rules! define_uuid_id {
    ($(#[$meta:meta])* $name:ident) => {
        $(#[$meta])*
        #[derive(Copy, Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
        #[serde(transparent)]
        pub struct $name(Uuid);

        impl $name {
            /// 生成新的随机 UUIDv4 标识符。
            #[must_use]
            pub fn new_v4() -> Self {
                Self(Uuid::new_v4())
            }

            /// 全零哨兵标识符。
            #[must_use]
            pub const fn nil() -> Self {
                Self(Uuid::nil())
            }

            /// 从 `Uuid` 无损包装。
            #[must_use]
            pub const fn from_uuid(uuid: Uuid) -> Self {
                Self(uuid)
            }

            /// 从固定 16 字节大端数组构造。
            #[must_use]
            pub const fn from_bytes(bytes: [u8; 16]) -> Self {
                Self(Uuid::from_bytes(bytes))
            }

            /// 返回内部 `Uuid`。
            #[must_use]
            pub const fn as_uuid(&self) -> Uuid {
                self.0
            }

            /// 返回固定 16 字节引用。
            #[must_use]
            pub const fn as_bytes(&self) -> &[u8; 16] {
                self.0.as_bytes()
            }

            /// 返回固定 16 字节大端副本。
            #[must_use]
            pub const fn to_be_bytes(&self) -> [u8; 16] {
                *self.0.as_bytes()
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                fmt::Display::fmt(&self.0.hyphenated(), f)
            }
        }

        impl FromStr for $name {
            type Err = QuetzalcoatlError;

            fn from_str(s: &str) -> Result<Self> {
                Uuid::parse_str(s)
                    .map(Self)
                    .map_err(|err| QuetzalcoatlError::InvalidId {
                        kind: stringify!($name),
                        detail: err.to_string(),
                    })
            }
        }

        impl From<Uuid> for $name {
            fn from(value: Uuid) -> Self {
                Self(value)
            }
        }

        impl From<$name> for Uuid {
            fn from(value: $name) -> Self {
                value.0
            }
        }
    };
}

define_uuid_id!(
    /// 独占主权脊柱的 Agent 唯一标识符（1 Agent = 1 物理与密码学独占脊柱）。
    AgentId
);

define_uuid_id!(
    /// 单写者设备链的授权设备标识符。
    DeviceId
);

impl DeviceId {
    /// 提取用于 `HlcTimestamp` 低 32 位确定性决胜（tie-breaker）的大端标签。
    #[must_use]
    pub const fn hlc_node_tag(&self) -> u32 {
        let b = self.0.as_bytes();
        u32::from_be_bytes([b[0], b[1], b[2], b[3]])
    }
}

define_uuid_id!(
    /// 内核持久化 `Run`（`Explore` / `Commit`）唯一标识符。
    RunId
);

define_uuid_id!(
    /// 会话或任务订阅流 `Thread` 唯一标识符。
    ThreadId
);

/// 内容寻址产物标识符（256-bit BLAKE3 摘要）。
#[derive(Copy, Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ArtifactId([u8; 32]);

impl ArtifactId {
    /// 全零摘要常量。
    pub const ZERO: Self = Self([0u8; 32]);

    /// 从 32 字节 BLAKE3 摘要构造。
    #[must_use]
    pub const fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }

    /// 返回底层 32 字节摘要引用。
    #[must_use]
    pub const fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }

    /// 编码为 64 字符小写十六进制字符串。
    #[must_use]
    pub fn to_hex(&self) -> String {
        encode_hex(&self.0)
    }

    /// 从 64 字符十六进制字符串（可选 `blake3:` 前缀）解析。
    pub fn from_hex(s: &str) -> Result<Self> {
        let trimmed = s.strip_prefix("blake3:").unwrap_or(s);
        decode_hex_fixed::<32>("ArtifactId", trimmed).map(Self)
    }
}

impl fmt::Display for ArtifactId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.to_hex())
    }
}

impl FromStr for ArtifactId {
    type Err = QuetzalcoatlError;

    fn from_str(s: &str) -> Result<Self> {
        Self::from_hex(s)
    }
}

impl Serialize for ArtifactId {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        if serializer.is_human_readable() {
            serializer.serialize_str(&self.to_hex())
        } else {
            self.0.serialize(serializer)
        }
    }
}

impl<'de> Deserialize<'de> for ArtifactId {
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        if deserializer.is_human_readable() {
            let s = String::deserialize(deserializer)?;
            Self::from_hex(&s).map_err(serde::de::Error::custom)
        } else {
            let bytes = <[u8; 32]>::deserialize(deserializer)?;
            Ok(Self(bytes))
        }
    }
}

/// 单调递增密码学/租约纪元编号（用于 `EpochKey[e]`、`witness_epoch`、`mls_epoch`）。
#[derive(
    Copy, Clone, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize,
)]
#[serde(transparent)]
pub struct Epoch(pub u64);

impl Epoch {
    /// 创世纪元 `0`。
    pub const GENESIS: Self = Self(0);

    /// 构造指定纪元。
    #[must_use]
    pub const fn new(value: u64) -> Self {
        Self(value)
    }

    /// 读取底层 `u64` 值。
    #[must_use]
    pub const fn get(self) -> u64 {
        self.0
    }

    /// 安全递增至下一纪元；若达 `u64::MAX` 返回 `EpochOverflow` 而绝不 panic。
    pub fn next(self) -> Result<Self> {
        self.0
            .checked_add(1)
            .map(Self)
            .ok_or(QuetzalcoatlError::EpochOverflow)
    }

    /// 编码为固定 8 字节大端数组。
    #[must_use]
    pub const fn to_be_bytes(self) -> [u8; 8] {
        self.0.to_be_bytes()
    }

    /// 从固定 8 字节大端数组还原。
    #[must_use]
    pub const fn from_be_bytes(bytes: [u8; 8]) -> Self {
        Self(u64::from_be_bytes(bytes))
    }
}

impl fmt::Display for Epoch {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(&self.0, f)
    }
}

impl From<u64> for Epoch {
    fn from(value: u64) -> Self {
        Self(value)
    }
}

impl From<Epoch> for u64 {
    fn from(value: Epoch) -> Self {
        value.0
    }
}

/// 固定宽度 128-bit 混合逻辑时钟时间戳（`HlcTimestamp(u128)`）。
///
/// 位布局（大端字节序字典序与因果全序严格等价）：
/// - `bits 127..64`（高 64 位）：`wall_ms: u64`（Unix 纪元毫秒物理时间）
/// - `bits 63..32`（中 32 位）：`logical: u32`（同毫秒单调逻辑计数器）
/// - `bits 31..0`（低 32 位）：`node_tag: u32`（设备确定性决胜标签）
#[derive(Copy, Clone, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct HlcTimestamp(pub u128);

impl HlcTimestamp {
    /// 全零时间戳常量。
    pub const ZERO: Self = Self(0);

    /// 远端未来时钟最大允许正偏置：`+5 分钟`（`300_000 ms`，防未来时钟投毒推高本机 HLC）。
    pub const MAX_FUTURE_DRIFT_MS: u64 = 5 * 60 * 1_000;

    /// 由 `(wall_ms, logical, node_tag)` 三元组组装 128-bit HLC。
    #[must_use]
    pub const fn from_parts(wall_ms: u64, logical: u32, node_tag: u32) -> Self {
        let packed = ((wall_ms as u128) << 64) | ((logical as u128) << 32) | (node_tag as u128);
        Self(packed)
    }

    /// 提取高 64 位物理毫秒时间。
    #[must_use]
    pub const fn wall_ms(self) -> u64 {
        (self.0 >> 64) as u64
    }

    /// 提取中 32 位逻辑计数器。
    #[must_use]
    pub const fn logical(self) -> u32 {
        ((self.0 >> 32) & 0xffff_ffff) as u32
    }

    /// 提取低 32 位节点决胜标签。
    #[must_use]
    pub const fn node_tag(self) -> u32 {
        (self.0 & 0xffff_ffff) as u32
    }

    /// 返回底层 `u128` 整数。
    #[must_use]
    pub const fn as_u128(self) -> u128 {
        self.0
    }

    /// 编码为固定 16 字节大端字节数组（可直接用于 SQLite BLOB 索引与签名头）。
    #[must_use]
    pub const fn to_be_bytes(self) -> [u8; 16] {
        self.0.to_be_bytes()
    }

    /// 从固定 16 字节大端字节数组还原。
    #[must_use]
    pub const fn from_be_bytes(bytes: [u8; 16]) -> Self {
        Self(u128::from_be_bytes(bytes))
    }

    /// 编码为定长 32 字符小写十六进制大端字符串（避免 JSON/JS `float64` 精度丢失）。
    #[must_use]
    pub fn to_hex(self) -> String {
        encode_hex(&self.to_be_bytes())
    }

    /// 从定长 32 字符十六进制大端字符串还原。
    pub fn from_hex(hex_str: &str) -> Result<Self> {
        let bytes = decode_hex_fixed::<16>("HlcTimestamp", hex_str)?;
        Ok(Self::from_be_bytes(bytes))
    }

    /// 校验远端 HLC 是否超出本机可信时间 `+5m` 容忍窗口（防坑规范 #10）。
    pub fn validate_drift(self, local_trusted_wall_ms: u64) -> Result<()> {
        let max_allowed = local_trusted_wall_ms.saturating_add(Self::MAX_FUTURE_DRIFT_MS);
        let remote_wall_ms = self.wall_ms();
        if remote_wall_ms > max_allowed {
            return Err(QuetzalcoatlError::ClockDriftExceeded {
                remote_wall_ms,
                local_wall_ms: local_trusted_wall_ms,
                max_drift_ms: Self::MAX_FUTURE_DRIFT_MS,
            });
        }
        Ok(())
    }

    /// 本机事件单调推进：即使物理时钟停滞或回拨，结果仍严格大于 `self`。
    pub fn tick(self, local_wall_ms: u64, node_tag: u32) -> Result<Self> {
        let prev_wall = self.wall_ms();
        if local_wall_ms > prev_wall {
            Ok(Self::from_parts(local_wall_ms, 0, node_tag))
        } else {
            let next_logical = self
                .logical()
                .checked_add(1)
                .ok_or(QuetzalcoatlError::HlcCounterOverflow)?;
            Ok(Self::from_parts(prev_wall, next_logical, node_tag))
        }
    }

    /// 观测并合入远端事件时间戳：
    /// 1. 先执行 `+5m` 未来时钟投毒校验，超限立即返回 `ClockDriftExceeded` 且绝不污染本机状态；
    /// 2. 通过校验后按 HLC 规则产生严格领先于 `self` 与 `remote` 的新本机时间戳。
    pub fn observe_remote(
        self,
        remote: Self,
        local_trusted_wall_ms: u64,
        local_node_tag: u32,
    ) -> Result<Self> {
        remote.validate_drift(local_trusted_wall_ms)?;

        let self_wall = self.wall_ms();
        let remote_wall = remote.wall_ms();
        let next_wall = self_wall.max(remote_wall).max(local_trusted_wall_ms);

        let next_logical = if next_wall == self_wall && next_wall == remote_wall {
            self.logical()
                .max(remote.logical())
                .checked_add(1)
                .ok_or(QuetzalcoatlError::HlcCounterOverflow)?
        } else if next_wall == self_wall {
            self.logical()
                .checked_add(1)
                .ok_or(QuetzalcoatlError::HlcCounterOverflow)?
        } else if next_wall == remote_wall {
            remote
                .logical()
                .checked_add(1)
                .ok_or(QuetzalcoatlError::HlcCounterOverflow)?
        } else {
            0
        };

        Ok(Self::from_parts(next_wall, next_logical, local_node_tag))
    }
}

impl fmt::Display for HlcTimestamp {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.to_hex())
    }
}

impl FromStr for HlcTimestamp {
    type Err = QuetzalcoatlError;

    fn from_str(s: &str) -> Result<Self> {
        Self::from_hex(s)
    }
}

impl Serialize for HlcTimestamp {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        if serializer.is_human_readable() {
            serializer.serialize_str(&self.to_hex())
        } else {
            self.to_be_bytes().serialize(serializer)
        }
    }
}

impl<'de> Deserialize<'de> for HlcTimestamp {
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        if deserializer.is_human_readable() {
            let s = String::deserialize(deserializer)?;
            Self::from_hex(&s).map_err(serde::de::Error::custom)
        } else {
            let bytes = <[u8; 16]>::deserialize(deserializer)?;
            Ok(Self::from_be_bytes(bytes))
        }
    }
}

#[cfg(test)]
mod unit_tests {
    use super::*;

    #[test]
    fn hlc_counter_overflow_returns_typed_error() {
        let maxed = HlcTimestamp::from_parts(1_000, u32::MAX, 1);
        let err = maxed.tick(1_000, 1);
        assert_eq!(err, Err(QuetzalcoatlError::HlcCounterOverflow));
    }

    #[test]
    fn device_id_node_tag_is_deterministic_big_endian_prefix() {
        let dev = DeviceId::from_bytes([
            0xde, 0xad, 0xbe, 0xef, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
        ]);
        assert_eq!(dev.hlc_node_tag(), 0xdead_beef);
    }

    #[test]
    fn artifact_id_supports_optional_blake3_prefix() -> std::result::Result<(), QuetzalcoatlError> {
        let raw = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        let prefixed = format!("blake3:{raw}");
        let a = ArtifactId::from_str(raw)?;
        let b = ArtifactId::from_str(&prefixed)?;
        assert_eq!(a, b);
        assert_eq!(a.to_string(), raw);
        Ok(())
    }
}
