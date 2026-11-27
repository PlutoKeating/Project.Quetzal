# Quetzalcoatl (`qz`) 宿主原生转向：架构修订与 S0–S9 实施计划

> **状态**：2026-11-28 经项目所有者批准，是当前唯一有效的执行计划。
> **与旧计划的关系**：`.opencode/plans/2026-11-24-quetzalcoatl-v2-architecture-and-plan.md` 已完成的 80 个步骤是本计划的地基，其架构规范继续有效；其未完成部分中，Task 5.1 / 5.2（iOS 与 Android 对话端）**撤销**，Task 3.2 的 Step 3b（端侧推理加载器）**冻结**。凡与本文第二部分冲突的旧决策，以本文为准。
> **命名约定**：文中带「拟」字的命令、接口与文件名是设计提议，落地时可以改名，但语义不变。

---

## 目录

1. 背景与依据
2. 所有者拍板的六条前提与被取代的旧决策
3. 架构修订要点
4. 实施计划（S0–S9 的冲刺契约与任务）
5. 审视重点
6. 冷启动交接

---

# 第一部分：背景与依据

## 1.1 铁律与定位

- **000 号铁律**：不做自己的控制台、聊天框或对话型客户端，完全不做自己的 agent harness。对话和推理循环永远发生在别人的宿主里（Claude Code、Codex、OpenCode、DeepSeek Harness、手机上的助手 App、IM 等）。
- **定位**：Quetzalcoatl 是 Agent 的「海」——人格、价值、关系与记忆，带权威等级并签名，跟着用户的设备走；在任何宿主的每次模型调用之前送进去，调用之后把输出当作信号，经独立审查才写回。它是 `Project.eWave` 中 GleanIt 理想的运行基座。
- **判据**：一个功能属于海（数据、治理、注入、调度）就做；属于浪（对话、推理循环）就交给宿主。
- **依据文档**：`docs/ORIGIN_GOAL.md`（目标用户与十个环境场景）、`docs/USER_SCENARIOS.md`（34 类场景逐步分析、现状与依赖顺序）。

## 1.2 2.0.0-alpha.4 的实况

零件大量建成并有测试，但三条主链路——接进用户自己的宿主、调用后写回、他自己的人生——没有一条接到用户手上。用户能摸到的是自家聊天框。生产环境只有官网在线，V2 的 Hub 未部署，客户端没有默认 Hub 地址。

## 1.3 勘查发现的六个硬缺口

| # | 缺口 | 位置 |
|---|---|---|
| 1 | 良知不在脊柱里：只存在本机快照 `identity/sovereign_state.json`，只在对话、导入、关机三处保存；变更不是可重放的事件，多设备同步不带良知 | `crates/quetzalcoatl-daemon/src/daemon.rs`（`save_sovereign_snapshot`、`load_or_init_sovereign_bundle`） |
| 2 | 种子与自检标签不能直接送进用户会话：`operator-01` 以高权威要求一切文件修改委派 Worker；自检规则要求每条回复带可见标签 | `daemon.rs`（`default_seed_conscience`）、`crates/quetzalcoatl-ewave/src/assembler.rs`（`SELF_CHECK_STATIC_RULE`） |
| 3 | 召回基本不可用：向量是 64 维词法哈希；触发兜底要求记忆正文包含整句提问；全文检索把整句当短语；问题为空时带上全部记忆；V1 导入的灵魂只落成普通记忆，图节点不带记忆编号 | `crates/quetzalcoatl-ewave/src/graph.rs`（`hash_embed`）、`assembler.rs`、`crates/quetzalcoatl-spine/src/store.rs`（`search_memories_fts`）、`daemon.rs`（`sync_imported_memories_into_ewave`） |
| 4 | 写回的证据链是空的：守护进程从不登记相处记录，有界层一律挂起；证据为空时去重键恒定，第二次纠正被当成重复；修改预算从不复位；仲裁器是未使用的字段 | `crates/quetzalcoatl-ewave/src/arbiter.rs`、`daemon.rs`（字段 `_arbiter`） |
| 5 | 根私钥、设备种子、纪元密钥明文与快照同存一个文件 | `daemon.rs`（`PersistedSovereignState`） |
| 6 | 导出包不含良知，导入只恢复记忆表，命令行没有导入入口 | `crates/quetzalcoatl-spine/src/archive.rs` |

另有两条与挂载直接相关的事实：

- 挂载只在守护进程自己拉起宿主时临时注入（`crates/quetzalcoatl-harness/src/drivers/claude.rs` 的 `build_launch_plan`，只注册了压缩之前与回合结束两个事件，命令是 node 脚本）；用户自己开的会话接不到。
- 守护进程拉起宿主时会复制用户的宿主配置（`crates/quetzalcoatl-harness/src/gateway.rs` 的 `copy_and_strip_cred_dir`），其中包含用户层的钩子与已启用插件——一旦把挂载装进用户层，受管运行会递归触发自己的钩子。

---

# 第二部分：所有者拍板的六条前提与被取代的旧决策

