// SQLite 存储：时间线、对话、审计、笔记（FTS5）、通用键值。使用 Node 内置 node:sqlite，无原生依赖。
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { paths } from "./config.ts";
import { bus, type TimelineEntry } from "./bus.ts";

export let db: DatabaseSync;

export function openStore() {
  const f = path.join(paths.data, "windler.db");
  db = new DatabaseSync(f);
  db.exec(`
    PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY, v TEXT);
    CREATE TABLE IF NOT EXISTS timeline(id INTEGER PRIMARY KEY, ts INTEGER, kind TEXT, title TEXT, detail TEXT);
    CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY, ts INTEGER, role TEXT, channel TEXT, text TEXT);
    CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY, ts INTEGER, actor TEXT, action TEXT, reason TEXT, args TEXT, result TEXT);
    CREATE TABLE IF NOT EXISTS usage(day TEXT, model TEXT, input INTEGER, output INTEGER, cost REAL, PRIMARY KEY(day, model));
    CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, title TEXT, channel TEXT, created INTEGER, updated INTEGER, archived INTEGER DEFAULT 0);
  `);
  // 对话归属会话，并保存执行过程与附件（旧库补列；此前没有会话的对话归入「最初的对话」）
  const cols = (db.prepare("PRAGMA table_info(messages)").all() as any[]).map((c) => c.name);
  for (const [c, t] of [["session", "TEXT"], ["process", "TEXT"], ["attachments", "TEXT"], ["mode", "TEXT"]]) if (!cols.includes(c)) db.exec(`ALTER TABLE messages ADD COLUMN ${c} ${t}`);
  db.exec("CREATE INDEX IF NOT EXISTS messages_session ON messages(session, id)");
  const orphan = db.prepare("SELECT MIN(ts) a, MAX(ts) b FROM messages WHERE session IS NULL").get() as any;
  if (orphan?.a) {
    db.prepare("INSERT OR IGNORE INTO sessions(id,title,channel,created,updated) VALUES('first','最初的对话','控制台',?,?)").run(orphan.a, orphan.b);
    db.exec("UPDATE messages SET session='first' WHERE session IS NULL");
  }
}

export const kv = {
  get<T>(k: string, d: T): T {
    const r = db.prepare("SELECT v FROM kv WHERE k=?").get(k) as { v: string } | undefined;
    return r ? JSON.parse(r.v) : d;
  },
  set(k: string, v: unknown) { db.prepare("INSERT OR REPLACE INTO kv VALUES(?,?)").run(k, JSON.stringify(v)); },
};

export function addTimeline(kind: string, title: string, detail: unknown = null): TimelineEntry {
  const ts = Date.now();
  const r = db.prepare("INSERT INTO timeline(ts,kind,title,detail) VALUES(?,?,?,?)").run(ts, kind, title, JSON.stringify(detail));
  const e = { id: Number(r.lastInsertRowid), ts, kind, title, detail };
  bus.emit("timeline", e);
  return e;
}

export function listTimeline(limit = 50, before = Number.MAX_SAFE_INTEGER, kind?: string): TimelineEntry[] {
  const rows = (kind
    ? db.prepare("SELECT * FROM timeline WHERE id<? AND kind=? ORDER BY id DESC LIMIT ?").all(before, kind, limit)
    : db.prepare("SELECT * FROM timeline WHERE id<? ORDER BY id DESC LIMIT ?").all(before, limit)) as any[];
  return rows.map((r) => ({ ...r, detail: JSON.parse(r.detail) }));
}

// ---------- 会话与对话
export interface SessionInfo { id: string; title: string; channel: string; created: number; updated: number; archived: boolean; count?: number; last?: string }
export interface Attachment { id: string; name: string; path: string; rel: string; mime: string; size: number; kind: "image" | "text" | "file" } // rel：相对 uploads 目录
export type Role = "user" | "agent" | "ambient"; // ambient：环境的声音（麦克风听到并识别的话），不是对方发来的消息
export interface MessageRow { id: number; ts: number; role: Role; channel: string; text: string; session: string; process: unknown[] | null; attachments: Attachment[] | null; mode: string | null } // mode：她工作时发来的消息如何并入（steer / interrupt）

const rowSession = (r: any): SessionInfo => ({ ...r, archived: !!r.archived });
const rowMessage = (r: any): MessageRow => ({ ...r, process: r.process ? JSON.parse(r.process) : null, attachments: r.attachments ? JSON.parse(r.attachments) : null });

