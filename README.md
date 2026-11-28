# Quetzalcoatl（羽蛇神）

**你的 Agent 的海：一份只属于你、跟着你的设备走的人格与记忆。**

Quetzalcoatl 不是聊天应用，也不是又一个 agent 框架。它把一个 Agent 的人格、价值、关系与记忆
存成一份带权威等级并签名的数据；在你已经在用的宿主（Claude Code、Codex、OpenCode 等）每次调用
模型之前把它送进去，调用之后把输出当作信号、经独立审查才写回。对话和推理循环永远是宿主的。
数据以单写者签名的 HLC 事件脊柱保存，端到端加密后才能离开设备，不托管给任何中心服务。

逐场景的需求与现状以 [docs/USER_SCENARIOS.md](docs/USER_SCENARIOS.md) 为准；当前执行计划是
`.opencode/plans/2026-11-28-quetzalcoatl-host-native-plan.md`。

- 当前工作区版本：`2.0.0-alpha.9`（预发布）
- 唯一终端简写：`qz`；其余二进制/服务/包名一律全拼 `quetzalcoatl-*`
- 许可证：核心与客户端 `Apache-2.0`；`hub/` 引导服 `AGPL-3.0-only`（见 [许可证](#许可证)）
- 已有自动化证据：`ConscienceBench` T1/T2/T3 认证报告
  [docs/bench/conscience-bench-2026-11-25.md](docs/bench/conscience-bench-2026-11-25.md)；召回评测基线
  [docs/bench/recall-eval-2026-11-28.md](docs/bench/recall-eval-2026-11-28.md)

> **诚实边界**：本 README 只描述仓库中可验证的代码与脚本。不做自己的对话客户端：iOS / Android 对话端已撤销，
> macOS 与 Windows 只剩打开治理面的外壳；本轮验证机暂停 VM，实机无障碍走查标记为
> `Deferred (VMs paused by owner)`，详见 [docs/ACCESSIBILITY_CHECKLIST.md](docs/ACCESSIBILITY_CHECKLIST.md)。

---

## 1. 它是什么

| 维度 | 设计选择 |
| --- | --- |
| 住在哪 | 用户已经在用的宿主里（目前 Claude Code、Codex、OpenCode 与 DeepSeek Harness）：经钩子、工具通道（MCP）、斜杠命令与状态栏挂上，任何失败都放行 |
| 送进去 | 会话开始送入他的核心（底线、部署约束、核心价值、性情、对你的了解），每次提交带上相关往事，压缩后重送 |
| 写回来 | 你亲口说的「记住 / 不对 / 别再提 / 忘掉」当场生效并与对话记录核对；模型自己想记的只作参考；你不在时他借你的宿主回想相处，提议经仲裁才沉淀 |
| 记忆 | 单写者签名 HLC 事件脊柱 + SQLite WAL 物化视图；良知的每次变更是一条可重放的事件，条目正文各用一把钥匙封存，抹除即销毁钥匙 |
| 隐私 | `zstd` + 分桶填充 + `XChaCha20-Poly1305` 的 E2EE Packfile；Hub 只存密文与配额 |
| 良知 | `ROOT(100)` / `OPERATOR(80)` / `SELF_CORE(70)` 锁死；底线由你亲手签；有界段在预算内演化 |
| 运行时 | 盲微内核 + 无容器 OS 沙箱 + 洁净室 `Verifier`；守护进程自身不调用模型，不重造底层 Coding Agent |
| 组网 | `iroh 1.5` 打洞 + `quetzalcoatl-hub`（中继 / QAD / 配额 / 密文同步），默认登录官方 Hub |
| 自有界面 | 只有治理面：只看和签，没有输入框 |

它**不是**：聊天应用、又一个 agent 框架、云端 RAG 记忆库，也不是一个把灵魂仓库同步到
Git 服务器的工具（V1 的 Git 灵魂仓库已彻底移除，见
[docs/MIGRATION_V1_TO_V2.md](docs/MIGRATION_V1_TO_V2.md)）。

## 2. 用起来

```bash
curl -fsSL https://quetzal.plutokeating.beer/install | bash   # 装完自动接上本机的宿主
qz doctor        # 逐个宿主核对：送核心、送往事、收信号、压缩后不丢
qz open          # 治理面：他、我、我们、往事、底线、宿主、设备、记录
qz login         # 登录官方 Hub（第一次登录即注册），多设备从这里开始
qz export ./sea.zip   # 人能读的海 + 签名事件 + 口令封存的恢复包
qz import ./sea.zip   # 在新机器的空目录里原样恢复
qz recovery-code      # 生成应急码：所有设备都丢了时，qz recover 凭它与登录口令找回他
qz sayit connect      # 接上 SayIt：你在 SayIt 里记下的自动流进他的海
qz bring ~/notes      # 把已有的笔记、对话导出与角色卡带进来；qz bring --undo <批次> 整批撤回
qz bring --watch ~/vault  # 让一个笔记目录一直流进来：改了接替、删了抹除
```

在宿主里说人话就行（也有 `/quetzalcoatl:remember`、`/quetzalcoatl:correct`、`/quetzalcoatl:hush`、
`/quetzalcoatl:forget`、`/quetzalcoatl:why`、`/quetzalcoatl:learned`、`/quetzalcoatl:off-record`、`/quetzalcoatl:delegate` 等命令）。

| 界面 | 实现 | 状态（本仓库） |
| --- | --- | --- |
| 宿主插件 | `packages/harness-enhancers/claude-code-plugin`、`packages/harness-enhancers/codex-plugin` | 已实现，由 `qz connect` 装入 |
| Web 治理面 | `surfaces/web`：TypeScript + 原生 DOM，由守护进程同源托管 | 已实现，含 vitest / Playwright |
| Linux 治理面 | `surfaces/linux`：`gtk4-rs` + 动态 `libadwaita-1` | 已实现，含无头冒烟 |
| macOS | `surfaces/macos`：SwiftUI 最小外壳（说明 + 打开 `qz open`） | 只剩外壳 |
| Windows | `surfaces/windows`：WinUI 3 最小外壳（说明 + 打开 `qz open`） | 只剩外壳 |
| iOS / Android | — | 对话端已撤销；手机上的治理面与推送另行审批 |

## 3. 架构总览

```mermaid
flowchart TB
  subgraph Hosts["用户自己的宿主"]
    CC["Claude Code"]
    Codex["Codex"]
    OC["OpenCode"]
    DSH["DeepSeek Harness"]
  end

  subgraph Clients["治理面（只看和签）"]
    Web["Web 治理面 (TS)"]
    Linux["Linux 治理面 (GTK4/Adwaita)"]
  end

  subgraph Daemon["quetzalcoatld（单主机唯一脊柱持有者）"]
    IPC["本地认证 IPC<br/>0600 UDS / 127.0.0.1 + 路径能力令牌"]
    GW["回环模型网关<br/>前缀缓存保护 / 凭据剥离"]
    Harness["HarnessHost<br/>纳管 OpenCode V2 等宿主"]
    Kernel["盲微内核<br/>RunMachine / Heart / Verifier"]
    Sandbox["无容器沙箱<br/>bwrap / Seatbelt / AppContainer"]
  end

  subgraph Core["状态与良知脊柱"]
    Spine["签名 HLC 事件脊柱<br/>SQLite WAL 物化视图"]
    Packs["E2EE Packfile<br/>zstd + 分桶 + AEAD"]
    Ewave["eWave 良知<br/>Arbiter / Assembler / Graph"]
    Domains["领域包<br/>SafetyEnvelope + Verifier"]
  end

  subgraph Fabric["协同与连接"]
    Hub["quetzalcoatl-hub<br/>relay / QAD / 密文同步 / 配额"]
    Lease["两态围栏租约<br/>witness_epoch / Partition-Local"]
    Group["openmls 群组<br/>水位线 / ANP-P9 / StewardGrant"]
    Channels["七通道族<br/>飞书 / 企微 / 钉钉 / TG / 邮件 / Webhook / 系统意图"]
  end

  Hosts -- "钩子 / MCP（qz hook、qz mcp）" --> IPC
  Clients --> IPC
  IPC --> Kernel
  IPC --> Ewave
  Kernel --> Sandbox
  Kernel --> Spine
  Sandbox --> GW
  GW --> Harness
  Ewave --> Spine
  Spine --> Packs
  Domains --> Ewave
  Packs <--> Hub
  Lease <--> Hub
  Group <--> Hub
  Channels <--> Hub
  Hub <--> Channels
```

四层划分、crate 映射、数据流与各子系统不变量见
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)；线格式与端点见
[docs/PROTOCOL.md](docs/PROTOCOL.md)。