## 2.1 六条前提（2026-11-28 拍板）

| # | 前提 | 影响冲刺 |
|---|---|---|
| **P1** | 治理面只有「看」和「签」，没有输入框 | S5 |
| **P2** | 撤掉手机对话端。手机以后只做推送拍板、治理面、给手机宿主当数据源，另行审批 | S0、S10 |
| **P3** | 无人在场时，守护进程可以调度宿主不带界面地跑（探索、后台反思、IM 来信）。循环和模型调用都是宿主的，用宿主自己的登录；守护进程自身永不直接调模型 | S1、S8 |
| **P4** | 拆除 `qz chat`、各端输入框与对话记录、Hub 的模型代理；语音冻结；不做群聊界面 | S1、S5、S6 |
| **P5** | 用户自己的会话默认只用「不会挡路」的挂点（钩子、MCP、状态栏、插件）。回环网关降为受管运行与可选的深度模式 | S2 |
| **P6** | 「抹除」是真删：每条往事的正文单独加密存放，抹除就是销毁它的钥匙，签名链只留一个空壳 | S3 |

## 2.2 被取代的旧决策

| 旧决策 | 处置 |
|---|---|
| D-12 手机端内嵌轻量引擎（Koog / SwiftAgent） | 被 P2 取代，撤销 |
| D-24 五端「三档认知密度」 | 被 P1 取代，只保留检视一档并演化为治理面 |
| D-11 默认套四层非侵入代理壳 | 被 P5 修订：代理壳只用于受管运行与可选深度模式 |
| D-22 语音与端侧小模型 | 语音冻结；端侧推理加载器是否重启，由 S3 的召回评测决定 |
| D-01 中的「可选零日志开箱模型代理」 | 被 P4 取代，删除 |
| D-21 中「群房间」的自有显示 | 被 P4 取代：群住在别人的 IM 里，协议与控场保留 |

---

# 第三部分：架构修订要点

## 3.1 手边四层

| 层 | 是什么 | 放什么 |
|---|---|---|
| 宿主内 | 钩子、插件、MCP 工具、斜杠命令、状态栏、宿主自己的权限提示 | 一切日常动作 |
| 系统层 | 通知、托盘、推送 | 需要用户但用户不在宿主里的事 |
| 治理面 | 自有界面，只看和签 | 底线、翻海、设备、记录、带走 |
| 终端一行 | `qz` | 接上、诊断、导出导入 |

## 3.2 宿主会话挂载

- 钩子与 MCP 都是 `qz` 的子命令，直接读 `run/daemon.json` 与 `run/daemon.token` 走本地 IPC；不把任何令牌写进宿主配置。
- **失败即放行**：任何超时、守护进程不可达、解析失败，钩子都以成功码退出且不输出。唯一例外是底线校验失败：不注入，并在状态栏说明。
- 稳定内容（核心）在会话开始与压缩之后送入；易变内容（往事、披露）在每次提交之前送入。
- 用户会话里不要求模型输出可见的自检标签。

## 3.3 受管运行

守护进程自己拉起的宿主进程叫受管运行。它带环境标记（拟 `QUETZALCOATL_MANAGED_RUN=1`），用户层的钩子、MCP 与状态栏命令见到标记立即退出；它产生的相处记录单独标记，不计入独立证据。受管运行只用于无人在场的场景与洁净室验收。

## 3.4 良知事件化

- 事件类型放在 `quetzalcoatl-ewave` 的新模块里，经 `PackCompartment::Core` 写入脊柱；内核保持盲视。
- 两类事件从一开始就分开：**信号**（有人提交了一个写回请求）与**变更**（仲裁放行后的增量，同时带审计字段）。单机上两者连着发生；多设备时非控制设备只写信号，持控制权的设备仲裁并写变更；变更带纪元，重放时丢弃过期的。
- 第一条事件收编现有快照（基线）。启动时、以及收到其它设备的同步后重放；快照降为缓存。
- 写入顺序固定：先追加事件，再经唯一的应用函数改内存。

## 3.5 真删

往事的正文不进签名链。签名链里只放密文引用；正文以每条一把钥匙单独加密存放。抹除 = 销毁钥匙并把销毁同步到每台设备。

## 3.6 本人信号的信任锚

钩子与模型能执行的命令属于同一个系统用户，模型可以自己调钩子冒充用户。因此：

1. 显式信号只在同一轮里钩子从用户原话中确定性认出意图（或斜杠命令）时成立，回合结束时再用宿主的对话记录核对。
2. 显式信号最高只能写到「关于我的偏好」，且必披露。
3. 插件的工具前钩子拒绝模型通过命令行调用我们的钩子与 MCP 命令。
4. 底线只能在治理面签。

---

# 第四部分：实施计划

## 全局强约束（适用于以下每一个 Task）

