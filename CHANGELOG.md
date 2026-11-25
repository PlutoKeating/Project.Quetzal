# Changelog

本文件是 `Quetzalcoatl` 的发布正文来源：`.github/workflows/release.yml` 在发版时按
`## <version>` 抽取对应小节，作为 GitHub Release 的 notes。新增版本时在文件顶部追加小节，
标题格式固定为 `## <version>`（可带日期）。

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
  仅使用固定到完整 commit SHA 的 `actions/*` 官方动作。
- `.github/workflows/release.yml`：Linux `x64`/`arm64` CLI 包、Hub 静态二进制、GTK4 桌面包、
  Web 控制台包，统一由 Ed25519 私钥签发 `SHA256SUMS` 与 `SHA256SUMS.sig` 后上传。
- `scripts/install.sh` / `scripts/install.ps1` 以内置公钥为信任根验签；安装失败自动回滚。

### 已知限制

- **iOS / Android 客户端尚未交付**：由计划 Task 5.1 / 5.2 落地；CI 中以 `if: false` 占位，
  不报告为通过。
- **Windows 安装包未签名**：当前发版只提供源码与 CI 构建证据；exe/msix 代码签名证书接入前
  不发布 Windows 二进制资产。
- **macOS 公证与 `.app` 打包**：SwiftPM 构建通过 CI 验证，Developer ID 公证流程尚未接入。
- **npm 未发布**：V2 没有 npm 包，发布流水线刻意不发布 npm。
