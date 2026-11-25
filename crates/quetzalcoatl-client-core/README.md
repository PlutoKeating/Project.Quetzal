# `quetzalcoatl-client-core`

五端（GTK4 / SwiftUI / WinUI 3 / Compose / Web）共享的纯 Rust 客户端核心。三个模块各自对应一条不可让渡的架构红线。

## 1. `ipc_mode` — 单脊柱持有者薄客户端（防坑规范 #13）

```rust
use quetzalcoatl_client_core::ThinClient;

let client = ThinClient::mount(&home)?;         // 只读探测，不创建任何文件
let status = client.status()?;                  // 一切读取都经本地 IPC
let resp = client.call(&IpcRequest::DomainList)?; // 一切写入也经本地 IPC
```

* 只有 `spine/daemon.lock` + `run/daemon.json` + `run/daemon.token` 三者齐备、
  token 文件为当前用户 `0600` 私有、且 `/v1/health` 握手成功时才返回客户端。
* 任一条件不满足返回类型化 `ClientError::DaemonUnavailable`（或令牌权限不足时的
  `ClientError::InsecureRuntimeFiles`），**绝不静默直连 `spine/spine.sqlite`**。
* 本 crate **不依赖 `rusqlite`，也不依赖 `quetzalcoatl-spine`**（有集成测试静态断言），
  因此"薄客户端误开数据库"在依赖图上物理不可能发生。
* 令牌权限校验严格先于令牌内容读取与 JSON 解析：未获授权不消费密钥。

## 2. `view_models` — 三档认知密度差分视图

`Companion`（摘要）⊂ `Workbench`（摘要+细节）⊂ `Inspector`（含原始载荷）严格嵌套。

```rust
let patch = base.diff(&target)?;     // ops 按 key 升序 → 完全确定
state.apply(&patch)?;                // 幂等：重复下发同一补丁是安全空操作
let snapshot = ViewState::replay(&base, &[p1, p2, p3])?;  // 完整快照可重放得到
```

乱序补丁（`from_rev` 与本地 `rev` 不符）显式返回 `PatchError::OutOfSequence`，绝不部分合并。

## 3. `llm_stream_bridge` — 拉模式流（防坑规范 #14）

```rust
let stream = ViewStream::spawn(source);
let batch = stream.next_events(8)?;  // 有界批次，硬上界 MAX_BATCH_EVENTS = 64
stream.cancel()?;                    // 立即唤醒并 join 生产者线程
```

* 没有任何外语回调注册：宿主只能主动拉取。
* 生产者线程按需生产（未拉取时阻塞在命令通道），不存在无界缓冲。
* `Drop` 与 `cancel` 都回收线程；10,000 次创建/取消后文件描述符回到基线（有测试）。

## 测试

```bash
cargo test -p quetzalcoatl-client-core
```

| 测试 | 覆盖 |
| --- | --- |
| `thin_client_mount::gui_and_cli_concurrent_mounts_share_ipc_without_lock_conflict` | 真实 `quetzalcoatld` + 2 个独立进程薄客户端（GUI/CLI 模拟），断言 0 个 `SQLITE_BUSY`、子进程 0 个 `spine.sqlite` fd |
| `thin_client_mount::loose_token_file_permissions_are_refused_before_reading_the_secret` | 0644 令牌被拒，且不解析其内容 |
| `view_patch_replay::*` | 差分确定性、幂等重放、序裂拒绝、三档密度裁剪 |
| `stream_lifecycle::ten_thousand_create_cancel_cycles_keep_fd_and_rss_bounded` | 10,000 次拉流取消，fd 回到基线 + RSS 上界 |
