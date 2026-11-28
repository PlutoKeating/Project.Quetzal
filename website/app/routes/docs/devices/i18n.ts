import { officialHubNote } from "~/i18n/hub";
import type { Messages } from "~/lib/content";

export const messages: Messages = {
  zh: {
    metaTitle: "多设备",
    doc: {
      title: "多设备",
      lead: "新设备上是同一个他。设备之间经 Hub 同步，Hub 看到的只有密文。",
      blocks: [
        { kind: "figure", id: "topology" },
        { kind: "h2", id: "hub", text: "先有一个 Hub" },
        { kind: "p", text: `${officialHubNote.zh}自建的步骤见[自建 Hub](/docs/advanced/self-host-hub)。` },
        { kind: "h2", id: "login", step: 1, text: "两台设备登录同一个 Hub" },
        { kind: "cmd", label: "登录官方 Hub（第一次登录时设定登录口令）：", head: "Terminal", text: "qz login" },
        { kind: "p", text: "用自建的 Hub 时加上地址：qz login --hub https://hub.example.com。" },
        { kind: "h2", id: "start", step: 2, text: "在已有的设备上发起配对" },
        { kind: "cmd", head: "Terminal", text: "qz pair start" },
        { kind: "p", text: "它给出一段配对码。" },
        { kind: "h2", id: "join", step: 3, text: "在新设备上加入" },
        { kind: "cmd", head: "Terminal", text: "qz pair join --code <配对码>" },
        { kind: "h2", id: "approve", step: 4, text: "回到已有的设备确认" },
        { kind: "cmd", head: "Terminal", text: "qz pair approve --code <配对码>" },
        { kind: "p", text: "新设备是不是你的，由你在已有的设备上确认。确认之后开始同步。再在新设备上接上宿主：" },
        { kind: "cmd", head: "Terminal", text: "qz connect" },
        { kind: "h2", id: "sees", text: "Hub 看得到什么" },
        { kind: "p", text: "只有密文。数据是端到端加密的，Hub 负责转发，但看不到内容。更完整的说明在[安全与信任](/docs/guide/trust)。" },
      ],
    },
  },
  en: {
    metaTitle: "More devices",
    doc: {
      title: "More devices",
      lead: "The same agent on a new device. Devices sync through a Hub, and the Hub sees only ciphertext.",
      blocks: [
        { kind: "figure", id: "topology" },
        { kind: "h2", id: "hub", text: "First, a Hub" },
        { kind: "p", text: `${officialHubNote.en} The steps are in [Self-host a Hub](/docs/advanced/self-host-hub).` },
        { kind: "h2", id: "login", step: 1, text: "Log both devices in to the same Hub" },
        { kind: "cmd", label: "Sign in to the official Hub (the first sign-in sets the sign-in passphrase):", head: "Terminal", text: "qz login" },
        { kind: "p", text: "With your own Hub, add its address: qz login --hub https://hub.example.com." },
        { kind: "h2", id: "start", step: 2, text: "Start pairing on the device you already have" },
        { kind: "cmd", head: "Terminal", text: "qz pair start" },
        { kind: "p", text: "It gives you a pairing code." },
        { kind: "h2", id: "join", step: 3, text: "Join from the new device" },
        { kind: "cmd", head: "Terminal", text: "qz pair join --code <pairing code>" },
        { kind: "h2", id: "approve", step: 4, text: "Approve on the device you already have" },
        { kind: "cmd", head: "Terminal", text: "qz pair approve --code <pairing code>" },
        { kind: "p", text: "Whether the new device is yours is confirmed by you, on the device you already have. Sync begins after that. Then connect a host on the new device:" },
        { kind: "cmd", head: "Terminal", text: "qz connect" },
        { kind: "h2", id: "sees", text: "What the Hub can see" },
        { kind: "p", text: "Only ciphertext. The data is end-to-end encrypted; the Hub relays it and cannot see the content. The fuller account is in [Security and trust](/docs/guide/trust)." },
      ],
    },
  },
};
