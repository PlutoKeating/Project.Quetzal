import type { Messages } from "~/lib/content";

export const messages: Messages = {
  zh: {
    metaTitle: "macOS（SwiftUI）",
    doc: {
      title: "macOS：SwiftUI 原生表面",
      description: "Swift 6 严格并发的 SwiftUI 客户端、launchd 用户代理、钥匙串与 iPhone 联动。",
      lead:
        "macOS 端是 Swift 6 严格并发下的原生 SwiftUI 应用，菜单栏常驻；后台守护由 launchd 用户代理随登录拉起。它与 iPhone / iPad 共享同一套 UniFFI 拉模式接口。",
      blocks: [
        { kind: "h2", id: "requirements", text: "系统要求" },
        {
          kind: "ul",
          items: [
            "macOS 12 及以上，Intel 与 Apple silicon 均可",
            "一个终端与 `curl`；安装器不需要 Xcode",
            "签名校验优先用 OpenSSL；系统自带的 LibreSSL 没有 Ed25519 时自动退回内置纯 Perl 验签器",
          ],
        },
        { kind: "h2", id: "install", text: "安装与启动" },
        {
          kind: "code",
          title: "shell",
          text: `curl -fsSL https://quetzal.plutokeating.beer/install | bash
launchctl print gui/$(id -u)/beer.plutokeating.quetzalcoatl
qz status`,
        },
        {
          kind: "p",
          text:
            "二进制在 `~/.local/bin`，家目录 `~/.quetzalcoatl`，launchd 代理写在 `~/Library/LaunchAgents/beer.plutokeating.quetzalcoatl.plist`。安装器用 `launchctl load` 加载代理，失败时只打印需要手动执行的命令，不静默提权。",
        },
        { kind: "h2", id: "permissions", text: "权限与隐私" },
        {
          kind: "ul",
          items: [
            "对话与记忆不需要辅助功能（Accessibility）权限。",
            "文件访问按需授权：只有你明确交给某个运行的工作目录才会被挂载进沙箱。",
            "麦克风只在语音插嘴时请求；不请求时 VAD 不会打开设备。",
            "后台主密钥写入钥匙串时使用 `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`，锁屏唤醒仍可用，且不会同步到其它设备。",
          ],
        },
        { kind: "h2", id: "continuity", text: "与 iPhone / iPad 联动" },
        {
          kind: "p",
          text:
            "两端配对后加入同一扁平算力网。手机离线时用端侧模型处理日常对话与记录；复杂工程与重型文档任务经 iroh 漂移到这台 Mac。手机产生的 episode 在离线时标为 `pending`，等连上大模型或桌面节点后再巩固，避免小模型自我谄媚污染核心价值。",
        },
        { kind: "h2", id: "files", text: "文件与日志" },
        {
          kind: "table",
          head: ["项目", "位置"],
          rows: [
            ["二进制", "`~/.local/bin/{qz,quetzalcoatld,quetzalcoatl-sandbox-exec}`"],
            ["家目录", "`~/.quetzalcoatl`"],
            ["launchd 代理", "`~/Library/LaunchAgents/beer.plutokeating.quetzalcoatl.plist`"],
            ["日志", "`log show --predicate 'process == \"quetzalcoatld\"' --last 10m`"],
          ],
        },
        { kind: "h2", id: "uninstall", text: "卸载" },
        {
          kind: "code",
          title: "shell",
          text: `launchctl unload ~/Library/LaunchAgents/beer.plutokeating.quetzalcoatl.plist
curl -fsSL https://quetzal.plutokeating.beer/install | bash -s -- --uninstall
# 连脊柱、记忆与设置一起删
curl -fsSL https://quetzal.plutokeating.beer/install | bash -s -- --uninstall --purge`,
        },
        {
          kind: "note",
          tone: "warn",
          text:
            "从浏览器下载的归档可能带隔离属性（quarantine）。安装器用 `curl` 直接取签名资产，不经过浏览器；如果你手动下载，先核对签名再解压。",
        },
      ],
    },
  },
  en: {
    metaTitle: "macOS (SwiftUI)",
    doc: {
      title: "macOS: a native SwiftUI surface",
      description: "A Swift 6 strict-concurrency SwiftUI client, a launchd user agent, Keychain storage and iPhone continuity.",
      lead:
        "The macOS surface is a native SwiftUI app under Swift 6 strict concurrency with a menu-bar presence. The daemon is started at login by a launchd user agent and shares one UniFFI pull-stream interface with iPhone and iPad.",
      blocks: [
        { kind: "h2", id: "requirements", text: "Requirements" },
        {
          kind: "ul",
          items: [
            "macOS 12 or newer, Intel or Apple silicon",
            "A terminal and `curl`; Xcode is not required",
            "OpenSSL is used for signature checks when present; if the system LibreSSL lacks Ed25519 the installer falls back to its built-in pure-Perl verifier",
          ],
        },
        { kind: "h2", id: "install", text: "Install and start" },
        {
          kind: "code",
          title: "shell",
          text: `curl -fsSL https://quetzal.plutokeating.beer/install | bash
launchctl print gui/$(id -u)/beer.plutokeating.quetzalcoatl
qz status`,
        },
        {
          kind: "p",
          text:
            "Binaries live in `~/.local/bin`, the home in `~/.quetzalcoatl`, and the launchd agent in `~/Library/LaunchAgents/beer.plutokeating.quetzalcoatl.plist`. The installer runs `launchctl load`; if that fails it prints the command for you instead of silently elevating.",
        },
        { kind: "h2", id: "permissions", text: "Permissions and privacy" },
        {
          kind: "ul",
          items: [
            "Chat and memory do not require Accessibility permission.",
            "File access is granted per run: only the working directory you hand to a run is mounted into its sandbox.",
            "The microphone is requested only for voice interjection; VAD never opens the device otherwise.",
            "The background master key uses `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, so lock-screen wakeups work and nothing syncs to other devices.",
          ],
        },
        { kind: "h2", id: "continuity", text: "Continuity with iPhone and iPad" },
        {
          kind: "p",
          text:
            "Once paired, both devices join the same flat fabric. When the phone is offline it uses on-device models for everyday chat and notes; heavy engineering and document work drifts to this Mac over iroh. Episodes created while offline are marked `pending` and consolidated once a large model or a desktop node is reachable, so a small model cannot flatter itself into your core values.",
        },
        { kind: "h2", id: "files", text: "Files and logs" },
        {
          kind: "table",
          head: ["Item", "Location"],
          rows: [
            ["Binaries", "`~/.local/bin/{qz,quetzalcoatld,quetzalcoatl-sandbox-exec}`"],
            ["Home", "`~/.quetzalcoatl`"],
            ["launchd agent", "`~/Library/LaunchAgents/beer.plutokeating.quetzalcoatl.plist`"],
            ["Logs", "`log show --predicate 'process == \"quetzalcoatld\"' --last 10m`"],
          ],
        },
        { kind: "h2", id: "uninstall", text: "Uninstall" },
        {
          kind: "code",
          title: "shell",
          text: `launchctl unload ~/Library/LaunchAgents/beer.plutokeating.quetzalcoatl.plist
curl -fsSL https://quetzal.plutokeating.beer/install | bash -s -- --uninstall
# also remove the spine, memory and settings
curl -fsSL https://quetzal.plutokeating.beer/install | bash -s -- --uninstall --purge`,
        },
        {
          kind: "note",
          tone: "warn",
          text:
            "Archives downloaded through a browser may carry the quarantine attribute. The installer fetches signed assets with `curl` directly; if you download by hand, verify the signature before extracting.",
        },
      ],
    },
  },
};
