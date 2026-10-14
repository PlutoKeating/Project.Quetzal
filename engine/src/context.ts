// 纯上下文选择：预算沿用 UTF-16 字符计数，不增加 token 预算或自动压缩。
import { rank, type Doc } from "./retrieval.ts";

/** 相关条目优先，其余从文件末尾补足；按原文件顺序呈现，整条过长则跳过。 */
export function selectCoreEntries(list: readonly string[], context: string, budget: number): { text: string; hidden: number; total: number } {
  const total = list.reduce((a, e) => a + e.length + 3, 0);
  if (total <= budget) return { text: list.join("\n§\n"), hidden: 0, total };
  const docs: Doc[] = list.map((e, i) => ({ kind: "memory", source: String(i), title: "", text: e, mtime: 0 }));
  const relevant = context.trim() ? rank(context, docs, 0).map((h) => Number(h.source)) : [];
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

/** 按候选顺序装入来源标签和摘录；预算不足跳过，连接空行沿用原行为另加。 */
export function formatRecallBlock(hits: readonly { source: string; excerpt: string }[], budget: number): string {
  const out: string[] = [];
  let used = 0;
  for (const h of hits) {
    const piece = `【${h.source}】\n${h.excerpt}`;
    if (used + piece.length > budget) continue;
    out.push(piece); used += piece.length;
  }
  return out.join("\n\n");
}