- **宪章**：`AGENTS.md` 的命名、许可证、六语言门禁、Git 卫生与推送纪律全部适用。
- **四步法**：先写会失败的测试 → 运行确认红灯 → 实现 → 全门禁通过后中文原子提交。
- **每次提交前**：`cargo deny check licenses bans sources && cargo fmt --all -- --check && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace && bash scripts/tests/docs_links.test.sh`；动到 Hub 时加 Go 的构建、`go vet`、`go test -race`；动到 Web 时加 vitest 与 Playwright。
- **文档门禁**：`README.md` 与 `docs/*.md` 里不得出现尚未登记的 `qz` 子命令或不存在的路径。新增子命令必须登记进 `crates/quetzalcoatl-daemon/src/bin/qz.rs` 的 `USAGE_TEXT`；删文件时同步更新 `docs/USER_SCENARIOS.md` 附录 C。
- **需所有者当场授权的动作**：推送到 `main`、打发版标签、改生产服务器、改所有者本机的宿主配置、改 SayIt 仓库。
- **macOS 与 Windows**：验证机恢复前只保证编译和单测通过，不加新功能，严禁伪造其它操作系统的本地通过记录。
- **冲刺收尾**：按 `docs/USER_SCENARIOS.md` 对应场景在真机上走一遍，更新「现状」栏。从 S2 起每个冲刺升一个预发布版本。

---

## S0：立规

### S0 Contract

- **用户可见行为**：无。宪章、计划与定位文档和铁律一致。
- **验证命令**：`bash scripts/tests/docs_links.test.sh`、`cargo test -p quetzalcoatl-types --test workspace_hygiene`。
- **明确排除项**：任何代码改动。

### Task 0.1：新计划落盘与旧计划标注

**Files:**
- Create: `.opencode/plans/2026-11-28-quetzalcoatl-host-native-plan.md`
- Modify: `.opencode/plans/2026-11-24-quetzalcoatl-v2-architecture-and-plan.md`

- [ ] **Step 1: 落盘本计划；旧计划顶部加指向本计划的状态说明，Task 5.1 / 5.2 标注撤销，Step 3b 标注冻结，D-11、D-12、D-21、D-22、D-24 标注处置**

### Task 0.2：宪章修订

**Files:**
- Modify: `AGENTS.md`

- [ ] **Step 1: 第 5 节最前加入 000 号铁律与海/浪判据；第 1 节冷启动清单加入两份依据文档与本计划；第 4、5 节撤掉移动端内嵌引擎条款并写入 P3、P5；第 6 节的 12、15、16 标注冻结或撤销（保留原文）**

### Task 0.3：定位文档对齐

**Files:**
- Modify: `README.md`、`docs/ARCHITECTURE.md`、`docs/USER_SCENARIOS.md`

- [ ] **Step 1: 改写定位段；`docs/USER_SCENARIOS.md` 第 6 节记下拍板结果**
- [ ] **Step 2: 运行验证命令，全绿后提交**

---

## S1：封口

### S1 Contract

- **用户可见行为**：自家的对话入口不存在了。`qz` 没有对话子命令；Web 与 Linux 桌面端没有输入框和对话记录，只剩只读的检视视图。
- **功能性要求**：「拉起宿主当 Worker 并做洁净室验收」的能力完整保留在内部委派接口上。
- **为什么排在最前**：对话轮不仅违规，还绕过仲裁器直接写记忆图和快照；不先删，后面的数据面改造没有干净的起点。
- **验证命令**：全局门禁；Web 的 vitest 与 Playwright。
- **明确排除项**：macOS 与 Windows 的对话视图（不走守护进程、不随包发布，S5 处理）；治理面（S5）。

### Task 1.1：抽出验收链路

**Files:**
- Modify: `crates/quetzalcoatl-daemon/src/daemon.rs`、`crates/quetzalcoatl-daemon/src/local_ipc.rs`、`crates/quetzalcoatl-daemon/src/lib.rs`、`crates/quetzalcoatl-daemon/src/bin/qz.rs`
- Test: `crates/quetzalcoatl-daemon/tests/e2e_single_node.rs`、`crates/quetzalcoatl-daemon/tests/qz_open_and_no_model.rs`

**Interfaces:**
- Consumes: `handle_chat` 的 Worker 分支（只依赖请求里的任务描述与验收 DAG）。
- Produces: 委派接口（拟 `IpcRequest::DelegateRun` / `handle_delegate_run`）与一次性的、非对话的命令行入口（拟 `qz delegate`，不进快速开始）。

- [ ] **Step 1: 把依赖对话接口的用例改写为走委派接口：空跑校验被洁净室拦截、Worker 在独立 worktree 完成并签发验收标记、沙箱缺失时直接失败、Worker 跑在沙箱里、带工作区而未配模型时的报错**
- [ ] **Step 2: 运行测试确认红灯**
- [ ] **Step 3: 抽出委派处理函数与接口，登记命令行入口**
- [ ] **Step 4: 全门禁验证并提交**

### Task 1.2：删除对话轮

