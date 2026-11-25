# V1 → V2 迁移指南

Quetzalcoatl V2 与 V1 不是同一个产品线：数据模型、运行时与安全边界都变了。V1 的最终状态完整
保存在 `v1-legacy` 分支与 `v1-final` 标签（`05f7ab7f`）中，`main` 分支只保留 V2。迁移是
**单向、幂等、只读源数据**的：`qz import-v1` 可以重复执行，不会重复写入，也不会修改 V1 文件。

## 1. V1 中已经消失的东西

| V1 | 状态 | V2 替代 |
| --- | --- | --- |
| Git "灵魂仓库"（`SOUL_REPO_SPEC.md`、SSH 同步、提交历史） | **完全移除** | 单写者签名 HLC 事件脊柱 + E2EE Packfile；可读导出为 Markdown + `.quetzalcoatl-spine/` ZIP |
| Flutter 跨平台 UI | **完全移除** | 五端纯原生：GTK4 / SwiftUI / WinUI 3 / TypeScript DOM / 移动原生 |
| Electron / Tauri / WebView 套壳 | **不再支持** | 同上；客户端不做浏览器内核嵌入 |
| V1 Gateway JSON-RPC（Flutter ↔ runtime 的私有 RPC） | **完全移除** | `quetzalcoatld` 本地认证 IPC（UDS `0600` / `127.0.0.1` + 路径能力令牌） |
| 单包内置 `HandsService` 无障碍服务 | **不再作为默认能力** | 能力包 `hands-desktop` 按需启用；Android 分 `store`（零 `AccessibilityService`）与 `full` 双包（Task 5.2） |
| 明文 `quetzal.db` 作为唯一事实源 | **不再是事实源** | SQLite WAL 只是物化视图；事实源是签名事件链，可重放重建 |
| V1 的"仅学习研究、不牟利"限制 | **移除** | `Apache-2.0`（核心/客户端）+ `AGPL-3.0-only`（`hub/`）双层许可 |

V1 的模型供应商适配、提示词模板与工具脚本**不会**自动迁移；它们需要按 V2 的
`packages/harness-enhancers/` 与 `packages/capabilities/` 形态重写。

## 2. 迁移前准备

1. **只读备份**整个 V1 家目录（以你实际使用的路径为准）与所有 `quetzal.db` 库文件。
2. 确认 V1 灵魂目录包含 `.soul-spec.json`；支持 `v1`–`v14`，更高版本会被拒绝。
3. 准备一个**全新的** `QUETZALCOATL_HOME`，不要指向 V1 目录。
4. 确认 `qz` 与 `quetzalcoatld` 版本一致（同一 release）；迁移可离线执行，不需要 Hub。

```bash
export QUETZALCOATL_HOME="$HOME/.quetzalcoatl-v2"
qz up
```

## 3. 执行迁移

```bash
qz import-v1 \
  --soul-dir /path/to/v1-soul \
  --db /path/to/quetzal.db \
  --db /path/to/other-body/quetzal.db
```

- `--soul-dir` 必填；`--db` 可重复，零个或多个。
- 守护进程在线时经本地 IPC 执行；离线时以只读方式打开源库并写入本机脊柱。
- 输出示例：

  ```text
  import-v1 complete (mode=ipc): events=842, memories=131, threads=57, messages=1204, skipped_duplicates=0
  ```

再次执行时，`skipped_duplicates` 应等于上次的导入总量，`events` 增量为 0。

## 4. 映射关系

| V1 源 | V2 落点 | 说明 |
| --- | --- | --- |
| `agent.json` | 脊柱事件 `v1.agent_record` | 原样保留为事件负载 |
| `SOUL.md` | 脊柱事件 `v1.soul_document` + `markdown_docs` 表 | 可读导出时重新出现在 `SOUL.md` |
| `memories/MEMORY.md` | 按 `\n§\n` 切分的 `MemoryEntry` + `markdown_docs` | 去重键基于内容摘要 |
| `memories/USER.md` | 同上 | 作为用户画像记忆 |
| `bodies/*.json` | 脊柱事件 `v1.body_record` | 多身体记录原样保留 |
| `skills/**/SKILL.md` | 脊柱事件 `v1.skill` + `markdown_docs` | 技能正文保留，不自动执行 |
| `journal/**/*.md`、`notes/**/*.md` | 脊柱事件 `v1.document` + `markdown_docs` | 文档正文保留 |
| V1 `sessions` 表 | V2 `threads` + `messages` | 以最大 `updated` 版本收敛 |
| V1 消息 | V2 `messages` | 保留角色、时间与正文 |
| V1 `runs` | V2 `runs` | 保留运行状态与产物引用 |
| V1 `canvas_docs` | V2 `markdown_docs` | 每个 `doc_id` 只保留最大时间戳的最新修订 |

