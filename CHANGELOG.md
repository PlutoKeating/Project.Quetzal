# Changelog

本文件是 `Quetzalcoatl` 的发布正文来源：`.github/workflows/release.yml` 在发版时按
`## <version>` 抽取对应小节，作为 GitHub Release 的 notes。新增版本时在文件顶部追加小节，
标题格式固定为 `## <version>`（可带日期）。

## 2.0.0-alpha.6

他住进更多宿主，也接上了你已有的东西；他闲下来时会自己去读；他的海跨设备。

- **四个宿主**：`qz connect` 一次接上本机的 Claude Code、Codex、OpenCode 与 DeepSeek Harness。OpenCode 的插件放进它的配置目录由它自己加载，插件自己登记工具通道，不改你的配置文件；DeepSeek Harness 在它的用户层补丁末尾加一段带标记的插入，撤下时你自己写的部分一字不动。治理面「宿主」页列出四个宿主。
- **他的海跨设备**：新设备 `qz pair join`，旧设备 `qz pair approve`，新设备等齐钥匙后成为同一个他。条目钥匙经 Hub 上可删除的封存通道到达；抹除一条，每台设备都销毁它的钥匙。接了 Hub 而同步失败或很久没走完时，状态栏显示「同步中断」，治理面总览显示上次同步时间。
- **SayIt 自动流入**：`qz sayit connect` 用 SayIt 的个人令牌接上，之后每五分钟增量拉取：一条记录一条往事，改了接替、删了抹除；落盘之后才上报游标，SayIt 上显示「已入海」。
- **把已有的东西带进来**：`qz bring <文件或目录>` 带进笔记、宿主的规则与记忆文件、ChatGPT 与 Claude 的对话导出（只取你自己说的话）；一批一个编号，`qz bring --undo <批次>` 整批撤回。
- **他闲时自己去读**：回想时他会记下一件好奇的事；空闲时一天至多一次，借你的宿主只读地查（只许搜索与读网页，不许命令与写文件），读到的要点带出处，作为只作参考的往事。`qz reflect --explore` 立即去读，`qz reflect --quiet-hours 23-8` 设不打扰的时段。治理面「他」页新增「他独处时」：他读到什么、好奇什么、想先提什么，节律写成两句话来选。
- **交办做完先等你拍板**：验收通过的改动先停在它自己的工作树里，桌面通知上「合进去 / 不要」，或终端里 `qz approve`；状态栏与总览显示几件事等你。
- **移除**：受管运行的四个 node 钩子脚本、只为它们存在的两个守护进程方法与按运行签发的钩子令牌；沙箱里不再有任何通往守护进程的令牌与地址。
- 已知限制：根私钥仍未用口令包裹（良知每次写入都要它签名，包裹前需要先改成由设备子钥签名）；OpenCode 与 DeepSeek Harness 的对话记录不交给回合结束的挂点，以你名义的改动按「核对不了」处理（不撤回），仍只能写到「关于我」。

## 2.0.0-alpha.5

方向转变：Quetzalcoatl 不再做自己的对话客户端，而是住进你已经在用的宿主里。对话和推理永远在宿主里（目前是 Claude Code 与 Codex），我们只负责他的「海」：人格、价值、关系与记忆。

