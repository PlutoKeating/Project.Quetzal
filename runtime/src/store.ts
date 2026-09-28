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
  `);
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

export function addMessage(role: "user" | "agent", channel: string, text: string) {
  db.prepare("INSERT INTO messages(ts,role,channel,text) VALUES(?,?,?,?)").run(Date.now(), role, channel, text);
}
export function recentMessages(limit = 20) {
  return (db.prepare("SELECT ts,role,channel,text FROM messages ORDER BY id DESC LIMIT ?").all(limit) as any[]).reverse();
}

export function audit(actor: string, action: string, reason: string, args: unknown, result: string) {
  db.prepare("INSERT INTO audit(ts,actor,action,reason,args,result) VALUES(?,?,?,?,?,?)")
    .run(Date.now(), actor, action, reason, JSON.stringify(args ?? null).slice(0, 2000), result.slice(0, 2000));
}
export function listAudit(limit = 100) {
  return db.prepare("SELECT * FROM audit ORDER BY id DESC LIMIT ?").all(limit);
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
