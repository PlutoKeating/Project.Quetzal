#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]

//! 规范 JSON（RFC 8785 JCS 受限子集）序列化与域分离 BLAKE3 摘要。
//!
//! 为消除跨语言签名歧义，本模块实现严格的 JCS 规范化：
//! 1. 对象键按 **UTF-16 码元序** 升序排列；
//! 2. 字符串仅使用 RFC 8785 规定的最短转义；
//! 3. 数组保持原序、无任何空白；
//! 4. **拒绝浮点数**（安全信封只允许整数微秒/次数/毫秒，彻底规避 ECMAScript 数字格式化分歧）。

use quetzalcoatl_crypto::hex_encode;
use quetzalcoatl_types::{QuetzalcoatlError, Result};
use serde_json::Value;

/// RFC 8785 允许的 IEEE-754 双精度安全整数上限（2^53）。超出该值的整数在跨语言
/// 解析为双精度时会被静默截断，因此安全信封一律拒绝。
pub const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_992;

/// 将 `serde_json::Value` 序列化为 RFC 8785 规范化 JSON 文本。
pub fn canonicalize_json_value(value: &Value) -> Result<String> {
    let mut out = String::new();
    write_value(value, &mut out)?;
    Ok(out)
}

/// 解析 JSON 文本并按 RFC 8785 规范化输出。
pub fn canonicalize_json_str(raw: &str) -> Result<String> {
    let value: Value =
        serde_json::from_str(raw).map_err(|e| QuetzalcoatlError::SerializationError {
            detail: format!("无法解析待规范化 JSON: {e}"),
        })?;
    canonicalize_json_value(&value)
}

/// 计算域分离的 BLAKE3 规范化 JSON 摘要（32 字节）。
pub fn blake3_jcs_digest(context: &str, value: &Value) -> Result<[u8; 32]> {
    let canonical = canonicalize_json_value(value)?;
    let mut hasher = blake3::Hasher::new_derive_key(context);
    hasher.update(canonical.as_bytes());
    Ok(*hasher.finalize().as_bytes())
}

/// 计算域分离的 BLAKE3 规范化 JSON 摘要（小写十六进制）。
pub fn blake3_jcs_digest_hex(context: &str, value: &Value) -> Result<String> {
    Ok(hex_encode(&blake3_jcs_digest(context, value)?))
}

fn write_value(value: &Value, out: &mut String) -> Result<()> {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(true) => out.push_str("true"),
        Value::Bool(false) => out.push_str("false"),
        Value::Number(number) => {
            if number.is_f64() && !number.is_i64() && !number.is_u64() {
                return Err(QuetzalcoatlError::SerializationError {
                    detail: String::from(
                        "JCS 规范化拒绝浮点数：安全信封仅允许整数微秒/次数/毫秒以消除跨语言数字格式化分歧",
                    ),
                });
            }
            let magnitude = number
                .as_u64()
                .or_else(|| number.as_i64().map(i64::unsigned_abs))
                .unwrap_or(0);
            if magnitude > MAX_SAFE_INTEGER {
                return Err(QuetzalcoatlError::SerializationError {
                    detail: format!(
                        "JCS 规范化拒绝超出 IEEE-754 安全整数 2^53 ({MAX_SAFE_INTEGER}) 的整数 {number}：跨语言解析会被静默截断"
                    ),
                });
            }
            out.push_str(&number.to_string());
        }
        Value::String(text) => write_string(text, out),
        Value::Array(items) => {
            out.push('[');
            for (idx, item) in items.iter().enumerate() {
                if idx > 0 {
                    out.push(',');
                }
                write_value(item, out)?;
            }
            out.push(']');
        }
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
            out.push('{');
            for (idx, key) in keys.into_iter().enumerate() {
                if idx > 0 {
                    out.push(',');
                }
                write_string(key, out);
                out.push(':');
                if let Some(inner) = map.get(key) {
                    write_value(inner, out)?;
                }
            }
            out.push('}');
        }
    }
    Ok(())
}

fn write_string(text: &str, out: &mut String) {
    out.push('"');
    for ch in text.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{0008}' => out.push_str("\\b"),
            '\u{0009}' => out.push_str("\\t"),
            '\u{000a}' => out.push_str("\\n"),
            '\u{000c}' => out.push_str("\\f"),
            '\u{000d}' => out.push_str("\\r"),
            c if u32::from(c) < 0x20 => {
                out.push_str("\\u00");
                let byte = u8::try_from(u32::from(c)).unwrap_or(0);
                out.push(char::from_digit(u32::from(byte >> 4), 16).unwrap_or('0'));
                out.push(char::from_digit(u32::from(byte & 0x0f), 16).unwrap_or('0'));
            }
            c => out.push(c),
        }
    }
    out.push('"');
}
