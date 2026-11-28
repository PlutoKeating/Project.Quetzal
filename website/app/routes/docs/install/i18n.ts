import { GITHUB_URL, INSTALL_COMMAND } from "~/i18n/core";
import type { Messages } from "~/lib/content";

const BUILD = `git clone ${GITHUB_URL}\ncd Project.Quetzal\ncargo build -p quetzalcoatl-daemon --release`;

export const messages: Messages = {
  zh: {
    metaTitle: "安装",
    doc: {
      title: "安装",
      lead: "一行命令。装好之后，它已经接在你的宿主上。",
      blocks: [
        { kind: "h2", id: "run", step: 1, text: "运行安装命令" },
        { kind: "cmd", head: "Terminal", text: INSTALL_COMMAND },
        { kind: "p", text: "安装器会识别你的系统，下载带签名的安装包，验证通过后才安装。目前有安装包的是 Linux x64 与 arm64。" },
        { kind: "h2", id: "connect", step: 2, text: "它自己接上宿主" },
        {
          kind: "p",
          text: "安装的最后一步会自动把它接进本机已有的宿主，不需要你再做什么。首个支持的宿主是 Claude Code。之后想重接或撤销，见[接上宿主](/docs/start/connect)。",
        },
        { kind: "h2", id: "open", step: 3, text: "打开宿主，确认他在" },
        { kind: "p", text: "照常启动宿主。状态栏上有他的名字，就是接上了。想看得更细，运行诊断：" },
        { kind: "cmd", head: "Terminal", text: "qz doctor" },
        { kind: "h2", id: "what", text: "安装器做了什么" },
        { kind: "figure", id: "installer" },
        {
          kind: "p",
          text: "顺序固定：先验证签名，再核对内容，然后才安装。前一步对不上，后一步不会发生。公钥与自己动手验签的命令在[发布签名与校验](/docs/reference/release-signing)。",
        },
        { kind: "h2", id: "platforms", text: "平台" },
        {
          kind: "table",
          head: ["平台", "现状"],
          rows: [
            ["Linux x64 · arm64", "有安装包，一行命令安装"],
            ["macOS", "目前只有源码构建"],
            ["Windows", "目前只有源码构建"],
          ],
        },
        { kind: "h2", id: "source", text: "从源码构建" },
        { kind: "p", text: "macOS 与 Windows 目前从源码构建，需要 Rust 工具链。" },
        { kind: "cmd", head: "Terminal", text: BUILD },
        { kind: "p", text: "构建产出命令行与后台服务。把它们放进你的可执行路径，然后接上宿主：" },
        { kind: "cmd", head: "Terminal", text: "qz connect" },
        { kind: "h2", id: "upgrade", text: "升级与卸载" },
        { kind: "p", text: "升级就是再运行一次安装命令。" },
        { kind: "cmd", label: "卸载。你的数据默认保留：", head: "Terminal", text: `${INSTALL_COMMAND} -s -- --uninstall` },
        { kind: "cmd", label: "连同数据一起移除：", head: "Terminal", text: `${INSTALL_COMMAND} -s -- --uninstall --purge` },
      ],
    },
  },
  en: {
    metaTitle: "Install",
    doc: {
      title: "Install",
      lead: "One command. When it finishes, it is already connected to your host.",
      blocks: [
        { kind: "h2", id: "run", step: 1, text: "Run the install command" },
        { kind: "cmd", head: "Terminal", text: INSTALL_COMMAND },
        {
          kind: "p",
          text: "The installer detects your system, downloads the signed package, and installs only after verification passes. Packages exist today for Linux x64 and arm64.",
        },
        { kind: "h2", id: "connect", step: 2, text: "It connects to your host by itself" },
        {
          kind: "p",
          text: "As its last step, the installer connects it to the hosts already on this machine. There is nothing more for you to do. The first supported host is Claude Code. To reconnect or undo later, see [Connect a host](/docs/start/connect).",
        },
        { kind: "h2", id: "open", step: 3, text: "Open your host and confirm" },
        { kind: "p", text: "Start your host as usual. When the name is in the status bar, it is connected. For a closer look, run the diagnosis:" },
        { kind: "cmd", head: "Terminal", text: "qz doctor" },
        { kind: "h2", id: "what", text: "What the installer does" },
        { kind: "figure", id: "installer" },
        {
          kind: "p",
          text: "The order is fixed: verify the signature, check the contents, and only then install. If one step does not match, the next never happens. The public key and the commands to verify by hand are in [Release signing](/docs/reference/release-signing).",
        },
        { kind: "h2", id: "platforms", text: "Platforms" },
        {
          kind: "table",
          head: ["Platform", "Today"],
          rows: [
            ["Linux x64 · arm64", "packaged; one-command install"],
            ["macOS", "source build only, for now"],
            ["Windows", "source build only, for now"],
          ],
        },
        { kind: "h2", id: "source", text: "Build from source" },
        { kind: "p", text: "macOS and Windows build from source for now. You need the Rust toolchain." },
        { kind: "cmd", head: "Terminal", text: BUILD },
        { kind: "p", text: "The build produces the command line and the background service. Put them on your path, then connect a host:" },
        { kind: "cmd", head: "Terminal", text: "qz connect" },
        { kind: "h2", id: "upgrade", text: "Upgrade and uninstall" },
        { kind: "p", text: "To upgrade, run the install command again." },
        { kind: "cmd", label: "Uninstall. Your data is kept by default:", head: "Terminal", text: `${INSTALL_COMMAND} -s -- --uninstall` },
        { kind: "cmd", label: "Remove the data as well:", head: "Terminal", text: `${INSTALL_COMMAND} -s -- --uninstall --purge` },
      ],
    },
  },
};