- **接上 Claude Code 与 Codex**：安装的最后一步自动执行 `qz connect`，本机装了哪个宿主就接哪个：装入插件（钩子、工具通道、斜杠命令），Claude Code 还写好状态栏。Codex 第一次要在 `/hooks` 里信任一次钩子。会话开始送入他的核心，每次提交带上相关的往事，压缩对话后重新送入；守护进程不在时宿主照常工作。`qz doctor` 逐项核对，`qz connect --undo` 一步撤下。
- **在对话里记住、纠正、别再提、忘掉**：说一句话就行，也有 `/quetzalcoatl:remember` 等斜杠命令。改动要你亲口说才算数，回合结束时与对话记录核对；模型自己想记的只作参考。「凭什么」列出带进来的条目与出处，「记了什么」列出这个会话留下的改动；回合结束显示「记下了 N 条」。
- **无痕**：说「这段无痕」或在目录里放 `.quetzalcoatl-off-record`，状态栏显示无痕，这一段什么都不留。
- **初见**：头几次会话里，他会在不打断你的前提下问两三件以后用得上的事。
- **他闲下来时会回想**：你离开宿主半小时以上时，守护进程借你自己的 Claude Code 非交互地回想最近的相处，提议经仲裁器才沉淀（往事即时写入，性情与核心价值要证据够）；守护进程自身不调用模型。回想时若有话想说，下次见面开场提一句，一天至多一次。`qz reflect` 立即回想，`qz reflect --quiet` 关掉先开口。
- **在宿主里交办**：`/quetzalcoatl:delegate` 把要做完的事交给后台，在独立工作树里做、在洁净室里验收，`/quetzalcoatl:delegate-status` 查进展。
- **治理面**（`qz open`）：只看和签。总览、他、我、我们、往事、底线、宿主、设备、记录九页；每条往事可改、不主动提、抹除；底线写几条短句，输口令即签。没有输入框。
- **抹除是真删**：每条往事一把钥匙，抹除即销毁钥匙；本机库、预写日志、全文索引与检索索引里都不留正文。
- **他记下的东西靠得住**：良知的每次变更写进签名的事件链，启动时重放；强杀进程后重启仍在。密钥与身份文件分开存放。
- **带走与恢复**：`qz export` 导出人能读的「海」与签名事件，给了口令时再带上恢复包；`qz import` 在新机器的空目录里原样恢复。
- **官方 Hub**：`qz login` 不带参数即登录官方 Hub，第一次登录自动注册；有新版时状态栏提示，低于 Hub 要求的最低版本时暂停同步。
- **新的设计系统**：官网、Web 治理面与 Linux 治理面统一改用 Quetzalcoatl 设计系统；Linux 桌面端从三档对话客户端改成与 Web 同构的九页治理面。
- **移除**：`qz chat`、各端的输入框与对话记录、Web 控制台的长连接通道、Hub 的模型代理、浏览器端的 WASM 客户端、共享客户端核心与 UniFFI 绑定。macOS 与 Windows 只剩打开治理面的外壳。语音冻结。手机对话端撤销。
- 安全：Hub 中继拒绝小阶点公钥（全零签名冒充端点）。

## 2.0.0-alpha.4

Linux 桌面端的真机验收修复：

- **密度页图标**：三个密度页改为带图标的标题页（对话 / 网格 / 搜索），不再在标题栏显示 `image-missing` 红叉。
- **可执行的离线指引**：联系不上本机助手时，提示改为「在终端运行 `qz up`」（安装器已写好 systemd 用户单元），而不是内部二进制名。
- 守护进程运行时窗口显示「已连接 · 助手在运行」，并渲染真实会话、共享产物与运行进展。

## 2.0.0-alpha.3

修掉 alpha.2 在真实新人验收与 CI 里暴露的问题：

- **`qz open` 不再挂住调用方**：浏览器启动器过去继承 stdout/stderr，`qz open | tail`、CI 与脚本调用会一直等到启动器退出；现在子进程标准流全部置空并回收。
- **控制台不再「发送后毫无反应」**：守护进程用 `200 + {"kind":"error"}` 与 WebSocket `response` 帧表达拒绝（例如未配置模型），客户端现在把它显示成带标题的错误卡（本机登录 Claude Code / `codex login` / 显式 Bearer 三条真实路径），并保留重试。
- **WinUI 无障碍契约修正**：容器（标签页/列表）的键盘可达性由子项承载，禁用控件不再被误判为不可聚焦；审批行「批准 / 拒绝」显式 32px 触点。Windows runner 的真实 UI Automation 冒烟已全绿。
- **上游连接按解析顺序逐个尝试地址**：`localhost` 先解析到 `[::1]` 时，只绑 `127.0.0.1` 的本地网关不再被判为不可达。
- **CI 可重复性**：macOS 跑点迁到 `macos-15`（`macos-14` 已于 2026-11-02 退役）；新手用例改用短临时目录以免越过 `SUN_LEN`；安装器测试与宿主 `XDG_*` 解耦并新增「尊重 XDG_CONFIG_HOME」用例；Go Hub 集成用例串行化，消除并行抢端口导致的偶发红。
- **安装器**：PowerShell 健康检查改为精确版本令牌（预发布不得冒充正式版），并补对应用例。

