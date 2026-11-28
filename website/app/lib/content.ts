import type { Lang } from "~/i18n/core";

/** 文档里可以放进正文的图（app/diagrams/ 里各有宽、窄两版）。 */
export type FigureId = "journey" | "installer" | "session" | "governance" | "topology" | "levels" | "export";

export type RailCell = {
  num?: string;
  tone?: "ice" | "amber";
  title: string;
  text: string;
  /** 站内路径（不带语言前缀）；给了就把标题做成链接 */
  href?: string;
  /** 单元格末尾的一行等宽小字：命令、人说的一句话，或一句状态说明 */
  line?: { kind: "cmd" | "say" | "note"; text: string };
  /** 代表「结果」的那一格，一条栅格最多一个 */
  accent?: boolean;
};

/**
 * 文档正文的内容块。页面文案住在各页的 i18n.ts 里，这里只定义形状。
 * 行内语法只有两种：`code` 与 [链接](地址)；没有加粗（设计系统不使用粗体）。
 */
export type Block =
  | { kind: "p"; text: string }
  | { kind: "h2"; id: string; text: string; step?: number }
  | { kind: "h3"; text: string }
  | { kind: "ul"; items: string[] }
  | { kind: "ol"; items: string[] }
  | { kind: "cmd"; text: string; label?: string; head?: string }
  | { kind: "say"; text: string; label?: string }
  | { kind: "table"; head: string[]; rows: string[][] }
  | { kind: "note"; text: string }
  | { kind: "figure"; id: FigureId }
  | { kind: "rail"; cols: 2 | 3 | 4; head?: { name: string; meta?: string }; cells: RailCell[] };

export type Doc = {
  title: string;
  /** <meta name="description"> 与标题下的导语 */
  lead: string;
  blocks: Block[];
};

export type PageMessages = {
  metaTitle: string;
  doc: Doc;
};

export type Messages = Record<Lang, PageMessages>;

/** 进 .qz-prose 的块；其余的（栅格、图）有自己的节奏，放在长文容器之外。 */
export function isProse(block: Block): boolean {
  return block.kind !== "rail" && block.kind !== "figure";
}
