#![forbid(unsafe_code)]
#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]

//! 平台加密回调的本地解密（WeCom / 飞书 / 钉钉），仅处理已由 Hub 验签的密封信封。

use aes::Aes256;
use aes::cipher::{BlockDecrypt, KeyInit, generic_array::GenericArray};
use base64::Engine;
use quetzalcoatl_types::{QuetzalcoatlError, Result};
use sha2::{Digest, Sha256};

fn integrity(detail: impl Into<String>) -> QuetzalcoatlError {
    QuetzalcoatlError::IntegrityViolation {
        detail: detail.into(),
    }
}

fn aes256_cbc_decrypt(key: &[u8; 32], iv: &[u8; 16], ciphertext: &[u8]) -> Result<Vec<u8>> {
    if ciphertext.is_empty() || !ciphertext.len().is_multiple_of(16) {
        return Err(integrity("平台密文长度不是 16 字节整数倍"));
    }
    let cipher = Aes256::new(GenericArray::from_slice(key));
    let mut prev = *iv;
    let mut out = Vec::with_capacity(ciphertext.len());
    let mut block = [0u8; 16];
    for chunk in ciphertext.chunks(16) {
        block.copy_from_slice(chunk);
        let mut ga = GenericArray::clone_from_slice(&block);
        cipher.decrypt_block(&mut ga);
        for (idx, byte) in ga.iter().enumerate() {
            out.push(byte ^ prev[idx]);
        }
        prev.copy_from_slice(chunk);
    }
    let pad = usize::from(*out.last().ok_or_else(|| integrity("平台密文为空"))?);
    if pad == 0 || pad > 16 || out.len() < pad {
        return Err(integrity("平台 PKCS#7 填充非法"));
    }
    let (body, padding) = out.split_at(out.len() - pad);
    if !padding.iter().all(|b| usize::from(*b) == pad) {
        return Err(integrity("平台 PKCS#7 填充字节不一致"));
    }
    Ok(body.to_vec())
}

fn b64_decode(value: &str) -> Result<Vec<u8>> {
    let trimmed = value.trim();
    let mut padded = String::from(trimmed);
    while !padded.len().is_multiple_of(4) {
        padded.push('=');
    }
    base64::engine::general_purpose::STANDARD
        .decode(padded)
        .map_err(|_| integrity("平台 base64 解码失败"))
}

/// 企业微信：`EncodingAESKey` 为 32 字节密钥，随机 16B 前缀 + 4B msg_len + msg + receive_id。
pub fn decrypt_wecom(encrypt_b64: &str, encoding_aes_key_b64: &str) -> Result<Vec<u8>> {
    decrypt_wecom_with_receive_id(encrypt_b64, encoding_aes_key_b64, None)
}

/// 同 [`decrypt_wecom`]，但可强制校验企业微信 `receive_id`（AgentID/CorpID）。
pub fn decrypt_wecom_with_receive_id(
    encrypt_b64: &str,
    encoding_aes_key_b64: &str,
    expected_receive_id: Option<&str>,
) -> Result<Vec<u8>> {
    let key = b64_decode(encoding_aes_key_b64)?;
    if key.len() != 32 {
        return Err(integrity("WeCom EncodingAESKey 必须为 32 字节"));
    }
    let ciphertext = b64_decode(encrypt_b64)?;
    let mut key_arr = [0u8; 32];
    key_arr.copy_from_slice(&key);
    let mut iv = [0u8; 16];
    iv.copy_from_slice(&key[..16]);
    let plain = aes256_cbc_decrypt(&key_arr, &iv, &ciphertext)?;
    if plain.len() < 20 {
        return Err(integrity("WeCom 明文过短"));
    }
    let msg_len = u32::from_be_bytes([plain[16], plain[17], plain[18], plain[19]]) as usize;
    let end = 20usize
        .checked_add(msg_len)
        .ok_or_else(|| integrity("WeCom msg_len 溢出"))?;
    if end > plain.len() {
        return Err(integrity("WeCom msg_len 超出明文长度"));
    }
    if let Some(expected) = expected_receive_id.filter(|v| !v.trim().is_empty()) {
        let receive_id = std::str::from_utf8(&plain[end..])
            .map_err(|_| integrity("WeCom receive_id 不是合法 UTF-8"))?;
        if receive_id != expected {
            return Err(integrity("WeCom receive_id 与配置不一致"));
        }
    }
    Ok(plain[20..end].to_vec())
}

/// 飞书 / 钉钉 JSON 加密模式：`{"encrypt"/"encrypt": "<base64>"}`。
pub fn decrypt_json_envelope(body: &[u8], encrypt_key: &str) -> Result<Vec<u8>> {
    let value: serde_json::Value =
        serde_json::from_slice(body).map_err(|_| integrity("平台加密回调 JSON 非法"))?;
    let ciphertext_b64 = value
        .get("encrypt")
        .or_else(|| value.get("Encrypt"))
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| integrity("平台加密回调缺少 encrypt 字段"))?;
    let ciphertext = b64_decode(ciphertext_b64)?;
    let (key, iv) = if let Ok(raw) = b64_decode(encrypt_key)
        && raw.len() == 32
    {
        let mut key = [0u8; 32];
        key.copy_from_slice(&raw);
        let mut iv = [0u8; 16];
        iv.copy_from_slice(&raw[..16]);
        (key, iv)
    } else {
        let digest = Sha256::digest(encrypt_key.as_bytes());
        let mut key = [0u8; 32];
        key.copy_from_slice(&digest);
        let mut iv = [0u8; 16];
        iv.copy_from_slice(&digest[..16]);
        (key, iv)
    };
    aes256_cbc_decrypt(&key, &iv, &ciphertext)
}
