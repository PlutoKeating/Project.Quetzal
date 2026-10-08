// SQLite 存储：时间线、对话、审计、笔记（FTS5）、通用键值。使用 Node 内置 node:sqlite，无原生依赖。
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import crypto from "node:crypto";
import { paths, config } from "./config.ts";
import { bus, type TimelineEntry } from "./bus.ts";

export let db: DatabaseSync;

// ---------- 全网唯一的编号（多具身体共用一份对话与时间线，见 mesh/replica.ts）
// 每具身体在自己的编号段里自增：id = 段号 × 2^32 + 序号。段号由身体名的哈希决定（1 … 2^20−1），id 小于 2^52，JS 与 Dart 都能精确表示。
// 排序一律按时间（ts）再按 id，不再按 id：不同身体的编号段之间没有先后。
export const ID_RANGE = 2 ** 32;
export const idPrefixOf = (body: string) => (parseInt(crypto.createHash("sha256").update(body).digest("hex").slice(0, 8), 16) % (2 ** 20 - 1)) + 1;
let prefix = 1;
/** 编号段里可用的序号上限：段尾留出 2^24 的余量，复制来的行不能落在这里（否则有人用段尾的编号就能把这具身体的下一个编号顶出段外）。 */
export const SEQ_MAX = ID_RANGE - 2 ** 24;
/** 这具身体的编号段。 */
export const idPrefix = () => prefix;
const nextId = (table: "messages" | "timeline") => {
  const lo = prefix * ID_RANGE, hi = lo + SEQ_MAX;
  const r = db.prepare(`SELECT MAX(id) m FROM ${table} WHERE id >= ? AND id < ?`).get(lo, hi) as { m: number | null };
  let id = Math.max(lo, Number(r.m ?? lo)) + 1;
  while (db.prepare(`SELECT 1 FROM ${table} WHERE id=?`).get(id)) id++; // 不应发生（段里的行只来自这具身体）
  if (id >= hi) throw new Error(`这具身体的${table === "messages" ? "对话" : "时间线"}编号段用完了`);
  return id;
};
/** 游标：某条记录的 (ts, id)，用于「比它更早」的翻页。 */
const cursor = (table: "messages" | "timeline", before: number): [number, number] => {
  if (before >= Number.MAX_SAFE_INTEGER) return [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER];
  const r = db.prepare(`SELECT ts FROM ${table} WHERE id=?`).get(before) as { ts: number } | undefined;
  return [r?.ts ?? Number.MAX_SAFE_INTEGER, before];
};