**Files:**
- Modify: `crates/quetzalcoatl-daemon/src/daemon.rs`（`handle_chat` 的 routine 分支、`execute_routine_gateway_turn`、`normalize_upstream_error_body`、`ChatRequest.thread_id`）、`local_ipc.rs`（`IpcRequest::Chat` / `IpcResponse::Chat`）、`bin/qz.rs`（`run_chat`、`send_single_chat_turn`、`USAGE_TEXT`）、`crates/quetzalcoatl-daemon/src/web_console.rs`（对话方法、假流式帧、白名单及其测试）

- [ ] **Step 1: 增加断言：对话接口与 `qz chat` 不再存在；Web 白名单拒绝对话方法**
- [ ] **Step 2: 运行测试确认红灯**
- [ ] **Step 3: 删除上述代码与只服务它的用例；`model_not_configured_error` 的文案不再指向 Web 控制台**
- [ ] **Step 4: 全门禁验证并提交**

### Task 1.3：删除输入框

**Files:**
- Modify: `surfaces/web/src/app.ts`、`surfaces/web/src/transport/client.ts`、`surfaces/web/src/transport/protocol.ts`、`surfaces/web/src/tiers`、`surfaces/linux/src/app.rs`、`surfaces/linux/src/views`
- Test: `surfaces/web/tests`、`surfaces/web/e2e`、`surfaces/linux/tests/dynamic_link_and_ui.rs`

- [ ] **Step 1: 改写用例：页面上不存在输入框与对话记录；只读检视视图可用**
- [ ] **Step 2: 运行测试确认红灯**
- [ ] **Step 3: Web 与 Linux 去掉输入框、对话记录、发送路径与三档切换，暂时只留检视视图**
- [ ] **Step 4: 全门禁、vitest、Playwright、Linux 无头冒烟通过后提交**

### Task 1.4：受管运行标记与配置隔离

**Files:**
- Modify: `crates/quetzalcoatl-harness/src/drivers/mod.rs`（`build_common_sandbox_env`）、`crates/quetzalcoatl-harness/src/gateway.rs`（`copy_and_strip_cred_dir`）
- Test: `crates/quetzalcoatl-harness/tests/harness_pitfalls.rs`

- [ ] **Step 1: 增加用例：受管运行的环境里带标记；复制出的宿主配置只含凭据白名单，不含用户层的钩子与已启用插件**
- [ ] **Step 2: 运行测试确认红灯**
- [ ] **Step 3: 注入标记；配置复制改为凭据白名单，存根设置由我们合成**
- [ ] **Step 4: 全门禁验证并提交**

### Task 1.5：文档同步

**Files:**
- Modify: `README.md`、`docs/ARCHITECTURE.md`、`docs/MIGRATION_V1_TO_V2.md`、`docs/USER_SCENARIOS.md`、`website/app`（安装页与首页文案）

- [ ] **Step 1: 删去对话命令与对话界面的描述；`docs/USER_SCENARIOS.md` 的现状栏与附录 C 更新**
- [ ] **Step 2: 文档门禁与官网单测通过后提交**

---

## S2：接上 Claude Code

### S2 Contract

- **用户可见行为**：安装的最后一步自动接上。之后正常启动 Claude Code：会话开始带入他的核心；每次提交带入相关往事；宿主压缩对话后核心还在；可以在对话里让模型查往事；状态栏有他的名字和状态；守护进程停了，Claude Code 照常工作。
- **功能性要求**：中性种子与旧快照迁移；宿主会话档位；召回地板；V1 导入映射；宿主会话 IPC；钩子、MCP、状态栏、接上、诊断五个子命令；Claude Code 插件包；安装器集成。
- **已核实的宿主事实**（Claude Code 2.1.332）：支持本地插件源与非交互安装；命令型钩子经标准输出注入上下文；压缩之前的钩子输出只会成为压缩指令，重贴核心必须挂在压缩之后。
- **验证命令**：全局门禁；新增的端到端测试。
- **真机验收**（动所有者机器前当场确认）：在所有者的开发机上装本冲刺的构建，用 `qz import-v1` 导入 V1 灵魂，接上其 Claude Code，问一件只有 V1 记忆里才有的事。
- **明确排除项**：任何写回（S4）；其它宿主（S9）；回环网关作为用户会话路径。

### Task 2.1：可以送进用户会话的内容

**Files:**
- Modify: `crates/quetzalcoatl-daemon/src/daemon.rs`（`default_seed_conscience`、快照加载处的迁移）、`crates/quetzalcoatl-ewave/src/assembler.rs`（`AssemblyRequest` 增加注入面档位）

- [ ] **Step 1: 用例：宿主会话档位的输出不含委派 Worker 的条款，也不要求可见标签；旧快照加载后种子被替换并重新签名**
- [ ] **Step 2: 确认红灯**
- [ ] **Step 3: 中性种子（用 `ConscienceManifest::sign_with_root` 重签）、迁移、档位**
- [ ] **Step 4: 全门禁验证并提交**

### Task 2.2：召回地板

**Files:**
- Modify: `crates/quetzalcoatl-ewave/src/assembler.rs`、`crates/quetzalcoatl-spine/src/store.rs`（`search_memories_fts`）、`crates/quetzalcoatl-daemon/src/daemon.rs`（`sync_imported_memories_into_ewave`）

