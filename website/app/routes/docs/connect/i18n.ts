import type { Messages } from "~/lib/content";

export const messages: Messages = {
  zh: {
    metaTitle: "接上宿主",
    doc: {
      title: "接上宿主",
      lead: "让你已经在用的工具从此认识你。接上是一条命令，撤销也是一条。",
      blocks: [
        { kind: "figure", id: "session" },
        { kind: "h2", id: "connect", step: 1, text: "接上" },
        { kind: "p", text: "安装时已经自动接过一次。之后新装了宿主，或者想重接一次，运行：" },
        { kind: "cmd", head: "Terminal", text: "qz connect" },
        { kind: "p", text: "目前支持 Claude Code、Codex、OpenCode 与 DeepSeek Harness，本机装了哪个就接哪个。Codex 会把新装的钩子标为未信任：第一次打开 Codex 时，在 /hooks 里信任 Quetzalcoatl 的钩子。OpenCode 的插件放进它自己的配置目录，由它的后台服务加载，不改你的配置文件；DeepSeek Harness 在它的用户层补丁末尾加一段带标记的插入，已经开着的 dsh 重启后生效，撤下时你自己写的部分一字不动。" },
        { kind: "h2", id: "use", step: 2, text: "照常启动宿主" },
        { kind: "p", text: "接上之后，你的用法没有任何变化。多出来的只有四件事：" },
        {
          kind: "rail",
          cols: 2,
          cells: [
            { num: "01", title: "会话开始", text: "带入他的核心。" },
            { num: "02", title: "每次提交", text: "带入与这句话相关的往事。" },
            { num: "03", title: "宿主压缩对话后", text: "核心还在。" },
            { num: "04", title: "状态栏", text: "有他的名字。" },
          ],
        },
        { kind: "h2", id: "check", step: 3, text: "确认" },
        { kind: "p", text: "诊断告诉你接上了没有；状态告诉你它是不是在运行。" },
        { kind: "cmd", head: "Terminal", text: "qz doctor\nqz status" },
        { kind: "h2", id: "failure", text: "接不上的时候" },
        { kind: "p", text: "它出故障时，宿主照常工作，只是这一轮少了他。先看诊断；需要时把它停下再启动：" },
        { kind: "cmd", head: "Terminal", text: "qz down\nqz up" },
        { kind: "h2", id: "undo", text: "撤销" },
        { kind: "p", text: "一步撤销，宿主回到接上之前的样子。" },
        { kind: "cmd", head: "Terminal", text: "qz connect --undo" },
      ],
    },
  },
  en: {
    metaTitle: "Connect a host",
    doc: {
      title: "Connect a host",
      lead: "Let the tool you already use know you from now on. One command connects it; one command undoes it.",
      blocks: [
        { kind: "figure", id: "session" },
        { kind: "h2", id: "connect", step: 1, text: "Connect" },
        { kind: "p", text: "The installer already connected it once. If you add a host later, or want to connect again, run:" },
        { kind: "cmd", head: "Terminal", text: "qz connect" },
        { kind: "p", text: "Claude Code, Codex, OpenCode and DeepSeek Harness are supported; whichever is installed gets connected. Codex marks newly installed hooks as untrusted: the first time you open Codex, trust the Quetzalcoatl hooks under /hooks. For OpenCode the plugin goes into its own config directory and its background service loads it, without touching your config file. For DeepSeek Harness a marked block is appended to its user-level patch; restart a running dsh for it to take effect, and undoing it leaves everything you wrote untouched." },
        { kind: "h2", id: "use", step: 2, text: "Start your host as usual" },
        { kind: "p", text: "Once connected, nothing about how you work changes. Only four things are new:" },
        {
          kind: "rail",
          cols: 2,
          cells: [
            { num: "01", title: "When a session starts", text: "The core goes in." },
            { num: "02", title: "On every submit", text: "Memories related to that line go in." },
            { num: "03", title: "After the host compacts", text: "The core is still there." },
            { num: "04", title: "In the status bar", text: "Your agent's name." },
          ],
        },
        { kind: "h2", id: "check", step: 3, text: "Confirm" },
        { kind: "p", text: "The diagnosis tells you whether it is connected; the status tells you whether it is running." },
        { kind: "cmd", head: "Terminal", text: "qz doctor\nqz status" },
        { kind: "h2", id: "failure", text: "When it cannot connect" },
        { kind: "p", text: "When it fails, your host keeps working as usual; that turn simply goes without your agent. Look at the diagnosis first; if needed, stop it and start it again:" },
        { kind: "cmd", head: "Terminal", text: "qz down\nqz up" },
        { kind: "h2", id: "undo", text: "Undo" },
        { kind: "p", text: "One step undoes it, and the host is back to how it was before." },
        { kind: "cmd", head: "Terminal", text: "qz connect --undo" },
      ],
    },
  },
};