export function openStore() {
  const f = path.join(paths.data, "quetzal.db");
  db = new DatabaseSync(f);
  db.exec(`
    PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY, v TEXT);
    CREATE TABLE IF NOT EXISTS timeline(id INTEGER PRIMARY KEY, ts INTEGER, kind TEXT, title TEXT, detail TEXT);
    CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY, ts INTEGER, role TEXT, channel TEXT, text TEXT);
    CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY, ts INTEGER, actor TEXT, action TEXT, reason TEXT, args TEXT, result TEXT);
    CREATE TABLE IF NOT EXISTS usage(day TEXT, model TEXT, input INTEGER, output INTEGER, cost REAL, PRIMARY KEY(day, model));
    CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, title TEXT, channel TEXT, created INTEGER, updated INTEGER, archived INTEGER DEFAULT 0);
    CREATE TABLE IF NOT EXISTS tool_calls(call TEXT, session TEXT, ts INTEGER, tool TEXT, args TEXT, result TEXT, status TEXT, ms INTEGER, PRIMARY KEY(call, session));
  `);
  db.exec("CREATE INDEX IF NOT EXISTS tool_calls_ts ON tool_calls(ts)");
  // 对话归属会话，并保存执行过程与附件（旧库补列；此前没有会话的对话归入「最初的对话」）
  const cols = (db.prepare("PRAGMA table_info(messages)").all() as any[]).map((c) => c.name);
  for (const [c, t] of [["session", "TEXT"], ["process", "TEXT"], ["attachments", "TEXT"], ["mode", "TEXT"]]) if (!cols.includes(c)) db.exec(`ALTER TABLE messages ADD COLUMN ${c} ${t}`);
  db.exec("CREATE INDEX IF NOT EXISTS messages_session ON messages(session, id)");
  // 1.0：来源身体、按时间排序的索引、会话的标题 / 归档修改时间（多具身体之间以较新的修改为准）
  if (!cols.includes("body")) db.exec("ALTER TABLE messages ADD COLUMN body TEXT");
  // 对方的话从哪具身体进来（控制台连的网关、飞书长连接的持有者、听到的耳朵）：转给另一具身体处理时 body 是处理它的身体，via 仍是进来的那具
  if (!cols.includes("via")) db.exec("ALTER TABLE messages ADD COLUMN via TEXT");
  const tcols = (db.prepare("PRAGMA table_info(timeline)").all() as any[]).map((c) => c.name);
  if (!tcols.includes("body")) db.exec("ALTER TABLE timeline ADD COLUMN body TEXT");
  const scols = (db.prepare("PRAGMA table_info(sessions)").all() as any[]).map((c) => c.name);
  if (!scols.includes("changed")) db.exec("ALTER TABLE sessions ADD COLUMN changed INTEGER DEFAULT 0");
  db.exec("CREATE INDEX IF NOT EXISTS messages_session_ts ON messages(session, ts, id)");
  db.exec("CREATE INDEX IF NOT EXISTS messages_ts ON messages(ts, id)");
  db.exec("CREATE INDEX IF NOT EXISTS timeline_ts ON timeline(ts, id)");
  prefix = idPrefixOf(config.body);
  migrateIds();
  // 1.0：用量按身体记（每日预算是全网合计）。旧表的主键是 (day, model)：重建为 (day, model, body)，旧行归这具身体
  const ucols = (db.prepare("PRAGMA table_info(usage)").all() as any[]).map((c) => c.name);
  if (!ucols.includes("body")) {
    db.exec("BEGIN");
    db.exec("CREATE TABLE usage2(day TEXT, model TEXT, body TEXT, input INTEGER, output INTEGER, cost REAL, PRIMARY KEY(day, model, body))");
    db.prepare("INSERT INTO usage2 SELECT day, model, ?, input, output, cost FROM usage").run(config.body);
    db.exec("DROP TABLE usage; ALTER TABLE usage2 RENAME TO usage; COMMIT");
  }
  const orphan = db.prepare("SELECT MIN(ts) a, MAX(ts) b FROM messages WHERE session IS NULL").get() as any;
  if (orphan?.a) {
    db.prepare("INSERT OR IGNORE INTO sessions(id,title,channel,created,updated) VALUES('first','最初的对话','控制台',?,?)").run(orphan.a, orphan.b);
    db.exec("UPDATE messages SET session='first' WHERE session IS NULL");
  }
}

/**
 * 一次性迁移：1.0 之前的对话与时间线编号从 1 开始自增，几具身体合到一起会撞号。把它们搬进这具身体的编号段，
 * 并改写执行过程里引用的消息编号（插话标记 steer.msg）。kv 的 store.ids 记录已经迁移过。
 */