/** 确保会话存在（固定 id 的会话如「飞书」首次使用时自动创建）。 */
export function ensureSession(id: string, title: string, channel = "控制台"): SessionInfo {
  const now = Date.now();
  db.prepare("INSERT OR IGNORE INTO sessions(id,title,channel,created,updated) VALUES(?,?,?,?,?)").run(id, title, channel, now, now);
  return getSession(id)!;
}
export function getSession(id: string): SessionInfo | undefined {
  const r = db.prepare("SELECT * FROM sessions WHERE id=?").get(id);
  return r ? rowSession(r) : undefined;
}
export function listSessions(o: { archived?: boolean; limit?: number } = {}): SessionInfo[] {
  return (db.prepare(`SELECT s.*, (SELECT COUNT(*) FROM messages m WHERE m.session=s.id) count,
      (SELECT text FROM messages m WHERE m.session=s.id ORDER BY id DESC LIMIT 1) last
    FROM sessions s WHERE archived=? ORDER BY updated DESC LIMIT ?`).all(o.archived ? 1 : 0, o.limit ?? 200) as any[])
    .map((r) => ({ ...rowSession(r), last: String(r.last ?? "").slice(0, 80) }));
}
export function updateSession(id: string, patch: { title?: string; archived?: boolean }) {
  if (patch.title !== undefined) db.prepare("UPDATE sessions SET title=? WHERE id=?").run(patch.title.trim().slice(0, 60) || "新的对话", id);
  if (patch.archived !== undefined) db.prepare("UPDATE sessions SET archived=? WHERE id=?").run(patch.archived ? 1 : 0, id);
  return getSession(id);
}

export function addMessage(role: Role, channel: string, text: string, o: { session?: string; process?: unknown[]; attachments?: Attachment[]; mode?: string } = {}) {
  const ts = Date.now(), session = o.session ?? "first";
  const r = db.prepare("INSERT INTO messages(ts,role,channel,text,session,process,attachments,mode) VALUES(?,?,?,?,?,?,?,?)")
    .run(ts, role, channel, text, session, o.process?.length ? JSON.stringify(o.process) : null, o.attachments?.length ? JSON.stringify(o.attachments) : null, o.mode ?? null);
  db.prepare("UPDATE sessions SET updated=?, archived=0 WHERE id=?").run(ts, session); // 有新消息的会话自动回到列表
  return Number(r.lastInsertRowid);
}
/** 改一条消息的并入方式标记（ambient 的 ignored：她判断不是对她说的）。 */
export function setMessageMode(id: number, mode: string | null) { db.prepare("UPDATE messages SET mode=? WHERE id=?").run(mode, id); }
/** 全部会话里最近的对话（正序）。 */
export function recentMessages(limit = 20): MessageRow[] {
  return (db.prepare("SELECT * FROM messages ORDER BY id DESC LIMIT ?").all(limit) as any[]).map(rowMessage).reverse();
}
/** 某个会话的对话（正序）；before 为消息 id，用于向前翻页。 */
export function sessionMessages(session: string, limit = 50, before = Number.MAX_SAFE_INTEGER): MessageRow[] {
  return (db.prepare("SELECT * FROM messages WHERE session=? AND id<? ORDER BY id DESC LIMIT ?").all(session, before, limit) as any[]).map(rowMessage).reverse();
}

export function audit(actor: string, action: string, reason: string, args: unknown, result: string) {
  db.prepare("INSERT INTO audit(ts,actor,action,reason,args,result) VALUES(?,?,?,?,?,?)")
    .run(Date.now(), actor, action, reason, JSON.stringify(args ?? null).slice(0, 2000), result.slice(0, 2000));
}
export interface AuditRow { id: number; ts: number; actor: string; action: string; reason: string; args: string; result: string }
/** 审计记录（从新到旧）；action 只看某个动作，since 只看该时刻之后的。 */
export function listAudit(limit = 100, o: { action?: string; since?: number } = {}): AuditRow[] {
  return db.prepare("SELECT * FROM audit WHERE (?1 IS NULL OR action=?1) AND ts>=?2 ORDER BY id DESC LIMIT ?3").all(o.action ?? null, o.since ?? 0, limit) as unknown as AuditRow[];
}

export const today = () => new Date().toISOString().slice(0, 10);
export function addUsage(model: string, input: number, output: number, cost: number) {
  db.prepare(`INSERT INTO usage VALUES(?,?,?,?,?) ON CONFLICT(day,model) DO UPDATE SET
    input=input+excluded.input, output=output+excluded.output, cost=cost+excluded.cost`).run(today(), model, input, output, cost);
}
export function usageToday() {
  const r = db.prepare("SELECT COALESCE(SUM(input+output),0) tokens, COALESCE(SUM(cost),0) cost FROM usage WHERE day=?").get(today()) as any;
  return { tokens: Number(r.tokens), cost: Number(r.cost) };
}