## 4. 安装

官方安装脚本（校验 `SHA256SUMS` 与 Ed25519 `SHA256SUMS.sig` 后才落盘）：

```bash
curl -fsSL https://quetzal.plutokeating.beer/install | bash
```

可选参数（完整列表见 `scripts/install.sh` 头部注释）：

```bash
curl -fsSL https://quetzal.plutokeating.beer/install | bash -s -- --prefix "$HOME/.local"
```

Windows：

```powershell
irm https://quetzal.plutokeating.beer/install.ps1 | iex
```

从源码构建（Linux 需 GTK4 >= 4.14、libadwaita >= 1.9、xvfb）：

```bash
cargo build --workspace --release
cargo build -p quetzalcoatl-daemon --release   # quetzalcoatld 与 qz
CGO_ENABLED=0 go build ./cmd/quetzalcoatl-hub  # 在 hub/ 目录
```

安装脚本的验签、回滚、镜像回退、幂等升级与卸载行为由
`scripts/tests/install_verify_sig.test.sh` 覆盖；发布清单签名工具是 `scripts/gen-sums.sh`。

## 5. `qz` 快速开始

```bash
qz up                 # 启动本机 quetzalcoatld 并等待就绪
qz connect            # 把他接进本机的宿主（Claude Code、Codex、OpenCode、DeepSeek Harness）；--undo 撤下
qz doctor             # 按宿主体检：送核心、送往事、收信号、压缩后不丢
qz open               # 打开治理面（只有「看」和「签」）
qz status             # 守护进程 / 脊柱 / Heart / fabric 状态
qz agents             # 发现已安装的 Coding Agent（并行探测）
qz login              # 登录官方 Hub（--hub 指向自建的）
qz reflect            # 让他现在就回想一次最近的相处
qz export ./backup.zip
qz import ./backup.zip
qz pair start         # 抗量子 X-Wing 设备配对
qz group list         # openmls 群房间
qz channel list       # 七大通道族
qz domain list        # 五大领域包
qz sayit ingest --path ./snapshot
qz webhook status
```

