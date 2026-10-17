// 会话列表里的搜索（#30）：按标题与内容找会话。内容复用记忆检索的全文索引（memory/index.ts 的对话检索，FTS5 + 中文二字分词），
// 每个会话取分数最高的一条命中，配上命中处的片段与高亮位置；点开跳到那条消息。FTS5 不可用时退回逐条 LIKE。
//   排序：标题命中的在前（按最近更新），其余按内容命中的分数。归档的会话也搜（结果里标着），不在列表里的话也能找到。
import { db, getSession, listSessions, type SessionInfo } from "../store.ts";
import { ensureIndex, search as searchIndex } from "../memory/index.ts";
import { tokens } from "../memory/retrieval.ts";

export interface SessionHit {
  session: SessionInfo;
  title: boolean; // 标题命中
  titleMarks: [number, number][]; // 标题里命中的位置 [起, 止)
  matches: number; // 内容命中的消息数（最多统计到搜索上限）
  hit?: { message: number; ts: number; role: string; snippet: string; marks: [number, number][] }; // 最好的一条内容命中
}

/** 查询里用来标亮的词：整句、按空白切开的各段，以及（中文没有空格时）分词得到的二字词。长的在前，免得短词把长词切碎。 */
export function markTerms(query: string): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const parts = q.split(/\s+/).filter(Boolean);
  const set = new Set([q, ...parts, ...tokens(q).filter((t) => t.length >= 2 || /[a-z0-9]/.test(t))]);
  return [...set].filter((t) => t.trim()).sort((a, b) => b.length - a.length);
}

/** 文字里命中各词的位置（不分大小写，合并重叠的）。 */
export function marksIn(text: string, terms: string[]): [number, number][] {
  const low = text.toLowerCase(), out: [number, number][] = [];
  for (const t of terms) {
    if (!t) continue;
    for (let i = low.indexOf(t); i >= 0 && out.length < 200; i = low.indexOf(t, i + t.length)) out.push([i, i + t.length]);
  }
  out.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const m of out) { const last = merged.at(-1); if (last && m[0] <= last[1]) last[1] = Math.max(last[1], m[1]); else merged.push([...m]); }
  return merged;
}

/** 命中处前后的一段（前 24 字、共约 120 字），连同片段里的高亮位置。 */
export function snippetOf(text: string, terms: string[], width = 120): { snippet: string; marks: [number, number][] } {
  const flat = text.replace(/\s+/g, " ").trim();
  const all = marksIn(flat, terms);
  const at = all[0]?.[0] ?? 0;
  const start = Math.max(0, Math.min(at - 24, flat.length - width));
  const end = Math.min(flat.length, start + width);
  const head = start > 0 ? "…" : "", tail = end < flat.length ? "…" : "";
  const snippet = head + flat.slice(start, end) + tail;
  const marks = all.filter(([a, b]) => a >= start && b <= end).map(([a, b]) => [a - start + head.length, b - start + head.length] as [number, number]);
  return { snippet, marks };
}

/** 搜索会话。limit：最多返回几个会话（缺省 30，最多 100）。 */
export function searchSessions(query: string, o: { limit?: number } = {}): SessionHit[] {
  const q = String(query ?? "").trim().slice(0, 200);
  if (!q) return [];
  const limit = Math.max(1, Math.min(o.limit ?? 30, 100));
  const terms = markTerms(q);
  const out = new Map<string, SessionHit>();

  // 标题：现在的与归档的都搜
  for (const s of [...listSessions({ title: q, limit: 200 }), ...listSessions({ title: q, archived: true, limit: 200 })]) {
    out.set(s.id, { session: s, title: true, titleMarks: marksIn(s.title, terms), matches: 0 });
  }

  // 内容：全文索引（每个会话取分数最高的一条）；没有 FTS5 时逐条 LIKE（新的在前）
  const rows: { id: number; session: string }[] = ensureIndex()
    ? searchIndex(q, { kinds: ["chat"], limit: 400 }).map((h) => ({ id: Number(h.ref), session: String(h.session) }))
    : (db.prepare("SELECT id, session FROM messages WHERE text LIKE ? ESCAPE '\\' ORDER BY ts DESC LIMIT 400").all(`%${q.replace(/[\\%_]/g, (c) => "\\" + c)}%`) as any[]);
  const msg = db.prepare("SELECT id, ts, role, text, mode FROM messages WHERE id=?");
  const order: string[] = [];
  for (const r of rows) {
    const m = msg.get(r.id) as { id: number; ts: number; role: string; text: string; mode: string | null } | undefined;
    if (!m || m.mode === "ignored") continue; // 她判断不是对她说的环境声音，控制台本来就不显示
    let h = out.get(r.session);
    if (!h) {
      const s = getSession(r.session);
      if (!s) continue;
      h = { session: s, title: false, titleMarks: [], matches: 0 };
      out.set(r.session, h);
      order.push(r.session);
    }
    h.matches++;
    if (!h.hit) { const sn = snippetOf(String(m.text ?? ""), terms); h.hit = { message: Number(m.id), ts: Number(m.ts), role: m.role, ...sn }; }
  }
  const titled = [...out.values()].filter((h) => h.title).sort((a, b) => b.session.updated - a.session.updated);
  const content = order.map((id) => out.get(id)!).filter((h) => !h.title);
  return [...titled, ...content].slice(0, limit);
}