- [ ] **Step 1: 用例：一句自然的中文或英文提问能召回正文里只含其中几个词的记忆；问题为空时不带往事；召回条数不超过上限；召回结果能回指到记忆条目**
- [ ] **Step 2: 确认红灯**
- [ ] **Step 3: 重写全文检索查询与触发兜底；图节点带记忆编号；空问题与上限**
- [ ] **Step 4: 全门禁验证并提交**

### Task 2.3：V1 导入映射

**Files:**
- Modify: `crates/quetzalcoatl-daemon/src/daemon.rs`、`crates/quetzalcoatl-spine` 的 V1 导入模块
- Test: 现有 V1 合成夹具

- [ ] **Step 1: 用例：V1 灵魂的自述进入身份与价值，关于用户的部分进入「关于我」层**
- [ ] **Step 2: 确认红灯**
- [ ] **Step 3: 实现映射；导入物一律不进核心层与底线**
- [ ] **Step 4: 全门禁验证并提交**

### Task 2.4：宿主会话接口

**Files:**
- Create: `crates/quetzalcoatl-daemon/src/host_sessions.rs`
- Modify: `crates/quetzalcoatl-daemon/src/local_ipc.rs`（新请求与响应、`IpcClient` 超时可配）、`daemon.rs`（分发）、`lib.rs`（导出）、`web_console.rs`（新方法不进白名单，并补进拒绝清单的测试）

**Interfaces:**
- Consumes: `ContextAssembler::assemble`、`Conscience::take_disclosures`。
- Produces: 拟 `HostSessionStart` / `HostPromptSubmit` / `HostTurnEnd` / `HostPostCompact` / `HostStatusLine` / `HostMcp`；会话登记表（每轮带入的条目编号）。

- [ ] **Step 1: 用例：会话开始返回核心；提交之前按提问返回往事并登记条目；压缩之后重新返回核心；读路径在全局状态锁被占用时仍在时限内返回；Web 调用这些方法被拒**
- [ ] **Step 2: 确认红灯**
- [ ] **Step 3: 实现模块与接口**
- [ ] **Step 4: 全门禁验证并提交**

### Task 2.5：钩子命令

**Files:**
- Create: `crates/quetzalcoatl-daemon/src/host_hook.rs`
- Modify: `crates/quetzalcoatl-daemon/src/bin/qz.rs`（拟 `qz hook`，登记进 `USAGE_TEXT`）

- [ ] **Step 1: 用例：各事件的输入输出符合宿主约定；守护进程不可达、超时、输入畸形时以成功码退出且无输出；见到受管运行标记立即退出**
- [ ] **Step 2: 确认红灯**
- [ ] **Step 3: 实现（用 `IpcClient::from_runtime_info`，不做状态探活）**
- [ ] **Step 4: 全门禁验证并提交**

### Task 2.6：MCP 命令

**Files:**
- Create: `crates/quetzalcoatl-daemon/src/host_mcp.rs`
- Modify: `crates/quetzalcoatl-daemon/src/bin/qz.rs`（拟 `qz mcp`）、`crates/quetzalcoatl-harness/src/mcp_bridge.rs`（宿主会话主体与显式工具白名单）

- [ ] **Step 1: 用例：工具清单只有「查往事」，不出现 Router 专用工具；守护进程重启后（令牌已变）调用仍然成功；召回有上限**
- [ ] **Step 2: 确认红灯**
- [ ] **Step 3: 实现标准输入输出的 MCP 循环与转发**
- [ ] **Step 4: 全门禁验证并提交**

### Task 2.7：插件包与接上命令

**Files:**
- Create: `packages/harness-enhancers/claude-code-plugin/`（插件清单、钩子表、MCP 配置）、`crates/quetzalcoatl-daemon/src/host_connect.rs`
- Modify: `crates/quetzalcoatl-daemon/src/bin/qz.rs`（拟 `qz connect`，含撤销）

- [ ] **Step 1: 用例：接上后本地插件源写在 `QUETZALCOATL_HOME` 下、钩子表里是 `qz` 的绝对路径；重复执行不重复写；撤销后宿主配置逐字节还原；宿主不存在时给出一句可执行的提示**
- [ ] **Step 2: 确认红灯**
- [ ] **Step 3: 实现（插件文件内嵌进 `qz`；改动前备份；用 `discover_coding_agents` 定位宿主）**
- [ ] **Step 4: 全门禁验证并提交**

### Task 2.8：诊断、状态栏与安装器

**Files:**
- Modify: `crates/quetzalcoatl-daemon/src/bin/qz.rs`（拟 `qz doctor`、`qz statusline`）、`scripts/install.sh`、`scripts/install.src.ps1`（并重新生成 `scripts/install.ps1`）
- Test: `scripts/tests/install_verify_sig.test.sh`