全部子命令与参数以 `qz --help` 与 `crates/quetzalcoatl-daemon/src/bin/qz.rs` 为准；`qz up`
在守护进程已在线时会自动切换到本地 IPC 薄客户端，绝不重复打开 `spine.sqlite`。

### V1 迁移

```bash
qz import-v1 --soul-dir /path/to/v1-soul --db /path/to/v1-sessions.sqlite
```

单向、幂等、可重复执行；映射关系、导出/恢复与注意事项见
[docs/MIGRATION_V1_TO_V2.md](docs/MIGRATION_V1_TO_V2.md)。

## 6. 安全模型摘要

1. **主权根密钥**：`AccountRootKey` 签名 `ROOT`/`OPERATOR` 清单；每次上下文组装与提案提交
   前都做 BLAKE3 物理比对，篡改即 `CONSCIENCE_VIOLATION`。
2. **绝对段不可由模型改写**：任何触及 `ROOT(100)` / `OPERATOR(80)` 的 LLM 提案直接报错；
   `SELF_CORE(70)` 只能经多独立证据 + 冷却期 + 异构双 Reflector 的 C 档流程升格。
3. **本地攻击面收敛**：IPC 仅绑 `127.0.0.1`/UDS，`0600` 权限 + 256-bit 路径能力令牌 +
   Host 校验；外部网页无法凭 DNS 重绑定调用本地 RPC。
4. **凭据不进沙箱**：真实 OAuth `refresh_token` 由 `quetzalcoatld` 托管，沙箱只拿到剥离后的
   临时配置目录；`CredentialBroker` 出站时才换上真令牌。
5. **改动要你亲口说**：宿主会话里的纠正、不主动提、抹除只在你这一句话里说了才执行，回合结束与对话记录核对；
   模型在命令行里调用宿主专用入口会被拒；对话里的改动最高只写到「关于我」，底线只能在治理面签。
6. **抹除是真删**：每个条目一把钥匙，抹除即销毁钥匙；本机库、预写日志、全文索引与检索索引里都不留正文。
7. **零知识 Hub**：Hub 只见 HPKE 密封的 webhook 队列、密文 Packfile、哈希与配额；不持有
   任何明文记忆或模型密钥。
8. **供应链**：`deny.toml` 硬阻断 GPL/AGPL 进入 `Apache-2.0` 工作区；发布产物经
   `scripts/gen-sums.sh` 生成 `SHA256SUMS` + Ed25519 签名；仓库零密钥、零真实个人数据。

完整威胁模型与边界见 [docs/SECURITY.md](docs/SECURITY.md)。

## 7. 许可证

本项目采用严格物理隔离的双层许可：

