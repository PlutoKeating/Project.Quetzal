import type { Messages } from "~/lib/content";

export const messages: Messages = {
  zh: {
    metaTitle: "命令速查",
    doc: {
      title: "命令速查",
      lead: "终端一行是离手最远的一层：接上、诊断、带走。日常的事不需要它。",
      blocks: [
        { kind: "h2", id: "all", text: "全部命令" },
        {
          kind: "table",
          head: ["场合", "命令", "做什么"],
          rows: [
            ["接上", "`qz connect`", "把它接进本机已有的宿主"],
            ["", "`qz connect --undo`", "一步撤销"],
            ["诊断", "`qz doctor`", "接上了没有，哪里不对"],
            ["", "`qz status`", "它现在的状态"],
            ["", "`qz up`", "启动"],
            ["", "`qz down`", "停止"],
            ["治理面", "`qz open`", "打开本机的治理面"],
            ["带走", "`qz export`", "导出人能读的文档与可恢复的密文"],
            ["", "`qz import`", "从导出的那一份恢复"],
            ["", "`qz import-v1`", "从 V1 迁移"],
            ["多设备", "`qz login`", "登录 Hub"],
            ["", "`qz pair`", "配对一台新设备"],
          ],
        },
        { kind: "h2", id: "when", text: "什么时候用得到" },
        {
          kind: "rail",
          cols: 2,
          cells: [
            { num: "01", title: "新装了一个宿主", text: "再接一次。", href: "/docs/start/connect", line: { kind: "cmd", text: "qz connect" } },
            { num: "02", title: "状态栏上没有他", text: "先看诊断。", href: "/docs/start/connect#failure", line: { kind: "cmd", text: "qz doctor" } },
            { num: "03", title: "多了一台设备", text: "登录同一个 Hub，再配对。", href: "/docs/guide/devices", line: { kind: "cmd", text: "qz login · qz pair" } },
            { num: "04", title: "想留一份在手里", text: "导出，需要时再恢复。", href: "/docs/guide/export", line: { kind: "cmd", text: "qz export · qz import" } },
          ],
        },
      ],
    },
  },
  en: {
    metaTitle: "Commands",
    doc: {
      title: "Commands",
      lead: "One line in the terminal is the layer furthest from your hand: connect, diagnose, take it with you. Everyday things do not need it.",
      blocks: [
        { kind: "h2", id: "all", text: "All commands" },
        {
          kind: "table",
          head: ["When", "Command", "What it does"],
          rows: [
            ["Connect", "`qz connect`", "connects it to the hosts already on this machine"],
            ["", "`qz connect --undo`", "undoes that in one step"],
            ["Diagnose", "`qz doctor`", "whether it is connected, and what is wrong"],
            ["", "`qz status`", "its current state"],
            ["", "`qz up`", "starts it"],
            ["", "`qz down`", "stops it"],
            ["Governance", "`qz open`", "opens the governance view on this machine"],
            ["Take it with you", "`qz export`", "exports readable documents and restorable ciphertext"],
            ["", "`qz import`", "restores from an export"],
            ["", "`qz import-v1`", "migrates from V1"],
            ["More devices", "`qz login`", "logs in to a Hub"],
            ["", "`qz pair`", "pairs a new device"],
          ],
        },
        { kind: "h2", id: "when", text: "When you need them" },
        {
          kind: "rail",
          cols: 2,
          cells: [
            { num: "01", title: "You installed another host", text: "Connect once more.", href: "/docs/start/connect", line: { kind: "cmd", text: "qz connect" } },
            { num: "02", title: "The name is missing from the status bar", text: "Look at the diagnosis first.", href: "/docs/start/connect#failure", line: { kind: "cmd", text: "qz doctor" } },
            { num: "03", title: "You have one more device", text: "Log in to the same Hub, then pair.", href: "/docs/guide/devices", line: { kind: "cmd", text: "qz login · qz pair" } },
            { num: "04", title: "You want a copy in your hands", text: "Export, and restore when needed.", href: "/docs/guide/export", line: { kind: "cmd", text: "qz export · qz import" } },
          ],
        },
      ],
    },
  },
};
