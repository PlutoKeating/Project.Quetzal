#![forbid(unsafe_code)]
#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]

//! 原生可测的浏览器存储/压缩/传输语义（无需浏览器）。

use std::fs;
use std::path::PathBuf;

use quetzalcoatl_wasm::compress::{
    MAX_DECOMPRESSED_BYTES, decompress_pack, decompress_pack_bounded,
};
use quetzalcoatl_wasm::storage::{SingleWriterStorage, StorageError, TempDirStorage};
use quetzalcoatl_wasm::transport::{TransportError, WssEndpoint};
use uuid::Uuid;

struct TempRoot(PathBuf);

impl TempRoot {
    fn new(prefix: &str) -> Self {
        let base = PathBuf::from("/tmp/opencode");
        let parent = if base.is_dir() {
            base
        } else {
            std::env::temp_dir()
        };
        let path = parent.join(format!("{prefix}_{}", Uuid::new_v4().simple()));
        fs::create_dir_all(&path).expect("create temp root");
        Self(path)
    }

    fn path(&self) -> &std::path::Path {
        &self.0
    }
}

impl Drop for TempRoot {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn single_writer_lease_blocks_second_writer_within_same_storage() {
    let root = TempRoot::new("qz_wasm_sw");
    let storage = TempDirStorage::new(root.path()).expect("storage");

    let lease = storage.try_acquire_writer("spine").expect("first lease");
    let err = storage
        .try_acquire_writer("spine")
        .expect_err("第二个写者必须立即失败");
    assert!(
        matches!(err, StorageError::WriterBusy { .. }),
        "必须 fail fast 返回 WriterBusy，实际 {err:?}"
    );

    storage
        .write(&lease, "pack-1", b"hello")
        .expect("holder can write");
    drop(lease);

    // 释放后可以重新取租约（并覆盖同 key）。
    let lease2 = storage
        .try_acquire_writer("spine")
        .expect("lease after drop");
    assert_ne!(lease2.token(), 0);
    storage.write(&lease2, "pack-1", b"world").expect("rewrite");
    assert_eq!(
        storage.read("pack-1").expect("read").as_deref(),
        Some(&b"world"[..])
    );
}

#[test]
fn single_writer_lease_is_cross_instance_enforced_by_marker_file() {
    let root = TempRoot::new("qz_wasm_xproc");
    let first = TempDirStorage::new(root.path()).expect("storage a");
    let second = TempDirStorage::new(root.path()).expect("storage b");

    let _lease = first.try_acquire_writer("spine").expect("first lease");
    let err = second
        .try_acquire_writer("spine")
        .expect_err("另一个实例必须 fail fast");
    assert!(
        matches!(err, StorageError::WriterBusy { .. }),
        "跨实例必须返回 WriterBusy，实际 {err:?}"
    );
}

#[test]
fn writes_require_a_live_lease_from_this_storage() {
    let root_a = TempRoot::new("qz_wasm_lease_a");
    let root_b = TempRoot::new("qz_wasm_lease_b");
    let storage_a = TempDirStorage::new(root_a.path()).expect("storage a");
    let storage_b = TempDirStorage::new(root_b.path()).expect("storage b");

    let lease = storage_a.try_acquire_writer("spine").expect("lease");
    let err = storage_b
        .write(&lease, "pack-1", b"x")
        .expect_err("外域租约必须被拒绝");
    assert!(
        matches!(err, StorageError::LeaseRevoked { .. }),
        "必须返回 LeaseRevoked，实际 {err:?}"
    );
}

#[test]
fn keys_with_traversal_or_separators_are_rejected() {
    let root = TempRoot::new("qz_wasm_keys");
    let storage = TempDirStorage::new(root.path()).expect("storage");
    let lease = storage.try_acquire_writer("spine").expect("lease");

    for bad in ["../escape", "a/b", "a\\b", "", ".", ".."] {
        let err = storage.write(&lease, bad, b"x").expect_err(bad);
        assert!(
            matches!(err, StorageError::InvalidKey { .. }),
            "非法 key `{bad}` 必须被拒绝，实际 {err:?}"
        );
    }
    assert!(
        !root.path().join("escape").exists(),
        "路径上跳不得写出存储根目录"
    );
}

#[test]
fn list_and_remove_respect_prefix_and_hidden_markers() {
    let root = TempRoot::new("qz_wasm_list");
    let storage = TempDirStorage::new(root.path()).expect("storage");
    let lease = storage.try_acquire_writer("spine").expect("lease");
    storage.write(&lease, "pack-1.bin", b"1").expect("w1");
    storage.write(&lease, "pack-2.bin", b"2").expect("w2");
    storage.write(&lease, "other.bin", b"3").expect("w3");

    assert_eq!(
        storage.list("pack-").expect("list"),
        vec![String::from("pack-1.bin"), String::from("pack-2.bin")]
    );
    storage.remove(&lease, "pack-1.bin").expect("remove");
    assert_eq!(
        storage.list("pack-").expect("list"),
        vec![String::from("pack-2.bin")]
    );
}

#[test]
fn ruzstd_roundtrip_matches_original_bytes() {
    let payload: Vec<u8> = (0..200_000u32)
        .map(|index| u8::try_from(index % 251).unwrap_or(0))
        .collect();
    let frame = zstd::encode_all(&payload[..], 3).expect("zstd encode");

    let restored = decompress_pack(&frame).expect("ruzstd decode");
    assert_eq!(restored, payload, "纯 Rust ruzstd 解压必须逐字节一致");
}

#[test]
fn ruzstd_rejects_oversized_and_corrupt_frames() {
    let payload = vec![7u8; 64 * 1024];
    let frame = zstd::encode_all(&payload[..], 3).expect("zstd encode");

    let err = decompress_pack_bounded(&frame, 1024).expect_err("必须拒绝超界输出");
    assert!(
        err.to_string().contains("解压输出超过上界"),
        "必须是 TooLarge，实际: {err}"
    );

    let err = decompress_pack(&b"not a zstd frame at all"[..]).expect_err("必须拒绝垃圾输入");
    assert!(err.to_string().contains("zstd 帧解析失败") || err.to_string().contains("解压"));
    const { assert!(MAX_DECOMPRESSED_BYTES >= 1024 * 1024) };
}

#[test]
fn transport_only_accepts_wss_and_rejects_plaintext_downgrades() {
    let endpoint =
        WssEndpoint::parse("wss://hub.quetzalcoatl.example:8443/relay?x=1").expect("wss");
    assert_eq!(endpoint.host(), "hub.quetzalcoatl.example");
    assert!(endpoint.as_str().starts_with("wss://"));

    for bad in [
        "ws://hub.example/relay",
        "http://hub.example/relay",
        "https://hub.example/relay",
        "hub.example/relay",
        "wss://",
        "wss://user@hub.example/relay",
        "wss://hub.example/relay\nInjected: 1",
    ] {
        let err = WssEndpoint::parse(bad).expect_err(bad);
        assert!(
            matches!(
                err,
                TransportError::NotWss { .. }
                    | TransportError::MissingHost { .. }
                    | TransportError::Malformed { .. }
            ),
            "{} 必须被拒绝",
            bad.escape_debug()
        );
    }
}
