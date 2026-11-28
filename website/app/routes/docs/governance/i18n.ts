import type { Messages } from "~/lib/content";

export const messages: Messages = {
  zh: {
    metaTitle: "治理面",
    doc: {
      title: "治理面",
      lead: "一块只有「看」和「签」的界面。它没有输入框；想聊，去你的宿主。",
      blocks: [
        { kind: "figure", id: "governance" },
        { kind: "h2", id: "open", text: "打开" },
        { kind: "cmd", head: "Terminal", text: "qz open" },
        { kind: "p", text: "它在本机打开。这是低频而郑重的地方：看他是谁，签下不许变的事。日常的动作都在宿主里，一句话就够，见[在宿主里怎么用](/docs/guide/in-host)。" },
        { kind: "h2", id: "pages", text: "六页" },
        {
          kind: "rail",
          cols: 3,
          cells: [
            { num: "01", title: "他", text: "他是谁，看重什么。" },
            { num: "02", title: "我", text: "他眼里的你。" },
            { num: "03", title: "我们", text: "你们之间。" },
            { num: "04", title: "往事", text: "聊过的事，每一条都带出处。" },
            { num: "05", title: "设备", text: "他在哪些设备上。" },
            { num: "06", title: "记录", text: "发生过什么，按时间排开。" },
          ],
        },
        { kind: "h2", id: "sign", text: "亲手签下你的底线" },
        { kind: "p", text: "底线是无论谁说什么都不变的那几条。它在权威等级的最上面，只能由你亲手签署。" },
        { kind: "p", text: "这是治理面存在的首要理由：有些事不该由一次对话决定，也不该由他自己决定。" },
        { kind: "h2", id: "no-input", text: "为什么没有输入框" },
        { kind: "p", text: "对话属于宿主。治理面上的每一处，要么给你看，要么等你签。所以它不会变成另一个聊天框。" },
      ],
    },
  },
  en: {
    metaTitle: "Governance view",
    doc: {
      title: "Governance view",
      lead: "An interface with only two verbs: look and sign. It has no input box. To talk, go to your host.",
      blocks: [
        { kind: "figure", id: "governance" },
        { kind: "h2", id: "open", text: "Open it" },
        { kind: "cmd", head: "Terminal", text: "qz open" },
        { kind: "p", text: "It opens on this machine. This is a place for rare, deliberate things: seeing who your agent is, and signing what must not change. Everyday actions stay in the host, one sentence each; see [Inside the host](/docs/guide/in-host)." },
        { kind: "h2", id: "pages", text: "Six pages" },
        {
          kind: "rail",
          cols: 3,
          cells: [
            { num: "01", title: "Agent", text: "Who your agent is, and what it values." },
            { num: "02", title: "Me", text: "You, as your agent sees you." },
            { num: "03", title: "Us", text: "What is between you." },
            { num: "04", title: "Memories", text: "What was said, each item with its source." },
            { num: "05", title: "Devices", text: "The devices your agent lives on." },
            { num: "06", title: "Records", text: "What happened, in order of time." },
          ],
        },
        { kind: "h2", id: "sign", text: "Sign your bottom lines by hand" },
        { kind: "p", text: "Bottom lines are the few things that do not change, whoever says otherwise. They sit at the top of the authority levels, and only you can sign them." },
        { kind: "p", text: "This is the first reason the governance view exists: some things should not be decided by one conversation, nor by your agent alone." },
        { kind: "h2", id: "no-input", text: "Why there is no input box" },
        { kind: "p", text: "Conversation belongs to the host. Everything in the governance view is either shown to you or waiting for your signature. So it never turns into another chat box." },
      ],
    },
  },
};