- [ ] **Step 1: 用例：诊断按宿主报告四项；状态栏只在用户没有自定义时写入；安装末尾接上失败不算安装失败；卸载先撤销；`qz up` 不再打印控制台地址**
- [ ] **Step 2: 确认红灯**
- [ ] **Step 3: 实现**
- [ ] **Step 4: 全门禁验证并提交**

### Task 2.9：端到端与真机验收

**Files:**
- Create: `crates/quetzalcoatl-daemon/tests/e2e_host_attach.rs`（含「假 Claude Code」夹具：按插件的钩子表依次触发钩子）

- [ ] **Step 1: 用例：开场带入、提交带入、压缩后重贴、守护进程停机时放行、受管运行里钩子不触发**
- [ ] **Step 2: 全绿后提交**
- [ ] **Step 3: 真机验收（当场授权）；更新 `docs/USER_SCENARIOS.md` 现状栏；升预发布版本**

---

## S3：数据面打底

### S3 Contract

- **用户可见行为**：没有新界面。写进去的东西从此靠得住。
- **验证命令**：全局门禁；写入后强杀进程重启仍在；清空快照后仅靠重放得到同一份良知；抹除后在本机数据库与已封存的数据包里都读不出正文；`ConscienceBench` 全绿。
- **明确排除项**：多设备（S6）；任何用户可见的写入口（S4）。

### Task 3.1：良知事件化与重放

**Files:**
- Create: `crates/quetzalcoatl-ewave/src/` 下的变更日志模块
- Modify: `crates/quetzalcoatl-ewave/src/arbiter.rs`、`crates/quetzalcoatl-daemon/src/daemon.rs`、`crates/quetzalcoatl-fabric/src/sync_actor.rs`（`ingest_packfiles_and_rehydrate` 之后重放）

- [ ] **Step 1: 用例：基线事件收编现有快照；放行的变更是一条同时带审计字段与增量的事件；清空快照后重放得到逐字节相同的良知与仲裁器状态（去重键、冷却历史）；信号与变更是两类事件；过期纪元的变更在重放时被丢弃；兼容已有的 V1 导入事件**
- [ ] **Step 2: 确认红灯**
- [ ] **Step 3: 实现；写入顺序为先追加事件再应用；放行后不整份重写快照**
- [ ] **Step 4: 全门禁验证并提交**

### Task 3.2：真删

**Files:**
- Modify: `crates/quetzalcoatl-crypto`、`crates/quetzalcoatl-spine/src/store.rs`、变更日志模块

- [ ] **Step 1: 用例：往事正文不出现在签名事件与数据包明文里；抹除后正文在本机与数据包中均不可恢复，签名链仍可验证**
- [ ] **Step 2: 确认红灯**
- [ ] **Step 3: 正文外置为每条一把钥匙的密文；抹除销毁钥匙并写一条可同步的事件；物化视图补删除**
- [ ] **Step 4: 全门禁验证并提交**

### Task 3.3：条目操作与提案扩展

**Files:**
- Modify: `crates/quetzalcoatl-ewave/src/conscience.rs`、`crates/quetzalcoatl-ewave/src/arbiter.rs`

- [ ] **Step 1: 用例：提案可带类别、话题、触发词、来源与操作类型（增改、失效、不主动提、抹除）；良知的增改失效都经封装方法**
- [ ] **Step 2: 确认红灯**
- [ ] **Step 3: 实现**
- [ ] **Step 4: 全门禁验证并提交**

### Task 3.4：相处记录与仲裁器的两个缺陷

**Files:**
- Modify: `crates/quetzalcoatl-daemon/src/host_sessions.rs`、`crates/quetzalcoatl-ewave/src/arbiter.rs`

- [ ] **Step 1: 用例：用户提交时开一条相处记录、回合结束时合上；受管运行的记录不计入独立证据；同一条目的第二次纠正被接受；修改预算按规则复位**
- [ ] **Step 2: 确认红灯**
- [ ] **Step 3: 实现**
- [ ] **Step 4: 全门禁验证并提交**

### Task 3.5：密钥离开快照

**Files:**
- Modify: `crates/quetzalcoatl-daemon/src/daemon.rs`（`PersistedSovereignState`）

- [ ] **Step 1: 用例：快照文件里不含根私钥、设备种子与纪元密钥；旧文件加载后自动迁移；日常验签只用公钥**
- [ ] **Step 2: 确认红灯**
- [ ] **Step 3: 实现**
- [ ] **Step 4: 全门禁验证并提交**

### Task 3.6：召回评测

**Files:**
- Create: 评测用例与报告（合成数据，中英文）

- [ ] **Step 1: 建立可复现的召回评测，出第一份基线数字，报告落盘到 `docs/bench/`**

---

## S4：写回回路

### S4 Contract

- **用户可见行为**：在 Claude Code 里说「记住……」，新开一个会话问得到；说「不对，应该是……」，旧的作废；说「别再提这个」，他不再主动提；说「凭什么」，看到上一轮带进去的条目与出处；开了无痕，这一段什么都不留。
- **实施前先验证**：宿主是否允许钩子给工具调用盖上「这是第几轮」的票据。不允许就退回到按会话的最近一轮关联。
- **验证命令**：全局门禁；端到端用例覆盖契约的每一句；`ConscienceBench` 里「工具输出夹带改写指令」的用例经真实接口重跑确认落不了库；模型自己调钩子冒充用户的用例被拒。
- **明确排除项**：后台反思（S8）；底线签署（S5）。

