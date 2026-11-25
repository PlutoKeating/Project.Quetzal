import type { Lang } from "~/i18n/core";

export type HomeMessages = {
  metaTitle: string;
  metaDescription: string;
  eyebrow: string;
  title: string;
  lead: string;
  primaryCta: string;
  secondaryCta: string;
  factsTitle: string;
  facts: { label: string; value: string }[];
  pillarsTitle: string;
  pillarsLead: string;
  pillars: { kicker: string; title: string; text: string }[];
  surfacesTitle: string;
  surfacesLead: string;
  surfaces: { name: string; stack: string; text: string }[];
  installTitle: string;
  installLead: string;
  installCode: string;
  trustTitle: string;
  trustText: string;
  trustCta: string;
  ctaTitle: string;
  ctaText: string;
  ctaButton: string;
};

const zh: HomeMessages = {
  metaTitle: "Quetzalcoatl · 属于你的主权 Agent 操作系统",
  metaDescription:
    "Quetzalcoatl 是跑在你自己设备上的主权 Agent 操作系统：盲微内核、签名 HLC 状态脊柱、两段式良知与五端原生界面，底层纳管 OpenCode V2 / Claude Code / Codex。",
  eyebrow: "Quetzalcoatl V2 · 从第一性原理重构",
  title: "把 Agent 活成一条脊柱，而不是一串会话。",
  lead:
    "Quetzalcoatl 是一个跑在你自己设备上的主权 Agent 操作系统。盲微内核只做四件事：状态脊柱、权限隔离、事件路由、客观校验；底层的编码 Agent 用你已经在用的 OpenCode V2、Claude Code、Codex，不重造毛坯房，也不把你的记忆锁进某一家云。",
  primaryCta: "一行命令安装",
  secondaryCta: "下载签名版本",
  factsTitle: "一眼看清",
  facts: [
    { label: "后台守护", value: "quetzalcoatld" },
    { label: "命令行", value: "qz" },
    { label: "状态脊柱", value: "SQLite WAL + 签名 HLC" },
    { label: "组网", value: "iroh 1.5（QUIC + QAD）" },
    { label: "原生表面", value: "5 端，零 WebView" },
    { label: "许可证", value: "Apache-2.0" },
  ],
  pillarsTitle: "六条不可妥协的第一性原理",
  pillarsLead: "每一条都对应可复现的验证命令；做不到的，就不写进架构。",
  pillars: [
    {
      kicker: "01 / 盲微内核",
      title: "内核不认识供应商",
      text: "模型名、通道名、工具名都不进内核。状态、权限、事件、校验四件事之外，一律是外置插件。",
    },
    {
      kicker: "02 / 两段式良知",
      title: "日常自由，汇点验收",
      text: "ROOT 100 / OPERATOR 80 / SELF_CORE 70 绝对锁死；SELF_SOFT 50 与 MEMORY 30 在写时复制沙箱里零审批自演化，研发与高危动作必须过断网只读的洁净室 Verifier。",
    },
    {
      kicker: "03 / 蛇形记忆",
      title: "eWave 不是向量堆",
      text: "项目、记录、章节三种粒度做语义 + 词法 + 结构对齐。跨模型导入按本脊柱规范重算嵌入，维度不同也不会崩。",
    },
    {
      kicker: "04 / 物理隔离",
      title: "1 个 Agent = 1 条脊柱",
      text: "家庭与团队协作不做单实例分舱，而是密码学完全隔离的独立 Agent 实例，经 quetzalcoatl-group 的四种拓扑协同。",
    },
    {
      kicker: "05 / 可迁移",
      title: "导出是可读的",
      text: "qz export 产出 Markdown + Spine 的 ZIP；没有 Git 灵魂仓库，也没有把记忆锁死的私有格式。",
    },
    {
      kicker: "06 / 供应链",
      title: "安装即验签",
      text: "每个资产都有 SHA256SUMS，清单由 Ed25519 签名。安装器用内置公钥先验签、再核对哈希，任何一步失败就回滚。",
    },
  ],
  surfacesTitle: "五端原生，没有 WebView 套壳",
  surfacesLead: "同一个 quetzalcoatld、同一条脊柱、同一套良知；界面各用各的原生控件。",
  surfaces: [
    { name: "Linux", stack: "Rust · GTK4 + libadwaita", text: "三档认知密度的原生窗口，systemd 用户服务托管后台守护。" },
    { name: "macOS", stack: "Swift 6 · SwiftUI", text: "严格并发，菜单栏常驻；UniFFI 拉模式流与移动端共享同一套接口。" },
    { name: "Windows", stack: "C# · WinUI 3", text: "原生 Fluent 控件；quetzalcoatld 由计划任务在开机与登录时拉起。" },
    { name: "Web", stack: "TypeScript · WASM + OPFS", text: "浏览器内 E2EE 与本地脊柱；关掉页面，状态还在本机。" },
    { name: "iPhone / iPad", stack: "SwiftUI · SwiftAgent", text: "离线用端侧模型，重活经 iroh 漂移到桌面节点。" },
    { name: "Android", stack: "Kotlin · Jetpack Compose", text: "Koog v1.3 原生内嵌；store 渠道零无障碍服务、零 dataSync 前台服务。" },
  ],
  installTitle: "一条命令，立起脊柱",
  installLead: "安装器先验签再安装；失败不会留下半套系统。",
  installCode: `# Linux / macOS
curl -fsSL https://quetzal.plutokeating.beer/install | bash

# Windows（PowerShell 5.1+）
irm https://quetzal.plutokeating.beer/install.ps1 | iex`,
  trustTitle: "信任不是口号，是四道门",
  trustText:
    "安装验签、回环网关的能力令牌、洁净室验收、群组发言降权——每一道都有可复现的命令，默认值一律是失败即拒。",
  trustCta: "阅读发布签名与校验规则",
  ctaTitle: "现在就把脊柱立起来",
  ctaText:
    "安装脚本只做四件事：验签、核对哈希、安装二进制、跑健康检查。任何一步不过，它会把上一个版本放回去并如实退出。",
  ctaButton: "开始安装",
};

