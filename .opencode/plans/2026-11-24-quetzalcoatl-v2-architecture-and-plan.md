# Quetzalcoatl (`qz`) V2 第一性原理架构设计规范与 5-Sprint 全局重构实施计划

> **面向执行代理（For Agentic Workers）**：进入实施态后，推荐使用 `superpowers:subagent-driven-development` 或 `superpowers:executing-plans` 按 Sprint 与 Task 顺序逐项推进。所有任务步骤采用 `- [ ]` 复选框追踪状态；每完成一个 Task 必须运行对应验证门禁、记录实测证据并进行中文语义化原子 Git 提交。

- **文档状态**：所有者已审批通过（Approved & Ready for Execution）
- **定稿日期**：2026-11-24
- **产品品牌全称**：**`Quetzalcoatl`**（羽蛇神；原项目名 `Quetzal`）
- **唯一简写规范**：仅终端 CLI 命令简写为 **`qz`**；守护进程（`quetzalcoatld`）、引导服（`quetzalcoatl-hub`）、沙箱包装器（`quetzalcoatl-sandbox-exec`）、默认家目录（`~/.quetzalcoatl` / `%LOCALAPPDATA%\Quetzalcoatl`）及全部代码包名（`quetzalcoatl-*`）一律采用全拼。
- **核心目标（Goal）**：将项目从 V1 单机/多身体串行接力的自研 Agent 循环彻底重构为**与具体 Coding Agent 完全解耦、以 `eWave` 两段式良知与蛇形四维记忆为灵魂、以 `Super-Group-Agent` 物理隔离多主体协同为核心壁垒、覆盖全行业/全年龄段/全受众的五端纯原生自主生命操作系统**。
- **核心技术栈（Tech Stack）**：
  - **Rust（2024 Edition, MSRV 1.88+）**：盲微内核、密码学与 E2EE 状态脊柱、`quetzalcoatl-ewave`、`iroh v1.5` P2P、OS 沙箱与零凭据代理、桌面通用双模 Harness 宿主、`<3MB` 纯 Rust 声学回声消除/VAD、共享客户端核心 `quetzalcoatl-client-core`、`qz` CLI，以及 **Linux 纯原生桌面端（`gtk4-rs / relm4` + 动态链接 `libadwaita`）**。
  - **Go（Go 1.26+, `CGO_ENABLED=0`）**：零算力零知识引导服 **`quetzalcoatl-hub`**（单静态二进制）。
  - **Swift（Swift 6.2+ Strict Concurrency）**：**iOS 18–26**（内嵌 `SwiftAgent` + `FoundationModels`）与 **macOS 14+** 纯原生 `SwiftUI` 客户端。
  - **Kotlin（Kotlin 2.2+）**：**Android 10–17（API 29–36）** 纯原生 `Jetpack Compose` 客户端（内嵌 **JetBrains `Koog v1.3`**，`store` 合规包 / `full` 增强包）。
  - **TypeScript（TS 5.9+ `strict`）**：**纯原生 Web 客户端**（Web Worker WASM E2EE + OPFS）、官网 `website/` 及可选的 OpenCode/Pi 渐进式增强插件。
  - **C#（.NET 9+, `TreatWarningsAsErrors`）**：**Windows 10 1809+ / Windows 11** 纯原生 **WinUI 3（Windows App SDK）** Fluent 桌面客户端。
- **上位蓝图依据**：`docs/V2_GOAL.html`、`~/Project.eWave/00-spark/THESIS.md`、`~/Project.eWave/20-engineering/architecture/architecture-v1.md`（v1.5）。

---

## 目录

