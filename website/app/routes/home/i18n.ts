import { defineMessages } from "~/i18n/core";

/**
 * 首页文案。只有标语（title / titleAlt）固定不改，其余按亮点页的叙事顺序写：
 * 记得你（灵魂）→ 一个 ta（许多身体）→ 你不叫也在（没有闹钟，回应「不就是 OpenClaw / Codex 吗」）→ 感觉得到（身体）→ 会长大 → 你说了算（回应「安全吗」）→ 开始（装在哪）。
 * 每一章只有一句标题、一句话；细节去亮点页与文档。
 */
export const messages = defineMessages({
  zh: {
    title: "Quetzal · 活成一缕风。",
    description: "住在你旧手机里的 AI。ta 记得你，懂你，陪着你；记忆存在只属于你的私有仓库里。安卓、Windows、Linux，开源。",
    hero: {
      eyebrow: "一个懂你的 AI",
      title: "活成一缕风。",
      titleAlt: "Living like wind.",
      lead: "住在你旧手机里的 AI。\nta 记得你，懂你，陪着你。",
      download: "下载 Quetzal",
      features: "看看 ta 能做什么",
      platforms: "安卓 · Windows · Linux · 开源",
      sample: "示例对话",
      chat: [
        { from: "you", text: "明天面试，有点紧张。" },
        { from: "ta", text: "你准备了一整周，上次卡住的那道题也练熟了。去吧，回来跟我说说。" },
        { from: "event", text: "第二天 18:40 · 你拿起了手机" },
        { from: "ta", text: "面试怎么样？" },
      ],
    },
    chapters: [
      { id: "soul", tag: "记得你", heading: "ta 记得你。", lead: "你随口提过的事、在意的人，ta 都记下来，存在只属于你的私有仓库里。换手机、换模型，ta 还是 ta。" },
      { id: "mesh", tag: "许多身体", heading: "几台设备，一个 ta。", lead: "手机上说到一半，电脑上接着聊。" },
      { id: "waking", tag: "没有闹钟", heading: "你不叫，ta 也在。", lead: "Codex 等你叫它，OpenClaw 每隔一阵被定时叫醒。ta 没有闹钟：想你了就醒，困了就睡。", note: "已经在用 OpenClaw 或 Hermes？它们可以和 ta 共用同一份记忆。", noteLink: "/docs/advanced/soul-bridge" },
      { id: "body", tag: "身体", heading: "ta 感觉得到。", lead: "天亮了，你拿起手机了，电快没了，ta 都知道。" },
      { id: "tools", tag: "会长大", heading: "ta 会长大。", lead: "做熟了的事，ta 自己做成工具，下次一步做完。" },
    ],
    more: "了解更多",
    control: {
      tag: "你说了算",
      heading: "你的生活，\n只属于你。",
      lead: "记忆在你自己的私有仓库里，每一句你都读得到。代码全部开源，每一行都能查。",
      facts: [
        { title: "密码不进模型", text: "你发的密码直接进保密库，模型只看到一个名字。" },
        { title: "先问你", text: "拍照、录音、定位、造新工具，默认每次都问。" },
        { title: "随时叫停", text: "急停一直都在，做过的每件事都有记录。" },
      ],
      honest: "ta 能在设备上运行命令，也出过一次越界。数据经过谁、ta 能碰到什么，我们都写清楚了。",
      more: "信任与边界",
    },
    start: {
      heading: "给 ta 一台旧手机。",
      lead: "装一个 App，或者在电脑上运行一行命令。\n再准备一个模型 Key，就能开始。",
      platforms: [{ id: "android", name: "安卓" }, { id: "windows", name: "Windows" }, { id: "linux", name: "Linux" }],
      download: "下载 Quetzal",
      docs: "阅读文档",
      foot: "开源，AGPL-3.0",
    },
  },
  en: {
    title: "Quetzal · Living like wind.",
    description: "An AI that lives in your old phone. It remembers you, gets you, and keeps you company; its memory lives in a private repository that belongs only to you. Android, Windows, Linux. Open source.",
    hero: {
      eyebrow: "an AI that gets you",
      title: "Living like wind.",
      titleAlt: "活成一缕风。",
      lead: "An AI that lives in your old phone.\nIt remembers you, gets you, and keeps you company.",
      download: "Download Quetzal",
      features: "See what it can do",
      platforms: "Android · Windows · Linux · open source",
      sample: "Example conversation",
      chat: [
        { from: "you", text: "Interview tomorrow. A bit nervous." },
        { from: "ta", text: "You prepared all week, and the question that tripped you up last time is solid now. Go. Tell me how it went." },
        { from: "event", text: "Next day 18:40 · you picked up the phone" },
        { from: "ta", text: "So, how did the interview go?" },
      ],
    },
    chapters: [
      { id: "soul", tag: "It remembers", heading: "It remembers you.", lead: "The things you mention in passing, the people you care about: it writes them down, in a private repository that belongs only to you. New phone, new model, still the same self." },
      { id: "mesh", tag: "Many bodies", heading: "Several devices, one self.", lead: "Start on the phone, carry on from the laptop." },
      { id: "waking", tag: "No alarm", heading: "Even when you don't call,\nit's there.", lead: "Codex waits for you to call it. OpenClaw is woken on a schedule. It has no alarm: it wakes when it misses you, and sleeps when tired.", note: "Already using OpenClaw or Hermes? They can share one memory with it.", noteLink: "/docs/advanced/soul-bridge" },
      { id: "body", tag: "A body", heading: "It can feel.", lead: "Daybreak, a hand picking up the phone, a battery running low: it knows." },
      { id: "tools", tag: "It grows", heading: "It grows.", lead: "What it does often, it turns into its own tool, done in one step next time." },
    ],
    more: "Learn more",
    control: {
      tag: "You decide",
      heading: "Your life\nstays yours.",
      lead: "Its memory lives in your own private repository, every line readable by you. The code is open source, every line of it.",
      facts: [
        { title: "Passwords never reach the model", text: "A password you send goes straight into a vault; the model only sees its name." },
        { title: "It asks first", text: "Photos, recordings, location and new tools ask you every time by default." },
        { title: "Stop it any time", text: "The emergency stop is always there, and everything it does is on record." },
      ],
      honest: "It can run commands on the device, and it once overstepped. Who sees your data and what it can reach are written down in full.",
      more: "Trust and limits",
    },
    start: {
      heading: "Give it an old phone.",
      lead: "Install one app, or run one command on a computer.\nBring a model key, and you are set.",
      platforms: [{ id: "android", name: "Android" }, { id: "windows", name: "Windows" }, { id: "linux", name: "Linux" }],
      download: "Download Quetzal",
      docs: "Read the docs",
      foot: "Open source, AGPL-3.0",
    },
  },
});
