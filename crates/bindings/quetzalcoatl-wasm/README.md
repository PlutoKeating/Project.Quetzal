# `quetzalcoatl-wasm`

浏览器端平台特化层（`wasm32-unknown-unknown`，防坑规范 #17）。

## 1. OPFS 单写者存储 + Web Lock

* 契约（[`src/storage.rs`](src/storage.rs)）：`SingleWriterStorage::try_acquire_writer`
  **立即返回**——已被持有时返回 `StorageError::WriterBusy`（fail fast，绝不阻塞、绝不无锁降级）；
  所有写入必须携带有效 `WriterLease`；租约 `Drop` 立即释放。
* 原生后端 `TempDirStorage`：进程内登记 + `create_new` 独占标记文件，覆盖同进程与跨实例竞争。
* 浏览器后端 [`src/opfs.rs`](src/opfs.rs)：**写入前**先取 `navigator.locks` 独占锁
  （`mode: "exclusive"`, `ifAvailable: true`），取不到即以 `writer lock busy` 拒绝；
  随后经 `FileSystemDirectoryHandle.getFileHandle(create=true)` +
  `createWritable()` 原子写入。
  `web-sys` 的 `LockManager` 仍是 unstable API，为免给全仓库引入 `--cfg web_sys_unstable_apis`，
  这里通过 `Reflect` 动态取 `navigator.locks.request` 并按 Web Locks 标准签名调用。
  若浏览器没有 `navigator.locks`，直接 fail-closed。

## 2. 纯 Rust `ruzstd` 解压

浏览器端不捆绑 C `zstd`。[`src/compress.rs`](src/compress.rs) 用 `ruzstd` 解压，并带
`MAX_DECOMPRESSED_BYTES = 8 MiB` 输出上界（防解压炸弹）。

## 3. 纯 WSS 传输

[`src/transport.rs`](src/transport.rs) 只接受 `wss://`，显式拒绝 `ws://`、`http://`
乃至 `https://`（不允许降级混用）。真正的 WSS 会话循环由 Web 端（Task 4.2）驱动。

## 测试

```bash
cargo test -p quetzalcoatl-wasm                                   # 原生：租约/解压/传输
cargo check -p quetzalcoatl-wasm --target wasm32-unknown-unknown   # 类型级门禁
```

| 测试 | 覆盖 |
| --- | --- |
| `single_writer_lease_blocks_second_writer_within_same_storage` | 同实例第二写者 fail fast + 释放后可重取 |
| `single_writer_lease_is_cross_instance_enforced_by_marker_file` | 跨实例 `WriterBusy` |
| `writes_require_a_live_lease_from_this_storage` | 外域租约 `LeaseRevoked` |
| `keys_with_traversal_or_separators_are_rejected` | 路径上跳/分隔符拒绝 |
| `ruzstd_roundtrip_matches_original_bytes` | `zstd` 压缩 → `ruzstd` 解压逐字节一致 |
| `ruzstd_rejects_oversized_and_corrupt_frames` | 超界与垃圾输入拒绝 |
| `transport_only_accepts_wss_and_rejects_plaintext_downgrades` | 明文/降级端点拒绝 |

**Deferred：** 真实浏览器中的 OPFS + Web Lock 竞争 E2E 在 Task 4.2 的 Web Worker 客户端执行
（`surfaces/web`）；本 crate 目前只做原生语义测试与 wasm 目标类型门禁。

## `unsafe`：`forbid`，无任何豁免

crate 与全工作区一致启用 `#![forbid(unsafe_code)]`（`[lints] workspace = true`），
`src/` 中手写代码零 `unsafe` 关键字。`wasm_bindgen` / `web-sys` 宏展开的胶水自带其内部
`unsafe`（外部宏 span，不触发本 crate lint），因此**不需要任何文件/行级豁免**；
`cargo check -p quetzalcoatl-wasm --target wasm32-unknown-unknown` 与
`cargo clippy --workspace --all-targets -- -D warnings` 均在该 `forbid` 下通过。
