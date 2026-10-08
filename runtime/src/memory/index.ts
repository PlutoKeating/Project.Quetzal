// 检索索引：node:sqlite 的 FTS5，持久、增量，不依赖向量模型与任何原生扩展。
//   内容：对话（messages 表，含其他身体复制来的）、笔记、日记的每一段经历、常驻记忆的每一条。
//   分词在 JS 里做（tokens）：英文与数字按词；中文按相邻二字（召回）+ ICU 分出的整词（Intl.Segmenter，精度）；
//   写进 FTS5 的是空格隔开的词，FTS5 的 unicode61 只负责按空格切开。查询用同一个分词，词之间是 OR，按 bm25 排序，
//   再乘以查询词覆盖率与一点新近加分。
//   增量：对话不挂写入钩子（本机写入与别处复制来的是两条路），检索前把还没进索引的消息补进去（按 rowid 反连接，没有新消息时几乎不花时间），
//   启动时在后台补一次；笔记、日记、常驻记忆按「来源 + 内容哈希」比对，只重写变了的。
//   时间：每条都带一个时刻（对话是发送时刻，日记是那天，笔记是修改时刻；常驻记忆没有时刻），检索可以只看某个时间段。
import crypto from "node:crypto";
import { db } from "../store.ts";
import { log } from "../log.ts";
import { tokens } from "./retrieval.ts";
import type { Doc } from "./retrieval.ts";

export type Kind = Doc["kind"] | "chat";
export interface IndexHit { kind: Kind; source: string; title: string; text: string; ts: number; score: number; ref: string; session?: string }

let ready: boolean | undefined;

/** 建表（FTS5 不可用时返回 false，检索退回逐篇打分）。 */
export function ensureIndex(): boolean {
  if (ready !== undefined) return ready;
  if (!db) return false; // 存储还没打开（只在测试里会这样）：不记下结论
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS recall_chat USING fts5(toks, content='', tokenize='unicode61 remove_diacritics 0');
      CREATE VIRTUAL TABLE IF NOT EXISTS recall_doc USING fts5(toks, kind UNINDEXED, source UNINDEXED, title UNINDEXED, body UNINDEXED, ts UNINDEXED, hash UNINDEXED, tokenize='unicode61 remove_diacritics 0');
      CREATE TABLE IF NOT EXISTS recall_chat_ids(id INTEGER PRIMARY KEY);
    `);
    ready = true;
  } catch (e) {
    log("memory", `FTS5 不可用，检索退回逐篇打分：${(e as Error).message}`);
    ready = false;
  }
  return ready;
}

/** 写进索引的词串：分词结果去重后用空格连起来（FTS5 的 unicode61 按空格切开）。 */
export const toks = (s: string) => [...new Set(tokens(s))].join(" ");

/** 把还没进索引的对话补进去（每次最多 batch 条；返回补了多少）。只收对方、她与环境声音里有文字的消息。 */
export function syncChat(batch = 2000): number {
  if (!ensureIndex()) return 0;
  const rows = db.prepare(`SELECT m.id, m.text FROM messages m LEFT JOIN recall_chat_ids r ON r.id = m.id WHERE r.id IS NULL LIMIT ?`).all(batch) as { id: number; text: string }[];
  if (!rows.length) return 0;
  const put = db.prepare("INSERT INTO recall_chat(rowid, toks) VALUES(?, ?)"), mark = db.prepare("INSERT OR IGNORE INTO recall_chat_ids(id) VALUES(?)");
  db.exec("BEGIN");
  try {
    for (const r of rows) {
      const t = toks(String(r.text ?? ""));
      if (t) put.run(r.id, t);
      mark.run(r.id);
    }
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
  return rows.length;
}

/** 启动时在后台把历史对话补进索引（分批，让出事件循环）。 */
export function backfillChat() {
  if (!ensureIndex()) return;
  let total = 0;
  const step = () => {
    try {
      const n = syncChat(1000);
      total += n;
      if (n) { setTimeout(step, 50).unref?.(); return; }
      if (total) log("memory", `对话索引补了 ${total} 条`);
    } catch (e) { log("memory", `对话索引补不上：${(e as Error).message}`); }
  };
  setTimeout(step, 2000).unref?.();
}

/** 笔记、日记、常驻记忆：与现有的文档比对，变了的重写、没了的删掉。docs 由 retrieval.documents() 提供。 */
export function syncDocs(docs: (Doc & { ts: number })[]) {
  if (!ensureIndex()) return;
  const have = new Map((db.prepare("SELECT rowid, source, hash FROM recall_doc").all() as { rowid: number; source: string; hash: string }[]).map((r) => [r.source, r]));
  const seen = new Set<string>();
  const put = db.prepare("INSERT INTO recall_doc(toks, kind, source, title, body, ts, hash) VALUES(?,?,?,?,?,?,?)"), del = db.prepare("DELETE FROM recall_doc WHERE rowid=?");
  db.exec("BEGIN");
  try {
    for (const d of docs) {
      if (seen.has(d.source)) continue;
      seen.add(d.source);
      const hash = crypto.createHash("sha1").update(`${d.title}\n${d.text}\n${d.ts}`).digest("hex");
      const old = have.get(d.source);
      if (old?.hash === hash) continue;
      if (old) del.run(old.rowid);
      put.run(toks(`${d.title} ${d.title} ${d.text}`), d.kind, d.source, d.title, d.text, d.ts, hash); // 标题算两遍：命中标题加权
    }
    for (const [source, r] of have) if (!seen.has(source)) del.run(r.rowid);
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
}

const quote = (t: string) => `"${t.replace(/"/g, '""')}"`;