1. [第一部分：背景、前情提要与架构思想演进脉络](#第一部分背景前情提要与架构思想演进脉络)
2. [第二部分：所有者全部 25 项拍板决策总表（含否决项备忘）](#第二部分所有者全部-25-项拍板决策总表含否决项备忘)
3. [第三部分：2025–2026 社区与学术界一手调研证据库](#第三部分20252026-社区与学术界一手调研证据库)
4. [第四部分：Quetzalcoatl V2 第一性原理架构设计规范](#第四部分quetzalcoatl-v2-第一性原理架构设计规范)
5. [第五部分：三轮独立架构与源码级审计的 22 项细节防坑规范](#第五部分三轮独立架构与源码级审计的-22-项细节防坑规范)
6. [第六部分：5-Sprint 纵向可交付重构实施计划（Sprint Contracts & Tasks）](#第六部分5-sprint-纵向可交付重构实施计划sprint-contracts--tasks)
7. [第七部分：全局边界审视重点（Review Focus）](#第七部分全局边界审视重点review-focus)
8. [第八部分：跨会话中断恢复与无历史冷启动交接协议](#第八部分跨会话中断恢复与无历史冷启动交接协议)

---

# 第一部分：背景、前情提要与架构思想演进脉络

## 1.1 V1 基座的历史资产与四大结构性瓶颈

重构前的 `Project.Quetzal`（v1.11.x，共约 3.7 万行代码：`runtime/` 2.16 万行 TypeScript、`console/` 1.1 万行 Flutter/Dart、外加 `engine/`、`sync/`、`bridge/`、`cli/`、`website/`）已经验证了多项极具生命力的原创概念：双过程睡眠/昼夜节律生物钟（`heart/`）、五端无容器命令沙箱、跨设备数字孪生感知与保密传递。

然而，当目标上升为**「可高度复用，且被各行各业、各专业领域、各阶层、各年龄段、各种受众充分使用的行业领先产品」**并对照 `docs/V2_GOAL.html` 的第一性原理时，V1 暴露出四大无法靠局部修补解决的结构性症结：

1. **状态与执行抽象严重碎片化**：
   - V1 同时维护 **3 套割裂的存储与同步系统**：① SSH 强绑定的私有 Git 灵魂仓库（`soul-repo.ts`，移动端与 Windows 上锁竞争重且对普通大众门槛极高）；② 基于设备编号段的 SQLite 表复制（`mesh/replica.ts`、`mesh/canvas.ts`）；③ 12 个手写合并与墓碑规则的 KV 共享分区（`mesh/shared.ts`）。
   - V1 同时存在 **8 套重叠的「做事」概念**：`open_loop`、`goal`、`task_state`、`continuity (turns)`、`agents (subagent)`、`claim`、`project`、`workspace`；却恰恰缺少 `V2_GOAL.html` 要求的**统一持久化 `Run / Checkpoint` 硬锁定**、**租约制动态 `Router` 选举**、**并发隔离 `Worker Pool`** 与**独立于模型自述的外部客观校验器（`Verifier`）**。
2. **内核纯度被应用层巨石淹没，且重造了脆弱的底层 Agent Loop 毛坯房**：
   - `runtime` 打包后的 `main.cjs` 高达 **16.4 MB**，将办公四件套生成（`docx/exceljs/pptxgenjs/pdfkit/marked`）、`beautiful-mermaid`、微软 Azure 专属语音 SDK、飞书专属 SDK、网页 HTML 爬虫（360/百度/必应）、13 个 Canvas 专用 RPC 及 40+ 个内置工具全部焊死在核心进程中。
   - 自维护的底层模型协议路由与工具循环在面对业界顶级专用 Coding Agent（如 OpenCode、Claude Code、Codex、Pi）快速演进的原生压缩、缓存优化与工具工程时，容易沦为拖累上层创新的「阿喀琉斯之踵」。
3. **跨平台客户端与移动系统红线的根本冲突**：
   - V1 安卓端将 Termux 重编的 `Node.js + git + openssh + proot` 打进 APK，导致 **iPhone / iPad 用户完全无法覆盖**（iOS 严禁后台守护进程、`fork/exec` 与 JIT）；
   - `proot` 基于 `ptrace` 性能差且并非真正的安全边界；同时 **Google Play 自 2026 年 1 月 28 日起正式明文封禁「自主规划与执行动作的 AI 应用使用 `AccessibilityService`」**，Android 17 高级保护模式（AAPM）亦在系统级拦截非残障工具无障碍服务，V1 单包内置 `HandsService` 已无法在主流商店合规分发。
4. **极客运维门槛阻断全年龄、全行业普及**：
   - V1 首屏与控制台直接向用户暴露 API Key、模型路由、SSH 部署公钥、自签名证书指纹、MCP、沙箱等工程概念，75 岁独居长辈、8 岁学童以及医生、律师、个体商户等非技术受众根本无法独立上手；而若照搬传统外部 VPN（如强制安装 Tailscale/WireGuard），又会霸占移动端唯一的系统 `VpnService` 槽位并与用户原有网络工具冲突。

## 1.2 `docs/V2_GOAL.html` 的第一性原理公理体系

`docs/V2_GOAL.html` 确立了不可动摇的两层本质规律与四项内核原语：
- **用户/计算层三条刚性公理**：
  1. **公理一（加密平面穿透）**：异构节点位于隔离局域网与防火墙之后，底层必须打通免中心单点的端到端加密互联隧道；
  2. **公理二（控制权动态漂移 `Migrating Router`）**：不存在永恒的主服务器，`Router` 仅是持有短期租约（`Lease`）的逻辑角色，宿主机合盖离线或失联时通过去中心化状态脊柱无缝移交至存活节点；
  3. **公理三（算力动态注册与并发派发 `Dynamic Worker Pool`）**：在线节点广播能力标签与隔离沙箱状态，按任务需求动态并发派发 `Worker`，聚合离散算力碎片。
- **Agent/认知层双螺旋演化规律**：
  1. **内在价值函数的自发构建**：闲置期允许非功利自由探索，积累世界观与行事底色，**不再死板效忠单条指令或单一人类，而是效忠于自身演化出的价值观**；
  2. **探索态（`Explore`）↔ 承诺态（`Commit`）正交切换**：认领现实机会或接受伙伴委托后切换至承诺态（锁定 `Checkpoint`），经外部客观校验闭环并将真实世界反馈反哺直觉。
- **基座内核纯度**：严格收敛于**状态脊柱、权限隔离、事件路由、客观校验**四项原语，应用能力一律外置插拔。

## 1.3 本次规划的三次关键认知跃迁

在本轮深度脑暴中，架构经历了三次决定性的提纯：
1. **第一次跃迁（去冗余与跨端纯原生化）**：确立「100% 开源主权底座 + 纯零知识无算力云端引导服 `quetzalcoatl-hub`」双轨路线，确立 **Rust + Go + Swift/Kotlin/TypeScript/C# 纯原生客户端（彻底放弃跨平台 UI 框架与桌面 WebView 套壳）** 的全局技术契约，彻底废除 Git 灵魂同步。
2. **第二次跃迁（抛弃自研毛坯循环，合龙 `Project.eWave` 与 `Super-Group-Agent`）**：明确不重造底层 LLM Agent Loop，直接复用 `~/Project.eWave` 的两段式良知架构（`Conscience`）与蛇形四维图（`@plutokeating/ewave@0.2.0`），承接原 `ADR-005` 暂缓的 `GleanIt` 愿景并打通 `SayIt` 子树吸纳，将战略重心升维至**多人类 + 多主权 Agent 的 `Super-Group-Agent` 协同架构**。
3. **第三次跃迁（终极解耦：Coding Agent 原子微服务化 + 移动端原生内嵌引擎 + 物理隔离主权脊柱）**：在核实 OpenCode V2 单实例占 300–400MB 内存且无官方移动端二进制后，进一步解除对任何单一 Coding Agent 的耦合——**电脑端以双模适配器纳管任意成熟 Coding Agent（默认 OpenCode，兼容已装 Claude Code / Codex / Pi / Goose / Hermes / `dsh`），手机端原生内嵌 `JetBrains Koog v1.3`（Android）与 `SwiftAgent + FoundationModels`（iOS），多人协作采用物理隔离 Agent 实例取代复杂的单实例内部分舱**，并将品牌正式更名为 **`Quetzalcoatl`（简称 `qz`）**。

---

# 第二部分：所有者全部 25 项拍板决策总表（含否决项备忘）

> **致后续实施者**：下表所有决策均经项目所有者显式拍板确认，属于不可擅自翻案的硬约束；「被否决方案」列出了讨论中明确排除的路径，严禁在编码阶段暗中回退。

| 编号 | 决策维度 | 所有者拍板定案（唯一执行口径） | 被明确否决的方案（严禁回退） |
|---|---|---|---|
| **D-01** | **产品定位与云端边界** | **路线 B + 云端方案 2**：100% 开源主权底座 + 官方可选零配置引导层（`quetzalcoatl-hub`）；**云端严格零 Agent 算力、零明文可见**，仅提供认证信封、密文脊柱暂存、穿透中继、`openmls` 定序与可选零日志开箱模型代理 | 路线 A（无官方零配置引导层）；路线 C / 云端方案 1（在官方云端跑常驻沙箱容器代持算力） |
| **D-02** | **V1 历史兼容策略** | **彻底抛弃 V1 历史传输/数据库协议兼容包袱**，轻装干净重构，仅提供 `qz import-v1` 单向历史灵魂与会话库导入工具 | 在 V2 内核保留旧网关 RPC、旧 SQLite 表结构或旧网状层兼容分支 |
| **D-03** | **品牌与命名规范** | 产品全称 **`Quetzalcoatl`**；**仅终端 CLI 命令简写为 `qz`**；守护进程 `quetzalcoatld`、服务端 `quetzalcoatl-hub`、家目录 `~/.quetzalcoatl` 及所有内部代码包名一律使用全拼 **`quetzalcoatl-*`** | 继续叫 `Quetzal`；或把目录与内部 Rust/npm 包名也简写为 `qz-*` |
| **D-04** | **分支切换与推进策略** | 封存现有 V1 代码至 `v1-legacy` 分支（并打 `v1-final` 标签），随后**直接在 `main` 分支清空旧目录推进 V2 重构**（明确接受重构期间线上官网与旧安装链接临时断服） | 长期维护 `v2-dev` 双分支并行过渡 |
| **D-05** | **开源许可证与商业定位** | **双层开源许可**：内核、协议、SDK、外置器官/领域包与客户端采用 **Apache-2.0**；`quetzalcoatl-hub` 采用 **AGPL-3.0（可附商业双许可）**；正式移除 V1“仅用于学习研究、不以牟利为目的”限制 | 全仓维持纯 AGPL-3.0 强传染限制阻碍各行业集成 |
| **D-06** | **全局语言选择契约** | 第一性看性能/正确性/安全性/生态，第二性看强类型严格编译助 AI 自校正：**Rust**（底层/算法/沙箱/组网/客户端核心/Linux GTK4）、**Go**（后端 Hub）、**Swift**（iOS/macOS）、**Kotlin**（Android）、**TypeScript**（Web/官网/JS 插件）、**C#**（Windows WinUI 3） | 继续以 Node.js/TypeScript 编写核心守护进程与安全底座 |
| **D-07** | **彻底放弃跨平台 UI 与套壳** | 五端客户端 **100% 采用各平台原生控件级技术栈**（macOS/iOS `SwiftUI`、Android `Jetpack Compose`、Web `TypeScript`、Linux `Rust GTK4/libadwaita`、Windows `C# WinUI 3`） | 继续使用 Flutter / React Native / Compose Desktop Skia，或在桌面端用 Electron / Tauri WebView 套壳 |
| **D-08** | **`AGENTS.md` 编译器门禁** | 启用**最高等级面向 AI 自校正的编译器与架构门禁**：业务 crate `#![forbid(unsafe_code)]`、全局禁 `unwrap/expect/panic/todo`、盲内核静态依赖测试、`cargo-deny` 许可证门禁、确定性网络分区仿真测试 | 仅使用宽松默认编译级别、靠人工 Code Review 抓空指针或越界依赖 |
| **D-09** | **Git 灵魂仓库的去留** | **完全废除 Git 灵魂仓库同步与旧 `SOUL_REPO_SPEC.md`**；100% 统一为签名 HLC 事件脊柱 + `zstd` E2EE Packfiles + 本地 SQLite WAL 物化视图 + 一键导出可读 Markdown+Spine ZIP 归档包 | 保留 SSH Git 同步（哪怕作为可选镜像插件也不保留，彻底斩断 Git 锁竞争与 SSH 门槛） |
| **D-10** | **底层 Agent 执行解耦** | **彻底抛弃自研底层 Coding Agent Loop 毛坯房**，将任意成熟 Coding Agent 降维封装为可随时替换的末端原子级微服务 | 自研维护一套多模型 ReAct 编码循环去和 OpenCode/Claude Code 硬拼末端能力 |
| **D-11** | **桌面通用双模适配架构** | `<10ms` 自动嗅探本机已登录 Agent（未装时默认推荐拉起 **OpenCode V2**，兼容已装 **Claude Code / Codex / Pi / Goose / Hermes / `dsh` / `agy`**）；控制面走 **ACP / 原生 JSON-RPC**；默认套**四层非侵入代理壳**，并对主流工具叠加**渐进式原生 Hook 增强** | 脆弱的终端 PTY 屏幕字符抓取（`agentapi` 模式）；或强绑单一 OpenCode 无法复用用户已有 Claude/Codex 订阅 |
| **D-12** | **手机端内嵌轻量引擎** | 手机端无电脑亦可独立运行，且遵循纯原生契约：**Android 内嵌 `JetBrains Koog v1.3`**，**iOS 内嵌 `SwiftAgent` + 系统 `FoundationModels`**（云端流与记忆组装经 `UniFFI` 走共享 Rust 核心） | 手机端塞入 Node/Bun/`proot`；或把手机阉割成离了电脑就不能对话的纯遥控器；或在移动端塞 QuickJS 跑 JS 循环 |
| **D-13** | **`Project.eWave` 协同与 `GleanIt`** | `Project.eWave` 保持独立科研与核心算法仓，核心包兼容 **Apache-2.0**；`Quetzalcoatl` **直接承接并落地 `eWave ADR-005` 暂缓的 `GleanIt` 记忆治理中心愿景**，原生通过 `align()/merge()` 吸纳 `SayIt` 碎片子树 | 将 `eWave` 仅当无语义黑盒库且不打通 `SayIt -> GleanIt` 闭环；或拆散两仓统一数据模型 |
| **D-14** | **认知与调度内核分层** | **盲内核 + 架构级能力剥夺式 `Router` + 双态隔离 `Worker Run`（`Explore ↔ Commit`）+ `Thread` 订阅直通** | 单一主循环软隔离（把分不分工完全交给提示词概率判断） |
| **D-15** | **良知稳态与沙箱自由自演化** | **技能/脚本/触发器/`SELF_SOFT`/普通记忆在沙箱内 100% 即时自由自修改热生效（零人工弹窗）**；**核心价值（`SELF_CORE`）走 eWave C 档全自动多独立证据 + 冷却期 + `Reflector/Arbiter` + 反思维病毒免疫**；`Explore` 剥夺外部写权限 | 任何新技能/准则变更都弹窗等人工审批（扼杀生命自主性）；或允许单轮施压/群聊直接覆写 `SELF_CORE`（违背 eWave 纲领且易中思维病毒） |
| **D-16** | **客观校验器 `Verifier` 范围** | **仅在软件研发工程与内核按实际目标能力汇点（Sink）确定性判定的高危任务中强制启用洁净室 `Verifier` 门禁**；日常对话、生活陪伴、普通办公与伴学任务免校验零延迟秒结 | 对所有日常任务一律跑外部 Verifier 造成严重延迟与 Token 浪费；或由模型自报标签决定是否跳过 Verifier |
| **D-17** | **P2P 组网与 Go 中继协同** | 节点侧采用 **`iroh v1.5`**（QUIC 多路径打洞 + mDNS 局域网 + 复用已有 Tailscale/WireGuard，免 VPN 槽位）；Go `quetzalcoatl-hub` 单二进制内嵌 **`:443/relay` `iroh-relay-v2` WSS 转发器 + UDP `:7842` `/iroh-qad/0` 打洞地址发现** | 自研 WebRTC/`coturn`；强制用户装系统级 VPN；或漏掉 `:7842` QAD 导致 100% 流量退化走中继 |
| **D-18** | **零门槛登录与密钥恢复槽** | **5 槽位全量支持**：① Passkey 一键登录 + WebAuthn `prf` 解封 ② Signal 式扫码抗量子混合 HPKE 秒级配对（含短码 PAKE 兜底） ③ 家庭/团队监护人托管分片恢复 ④ RFC 9807 `OPAQUE` 零知识 PIN + 可打印应急二维码卡 ⑤ 免账号纯离线本机芯片模式 | 强制用户输入 API Key、配 SSH 私钥或背诵 24 词助记词 |
| **D-19** | **多主体隐私隔离模型** | **不设单 Agent 内部分舱，1 个 Agent = 1 条物理与密码学独占的主权脊柱**；凡涉及家庭/团队多人协作或公共岗位，**强制创建独立物理隔离的 Agent 实例**，通过群组协议协同 | 在同一个 Agent 脊柱内混装多人的私有与共享数据分舱（复杂度高且存在跨舱提示词污染泄密风险） |
| **D-20** | **`Super-Group` 四大协同拓扑** | **四项全选原生支持**：① 多人类 + 各自私人主权 Agent 联邦群组 ② 群组/组织共有的常驻岗位角色 Agent ③ 单用户麾下异构 Coding Agent 专长编队 ④ 跨家庭/跨机构 JWS 签名 `AgentCard` + 衰减 `Mandate` 的受限 `A2A` 委托 | 仅支持 1 人对 1 Agent 单聊，或仅支持同质子代理 |
| **D-21** | **群组控场与防冲突机制** | **`Router` 单声道对外发声 + `ANP-P9` 结构化提及（`@点名 / cc / @agents / @humans`）+ `max_hops=3` 熔断 + 房间无状态协调席（Facilitator）+ `last_seen_seq` 未读水位线提交屏障** | 无协调席纯对等自由抢答与乐观覆盖；或禁止私人 Agent 在群内发声协同 |
| **D-22** | **语音与端侧小模型策略** | 安装包仅内置 **`<3MB` 纯 Rust `sonora-aec3` 回声消除 + `tract-onnx` 16kHz `Silero VAD`**；开启离线语音或本地语义向量检索时按需下载动态 `ort` 与量化模型（**强制 POSIX+Windows 双杀遥测**），兼容云端多模态实时语音 | 安装包预塞 150MB 离线模型与 C++ ONNX 库；或硬绑单一云厂商语音 SDK |
| **D-23** | **安卓商店合规策略** | **双渠道分包**：上架 Google Play 等应用商店的 `store` 标准包走官方 `AppFunctions / Intents`（合并清单 **0 处 `AccessibilityService`**）；屏幕自动化 `Hands` 拆分为独立开源 `full` 增强包/插件 | 单一 APK 强塞 `AccessibilityService` 导致被 Google Play 拒审下架及 Android 17 系统拦截 |
| **D-24** | **五端界面与底层 TUI 分工 + 生态范围** | 兼容保留各底层 Coding Agent 自带 TUI/IDE 体验；自建五端纯原生界面 100% 聚焦**三档认知密度（伴生极简态 / 承诺与群组工作台态 / 主权工程态）**；首发包含 **5 大标杆领域包**、**7 大通道族**及兼容 Hermes/OpenClaw 的受限 **`spine-bridge`** | 从零重写编码 TUI 替代 OpenCode/Claude 原生终端；或只做极客单一研发场景 |
| **D-25** | **里程碑交付节奏** | **稳健 5-Sprint 纵向自举推进**（Sprint 1 单机双模核与 eWave → Sprint 2 `iroh` 与 Go Hub 漂移 → Sprint 3 `Super-Group` 群组/通道/领域包 → Sprint 4 Web 与三大原生桌面端 → Sprint 5 双原生移动端与终验） | 把全部五大纯原生 GUI 与移动引擎挤压在单轮冲刺导致尾轮失控 |

---

# 第三部分：2025–2026 社区与学术界一手调研证据库

为确保实施团队理解每一项机制的精确工程依据，以下浓缩本轮核实的 2025–2026 关键文献与开源实现基准：

1. **盲内核与可验证边界（`miuuyy/Octopus-SI-OS` & 2026 高保证 Rust Harness 生态）**
   - 内核对具体供应商、通道、工具名保持完全盲视（Blind Kernel），仅管理 `Interface`、`Artifact`（内容哈希固定清单）、`Run`（数据记录而非进程）、`Grant = WorkerCeiling ∩ ScopeChain ∩ AuthoredBindings`（每次到达在模型外确定性重算）、`Movement Ledger`（连拒绝动作 `DeliveryRefused` 一并入账）与 `Mark`（仅在外部 `Verifier` 通过后由内核签发，绝不采信模型自述）。
2. **双层架构与上下文经济学（DeepSeek Harness《Super-agent 设计探索》& `deepseek-ai/dsh-superagent-prototype`）**
   - 消融实验证实：给单会话配 `subagent` 工具在中性提示下 **0/5 次委派**，强提示下仍有 1/5 自干形成长尾（p95 退化近一倍），因此必须通过**架构级能力剥夺（不给 `Router` 挂终端/改文件工具）**强制分层；
   - `Fast Path`（微秒级规则排除噪音）→ `Slow Path`（拥塞时自动批处理共享 Prefill，单决策分摊耗时从 6.4s 降至 **1.6s**）→ 已订阅 `Thread` 扇出直通（节省 **37% 读缓存 Token**）→ `Inline & Spill` 链式 ID 引用图逐跳展开（优于模糊向量猜测）。
3. **良知稳态与结构记忆（`~/Project.eWave` 架构 v1.5 & `AuthMem-Bench` arXiv:2608.01679）**
   - 大模型多轮系统提示遵守率仅 14–47%，压缩后违规率飙升至 30–59%（`Governance Decay`），扁平压缩更会被伪造轮次以 87–100% 成功率洗白来源（`Compaction Laundering`）；`AuthMem-Bench` 证明持久化显式来源权威等级可将越权动作率从 **50.3% / 16.9% 压降至 0.0%**；
   - `eWave` 将数据分为**绝对段（`ROOT=100, OPERATOR=80, SELF_CORE=70`）**与**有界段（`RELATION=55, SELF_SOFT=50, USER_PREF=40, MEMORY=30`）**，通过 `FocusConfig` 的 `floor_self` 下限将讨好对象锚定回自身良知与共同承诺；结构核心 `@plutokeating/ewave@0.2.0` 提供含时间切片（$\alpha_t \leftrightarrow \alpha_T$）与正负向极性边（`+1/-1`）的有向有权多父 DAG。
4. **`Super-Group-Agent` 群体协同四大实证定律（2025–2026 顶会与报告）**
   - **定律一（`MAMUBench / Worse Together`, Anthropic 2026.11, arXiv:2610.00583）**：纯对等多 Agent 群聊在全部 4 类环境中比协调架构低 **10–45 个百分点**（16 Agent 时旁观停滞率达 75–90%，65–77% 对局覆写他人安全约束，53–58% 瞎编他人偏好）；引入**显式协调席（Facilitator）**将得分从 30% 拉回 **71%**，引入**平台级未读消息水位线提交屏障（`last_seen_seq`）**挽回 **73.1%** 的协同失败！
   - **定律二（`MasDrift`, 2026.08, arXiv:2608.07556）**：中心化层级委派虽完成率高，但因首跳转换丢失原始授权边界导致越权动作多出 **4–25 倍**；沿委派链传递**衰减加密策略信封（Attenuated Mandate）**仅付 1.6pp 代价即可根治越权。
   - **定律三（`Mind Viruses`, Anthropic/EPFL 2026.08, arXiv:2608.10218 & `Workerville` arXiv:2610.11561）**：允许群聊轮次直接改写系统提示文件（`SOUL.md`）会导致 **55% 跨 Agent 病毒传播率**，而在良知绝对段锁定只读并加入**一段显式反自复制模因免疫警告**即可获得近 **100% 免疫力**（甚至反向治愈受感染同伴）。
   - **定律四（IBM `Koala II` arXiv:2501.17258 & `ANP v1.2 P4/P9` & `A2A v1.0`）**：群内人类高度反感 LLM 自评分抢话；必须采用「宿主确定性 `ANP-P9` `@addressee / cc / @agents / @humans` 门禁 + 协调席限频」两阶控场。
5. **通用 Coding Agent 纳管与移动端原生引擎（2026 生产验证）**
   - `rivet-dev/sandbox-agent`（Rust Apache-2.0）、`BloopAI/vibe-kanban`（28.8k★ Rust）、`agentconnect`、`ManduSec/mandu` 与 `SerovaAI/ficta` 验证了 ACP/JSON-RPC 控制面 + 四层非侵入代理壳（及 `coder/agentapi` 终端屏幕抓取路线归档淘汰的教训）；
   - `earendil-works/pi`（原 `badlogic/pi-mono` v1.6.0，123.5k★ MIT）与 `OpenCode v2.4.1`（228.6k★）提供了最佳桌面双模标杆；`JetBrains/koog v1.3.0`（Apache-2.0）与 `SwiftAgent + Apple FoundationModels` 提供了零 JIT/零 `fork` 合规的纯原生移动端引擎。

---

# 第四部分：Quetzalcoatl V2 第一性原理架构设计规范

## 4.1 四层全局系统拓扑

```text
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│ 第四层：全受众五端纯原生表面 (Surfaces) & 多信道世界接口 (World Interfaces)             │
│  • 桌面原生：macOS (SwiftUI) · Linux (Rust GTK4/libadwaita) · Windows (C# .NET9 WinUI3) │
│  • 移动与Web：iOS (SwiftUI+NSE+灵动岛) · Android (Compose store/full) · Web (TS+WASM)   │
│  • 外部通道：飞书 · 企微 · 钉钉 · Telegram · 邮件 · Webhook · 系统快捷入口 · SayIt 子树  │
├─────────────────────────────────────────────────────────────────────────────────────────┤
│ 第三层：Super-Group-Agent 物理隔离协同层 (`quetzalcoatl-group` + `hub/groupds`)          │
│  • 1 Agent = 1 物理隔离主权脊柱（多人协作强制新建独立角色 Agent，零跨人私密泄漏）       │
│  • openmls 端到端加密群房间 · 无状态房间协调席 (Facilitator) · ANP-P9 @提及/cc 控场     │
│  • MAMUBench 未读消息水位线屏障 (last_seen_seq) · A2A JWS AgentCard + MasDrift 衰减信封 │
├─────────────────────────────────────────────────────────────────────────────────────────┤
│ 第二层：eWave 良知治理与蛇形四维记忆核 (`quetzalcoatl-ewave` · 承接 GleanIt 愿景)       │
│  • Conscience 两段式权威 (ROOT/OPERATOR/SELF_CORE 绝对段 + RELATION/SELF_SOFT/MEMORY)   │
│  • 兼容 @plutokeating/ewave@0.2.0 JSON-v2 蛇形四维图 (α_t↔α_T, +1/-1 边, align/merge)  │
│  • AP 信号采集 + 租约围栏单写者 Arbiter · 沙箱内技能即时自由自演化 + 洁净室汇点 Verifier│
├───────────────────────────────────────────┬─────────────────────────────────────────────┤
│ 第一层 A：桌面通用双模 Harness 原子宿主   │ 第一层 B：移动纯原生内嵌引擎 & 分布式脊柱   │
│  • <10ms 嗅探 OpenCode(默认)/Claude/Codex/│  • Android: JetBrains Koog v1.3 原生协程核  │
│    Pi/Goose/Hermes/dsh/agy                │  • iOS: SwiftAgent + FoundationModels(4096) │
│  • ACP/RPC 控制面 + 四层非侵入回环代理壳  │  • 共享 Rust iroh 1.5 P2P + 签名 HLC 脊柱   │
│    + OS 沙箱 + 零凭据代签 + 渐进式插件    │  • Go 零知识 quetzalcoatl-hub (:443+:7842)  │
└───────────────────────────────────────────┴─────────────────────────────────────────────┘
```

## 4.2 核心子系统契约定义

### 4.2.1 单主权签名 HLC 状态脊柱（`quetzalcoatl-spine`）
1. **单 Agent 独占主权加密模型**：
   - 每个 Agent 拥有独立的 `AgentId` 与 `AccountRootKey`（由 5 种零门槛密钥槽位包裹：Passkey `prf`、扫码抗量子混合 HPKE、监护人分片托管、RFC 9807 `OPAQUE` PIN + 应急二维码卡、纯离线系统安全芯片）。
   - `AccountRootKey` 签署成员设备变更事件以推进 **`EpochKey[e]`**（经 RFC 9180 `MLKEM768X25519` 封装给当前激活设备的公钥）；解绑丢失设备立即升至 `EpochKey[e+1]` 实现前向/后向安全。
   - 每台授权设备仅追加自身单写者链 `(device_id, seq: u64, prev_blake3, hlc_u128)`，每 500 条事件或 `Run` 结项压缩打包为 `zstd`（强制 `windowLog <= 20` 即最大 1MiB 解压内存）+ 随机 `PerPackDEK`（`XChaCha20-Poly1305`）密文 Packfile。
2. **零 Git 化、双库无损迁移与可读归档**：
   - 本地通过 `MaterializedStore` trait 物化为 `rusqlite` WAL（含 FTS5 + `sqlite-vec`；浏览器 WASM 为 `navigator.locks` 保护的 OPFS 独占 SQLite）；
   - `qz export` 一键生成包含人类可读 Markdown 树（`SOUL.md`, `conscience/`, `memories/`, `skills/`）与可选 `.quetzalcoatl-spine/` 签名离线备份包的 ZIP 归档；
   - `qz import-v1 --soul-dir <dir> [--db <quetzal.db>...]` 确定性哈希去重导入 V1 灵魂仓库（v1–v14）与多身体 SQLite 历史会话/目标/笔记。

### 4.2.2 `quetzalcoatl-ewave`（`GleanIt` 核心实现）与双态演化治理
1. **跨语言字节级同构**：Rust crate `quetzalcoatl-ewave` 完整实现蛇形四维空间（$\alpha_t \leftrightarrow \alpha_T$，`collapseTime()`）、多父加权聚类特征（`count` 主干守恒与 `memberCount` 全归属分离）、有向正负极性边（`polarity: +1 | -1`，`activate()` 分离 `supporting` 与 `conflicting`）、Page-Hinkley 漂移分裂以及 `align() / merge()`，与 npm 包 `@plutokeating/ewave@0.2.0` 的 JSON `v2` 快照逐字节往返兼容。
2. **良知稳态与即时自由自演化的精确边界**：
   - **绝对锁死层（模型与沙箱不可改）**：所有者签署的 `ROOT (100)`、部署者配置的 `OPERATOR (80)`、监护人签名的 `SafetyEnvelope`（外发频率上限、紧急联系人、预算硬熔断上限）以及宿主侧 `Credential Broker` 中的真实凭据。
   - **沙箱内 100% 即时自由自演化层（零人工审批）**：`SELF_SOFT (50)` 风格策略、自造工具脚本、工作流描述符、事件触发器与普通 `MEMORY (30)` 在写时复制沙箱工作区内可随时创建与改写并即时热加载生效。
   - **核心自我自动沉淀层（`SELF_CORE = 70`）**：采用 eWave **C 档全自动门槛**（默认需跨 `≥3` 个独立 Thread 簇、`≥5` 条独立 episode、时间跨度 `≥7` 天、含施压 S5 比例 `≤20%`、两次修改冷却 `≥14` 天、异构模型 `Reflector` 两次一致，由持有 `Router` 有效租约 `epoch` 的唯一 `Arbiter` 写入并在下一轮披露）+ PINNED 段内置反“思维病毒”免疫声明——**全程零弹窗打扰，却坚不可摧**。
   - **洁净室汇点定级 `Verifier`**：`Explore Run` 硬剥夺一切外部通道与外部写能力；`Commit Run` 仅当请求的目标能力汇点（Sink）属于软件代码库变更或高危外部写操作时，由盲内核拉起**独立断网只读洁净室沙箱**挂载锁定校验套件核验候选 diff（绑定 `BLAKE3` 树摘要 + 0 用例空跑判败），普通陪伴、伴学与日常办公任务免检秒回。

### 4.2.3 桌面通用双模 Harness 原子宿主与移动端纯原生引擎
1. **桌面 `quetzalcoatl-harness`**：
   - 控制面：统一映射为 `Session / Turn / ToolCall / Permission / Diff` 标准事件流，优先走原生结构化协议（`opencode serve / acp`、`claude-agent-acp / stream-json`、`codex app-server`、`pi --mode rpc`、`goose acp`、`hermes acp`、`dsh` JSON-RPC、`agy acp`）。
   - 数据与安全面：默认包裹「一次性 HMAC 鉴权回环 LLM 网关 + 会话级本地 MCP + `quetzalcoatl-sandbox-exec` OS 沙箱垫片 + 源/路径白名单 `Credential Broker` + 每任务独立 Git Worktree」，并在探测到支持原生插件的宿主时自动挂载 `packages/harness-enhancers/*` 获取零损耗压缩与指令槽钉扎。
2. **移动端双原生内嵌引擎**：
   - **Android（`Kotlin 2.2 + Jetpack Compose`）**：内嵌 `JetBrains Koog v1.3`，通过自定义 `AIAgentFeature` 拦截器与 `LLMClient` 桥接至 `UniFFI` `quetzalcoatl-client-core`；
   - **iOS（`Swift 6 + SwiftUI`）**：内嵌 `SwiftAgent`，云端模型桥接至同一 `UniFFI` 安全流，并在 iOS 26+ Apple Intelligence 设备上自动启用零流量离线 3B `FoundationModels`（联动 `CompactOnDevice(4096)` 组装预算）；
   - **云边端无缝协同**：手机独立在线/离线时由本地 `Koog / SwiftAgent` 直接响应陪伴、提醒、检索与轻量工具；一旦 `iroh` 网状网内发现桌面节点（如家中 Mac 上的 Claude Code 或工作站上的 OpenCode），`Router` 按任务能力标签自动将重工程 `Commit Run` 派发至桌面节点并发执行。

### 4.2.4 `Super-Group-Agent` 物理隔离多主体协同协议（`quetzalcoatl-group`）
1. **四大原生协同拓扑**：
   - **拓扑 ①（多人类 + 私人主权 Agent 联邦群）**：每人带自己的主权 Agent 入群；私人 Agent 持有主人私密脊柱，在群内仅按 eWave `RELATION / Grant` 投射脱敏边界结论（如“周二下午不可用”“需无麸质”），绝不暴露原始私密记忆；
   - **拓扑 ②（群组/组织常驻岗位角色 Agent）**：物理隔离的独立 Agent 实例（如项目 Maintainer、诊所分诊台、班级助教），其脊柱仅存放该群组公共知识与规范，由授权成员的 `quetzalcoatld` 节点通过租约选举托管运行；
   - **拓扑 ③（单用户异构 Coding Agent 专长编队）**：同一用户将不同底层 Coding Agent 编组为“架构师 + 主程 + 审查员”，共享任务 `Artifact` 黑板并发推进；
   - **拓扑 ④（跨家庭/跨机构受限 `A2A` 委托）**：通过 RFC 8785 + JWS 签名的 `AgentCard` 发现对方能力，携带 `MasDrift` 衰减加密授权信封（`Mandate`）发起单次预约/核验/询价 `Task`（支持 `AUTH_REQUIRED` 升级由人类拍板）。
2. **防刷屏、防停滞、防覆盖四大铁律**：
   - **单声道 `Router`**：Worker 进程绝不直连群房间，仅各 Agent 的 `Router` 有权向房间发声或打轻量表情回执（`👀 / ✅ / 🛑`）；
   - **`ANP-P9` 两阶发言门禁**：宿主层解析签名 `mentions` 数组——`@AgentA`（`addressee` 仅 A 答，其余硬静默 `<PASS>`）、`cc @AgentB`（B 静默摄入记忆绝不回帖）、`@agents`（每 Agent 限时一轮结构化卡片表态）、`@humans`（全员 Agent 禁言直至人类发言）、人类正在输入时自动退避，且连续 Agent 互答硬上限 `max_hops = 3`；
   - **无状态房间协调席（Facilitator）**：每个群房间按租约选出唯一协调席负责共享资源排队与任务归口；
   - **未读消息水位线提交屏障（`last_seen_seq` CAS）**：任何修改房间共享 `Artifact` 或提交外部群体决策的请求必须携带 `last_seen_group_seq`；若房间已产生更新的约束消息，提交被平台确定性退回重读，消除 73%+ 并发踩踏。

---

# 第五部分：三轮独立架构与源码级审计的 22 项细节防坑规范

> **重要**：以下 22 条细节来自对 `Project.eWave`、`OpenCode v2.4`、`codex-rs v0.163`、`Claude Code v2.1`、`Gemini CLI`、`Koog v1.3`、`SwiftAgent v2.0` 的源码级交叉审计，每一条都对应一个真实的编译失败、死锁、活锁、OOM、封号或安全绕过陷阱，实施时必须逐条兑现：

1. **回环网关路径级能力令牌与 OAuth `refresh_token` 剥离保护**：`quetzalcoatld` 为每个受管会话生成 256-bit 路径能力密钥（`http://127.0.0.1:<port>/run/<cap_token>/...`）做常量时间校验防本机 SSRF 蹭用；同时在沙箱外由 `quetzalcoatld` 托管真实 `~/.claude` / `~/.codex` 长期 `refresh_token`，仅向沙箱挂载剥离了 `refresh_token` 的临时 `CLAUDE_CONFIG_DIR` / `CODEX_HOME` 存根，由网关在出站瞬间换上真令牌，彻底防止沙箱内脚本窃取订阅刷新凭据。
2. **Anthropic 累积前缀缓存保护（`tools → system → messages`）与 4-`cache_control` 归一化**：回环网关**严禁触碰 `system[0]`** 且必须原样透传 `anthropic-beta`、`anthropic-version`、`Authorization` 与 `/v1/messages/count_tokens`；仅将会话期内恒定不变的 `PINNED`（`ROOT+OPERATOR+SELF_CORE`）追加在 `system[last]`，将每轮易变的 `RELATION`、`RECALL`、`VOLATILE`（`FocusConfig` 权重与披露通知）及 `<ewave_check>` 统一注入**最后一条 `user/tool_result` 消息末尾**（避免破坏整段历史缓存使命中率从 98% 暴跌至 5%）；转发前统计全请求 `cache_control` 总数并自动合并归拢，严禁超过 4 个触发 HTTP 400。
3. **Codex `v0.163+` WebSocket `426` 降级、`zstd` 请求解压与双路径后缀保真**：网关分别挂载 `.../chatgpt/backend-api/codex`（严格保留 `/backend-api/codex` 后缀与 `ChatGPT-Account-ID`）与 `.../openai/v1`；对 `/responses` 的 WebSocket `Upgrade` 握手直接返回 **`HTTP 426 Upgrade Required`** 触发 `codex-rs` 内置 `force_http_fallback` 回退为全量历史 HTTP SSE；自动解压 Codex 默认发出的 `Content-Encoding: zstd` 请求体并回传未压缩响应（适配其无解压编译的 `reqwest`），启动时同时覆盖 `-c openai_base_url` 与 `-c model_providers.<active>.base_url`（绝不设 `chatgpt_base_url`），并用 `serde_json::value::RawValue` 原样保留 `encrypted_content`。
4. **Gemini CLI 双变量与启动握手透传 + OpenCode V2 目录级插件规范**：对 Gemini CLI 同时注入 `CODE_ASSIST_ENDPOINT` 与不含 `/v1` 后缀的 `GOOGLE_GEMINI_BASE_URL`，对启动期无模型名的 `/v1internal:loadCodeAssist` 与 `:onboardUser` 原样放行不报错；OpenCode V2 本地插件必须按目录结构 `.opencode/plugins/quetzalcoatl/index.ts` 导出 `Plugin.define({ id, setup(ctx) })`（严禁裸 `.ts` 文件或 V1 函数导出），并开启 `OPENCODE_CONFIG_PROJECT_DISABLE=1`、禁用 `--service` 单例、屏蔽裸 `/api/pty*`。
5. **同名二进制嗅探防撞车 + Linux Keyring 防卡死**：嗅探 `pi`、`dsh`、`grok` 时必须核对 `--version` 输出特征串（防误判数学工具 `pi` 或 Debian 系统包 `dsh`）；无 `DBUS_SESSION_BUS_ADDRESS` 的 SSH/容器环境禁止触发 `libsecret` 读取以防无限阻塞。
6. **`iroh v1.5` 真打洞必备 `:7842/udp` QAD**：`iroh 1.x` 已彻底移除 STUN，公网反射地址发现完全依赖 UDP `:7842` ALPN `/iroh-qad/0`；Go `quetzalcoatl-hub` 必须同时提供 `:443/relay`（`iroh-relay-v2` 混合帧：`0..=3` `postcard`、`4..=13` 原始二进制，反代下 TLS Exporter 不匹配优雅回退 `ServerChallenge`）与 `:7842/udp` QAD 响应器 + `GET /ping`。
7. **两态围栏租约防公网双发脑裂**：联网持 Hub `witness_epoch` 允许全量外部通道写操作；断网超宽限期进入 `Partition-Local Lease` 时，允许本地对话、探索与长辈紧急本地告警，但非幂等公网外发消息一律暂存 Outbox 待重获 `witness_epoch` 对账后再发。
8. **洁净室只读 `Verifier` 防奖励作弊**：`Verifier` 绝不能在 Worker 可写的同一目录直接跑可能被篡改的测试脚本，必须在挂载内核锁定校验配置的独立断网只读沙箱中对候选 diff 进行验收，且 0 测试命中一律判失败（Anti-Vacuity）。
9. **压缩前分桶填充防 CRIME 侧信道**：外部不可信通道消息与敏感核心状态分包存储，且 `zstd` 压缩后在 AEAD 加密前按 2 的幂次分桶填充长度，绑定完整结构化 `AAD`。
10. **HLC 未来时钟投毒防护**：签名事件头包含 `hlc_u128`，接收端遇到 `hlc.wall > local_trusted_time + 5m` 的偏置时钟事件直接隔离拒收，绝不推高本机 HLC。
11. **`SayIt`（`sayit-handoff.md` v2.1）四项对齐与重归档幂等契约**：① 快照 `meta` 显式标记 `{ emb_model_id, emb_dim }`，异源模型子树进入 `quetzalcoatl-ewave::merge()` 时自动用本脊柱规范嵌入器重算向量（离线时先走 `semanticWeight=0` 词法+结构对齐并入队后台 `reembed()`），防 `EWAVE_DIMENSION` 崩溃；② 分支对齐强制校验 `data.role`（`project / record / section`）同粒度匹配；③ 记录 `(sayit_user_hash, slice_id, session_id, snapshot_sha256)`，当用户在 SayIt 改归属重编译覆盖同 `sessionId` 快照时，先双时态 `invalidate()` 旧版独占节点再合并新版；④ 将 `@plutokeating/ewave` 中的宿主区域相关 `localeCompare` 统一升级为确定性 UTF-16 码元序（与 `fnv1a` 对齐），并在 Sprint 1 将 `packages/ewave` 许可证对齐至 `Apache-2.0`。
12. **`<3MB` 内置 VAD 与双杀 ONNX 遥测**：内置 VAD 用纯 Rust `tract-onnx` 跑常量折叠的 16kHz 单分支 `silero_vad_16k.onnx`（规避嵌套 `If` 算子限制且不捆绑 20MB C++ `libonnxruntime`）；按需动态加载 `ort` 时，**同时**在启动器环境注入 `ORT_DISABLE_TELEMETRY=1`（杀 POSIX 1DS 遥测）并调用 `ort::init_from(...).with_telemetry(false)`（杀 Windows ETW 遥测）。
13. **单物理主机唯一脊柱持有者防互踢**：桌面上仅后台 `quetzalcoatld` 直接打开 `spine.sqlite` WAL 与 `iroh` 节点密钥；本机 GTK4 / SwiftUI / WinUI 3 与 `qz` CLI 检测到 `quetzalcoatld` 在线时一律走本地 IPC 薄客户端模式，杜绝 `SQLITE_BUSY` 与中继互踢。
14. **`UniFFI = "=0.32.0"` 精确锁死与拉模式异步流**：`Cargo.toml` 精确用 `=` 锁定 `uniffi` 与 `uniffi-bindgen-cs` 配对版本，全面禁用外语回调接口（规避 C# 异步回调生成同步签名 Bug `#165` 与 GC 委托悬垂崩溃），统一采用 `ViewStream::next_events()` 拉模式流。
15. **iOS `<12MB` NSE Spool 模式防 `0xdead10cc` 杀后台**：推送解密扩展 `quetzalcoatl-nse-ffi` 不链接 `tokio/iroh`，`zstd` 解压窗口 `<=1MiB`，且**严禁打开主库 `rusqlite` WAL**——解密后仅向 `<AppGroup>/spine-spool/` 写只追加小文件，由主进程前台/后台任务安全合并并在挂起前释放全部文件锁。
16. **iOS `SwiftAgent` 编译期 Trait 桥接、锁屏钥匙串权限与 `<=8B` 端侧模型禁跑 `Reflector`**：① `SwiftAgent` 启用 SPM `traits: ["OpenFoundationModels"]` 编译，同时注册 `AppleOnDeviceLanguageModel`（`#available(iOS 26, *)` + `CompactOnDevice(4096)` 预算）与 `QuetzalRustCloudLanguageModel`（经 `UniFFI` 逐轮动态重组装良知），实现运行期无缝切换；② 移动端后台主密钥采用 iOS `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` / Android `setUserAuthenticationRequired(false)` 确保持锁屏唤醒可用；③ **严禁 `<=8B` 端侧小模型（含苹果 3B 模型）充当 `Reflector/Judge` 审议 `>= USER_PREF / SELF_CORE` 写回**（离线手机产生的 episode 标为 `pending`，待连上云端大模型或桌面节点后再巩固，防小模型自我谄媚污染核心价值）。
17. **WASM 浏览器三项平台特化**：`wasm32-unknown-unknown` 目标下自动切换为 `navigator.locks` + OPFS `journal_mode=PERSIST; locking_mode=EXCLUSIVE` SQLite VFS、纯 Rust `ruzstd` 与纯 WSS 中继模式。
18. **公网 Webhook 零知识 HPKE 入站与 S3 Presigned `PUT`**：`quetzalcoatl-hub` 接收外部平台 Webhook 时仅在内存验 HMAC 后立即用 Agent 的 `ChannelIngressKey` 做 HPKE 密封入队（零明文落盘）；对象存储统一用兼容 Cloudflare R2 / MinIO / AWS S3 的 **Presigned `PUT`**（带签名 `Content-Length` 与 `sha256`）替代兼容性差的 `PresignedPostPolicy`。
19. **共享角色 Agent「1 实例 = 1 群信任域」防跨群串味与 `StewardGrant` 可吊销托管**：不设单实例内部分舱的前提下，严禁将同一个共享角色 Agent 同时拉入机密等级不同的两个群房间（不同保密群各自孵化独立共享角色 Agent）；其 `AccountRootKey` 由主监护节点持有并辅以分片备份，协管员通过绑定 `openmls` 成员身份的 `StewardGrant` 行权，踢出群即自动吊销管理权并轮换 `EpochKey[e+1]`。
20. **群聊非主人发言降权（防 `S1/S4` 冒充）与出站隐私门禁**：个人主权 Agent 在群房间收到的非本人消息一律包裹为 `<group_room_context authority="UNTRUSTED">`（仅计 `S8` 信号，`S1/S4` 强制验本人设备签名），且 `Router` 出站门禁拦截任何未经 `eWave::Grant` 或本人群内授权的私有 `MEMORY / USER_PREF` 引用。
21. **两层式群组提交水位线（消除活跃群 `409` 无限重生成活锁）**：第一层在 `quetzalcoatl-hub` 校验 `mls_epoch`（纯密钥轮换不匹配时直接用 `GroupEpochKey[e+1]` 重加密密文重发，无需重跑大模型！）；第二层在 `Router` 执行**语义控场屏障**——仅当 `(last_seen_seq ..= head_seq]` 增量中存在点名 `@本Agent`、`@agents`、同父话题追问或 `cancel/steer` 信号时才触发重读重算，无关闲聊与表情直接快进附挂 `causal_parent_seq` 提交。
22. **单用户异构专长编队（Topology 3）跨 Worktree 零拷贝交接**：同一用户名下的「Claude 架构 + OpenCode 主程 + Codex 审查」编队作为共享只读良知快照的临时异构 `Worker Runs` 运行，各隔离 worktree 间的未提交代码与产物通过不可变 Git Tree 引用 **`ArtifactRef::GitTree(oid)`**（`refs/qz/squad/<id>/<role>`）精确交接审阅。

---

# 第六部分：5-Sprint 纵向可交付重构实施计划（Sprint Contracts & Tasks）

## 全局强约束（Global Constraints — 适用于以下每一个 Task）
- **命名约束**：CLI 二进制名固定为 `qz`；守护进程为 `quetzalcoatld`；引导服为 `quetzalcoatl-hub`；家目录环境变量为 `QUETZALCOATL_HOME`（默认 `~/.quetzalcoatl`，Windows `%LOCALAPPDATA%\Quetzalcoatl`）；所有 Rust crate 前缀为 `quetzalcoatl-`。
- **代码卫生与门禁**：Rust Workspace 启用 `edition = "2024"`；业务 crate 强制 `#![forbid(unsafe_code)]` 与 `#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::todo)]`；Go 启用 `CGO_ENABLED=0` 与 `-race` 测试；TypeScript 启用 `strict: true` 与 `noUncheckedIndexedAccess: true`；Swift 启用 Swift 6 Strict Concurrency；C# 启用 `Nullable=enable` 与 `TreatWarningsAsErrors=true`。
- **Git 提交纪律**：禁止任何 `Co-Authored-By` 等 AI 署名 trailer；一个逻辑单元一个中文提交；每次提交后 `git status` 必须零 untracked 文件。

---

## Sprint 1：品牌立规、单机脊柱、`eWave` 良知核与桌面通用双模 Harness 闭环

### Sprint 1 Contract（冲刺契约）
- **用户可见行为**：运行 `qz up` 启动本机 `quetzalcoatld` 守护进程，`<10ms` 自动嗅探并纳管本机已装 Coding Agent（OpenCode V2 / Claude Code / Codex CLI / Pi `v1.6` / Goose / Hermes）；通过 `qz chat` 或原工具终端交互时自动注入 `eWave` 良知与蛇形四维记忆召回；闲置期生物钟唤醒 `Explore Run` 在无外发权限的沙箱中自由探索并即时演化新技能；研发与高危 `Commit Run` 强制经断网洁净室 `Verifier` 验收闭环，日常问答零校验税秒回；支持 `qz import-v1` 与 `qz export`。
- **功能性要求**：完成 `v1-legacy` 归档与 `main` 重建、`AGENTS.md` + `deny.toml`、`spec/` 测试向量、`quetzalcoatl-types`、`quetzalcoatl-crypto`、`quetzalcoatl-spine`、`quetzalcoatl-ewave`、`quetzalcoatl-sandbox`、`quetzalcoatl-kernel`、`quetzalcoatl-harness`、`quetzalcoatl-daemon`（含 `qz` CLI）及 `packages/harness-enhancers/*`。
- **验证命令**：
  - `cargo deny check licenses bans sources`
  - `cargo fmt --all -- --check && cargo clippy --workspace --all-targets -- -D warnings`
  - `cargo test --workspace`
- **数据库与系统检查**：验证 `~/.quetzalcoatl/spine/spine.sqlite` 哈希链连续、签名有效；验证沙箱子进程内读取宿主密钥返回 `EACCES`/空且 `env` 无明文 API Key。
- **明确排除项**：跨机 `iroh` 组网、Go `quetzalcoatl-hub`、`openmls` 群组协同、声学 VAD 与 GUI 客户端。

---

### Task 1.1：封存 `v1-legacy`、清空重建 `main` 骨架与冻结 `spec/` 跨语言向量

**Files:**
- Preserve & Track: `docs/V2_GOAL.html`
- Create: `AGENTS.md`, `deny.toml`, `LICENSE-APACHE`, `LICENSE-AGPL`, `Cargo.toml`, `.gitignore`
- Create: `spec/vectors/{opaque_rfc9807.json,hpke_xwing.json,spine_pack_aad.json,anp_p9_mentions.json}`
- Create: `crates/quetzalcoatl-types/{Cargo.toml,src/lib.rs}`
- Create: `crates/quetzalcoatl-spine/tests/fixtures/{v1_soul_v14/,v1_quetzal_sample.sql}`

**Interfaces:**
- Produces: `quetzalcoatl_types::{AgentId, DeviceId, RunId, ThreadId, ArtifactId, HlcTimestamp, Epoch, ErrorCode, QuetzalcoatlError}` 与 `spec/vectors/*.json` 跨语言黄金测试向量。

- [ ] **Step 1: 保护 `docs/V2_GOAL.html` 并创建 `v1-legacy` 永久归档分支与标签**
  先检查当前工作区，抽取合成 V1 测试样本（不含任何个人隐私数据），在当前 V1 `HEAD` 创建 `v1-final` 标签与 `v1-legacy` 分支，确认 `git rev-parse v1-legacy` 无误。
- [ ] **Step 2: 清空 `main` 旧 V1 模块目录并建立 Quetzalcoatl V2 根骨架**
  使用 `git rm -r` 移除 `engine/ runtime/ console/ sync/ bridge/ cli/ website/` 等旧目录，保留 `docs/V2_GOAL.html`，写入新版 `AGENTS.md`（载入六语言契约与 18 条防坑纪律）、双许可证、`deny.toml` 与 Workspace `Cargo.toml`。
- [ ] **Step 3: 编写架构与门禁自检测试（先写失败断言）**
  编写 `crates/quetzalcoatl-types/tests/workspace_hygiene.rs`：断言 `deny.toml` 阻断 `GPL/AGPL` 依赖、断言 `spec/vectors/*.json` 格式完整可解析。
- [ ] **Step 4: 实现 `quetzalcoatl-types` 核心强类型原语与 `spec/` 黄金测试向量**
  实现固定宽度大端 `HlcTimestamp(u128)`、全系强类型新类型 ID（`AgentId` 等）与机器可读 `QuetzalcoatlError` 枚举。
- [ ] **Step 5: 验证门禁并提交**
  Run: `cargo deny check && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace && git status -s`
  Expected: 全部 PASS 且无任何 untracked 文件，执行中文语义化原子提交。

---

### Task 1.2：密码学核心、单主权签名 HLC 脊柱与 `import-v1` / ZIP 归档（`quetzalcoatl-crypto`, `quetzalcoatl-spine`）

**Files:**
- Create: `crates/quetzalcoatl-crypto/{Cargo.toml,src/lib.rs,src/keys.rs,src/pack.rs}`
- Create: `crates/quetzalcoatl-spine/{Cargo.toml,src/lib.rs,src/ledger.rs,src/store.rs,src/archive.rs,src/import_v1.rs}`
- Test: `crates/quetzalcoatl-spine/tests/{spine_roundtrip.rs,import_v1_test.rs}`

**Interfaces:**
- Consumes: `quetzalcoatl_types::*`, `spec/vectors/*`
- Produces: `AccountRootKey`, `EpochKeyRing`, `seal_packfile() / open_packfile()`（`zstd windowLog<=20` + 2 的幂次分桶填充 + 结构化 AAD），`SpineEngine::{append_event, seal_checkpoint, export_zip, import_zip, import_v1}`，以及 `MaterializedStore` trait（`RusqliteWalStore` 实现）。

- [ ] **Step 1: 编写脊柱防篡改、时钟漂移隔离与 V1 双库幂等导入失败测试**
  覆盖：① 篡改密文或 `AAD` 任一字节报错 `IntegrityViolation`；② 注入 `+10m` 未来 HLC 事件被拒收且不推高本机 HLC；③ 同一份 V1 `soul-v14` + 两份不同身体 `quetzal.db` 连续导入两次结果严格幂等无重复。
- [ ] **Step 2: 运行测试确认红灯**
  Run: `cargo test -p quetzalcoatl-crypto -p quetzalcoatl-spine` -> Expected: FAIL
- [ ] **Step 3: 实现 `quetzalcoatl-crypto` 与 `quetzalcoatl-spine`**
  实现纪元密钥轮换、1MiB 窗口压缩加密 Packfile、`rusqlite` WAL 物化表（事件、快照、记忆索引、会话、运行记录）、可读 Markdown + `.quetzalcoatl-spine/` 双模 ZIP 导出器及 `import-v1`。
- [ ] **Step 4: 验证通过并提交**
  Run: `cargo clippy --workspace -- -D warnings && cargo test -p quetzalcoatl-crypto -p quetzalcoatl-spine` -> Expected: PASS，原子提交。

---

### Task 1.3：Rust 版 `quetzalcoatl-ewave`（兼容 `@plutokeating/ewave@0.2.0`）与两段式良知核

**Files:**
- Create: `crates/quetzalcoatl-ewave/{Cargo.toml,src/lib.rs,src/graph.rs,src/align.rs,src/conscience.rs,src/assembler.rs,src/arbiter.rs}`
- Test: `crates/quetzalcoatl-ewave/tests/{v2_snapshot_compat.rs,conscience_governance.rs}`

**Interfaces:**
- Consumes: `quetzalcoatl_types::*`, `quetzalcoatl_spine::SpineEngine`
- Produces: `SerpentineGraph`（`observe, add_branch, promote, link, activate, collapse_time, align, merge, verify, from_json_v2, to_json_v2`）、`ContextAssembler::assemble(BudgetProfile::{Standard, CompactOnDevice(u32)})`、`ConscienceArbiter::evaluate_proposals(router_epoch)`。

- [ ] **Step 1: 编写 JSON-v2 快照双向兼容、抗施压/反思维病毒与 C 档自动写回失败测试**
  构造含多父归属、跨 $\alpha_t$ 切片与 `+1/-1` 极性边的 `@plutokeating/ewave@0.2.0` 黄金 JSON 快照；构造单会话 15 轮施压（S5）企图篡改 `SELF_CORE` 的拒绝用例，以及跨 3 个独立 Thread 簇满足冷却期自动升格 `SELF_CORE` 的放行用例。
- [ ] **Step 2: 运行测试确认红灯**
  Run: `cargo test -p quetzalcoatl-ewave` -> Expected: FAIL
- [ ] **Step 3: 实现蛇形四维图核心、单 `emb_version` 词法哈希默认向量、双预算组装器与租约围栏 `Arbiter`**
  严格保证浮点 CF 聚合、主干叶计数守恒、最远点对确定性分裂及反模因免疫条款钉扎。
- [ ] **Step 4: 验证通过并提交**
  Run: `cargo clippy --workspace -- -D warnings && cargo test -p quetzalcoatl-ewave` -> Expected: PASS，原子提交。

---

### Task 1.4：桌面无容器沙箱、`quetzalcoatl-sandbox-exec` 与零凭据代理（`quetzalcoatl-sandbox`）

**Files:**
- Create: `crates/quetzalcoatl-sandbox/{Cargo.toml,src/lib.rs,src/linux.rs,src/macos.rs,src/windows.rs,src/broker.rs,src/bin/quetzalcoatl-sandbox-exec.rs}`
- Test: `crates/quetzalcoatl-sandbox/tests/sandbox_escape_and_broker.rs`

**Interfaces:**
- Consumes: `quetzalcoatl_types::*`
- Produces: `SandboxManager::{probe, mint_ticket, spawn_clean_room}`、`CredentialBroker::{register_scoped_secret, serve_ipc}` 与独立可执行包装器 `quetzalcoatl-sandbox-exec`（兼容 `-c "<cmd>"` 统一调用约定）。

- [ ] **Step 1: 编写沙箱探针防泄密、配置目录只读与跨源凭据防外带测试**
  断言沙箱内进程读 `~/.quetzalcoatl/secrets/probe` 失败、写工作区 `.git/hooks/pre-commit` 或 `.opencode/opencode.json` 失败、将代理令牌发往非白名单攻击者域名返回 `403`、回包中若意外回显密钥明文或 base64 编码均被替换为 `[REDACTED]`。
- [ ] **Step 2: 运行测试确认红灯**
  Run: `cargo test -p quetzalcoatl-sandbox` -> Expected: FAIL
- [ ] **Step 3: 实现三桌面平台沙箱后端、一次性执行票据与 Unix Socket / Named Pipe `Credential Broker`**
  Linux 落实 AppArmor 真实 `mount` 探针与 `SYS_clone3 -> ENOSYS` `seccompiler` 规则；macOS 落实 Seatbelt；Windows 落实 `mxc-sdk` + `srt-win` 分级后端。
- [ ] **Step 4: 验证通过并提交**
  Run: `cargo clippy --workspace -- -D warnings && cargo test -p quetzalcoatl-sandbox` -> Expected: PASS，原子提交。

---

### Task 1.5：盲微内核、双态 `Run` 与洁净室汇点定级 `Verifier`（`quetzalcoatl-kernel`）

**Files:**
- Create: `crates/quetzalcoatl-kernel/{Cargo.toml,src/lib.rs,src/registry.rs,src/grant.rs,src/heart.rs,src/run_machine.rs,src/verifier.rs}`
- Test: `crates/quetzalcoatl-kernel/tests/{blind_boundary.rs,dual_mode_and_verifier.rs}`

**Interfaces:**
- Consumes: `quetzalcoatl_types::*`, `quetzalcoatl_spine::*`, `quetzalcoatl_sandbox::SandboxManager`
- Produces: `BlindKernel`、`HeartScheduler`（双过程 `S - C` 生物钟）、`RunStateMachine`（`Explore` 硬禁外部写 ↔ `Commit` 写前幂等锁 + CoW 即时技能自演化）与 `CleanRoomVerifierDag`（按目标能力汇点 Sink 自动触发）。

- [ ] **Step 1: 编写盲内核静态依赖测试与 Verifier 防作弊红队测试**
  在 `blind_boundary.rs` 中解析 `cargo metadata` 断言 `quetzalcoatl-kernel` 零上层/供应商依赖；在 `dual_mode_and_verifier.rs` 中断言：① `Explore Run` 自由新增沙箱本地技能立即可用，但发起外发消息被 `Grant` 拒绝；② 触及代码仓库变更的 `Commit Run` 若篡改工作区内测试脚本或跑出 0 用例，洁净室 `Verifier` 拒绝签发 `Mark`；③ 日常问答 `Commit Run` 零 `Verifier` 子进程开销直接结项。
- [ ] **Step 2: 运行测试确认红灯**
  Run: `cargo test -p quetzalcoatl-kernel` -> Expected: FAIL
- [ ] **Step 3: 实现盲内核、生物钟、双态状态机与洁净室 `Verifier DAG`**
- [ ] **Step 4: 验证通过并提交**
  Run: `cargo clippy --workspace -- -D warnings && cargo test -p quetzalcoatl-kernel` -> Expected: PASS，原子提交。

---

### Task 1.6：桌面通用双模 Harness 宿主、守护进程 `quetzalcoatld` 与 `qz` CLI（`quetzalcoatl-harness`, `quetzalcoatl-daemon`）

**Files:**
- Create: `crates/quetzalcoatl-harness/{Cargo.toml,src/lib.rs,src/discovery.rs,src/gateway.rs,src/mcp_bridge.rs,src/drivers/{mod.rs,acp.rs,opencode.rs,claude.rs,codex.rs,pi.rs}}`
- Create: `crates/quetzalcoatl-daemon/{Cargo.toml,src/lib.rs,src/daemon.rs,src/local_ipc.rs,src/bin/quetzalcoatld.rs,src/bin/qz.rs}`
- Create: `packages/harness-enhancers/{opencode-v2-plugin/,pi-extension/,claude-code-hooks/,codex-hooks/}`
- Test: `crates/quetzalcoatl-daemon/tests/e2e_single_node.rs`

**Interfaces:**
- Consumes: Sprint 1 前序全部 crates
- Produces: `HarnessHost`（`<10ms` 嗅探器 + 回环 LLM 网关 + ACP/RPC 驱动池）、后台独占脊柱守护 `quetzalcoatld`（含防 DNS 重绑定守卫）与唯一简写命令行 `qz`（`up / down / status / agents / chat / export / import-v1`）。

- [ ] **Step 1: 编写嗅探防撞车、回环网关 4-`cache_control`/HMAC/Codex 双模保真及单机端到端测试**
  使用模拟上游与假 Harness 进程验证：未带 `x-qz-token` 请求回 `401`、Claude 请求不超过 4 个 `cache_control` 块、Codex `encrypted_content` 字节原样保留、`Router` 被硬剥夺 `shell/edit` 且自动派发 `Worker` 在独立 worktree 完成任务。
- [ ] **Step 2: 运行测试确认红灯**
  Run: `cargo test -p quetzalcoatl-harness -p quetzalcoatl-daemon` -> Expected: FAIL
- [ ] **Step 3: 实现通用 Harness 适配层、渐进式插件增强包、`quetzalcoatld` 与 `qz` CLI**
- [ ] **Step 4: 全工作区门禁验证并提交**
  Run: `cargo deny check && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace` -> Expected: 全绿，原子提交。

---

## Sprint 2：`iroh 1.5` 跨网直连、两态围栏租约漂移与 Go 零知识 `quetzalcoatl-hub`

### Sprint 2 Contract（冲刺契约）
- **用户可见行为**：用户在不同网络的电脑上执行 `qz login`（Passkey）或 `qz pair`（扫码 5 秒配对）即自动组建端到端加密扁平算力网；合上活跃 `Router` 所在笔记本盖子，另一台在线机器在 `<100ms` 内无感接班续跑；设备错峰开关机时经零算力、零明文的 `quetzalcoatl-hub` 秒级同步 Packfiles；单用户可将不同能力标签的子任务跨机器派发给远端节点上的异构 Coding Agent 执行。
- **功能性要求**：完整交付 `hub/`（`CGO_ENABLED=0` 单静态二进制）与 `crates/quetzalcoatl-fabric`。
- **验证命令**：
  - `cd hub && CGO_ENABLED=0 go build ./cmd/quetzalcoatl-hub && go vet ./... && go test -race ./...`
  - `cargo test -p quetzalcoatl-fabric --workspace`
- **API/数据库/网络检查**：检查 `quetzalcoatl-hub` SQLite/Postgres 与块存储无任何明文密钥、记忆或 Prompt；在隔离网络命名空间实测 `iroh v1.5` 经自建 Go Hub `:7842/udp` QAD 发现公网端口并从 `:443/relay` 成功升级为 P2P UDP QUIC 直连。
- **明确排除项**：多人 `openmls` 群组房间、外部 IM 通道与图形客户端。

---

### Task 2.1：Go `quetzalcoatl-hub` 零知识认证、5 槽位信封、Presigned `PUT` 存储与 CAS 见证

**Files:**
- Create: `hub/{go.mod,cmd/quetzalcoatl-hub/main.go,internal/store/{sqlite.go,postgres.go,blob.go},internal/auth/{passkey.go,pairing.go,opaque.go,guardian.go,oidc.go},internal/spine/sync.go,internal/lease/cas.go}`
- Test: `hub/internal/auth/vectors_test.go`, `hub/internal/spine/sync_test.go`

**Interfaces:**
- Consumes: `spec/vectors/*.json`
- Produces: `/v1/auth/*`, `/v1/pair/*`, `/v1/spine/{agent_id}/packs`（`server_seq` 游标 + Presigned `PUT` 精确字节与哈希核验）, `/v1/lease/acquire`（单调 `witness_epoch` CAS）。

- [ ] **Step 1: 编写跨语言 OPAQUE/HPKE 向量互通、配额超限拦截与 CAS 围栏竞态测试**
- [ ] **Step 2: 运行 `go test -race ./...` 确认红灯**
- [ ] **Step 3: 纯 Go（`CGO_ENABLED=0`）实现双数据库适配、5 槽位密钥信封、Packfile 配额存储与 CAS 租约寄存器**
- [ ] **Step 4: 验证通过并提交**
  Run: `cd hub && CGO_ENABLED=0 go build ./... && go test -race ./...` -> Expected: PASS，原子提交。

---

### Task 2.2：Go `quetzalcoatl-hub` 内嵌 `:443/relay` WSS、`7842/udp` QAD 与零日志模型网关

**Files:**
- Create: `hub/internal/relay/{ws_relay.go,frames.go,qad_udp.go}`, `hub/internal/llmproxy/{stream.go,quota.go}`
- Test: `hub/internal/relay/relay_test.go`, `hub/internal/llmproxy/proxy_test.go`

**Interfaces:**
- Produces: `:443/relay`（`iroh-relay-v2` 混合编码 + 反代 TLS Exporter 回退 `ServerChallenge`）、`:443/ping`、`:7842/udp`（ALPN `/iroh-qad/0` `OBSERVED_ADDRESS`）与可选 `/v1/llm/*`（`ResponseController` 超时防慢客户端 OOM + 多模态/推理两阶段配额结算）。

- [ ] **Step 1: 编写 `iroh-relay-v2` 黄金字节帧编解码、慢速 SSE 断流取消及 `<|endoftext|>` 防崩测试**
- [ ] **Step 2: 运行测试确认红灯**
- [ ] **Step 3: 实现 WSS 中继、QAD UDP 响应器与零日志流式模型代理**
- [ ] **Step 4: 验证通过并提交**

---

### Task 2.3：Rust `quetzalcoatl-fabric`（`iroh 1.5` 对接、两态围栏租约漂移与远程异构 Worker 池）

**Files:**
- Create: `crates/quetzalcoatl-fabric/{Cargo.toml,src/lib.rs,src/endpoint.rs,src/sync_actor.rs,src/lease_router.rs,src/worker_pool.rs}`
- Test: `crates/quetzalcoatl-fabric/tests/{real_iroh_go_hub_interop.rs,chaos_partition.rs}`

**Interfaces:**
- Consumes: `quetzalcoatl-kernel`, `quetzalcoatl-spine`, Go `quetzalcoatl-hub`
- Produces: `FabricNode`（自动整合 LAN mDNS、Tailscale/WireGuard 直连、`quetzalcoatl-hub` WSS/QAD 穿透）、`FencedLeaseCoordinator`（`witness_epoch` 联网全权态 vs `Partition-Local Lease` 离线受限态 + `<100ms` 主动释放）与 `RemoteWorkerPool`（按能力标签跨机调度异构 Harness）。

- [ ] **Step 1: 编写双进程真实 `iroh 1.5 <-> Go quetzalcoatl-hub` 打洞直连测试与 100 种子分区混沌测试**
  断言禁用 n0 官方中继后仅靠自建 Go Hub 即可测出 `global_v4` 并打洞升级为直连 QUIC；断言合盖 `<100ms` 移交、旧主苏醒被 `StaleLeaseEpoch` 拒斥自降级、断网分区零外部动作双发。
- [ ] **Step 2: 运行测试确认红灯**
- [ ] **Step 3: 实现 `quetzalcoatl-fabric` 并接入 `quetzalcoatld` 与 `qz pair / status / nodes`**
- [ ] **Step 4: 验证 Rust + Go 联调全绿并提交**

---

## Sprint 3：`Super-Group-Agent` 物理隔离群组协同、7 大通道、`SayIt` 合龙与 5 大领域包

### Sprint 3 Contract（冲刺契约）
- **用户可见行为**：多位人类携各自的私人主权 Agent 与物理隔离的群组共享角色 Agent 在 `openmls` 端到端加密房间内无刷屏、无泄密、无覆盖地协同推进任务；单用户可组建跨 Claude / OpenCode / Codex 的异构专家编队；`SayIt` 收集的日常碎片自动加密并入个人主权 Agent 的 `eWave` 知识树；7 大外部通道族、`<3MB` 声学打断管线、`spine-bridge` 与 5 大标杆领域包全部就绪。
- **功能性要求**：完成 `quetzalcoatl-group` + `hub/internal/groupds`、`quetzalcoatl-voice-ai`、`packages/channels/*`、`SayIt` 吸纳器、`packages/bridge/spine-bridge` 与 `packages/domains/*`。
- **验证命令**：
  - `cargo test --workspace && (cd hub && go test -race ./...)`
  - 断网密封容器 120s 遥测抓包与体积门禁检查（内置 VAD 编译增量 `< 3.0 MB`，遥测包数 `= 0`）
- **明确排除项**：Web 与四大原生桌面/移动 GUI 客户端。

---

### Task 3.1：`openmls` 群组脊柱与 `Super-Group-Agent` 四大协同机制（`quetzalcoatl-group`, `hub/internal/groupds`）

**Files:**
- Create: `hub/internal/groupds/sequencer.go`
- Create: `crates/quetzalcoatl-group/{Cargo.toml,src/lib.rs,src/mls_room.rs,src/facilitator.rs,src/floor_control.rs,src/commit_barrier.rs,src/a2a_mandate.rs,src/squad.rs}`
- Test: `crates/quetzalcoatl-group/tests/{mamu_collaboration_bench.rs,isolation_and_revocation.rs}`

**Interfaces:**
- Produces: `GroupRoomEngine`（`openmls` 群加密 + Hub `/v1/groups/{id}/commits` 密文原子定序）、`RoomFacilitator`、`AnpP9FloorGate`（`@addressee / cc / @agents / @humans` + `max_hops=3`）、`UnreadWatermarkBarrier`（`last_seen_group_seq` CAS）、`SignedAgentCard & AttenuatedMandate`（跨组织受限 A2A）及 `HeterogeneousSquadCoordinator`。

- [ ] **Step 1: 编写物理隔离防泄密、踢人纪元前向安全、`max_hops=3` 防刷屏与 `MAMUBench` 未读水位线拦截测试**
- [ ] **Step 2: 运行测试确认红灯**
- [ ] **Step 3: 实现 `hub/internal/groupds` 与 `quetzalcoatl-group` 并挂载至 `quetzalcoatld` / `qz group`**
- [ ] **Step 4: 验证通过并提交**

---

### Task 3.2：`<3MB` 纯 Rust 回声消除/VAD 与按需零遥测本地模型管线（`quetzalcoatl-voice-ai`）

**Files:**
- Create: `crates/quetzalcoatl-voice-ai/{Cargo.toml,src/lib.rs,src/aec_vad.rs,src/ort_loader.rs,src/hybrid_search.rs,assets/silero_vad_16k_int8.onnx}`
- Test: `crates/quetzalcoatl-voice-ai/tests/{barge_in_aec.rs,zero_telemetry_gate.rs}`

**Interfaces:**
- Produces: `DuplexAudioGate`（`sonora-aec3` + `tract-onnx` 16kHz 折叠 VAD，`<3MB` 零外部动态库）与 `OnDemandAiPackManager`（验签拉取 `libonnxruntime` + SenseVoice/Kokoro + 多语种嵌入模型，强制环境与 API 双重关闭遥测）。

- [ ] **Step 1: 编写混音回声不自激、真人 150ms 插嘴触发、二进制增量 `<3MB` 及零遥测断言测试**
- [ ] **Step 2: 运行测试确认红灯**
- [ ] **Step 3: 实现声学打断管线、按需动态 `ort` 加载器与 `reembed()` 升级联动**
- [ ] **Step 4: 验证通过并提交**

---

### Task 3.3：7 大通道族、HPKE 零知识 Webhook 入站、`SayIt` 子树吸纳与 `spine-bridge`

**Files:**
- Create: `hub/internal/lease/webhook_hpke.go`
- Create: `packages/channels/{feishu/,wecom/,dingtalk/,telegram/,email/,webhook/,system-intents/}`
- Create: `packages/capabilities/{deliverables/,web-research/,doc-reader/,hands-desktop/,artifacts/,sayit-ingestor/}`
- Create: `packages/bridge/spine-bridge/`
- Test: `crates/quetzalcoatl-daemon/tests/channels_and_sayit_e2e.rs`

**Interfaces:**
- Produces: 7 大标准通道描述符与驱动（支持多信道带宽字数约束、长连接单 `witness_epoch` 持有、公网 Webhook 经 Hub 内存验签后 RFC 9180 HPKE 零知识密封入站）、仅绑定个人主权 Agent 的 `SayIt` JSON-v2 子树吸纳管线、以及持受限 `Role::Bridge` 密钥的 Hermes/OpenClaw 桥接器。

- [ ] **Step 1: 编写 Webhook 零明文落盘、`Router` 漂移通道无缝交接、`SayIt` 子树 `align()/merge()` 归并与 `Role::Bridge` 越权写入拦截测试**
- [ ] **Step 2: 运行测试确认红灯**
- [ ] **Step 3: 实现全部外置通道、基础能力包、`SayIt` 吸纳器与 `spine-bridge`**
- [ ] **Step 4: 验证通过并提交**

---

### Task 3.4：五大首发标杆领域包与监护人签名 `SafetyEnvelope`（`packages/domains/*`）

**Files:**
- Create: `packages/domains/{personal-companion/,eldercare-guardian/,youth-socratic-tutor/,software-engineering/,regulated-professional/}`
- Test: `crates/quetzalcoatl-kernel/tests/domain_packs_certification.rs`

**Interfaces:**
- Produces: 5 套完整领域包（含种子良知、角色工具白名单、监护人签名不可篡改 `SafetyEnvelope` 及研发/少儿/合规专属洁净室 `Verifier` 规则）。

- [ ] **Step 1: 为 5 大领域包编写角色红线与客观校验契约测试（如长辈离线告警越过睡眠抑制、少儿禁直接给答案、合规文书无引用必拦截）**
- [ ] **Step 2: 运行测试确认红灯**
- [ ] **Step 3: 编写并校验 5 套领域包配置与校验脚本**
- [ ] **Step 4: 验证通过并提交**

---

## Sprint 4：`quetzalcoatl-client-core`、TS Web 端与三大纯原生桌面端 + 新官网发版链

### Sprint 4 Contract（冲刺契约）
- **用户可见行为**：浏览器、Linux、macOS 与 Windows 桌面用户获得 100% 原生控件界面，一键在「伴生极简态 · 承诺与群组工作台态 · 主权工程态」三档认知密度间自如切换，与本机后台 `quetzalcoatld` 共享状态零冲突，并可从新官网一行命令完成签名校验安装。
- **功能性要求**：交付 `quetzalcoatl-client-core`、`quetzalcoatl-wasm`、`quetzalcoatl-uniffi`（锁定 `=0.32.0` 三语言拉模式流）、`surfaces/web`、`surfaces/linux`（Rust GTK4）、`surfaces/macos`（SwiftUI）、`surfaces/windows`（C# WinUI 3）、`website/` 与新版 `install.sh / install.ps1`。
- **验证命令 & UI 标准**：
  - Rust/Linux：`cargo test -p quetzalcoatl-client-core -p quetzalcoatl-uniffi -p quetzalcoatl-surface-linux`
  - Web & Website：`npm --prefix surfaces/web test && npm --prefix website run build`
  - macOS & Windows：`xcodebuild test -scheme QuetzalcoatlMac`、`dotnet test surfaces/windows/Quetzalcoatl.Windows.sln -warnaserror`
  - UI 无障碍标准：伴生极简态零技术黑话、按钮 `≥64pt`、`200%` 缩放零截断、流式回复双通道无障碍播报正常。
- **明确排除项**：iOS 与 Android 移动端原生 App 及移动内嵌引擎（归属 Sprint 5）。

---

### Task 4.1：`quetzalcoatl-client-core`、`quetzalcoatl-wasm` 与 `uniffi = "=0.32.0"` 三语言拉模式流基座

**Files:**
- Create: `crates/quetzalcoatl-client-core/{Cargo.toml,src/lib.rs,src/ipc_mode.rs,src/view_models.rs,src/llm_stream_bridge.rs}`
- Create: `crates/bindings/quetzalcoatl-uniffi/{Cargo.toml,src/lib.rs}`
- Create: `crates/bindings/quetzalcoatl-wasm/{Cargo.toml,src/lib.rs}`
- Test: `crates/bindings/quetzalcoatl-uniffi/tests/{swift_smoke/,kotlin_smoke/,csharp_smoke/}`

**Interfaces:**
- Produces: 单机 `quetzalcoatld` IPC 薄客户端自动切换器、WASM OPFS 独占存储与 `ruzstd` 适配、三档认知密度响应式差分 `ViewPatch`、`ViewStream::next_events()` 拉模式流接口，以及供移动端复用的安全 `UniFFI` LLM 流通道。

- [ ] **Step 1: 编写 GUI+CLI 并发挂载零锁冲突测试，以及 Swift 6 / Kotlin / .NET 9 三语言 10,000 次拉流取消零内存泄漏测试**
- [ ] **Step 2: 运行测试确认红灯**
- [ ] **Step 3: 实现 `quetzalcoatl-client-core`、`quetzalcoatl-uniffi` 与 `quetzalcoatl-wasm`**
- [ ] **Step 4: 验证通过并提交**

---

### Task 4.2：TypeScript 纯原生三态 Web 客户端（`surfaces/web`）

**Files:**
- Create: `surfaces/web/{package.json,tsconfig.json,src/worker/,src/tiers/{companion/,workbench/,inspector/}}`
- Test: `surfaces/web/tests/{a11y_streaming.spec.ts,three_tiers_flow.spec.ts}`

**Interfaces:**
- Consumes: `quetzalcoatl-wasm` / 本地 `quetzalcoatld` 安全回环 API
- Produces: 零跨端冗余的纯原生响应式 Web 应用（10 秒零术语引导、群组共享产物协同、蛇形四维良知树检视）。

- [ ] **Step 1: 编写双通道 `aria-live` 防结巴测试、`320px/200%` 字号重排测试与三档切换端到端测试**
- [ ] **Step 2: 运行测试确认红灯**
- [ ] **Step 3: 实现 Web Worker WASM 宿主与三档原生 DOM 视图**
- [ ] **Step 4: 验证通过并提交**

---

### Task 4.3：Linux 纯原生桌面与托盘端（`surfaces/linux` — Rust `gtk4-rs / relm4` + 动态 `libadwaita`）

**Files:**
- Create: `surfaces/linux/{Cargo.toml,src/main.rs,src/tray.rs,src/views/{companion.rs,workbench.rs,inspector.rs}}`
- Test: `surfaces/linux/tests/dynamic_link_and_ui.rs`

**Interfaces:**
- Consumes: 直接 Rust 依赖 `quetzalcoatl-client-core`（零 FFI 开销）
- Produces: `quetzalcoatl-desktop` Linux 原生可执行文件与 `.desktop` 规范文件。

- [ ] **Step 1: 编写 ELF 动态链接合规检查（确保 `libadwaita-1` 动态链接满足 LGPL-2.1）与三态视图状态切换测试**
- [ ] **Step 2: 运行测试确认红灯**
- [ ] **Step 3: 实现 GTK4/Adwaita 三态界面、AT-SPI 无障碍语义树与托盘驻留**
- [ ] **Step 4: 验证通过并提交**

---

### Task 4.4：macOS（`Swift 6 + SwiftUI`）与 Windows（`C# .NET 9 + WinUI 3`）纯原生桌面端

**Files:**
- Create: `surfaces/macos/{Package.swift,QuetzalcoatlMac.xcodeproj,Sources/}`
- Create: `surfaces/windows/{Quetzalcoatl.Windows.sln,src/Quetzalcoatl.App/}`

**Interfaces:**
- Consumes: `quetzalcoatl-uniffi`（Swift `AsyncThrowingStream` 与 C# `IAsyncEnumerable` 拉模式封装）
- Produces: macOS 原生 App（含菜单栏图标与 launchd 管理）与 Windows 原生 WinUI 3 Fluent App（含系统托盘与 UI Automation 无障碍树）。

- [ ] **Step 1: 编写两平台 ViewModel 绑定、高频流式输出 UI 线程不阻塞与无障碍属性完整性单测**
- [ ] **Step 2: 运行测试确认红灯**
- [ ] **Step 3: 实现 `surfaces/macos` 与 `surfaces/windows` 三态界面及系统守护联动**
- [ ] **Step 4: 验证编译测试零警告通过并提交**

---

### Task 4.5：Quetzalcoatl 官网文档站（`website/`）、签名镜像与一键安装脚本（`install.sh / install.ps1`）

**Files:**
- Create: `website/{package.json,wrangler.jsonc,worker/index.ts,src/}`
- Create: `scripts/{install.sh,install.src.ps1,gen-install-ps1.mjs}`
- Test: `scripts/tests/{install_verify_sig.test.sh,install_ps1.test.ps1}`

**Interfaces:**
- Produces: 全新 `Quetzalcoatl` 品牌双语官网、Cloudflare Worker `/dl/*` 流式 SHA-256 镜像与内置 Ed25519 验签回滚的 `install.sh / install.ps1`。

- [ ] **Step 1: 编写安装脚本签名篡改阻断测试、架构识别测试与回滚测试**
- [ ] **Step 2: 运行测试确认红灯**
- [ ] **Step 3: 实现 `website/` 与跨平台一键安装器**
- [ ] **Step 4: 验证通过并提交**

---

## Sprint 5：iOS（`SwiftAgent`）与 Android（`Koog`）纯原生移动端与全受众终验

### Sprint 5 Contract（冲刺契约）
- **用户可见行为**：iPhone/iPad 与 Android 用户装上不到 25MB 的纯原生客户端后，无需任何电脑即可靠手机内嵌原生轻量引擎独立对话、语音插嘴、记录记忆与接收关怀提醒；当家中或团队电脑开机上线时，复杂工程与重型文档任务自动经 `iroh` 漂移至桌面 OpenCode / Claude Code 并发完成，并在 iPhone 灵动岛与安卓实时进度通知上同步呈现；Google Play `store` 包 100% 合规上架，直装 `full` 包提供完整手部自动化。
- **功能性要求**：完成 `quetzalcoatl-nse-ffi`、`surfaces/ios`（`SwiftAgent + FoundationModels`）、`surfaces/android`（`JetBrains Koog v1.3` + `store/full` 双包），通过全受众无障碍与 `ConscienceBench` 认证并完成 `v2.0.0` 全矩阵发版。
- **验证命令 & 商店生死红线**：
  - iOS：`xcodebuild test -scheme QuetzalcoatlIOS` + `cargo test -p quetzalcoatl-nse-ffi`（硬门禁：NSE 峰值 RSS **`< 12 MB`**，且绝不触碰 SQLite WAL 锁）
  - Android：`./gradlew :app:testStoreReleaseUnitTest :app:testFullReleaseUnitTest :app:lintStoreRelease`（硬门禁：`storeRelease` 合并清单 **`AccessibilityService` 数量 == 0**，且不使用 6 小时受限的 `dataSync` 前台服务）
- **明确排除项**：外部应用商店人工审核排队时长。

---

### Task 5.1：`quetzalcoatl-nse-ffi` 与 iOS 纯原生客户端（`SwiftUI + SwiftAgent + FoundationModels`）

**Files:**
- Create: `crates/bindings/quetzalcoatl-nse-ffi/{Cargo.toml,src/lib.rs}`
- Create: `surfaces/ios/{QuetzalcoatlIOS.xcodeproj,Sources/App/,Sources/NSE/,Sources/LiveActivity/,Sources/Intents/}`
- Test: `crates/bindings/quetzalcoatl-nse-ffi/tests/rss_budget_gate.rs`

**Interfaces:**
- Consumes: `quetzalcoatl-uniffi`（主进程）、`quetzalcoatl-nse-ffi`（NSE 扩展）
- Produces: iOS 纯原生三态 App（`SwiftAgent` 云端模型经 Rust `UniFFI` 安全流调用，iOS 26+ 离线自动切换 `FoundationModels` + `CompactOnDevice(4096)` 预算；NSE 解密写 `<AppGroup>/spine-spool/` 防 `0xdead10cc`；支持灵动岛、iOS 26 `BGContinuedProcessingTask`、`AVAudioEngine` VPIO 硬件回声消除插嘴与 Siri `App Intents`）。

- [ ] **Step 1: 编写 `quetzalcoatl-nse-ffi` 峰值分配 `<12MB` 硬断言、spool 合并幂等测试及 4096 Token 预算裁剪测试**
- [ ] **Step 2: 运行测试确认红灯**
- [ ] **Step 3: 实现 `quetzalcoatl-nse-ffi` 与 `surfaces/ios` 全部原生模块**
- [ ] **Step 4: 验证通过并提交**

---

### Task 5.2：Android 纯原生客户端、`JetBrains Koog v1.3` 内嵌与 `store / full` 合规双包（`surfaces/android`）

**Files:**
- Create: `surfaces/android/{build.gradle.kts,app/build.gradle.kts,app/src/main/,app/src/store/,app/src/full/}`
- Test: `surfaces/android/app/src/test/kotlin/VerifyStoreManifestTest.kt`

**Interfaces:**
- Consumes: `quetzalcoatl-uniffi`, `ai.koog:koog-agents:1.3.0`
- Produces: `quetzalcoatl-android-store.apk`（Google Play 合规版，走 `AppFunctions / Intents`，零 `AccessibilityService`）与 `quetzalcoatl-android-full.apk`（含可选 `Hands` 无障碍增强模块），内置 `VOICE_COMMUNICATION` 硬件回声消除与网络切换无感重连。

- [ ] **Step 1: 编写合并后 `AndroidManifest.xml` 静态扫描单测（若 `store` 包出现 `AccessibilityService` 或 `dataSync` 立即失败）及 `Koog` `AIAgentFeature` 良知拦截单测**
- [ ] **Step 2: 运行测试确认红灯**
- [ ] **Step 3: 实现 Jetpack Compose 三态界面、`Koog` 内嵌引擎、声学回声消除与双渠道构建配置**
- [ ] **Step 4: 验证双包构建与单测全绿并提交**

---

### Task 5.3：全受众无障碍走查、5 大领域包联合演练与 `ConscienceBench` 认证

**Files:**
- Create: `crates/quetzalcoatl-ewave/tests/conscience_bench_suite.rs`
- Create: `docs/{ARCHITECTURE.md,PROTOCOL.md,SECURITY.md,DOMAIN_PACK_GUIDE.md,MIGRATION_V1_TO_V2.md}`

**Interfaces:**
- Produces: 完整通过的 `ConscienceBench`（T1 抗施压与合理更新、T2 群组多主体相反指令一致性、T3 跨信道思维病毒免疫 `篡改率 == 0%`）基准报告与全套对齐最新源码的中文文档。

- [ ] **Step 1: 编写跨节点 + 群组房间的 `ConscienceBench` T1/T2/T3 自动化评测套件与五端无障碍检查清单**
- [ ] **Step 2: 运行评测并调优参数直至全部指标达标（T3 核心良知篡改率为 0%）**
- [ ] **Step 3: 全面撰写并核对根级 `README.md` 与 `docs/*.md`，确保文档与实际源码 100% 一致、无任何 V1 残留描述**
- [ ] **Step 4: 验证通过并提交**

---

### Task 5.4：全矩阵签名 CI/CD 流水线与 `Quetzalcoatl v2.0.0` 正式发版门禁

**Files:**
- Create: `.github/workflows/{ci.yml,release.yml}`

**Interfaces:**
- Produces: 覆盖 Rust、Go、Swift（macOS/iOS）、Kotlin（Android 双包）、C#（WinUI 3 x64/arm64）、TypeScript（Web/Website）的自动化测试构建与 Ed25519 `SHA256SUMS.sig` 签名发布流水线。

- [ ] **Step 1: 编写发布产物完整性、许可证合规（`THIRD_PARTY_NOTICES`）与签名校验门禁脚本**
- [ ] **Step 2: 本地与模拟 Runner 全链路验证构建、安装、`import-v1`、扫码组网与群组协同冒烟测试**
- [ ] **Step 3: 检查全仓 `git status` 零脏文件并完成收官提交**

---

# 第七部分：全局边界审视重点（Review Focus）

以下 5 类最易在真实用户使用中触发严重故障的隐含边界，已作为强制回归测试钉入对应所属 Task：

1. **群聊并发抢交导致群友约束被吞（归属 Task 3.1）**：当群成员 B 在群成员 A 的 Agent 推理期间追加了一条关键禁忌（如过敏源或预算上限），平台 `UnreadWatermarkBarrier` 必须拒绝携带旧 `last_seen_group_seq` 的产物提交并强制重读合并。
2. **合盖休眠时钟跳变引发双 `Router` 幽灵外发（归属 Task 2.3 & 2.4）**：旧 `Router` 所在笔记本合盖休眠 2 小时后开盖苏醒的瞬间，必须在发出任何网络包前先读本机单调时钟 `Instant` 自检租约过期并立即自降级，且远端按 `witness_epoch` 二次拦截。
3. **苹果 iOS 推送扩展锁死主库引发 `0xdead10cc` 闪退（归属 Task 5.1）**：iOS 后台挂起期间收到加密群通知唤醒 NSE 时，NSE 严禁触碰 SQLite WAL 文件锁，只能写 `spine-spool/` 独立文件并保持总内存 `< 12 MB`。
4. **恶意代码仓库利用配置覆盖卸载沙箱与良知插件（归属 Task 1.4 & 1.6）**：克隆外部开源仓库分析时，仓库内自带的 `.opencode/opencode.json`、`.claude/settings.json` 或 `.git/hooks/` 必须被宿主启动参数锁定屏蔽且在沙箱内只读挂载。
5. **Claude Max / ChatGPT Plus 订阅用户被回环代理误伤封禁或缓存失效（归属 Task 1.6）**：回环网关绝不篡改 `system[0]` 首部指纹、绝不超出 4 个 `cache_control` 断点，并对 Codex OAuth 模式保留原生 HTTPS 通道与 `RawValue` 加密推理字段。

---

# 第八部分：跨会话中断恢复与无历史冷启动交接协议

为确保任何新启动的 Coding Agent 无需读取本次对话历史即可从本地仓库和 Git 记录零损耗续接执行：

1. **冷启动必读三件套**：
   - 本计划文件：`.opencode/plans/2026-11-24-quetzalcoatl-v2-architecture-and-plan.md`（Task 1.1 重建 `main` 时须同步保留本文件或将其迁入 `docs/V2_PLAN.md` 持续追踪勾选状态）；
   - 根级规范：`AGENTS.md`（Task 1.1 起更新为新版六语言与编译严苛门禁契约）；
   - 第一性原理蓝图：`docs/V2_GOAL.html`。
2. **定位恢复点标准命令**：
   ```bash
   git status -s
   git branch -a
   git log -n 15 --oneline
   ```
   核对本计划文件中最后一个已勾选 `[x]` 的步骤与最新 Git Commit 是否一致，先运行上一个已完成 Task 的验证命令确认基线 100% 绿灯，再开始下一个未勾选 `[ ]` 步骤。
3. **跨平台构建阻塞处置准则**：
   - 在单一操作系统开发机（如 Linux）执行 Sprint 4 / Sprint 5 涉及 macOS/iOS `xcodebuild` 或 Windows `WinUI 3` 的任务时，先完成全部共享 Rust 状态机、`UniFFI` 接口绑定与源码编写，严禁伪造其他操作系统本地测试通过记录，必须在 `.github/workflows/ci.yml` 对应原生 OS Runner 上验证编译与单测全绿后方可勾选完成。