### Task 4.1：接通仲裁器与写工具

**Files:**
- Modify: `crates/quetzalcoatl-daemon/src/host_sessions.rs`、`crates/quetzalcoatl-daemon/src/host_mcp.rs`、`crates/quetzalcoatl-daemon/src/daemon.rs`

- [ ] **Step 1: 用例：记住、纠正、不主动提、抹除、凭什么、记了什么六个工具；每次只提交一条提案；纪元来自真实的租约**
- [ ] **Step 2: 确认红灯**
- [ ] **Step 3: 实现（写工具在宿主会话模块里直接调用 `evaluate_proposals`）**
- [ ] **Step 4: 全门禁验证并提交**

### Task 4.2：信任锚与防伪造

**Files:**
- Modify: `crates/quetzalcoatl-daemon/src/host_sessions.rs`、`crates/quetzalcoatl-daemon/src/host_hook.rs`、`packages/harness-enhancers/claude-code-plugin/`

- [ ] **Step 1: 用例：用户原话含意图时按显式信号计；模型自发或工具输出夹带时按不可信计；回合结束时与对话记录不符的信号被撤回；显式信号写不进核心层；模型经命令行调用我们的钩子被拒**
- [ ] **Step 2: 确认红灯**
- [ ] **Step 3: 实现**
- [ ] **Step 4: 全门禁验证并提交**

### Task 4.3：斜杠命令、无痕、披露出口与回执

**Files:**
- Modify: `packages/harness-enhancers/claude-code-plugin/`、`crates/quetzalcoatl-daemon/src/host_sessions.rs`、`crates/quetzalcoatl-daemon/src/host_hook.rs`

- [ ] **Step 1: 用例：无痕期间不登记、写工具拒绝、状态栏显示、可转正；目录标记文件（拟 `.quetzalcoatl-off-record`）进入即无痕；披露在下次会话开头出现一次后出队；回合结束时显示「记下 N 条」**
- [ ] **Step 2: 确认红灯**
- [ ] **Step 3: 实现**
- [ ] **Step 4: 全门禁验证、真机走查、提交、升预发布版本**

---

## S5：他是谁、我的底线、治理面

### S5 Contract

- **用户可见行为**：第一次在宿主里见面，他问几句就认识了；在治理面写下并签署自己的底线；能翻到他、他眼里的我、我们、往事；导出的包能在另一台机器上完整恢复。
- **验证命令**：全局门禁；Web 的 vitest 与 Playwright；导出后在空目录导入，良知逐项一致。
- **明确排除项**：macOS 与 Windows 的新功能。

### Task 5.1：初见与治理接口

**Files:**
- Modify: `crates/quetzalcoatl-daemon/src/host_sessions.rs`、`local_ipc.rs`、`web_console.rs`

- [ ] **Step 1–4: 首次会话开头的初见说明；只读与治理 IPC（列出与搜索往事、四页内容、条目动作、披露的证据链、设备、记录时间线）；Web 白名单同步**

### Task 5.2：Web 治理面

**Files:**
- Modify: `surfaces/web/src`

- [ ] **Step 1–4: 六页（他、我、我们、往事、设备、记录）；每条三个动作（改、不主动提、抹除）；没有输入框**

### Task 5.3：签署与口令

**Files:**
- Modify: `crates/quetzalcoatl-ewave/src/conscience.rs`（已有签名函数）、`crates/quetzalcoatl-crypto`、`web_console.rs`、`bin/qz.rs`

- [ ] **Step 1–4: 第一次签署时设口令，根私钥从此用口令包裹，只在签署与设备变更时解开（不加新依赖）；底线页写短句、输口令即签；命令行等价入口**

### Task 5.4：完整带走

**Files:**
- Modify: `crates/quetzalcoatl-spine/src/archive.rs`、`bin/qz.rs`

- [ ] **Step 1–4: 导出包含良知全部内容；新增导入命令并登记；导入可完整恢复**

### Task 5.5：其余拆除与桌面治理面

**Files:**
- Modify: `crates/quetzalcoatl-client-core`（删 `llm_stream_bridge.rs`）、`crates/bindings`、`surfaces/linux`、`surfaces/macos`、`surfaces/windows`

- [ ] **Step 1–4: 共享核心与绑定去掉对话流；Linux 改成与 Web 同构的治理面；macOS 与 Windows 删对话视图，只留能编译的治理外壳（以 CI 原生跑点为准）**

### Task 5.6：文档与官网

- [ ] **Step 1: README、架构、无障碍清单、官网文案同步；升预发布版本**

---

## S6：官方 Hub 与多设备

### S6 Contract