/**
 * 检索。query 为空时只按时间范围列出（时间段里的对话与日记，新的在前）。
 * from / to：毫秒时刻，[from, to)；kinds：只看哪几类。返回按分数从高到低（只按时间时从新到旧）。
 */
export function search(query: string, o: { from?: number; to?: number; kinds?: Kind[]; limit?: number } = {}): IndexHit[] {
  if (!ensureIndex()) return [];
  syncChat();
  const q = [...new Set(tokens(query))];
  const kinds = o.kinds ?? ["chat", "note", "journal", "memory", "user"];
  const from = o.from ?? -Infinity, to = o.to ?? Infinity;
  const timed = o.from !== undefined || o.to !== undefined;
  const limit = o.limit ?? 8;
  const hits: IndexHit[] = [];
  const match = q.map(quote).join(" OR ");

  if (kinds.includes("chat")) {
    const range = `m.ts >= ? AND m.ts < ?`;
    const lo = Number.isFinite(from) ? from : 0, hi = Number.isFinite(to) ? to : Number.MAX_SAFE_INTEGER;
    const rows = (q.length
      ? db.prepare(`SELECT m.id, m.ts, m.role, m.text, m.session, s.title, bm25(recall_chat) AS r FROM recall_chat JOIN messages m ON m.id = recall_chat.rowid LEFT JOIN sessions s ON s.id = m.session WHERE recall_chat MATCH ? AND ${range} ORDER BY r LIMIT 200`).all(match, lo, hi)
      : timed ? db.prepare(`SELECT m.id, m.ts, m.role, m.text, m.session, s.title, 0 AS r FROM messages m LEFT JOIN sessions s ON s.id = m.session WHERE ${range} AND m.role != 'ambient' ORDER BY m.ts DESC LIMIT 200`).all(lo, hi) : []) as any[];
    for (const r of rows) hits.push({ kind: "chat", source: `对话/${r.title ?? r.session}`, title: String(r.title ?? ""), text: String(r.text ?? ""), ts: Number(r.ts), score: -Number(r.r), ref: String(r.id), session: String(r.session) });
  }
  const docKinds = kinds.filter((k) => k !== "chat");
  if (docKinds.length) {
    const marks = docKinds.map(() => "?").join(",");
    const rows = (q.length
      ? db.prepare(`SELECT kind, source, title, body, ts, bm25(recall_doc) AS r FROM recall_doc WHERE recall_doc MATCH ? AND kind IN (${marks}) ORDER BY r LIMIT 200`).all(match, ...docKinds)
      : timed ? db.prepare(`SELECT kind, source, title, body, ts, 0 AS r FROM recall_doc WHERE kind IN (${marks}) ORDER BY ts DESC LIMIT 400`).all(...docKinds) : []) as any[];
    for (const r of rows) {
      const ts = Number(r.ts);
      if (timed && (!(ts > 0) || ts < from || ts >= to)) continue; // 有时间范围时，没有时刻的（常驻记忆）不算
      hits.push({ kind: r.kind, source: String(r.source), title: String(r.title), text: String(r.body), ts, score: -Number(r.r), ref: String(r.source) });
    }
  }
  if (!q.length) return hits.sort((a, b) => b.ts - a.ts).slice(0, limit);

  // 覆盖率（命中了多少查询词，按稀有程度加权）与新近：避免只命中一个常见词的排到前面
  const weight = new Map(q.map((t) => [t, 1 / Math.log(2 + hits.filter((h) => h.text.toLowerCase().includes(t) || h.title.toLowerCase().includes(t)).length)]));
  const total = [...weight.values()].reduce((a, b) => a + b, 0) || 1;
  const now = Date.now();
  for (const h of hits) {
    const hay = `${h.title} ${h.text}`.toLowerCase();
    const cover = q.reduce((a, t) => a + (hay.includes(t) ? weight.get(t)! : 0), 0) / total;
    const age = h.ts > 1e12 ? (now - h.ts) / 86_400_000 : 365;
    h.score = h.score * cover * cover * (1 + 0.3 * Math.exp(-age / 30));
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** 一条对话前后各几条（同一会话），给检索结果配上下文。 */
export function around(id: number, n = 1): { id: number; ts: number; role: string; text: string }[] {
  const m = db.prepare("SELECT session, ts FROM messages WHERE id=?").get(id) as { session: string; ts: number } | undefined;
  if (!m) return [];
  const before = db.prepare("SELECT id, ts, role, text FROM messages WHERE session=?1 AND (ts<?2 OR (ts=?2 AND id<?3)) AND role!='ambient' ORDER BY ts DESC, id DESC LIMIT ?4").all(m.session, m.ts, id, n) as any[];
  const after = db.prepare("SELECT id, ts, role, text FROM messages WHERE session=?1 AND (ts>?2 OR (ts=?2 AND id>?3)) AND role!='ambient' ORDER BY ts, id LIMIT ?4").all(m.session, m.ts, id, n) as any[];
  const self = db.prepare("SELECT id, ts, role, text FROM messages WHERE id=?").get(id) as any;
  return [...before.reverse(), self, ...after];
}

/** 时间段里最近的对话（没有 FTS5 时逐条打分用）。 */
export function recentChats(from: number, to: number, limit: number): { id: number; ts: number; text: string; session: string; title?: string }[] {
  if (!db) return [];
  const lo = Number.isFinite(from) ? from : 0, hi = Number.isFinite(to) ? to : Number.MAX_SAFE_INTEGER;
  return db.prepare("SELECT m.id, m.ts, m.text, m.session, s.title FROM messages m LEFT JOIN sessions s ON s.id = m.session WHERE m.ts >= ? AND m.ts < ? AND m.role != 'ambient' ORDER BY m.ts DESC LIMIT ?").all(lo, hi, limit) as any[];
}
