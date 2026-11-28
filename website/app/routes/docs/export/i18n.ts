import type { Messages } from "~/lib/content";

export const messages: Messages = {
  zh: {
    metaTitle: "带走与恢复",
    doc: {
      title: "带走与恢复",
      lead: "他是你的。随时可以整个带走，也可以从带走的那一份恢复。",
      blocks: [
        { kind: "figure", id: "export" },
        { kind: "h2", id: "export", text: "导出" },
        { kind: "cmd", head: "Terminal", text: "qz export ./quetzalcoatl.zip" },
        { kind: "p", text: "一次导出得到两样东西。人能直接读的文档，让你不靠任何软件也读得到他；可恢复的密文，让你把他原样带到别处。" },
        { kind: "h2", id: "import", text: "恢复" },
        { kind: "cmd", head: "Terminal", text: "qz import ./quetzalcoatl.zip" },
        { kind: "p", text: "从导出的那一份恢复。恢复之后接上宿主，他就回来了。" },
        { kind: "h2", id: "v1", text: "从 V1 迁移" },
        { kind: "p", text: "用过 V1 的话，把旧的数据迁进来。迁移是单向的，可以重复运行。" },
        { kind: "cmd", head: "Terminal", text: "qz import-v1 --soul-dir <V1 的数据目录> --db <V1 的会话库>" },
      ],
    },
  },
  en: {
    metaTitle: "Export and restore",
    doc: {
      title: "Export and restore",
      lead: "Your agent is yours. Take everything with you at any time, and restore from what you took.",
      blocks: [
        { kind: "figure", id: "export" },
        { kind: "h2", id: "export", text: "Export" },
        { kind: "cmd", head: "Terminal", text: "qz export ./quetzalcoatl.zip" },
        { kind: "p", text: "One export yields two things. Documents a person can read, so you can reach your agent without any software; and restorable ciphertext, so you can carry your agent elsewhere exactly as it is." },
        { kind: "h2", id: "import", text: "Restore" },
        { kind: "cmd", head: "Terminal", text: "qz import ./quetzalcoatl.zip" },
        { kind: "p", text: "Restore from what you exported. Connect a host afterwards, and your agent is back." },
        { kind: "h2", id: "v1", text: "Migrate from V1" },
        { kind: "p", text: "If you used V1, bring the old data in. The migration is one-way and safe to run again." },
        { kind: "cmd", head: "Terminal", text: "qz import-v1 --soul-dir <V1 data directory> --db <V1 session database>" },
      ],
    },
  },
};
