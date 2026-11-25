import type { Messages } from "~/lib/content";

export const messages: Messages = {
  zh: {
    metaTitle: "安装",
    doc: {
      title: "安装 Quetzalcoatl",
      description: "Linux、macOS 与 Windows 的一行安装：先验签，再核对哈希，最后跑健康检查。",
      lead:
        "安装器的信任根是发布签名，不是下载地址。它用内置的 Ed25519 公钥验证 SHA256SUMS，确认清单里的哈希，再安装二进制；任何一步失败都会把上一个版本放回去。",
      blocks: [
        { kind: "h2", id: "requirements", text: "安装之前" },
        {
          kind: "ul",
          items: [
            "**Linux**：x86_64 或 arm64，glibc 2.31+，systemd 用户实例（没有 systemd 时只写单元文件并提示手动启用）",
            "**macOS**：12 及以上，Intel 与 Apple silicon 均可，launchd 用户代理随登录启动",
            "**Windows**：10 1809+ 或 11，PowerShell 5.1+，x64 或 arm64",
            "**网络**：能访问 GitHub Releases 或本站镜像；安装器不依赖任何第三方 CDN",
          ],
        },
        {
          kind: "p",
          text:
            "签名校验优先使用 OpenSSL 1.1.1+；macOS 自带的 LibreSSL 没有 Ed25519，安装器会自动退回内置的纯 Perl 验签器（RFC 8032，无外部依赖）。两者都没有的极简容器会被明确拒绝，而不是跳过校验。",
        },
        { kind: "h2", id: "unix", text: "Linux 与 macOS" },
        {
          kind: "code",
          title: "shell",
          text: `curl -fsSL https://quetzal.plutokeating.beer/install | bash

# 指定版本与安装前缀
curl -fsSL https://quetzal.plutokeating.beer/install | bash -s -- --version 0.1.0 --prefix "$HOME/.local"`,
        },
        {
          kind: "p",
          text:
            "二进制装进 `--prefix` 下的 `bin/`（默认 `~/.local/bin`），运行时家目录默认 `~/.quetzalcoatl`，可用 `QUETZALCOATL_HOME` 改。安装器从不调用 `sudo`：它检查下载工具（curl/wget）、`tar`、`sha256sum`/`shasum` 与验签工具（openssl/perl），缺什么就把对应包管理器（apt / dnf / pacman / apk / brew）的安装命令打印出来，然后退出。",
        },
        { kind: "h2", id: "windows", text: "Windows" },
        {
          kind: "code",
          title: "powershell",
          text: `irm https://quetzal.plutokeating.beer/install.ps1 | iex

# 指定版本
$env:QUETZALCOATL_VERSION = '0.1.0'; irm https://quetzal.plutokeating.beer/install.ps1 | iex`,
        },
        {
          kind: "p",
          text:
            "安装到 `%LOCALAPPDATA%\\Quetzalcoatl`，并注册 `\\Quetzalcoatl\\Runtime-Boot`（开机）与 `\\Quetzalcoatl\\Runtime-Logon`（登录）两个计划任务，以当前用户、受限权限运行。注册计划任务不会悄悄提权；没有权限时会打印要手动执行的命令。",
        },
        { kind: "h2", id: "options", text: "常用选项" },
        {
          kind: "table",
          head: ["选项", "环境变量", "作用"],
          rows: [
            ["`--version X.Y.Z`", "`QUETZALCOATL_VERSION`", "安装指定版本；默认取最新签名版本"],
            ["`--prefix DIR`", "`QUETZALCOATL_PREFIX`", "安装前缀，二进制在 DIR/bin"],
            ["`--no-desktop`", "`QUETZALCOATL_NO_DESKTOP=1`", "不写桌面快捷方式"],
            ["`--cn` / `--no-cn`", "`QUETZALCOATL_CN=1|0`", "优先本站镜像（默认优先 GitHub；`QZ_CN_MIRROR` 可改镜像地址）"],
            ["`--uninstall [--purge]`", "—", "卸载；`--purge` 连家目录一起删"],
            ["`--print-platform`", "`QZ_OS` / `QZ_ARCH`", "打印 `<os> <arch>` 后退出（CI 用）"],
          ],
        },
        { kind: "h2", id: "steps", text: "安装器做了什么" },
        {
          kind: "steps",
          items: [
            { title: "识别平台与架构", text: "Linux / macOS 与 x64 / arm64；不支持的架构直接拒绝，不猜。" },
            { title: "下载签名清单", text: "SHA256SUMS 与 SHA256SUMS.sig：默认先 GitHub、再本站镜像（`--cn` 反过来）；每个源都单独验签。" },
            { title: "用内置公钥验签", text: "公钥写死在安装器里（见发布签名页），镜像无法替换。" },
            { title: "核对资产哈希", text: "清单里必须同时有 `commit <sha> v<版本>` 行与该资产的哈希。" },
            { title: "备份旧版本", text: "把现有 bin 目录复制到状态目录，升级失败可原样恢复。" },
            { title: "安装并跑健康检查", text: "执行 `qz --version`，输出必须与目标版本一致。" },
            { title: "写服务与快捷方式", text: "systemd 用户单元或 launchd 代理；有桌面客户端时才写桌面项。" },
          ],
        },
        {
          kind: "note",
          tone: "warn",
          text: "健康检查失败时安装器会回滚二进制与 `installed-version` 记录，并以非零状态退出。它不会留下「新版半装好」的状态。",
        },
        { kind: "h2", id: "upgrade", text: "升级与卸载" },
        {
          kind: "code",
          title: "shell",
          text: `# 幂等升级：再跑一次就是升级
curl -fsSL https://quetzal.plutokeating.beer/install | bash

# 卸载（保留脊柱、记忆与设置）
curl -fsSL https://quetzal.plutokeating.beer/install | bash -s -- --uninstall

# 连家目录一起删
curl -fsSL https://quetzal.plutokeating.beer/install | bash -s -- --uninstall --purge`,
        },
        {
          kind: "note",
          tone: "warn",
          text: "`--purge` 会删除 `QUETZALCOATL_HOME` 下的脊柱、记忆与设置。请先用 `qz export` 导出一份可读 ZIP。",
        },
        { kind: "h2", id: "verify", text: "验证安装" },
        {
          kind: "code",
          title: "shell",
          text: `qz --version          # 应与安装的版本一致
qz status             # 守护进程、脊柱与 iroh 节点状态
qz agents             # 本机被纳管的编码 Agent

# Linux
systemctl --user status quetzalcoatld
# macOS
launchctl print gui/$(id -u)/beer.plutokeating.quetzalcoatl`,
        },
        {
          kind: "p",
          text:
            "想自己复核签名与哈希而不依赖安装器，见 [发布签名与校验](/docs/reference/release-signing)。",
        },
      ],
    },
  },
  en: {
    metaTitle: "Install",
    doc: {
      title: "Install Quetzalcoatl",
      description: "One-line install on Linux, macOS and Windows: verify the signature, check the hash, run a health check.",
      lead:
        "The root of trust is the release signature, not the download URL. The installer verifies SHA256SUMS with an embedded Ed25519 key, checks that the artifact hash is listed, then installs. If any step fails it restores the previous version.",
      blocks: [
        { kind: "h2", id: "requirements", text: "Before you start" },
        {
          kind: "ul",
          items: [
            "**Linux**: x86_64 or arm64, glibc 2.31+, a systemd user instance (without systemd the unit file is written but not enabled)",
            "**macOS**: 12 or newer, Intel or Apple silicon, a launchd user agent at login",
            "**Windows**: 10 1809+ or 11, PowerShell 5.1+, x64 or arm64",
            "**Network**: reachable GitHub Releases or this site's mirror; no third-party CDN is involved",
          ],
        },
        {
          kind: "p",
          text:
            "Signature verification uses OpenSSL 1.1.1+ when available. macOS ships LibreSSL without Ed25519, so the installer falls back to a built-in pure-Perl verifier (RFC 8032, no extra dependencies). A minimal container with neither is rejected explicitly instead of skipping verification.",
        },
        { kind: "h2", id: "unix", text: "Linux and macOS" },
        {
          kind: "code",
          title: "shell",
          text: `curl -fsSL https://quetzal.plutokeating.beer/install | bash

# Pin a version and a prefix
curl -fsSL https://quetzal.plutokeating.beer/install | bash -s -- --version 0.1.0 --prefix "$HOME/.local"`,
        },
        {
          kind: "p",
          text:
            "Binaries land in `--prefix`/bin (default `~/.local/bin`); the runtime home defaults to `~/.quetzalcoatl` and can be changed with `QUETZALCOATL_HOME`. The installer never calls `sudo`. It checks for a downloader (curl/wget), `tar`, `sha256sum`/`shasum` and an Ed25519 verifier (openssl/perl); if one is missing it prints the command for your package manager (apt / dnf / pacman / apk / brew) and exits.",
        },
        { kind: "h2", id: "windows", text: "Windows" },
        {
          kind: "code",
          title: "powershell",
          text: `irm https://quetzal.plutokeating.beer/install.ps1 | iex

# Pin a version
$env:QUETZALCOATL_VERSION = '0.1.0'; irm https://quetzal.plutokeating.beer/install.ps1 | iex`,
        },
        {
          kind: "p",
          text:
            "Installs into `%LOCALAPPDATA%\\Quetzalcoatl` and registers two scheduled tasks, `\\Quetzalcoatl\\Runtime-Boot` and `\\Quetzalcoatl\\Runtime-Logon`, running as the current user with limited privileges. Registering a task never silently elevates; without permission it prints the command to run yourself.",
        },
        { kind: "h2", id: "options", text: "Options" },
        {
          kind: "table",
          head: ["Option", "Environment", "Effect"],
          rows: [
            ["`--version X.Y.Z`", "`QUETZALCOATL_VERSION`", "Install this version (default: latest signed)"],
            ["`--prefix DIR`", "`QUETZALCOATL_PREFIX`", "Install prefix; binaries in DIR/bin"],
            ["`--no-desktop`", "`QUETZALCOATL_NO_DESKTOP=1`", "Do not write a desktop entry"],
            ["`--cn` / `--no-cn`", "`QUETZALCOATL_CN=1|0`", "Prefer this site's mirror (default: GitHub first; `QZ_CN_MIRROR` overrides the mirror URL)"],
            ["`--uninstall [--purge]`", "—", "Remove; `--purge` also deletes the home directory"],
            ["`--print-platform`", "`QZ_OS` / `QZ_ARCH`", "Print `<os> <arch>` and exit (CI)"],
          ],
        },
        { kind: "h2", id: "steps", text: "What the installer does" },
        {
          kind: "steps",
          items: [
            { title: "Detect platform and architecture", text: "Linux / macOS and x64 / arm64. Unsupported architectures are rejected, never guessed." },
            { title: "Download the signed manifest", text: "SHA256SUMS and SHA256SUMS.sig: GitHub first, then this site's mirror (`--cn` reverses that); each source is verified separately." },
            { title: "Verify with the embedded key", text: "The public key lives in the installer (see release signing). A mirror cannot swap it." },
            { title: "Check the artifact hash", text: "The manifest must contain both a `commit <sha> v<version>` line and the hash of this asset." },
            { title: "Back up the previous version", text: "The existing bin directory is copied aside so a failed upgrade can be undone." },
            { title: "Install and run the health check", text: "`qz --version` must exit 0 and report the target version." },
            { title: "Write the service", text: "A systemd user unit or launchd agent; a desktop entry only when a native client is present." },
          ],
        },
        {
          kind: "note",
          tone: "warn",
          text: "When the health check fails the installer rolls back both the binaries and the `installed-version` record, then exits non-zero. It never leaves a half-installed upgrade behind.",
        },
        { kind: "h2", id: "upgrade", text: "Upgrade and uninstall" },
        {
          kind: "code",
          title: "shell",
          text: `# Idempotent upgrade: running it again upgrades
curl -fsSL https://quetzal.plutokeating.beer/install | bash

# Uninstall (keep the spine, memory and settings)
curl -fsSL https://quetzal.plutokeating.beer/install | bash -s -- --uninstall

# Remove the home directory as well
curl -fsSL https://quetzal.plutokeating.beer/install | bash -s -- --uninstall --purge`,
        },
        {
          kind: "note",
          tone: "warn",
          text: "`--purge` deletes the spine, memory and settings under `QUETZALCOATL_HOME`. Export a readable ZIP with `qz export` first.",
        },
        { kind: "h2", id: "verify", text: "Verify the install" },
        {
          kind: "code",
          title: "shell",
          text: `qz --version          # must match the installed version
qz status             # daemon, spine and iroh node
qz agents             # coding agents discovered on this machine

# Linux
systemctl --user status quetzalcoatld
# macOS
launchctl print gui/$(id -u)/beer.plutokeating.quetzalcoatl`,
        },
        {
          kind: "p",
          text:
            "To re-check the signature and hash yourself without the installer, see [release signing & verification](/docs/reference/release-signing).",
        },
      ],
    },
  },
};
