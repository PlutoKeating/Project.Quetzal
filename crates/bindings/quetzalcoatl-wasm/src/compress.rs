//! 纯 Rust `ruzstd` 解压适配（浏览器端不捆绑 C `zstd`）。
//!
//! 解压窗口与输出体积都有硬上界：即便收到恶意构造的压缩炸弹，也最多消耗
//! [`MAX_DECOMPRESSED_BYTES`]，而不会被一次性撑爆 WASM 线性内存。

use std::io::Read;

use thiserror::Error;

/// 单次解压允许的输出上界（8 MiB，覆盖单条脊柱 packfile）。
pub const MAX_DECOMPRESSED_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Error)]
pub enum CompressError {
    #[error("zstd 帧解析失败: {detail}")]
    Decode { detail: String },

    #[error("解压输出超过上界 ({limit} 字节)")]
    TooLarge { limit: usize },

    #[error("解压读取失败: {detail}")]
    Io { detail: String },
}

/// 以默认上界解压一个标准 zstd 帧。
pub fn decompress_pack(frame: &[u8]) -> Result<Vec<u8>, CompressError> {
    decompress_pack_bounded(frame, MAX_DECOMPRESSED_BYTES)
}

/// 以显式上界解压：输出一旦超过 `limit` 立即失败（不继续分配）。
pub fn decompress_pack_bounded(frame: &[u8], limit: usize) -> Result<Vec<u8>, CompressError> {
    if limit == 0 {
        return Err(CompressError::TooLarge { limit });
    }
    let mut decoder =
        ruzstd::decoding::StreamingDecoder::new(frame).map_err(|e| CompressError::Decode {
            detail: e.to_string(),
        })?;

    let mut out = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        let n = decoder.read(&mut chunk).map_err(|e| CompressError::Io {
            detail: e.to_string(),
        })?;
        if n == 0 {
            return Ok(out);
        }
        if out.len().saturating_add(n) > limit {
            return Err(CompressError::TooLarge { limit });
        }
        out.extend_from_slice(&chunk[..n]);
    }
}
