// 记忆检索（文本结构 RAG，不依赖向量模型）：让 agent 可以存任意多的记忆，而每次放进上下文的只有与当前话题相关的一小部分。
//   分词：英文与数字按词，中文按相邻二字（bigram）；打分：BM25 风格的词频饱和 × IDF，标题 / 路径命中加权，较新的略加分，
//   再乘以查询词覆盖率，避免只命中一个常见字的结果排到前面。
//   文档：笔记目录树里的每一篇、日记里的每一段经历（## 小节）、常驻记忆的每一条。
import * as mem from "./memory.ts";

export interface Doc { kind: "note" | "journal" | "memory" | "user"; source: string; title: string; text: string; mtime: number }
export interface Hit extends Doc { score: number; excerpt: string }

const ASCII = /[a-z0-9_][a-z0-9_.+-]*/g;
const CJK = /[㐀-鿿豈-﫿]+/g;

/** 分词：英文词（至少 2 个字符）+ 中文二字组（单字的中文串保留单字）。 */
export function tokens(s: string): string[] {
  const low = s.toLowerCase(), out: string[] = [];
  for (const m of low.match(ASCII) ?? []) if (m.length >= 2) out.push(m);
  for (const run of low.match(CJK) ?? []) {
    if (run.length === 1) out.push(run);
    for (let i = 0; i + 1 < run.length; i++) out.push(run.slice(i, i + 2));
  }
  return out;
}

const count = (hay: string[], t: string) => { let n = 0; for (const x of hay) if (x === t) n++; return n; };

/** 收集全部可检索的记忆。 */
export function documents(kinds: Doc["kind"][] = ["note", "journal", "memory", "user"]): Doc[] {
  const docs: Doc[] = [];
  if (kinds.includes("note"))
    for (const n of mem.listNotes()) docs.push({ kind: "note", source: `笔记/${n.name}`, title: `${n.name} ${n.title} ${n.summary}`, text: mem.readNote(n.name), mtime: n.mtime });
  if (kinds.includes("journal"))
    for (const j of mem.listJournal()) {
      const text = mem.readJournal(j.body, j.day);
      for (const sec of text.split(/\n(?=## )/).slice(1)) {
        const head = sec.split("\n")[0].replace(/^##\s*/, "");
        docs.push({ kind: "journal", source: `日记/${j.body}/${j.day} ${head}`.trim(), title: head, text: sec, mtime: j.mtime });
      }
    }
  for (const t of ["memory", "user"] as const)
    if (kinds.includes(t)) mem.entries(t).forEach((e, i, all) => docs.push({ kind: t, source: `${t === "memory" ? "常驻记忆" : "关于你"}#${i + 1}`, title: "", text: e, mtime: i - all.length }));
  return docs;
}

/** 对一组文档按查询打分，返回从高到低的命中。 */
export function rank(query: string, docs: Doc[]): Hit[] {
  const q = [...new Set(tokens(query))];
  if (!q.length || !docs.length) return [];
  const toks = docs.map((d) => tokens(d.text));
  const heads = docs.map((d) => new Set(tokens(d.title)));
  const avg = toks.reduce((a, t) => a + t.length, 0) / docs.length || 1;
  const df = new Map(q.map((t) => [t, toks.filter((x) => x.includes(t)).length]));
  const idf = (t: string) => Math.log(1 + (docs.length - df.get(t)! + 0.5) / (df.get(t)! + 0.5));
  const now = Date.now(), maxIdf = q.reduce((a, t) => a + idf(t), 0) || 1;
  const hits: Hit[] = [];
  docs.forEach((d, i) => {
    let s = 0, matched = 0;
    for (const t of q) {
      const tf = count(toks[i], t), inHead = heads[i].has(t);
      if (!tf && !inHead) continue;
      matched += idf(t);
      s += idf(t) * ((tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * toks[i].length / avg)) + (inHead ? 1.5 : 0));
    }
    if (s <= 0) return;
    const age = d.mtime > 1e12 ? (now - d.mtime) / 86_400_000 : 0;
    s *= (matched / maxIdf) * (1 + 0.2 * Math.exp(-age / 30));
    hits.push({ ...d, score: s, excerpt: excerpt(d.text, q, idf) });
  });
  return hits.sort((a, b) => b.score - a.score);
}

/** 摘录：以命中最稀有的词为中心截取一段。 */
function excerpt(text: string, q: string[], idf: (t: string) => number): string {
  if (text.length <= 500) return text.trim();
  const low = text.toLowerCase();
  const best = q.filter((t) => low.includes(t)).sort((a, b) => idf(b) - idf(a))[0];
  const i = best ? low.indexOf(best) : 0;
  const from = Math.max(0, i - 150);
  return `${from > 0 ? "…" : ""}${text.slice(from, from + 500).trim()}${from + 500 < text.length ? "…" : ""}`;
}

/** 检索（recall 工具、控制台搜索）。 */
export function retrieve(query: string, o: { limit?: number; kinds?: Doc["kind"][] } = {}): Hit[] {
  return rank(query, documents(o.kinds)).slice(0, o.limit ?? 8);
}

/**
 * 常驻记忆的上下文视图：存储不限长，放进上下文时有预算。放得下就全部展开；
 * 放不下时优先展开与当前话题相关的条目，其余按新近程度补足，按原顺序呈现，并说明还有多少条没展开。
 */
export function coreView(t: "memory" | "user", context: string, budget: number): { text: string; hidden: number; total: number } {
  const list = mem.entries(t);
  const total = list.reduce((a, e) => a + e.length + 3, 0);
  if (total <= budget) return { text: list.join("\n§\n"), hidden: 0, total };
  const docs: Doc[] = list.map((e, i) => ({ kind: t, source: String(i), title: "", text: e, mtime: 0 }));
  const relevant = context.trim() ? rank(context, docs).map((h) => Number(h.source)) : [];
  const order = [...new Set([...relevant, ...list.map((_, i) => list.length - 1 - i)])]; // 相关的在前，其余从新到旧
  const keep = new Set<number>();
  let used = 0;
  for (const i of order) {
    const cost = list[i].length + 3;
    if (used + cost > budget) continue;
    keep.add(i); used += cost;
  }
  return { text: list.filter((_, i) => keep.has(i)).join("\n§\n"), hidden: list.length - keep.size, total };
}

/** 自动检索块：把与当前话题相关的笔记与日记片段放进上下文（常驻记忆已由 coreView 按相关性展开）。 */
export function recallBlock(context: string, budget = 3000): string {
  if (!context.trim()) return "";
  const out: string[] = [];
  let used = 0;
  for (const h of retrieve(context, { limit: 12, kinds: ["note", "journal"] })) {
    const piece = `【${h.source}】\n${h.excerpt}`;
    if (used + piece.length > budget) continue;
    out.push(piece); used += piece.length;
  }
  return out.join("\n\n");
}