去重使用确定性 BLAKE3 摘要（`quetzalcoatl/v2/import-v1-dedup-v1`）；确定性 UUID 使用
`quetzalcoatl/v2/import-v1-deterministic-uuid-v1`，保证重复导入得到相同 ID。

## 5. 导出、备份与恢复

### 5.1 导出

```bash
qz export ./quetzalcoatl-backup.zip
qz export ./readable-only.zip --no-sealed-spine
```

归档内容：

- `SOUL.md`、`memories/MEMORY.md`、`memories/USER.md` 等可读 Markdown；
- `.quetzalcoatl-spine/`：密封清单、Packfile（`.qzp`）、尾部事件与检查点；
- 默认包含密文脊柱（`--no-sealed-spine` 可关闭）。

导出既可在守护进程在线时经 IPC 完成，也可在离线时直接读取脊柱。

### 5.2 恢复

- **V2 到 V2 恢复**：当前 `qz` **尚无**归档导入子命令；恢复逻辑已作为库 API
  `import_zip_archive` 存在于 `crates/quetzalcoatl-spine`，会重新校验签名事件链与 Packfile AAD。
  在 CLI 暴露之前，请通过自定义 Rust 程序或后续 Task 5.4 的发版工具完成恢复。
- **V1 到 V2**：使用 `qz import-v1`（见 §3），不要尝试把 V1 目录直接放进
  `QUETZALCOATL_HOME`。

> 这是本轮明确的缺口，不伪造"已支持一键恢复"。

## 6. 注意事项

1. **旧设备吊销**：迁移不会自动把 V1 设备当作 V2 受信设备。请用 `qz pair start` 重新配对，
   并在 V2 中显式吊销旧设备。
2. **记忆不是良知**：V1 `MEMORY.md` 导入为 `MEMORY(30)`，不会自动升格为 `SELF_CORE`。若你希望
   把某条长期原则固化，需要走 C 档流程（多独立证据 + 冷却 + 异构双 Reflector）。
3. **外部通道需重建**：V1 的通道令牌不会迁移；用 `qz channel enable <name>` 重新配置，凭据只存
   本机。
4. **群组不迁移**：V2 群组是 `openmls` 房间，V1 没有等价物；需要重新创建并邀请成员。
5. **技能不自动执行**：导入的 `SKILL.md` 只是文档与事件，不会自动成为可执行技能；需按 V2 能力包
   规范重写并由沙箱执行。
6. **`.soul-spec.json` 版本**：仅支持 `v1`–`v14`；解析失败会在写入任何数据前中止。
7. **零敏感数据**：迁移日志与错误信息不打印正文；但仍建议在离线环境执行并自行检查导出归档。

## 7. 验证迁移结果

```bash
qz status                     # 查看脊柱事件数、物化视图与 Heart 状态
qz export /tmp/check.zip      # 抽查可读 Markdown 与密文清单
```

在 Rust 侧可进一步用 `BlindKernel::rehydrate_from_spine`（内部委托
`RunStateMachine::rehydrate_from_spine`）从事件链重建运行与幂等视图，并逐条
`SpineEvent::verify` 校验签名；任何摘要或链断裂都会报 `INTEGRITY_VIOLATION`。

## 8. 回滚

V2 不修改 V1 源数据，因此回滚只需：

1. 停止 `quetzalcoatld`；
2. 把 `QUETZALCOATL_HOME` 指回 V1 目录（或从备份恢复 V1 家目录）；
3. 继续使用 V1（`v1-legacy` 分支 / `v1-final` 标签）。

V2 侧数据可保留为归档，不影响 V1。
