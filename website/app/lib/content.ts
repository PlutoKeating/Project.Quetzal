import type { Lang } from "~/i18n/core";

/** 文档与页面正文的内容块。页面文案住在各页的 i18n.ts 里，这里只定义形状。 */
export type Block =
  | { kind: "p"; text: string }
  | { kind: "h2"; id: string; text: string }
  | { kind: "ul"; items: string[] }
  | { kind: "ol"; items: string[] }
  | { kind: "code"; title?: string; text: string }
  | { kind: "table"; head: string[]; rows: string[][] }
  | { kind: "note"; tone?: "info" | "warn"; text: string }
  | { kind: "steps"; items: { title: string; text: string }[] }
  | { kind: "cards"; items: { title: string; text: string; href?: string }[] };

export type Doc = {
  title: string;
  description: string;
  lead: string;
  blocks: Block[];
};

export type PageMessages = {
  metaTitle: string;
  doc: Doc;
};

export type Messages = Record<Lang, PageMessages>;