- **`Apache-2.0`**（[LICENSE-APACHE](LICENSE-APACHE)）：`crates/`、`spec/`、`packages/`、
  `surfaces/`、`website/`、安装脚本与文档。
- **`AGPL-3.0-only`**（[LICENSE-AGPL](LICENSE-AGPL)）：仅 `hub/` 下的零算力零知识服务端
  `quetzalcoatl-hub`；可另行洽谈商业双许可。

向 `Apache-2.0` 工作区引入 `GPL-2.0*` / `GPL-3.0*` / `AGPL-3.0*` 强传染依赖会被
`cargo deny check licenses bans sources` 直接阻断。

## 8. 文档索引

| 文档 | 内容 |
| --- | --- |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 四层架构、crate 地图、数据流、脊柱/Packfile、eWave、内核、沙箱、fabric、群组、通道、领域包、IPC、客户端 |
| [docs/PROTOCOL.md](docs/PROTOCOL.md) | 脊柱事件/HLC/Pack AAD、Hub REST/relay/QAD、群组提交协议、配对与纪元、通道信封、错误码 |
| [docs/SECURITY.md](docs/SECURITY.md) | 威胁模型、沙箱边界、零知识 Hub、凭据代理、良知权威、供应链与密钥纪律 |
| [docs/DOMAIN_PACK_GUIDE.md](docs/DOMAIN_PACK_GUIDE.md) | 领域包 schema、监护人签名、`SafetyEnvelope`、Verifier 规则、编写与测试流程 |
| [docs/MIGRATION_V1_TO_V2.md](docs/MIGRATION_V1_TO_V2.md) | V1 移除项、`qz import-v1` 映射、导出/恢复、注意事项 |
| [docs/ACCESSIBILITY_CHECKLIST.md](docs/ACCESSIBILITY_CHECKLIST.md) | 五端无障碍检查清单与延后项 |
| [docs/RELEASE.md](docs/RELEASE.md) | 发版手册：tag/Secret、资产清单、验签、回滚、CI 矩阵与已知限制 |
| [docs/V2_GOAL.html](docs/V2_GOAL.html) | 第一性原理蓝图（不改动） |
| [docs/ORIGIN_GOAL.md](docs/ORIGIN_GOAL.md) | 目标用户人设与十个典型环境场景（项目的背景期待） |
| [docs/GOVERNANCE_SURFACE.md](docs/GOVERNANCE_SURFACE.md) | 治理面规范：用户来这里要什么、三栏版面、动作与状态、与守护进程的接口 |
| [docs/USER_SCENARIOS.md](docs/USER_SCENARIOS.md) | 用户场景与链路：34 类场景逐步写清原始需求、手边该有的控件与现状；与铁律冲突之处与依赖顺序 |
| [docs/bench/conscience-bench-2026-11-25.md](docs/bench/conscience-bench-2026-11-25.md) | `ConscienceBench` 认证报告 |
| [docs/bench/recall-eval-2026-11-28.md](docs/bench/recall-eval-2026-11-28.md) | 召回评测基线：按词匹配能带入什么、带不入什么 |

## 9. 验证门禁

提交前必须全部通过（Linux 主机；GTK 依赖见上文）：

```bash
cargo deny check licenses bans sources
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
bash scripts/tests/docs_links.test.sh
```

Go Hub：

```bash
cd hub && CGO_ENABLED=0 go build ./cmd/quetzalcoatl-hub && go vet ./... && go test -race ./...
```

`ConscienceBench` 单独运行（默认零副作用；设置报告目录才会落盘）：

```bash
CONSCIENCE_BENCH_REPORT_DIR=docs/bench \
  cargo test -p quetzalcoatl-ewave --test conscience_bench_suite
```

召回评测（同样默认零副作用）：

```bash
RECALL_EVAL_REPORT_DIR=docs/bench \
  cargo test -p quetzalcoatl-ewave --test recall_eval -- --nocapture
```

GitHub Actions（`.github/workflows/ci.yml`）另在 macOS 与 Windows 上构建两端外壳。

## 10. 参与开发

- 冷启动先读 `AGENTS.md`、`docs/ORIGIN_GOAL.md`、`docs/USER_SCENARIOS.md` 与当前执行计划
  `.opencode/plans/2026-11-28-quetzalcoatl-host-native-plan.md`；
- 提交信息使用中文说明真实工程意图，禁止 AI 署名 trailer；
- 禁止提交任何密钥、真实个人记忆样本、设备标识符或私有 IP/MAC；
- 运行态数据只写入 `QUETZALCOATL_HOME`（POSIX 默认 `~/.quetzalcoatl`）。
