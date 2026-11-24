#![forbid(unsafe_code)]
#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

//! 按需模型包：签名、BLAKE3、原子落盘、权限与路径穿越拒绝。

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use ed25519_dalek::SigningKey;

use quetzalcoatl_types::QuetzalcoatlError;
use quetzalcoatl_voice_ai::ort_loader::{
    AiPackKind, OnDemandAiPackManager, PackFileEntry, PackManifest, PackSource,
};

struct MemorySource {
    payloads: BTreeMap<String, Vec<u8>>,
}

impl PackSource for MemorySource {
    fn fetch(&self, url: &str) -> quetzalcoatl_types::Result<Vec<u8>> {
        self.payloads
            .get(url)
            .cloned()
            .ok_or_else(|| QuetzalcoatlError::IntegrityViolation {
                detail: format!("缺少测试下载内容 {url}"),
            })
    }
}

fn temp_home(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "qz-voice-pack-{tag}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    fs::create_dir_all(&dir).expect("创建临时 home");
    dir
}

fn manifest_for(
    key: &SigningKey,
    pack: &str,
    version: &str,
    file_path: &str,
    payload: &[u8],
) -> PackManifest {
    let mut manifest = PackManifest::new(
        pack,
        AiPackKind::Embedding,
        version,
        "multilingual-embed-v2",
        vec![PackFileEntry {
            path: file_path.to_string(),
            url: format!("https://models.invalid/{pack}/{version}/{file_path}"),
            blake3: blake3::hash(payload).to_hex().to_string(),
            size: payload.len() as u64,
        }],
    );
    manifest.sign_with(key).expect("签名");
    manifest
}

fn source_for(manifest: &PackManifest, payload: &[u8]) -> Arc<dyn PackSource> {
    let mut payloads = BTreeMap::new();
    for file in &manifest.files {
        payloads.insert(file.url.clone(), payload.to_vec());
    }
    Arc::new(MemorySource { payloads })
}

fn manager(home: &Path, source: Arc<dyn PackSource>, key: &SigningKey) -> OnDemandAiPackManager {
    OnDemandAiPackManager::new(home, source, key.verifying_key()).expect("管理器")
}

#[test]
fn installs_verifies_and_reloads_manifest() {
    let home = temp_home("ok");
    let key = SigningKey::from_bytes(&[0x11; 32]);
    let payload = b"embedding-model-weights-v2".to_vec();
    let manifest = manifest_for(&key, "multilingual-embed", "2.1.0", "model.onnx", &payload);
    let mgr = manager(&home, source_for(&manifest, &payload), &key);

    let installed = mgr.install_pack(&manifest).expect("安装");
    assert_eq!(installed.kind, AiPackKind::Embedding);
    assert_eq!(installed.version, "2.1.0");
    assert!(installed.path.starts_with(home.join("models")));
    assert_eq!(
        fs::read(installed.path.join("model.onnx")).expect("读取落盘文件"),
        payload
    );

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let dir_mode = fs::metadata(&installed.path)
            .expect("包目录元数据")
            .permissions()
            .mode()
            & 0o777;
        let file_mode = fs::metadata(installed.path.join("model.onnx"))
            .expect("文件元数据")
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(dir_mode, 0o700, "模型包目录必须 0700");
        assert_eq!(file_mode, 0o600, "模型文件必须 0600");
    }

    let reloaded = mgr
        .load_pack(AiPackKind::Embedding, "2.1.0")
        .expect("重新加载");
    assert_eq!(reloaded.path, installed.path);
    assert_eq!(reloaded.model_id, "multilingual-embed-v2");
    assert_eq!(mgr.installed_packs().expect("枚举").len(), 1);

    // 幂等重装：内容一致则成功且不重复。
    mgr.install_pack(&manifest).expect("幂等重装");
    assert_eq!(mgr.installed_packs().expect("枚举").len(), 1);
}

#[test]
fn rejects_tampered_signature_without_touching_disk() {
    let home = temp_home("sig");
    let key = SigningKey::from_bytes(&[0x22; 32]);
    let payload = b"weights".to_vec();
    let mut manifest = manifest_for(&key, "kokoro", "3.0.0", "model.onnx", &payload);
    manifest.model_id = String::from("tampered-model");
    let mgr = manager(&home, source_for(&manifest, &payload), &key);

    let error = mgr.install_pack(&manifest).expect_err("签名被篡改必须拒绝");
    assert!(matches!(
        error,
        QuetzalcoatlError::IntegrityViolation { .. }
    ));
    assert!(
        !home.join("models/kokoro/3.0.0").exists(),
        "验签失败不得创建目标目录"
    );
}

#[test]
fn rejects_hash_mismatch_and_leaves_no_partial_pack() {
    let home = temp_home("hash");
    let key = SigningKey::from_bytes(&[0x33; 32]);
    let payload = b"correct-weights".to_vec();
    let manifest = manifest_for(&key, "sensevoice", "1.2.3", "model.onnx", &payload);
    let mut tampered = BTreeMap::new();
    for file in &manifest.files {
        tampered.insert(file.url.clone(), b"evil-weights".to_vec());
    }
    let mgr = manager(&home, Arc::new(MemorySource { payloads: tampered }), &key);

    let error = mgr.install_pack(&manifest).expect_err("哈希不符必须拒绝");
    assert!(matches!(
        error,
        QuetzalcoatlError::IntegrityViolation { .. }
    ));
    assert!(!home.join("models/sensevoice/1.2.3").exists());
    let leftovers: Vec<_> = fs::read_dir(home.join("models"))
        .map(|entries| entries.flatten().collect())
        .unwrap_or_default();
    assert!(leftovers.is_empty(), "不得残留暂存文件: {leftovers:?}");
}

#[test]
fn rejects_path_traversal_in_pack_version_and_file_paths() {
    let home = temp_home("traversal");
    let key = SigningKey::from_bytes(&[0x44; 32]);
    let payload = b"weights".to_vec();

    for (pack, version, file_path) in [
        ("../escape", "1.0.0", "model.onnx"),
        ("safe-pack", "../../escape", "model.onnx"),
        ("safe-pack", "1.0.0", "../escape.onnx"),
        ("safe-pack", "1.0.0", "/etc/passwd"),
        ("safe/../pack", "1.0.0", "model.onnx"),
    ] {
        let manifest = manifest_for(&key, pack, version, file_path, &payload);
        let mgr = manager(&home, source_for(&manifest, &payload), &key);
        let error = mgr.install_pack(&manifest).expect_err("路径穿越必须拒绝");
        assert!(
            matches!(
                error,
                QuetzalcoatlError::PermissionDenied { .. }
                    | QuetzalcoatlError::IntegrityViolation { .. }
            ),
            "{pack}/{version}/{file_path} 产生了意外错误: {error}"
        );
    }
}

#[test]
fn detects_on_disk_corruption_on_load() {
    let home = temp_home("corrupt");
    let key = SigningKey::from_bytes(&[0x55; 32]);
    let payload = b"weights-to-corrupt".to_vec();
    let manifest = manifest_for(&key, "ort-runtime", "1.20.0", "libonnxruntime.so", &payload);
    let mgr = manager(&home, source_for(&manifest, &payload), &key);
    let installed = mgr.install_pack(&manifest).expect("安装");

    fs::write(installed.path.join("libonnxruntime.so"), b"corrupted").expect("篡改文件");
    let error = mgr
        .load_pack(AiPackKind::OnnxRuntime, "1.20.0")
        .expect_err("损坏文件必须拒绝加载");
    assert!(matches!(
        error,
        QuetzalcoatlError::IntegrityViolation { .. }
    ));
}
