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

/// 进程内验签缓存：未变更的包第二次加载不得重复全量哈希；篡改后必须失效并检出。
#[test]
fn verification_cache_avoids_rehash_and_invalidates_on_tamper() {
    let home = temp_home("cache");
    let key = SigningKey::from_bytes(&[0x66; 32]);
    let payload = b"cache-test-weights".to_vec();
    let manifest = manifest_for(&key, "sensevoice", "9.9.9", "model.onnx", &payload);
    let mgr = manager(&home, source_for(&manifest, &payload), &key);

    let installed = mgr.install_pack(&manifest).expect("安装");
    let after_install = mgr.verification_stats();
    assert_eq!(after_install.verifications, 1);

    mgr.load_pack(AiPackKind::Embedding, "9.9.9")
        .expect("首次加载");
    mgr.load_pack(AiPackKind::Embedding, "9.9.9")
        .expect("第二次加载");
    let cached = mgr.verification_stats();
    assert_eq!(
        cached.verifications, after_install.verifications,
        "未变更的包不得重复全量哈希"
    );
    assert!(cached.cache_hits >= 2, "第二次加载必须命中进程内验签缓存");

    // 追加字节篡改（大小与 mtime 均变化）→ 缓存必须失效并检出。
    let path = installed.path.join("model.onnx");
    let mut tampered = fs::read(&path).expect("读取");
    tampered.extend_from_slice(b"evil");
    fs::write(&path, tampered).expect("篡改");
    let error = mgr
        .load_pack(AiPackKind::Embedding, "9.9.9")
        .expect_err("篡改文件必须检出");
    assert!(matches!(
        error,
        QuetzalcoatlError::IntegrityViolation { .. }
    ));
    assert!(
        mgr.verification_stats().verifications > cached.verifications,
        "缓存失效后必须重新校验"
    );
}

/// 安装新的 Embedding 包版本必须把受影响文档批量入队 `reembed()`。
#[test]
fn installing_embedding_pack_enqueues_documents_for_reembed() {
    use std::sync::Mutex;

    use quetzalcoatl_voice_ai::hybrid_search::{EmbeddingVersion, HybridIndex, SharedHybridIndex};

    let home = temp_home("embed-sink");
    let key = SigningKey::from_bytes(&[0x77; 32]);
    let payload_v1 = b"embed-v1-weights".to_vec();
    let mut manifest_v1 = manifest_for(
        &key,
        "multilingual-embed",
        "1.0.0",
        "model.onnx",
        &payload_v1,
    );
    manifest_v1.embedding_dimensions = Some(4);
    manifest_v1.sign_with(&key).expect("重签 v1");

    let index = std::sync::Arc::new(Mutex::new(HybridIndex::new(
        EmbeddingVersion::new("multilingual-embed-v1", 4).with_pack_version("1.0.0"),
    )));
    {
        let mut guard = index.lock().expect("索引锁");
        guard
            .upsert("a", "声学回声消除", vec![1.0, 0.0, 0.0, 0.0])
            .expect("插入 a");
        guard
            .upsert("b", "端侧模型验签", vec![0.0, 1.0, 0.0, 0.0])
            .expect("插入 b");
    }

    let mgr = manager(&home, source_for(&manifest_v1, &payload_v1), &key);
    mgr.set_embedding_sink(std::sync::Arc::new(SharedHybridIndex::new(
        std::sync::Arc::clone(&index),
    )));
    mgr.install_pack(&manifest_v1).expect("安装 v1");

    let payload_v2 = b"embed-v2-weights".to_vec();
    let mut manifest_v2 = manifest_for(
        &key,
        "multilingual-embed",
        "2.0.0",
        "model.onnx",
        &payload_v2,
    );
    manifest_v2.embedding_dimensions = Some(4);
    manifest_v2.sign_with(&key).expect("重签 v2");
    let mgr_v2_source = source_for(&manifest_v2, &payload_v2);
    let mgr = {
        // 同一管理器已持有 v1 源；这里直接以新源重建并复用同一 sink。
        let mgr = manager(&home, mgr_v2_source, &key);
        mgr.set_embedding_sink(std::sync::Arc::new(SharedHybridIndex::new(
            std::sync::Arc::clone(&index),
        )));
        mgr
    };
    mgr.install_pack(&manifest_v2).expect("安装 v2");

    let mut guard = index.lock().expect("索引锁");
    assert_eq!(guard.pending_reembed(), 2, "新包版本必须入队全部受影响文档");
    assert_eq!(guard.drain_reembed_batch(1).len(), 1, "必须是分批消费");
    assert_eq!(guard.pending_reembed(), 1);
}

/// 同大小、mtime 被恢复的原地改写仍必须被 ctime/inode 指纹检出（unix）。
#[cfg(unix)]
#[test]
fn cache_detects_same_size_rewrite_with_restored_mtime() {
    use std::time::SystemTime;

    let home = temp_home("ctime");
    let key = SigningKey::from_bytes(&[0x88; 32]);
    let payload = b"same-size-payload-0123456789".to_vec();
    let manifest = manifest_for(&key, "multilingual-embed", "7.7.7", "model.onnx", &payload);
    let mgr = manager(&home, source_for(&manifest, &payload), &key);
    let installed = mgr.install_pack(&manifest).expect("安装");
    mgr.load_pack(AiPackKind::Embedding, "7.7.7")
        .expect("首次加载命中缓存");

    let path = installed.path.join("model.onnx");
    let original_mtime = fs::metadata(&path)
        .expect("原文件元数据")
        .modified()
        .expect("mtime");
    assert!(original_mtime <= SystemTime::now());

    let mut tampered = payload.clone();
    tampered[0] ^= 0xff;
    assert_eq!(tampered.len(), payload.len(), "必须保持同大小");
    fs::write(&path, &tampered).expect("原地改写");
    fs::File::options()
        .write(true)
        .open(&path)
        .expect("打开以便恢复 mtime")
        .set_modified(original_mtime)
        .expect("恢复 mtime");

    let error = mgr
        .load_pack(AiPackKind::Embedding, "7.7.7")
        .expect_err("同大小且恢复 mtime 的篡改仍必须检出");
    assert!(matches!(
        error,
        QuetzalcoatlError::IntegrityViolation { .. }
    ));
}
