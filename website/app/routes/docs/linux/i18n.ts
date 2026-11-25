import type { Messages } from "~/lib/content";

export const messages: Messages = {
  zh: {
    metaTitle: "Linux（GTK4）",
    doc: {
      title: "Linux：GTK4 原生表面",
      description: "gtk4-rs 与动态 libadwaita 的三档认知密度客户端，systemd 用户服务托管 quetzalcoatld。",
      lead:
        "Linux 端是用 Rust 写的 GTK4 原生窗口，动态链接系统 libadwaita，没有 Electron、Tauri 或任何 WebView 套壳。后台守护由 systemd 用户服务托管。",
      blocks: [
        { kind: "h2", id: "requirements", text: "系统要求" },
        {
          kind: "ul",
          items: [
            "glibc 2.31+，x86_64 或 arm64",
            "GTK 4.14+ 与 libadwaita 1.9+（动态链接，符合 LGPL-2.1 边界）",
            "Wayland 或 X11 会话；无界面机器见「服务器与无界面机器」",
            "systemd 用户实例；没有 systemd 时安装器只写单元文件",
          ],
        },
        {
          kind: "table",
          head: ["发行版", "包"],
          rows: [
            ["Debian / Ubuntu", "`libgtk-4-1` `libadwaita-1-0` `xdg-utils`"],
            ["Fedora", "`gtk4` `libadwaita` `xdg-utils`"],
            ["Arch", "`gtk4` `libadwaita` `xdg-utils`"],
          ],
        },
        { kind: "h2", id: "install", text: "安装与启动" },
        {
          kind: "code",
          title: "shell",
          text: `curl -fsSL https://quetzal.plutokeating.beer/install | bash
systemctl --user enable --now quetzalcoatld
qz status`,
        },
        {
          kind: "p",
          text:
            "安装器把 `qz`、`quetzalcoatld` 与 `quetzalcoatl-sandbox-exec` 放进 `~/.local/bin`，并写 `~/.config/systemd/user/quetzalcoatld.service`。桌面快捷方式只在归档里带原生客户端时才写；`--no-desktop` 可以强制不写。",
        },
        { kind: "h2", id: "density", text: "三档认知密度" },
        {
          kind: "table",
          head: ["档位", "给谁", "界面上有什么"],
          rows: [
            ["伴生极简态", "日常对话与记录", "一条输入、最近的记忆与关怀提醒，没有仪表盘"],
            ["承诺与群组工作台态", "家庭 / 团队协作", "群房间、承诺清单、共享角色与水位线"],
            ["主权工程态", "研发与高危操作", "运行记录、洁净室验收、diff、技能演化与审计事件"],
          ],
        },
        { kind: "h2", id: "files", text: "服务、文件与日志" },
        {
          kind: "table",
          head: ["项目", "位置"],
          rows: [
            ["二进制", "`~/.local/bin/{qz,quetzalcoatld,quetzalcoatl-sandbox-exec}`"],
            ["家目录", "`~/.quetzalcoatl`（`QUETZALCOATL_HOME`）"],
            ["systemd 单元", "`~/.config/systemd/user/quetzalcoatld.service`"],
            ["日志", "`journalctl --user -u quetzalcoatld -f`"],
            ["安装状态", "`~/.local/share/quetzalcoatl/installed-version`"],
          ],
        },
        { kind: "h2", id: "headless", text: "无头与 CI" },
        {
          kind: "p",
          text:
            "没有图形会话的机器上，`qz` 与守护进程照常工作；原生窗口可以用 `xvfb-run -a` 在 CI 里跑冒烟。窗口只负责展示，脊柱与网关都在守护进程里。",
        },
        { kind: "h2", id: "uninstall", text: "卸载" },
        {
          kind: "code",
          title: "shell",
          text: `curl -fsSL https://quetzal.plutokeating.beer/install | bash -s -- --uninstall
# 连脊柱、记忆与设置一起删
curl -fsSL https://quetzal.plutokeating.beer/install | bash -s -- --uninstall --purge`,
        },
        {
          kind: "note",
          tone: "warn",
          text: "原生客户端与守护进程必须来自同一版本；混装时客户端会拒绝连接并在 `qz status` 里报出版本不一致。",
        },
      ],
    },
  },
  en: {
    metaTitle: "Linux (GTK4)",
    doc: {
      title: "Linux: a native GTK4 surface",
      description: "A gtk4-rs client with dynamically linked libadwaita and three cognitive densities; quetzalcoatld runs as a systemd user service.",
      lead:
        "The Linux surface is a native GTK4 window written in Rust, linking the system libadwaita dynamically. No Electron, no Tauri, no WebView shell. The daemon is supervised by a systemd user service.",
      blocks: [
        { kind: "h2", id: "requirements", text: "Requirements" },
        {
          kind: "ul",
          items: [
            "glibc 2.31+, x86_64 or arm64",
            "GTK 4.14+ and libadwaita 1.9+ (dynamically linked, keeping the LGPL-2.1 boundary intact)",
            "A Wayland or X11 session; headless machines are covered in “servers and headless machines”",
            "A systemd user instance; without it the installer writes the unit but does not enable it",
          ],
        },
        {
          kind: "table",
          head: ["Distribution", "Packages"],
          rows: [
            ["Debian / Ubuntu", "`libgtk-4-1` `libadwaita-1-0` `xdg-utils`"],
            ["Fedora", "`gtk4` `libadwaita` `xdg-utils`"],
            ["Arch", "`gtk4` `libadwaita` `xdg-utils`"],
          ],
        },
        { kind: "h2", id: "install", text: "Install and start" },
        {
          kind: "code",
          title: "shell",
          text: `curl -fsSL https://quetzal.plutokeating.beer/install | bash
systemctl --user enable --now quetzalcoatld
qz status`,
        },
        {
          kind: "p",
          text:
            "The installer puts `qz`, `quetzalcoatld` and `quetzalcoatl-sandbox-exec` into `~/.local/bin` and writes `~/.config/systemd/user/quetzalcoatld.service`. A desktop entry is written only when the archive carries a native client; `--no-desktop` disables it.",
        },
        { kind: "h2", id: "density", text: "Three cognitive densities" },
        {
          kind: "table",
          head: ["Density", "For", "What it shows"],
          rows: [
            ["Companion", "Everyday chat and notes", "One input, recent memory and care nudges; no dashboard"],
            ["Commit and group desk", "Family / team work", "Group rooms, commitments, shared roles and watermarks"],
            ["Sovereign engineering", "Development and high-risk work", "Runs, clean-room acceptance, diffs, skill evolution and audit events"],
          ],
        },
        { kind: "h2", id: "files", text: "Service, files and logs" },
        {
          kind: "table",
          head: ["Item", "Location"],
          rows: [
            ["Binaries", "`~/.local/bin/{qz,quetzalcoatld,quetzalcoatl-sandbox-exec}`"],
            ["Home", "`~/.quetzalcoatl` (`QUETZALCOATL_HOME`)"],
            ["systemd unit", "`~/.config/systemd/user/quetzalcoatld.service`"],
            ["Logs", "`journalctl --user -u quetzalcoatld -f`"],
            ["Install state", "`~/.local/share/quetzalcoatl/installed-version`"],
          ],
        },
        { kind: "h2", id: "headless", text: "Headless and CI" },
        {
          kind: "p",
          text:
            "On a machine without a graphical session, `qz` and the daemon work as usual; the native window can be smoke-tested in CI with `xvfb-run -a`. The window only renders — the spine and gateway live in the daemon.",
        },
        { kind: "h2", id: "uninstall", text: "Uninstall" },
        {
          kind: "code",
          title: "shell",
          text: `curl -fsSL https://quetzal.plutokeating.beer/install | bash -s -- --uninstall
# also remove the spine, memory and settings
curl -fsSL https://quetzal.plutokeating.beer/install | bash -s -- --uninstall --purge`,
        },
        {
          kind: "note",
          tone: "warn",
          text: "The native client and the daemon must come from the same version. A mixed install refuses to connect and `qz status` reports the mismatch.",
        },
      ],
    },
  },
};
