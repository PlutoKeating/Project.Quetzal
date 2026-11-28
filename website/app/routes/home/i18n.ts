import type { Lang } from "~/i18n/core";
import type { RailCell } from "~/lib/content";

export type HomeMessages = {
  metaTitle: string;
  metaDescription: string;
  hero: { title: string; lead: string; docs: string; meta: string[] };
  stage: { label: string; host: string; sea: string; steps: string[] };
  loop: { title: string; lead: string; cells: RailCell[] };
  layers: {
    title: string;
    lead: string;
    head: { name: string; meta: string };
    cells: RailCell[];
    saying: string;
    all: string;
  };
  not: { title: string; lead: string; also: string };
  close: { title: string; note: string; install: string; download: string };
};

const zh: HomeMessages = {
  metaTitle: "Quetzalcoatl · 你的 Agent 的海",
  metaDescription:
    "Quetzalcoatl 保管你的 Agent 的人格、价值、关系与记忆，带权威等级并签名，跟着你的设备走。它接在你已经在用的宿主上，不做聊天框。",
  hero: {
    title: "你的 Agent 的海",
    lead: "他的人格、价值、关系与记忆，带权威等级并签名，跟着你的设备走。在你已经在用的宿主每次调用模型之前送进去，调用之后把输出当信号，经独立审查才写回。",
    docs: "阅读文档",
    meta: ["Linux x64 / arm64", "macOS 与 Windows 从源码构建"],
  },
  stage: {
    label: "展示：左边是你的宿主，右边是海",
    host: "你的宿主",
    sea: "海 · 在你的设备上",
    steps: ["会话开始，带入他的核心", "每次提交，带入相关往事", "宿主压缩对话后，核心还在"],
  },
  loop: {
    title: "每一次调用，前后各一步",
    lead: "对话和推理留在你的宿主里。它只在模型调用的两端各做一件事，中间那一步始终是宿主的。",
    cells: [
      { num: "01", title: "调用之前，送进去", text: "会话开始带入他的核心，每次提交带入相关的往事。你什么都不用做。" },
      { num: "02", title: "调用之后，当信号", text: "模型的输出不直接成为记忆。它只是一条信号，等待审查。" },
      { num: "03", tone: "ice", title: "审查之后，才写回", text: "信号经过独立审查，才写进海里。下一次，他就知道了。", accent: true },
    ],
  },
  layers: {
    title: "手边只有四层",
    lead: "它没有自己的主界面。你碰到它的地方，按离手的远近只有四处，日常的事不出第一层。",
    head: { name: "离手的距离", meta: "近 → 远" },
    cells: [
      {
        num: "01",
        title: "宿主内",
        text: "一切日常动作，都是对他说的一句话：记住、纠正、别再提、抹除、看出处、无痕。",
        line: { kind: "say", text: "别再提这个了。" },
      },
      { num: "02", title: "系统层", text: "需要你、而你此刻不在宿主里的事，会在这里找到你。", line: { kind: "note", text: "这一层随后到来" } },
      { num: "03", title: "治理面", text: "只有看和签，没有输入框。看他是谁，亲手签下你的底线。", line: { kind: "cmd", text: "qz open" } },
      { num: "04", title: "终端一行", text: "接上、诊断、带走。低频，但都只要一行。", line: { kind: "cmd", text: "qz connect · qz doctor · qz export" } },
    ],
    saying: "记住：周四下午不排会。",
    all: "六句话都在这里",
  },
  not: {
    title: "它不是什么",
    lead: "它不和你的宿主抢位置。又一个聊天框会带来的三件事，它一件都不做。",
    also: "这一版同样没有语音，也没有手机 App。",
  },
  close: {
    title: "打开你的宿主，他在了。",
    note: "一行命令装好，最后一步自动接进本机已有的宿主。",
    install: "从安装开始",
    download: "下载",
  },
};

const en: HomeMessages = {
  metaTitle: "Quetzalcoatl · The sea beneath your agent",
  metaDescription:
    "Quetzalcoatl keeps your agent's character, values, relationships and memories: ranked by authority, signed, and living on your devices. It connects to the host you already use. It is not a chat box.",
  hero: {
    title: "The sea beneath your agent",
    lead: "Character, values, relationships and memories: ranked by authority, signed, and living on your devices. Sent into the host you already use before every model call. Afterwards the output is treated as a signal, and written back only after independent review.",
    docs: "Read the docs",
    meta: ["Linux x64 / arm64", "macOS and Windows build from source"],
  },
  stage: {
    label: "Showcase: your host on the left, the sea on the right",
    host: "Your host",
    sea: "The sea · on your devices",
    steps: ["Session starts: the core goes in", "Every submit: related memories go in", "After the host compacts the conversation, the core is still there"],
  },
  loop: {
    title: "One step before each call, one after",
    lead: "Conversation and reasoning stay in your host. It does one thing on each side of a model call. The call itself always belongs to the host.",
    cells: [
      { num: "01", title: "Before the call, sent in", text: "The core goes in when a session starts; related memories go in with every submit. You do nothing." },
      { num: "02", title: "After the call, a signal", text: "The model's output does not become memory directly. It is only a signal, waiting for review." },
      { num: "03", tone: "ice", title: "After review, written back", text: "The signal passes independent review before it is written into the sea. Next time, your agent knows.", accent: true },
    ],
  },
  layers: {
    title: "Four places within reach",
    lead: "It has no main interface of its own. You touch it in four places, ordered by distance from your hand. Everyday things never leave the first.",
    head: { name: "Distance from your hand", meta: "near → far" },
    cells: [
      {
        num: "01",
        title: "Inside the host",
        text: "Everything everyday is one sentence to your agent: remember, correct, stop bringing it up, erase, show sources, off the record.",
        line: { kind: "say", text: "Stop bringing this up." },
      },
      { num: "02", title: "System layer", text: "Things that need you while you are away from the host find you here.", line: { kind: "note", text: "this layer arrives later" } },
      { num: "03", title: "Governance view", text: "Look and sign; there is no input box. See who your agent is, and sign your bottom lines by hand.", line: { kind: "cmd", text: "qz open" } },
      { num: "04", title: "One line in the terminal", text: "Connect, diagnose, take it with you. Rare, and always one line.", line: { kind: "cmd", text: "qz connect · qz doctor · qz export" } },
    ],
    saying: "Remember: no meetings on Thursday afternoons.",
    all: "All six sentences",
  },
  not: {
    title: "What it is not",
    lead: "It does not compete with your host. One more chat box would bring three things; it does none of them.",
    also: "This release also has no voice and no phone app.",
  },
  close: {
    title: "Open your host. Your agent is there.",
    note: "One command installs it; the last step connects it to the hosts already on this machine.",
    install: "Start with install",
    download: "Download",
  },
};

export const messages: Record<Lang, HomeMessages> = { zh, en };
