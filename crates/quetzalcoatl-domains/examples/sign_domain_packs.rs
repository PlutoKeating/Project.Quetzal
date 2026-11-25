//! 重新签署 `packages/domains/*/pack.json` 的监护人 `SafetyEnvelope`（与运行期校验共用同一实现）。

use std::error::Error;
use std::fs;
use std::path::{Path, PathBuf};

use quetzalcoatl_crypto::hex_encode;
use quetzalcoatl_domains::{
    SafetyEnvelope, SafetyEnvelopePayload, blake3_jcs_digest, demo_guardian_seed,
    manifest::PACK_BODY_DIGEST_CONTEXT,
};
use serde_json::Value;

type ToolResult<T> = Result<T, Box<dyn Error>>;

fn repo_root() -> ToolResult<PathBuf> {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let root = manifest_dir
        .parent()
        .and_then(Path::parent)
        .ok_or("无法定位仓库根目录")?;
    Ok(root.to_path_buf())
}

fn main() -> ToolResult<()> {
    let domains_dir = repo_root()?.join("packages/domains");
    let mut dirs: Vec<PathBuf> = Vec::new();
    for entry in fs::read_dir(&domains_dir)? {
        let entry = entry?;
        let pack_path = entry.path().join("pack.json");
        if pack_path.is_file() {
            dirs.push(pack_path);
        }
    }
    dirs.sort();

    for pack_path in dirs {
        sign_pack(&pack_path)?;
    }
    Ok(())
}

fn sign_pack(pack_path: &Path) -> ToolResult<()> {
    let raw = fs::read_to_string(pack_path)?;
    let mut document: Value = serde_json::from_str(&raw)?;

    let pack_id = document["id"]
        .as_str()
        .ok_or_else(|| format!("{} 缺少 id", pack_path.display()))?
        .to_owned();

    // 1. 正文摘要：剥离安全信封后做 JCS + 域分离 BLAKE3
    let mut body = document.clone();
    body.as_object_mut()
        .ok_or("pack.json 顶层必须是对象")?
        .remove("safetyEnvelope");
    let pack_digest_hex = hex_encode(&blake3_jcs_digest(PACK_BODY_DIGEST_CONTEXT, &body)?);

    // 2. 合成演示监护人公钥
    let guardian_seed = demo_guardian_seed(&pack_id);
    let signing_key = ed25519_dalek::SigningKey::from_bytes(&guardian_seed);
    let pubkey_hex = hex_encode(signing_key.verifying_key().as_bytes());
    let guardian_label = format!("guardian:demo-{pack_id}");

    // 3. 回填载荷并签名
    let payload_value = document["safetyEnvelope"]["payload"].clone();
    let mut payload_object = payload_value
        .as_object()
        .cloned()
        .ok_or("缺少 safetyEnvelope.payload")?;
    payload_object.insert(
        String::from("packBlake3Hex"),
        Value::String(pack_digest_hex.clone()),
    );
    payload_object.insert(
        String::from("guardianKeyId"),
        Value::String(pubkey_hex.clone()),
    );
    payload_object.insert(
        String::from("guardianLabel"),
        Value::String(guardian_label.clone()),
    );
    let payload: SafetyEnvelopePayload = serde_json::from_value(Value::Object(payload_object))?;

    let signed = SafetyEnvelope::sign(payload, &guardian_seed)?;
    document["safetyEnvelope"] = serde_json::to_value(&signed)?;

    let mut rendered = serde_json::to_string_pretty(&document)?;
    rendered.push('\n');
    fs::write(pack_path, rendered)?;

    println!(
        "signed pack={pack_id} guardian={guardian_label} pubkey={pubkey_hex} packBlake3={pack_digest_hex}"
    );
    Ok(())
}
