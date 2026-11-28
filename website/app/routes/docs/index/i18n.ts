import { INSTALL_COMMAND, type Lang } from "~/i18n/core";
import type { PageMessages } from "~/lib/content";

type IndexMessages = PageMessages & { directory: string };

export const messages: Record<Lang, IndexMessages> = {
  zh: {
    metaTitle: "文档",
    directory: "按你要做的事找",
    doc: {
      title: "文档",
      lead: "从一行安装到打开宿主看见他，只有三步。其余的页面，等你需要时再读。",
      blocks: [
        { kind: "figure", id: "journey" },
        {
          kind: "p",
          text: "Quetzalcoatl 是你的 Agent 的海：他的人格、价值、关系与记忆，带权威等级并签名，跟着你的设备走。它接在你已经在用的宿主上，不做聊天框，也不做自己的 agent 框架。",
        },
        { kind: "h2", id: "start", text: "现在就开始" },
        { kind: "cmd", label: "在终端里运行：", head: "Terminal", text: INSTALL_COMMAND },
        {
          kind: "p",
          text: "安装的最后一步会自动把它接进本机已有的宿主。接着照常启动宿主：状态栏上有他的名字，就是接上了。每一步的细节在[安装](/docs/start/install)与[接上宿主](/docs/start/connect)。",
        },
        { kind: "h2", id: "pages", text: "全部页面" },
      ],
    },
  },
  en: {
    metaTitle: "Documentation",
    directory: "Find it by what you want to do",
    doc: {
      title: "Documentation",
      lead: "Three steps take you from a one-line install to opening your host and finding your agent there. Read the other pages when you need them.",
      blocks: [
        { kind: "figure", id: "journey" },
        {
          kind: "p",
          text: "Quetzalcoatl is the sea beneath your agent: character, values, relationships and memories, ranked by authority, signed, and living on your devices. It connects to the host you already use. It is not a chat box, and not an agent framework of its own.",
        },
        { kind: "h2", id: "start", text: "Start now" },
        { kind: "cmd", label: "Run this in a terminal:", head: "Terminal", text: INSTALL_COMMAND },
        {
          kind: "p",
          text: "As its last step, the installer connects it to the hosts already on this machine. Then start your host as usual: when the name is in the status bar, it is connected. The details of each step are in [Install](/docs/start/install) and [Connect a host](/docs/start/connect).",
        },
        { kind: "h2", id: "pages", text: "All pages" },
      ],
    },
  },
};
