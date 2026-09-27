// 常驻记忆条目的纯函数（无依赖）：§ 分隔格式与条目级三方合并。运行基座与桥接模块共用。
export const SEP = "\n§\n";
export function parseEntries(s: string): string[] { return (s ?? "").split(/\n?§\n?/).map((e) => e.trim()).filter(Boolean); }
export const joinEntries = (e: string[]) => e.join(SEP) + (e.length ? "\n" : "");

/** 条目级三方合并：双方新增的条目都保留，任何一方删除的条目删除。 */
export function mergeEntries(base: string, ours: string, theirs: string): string {
  const b = new Set(parseEntries(base)), o = parseEntries(ours), t = parseEntries(theirs);
  const oSet = new Set(o), tSet = new Set(t);
  const keep = (e: string) => !(b.has(e) && (!oSet.has(e) || !tSet.has(e)));
  const out: string[] = [];
  for (const e of [...o, ...t]) if (keep(e) && !out.includes(e)) out.push(e);
  return joinEntries(out);
}

/** 整段文本的三方合并：只有一方改动时取改动方；双方都改且不同时返回冲突。 */
export function mergeText(base: string, ours: string, theirs: string): { text: string; conflict?: string } {
  if (ours === theirs || theirs === base) return { text: ours };
  if (ours === base) return { text: theirs };
  return { text: ours, conflict: theirs };
}