function migrateIds() {
  if (db.prepare("SELECT v FROM kv WHERE k='store.ids'").get()) return;
  const base = prefix * ID_RANGE;
  const fix = (items: any[]) => items.map((it) => (it?.type === "steer" && typeof it.msg === "number" && it.msg < ID_RANGE ? { ...it, msg: it.msg + base } : it));
  const remap = (s: string | null) => {
    if (!s || !s.includes("steer")) return s;
    try {
      const v = JSON.parse(s);
      if (Array.isArray(v)) return JSON.stringify(fix(v));
      if (v && Array.isArray(v.process)) return JSON.stringify({ ...v, process: fix(v.process) });
      return s;
    } catch { return s; }
  };
  db.exec("BEGIN");
  try {
    db.prepare("UPDATE messages SET id = id + ?, body = COALESCE(body, ?) WHERE id < ?").run(base, config.body, ID_RANGE);
    db.prepare("UPDATE timeline SET id = id + ?, body = COALESCE(body, ?) WHERE id < ?").run(base, config.body, ID_RANGE);
    for (const r of db.prepare("SELECT id, process FROM messages WHERE process LIKE '%steer%'").all() as any[]) db.prepare("UPDATE messages SET process=? WHERE id=?").run(remap(r.process), r.id);
    for (const r of db.prepare("SELECT id, detail FROM timeline WHERE detail LIKE '%steer%'").all() as any[]) db.prepare("UPDATE timeline SET detail=? WHERE id=?").run(remap(r.detail), r.id);
    db.prepare("INSERT OR REPLACE INTO kv VALUES('store.ids', ?)").run(JSON.stringify({ prefix, at: Date.now() }));
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
}

export const kv = {
  get<T>(k: string, d: T): T {
    const r = db.prepare("SELECT v FROM kv WHERE k=?").get(k) as { v: string } | undefined;
    return r ? JSON.parse(r.v) : d;
  },
  set(k: string, v: unknown) { db.prepare("INSERT OR REPLACE INTO kv VALUES(?,?)").run(k, JSON.stringify(v)); },
};

export function addTimeline(kind: string, title: string, detail: unknown = null): TimelineEntry {
  const ts = Date.now(), id = nextId("timeline"), text = JSON.stringify(detail);
  db.prepare("INSERT INTO timeline(id,ts,kind,title,detail,body) VALUES(?,?,?,?,?,?)").run(id, ts, kind, title, text, config.body);
  const e = { id, ts, kind, title, detail, body: config.body };
  bus.emit("timeline", e);
  bus.emit("replica", { table: "timeline", rows: [{ id, ts, kind, title, detail: text, body: config.body }] });
  return e;
}

export function listTimeline(limit = 50, before = Number.MAX_SAFE_INTEGER, kind?: string): TimelineEntry[] {
  const [bts, bid] = cursor("timeline", before);
  const rows = (kind
    ? db.prepare("SELECT * FROM timeline WHERE (ts<?1 OR (ts=?1 AND id<?2)) AND kind=?3 ORDER BY ts DESC, id DESC LIMIT ?4").all(bts, bid, kind, limit)
    : db.prepare("SELECT * FROM timeline WHERE (ts<?1 OR (ts=?1 AND id<?2)) ORDER BY ts DESC, id DESC LIMIT ?3").all(bts, bid, limit)) as any[];
  return rows.map((r) => ({ ...r, detail: JSON.parse(r.detail) }));
}

// ---------- 会话与对话
export interface SessionInfo { id: string; title: string; channel: string; created: number; updated: number; archived: boolean; changed?: number; count?: number; last?: string }
export interface Attachment { id: string; name: string; path: string; rel: string; mime: string; size: number; kind: "image" | "text" | "file" } // rel：相对 uploads 目录
export type Role = "user" | "agent" | "ambient"; // ambient：环境的声音（麦克风听到并识别的话），不是对方发来的消息
export interface MessageRow { id: number; ts: number; role: Role; channel: string; text: string; session: string; process: unknown[] | null; attachments: Attachment[] | null; mode: string | null; body?: string | null; via?: string | null } // mode：她工作时发来的消息如何并入（steer / interrupt）；body：在哪具身体上；via：对方的话从哪具身体进来（旧行为空，按 body）

const rowSession = (r: any): SessionInfo => ({ ...r, archived: !!r.archived });
const rowMessage = (r: any): MessageRow => ({ ...r, process: r.process ? JSON.parse(r.process) : null, attachments: r.attachments ? JSON.parse(r.attachments) : null });

/** 确保会话存在（固定 id 的会话如「飞书」首次使用时自动创建）。 */
export function ensureSession(id: string, title: string, channel = "控制台"): SessionInfo {
  const now = Date.now();
  if (Number(db.prepare("INSERT OR IGNORE INTO sessions(id,title,channel,created,updated,changed) VALUES(?,?,?,?,?,0)").run(id, title, channel, now, now).changes)) replicateSession(id);
  return getSession(id)!;
}
export function getSession(id: string): SessionInfo | undefined {
  const r = db.prepare("SELECT * FROM sessions WHERE id=?").get(id);
  return r ? rowSession(r) : undefined;
}
export function listSessions(o: { archived?: boolean; limit?: number } = {}): SessionInfo[] {
  return (db.prepare(`SELECT s.*, (SELECT COUNT(*) FROM messages m WHERE m.session=s.id) count,
      (SELECT text FROM messages m WHERE m.session=s.id ORDER BY ts DESC, id DESC LIMIT 1) last
    FROM sessions s WHERE archived=? ORDER BY updated DESC LIMIT ?`).all(o.archived ? 1 : 0, o.limit ?? 200) as any[])
    .map((r) => ({ ...rowSession(r), last: String(r.last ?? "").slice(0, 80) }));
}
export function updateSession(id: string, patch: { title?: string; archived?: boolean }) {
  const now = Date.now();
  if (patch.title !== undefined) db.prepare("UPDATE sessions SET title=?, changed=? WHERE id=?").run(patch.title.trim().slice(0, 60) || "新的对话", now, id);
  if (patch.archived !== undefined) db.prepare("UPDATE sessions SET archived=?, changed=? WHERE id=?").run(patch.archived ? 1 : 0, now, id);
  replicateSession(id);
  return getSession(id);
}
function replicateSession(id: string) {
  const r = db.prepare("SELECT id,title,channel,created,updated,archived,changed FROM sessions WHERE id=?").get(id);
  if (r) bus.emit("replica", { table: "sessions", rows: [r] });
}

export function addMessage(role: Role, channel: string, text: string, o: { session?: string; process?: unknown[]; attachments?: Attachment[]; mode?: string; via?: string } = {}) {
  const ts = Date.now(), session = o.session ?? "first", id = nextId("messages");
  const row = { id, ts, role, channel, text, session, process: o.process?.length ? JSON.stringify(o.process) : null, attachments: o.attachments?.length ? JSON.stringify(o.attachments) : null, mode: o.mode ?? null, body: config.body, via: o.via ?? null };
  db.prepare("INSERT INTO messages(id,ts,role,channel,text,session,process,attachments,mode,body,via) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
    .run(row.id, row.ts, row.role, row.channel, row.text, row.session, row.process, row.attachments, row.mode, row.body, row.via);
  db.prepare("UPDATE sessions SET updated=MAX(updated, ?), archived=0 WHERE id=?").run(ts, session); // 有新消息的会话自动回到列表
  bus.emit("replica", { table: "messages", rows: [row] });
  return id;
}
/** 改一条消息的并入方式标记（ambient 的 ignored：她判断不是对她说的）。 */
export function setMessageMode(id: number, mode: string | null) {
  db.prepare("UPDATE messages SET mode=? WHERE id=?").run(mode, id);
  bus.emit("replica", { table: "message.mode", rows: [{ id, mode }] });
}
/** 全部会话里最近的对话（正序）。 */
export function recentMessages(limit = 20): MessageRow[] {
  return (db.prepare("SELECT * FROM messages ORDER BY ts DESC, id DESC LIMIT ?").all(limit) as any[]).map(rowMessage).reverse();
}
/** 某个会话的对话（正序）；before 为消息 id，用于向前翻页（取比它更早的）。 */
export function sessionMessages(session: string, limit = 50, before = Number.MAX_SAFE_INTEGER): MessageRow[] {
  const [bts, bid] = cursor("messages", before);
  return (db.prepare("SELECT * FROM messages WHERE session=?1 AND (ts<?2 OR (ts=?2 AND id<?3)) ORDER BY ts DESC, id DESC LIMIT ?4").all(session, bts, bid, limit) as any[]).map(rowMessage).reverse();
}

// ---------- 复制（多具身体之间，见 mesh/replica.ts）。来自别处的行用这里写入：幂等，不再转发。
export type ReplicaTable = "messages" | "timeline" | "sessions" | "message.mode";
/** 版本向量：每个编号段里见过的最大 id。对方据此只发我没有的。 */
export function idVector(table: "messages" | "timeline"): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of db.prepare(`SELECT CAST(id / ${ID_RANGE} AS INTEGER) p, MAX(id) m FROM ${table} GROUP BY p`).all() as any[]) out[String(r.p)] = Number(r.m);
  return out;
}
/** 对方缺的行：编号段里比对方向量大的（每次最多 limit 行，按 id 升序，便于分页续传）。 */
export function rowsAfter(table: "messages" | "timeline", vector: Record<string, number>, limit = 200): any[] {
  const out: any[] = [];
  for (const r of db.prepare(`SELECT DISTINCT CAST(id / ${ID_RANGE} AS INTEGER) p FROM ${table}`).all() as any[]) {
    const p = Number(r.p), after = Math.max(vector[String(p)] ?? 0, p * ID_RANGE - 1);
    out.push(...(db.prepare(`SELECT * FROM ${table} WHERE id > ? AND id < ? ORDER BY id LIMIT ?`).all(after, (p + 1) * ID_RANGE, limit - out.length) as any[]));
    if (out.length >= limit) break;
  }
  return out;
}
export const allSessions = () => db.prepare("SELECT id,title,channel,created,updated,archived,changed FROM sessions").all() as any[];
// ---------- 复制来的行的检查：字段类型与长度、时间、编号段与作者。不合格的整行丢弃（对方是可信的身体，但数据可能来自出错或被攻破的一方，不能让它弄坏本机的库）
const BODY_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const TS_MIN = Date.UTC(2020, 0, 1);
const FUTURE_MS = 10 * 60_000;
const ROLES = new Set(["user", "agent", "ambient"]);
const isStr = (v: unknown, max: number, min = 0): v is string => typeof v === "string" && v.length >= min && v.length <= max;
const okTs = (t: unknown) => typeof t === "number" && Number.isFinite(t) && t >= TS_MIN && t <= Date.now() + FUTURE_MS;
const okJson = (v: unknown, max: number, shape: (x: unknown) => boolean) => {
  if (v === null || v === undefined) return true;
  if (!isStr(v, max)) return false;
  try { return shape(JSON.parse(v)); } catch { return false; }
};
const okAttachments = (x: unknown) => Array.isArray(x) && x.length <= 50 && x.every((a) => !!a && typeof a === "object" && isStr((a as any).name, 500) && isStr((a as any).rel ?? "", 1000));
const okVia = (v: unknown) => v === null || v === undefined || (isStr(v, 40) && BODY_RE.test(v));
const okMode = (m: unknown) => m === null || m === undefined || (isStr(m, 20) && /^[a-z]+$/.test(m));
/** 编号与作者对得上：id 落在作者身体的编号段里、序号在可用范围内。 */
const okAuthor = (id: unknown, body: unknown): body is string => {
  if (!Number.isSafeInteger(id) || !isStr(body, 40) || !BODY_RE.test(body)) return false;
  const p = Math.floor((id as number) / ID_RANGE), seq = (id as number) - p * ID_RANGE;
  return p === idPrefixOf(body) && seq > 0 && seq < SEQ_MAX;
};
/**
 * 来源规则：平时实时收到的行（catchUp 为假）只能是发来的那具身体自己写的（body === from，编号在它的段里）；
 * 连上时补齐（catchUp）可以带着别的身体的行，也可以带回这具身体自己的旧行（重装后从别处找回历史），但都要编号段与作者对得上。
 */
