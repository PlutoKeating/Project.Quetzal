# AGENTS.md — Quetzalcoatl (`qz`) V2 工程与协作宪章

本文件约束所有参与 `Quetzalcoatl`（原 V1 归档于 `v1-legacy` 分支与 `v1-final` 标签）开发、重构、测试、文档与交付工作的 AI Agent 与工程师。任何代码变更落地前，必须严格遵守本宪章的全部条款。

---

## 1. 冷启动与开工前必读流程

任何新启动或中断恢复的会话在修改文件前，**必须**完成以下核对：

1. **冷启动必读三件套**：
   - 根级宪章：`AGENTS.md`（本文件）
   - 第一性原理蓝图：`docs/V2_GOAL.html`
   - 全局架构规范与 5-Sprint 实施计划：`.opencode/plans/2026-11-24-quetzalcoatl-v2-architecture-and-plan.md`
   - 若根目录或目标子系统下已落地 `README.md` / `docs/*.md`（见 Sprint 5），亦须一并阅读并以最新实际源码为准。
2. **工作区与基线核对命令**：
   ```bash
   git status -s
   git branch -a
   git log -n 15 --oneline
   ```
   确认当前工作区无意外脏改动，核对计划文件中最后一个已勾选 `[x]` 的步骤与最新 Git Commit 一致，并先跑通前序模块验证门禁后再推进新变更。

---

## 2. 品牌、命名与家目录硬约束

- **产品品牌全称**：**`Quetzalcoatl`**（羽蛇神）。严禁在 V2 新代码中继续沿用旧名 `Quetzal`（`qz import-v1` 历史单向迁移模块除外）。
- **唯一简写规则**：**仅终端 CLI 可执行文件简写为 `qz`**。其余所有二进制、服务、环境变量、配置目录与代码包名一律采用全拼：
  - 本机后台守护进程：`quetzalcoatld`
  - 零算力零知识引导服：`quetzalcoatl-hub`
  - 无容器沙箱包装器：`quetzalcoatl-sandbox-exec`
  - 家目录环境变量：`QUETZALCOATL_HOME`（POSIX 默认 `~/.quetzalcoatl`，Windows 默认 `%LOCALAPPDATA%\Quetzalcoatl`）
  - 所有 Rust crate 统一前缀：`quetzalcoatl-*`（严禁简写为 `qz-*`）

---

## 3. 双层开源许可证与商业合规边界

本项目采用严格物理隔离的双层开源许可架构（正式移除 V1“仅用于学习研究、不以牟利为目的”限制）：

1. **`Apache-2.0`（见 `LICENSE-APACHE`）**：覆盖全部 Rust 内核与共享核心（`crates/*`）、跨语言规范向量（`spec/*`）、外置通道/能力/领域/增强插件包（`packages/*`）、五端纯原生客户端（`surfaces/*`）、安装脚本与文档官网。
2. **`AGPL-3.0-only`（见 `LICENSE-AGPL`，可附商业双许可）**：仅适用于 `hub/` 目录下的零算力零知识服务端 `quetzalcoatl-hub`。
3. **许可证传染硬门禁**：`Apache-2.0` 工作区严禁引入任何 `GPL-2.0*`、`GPL-3.0*`、`AGPL-3.0*` 强传染依赖，由根级 `deny.toml`（`cargo deny check licenses bans sources`）在本地提交前与 CI 中强制阻断；Linux 桌面端动态链接 `libadwaita-1` 须通过 ELF 动态链接合规单测以符合 `LGPL-2.1`。

---

## 4. 六语言技术契约与最高等级编译器门禁

本项目以第一性原理选择各层最优语言，并启用最高等级编译期静态检查辅助 AI Agent 自校正；**100% 放弃跨平台 UI 框架（Flutter / React Native / Compose Desktop）与桌面 WebView 套壳（Electron / Tauri）**：

1. **Rust（`edition = "2024"`, `rust-version = "1.91"`）**：
   - 覆盖范围：盲微内核、密码学与签名 HLC 脊柱、`quetzalcoatl-ewave`、`iroh v1.5` 组网、OS 沙箱与零凭据代理、桌面通用双模 Harness 宿主、`<3MB` 纯 Rust AEC/VAD、`quetzalcoatl-client-core`、`qz` CLI 及 Linux 原生 `gtk4-rs / relm4` 客户端。
   - **强制门禁**：`[workspace.lints]` 全局开启 `unsafe_code = "forbid"` 与 `clippy::{unwrap_used, expect_used, panic, todo} = "deny"`，所有业务 crate 必须声明 `lints.workspace = true`（仅极少数底层 OS FFI 垫片可在独立受控边界内经显式审计豁免，核心业务 crate 一律 `#![forbid(unsafe_code)]`）。
   - 每次提交前必跑：`cargo deny check licenses bans sources && cargo fmt --all -- --check && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace`。
