// 纯文本记忆检索策略：不读取文件或数据库，当前时间由宿主显式传入。
export interface Doc { kind: "note" | "journal" | "memory" | "user"; source: string; title: string; text: string; mtime: number }
export interface Hit extends Doc { score: number; excerpt: string }

const ASCII = /[a-z0-9_][a-z0-9_.+-]*/g;
const CJK = /[㐀-鿿豈-﫿]+/g;

/** ICU 的中文分词（Node 带完整 ICU 时可用；安卓 App 内置的 Node 用系统 ICU）。没有就只用二字组。 */
const seg = (() => { try { return new Intl.Segmenter("zh", { granularity: "word" }); } catch { return undefined; } })();

/** 分词：英文词（一个字母也算：C、R 这类名字照样能搜到，权重由 IDF 决定）+ 中文二字组（召回；单字的中文串保留单字）+ ICU 分出的三字以上的中文词（精度，如「小笼包」）。 */
export function tokens(s: string): string[] {
  const low = s.toLowerCase(), out: string[] = [];
  for (const m of low.match(ASCII) ?? []) out.push(m);
  for (const run of low.match(CJK) ?? []) {
    if (run.length === 1) out.push(run);
    for (let i = 0; i + 1 < run.length; i++) out.push(run.slice(i, i + 2));
    if (seg && run.length >= 3) for (const w of seg.segment(run)) if (w.isWordLike && w.segment.length >= 3) out.push(w.segment);
  }
  return out;
}

const count = (hay: string[], t: string) => { let n = 0; for (const x of hay) if (x === t) n++; return n; };

/** 对一组文档按查询打分，返回从高到低的命中。 */
export function rank(query: string, docs: Doc[], now: number): Hit[] {
  const q = [...new Set(tokens(query))];
  if (!q.length || !docs.length) return [];
  const toks = docs.map((d) => tokens(d.text));
  const heads = docs.map((d) => new Set(tokens(d.title)));
  const avg = toks.reduce((a, t) => a + t.length, 0) / docs.length || 1;
  const df = new Map(q.map((t) => [t, toks.filter((x) => x.includes(t)).length]));
  const idf = (t: string) => Math.log(1 + (docs.length - df.get(t)! + 0.5) / (df.get(t)! + 0.5));
  const maxIdf = q.reduce((a, t) => a + idf(t), 0) || 1;
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

/** 摘录（给索引的结果用）：以命中的第一个较长的查询词为中心截取一段。 */
export function excerptOf(text: string, query: string): string {
  const q = [...new Set(tokens(query))].sort((a, b) => b.length - a.length);
  const idfLen = (t: string) => t.length;
  return excerpt(text, q, idfLen);
}
