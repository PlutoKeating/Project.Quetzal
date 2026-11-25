import type { Messages } from "~/lib/content";

export const messages: Messages = {
  zh: {
    metaTitle: "文档",
    doc: {
      title: "Quetzalcoatl 文档",
      description: "从一行安装到良知、群组、脊柱备份与发布签名，按你需要解决的问题组织。",
      lead:
        "这份文档按「你要解决什么问题」组织，而不是按代码目录。第一次来，从安装开始；要确认它凭什么可信，读良知与发布签名；要把记忆搬走，读脊柱与备份。",
      blocks: [
        { kind: "h2", id: "quickstart", text: "五分钟上手" },
        {
          kind: "code",
          title: "shell",
          text: `# Linux / macOS
curl -fsSL https://quetzal.plutokeating.beer/install | bash
qz up
qz status
qz chat`,
        },
        {
          kind: "p",
          text:
            "Windows 用 `irm https://quetzal.plutokeating.beer/install.ps1 | iex`。安装器会先验签再装；`qz status` 应显示守护进程在线、脊柱水位在推进。",
        },
        {
          kind: "note",
          text:
            "本机已装的 OpenCode V2 / Claude Code / Codex 会被自动嗅探并纳管；不需要卸载它们，也不需要把订阅令牌交给 Quetzalcoatl。",
        },
      ],
    },
  },
  en: {
    metaTitle: "Documentation",
    doc: {
      title: "Quetzalcoatl documentation",
      description: "From the one-line install to conscience, groups, spine backups and release signing — organised by the problem you have.",
      lead:
        "These docs are organised by the problem you are solving, not by directory layout. New here? Start with installation. Want to know why it can be trusted? Read conscience and release signing. Moving your memory? Read the spine page.",
      blocks: [
        { kind: "h2", id: "quickstart", text: "Five-minute start" },
        {
          kind: "code",
          title: "shell",
          text: `# Linux / macOS
curl -fsSL https://quetzal.plutokeating.beer/install | bash
qz up
qz status
qz chat`,
        },
        {
          kind: "p",
          text:
            "On Windows use `irm https://quetzal.plutokeating.beer/install.ps1 | iex`. The installer verifies before it writes; `qz status` should show the daemon online and the spine watermark moving.",
        },
        {
          kind: "note",
          text:
            "OpenCode V2 / Claude Code / Codex already installed on this machine are discovered and managed automatically. You do not need to uninstall them or hand your subscription tokens to Quetzalcoatl.",
        },
      ],
    },
  },
};