2. **Go（Go 1.26+, `CGO_ENABLED=0`）**：
   - 覆盖范围：`hub/` 零算力零知识引导服 `quetzalcoatl-hub`（单静态二进制）。
   - **强制门禁**：`CGO_ENABLED=0 go build ./cmd/quetzalcoatl-hub && go vet ./... && go test -race ./...`。
3. **Swift（Swift 6.2+）**：
   - 覆盖范围：`surfaces/macos`（macOS 14+ `SwiftUI`）与 `surfaces/ios`（iOS 18–26 `SwiftUI` + `SwiftAgent` + `FoundationModels` + `<12MB` NSE）。
   - **强制门禁**：全面启用 Swift 6 Strict Concurrency。
4. **Kotlin（Kotlin 2.2+）**：
   - 覆盖范围：`surfaces/android`（Android 10–17 API 29–36 `Jetpack Compose` + `JetBrains Koog v1.3`）。
   - **强制门禁**：严格执行 `store`（零 `AccessibilityService`、零 `dataSync` 前台服务）与 `full` 双渠道分包及合并清单静态扫描测试。
5. **TypeScript（TS 5.9+）**：
   - 覆盖范围：`surfaces/web`（Web Worker WASM E2EE + OPFS 原生 DOM 三态客户端）、`website/` 与 `packages/harness-enhancers/*`。
   - **强制门禁**：`strict: true`、`noUncheckedIndexedAccess: true`、禁止裸 `any`。
6. **C#（.NET 9+）**：
   - 覆盖范围：`surfaces/windows`（Windows 10 1809+ / Windows 11 纯原生 `WinUI 3` Fluent 客户端）。
   - **强制门禁**：`<Nullable>enable</Nullable>` 与 `<TreatWarningsAsErrors>true</TreatWarningsAsErrors>`。

---

## 5. 第一性原理核心架构红线

1. **盲微内核（Blind Kernel）**：内核对具体模型供应商、外部通道与业务工具名保持完全盲视，仅收敛于**状态脊柱、权限隔离、事件路由、客观校验**四项原语；严禁向内核回塞办公文档生成、网页爬虫或专有云 SDK。
2. **彻底废除 Git 灵魂仓库**：不保留任何 SSH Git 同步或旧 `SOUL_REPO_SPEC.md` 写路径；100% 统一为单写者签名 HLC 事件脊柱 + `zstd` E2EE Packfiles + 本地 SQLite WAL 物化视图 + 可读 Markdown+Spine ZIP 导出，历史迁移仅通过单向幂等 `qz import-v1` 完成。
3. **物理隔离主权脊柱（1 Agent = 1 独占脊柱）**：不设单 Agent 内部多人分舱；凡涉及家庭/团队多人协作或公共岗位角色，强制创建物理与密码学完全隔离的独立 Agent 实例，经 `quetzalcoatl-group` 四大协同拓扑交互。
4. **底层 Coding Agent 原子解耦**：严禁重造底层 ReAct Coding Agent Loop 毛坯房；桌面端经 ACP / 原生 JSON-RPC + 四层回环安全壳纳管成熟宿主（默认推荐 OpenCode V2，兼容 Claude Code / Codex / Pi / Goose / Hermes / `dsh` / `agy`），移动端原生内嵌 `Koog v1.3`（Android）与 `SwiftAgent + FoundationModels`（iOS）。
5. **两段式良知稳态与洁净室客观校验**：`ROOT (100)` / `OPERATOR (80)` / `SafetyEnvelope` 绝对锁死；`SELF_SOFT (50)` / 技能脚本 / `MEMORY (30)` 在写时复制沙箱内即时自由自演化（零审批弹窗）；`SELF_CORE (70)` 走 eWave C 档全自动多证据冷却升格；`Explore Run` 硬剥夺外部写权限，研发与高危汇点 `Commit Run` 强制经断网只读洁净室 `Verifier` 验收签发 `Mark`。

---

## 6. 三轮架构与源码级审计的 22 项细节防坑纪律

以下 22 条铁律对应真实编译失败、死锁、活锁、OOM、封号或安全绕过漏洞，编码与审查时必须逐条核验：