## 2.0.0-alpha.2

修复首个预发布的新手安装缺口：

- **Web 控制台随包安装**：Linux CLI 包里现在带 `bin/web/`，安装器会就位/卸载它；装完 `qz up` 即可在打印的地址打开控制台。
- **`qz open` 可用**：有桌面时打开默认浏览器，没有桌面时打印地址；`qz up` 成功时也会打印控制台地址。
- **未配置模型时的提示**：`qz chat` 现在返回单一的 `MODEL_NOT_CONFIGURED` 并提示去「控制台 → 模型」填 Key，不再发起上游请求，也不再出现重复的凭据代理前缀。
- 发版门禁：签名前对照安装器内嵌公钥校验、标签版本不一致直接失败、自动把含 `-` 的版本标为预发布、断言六个资产齐全；官网 `/api/releases/latest` 只选本品牌且已签名的发布，V1 排除，稳定版缺失时回退到最新预发布并带标记。

## 2.0.0-alpha.1

首个可安装的 `Quetzalcoatl` V2 预发布，用于验证签名发版流水线与 Linux/Web 端到端安装。

**本版包含**：签名 HLC 状态脊柱、盲微内核、`quetzalcoatl-ewave` 良知核、无容器沙箱与零凭据代理、
`iroh 1.5` 组网与 Go `quetzalcoatl-hub`（认证/Packfile/CAS 租约/中继/QAD/零日志模型网关）、`openmls`
群组协同、通道族与 SayIt 吸纳、五个领域包、`qz` CLI、Linux GTK4 桌面端、Web 控制台、macOS/Windows
原生端源码与单元测试、官网与签名安装器。

**尚未包含**（阻塞项，待虚拟机恢复后补齐）：iOS 与 Android 原生客户端（Tasks 5.1/5.2）；
macOS `swift test`、Windows WinUI 完整构建与 UIA 冒烟、Windows/macOS 的签名二进制产物的原生运行验收；
`v2.0.0` 正式版将在移动端与三平台原生运行验收完成后发布。

**安装**：Linux / macOS 用 `curl -fsSL https://quetzal.plutokeating.beer/install | bash`；网页控制台
随安装启动；Windows 与 macOS 原生端在本版为源码 + 构建说明。

## 2.0.0

`Quetzalcoatl` V2 的首个签名发版。V1 的 Git 灵魂仓库与跨平台 UI 套壳已被彻底移除，V2 以
单写者签名 HLC 事件脊柱为唯一真相源，按六语言契约交付五个纯原生客户端。

> 本条目描述的是 `v2.0.0` 发版门禁就绪时的仓库状态。发版由维护者打 `vx.y.z` tag 触发
> `.github/workflows/release.yml`；在此之前仓库内版本号可能仍是预发布版本。

### 核心与安全

- **签名 HLC 事件脊柱**：单写者签名事件、`zstd` + 分桶填充 + `XChaCha20-Poly1305` 的 E2EE
  Packfile、SQLite WAL 物化视图；`qz import-v1` 提供唯一单向幂等迁移路径。
- **盲微内核**：内核只收敛状态脊柱、权限隔离、事件路由与客观校验，对模型供应商、通道与
  业务工具名保持盲视。
- **两段式良知稳态**：`ROOT(100)` / `OPERATOR(80)` / `SafetyEnvelope` 锁死；`SELF_SOFT(50)`
  在写时复制沙箱内自由自演化；`SELF_CORE(70)` 经 eWave C 档多证据冷却升格；`Verifier`
  在断网只读洁净室验收并签发 `Mark`。