function okRow(table: "messages" | "timeline", r: any, from: string, catchUp: boolean): boolean {
  if (!r || typeof r !== "object" || !okAuthor(r.id, r.body)) return false;
  if (!catchUp && r.body !== from) return false;
  if (!okTs(r.ts)) return false;
  if (table === "messages") {
    return ROLES.has(r.role) && isStr(r.channel, 100) && isStr(r.text, 200_000) && isStr(r.session, 200, 1) && okMode(r.mode) && okVia(r.via)
      && okJson(r.process, 4 << 20, (x) => Array.isArray(x) || (!!x && typeof x === "object")) && okJson(r.attachments, 256 << 10, okAttachments);
  }
  return isStr(r.kind, 40, 1) && isStr(r.title, 4000) && okJson(r.detail ?? "null", 1 << 20, () => true);
}
const clampTime = (v: unknown, max: number) => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(v, max)) : 0);

/**
 * 写入来自其他身体的行（from：发来的身体；catchUp：连上时的补齐，见 okRow）。不合格的行丢弃。
 * 返回真正新增或改变了的行（调用方据此通知控制台）与丢弃的行数。
 */
export function applyRemote(table: ReplicaTable, rows: any[], o: { from: string; catchUp?: boolean }): { changed: any[]; rejected: number } {
  const changed: any[] = [];
  let rejected = 0;
  if (!Array.isArray(rows)) return { changed, rejected };
  const soon = Date.now() + 5 * 60_000;
  db.exec("BEGIN");
  try {
    for (const r of rows.slice(0, 1000)) {
      if (table === "messages") {
        if (!okRow("messages", r, o.from, !!o.catchUp)) { rejected++; continue; }
        const ok = db.prepare("INSERT OR IGNORE INTO messages(id,ts,role,channel,text,session,process,attachments,mode,body,via) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
          .run(r.id, r.ts, r.role, r.channel, r.text, r.session, r.process ?? null, r.attachments ?? null, r.mode ?? null, r.body, r.via ?? null);
        if (Number(ok.changes)) {
          db.prepare("INSERT OR IGNORE INTO sessions(id,title,channel,created,updated,changed) VALUES(?,?,?,?,?,0)").run(r.session, "新的对话", r.channel, r.ts, r.ts);
          db.prepare("UPDATE sessions SET updated=MAX(updated, ?), archived=0 WHERE id=?").run(r.ts, r.session);
          changed.push(r);
        }
      } else if (table === "timeline") {
        if (!okRow("timeline", r, o.from, !!o.catchUp)) { rejected++; continue; }
        if (Number(db.prepare("INSERT OR IGNORE INTO timeline(id,ts,kind,title,detail,body) VALUES(?,?,?,?,?,?)").run(r.id, r.ts, r.kind, r.title, r.detail ?? "null", r.body).changes)) changed.push(r);
      } else if (table === "message.mode") {
        if (!r || !Number.isSafeInteger(r.id) || !okMode(r.mode)) { rejected++; continue; }
        if (Number(db.prepare("UPDATE messages SET mode=? WHERE id=? AND COALESCE(mode,'')<>COALESCE(?,'')").run(r.mode ?? null, r.id, r.mode ?? null).changes)) changed.push(r);
      } else if (table === "sessions") {
        if (!r || !isStr(r.id, 200, 1) || !isStr(r.title, 200) || !isStr(r.channel, 100)) { rejected++; continue; }
        // 时间一律不晚于「现在 + 5 分钟」：一个远在未来的修改时刻会让标题永远改不动
        const s = { id: r.id, title: r.title, channel: r.channel, created: clampTime(r.created, soon), updated: clampTime(r.updated, soon), changed: clampTime(r.changed ?? 0, soon), archived: r.archived === true || r.archived === 1 ? 1 : 0 };
        const cur = db.prepare("SELECT * FROM sessions WHERE id=?").get(s.id) as any;
        if (!cur) { db.prepare("INSERT INTO sessions(id,title,channel,created,updated,archived,changed) VALUES(?,?,?,?,?,?,?)").run(s.id, s.title, s.channel, s.created, s.updated, s.archived, s.changed); changed.push(s); continue; }
        // 标题与归档：以较新的修改为准；最近更新取两边较大的；创建时间取较早的
        const takeTheirs = s.changed > (cur.changed ?? 0) || ((cur.changed ?? 0) === 0 && cur.title === "新的对话" && s.title !== "新的对话");
        const next = { title: takeTheirs ? s.title : cur.title, archived: takeTheirs ? s.archived : cur.archived, changed: Math.max(cur.changed ?? 0, s.changed), updated: Math.max(cur.updated, s.updated), created: Math.min(cur.created, s.created) };
        if (next.title !== cur.title || next.archived !== cur.archived || next.updated !== cur.updated || next.created !== cur.created || next.changed !== (cur.changed ?? 0)) {
          db.prepare("UPDATE sessions SET title=?, archived=?, changed=?, updated=?, created=? WHERE id=?").run(next.title, next.archived, next.changed, next.updated, next.created, s.id);
          changed.push(s);
        }
      }
    }
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
  return { changed, rejected };
}

// ---------- 工具调用的完整记录：每次调用的完整参数（保密值已替换）与完整结果，只存在这具身体上，不复制给其他身体、不进灵魂仓库。
//   控制台点开一张工具卡片时取它（本机没有就经网状层问做那一轮的身体）。过程记录（会复制）里只有摘要与结果开头。
const TOOL_CALLS_KEEP = 50_000; // 最多留这么多条，超出删最旧的
export interface ToolCallRow { call: string; session: string; ts: number; tool: string; args: unknown; result: string; status: string; ms: number }
export function saveToolCall(r: Omit<ToolCallRow, "args"> & { args: unknown }) {
  db.prepare("INSERT OR REPLACE INTO tool_calls(call,session,ts,tool,args,result,status,ms) VALUES(?,?,?,?,?,?,?,?)")
    .run(r.call, r.session, r.ts, r.tool, JSON.stringify(r.args ?? null), r.result, r.status, r.ms);
  if (Math.random() < 0.01) db.prepare("DELETE FROM tool_calls WHERE ts < (SELECT ts FROM tool_calls ORDER BY ts DESC LIMIT 1 OFFSET ?)").run(TOOL_CALLS_KEEP);
}
/** 一次工具调用的完整记录（同一个调用编号以最新的为准）；没有返回 undefined。 */
export function getToolCall(call: string): ToolCallRow | undefined {
  if (!call) return undefined;
  const r = db.prepare("SELECT * FROM tool_calls WHERE call = ? ORDER BY ts DESC LIMIT 1").get(call) as any;
  if (!r) return undefined;
  let args: unknown = null; try { args = JSON.parse(r.args); } catch { args = r.args; }
  return { call: r.call, session: r.session, ts: r.ts, tool: r.tool, args, result: r.result, status: r.status, ms: r.ms };
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
  db.prepare(`INSERT INTO usage(day,model,body,input,output,cost) VALUES(?,?,?,?,?,?) ON CONFLICT(day,model,body) DO UPDATE SET
    input=input+excluded.input, output=output+excluded.output, cost=cost+excluded.cost`).run(today(), model, config.body, input, output, cost);
  const row = db.prepare("SELECT * FROM usage WHERE day=? AND model=? AND body=?").get(today(), model, config.body) as any;
  bus.emit("usage", { day: row.day, model: row.model, body: row.body, input: Number(row.input), output: Number(row.output), cost: Number(row.cost) });
}
/** 今天的用量：多具身体时为各身体之和（每日预算是全网的）。 */
export function usageToday() {
  const r = db.prepare("SELECT COALESCE(SUM(input+output),0) tokens, COALESCE(SUM(cost),0) cost FROM usage WHERE day=?").get(today()) as any;
  return { tokens: Number(r.tokens), cost: Number(r.cost) };
}
/** 某天各身体的用量行（同步给其他身体）。 */
export const usageRows = (day = today()) => (db.prepare("SELECT day,model,body,input,output,cost FROM usage WHERE day=?").all(day) as any[]).map((r) => ({ ...r, input: Number(r.input), output: Number(r.output), cost: Number(r.cost) }));
/** 写入另一具身体（from）的用量行：只收它自己的（body === from）、数值是有限的非负数；整行替换，不动这具身体自己的行。 */
export function applyUsage(rows: unknown, from: string) {
  if (!Array.isArray(rows) || from === config.body) return;
  const n = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0;
  for (const r of rows.slice(0, 500) as any[]) {
    if (!r || r.body !== from || !isStr(r.day, 10) || !/^\d{4}-\d{2}-\d{2}$/.test(r.day) || !isStr(r.model, 200, 1) || !n(r.input) || !n(r.output) || !n(r.cost)) continue;
    db.prepare("INSERT OR REPLACE INTO usage(day,model,body,input,output,cost) VALUES(?,?,?,?,?,?)").run(r.day, r.model, r.body, r.input, r.output, r.cost);
  }
}