const en: HomeMessages = {
  metaTitle: "Quetzalcoatl · the sovereign agent OS that is yours",
  metaDescription:
    "Quetzalcoatl is a sovereign agent OS on your own devices: a blind microkernel, a signed HLC event spine, two-stage conscience and five native surfaces, driving OpenCode V2 / Claude Code / Codex.",
  eyebrow: "Quetzalcoatl V2 · rebuilt from first principles",
  title: "Grow your agent a spine, not another chat transcript.",
  lead:
    "Quetzalcoatl is a sovereign agent operating system that runs on hardware you own. The blind microkernel does four things only: state spine, permission isolation, event routing and objective verification. The coding agents underneath are the ones you already trust — OpenCode V2, Claude Code, Codex — with your memory kept in a format you can read.",
  primaryCta: "Install with one line",
  secondaryCta: "Download signed builds",
  factsTitle: "At a glance",
  facts: [
    { label: "Daemon", value: "quetzalcoatld" },
    { label: "CLI", value: "qz" },
    { label: "Spine", value: "SQLite WAL + signed HLC" },
    { label: "Network", value: "iroh 1.5 (QUIC + QAD)" },
    { label: "Native surfaces", value: "5, zero WebView" },
    { label: "License", value: "Apache-2.0" },
  ],
  pillarsTitle: "Six principles we do not trade away",
  pillarsLead: "Each one maps to a reproducible check. If it cannot be verified, it does not go into the architecture.",
  pillars: [
    {
      kicker: "01 / Blind kernel",
      title: "The kernel knows no vendor",
      text: "Model names, channels and tool names never enter the kernel. State, permissions, events and verification — everything else is an out-of-tree plugin.",
    },
    {
      kicker: "02 / Two-stage conscience",
      title: "Free by default, verified at the frontier",
      text: "ROOT 100 / OPERATOR 80 / SELF_CORE 70 are hard-locked. SELF_SOFT 50 and MEMORY 30 evolve freely inside a copy-on-write sandbox; engineering and high-risk commits must pass an offline, read-only clean-room Verifier.",
    },
    {
      kicker: "03 / Serpentine memory",
      title: "eWave is not a pile of vectors",
      text: "Project, record and section granularity with semantic, lexical and structural alignment. Importing another model's snapshot re-embeds against this spine's canonical embedder, so a dimension mismatch cannot crash it.",
    },
    {
      kicker: "04 / Physical isolation",
      title: "One agent, one spine",
      text: "Family and team collaboration never share a spine. Each agent is a cryptographically isolated instance, coordinated through the four quetzalcoatl-group topologies.",
    },
    {
      kicker: "05 / Portable",
      title: "Exports stay readable",
      text: "qz export produces a Markdown + Spine ZIP. There is no Git soul repository and no private format holding your memory hostage.",
    },
    {
      kicker: "06 / Supply chain",
      title: "Verification is the install",
      text: "Every asset is listed in SHA256SUMS, and the manifest is Ed25519 signed. The installer verifies the signature with an embedded key before it trusts any hash, and rolls back on any failure.",
    },
  ],
  surfacesTitle: "Five native surfaces, no WebView shells",
  surfacesLead: "One quetzalcoatld, one spine, one conscience; each UI uses its platform's own controls.",
  surfaces: [
    { name: "Linux", stack: "Rust · GTK4 + libadwaita", text: "A native window with three cognitive densities; the daemon runs as a systemd user service." },
    { name: "macOS", stack: "Swift 6 · SwiftUI", text: "Strict concurrency and a menu-bar presence; the same UniFFI pull-stream interface as mobile." },
    { name: "Windows", stack: "C# · WinUI 3", text: "Native Fluent controls; scheduled tasks start quetzalcoatld at boot and at logon." },
    { name: "Web", stack: "TypeScript · WASM + OPFS", text: "E2EE and a local spine inside the browser; close the tab and state stays on your machine." },
    { name: "iPhone / iPad", stack: "SwiftUI · SwiftAgent", text: "On-device models when offline; heavy work drifts to a desktop node over iroh." },
    { name: "Android", stack: "Kotlin · Jetpack Compose", text: "Koog v1.3 embedded natively; the store build has no accessibility service and no dataSync foreground service." },
  ],
  installTitle: "One command to stand up the spine",
  installLead: "The installer verifies before it writes. A failure cannot leave you with half a system.",
  installCode: `# Linux / macOS
curl -fsSL https://quetzal.plutokeating.beer/install | bash

# Windows (PowerShell 5.1+)
irm https://quetzal.plutokeating.beer/install.ps1 | iex`,
  trustTitle: "Trust is four gates, not a slogan",
  trustText:
    "Signed installs, path capability tokens on the loopback gateway, clean-room verification and demoted group speakers. Every gate has a reproducible check, and the default is fail-closed.",
  trustCta: "Read the release signing rules",
  ctaTitle: "Stand up your spine today",
  ctaText:
    "The installer does four things: verify the signature, check the hash, install the binaries, run a health check. If any step fails it restores the previous version and exits truthfully.",
  ctaButton: "Start installing",
};

export const messages: Record<Lang, HomeMessages> = { zh, en };