- **用户可见行为**：第二台设备扫码即到；丢了能一步切断；知道有新版。
- **验证**：两台真机完成配对、合盖后控制权转移、吊销、在一台上纠正的内容在另一台生效。
- **明确排除项**：V1 同步服务的下线（另议）。

- [ ] **Task 6.1**：删除 `hub/internal/llmproxy` 及其挂载、配置与文档。
- [ ] **Task 6.2**：Hub 部署包（编排文件、环境变量模板、隧道说明）；运行指标；元信息接口（最低客户端版本、公告）。
- [ ] **Task 6.3**：**生产部署（当场授权）**——与 V1 同步服务并存；走现有的 Cloudflare 隧道，地址发现的 UDP 端口直连公网；登录接 Causally；记录做法与回滚。
- [ ] **Task 6.4**：客户端内置官方 Hub 地址，可改；登录命令无参即官方。
- [ ] **Task 6.5**：良知跨设备——非控制设备只提交信号，持控制权的设备仲裁并写变更。
- [ ] **Task 6.6**：配对体验（新机显示码、旧机确认）；配第二台设备时给应急码；吊销；同步状态进状态栏。
- [ ] **Task 6.7**：升级提示与最低版本门控。

---

## S7：拍板到通知

- [ ] **Task 7.1**：审批端到端——权限请求进守护进程的待办队列，Linux 桌面通知带「同意、拒绝」，结果回写，运行继续；各端画好的假按钮接通或删除。
- [ ] **Task 7.2**：验收入口翻转——在宿主里用斜杠命令触发洁净室验收，回执回到对话里；S1 留下的命令行入口只保留给无人在场的场景。
- [ ] **Task 7.3**：受管运行的钩子换成 S2 的钩子命令，退役 `packages/harness-enhancers` 里的 node 脚本。

---

## S8：他自己的人生

- [ ] **Task 8.1**：不带界面的宿主运行器——沙箱、探索时零对外写、预算上限、受管运行标记。
- [ ] **Task 8.2**：节律调度——守护进程按 `crates/quetzalcoatl-kernel/src/heart.rs` 的节律在空闲时发起探索；治理面给预算与安静时段。
- [ ] **Task 8.3**：后台反思——对已登记的相处记录由宿主不带界面地跑一遍，产出写回提案，仍经仲裁器；核心层的多证据门槛从这里才真正运转。
- [ ] **Task 8.4**：他先开口——一天至多一件，在下次会话开头提一句，能关。
- [ ] **Task 8.5**：治理面新增「他最近」「我们」两页与迎合滑杆。
- [ ] **Task 8.6**：依据 S3 的召回评测，决定是否引入本机语义向量（届时重启端侧推理加载器）。

---

## S9：更多宿主与外面的进来

- [ ] **Task 9.1**：OpenCode、Codex、DeepSeek Harness 的接入；发现新宿主时通知一键接上；诊断里的接入表。
- [ ] **Task 9.2**：SayIt 自动合龙（需要 SayIt 仓库配合，跨仓改动另行确认）。
- [ ] **Task 9.3**：通用导入（宿主自带的规则与记忆、各家对话导出包、角色卡），每次导入可整批撤回；只读的外部笔记来源。

---

## S10：手机、群、团队岗位（只列方向，届时另行审批）

- 手机：推送里拍板、治理面、给手机宿主当数据源。
- 群：住在别人的 IM 里，我们只做加密、定序与控场。
- 团队共用的岗位 Agent：部署与托管流程。

---

# 第五部分：审视重点

1. **我们坏了不能挡路**。任何钩子路径上的超时、崩溃、畸形输入都必须放行。用例必须覆盖守护进程停机、全局锁被占用、令牌轮换三种情况。
2. **受管运行不得递归**。受管运行触发用户层钩子不仅会循环，还会让后台反思的输出被登记成新的相处记录，自产「独立证据」喂给核心层门槛。
3. **显式信号的伪造**。模型或被注入的内容可以自己调用钩子冒充用户。三道闸缺一不可（第三部分 3.6）。
4. **事件化一次定型**。信号与变更的分型、正文外置必须在 S3 定死；S6 做多设备时不得返工事件格式。
5. **订阅用户不被误伤**。用户会话不走回环网关；受管运行继续遵守宪章第 6 节的 1–4 条。
6. **文档门禁**。删文件、删子命令、加子命令都会触发 `scripts/tests/docs_links.test.sh`。

---

# 第六部分：冷启动交接

1. **必读**：`AGENTS.md`、本计划、`docs/ORIGIN_GOAL.md`、`docs/USER_SCENARIOS.md`、`docs/V2_GOAL.html`；已建成子系统的规范见旧计划第四、五部分。
2. **定位恢复点**：

   ```bash
   git status -s
   git branch -a
   git log -n 15 --oneline
   ```

   核对本计划中最后一个已勾选 `[x]` 的步骤与最新提交一致，先跑通上一个已完成 Task 的验证命令，再开始下一个未勾选步骤。
3. **不要续做旧计划的 Task 5.1 / 5.2**——它们已撤销。