1. **回环网关路径级能力令牌与 OAuth `refresh_token` 剥离保护**：`quetzalcoatld` 为每个受管会话生成 256-bit 路径能力密钥（`http://127.0.0.1:<port>/run/<cap_token>/...`）做常量时间校验防本机 SSRF 蹭用；同时在沙箱外由 `quetzalcoatld` 托管真实 `~/.claude` / `~/.codex` 长期 `refresh_token`，仅向沙箱挂载剥离了 `refresh_token` 的临时 `CLAUDE_CONFIG_DIR` / `CODEX_HOME` 存根，由网关在出站瞬间换上真令牌，彻底防止沙箱内脚本窃取订阅刷新凭据。
2. **Anthropic 累积前缀缓存保护（`tools → system → messages`）与 4-`cache_control` 归一化**：回环网关**严禁触碰 `system[0]`** 且必须原样透传 `anthropic-beta`、`anthropic-version`、`Authorization` 与 `/v1/messages/count_tokens`；仅将会话期内恒定不变的 `PINNED`（`ROOT+OPERATOR+SELF_CORE`）追加在 `system[last]`，将每轮易变的 `RELATION`、`RECALL`、`VOLATILE`（`FocusConfig` 权重与披露通知）及 `<ewave_check>` 统一注入**最后一条 `user/tool_result` 消息末尾**；转发前统计全请求 `cache_control` 总数并自动合并归拢，严禁超过 4 个触发 HTTP 400。
3. **Codex `v0.163+` WebSocket `426` 降级、`zstd` 请求解压与双路径后缀保真**：网关分别挂载 `.../chatgpt/backend-api/codex`（严格保留 `/backend-api/codex` 后缀与 `ChatGPT-Account-ID`）与 `.../openai/v1`；对 `/responses` 的 WebSocket `Upgrade` 握手直接返回 **`HTTP 426 Upgrade Required`** 触发 `codex-rs` 内置 `force_http_fallback` 回退为全量历史 HTTP SSE；自动解压 Codex 默认发出的 `Content-Encoding: zstd` 请求体并回传未压缩响应，启动时同时覆盖 `-c openai_base_url` 与 `-c model_providers.<active>.base_url`（绝不设 `chatgpt_base_url`），并用 `serde_json::value::RawValue` 原样保留 `encrypted_content`。
4. **Gemini CLI 双变量与启动握手透传 + OpenCode V2 目录级插件规范**：对 Gemini CLI 同时注入 `CODE_ASSIST_ENDPOINT` 与不含 `/v1` 后缀的 `GOOGLE_GEMINI_BASE_URL`，对启动期无模型名的 `/v1internal:loadCodeAssist` 与 `:onboardUser` 原样放行不报错；OpenCode V2 本地插件必须按目录结构 `.opencode/plugins/quetzalcoatl/index.ts` 导出 `Plugin.define({ id, setup(ctx) })`（严禁裸 `.ts` 文件或 V1 函数导出），并开启 `OPENCODE_CONFIG_PROJECT_DISABLE=1`、禁用 `--service` 单例、屏蔽裸 `/api/pty*`。
5. **同名二进制嗅探防撞车 + Linux Keyring 防卡死**：嗅探 `pi`、`dsh`、`grok` 时必须核对 `--version` 输出特征串（防误判数学工具 `pi` 或 Debian 系统包 `dsh`）；无 `DBUS_SESSION_BUS_ADDRESS` 的 SSH/容器环境禁止触发 `libsecret` 读取以防无限阻塞。
6. **`iroh v1.5` 真打洞必备 `:7842/udp` QAD**：`iroh 1.x` 已彻底移除 STUN，公网反射地址发现完全依赖 UDP `:7842` ALPN `/iroh-qad/0`；Go `quetzalcoatl-hub` 必须同时提供 `:443/relay`（`iroh-relay-v2` 混合帧：`0..=3` `postcard`、`4..=13` 原始二进制，反代下 TLS Exporter 不匹配优雅回退 `ServerChallenge`）与 `:7842/udp` QAD 响应器 + `GET /ping`。
7. **两态围栏租约防公网双发脑裂**：联网持 Hub `witness_epoch` 允许全量外部通道写操作；断网超宽限期进入 `Partition-Local Lease` 时，允许本地对话、探索与长辈紧急本地告警，但非幂等公网外发消息一律暂存 Outbox 待重获 `witness_epoch` 对账后再发。
8. **洁净室只读 `Verifier` 防奖励作弊**：`Verifier` 绝不能在 Worker 可写的同一目录直接跑可能被篡改的测试脚本，必须在挂载内核锁定校验配置的独立断网只读沙箱中对候选 diff 进行验收，且 0 测试命中一律判失败（Anti-Vacuity）。
9. **压缩前分桶填充防 CRIME 侧信道**：外部不可信通道消息与敏感核心状态分包存储，且 `zstd` 压缩后在 AEAD 加密前按 2 的幂次分桶填充长度，绑定完整结构化 `AAD`。
10. **HLC 未来时钟投毒防护**：签名事件头包含 `hlc_u128`，接收端遇到 `hlc.wall > local_trusted_time + 5m` 的偏置时钟事件直接隔离拒收，绝不推高本机 HLC。
11. **`SayIt`（`sayit-handoff.md` v2.1）四项对齐与重归档幂等契约**：① 快照 `meta` 显式标记 `{ emb_model_id, emb_dim }`，异源模型子树进入 `quetzalcoatl-ewave::merge()` 时自动用本脊柱规范嵌入器重算向量（离线时先走 `semanticWeight=0` 词法+结构对齐并入队后台 `reembed()`），防 `EWAVE_DIMENSION` 崩溃；② 分支对齐强制校验 `data.role`（`project / record / section`）同粒度匹配；③ 记录 `(sayit_user_hash, slice_id, session_id, snapshot_sha256)`，当用户在 SayIt 改归属重编译覆盖同 `sessionId` 快照时，先双时态 `invalidate()` 旧版独占节点再合并新版；④ 将 `@plutokeating/ewave` 中的宿主区域相关 `localeCompare` 统一升级为确定性 UTF-16 码元序（与 `fnv1a` 对齐），并将 `packages/ewave` 许可证对齐至 `Apache-2.0`。
12. **`<3MB` 内置 VAD 与双杀 ONNX 遥测**：内置 VAD 是自研常量可折叠 16 kHz 单分支图的**纯 Rust 转写**（能量 + 周期性，确定性；`tract-onnx` 仅在开发期做解析/折叠/数值一致性验收，因增加 **19.35 MiB** 而不进默认构建）；**Silero 权重未捆绑**，替换为学习型 VAD 是功能默认启用前的跟踪项。按需动态加载 `ort` 时，**同时**在启动器环境注入 `ORT_DISABLE_TELEMETRY=1`（杀 POSIX 1DS 遥测）并由 `OrtInitializer` 强制桥接调用 `ort::init_from(...).with_telemetry(false)`（杀 Windows ETW 遥测），桥接报告遥测未关闭即 fail-closed；具体 `ort` 运行时加载器延后至首个需要端侧推理的 surface。
13. **单物理主机唯一脊柱持有者防互踢**：桌面上仅后台 `quetzalcoatld` 直接打开 `spine.sqlite` WAL 与 `iroh` 节点密钥；本机 GTK4 / SwiftUI / WinUI 3 与 `qz` CLI 检测到 `quetzalcoatld` 在线时一律走本地 IPC 薄客户端模式，杜绝 `SQLITE_BUSY` 与中继互踢。
14. **`UniFFI = "=0.32.0"` 精确锁死与拉模式异步流**：`Cargo.toml` 精确用 `=` 锁定 `uniffi` 与 `uniffi-bindgen-cs` 配对版本，全面禁用外语回调接口（规避 C# 异步回调生成同步签名 Bug `#165` 与 GC 委托悬垂崩溃），统一采用 `ViewStream::next_events()` 拉模式流。
15. **iOS `<12MB` NSE Spool 模式防 `0xdead10cc` 杀后台**：推送解密扩展 `quetzalcoatl-nse-ffi` 不链接 `tokio/iroh`，`zstd` 解压窗口 `<=1MiB`，且**严禁打开主库 `rusqlite` WAL**——解密后仅向 `<AppGroup>/spine-spool/` 写只追加小文件，由主进程前台/后台任务安全合并并在挂起前释放全部文件锁。
16. **iOS `SwiftAgent` 编译期 Trait 桥接、锁屏钥匙串权限与 `<=8B` 端侧模型禁跑 `Reflector`**：① `SwiftAgent` 启用 SPM `traits: ["OpenFoundationModels"]` 编译，同时注册 `AppleOnDeviceLanguageModel`（`#available(iOS 26, *)` + `CompactOnDevice(4096)` 预算）与 `QuetzalRustCloudLanguageModel`（经 `UniFFI` 逐轮动态重组装良知），实现运行期无缝切换；② 移动端后台主密钥采用 iOS `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` / Android `setUserAuthenticationRequired(false)` 确保持锁屏唤醒可用；③ **严禁 `<=8B` 端侧小模型（含苹果 3B 模型）充当 `Reflector/Judge` 审议 `>= USER_PREF / SELF_CORE` 写回**（离线手机产生的 episode 标为 `pending`，待连上云端大模型或桌面节点后再巩固，防小模型自我谄媚污染核心价值）。
17. **WASM 浏览器三项平台特化**：`wasm32-unknown-unknown` 目标下自动切换为 `navigator.locks` + OPFS `journal_mode=PERSIST; locking_mode=EXCLUSIVE` SQLite VFS、纯 Rust `ruzstd` 与纯 WSS 中继模式。
18. **公网 Webhook 零知识 HPKE 入站与 S3 Presigned `PUT`**：`quetzalcoatl-hub` 接收外部平台 Webhook 时仅在内存验 HMAC 后立即用 Agent 的 `ChannelIngressKey` 做 HPKE 密封入队（零明文落盘）；对象存储统一用兼容 Cloudflare R2 / MinIO / AWS S3 的 **Presigned `PUT`**（带签名 `Content-Length` 与 `sha256`）替代兼容性差的 `PresignedPostPolicy`。
19. **共享角色 Agent「1 实例 = 1 群信任域」防跨群串味与 `StewardGrant` 可吊销托管**：不设单实例内部分舱的前提下，严禁将同一个共享角色 Agent 同时拉入机密等级不同的两个群房间（不同保密群各自孵化独立共享角色 Agent）；其 `AccountRootKey` 由主监护节点持有并辅以分片备份，协管员通过绑定 `openmls` 成员身份的 `StewardGrant` 行权，踢出群即自动吊销管理权并轮换 `EpochKey[e+1]`。
20. **群聊非主人发言降权（防 `S1/S4` 冒充）与出站隐私门禁**：个人主权 Agent 在群房间收到的非本人消息一律包裹为 `<group_room_context authority="UNTRUSTED">`（仅计 `S8` 信号，`S1/S4` 强制验本人设备签名），且 `Router` 出站门禁拦截任何未经 `eWave::Grant` 或本人群内授权的私有 `MEMORY / USER_PREF` 引用。
21. **两层式群组提交水位线（消除活跃群 `409` 无限重生成活锁）**：第一层在 `quetzalcoatl-hub` 校验 `mls_epoch`（纯密钥轮换不匹配时直接用 `GroupEpochKey[e+1]` 重加密密文重发，无需重跑大模型）；第二层在 `Router` 执行**语义控场屏障**——仅当 `(last_seen_seq ..= head_seq]` 增量中存在点名 `@本Agent`、`@agents`、同父话题追问或 `cancel/steer` 信号时才触发重读重算，无关闲聊与表情直接快进附挂 `causal_parent_seq` 提交。
22. **单用户异构专长编队（Topology 3）跨 Worktree 零拷贝交接**：同一用户名下的「Claude 架构 + OpenCode 主程 + Codex 审查」编队作为共享只读良知快照的临时异构 `Worker Runs` 运行，各隔离 worktree 间的未提交代码与产物通过不可变 Git Tree 引用 **`ArtifactRef::GitTree(oid)`**（`refs/qz/squad/<id>/<role>`）精确交接审阅。

---

## 7. Git 卫生、敏感数据与推送纪律

1. **中文语义化原子提交**：一个逻辑单元一个提交，提交消息使用清晰准确的中文说明真实工程意图，严禁 `update`、`fix`、`wip` 等模糊消息。
2. **严禁任何 AI 署名 Trailer**：提交信息中**绝对禁止**包含 `Co-Authored-By`、`Generated-by` 等任何 AI 辅助标记。
3. **零 Untracked / 脏文件铁律**：每次任务结束前必须执行 `git status -s`，确保不存在任何未跟踪文件（untracked files）或未暂存改动；构建产物、临时目录（如 `.superpowers/`）必须纳入 `.gitignore`。
4. **敏感信息绝不入库**：API Key、OAuth 令牌、私钥、真实个人记忆/人格样本、具体设备标识符或私有 IP/MAC 地址一律禁止入库；测试夹具必须 100% 采用合成数据，运行态数据仅存于仓库外的 `QUETZALCOATL_HOME`。
5. **远程推送纪律**：
   - 未经人类维护者当下最新显式授权，不得向 `main` 分支执行 `git push`；
   - 未经二次显式确认，绝对禁止执行 `git push --force` 或 `git push --force-with-lease`。
