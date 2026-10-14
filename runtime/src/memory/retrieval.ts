// 记忆检索（文本结构 RAG，不依赖向量模型）：让 agent 可以存任意多的记忆，而每次放进上下文的只有与当前话题相关的一小部分。
//   分词：英文与数字按词，中文按相邻二字（bigram）；打分：BM25 风格的词频饱和 × IDF，标题 / 路径命中加权，较新的略加分，
//   再乘以查询词覆盖率，避免只命中一个常见字的结果排到前面。
//   文档：笔记目录树里的每一篇、日记里的每一段经历（## 小节）、常驻记忆的每一条。
//   recall 工具与控制台搜索走持久的 FTS5 索引（index.ts，含对话）；自动注入块只检索笔记与日记。
//   逐篇打分用于常驻记忆展开（coreView）与 FTS5 不可用时（对话退回时间段内最近的 3000 条）。预算按字符串字符数计，不是 token 数。
import * as mem from "./memory.ts";
import { config } from "../config.ts";
import { epoch } from "../time/zone.ts";
import * as idx from "./index.ts";

import { tokens, rank as rankDocuments, excerptOf, type Doc, type Hit } from "../../../engine/src/retrieval.ts";
import { selectCoreEntries, formatRecallBlock } from "../../../engine/src/context.ts";
export { tokens };
export type { Doc, Hit };

/** 收集全部可检索的记忆。 */
export function documents(kinds: Doc["kind"][] = ["note", "journal", "memory", "user"]): Doc[] {
  const docs: Doc[] = [];
  if (kinds.includes("note"))
    for (const n of mem.listNotes()) docs.push({ kind: "note", source: `笔记/${n.name}`, title: `${n.name} ${n.title} ${n.summary}`, text: mem.readNote(n.name), mtime: n.mtime });
  if (kinds.includes("journal"))
    for (const j of mem.listJournal()) {
      const text = mem.readJournal(j.body, j.day);
      const [y, m, d] = j.day.split("-").map(Number);
      for (const sec of text.split(/\n(?=## )/).slice(1)) {
        const head = sec.split("\n")[0].replace(/^##\s*/, "");
        const hm = /^(\d{1,2}):(\d{2})/.exec(head); // 每一段的标题以当地时间「HH:MM」开头：换算成那一刻
        const at = y && m && d ? epoch(y, m, d, hm ? +hm[1] : 12, hm ? +hm[2] : 0, config.timezone) : j.mtime;
        docs.push({ kind: "journal", source: `日记/${j.body}/${j.day} ${head}`.trim(), title: head, text: sec, mtime: at });
      }
    }
  for (const t of ["memory", "user"] as const)
    if (kinds.includes(t)) mem.entries(t).forEach((e, i, all) => docs.push({ kind: t, source: `${t === "memory" ? "常驻记忆" : "关于你"}#${i + 1}`, title: "", text: e, mtime: i - all.length }));
  return docs;
}

/** 兼容旧调用路径；当前时间由宿主提供给引擎纯评分策略。 */
export function rank(query: string, docs: Doc[]): Hit[] {
  return rankDocuments(query, docs, Date.now());
}

/** 检索：走 FTS5 索引；不可用时文档逐篇打分，对话取时间段内最近的 3000 条。自动检索块只请求笔记 / 日记。from / to：只看这个时间段。 */
export type Found = Omit<Hit, "kind"> & { kind: idx.Kind; session?: string; ref?: string };
export function retrieve(query: string, o: { limit?: number; kinds?: idx.Kind[]; from?: number; to?: number } = {}): Found[] {
  const kinds = o.kinds ?? ["chat", "note", "journal", "memory", "user"];
  if (idx.ensureIndex()) {
    const docKinds = kinds.filter((k): k is Doc["kind"] => k !== "chat");
    if (docKinds.length) idx.syncDocs(documents().map((d) => ({ ...d, ts: d.mtime > 1e12 ? d.mtime : 0 })));
    return idx.search(query, { ...o, kinds }).map((h) => ({ kind: h.kind, source: h.source, title: h.title, text: h.text, mtime: h.ts, score: h.score, excerpt: excerptOf(h.text, query), session: h.session, ref: h.ref }));
  }
  // 没有 FTS5（Node 22.13–22.15 的 node:sqlite 没编进去）：逐篇打分；对话只看时间段里最近的 3000 条
  const docKinds = kinds.filter((k): k is Doc["kind"] => k !== "chat");
  const from = o.from ?? -Infinity, to = o.to ?? Infinity;
  const inRange = (t: number) => o.from === undefined && o.to === undefined || (t > 1e12 && t >= from && t < to);
  const docs: (Doc & { session?: string; ref?: string; chat?: boolean })[] = documents(docKinds).filter((d) => inRange(d.mtime));
  if (kinds.includes("chat"))
    for (const m of idx.recentChats(from, to, 3000)) docs.push({ kind: "memory", source: `对话/${m.title ?? m.session}`, title: "", text: m.text, mtime: m.ts, session: m.session, ref: String(m.id), chat: true });
  const ranked = query.trim() ? rank(query, docs) : docs.map((d) => ({ ...d, score: d.mtime, excerpt: d.text })).sort((a, b) => b.mtime - a.mtime);
  return ranked.slice(0, o.limit ?? 8).map((h) => {
    const d = h as typeof docs[number] & Hit;
    return { ...d, kind: d.chat ? "chat" : d.kind, title: d.chat ? d.source.slice(3) : d.title };
  });
}

/**
 * 常驻记忆的上下文视图：存储不限长，放进上下文时有预算。放得下就全部展开；
 * 放不下时优先展开与当前话题相关的条目，其余按新近程度补足，按原顺序呈现，并说明还有多少条没展开。
 */
export function coreView(t: "memory" | "user", context: string, budget: number): { text: string; hidden: number; total: number } {
  return selectCoreEntries(mem.entries(t), context, budget);
}

/** 自动检索块：把与当前话题相关的笔记与日记片段放进上下文（常驻记忆已由 coreView 按相关性展开）。 */
export function recallBlock(context: string, budget = 3000): string {
  if (!context.trim()) return "";
  return formatRecallBlock(retrieve(context, { limit: 12, kinds: ["note", "journal"] }), budget);
}
