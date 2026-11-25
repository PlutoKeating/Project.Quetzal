import type { Messages } from "~/lib/content";

export const messages: Messages = {
  zh: {
    metaTitle: "Windows（WinUI 3）",
    doc: {
      title: "Windows：WinUI 3 原生表面",
      description: "C# / .NET 9 的 WinUI 3 Fluent 客户端、两个计划任务与 %LOCALAPPDATA% 下的脊柱。",
      lead:
        "Windows 端是 C# / .NET 9 写的纯原生 WinUI 3 应用，使用系统 Fluent 控件；后台守护由两个计划任务在开机与登录时拉起，不常驻托盘偷偷提权。",
      blocks: [
        { kind: "h2", id: "requirements", text: "系统要求" },
        {
          kind: "ul",
          items: [
            "Windows 10 1809+ 或 Windows 11，x64 或 arm64",
            "PowerShell 5.1 及以上（系统自带即可）",
            "安装目录 `%LOCALAPPDATA%\\Quetzalcoatl`，不需要管理员权限",
          ],
        },
        { kind: "h2", id: "install", text: "安装" },
        {
          kind: "code",
          title: "powershell",
          text: `irm https://quetzal.plutokeating.beer/install.ps1 | iex

# 指定版本
$env:QUETZALCOATL_VERSION = '0.1.0'
irm https://quetzal.plutokeating.beer/install.ps1 | iex`,
        },
        {
          kind: "p",
          text:
            "安装器先用内置公钥验证 `SHA256SUMS` 的 Ed25519 签名，再核对 zip 的 SHA-256；解压后跑一次 `qz.exe --version` 健康检查，失败则恢复上一个版本。验签与哈希逻辑由 .NET 的 `BigInteger` 实现（Windows PowerShell 5.1 没有内置 Ed25519 API）。",
        },
        { kind: "h2", id: "tasks", text: "两个计划任务，各司其职" },
        {
          kind: "table",
          head: ["任务", "触发", "作用"],
          rows: [
            ["`\\Quetzalcoatl\\Runtime-Boot`", "系统启动", "无需登录就把脊柱节点拉起来，供手机与其它机器连接"],
            ["`\\Quetzalcoatl\\Runtime-Logon`", "用户登录", "在用户态补齐凭据与钥匙串，保证网关能换出站令牌"],
          ],
        },
        {
          kind: "code",
          title: "powershell",
          text: `Get-ScheduledTask -TaskPath '\\Quetzalcoatl\\'
Get-ScheduledTaskInfo -TaskPath '\\Quetzalcoatl\\' -TaskName 'Runtime-Boot'
qz status`,
        },
        {
          kind: "note",
          text:
            "两个任务都以当前用户、受限权限注册。注册失败时安装器会打印 `Register-ScheduledTask` 的命令并提示你手动执行，不会静默请求管理员权限。",
        },
        { kind: "h2", id: "files", text: "文件位置" },
        {
          kind: "table",
          head: ["项目", "位置"],
          rows: [
            ["二进制", "`%LOCALAPPDATA%\\Quetzalcoatl\\bin`"],
            ["脊柱", "`%LOCALAPPDATA%\\Quetzalcoatl\\spine.sqlite`"],
            ["日志", "`%LOCALAPPDATA%\\Quetzalcoatl\\logs`"],
            ["计划任务记录", "`%LOCALAPPDATA%\\Quetzalcoatl\\service\\tasks.json`"],
          ],
        },
        { kind: "h2", id: "appcontrol", text: "Smart App Control 与应用控制" },
        {
          kind: "p",
          text:
            "启用了 Smart App Control 或应用控制策略的机器可能拦截未取得信任的 exe。安装器会检测并明确说明是哪一道策略拦下的；它不会修改系统策略来绕过。企业环境请让管理员按组织规则放行。",
        },
        { kind: "h2", id: "uninstall", text: "卸载" },
        {
          kind: "code",
          title: "powershell",
          text: `irm https://quetzal.plutokeating.beer/install.ps1 -OutFile install.ps1
.\\install.ps1 -Uninstall          # 保留脊柱与记忆
.\\install.ps1 -Uninstall -Purge   # 连家目录一起删`,
        },
        {
          kind: "note",
          tone: "warn",
          text: "`-Purge` 会删除 `%LOCALAPPDATA%\\Quetzalcoatl` 下的脊柱、记忆与设置，请先 `qz export` 备份。",
        },
      ],
    },
  },
  en: {
    metaTitle: "Windows (WinUI 3)",
    doc: {
      title: "Windows: a native WinUI 3 surface",
      description: "A C# / .NET 9 WinUI 3 Fluent client, two scheduled tasks and a spine under %LOCALAPPDATA%.",
      lead:
        "The Windows surface is a native WinUI 3 app written in C# / .NET 9 using the system Fluent controls. Two scheduled tasks start the daemon at boot and at logon; nothing quietly elevates from the tray.",
      blocks: [
        { kind: "h2", id: "requirements", text: "Requirements" },
        {
          kind: "ul",
          items: [
            "Windows 10 1809+ or Windows 11, x64 or arm64",
            "PowerShell 5.1 or newer (the built-in one is fine)",
            "Installs into `%LOCALAPPDATA%\\Quetzalcoatl`; no administrator rights required",
          ],
        },
        { kind: "h2", id: "install", text: "Install" },
        {
          kind: "code",
          title: "powershell",
          text: `irm https://quetzal.plutokeating.beer/install.ps1 | iex

# Pin a version
$env:QUETZALCOATL_VERSION = '0.1.0'
irm https://quetzal.plutokeating.beer/install.ps1 | iex`,
        },
        {
          kind: "p",
          text:
            "The installer verifies the Ed25519 signature on `SHA256SUMS` with the embedded key, checks the zip's SHA-256, extracts, then runs `qz.exe --version` as a health check. On failure it restores the previous version. Signature and hash verification uses .NET `BigInteger` because Windows PowerShell 5.1 has no built-in Ed25519 API.",
        },
        { kind: "h2", id: "tasks", text: "Two scheduled tasks, two jobs" },
        {
          kind: "table",
          head: ["Task", "Trigger", "Purpose"],
          rows: [
            ["`\\Quetzalcoatl\\Runtime-Boot`", "System startup", "Brings the spine node up before anyone logs in, so phones and other machines can connect"],
            ["`\\Quetzalcoatl\\Runtime-Logon`", "User logon", "Restores user-scope credentials and the keychain so the gateway can swap outbound tokens"],
          ],
        },
        {
          kind: "code",
          title: "powershell",
          text: `Get-ScheduledTask -TaskPath '\\Quetzalcoatl\\'
Get-ScheduledTaskInfo -TaskPath '\\Quetzalcoatl\\' -TaskName 'Runtime-Boot'
qz status`,
        },
        {
          kind: "note",
          text:
            "Both tasks are registered for the current user with limited privileges. If registration fails the installer prints the `Register-ScheduledTask` command for you to run — it never asks for elevation on its own.",
        },
        { kind: "h2", id: "files", text: "File locations" },
        {
          kind: "table",
          head: ["Item", "Location"],
          rows: [
            ["Binaries", "`%LOCALAPPDATA%\\Quetzalcoatl\\bin`"],
            ["Spine", "`%LOCALAPPDATA%\\Quetzalcoatl\\spine.sqlite`"],
            ["Logs", "`%LOCALAPPDATA%\\Quetzalcoatl\\logs`"],
            ["Task record", "`%LOCALAPPDATA%\\Quetzalcoatl\\service\\tasks.json`"],
          ],
        },
        { kind: "h2", id: "appcontrol", text: "Smart App Control" },
        {
          kind: "p",
          text:
            "Machines with Smart App Control or an application-control policy may block an untrusted exe. The installer detects this and says which policy blocked it; it never edits system policy to get around it. In managed environments ask your administrator to allow it under your organisation's rules.",
        },
        { kind: "h2", id: "uninstall", text: "Uninstall" },
        {
          kind: "code",
          title: "powershell",
          text: `irm https://quetzal.plutokeating.beer/install.ps1 -OutFile install.ps1
.\\install.ps1 -Uninstall          # keep the spine and memory
.\\install.ps1 -Uninstall -Purge   # remove the home directory too`,
        },
        {
          kind: "note",
          tone: "warn",
          text: "`-Purge` deletes the spine, memory and settings under `%LOCALAPPDATA%\\Quetzalcoatl`. Run `qz export` first.",
        },
      ],
    },
  },
};