- **无容器 OS 沙箱与零凭据代理**：`quetzalcoatl-sandbox-exec` 包装器、回环网关路径能力令牌、
  OAuth `refresh_token` 剥离、Anthropic 前缀缓存与 4 个 `cache_control` 归一化、
  Codex `HTTP 426` 降级与 `zstd` 请求解压。
- **`iroh 1.5` 组网**：`:7842/udp` QAD、`:443/relay`、两态围栏租约与 Outbox 对账。
- **`openmls` 群组协同**：1 实例 = 1 群信任域、`StewardGrant` 可吊销托管、两层式提交水位线。

### 客户端与宿主

- **Web**：TypeScript + Web Worker WASM/OPFS，三档认知密度，无内联脚本与远程依赖。
- **Linux**：`gtk4-rs` + 动态链接 `libadwaita-1`（LGPL-2.1 合规由 ELF 单测强制），原生托盘、
  无障碍播报、单脊柱持有者薄客户端。
- **macOS**：Swift 6 Strict Concurrency + SwiftUI，Swift Testing 覆盖核心与流泵。
- **Windows**：.NET 9 + WinUI 3，Fluent、UI Automation、`Nullable`/`TreatWarningsAsErrors` 门禁。
- **CLI / 守护进程**：`qz`（唯一允许的简写）与 `quetzalcoatld`（`CGO_ENABLED=0` 的
  `quetzalcoatl-hub` 由 Go 交付）。
- **桌面 Harness 宿主**：经 ACP / 原生 JSON-RPC 纳管 OpenCode V2 等成熟 Coding Agent，
  不重造底层 ReAct Loop。

### 发布与供应链

- `.github/workflows/ci.yml`：Rust / Go / TypeScript / Linux GTK4 / Swift / C# 全矩阵门禁，
  仅使用固定到完整 commit SHA 的 `actions/*` 官方动作；Windows App 只容忍 runner 缺
  Appx/PRI 任务这一已知缺口，C#/XAML 编译错误仍阻断，并在 App 产出时运行 UIA 冒烟。
- `.github/workflows/release.yml`：Linux `x64`/`arm64` CLI 包、Hub 静态二进制、GTK4 桌面包、
  Web 控制台包，统一由 Ed25519 私钥签发 `SHA256SUMS` 与 `SHA256SUMS.sig` 后上传。
- **信任根硬门禁**：发版前用 `scripts/check-release-key.sh` 比对 Secret 派生公钥与安装器
  内置公钥；不一致直接失败。签名后用**生产公钥**（无任何 test-pubkey 覆盖）从 `dist/`
  安装真实 `linux-x64` 包并断言 `qz --version` 精确匹配。
- **版本契约**：tag 与 Cargo workspace 版本不一致时阻断发版；安装器按完整版本令牌精确比较，
  `2.0.0-alpha.1` 不能冒充 `2.0.0`。含 `-` 的版本自动以 GitHub prerelease 发布。
- **资产契约**：签名前断言 6 个预期资产（CLI x64/arm64、Hub x64/arm64、桌面 x64、Web）
  全部存在且非空，缺失/改名即失败。
- 官网 `/api/releases/latest` 只解析本产品的已签名发布（至少一个 `quetzalcoatl-*` 资产），
  排除 V1 `v1.11.0`；无稳定版时回退到最新预发布版并标注 badge。
- `scripts/install.sh` / `scripts/install.ps1` 以内置公钥为信任根验签；安装失败自动回滚。

### 已知限制

- **iOS / Android 客户端尚未交付**：由计划 Task 5.1 / 5.2 落地；CI 中以 `if: false` 占位，
  不报告为通过。
- **Windows 安装包未签名**：当前发版只提供源码与 CI 构建证据；exe/msix 代码签名证书接入前
  不发布 Windows 二进制资产。**Windows arm64 构建 `Deferred:`**（无 arm64 验证机）。
- **macOS 公证与 `.app` 打包**：SwiftPM 构建通过 CI 验证，Developer ID 公证流程尚未接入，
  本预发布不包含 macOS 二进制资产。
- **npm 未发布**：V2 没有 npm 包，发布流水线刻意不发布 npm。
