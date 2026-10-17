// Canvas：对话旁边的一块独立编辑区（issue #33 运行代码、#34 评论协作）。她写的文档或代码放在这里，对方和她一起改。
//   - 每个会话可以有若干份 canvas，类型是 markdown 文档或代码（带语言）。每次修改都是一个新版本（不可变），可以回看、恢复（恢复也是一个新版本）。
//   - 存在本机 SQLite（canvas_docs / canvas_versions / canvas_comments / canvas_runs，第一次用到时建表），
//     经网状层复制给同一个 agent 的其他身体（mesh/canvas.ts；收到的行由这里的 applyCanvasRemote 逐字段检查）。
//   - 并发：两边同时改，两个版本都留下，按时间较新的是当前版本（另一个在历史里，可以恢复）；标题、语言、删除按较新的修改为准；
//     评论的回复是新行，解决 / 重开按较新的修改为准。
//   - 评论锚定到一段文字：记下被评论的原文、起止位置与前后各 32 个字符；内容变了以后按原文重新定位（多处出现时取前后文最吻合、离原位置最近的），
//     原文不在了就标为过时（stale），不猜。
//   - 运行代码（runCanvas）：Python / JavaScript（Node）/ TypeScript（Node 去类型）/ shell / PowerShell，经 sh.ts 的 shell——与她的命令同一个沙箱，
//     不经沙箱的路径一律没有（真实环境也不例外）；超时按「多久没有输出」计、另有总时长上限，输出有上限；解释器不存在时如实说明、不执行。
//     生成的图片（matplotlib 保存的 png 等）复制到 data/canvas-runs/<运行>/，控制台经 canvas.runImage 取来显示，她可以用 view_image 看。
//     闸门（「执行命令」类别）与审计由调用方负责：她的 canvas_run 经 callTool，控制台的运行经 canvas-ops.ts。
//   - 她在下一轮的系统提示里看到这个会话的 canvas（canvasBlock）：小的给全文，大的给开头与标题大纲（canvas_read 分页读），
//     对方改过的标明并附上改动的那一段，未解决的评论、最近一次运行的结果。
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import * as store from "../store.ts";
import { bus } from "../bus.ts";
import { config, paths } from "../config.ts";
import { shell } from "../sh.ts";
import { workDir, powershellPath, psq } from "../sandbox.ts";
import { isWindows, which } from "../platform.ts";

export type CanvasKind = "markdown" | "code";
export type Author = "agent" | "user";
export interface CanvasDoc { id: string; conv: string; title: string; kind: CanvasKind; lang: string; created: number; changed: number; deleted: boolean; body: string } // body：最后修改这一行的身体
export interface CanvasVersion { id: string; doc: string; ts: number; author: Author; body: string; content: string; note: string; parent: string | null }
export interface CanvasComment {
  id: string; doc: string; thread: string | null; ts: number; author: Author; body: string; text: string; // thread：回复所属的评论（根评论为 null）
  quote: string; start: number; end: number; version: string | null; prefix: string; suffix: string; // 锚点（只有根评论有）
  resolved: boolean; changed: number; suggestion: string | null; // suggestion：编辑建议——把被评论的原文换成这段文字
}
export interface RunImage { name: string; size: number; mime: string }
export interface CanvasRun { id: string; doc: string; version: string; ts: number; by: Author; body: string; lang: string; code: number; out: string; err: string; images: RunImage[]; ms: number; dir: string; note: string }
export interface Located { start: number; end: number; status: "exact" | "moved" | "stale"; line: number; endLine: number }
export interface Thread extends CanvasComment { at: Located; replies: CanvasComment[] }
export interface CanvasSummary extends CanvasDoc { version: number; versionId: string; versions: number; updated: number; author: Author; size: number; open: number }
export interface CanvasView extends CanvasSummary { content: string; threads: Thread[]; runs: CanvasRun[] }

/** 她或对方用错了（没有这份 canvas、要替换的片段找不到……）：工具把说明交给她，网关作为错误返回。 */
export class CanvasError extends Error { constructor(m: string) { super(m); this.name = "CanvasError"; } }

export const MAX_CONTENT = 500_000; // 一份 canvas 最多这么多字符（网关单条消息 4 MiB，中文 3 字节一个）
const MAX_TITLE = 200, MAX_COMMENT = 20_000, CTX = 32;
const ID = { doc: /^cv-[0-9a-f]{12}$/, version: /^v-[0-9a-f]{16}$/, comment: /^cm-[0-9a-f]{12}$/, run: /^run-[0-9a-f]{12}$/ };
const newId = (p: "cv" | "v" | "cm" | "run") => `${p}-${crypto.randomBytes(p === "v" ? 8 : 6).toString("hex")}`;

// ---------------------------------------------------------------- 存储
let ready: DatabaseSync | undefined;
/** 当前的数据库，第一次用到时建表（不改 store.ts 的建表；测试重新打开数据库时也能跟上）。 */
function db(): DatabaseSync {
  const d = store.db;
  if (ready !== d) {
    d.exec(`
      CREATE TABLE IF NOT EXISTS canvas_docs(id TEXT PRIMARY KEY, conv TEXT, title TEXT, kind TEXT, lang TEXT, created INTEGER, changed INTEGER, deleted INTEGER DEFAULT 0, body TEXT);
      CREATE TABLE IF NOT EXISTS canvas_versions(id TEXT PRIMARY KEY, doc TEXT, ts INTEGER, author TEXT, body TEXT, content TEXT, note TEXT, parent TEXT);
      CREATE TABLE IF NOT EXISTS canvas_comments(id TEXT PRIMARY KEY, doc TEXT, thread TEXT, ts INTEGER, author TEXT, body TEXT, text TEXT, quote TEXT, start INTEGER, end INTEGER, version TEXT, prefix TEXT, suffix TEXT, resolved INTEGER DEFAULT 0, changed INTEGER, suggestion TEXT);
      CREATE TABLE IF NOT EXISTS canvas_runs(id TEXT PRIMARY KEY, doc TEXT, version TEXT, ts INTEGER, by TEXT, body TEXT, lang TEXT, code INTEGER, out TEXT, err TEXT, images TEXT, ms INTEGER, dir TEXT, note TEXT);
      CREATE INDEX IF NOT EXISTS canvas_docs_conv ON canvas_docs(conv);
      CREATE INDEX IF NOT EXISTS canvas_versions_doc ON canvas_versions(doc, ts, id);
      CREATE INDEX IF NOT EXISTS canvas_comments_doc ON canvas_comments(doc, ts);
      CREATE INDEX IF NOT EXISTS canvas_runs_doc ON canvas_runs(doc, ts);
    `);
    ready = d;
  }
  return d;
}

const rowDoc = (r: any): CanvasDoc => ({ id: r.id, conv: r.conv, title: r.title, kind: r.kind === "code" ? "code" : "markdown", lang: r.lang ?? "", created: Number(r.created), changed: Number(r.changed), deleted: !!r.deleted, body: r.body ?? "" });
const rowVersion = (r: any): CanvasVersion => ({ id: r.id, doc: r.doc, ts: Number(r.ts), author: r.author === "agent" ? "agent" : "user", body: r.body ?? "", content: r.content ?? "", note: r.note ?? "", parent: r.parent ?? null });
const rowComment = (r: any): CanvasComment => ({ id: r.id, doc: r.doc, thread: r.thread ?? null, ts: Number(r.ts), author: r.author === "agent" ? "agent" : "user", body: r.body ?? "", text: r.text ?? "", quote: r.quote ?? "", start: Number(r.start ?? 0), end: Number(r.end ?? 0), version: r.version ?? null, prefix: r.prefix ?? "", suffix: r.suffix ?? "", resolved: !!r.resolved, changed: Number(r.changed ?? r.ts), suggestion: r.suggestion ?? null });
const rowRun = (r: any): CanvasRun => ({ id: r.id, doc: r.doc, version: r.version, ts: Number(r.ts), by: r.by === "agent" ? "agent" : "user", body: r.body ?? "", lang: r.lang ?? "", code: Number(r.code), out: r.out ?? "", err: r.err ?? "", images: safeJson(r.images, []), ms: Number(r.ms ?? 0), dir: r.dir ?? "", note: r.note ?? "" });
const safeJson = <T>(s: unknown, d: T): T => { try { return typeof s === "string" ? JSON.parse(s) : d; } catch { return d; } };

/** 原样的行（复制给其他身体用）。 */
const raw = (table: string, id: string) => db().prepare(`SELECT * FROM ${table} WHERE id=?`).get(id) as any;
function replicate(part: { docs?: string[]; versions?: string[]; comments?: string[]; runs?: string[] }) {
  const pick = (t: string, ids?: string[]) => (ids ?? []).map((id) => raw(t, id)).filter(Boolean);
  bus.emit("canvas.replica", { docs: pick("canvas_docs", part.docs), versions: pick("canvas_versions", part.versions), comments: pick("canvas_comments", part.comments), runs: pick("canvas_runs", part.runs) });
}
const changed = (d: CanvasDoc, kind: string, extra: Record<string, unknown> = {}) => bus.emit("canvas.changed", { doc: d.id, conv: d.conv, kind, ...extra });

// ---------------------------------------------------------------- 语言
const ALIASES: Record<string, string> = {
  py: "python", python3: "python", js: "javascript", node: "javascript", mjs: "javascript", cjs: "javascript", nodejs: "javascript",
  ts: "typescript", sh: "shell", bash: "shell", zsh: "shell", ps1: "powershell", pwsh: "powershell", ps: "powershell", md: "markdown", yml: "yaml",
};
/** 语言名规范化：小写、别名合一；不合规的写法当作没写。 */
export function normLang(l: unknown): string {
  const s = String(l ?? "").trim().toLowerCase();
  const v = ALIASES[s] ?? s;
  return /^[a-z0-9+#._-]{0,20}$/.test(v) ? v : "";
}
/** 可以一键运行的语言。 */
export const RUNNABLE = ["python", "javascript", "typescript", "shell", "powershell"];

// ---------------------------------------------------------------- 读
export function getDoc(id: string): CanvasDoc | undefined {
  const r = db().prepare("SELECT * FROM canvas_docs WHERE id=?").get(String(id ?? ""));
  return r ? rowDoc(r) : undefined;
}
function mustDoc(id: string): CanvasDoc {
  const d = getDoc(id);
  if (!d || d.deleted) throw new CanvasError(`没有这份 canvas：${id}${d?.deleted ? "（已删除）" : ""}`);
  return d;
}
/** 全部版本（按时间，第 1 版在前）。 */
export function versions(doc: string): CanvasVersion[] {
  return (db().prepare("SELECT * FROM canvas_versions WHERE doc=? ORDER BY ts, id").all(doc) as any[]).map(rowVersion);
}
export function head(doc: string): CanvasVersion | undefined {
  const r = db().prepare("SELECT * FROM canvas_versions WHERE doc=? ORDER BY ts DESC, id DESC LIMIT 1").get(doc);
  return r ? rowVersion(r) : undefined;
}
/** 第 n 版（从 1 起）或某个版本 id；不给时为当前版本。 */
export function versionOf(doc: string, v?: number | string): { v: CanvasVersion; n: number; total: number } {
  const all = versions(doc);
  if (!all.length) throw new CanvasError("这份 canvas 还没有内容");
  const n = v === undefined || v === null || v === "" ? all.length
    : typeof v === "number" || /^\d+$/.test(String(v)) ? Number(v)
    : all.findIndex((x) => x.id === v) + 1;
  if (!(n >= 1 && n <= all.length)) throw new CanvasError(`没有这个版本：${v}（共 ${all.length} 版）`);
  return { v: all[n - 1], n, total: all.length };
}

function summary(d: CanvasDoc): CanvasSummary {
  const all = db().prepare("SELECT id, ts, author, length(content) size FROM canvas_versions WHERE doc=? ORDER BY ts DESC, id DESC").all(d.id) as any[];
  const h = all[0];
  const open = Number((db().prepare("SELECT COUNT(*) n FROM canvas_comments WHERE doc=? AND thread IS NULL AND resolved=0").get(d.id) as any).n);
  return { ...d, version: all.length, versionId: h?.id ?? "", versions: all.length, updated: Math.max(Number(h?.ts ?? 0), d.changed), author: h?.author === "agent" ? "agent" : "user", size: Number(h?.size ?? 0), open };
}

/** 一个会话的 canvas（不给 conv 时为全部），最近修改的在前；删除了的不列。 */
export function listCanvases(conv?: string): CanvasSummary[] {
  const rows = (conv ? db().prepare("SELECT * FROM canvas_docs WHERE conv=? AND deleted=0").all(conv) : db().prepare("SELECT * FROM canvas_docs WHERE deleted=0").all()) as any[];
  return rows.map((r) => summary(rowDoc(r))).sort((a, b) => b.updated - a.updated);
}

/** 一份 canvas 的完整视图：某个版本（缺省当前）的内容、评论（按当前内容重新定位）、最近几次运行。 */
export function getCanvas(id: string, o: { version?: number | string } = {}): CanvasView {
  const d = mustDoc(id);
  const { v, n } = versionOf(d.id, o.version);
  return { ...summary(d), version: n, versionId: v.id, author: v.author, size: v.content.length, content: v.content, threads: threads(d.id, v.content), runs: runs(d.id, 5) };
}

// ---------------------------------------------------------------- 写：新建、修改、恢复、改名、删除
/** 新版本的时刻：严格晚于当前版本（同一毫秒里连改两次也分得出先后）。 */
const nextTs = (doc: string) => Math.max(Date.now(), (head(doc)?.ts ?? 0) + 1);

function addVersion(doc: CanvasDoc, content: string, author: Author, note: string): CanvasVersion {
  if (content.length > MAX_CONTENT) throw new CanvasError(`内容太长：${content.length} 个字符，一份 canvas 最多 ${MAX_CONTENT} 个`);
  const parent = head(doc.id)?.id ?? null;
  const v: CanvasVersion = { id: newId("v"), doc: doc.id, ts: nextTs(doc.id), author, body: config.body, content, note: note.slice(0, 500), parent };
  db().prepare("INSERT INTO canvas_versions(id,doc,ts,author,body,content,note,parent) VALUES(?,?,?,?,?,?,?,?)").run(v.id, v.doc, v.ts, v.author, v.body, v.content, v.note, v.parent);
  if (author === "agent") markSeen(doc.id, v.id); // 她自己写的当然看过
  return v;
}

export function createCanvas(o: { conv: string; title: string; kind?: string; lang?: string; content?: string; author: Author; note?: string }): CanvasView {
  const conv = String(o.conv ?? "").trim();
  if (!conv || conv.length > 200) throw new CanvasError("canvas 属于一个会话：没有会话");
  const title = String(o.title ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_TITLE) || "未命名";
  const lang = normLang(o.lang);
  const kind: CanvasKind = o.kind === "code" || (o.kind !== "markdown" && lang && lang !== "markdown") ? "code" : "markdown";
  const now = Date.now();
  const d: CanvasDoc = { id: newId("cv"), conv, title, kind, lang: kind === "code" ? lang : "", created: now, changed: now, deleted: false, body: config.body };
  db().prepare("INSERT INTO canvas_docs(id,conv,title,kind,lang,created,changed,deleted,body) VALUES(?,?,?,?,?,?,?,0,?)").run(d.id, d.conv, d.title, d.kind, d.lang, d.created, d.changed, d.body);
  const v = addVersion(d, String(o.content ?? ""), o.author, o.note ?? "新建");
  replicate({ docs: [d.id], versions: [v.id] });
  changed(d, "created", { author: o.author });
  return getCanvas(d.id);
}

export interface Edit { find: string; replace: string; all?: boolean }
/** 按片段查找替换：每个 find 必须原样出现；出现不止一次又没有 all 时不替换（让她给更长的片段），免得改错地方。 */
export function applyEdits(content: string, edits: Edit[]): string {
  if (!Array.isArray(edits) || !edits.length) throw new CanvasError("edits 是空的");
  let out = content;
  edits.forEach((e, i) => {
    const find = String(e?.find ?? ""), rep = String(e?.replace ?? "");
    if (!find) throw new CanvasError(`第 ${i + 1} 处修改的 find 是空的`);
    const n = out.split(find).length - 1;
    if (!n) throw new CanvasError(`第 ${i + 1} 处修改没有找到要替换的片段（要与当前内容逐字一致，含空白与换行）：「${find.slice(0, 80)}${find.length > 80 ? "…" : ""}」`);
    if (n > 1 && !e.all) throw new CanvasError(`第 ${i + 1} 处修改的片段出现了 ${n} 次：给更长、只出现一次的片段，或者 all=true 全部替换`);
    out = e.all ? out.split(find).join(rep) : out.replace(find, () => rep);
  });
  return out;
}

/**
 * 修改：content 整体替换，或 edits 按片段查找替换（基于当前版本）。内容没变就不生成新版本。
 * base：控制台编辑时基于的版本 id；保存时当前版本已经不是它（她刚改过），照样保存为最新版本，返回 conflict 让控制台说明（她的那版在历史里）。
 */
export function editCanvas(id: string, o: { content?: string; edits?: Edit[]; author: Author; note?: string; base?: string }): { view: CanvasView; conflict: boolean; changed: boolean } {
  const d = mustDoc(id);
  const cur = head(d.id);
  const before = cur?.content ?? "";
  const next = typeof o.content === "string" ? o.content : applyEdits(before, o.edits ?? []);
  const conflict = !!o.base && !!cur && o.base !== cur.id;
  if (next === before) return { view: getCanvas(d.id), conflict, changed: false };
  const v = addVersion(d, next, o.author, o.note ?? (typeof o.content === "string" ? "整体替换" : `改了 ${o.edits?.length ?? 0} 处`));
  replicate({ versions: [v.id] });
  changed(d, "edited", { author: o.author, version: v.id });
  return { view: getCanvas(d.id), conflict, changed: true };
}

/** 恢复到某个版本：把它的内容存成一个新版本（历史不改写）。 */
export function restoreCanvas(id: string, version: number | string, author: Author): CanvasView {
  const d = mustDoc(id);
  const { v, n } = versionOf(d.id, version);
  return editCanvas(d.id, { content: v.content, author, note: `恢复到第 ${n} 版` }).view;
}

/** 改标题 / 语言 / 类型，或删除（只做标记，复制给其他身体；版本仍在库里）。 */
export function updateCanvas(id: string, patch: { title?: string; lang?: string; kind?: string; deleted?: boolean }): CanvasDoc {
  const d = getDoc(id);
  if (!d) throw new CanvasError(`没有这份 canvas：${id}`);
  const next = { ...d };
  if (typeof patch.title === "string") next.title = patch.title.replace(/\s+/g, " ").trim().slice(0, MAX_TITLE) || d.title;
  if (patch.kind === "code" || patch.kind === "markdown") next.kind = patch.kind;
  if (patch.lang !== undefined) next.lang = normLang(patch.lang);
  if (next.kind === "markdown") next.lang = "";
  if (typeof patch.deleted === "boolean") next.deleted = patch.deleted;
  next.changed = Math.max(Date.now(), d.changed + 1); next.body = config.body;
  db().prepare("UPDATE canvas_docs SET title=?, kind=?, lang=?, deleted=?, changed=?, body=? WHERE id=?").run(next.title, next.kind, next.lang, next.deleted ? 1 : 0, next.changed, next.body, d.id);
  replicate({ docs: [d.id] });
  changed(next, next.deleted ? "deleted" : "meta");
  return next;
}

// ---------------------------------------------------------------- 评论：锚定与重新定位
export interface Anchor { quote: string; start: number; end: number; prefix: string; suffix: string }
/** 在 content 的 [start, end) 上建锚点：原文与前后各 32 个字符。 */
export function anchorAt(content: string, start: number, end: number): Anchor {
  const s = Math.max(0, Math.min(content.length, Math.floor(start))), e = Math.max(s, Math.min(content.length, Math.floor(end)));
  return { quote: content.slice(s, e), start: s, end: e, prefix: content.slice(Math.max(0, s - CTX), s), suffix: content.slice(e, e + CTX) };
}
const lineOf = (content: string, at: number) => { let n = 1; for (let i = 0; i < at && i < content.length; i++) if (content.charCodeAt(i) === 10) n++; return n; };
const commonTail = (a: string, b: string) => { let n = 0; while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++; return n; };
const commonHead = (a: string, b: string) => { let n = 0; while (n < a.length && n < b.length && a[n] === b[n]) n++; return n; };
/**
 * 按当前内容重新定位锚点：原位置上还是原文 → exact；原文在别处（可能多处）→ 取前后文最吻合、离原位置最近的那处 → moved；
 * 原文已经不在了 → stale（过时，位置只是原来的大致地方，不猜新的）。没有原文的锚点（评论整份文档）总是 exact。
 */
export function locate(content: string, a: Anchor): Located {
  const at = (start: number, end: number, status: Located["status"]): Located => ({ start, end, status, line: lineOf(content, start), endLine: lineOf(content, Math.max(start, end - 1)) });
  if (!a.quote) return at(0, 0, "exact");
  if (content.slice(a.start, a.end) === a.quote) return at(a.start, a.end, "exact");
  let best = -1, bestScore = -1, bestDist = Infinity;
  for (let i = content.indexOf(a.quote), k = 0; i >= 0 && k < 1000; i = content.indexOf(a.quote, i + 1), k++) {
    const score = commonTail(content.slice(Math.max(0, i - CTX), i), a.prefix) + commonHead(content.slice(i + a.quote.length, i + a.quote.length + CTX), a.suffix);
    const dist = Math.abs(i - a.start);
    if (score > bestScore || (score === bestScore && dist < bestDist)) { best = i; bestScore = score; bestDist = dist; }
  }
  if (best >= 0) return at(best, best + a.quote.length, "moved");
  const s = Math.min(a.start, content.length);
  return at(s, s, "stale");
}

function comment(id: string): CanvasComment | undefined {
  const r = db().prepare("SELECT * FROM canvas_comments WHERE id=?").get(String(id ?? ""));
  return r ? rowComment(r) : undefined;
}
/** 一份 canvas 的评论串（根评论 + 回复，按时间），锚点按 content（缺省为当前版本）重新定位。 */
export function threads(doc: string, content?: string): Thread[] {
  const text = content ?? head(doc)?.content ?? "";
  const all = (db().prepare("SELECT * FROM canvas_comments WHERE doc=? ORDER BY ts, id").all(doc) as any[]).map(rowComment);
  return all.filter((c) => !c.thread).map((c) => ({ ...c, at: locate(text, c), replies: all.filter((r) => r.thread === c.id) }));
}

/**
 * 加一条评论。锚点二选一：start / end（控制台里选中的范围，按当前版本）或 quote（她给的原文，在当前版本里找；出现多次时用 occurrence 选第几处，缺省第一处）。
 * 都不给就是评论整份文档。suggestion：编辑建议（把被评论的原文换成它），对方可以一键采纳。
 */
export function addComment(o: { doc: string; text: string; author: Author; start?: number; end?: number; quote?: string; occurrence?: number; suggestion?: string }): Thread {
  const d = mustDoc(o.doc);
  const text = String(o.text ?? "").trim();
  if (!text && !o.suggestion) throw new CanvasError("评论是空的");
  if (text.length > MAX_COMMENT) throw new CanvasError(`评论太长：最多 ${MAX_COMMENT} 个字符`);
  const h = head(d.id), content = h?.content ?? "";
  let a: Anchor = { quote: "", start: 0, end: 0, prefix: "", suffix: "" };
  if (typeof o.quote === "string" && o.quote) {
    let i = -1;
    for (let k = 0, from = 0; k < Math.max(1, Math.floor(o.occurrence ?? 1)); k++) { i = content.indexOf(o.quote, from); if (i < 0) break; from = i + 1; }
    if (i < 0) throw new CanvasError(`当前版本里没有找到要评论的原文：「${o.quote.slice(0, 80)}」（要与内容逐字一致）`);
    a = anchorAt(content, i, i + o.quote.length);
  } else if (Number.isFinite(o.start) && Number.isFinite(o.end) && Number(o.end) > Number(o.start)) {
    a = anchorAt(content, Number(o.start), Number(o.end));
  }
  if (a.quote.length > MAX_COMMENT) throw new CanvasError(`被评论的片段太长：最多 ${MAX_COMMENT} 个字符`);
  const suggestion = typeof o.suggestion === "string" && a.quote ? o.suggestion.slice(0, 100_000) : null;
  const now = Date.now();
  const c: CanvasComment = { id: newId("cm"), doc: d.id, thread: null, ts: now, author: o.author, body: config.body, text, ...a, version: h?.id ?? null, resolved: false, changed: now, suggestion };
  db().prepare("INSERT INTO canvas_comments(id,doc,thread,ts,author,body,text,quote,start,end,version,prefix,suffix,resolved,changed,suggestion) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?)")
    .run(c.id, c.doc, null, c.ts, c.author, c.body, c.text, c.quote, c.start, c.end, c.version, c.prefix, c.suffix, c.changed, c.suggestion);
  if (o.author === "agent") markSeen(`comment:${c.id}`, "1");
  replicate({ comments: [c.id] });
  changed(d, "comment", { author: o.author, comment: c.id });
  return { ...c, at: locate(content, c), replies: [] };
}

/** 回复一条评论（回复不带锚点）。thread 可以是根评论或其中一条回复的 id。有人回复时重新打开（已解决的串里又有人说话）。 */
export function replyComment(thread: string, text: string, author: Author): CanvasComment {
  const t = rootOf(thread);
  const body = String(text ?? "").trim();
  if (!body) throw new CanvasError("回复是空的");
  if (body.length > MAX_COMMENT) throw new CanvasError(`回复太长：最多 ${MAX_COMMENT} 个字符`);
  const now = Math.max(Date.now(), t.ts + 1);
  const c: CanvasComment = { id: newId("cm"), doc: t.doc, thread: t.id, ts: now, author, body: config.body, text: body, quote: "", start: 0, end: 0, version: null, prefix: "", suffix: "", resolved: false, changed: now, suggestion: null };
  db().prepare("INSERT INTO canvas_comments(id,doc,thread,ts,author,body,text,quote,start,end,version,prefix,suffix,resolved,changed,suggestion) VALUES(?,?,?,?,?,?,?,'',0,0,NULL,'','',0,?,NULL)")
    .run(c.id, c.doc, c.thread, c.ts, c.author, c.body, c.text, c.changed);
  const ids = [c.id];
  if (t.resolved) { setResolvedRow(t, false); ids.push(t.id); }
  replicate({ comments: ids });
  const d = getDoc(t.doc);
  if (d) changed(d, "comment", { author, comment: t.id });
  return c;
}
function rootOf(id: string): CanvasComment {
  const c = comment(id);
  if (!c) throw new CanvasError(`没有这条评论：${id}`);
  const t = c.thread ? comment(c.thread) : c;
  if (!t) throw new CanvasError(`这条回复所属的评论不在了：${id}`);
  return t;
}
function setResolvedRow(t: CanvasComment, resolved: boolean) {
  db().prepare("UPDATE canvas_comments SET resolved=?, changed=?, body=? WHERE id=?").run(resolved ? 1 : 0, Math.max(Date.now(), t.changed + 1), config.body, t.id);
}
/** 标为已解决 / 重新打开。 */
export function resolveComment(thread: string, resolved: boolean, author: Author): CanvasComment {
  const t = rootOf(thread);
  if (t.resolved !== resolved) { setResolvedRow(t, resolved); replicate({ comments: [t.id] }); }
  const d = getDoc(t.doc);
  if (d) changed(d, "comment", { author, comment: t.id });
  return comment(t.id)!;
}

/** 采纳编辑建议：把评论定位到的原文换成建议的文字（新版本），并把评论标为已解决。原文已经不在了（过时）就不采纳。 */
export function applySuggestion(thread: string, author: Author): CanvasView {
  const t = rootOf(thread);
  if (t.suggestion === null) throw new CanvasError("这条评论没有编辑建议");
  const content = head(t.doc)?.content ?? "";
  const at = locate(content, t);
  if (at.status === "stale") throw new CanvasError("被评论的原文已经改掉了，这条建议对不上当前内容");
  const next = content.slice(0, at.start) + t.suggestion + content.slice(at.end);
  const r = editCanvas(t.doc, { content: next, author, note: "采纳了一条编辑建议" });
  resolveComment(t.id, true, author);
  return r.view;
}

// ---------------------------------------------------------------- 她看过哪一版（只在这具身体上，系统提示据此标出「对方改过」）
const SEEN = "canvas.seen";
function markSeen(key: string, v: string) {
  const m = store.kv.get<Record<string, string>>(SEEN, {});
  if (m[key] === v) return;
  m[key] = v;
  const keys = Object.keys(m);
  for (const k of keys.slice(0, Math.max(0, keys.length - 2000))) delete m[k]; // 只留最近的
  store.kv.set(SEEN, m);
}
const seenOf = (key: string) => store.kv.get<Record<string, string>>(SEEN, {})[key];
/** 她读过某个版本（canvas_read）。 */
export function noteRead(doc: string, version: string) { const h = head(doc); if (h && h.id === version) markSeen(doc, version); }

// ---------------------------------------------------------------- 运行代码
export const MAX_RUN_OUTPUT = 64 * 1024; // 存下的 stdout / stderr 各这么多（超出留开头与结尾）
const MAX_TOTAL_MS = 15 * 60_000; // 一次运行的总时长上限（超时另按「多久没有输出」计）
const MAX_IMAGES = 8, MAX_IMAGE_BYTES = 4 << 20;
const IMAGE_EXT: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml" };

/** 运行目录：她的工作区里（沙箱里可写、对方也拿得到生成的文件）。Linux 的工作目录是主目录，放进主目录下的 Quetzal/canvas。 */
export const runRoot = () => process.env.QUETZAL_CANVAS_DIR || (workDir() === os.homedir() ? path.join(os.homedir(), "Quetzal", "canvas") : path.join(workDir(), "canvas"));
const imageRoot = () => path.join(paths.data, "canvas-runs");

/** 解释器：找不到时返回说明（不执行）。find 可替换（测试用）。 */
export function interpreter(lang: string, code: string, find: (c: string) => string | undefined = which): { cmd: string; args: string[]; file: string } | { missing: string } {
  const usable = (c: string) => { const p = find(c); return p && !(isWindows && /[\\/]WindowsApps[\\/]/i.test(p)) ? p : undefined; }; // Windows 应用商店的 python 占位别名：一运行就打开商店
  switch (lang) {
    case "python": {
      const p = isWindows ? usable("python") ?? usable("py") : usable("python3") ?? usable("python");
      if (!p) return { missing: `这具身体上没有 Python 3（找不到 ${isWindows ? "python 或 py" : "python3 或 python"}）。${isWindows ? "Windows 安装器会装上 Python 3：重新运行一次安装即可补上。" : process.platform === "android" || process.env.ANDROID_ROOT ? "安卓上的 Quetzal App 暂时没有内置 Python。" : "用系统的包管理器装上 python3（例如 apt install python3）后再运行。"}` };
      return { cmd: p, args: /[\\/]py(\.exe)?$/i.test(p) ? ["-3"] : [], file: "main.py" };
    }
    case "javascript": return { cmd: process.execPath, args: [], file: /^\s*(import\s|export\s)/m.test(code) ? "main.mjs" : "main.cjs" };
    case "typescript": return { cmd: process.execPath, args: ["--experimental-strip-types", "--disable-warning=ExperimentalWarning"], file: /^\s*(import\s|export\s)/m.test(code) ? "main.mts" : "main.cts" };
    case "shell": {
      if (isWindows) return { missing: "这具身体是 Windows，没有 sh：把代码改成 PowerShell（语言写 powershell）再运行。" };
      const p = usable("bash") ?? usable("sh");
      return p ? { cmd: p, args: [], file: "main.sh" } : { missing: "这具身体上没有 sh / bash。" };
    }
    case "powershell": {
      if (isWindows) return { cmd: powershellPath(), args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"], file: "main.ps1" };
      const p = usable("pwsh");
      return p ? { cmd: p, args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-File"], file: "main.ps1" } : { missing: "这具身体上没有 PowerShell（pwsh）。" };
    }
    default: return { missing: `${lang || "这种语言"}的代码不能直接运行（能运行的：Python、JavaScript、TypeScript、shell、PowerShell）。` };
  }
}

const shq = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
/** 在沙箱里执行的那条命令：进入运行目录，带上无界面绘图等环境变量，运行源文件。 */
export function runScript(dir: string, i: { cmd: string; args: string[]; file: string }): string {
  const env = { MPLBACKEND: "Agg", PYTHONIOENCODING: "utf-8", PYTHONUNBUFFERED: "1", PYTHONDONTWRITEBYTECODE: "1" };
  if (isWindows) {
    return `${Object.entries(env).map(([k, v]) => `$env:${k}=${psq(v)};`).join("")}Set-Location -LiteralPath ${psq(dir)}; & ${[i.cmd, ...i.args, path.join(dir, i.file)].map(psq).join(" ")}; exit $LASTEXITCODE`;
  }
  return `export ${Object.entries(env).map(([k, v]) => `${k}=${v}`).join(" ")}; cd ${shq(dir)} && exec ${[i.cmd, ...i.args, i.file].map(shq).join(" ")}`;
}

/** 输出太长：留开头与结尾，中间注明省略了多少。 */
export function clipOutput(s: string, max = MAX_RUN_OUTPUT): string {
  if (s.length <= max) return s;
  const half = Math.floor(max / 2);
  return `${s.slice(0, half)}\n…（中间省略 ${s.length - max} 个字符）…\n${s.slice(-half)}`;
}

/** 运行目录里生成的图片：只收普通文件（不跟随符号链接——代码在沙箱里，可能放一个指向密钥的链接）、核对文件头、有数量与大小上限，复制到 data/canvas-runs/<运行>/。 */
function collectImages(dir: string, run: string, skip: string): RunImage[] {
  let names: string[] = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const files = names.filter((n) => n !== skip && IMAGE_EXT[path.extname(n).toLowerCase()] && /^[\w.+\- ()一-鿿]{1,120}$/u.test(n))
    .map((n) => { try { const s = fs.lstatSync(path.join(dir, n)); return s.isFile() && !s.isSymbolicLink() && s.size > 0 && s.size <= MAX_IMAGE_BYTES ? { n, t: s.mtimeMs } : undefined; } catch { return undefined; } })
    .filter((x): x is { n: string; t: number } => !!x).sort((a, b) => a.t - b.t).slice(0, MAX_IMAGES);
  const out: RunImage[] = [];
  for (const { n } of files) {
    let buf: Buffer;
    try {
      const fd = fs.openSync(path.join(dir, n), fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
      try { if (!fs.fstatSync(fd).isFile()) continue; buf = fs.readFileSync(fd); } finally { fs.closeSync(fd); }
    } catch { continue; }
    const mime = IMAGE_EXT[path.extname(n).toLowerCase()];
    if (!magicOk(buf, mime) || buf.length > MAX_IMAGE_BYTES) continue;
    const to = path.join(imageRoot(), run);
    fs.mkdirSync(to, { recursive: true });
    fs.writeFileSync(path.join(to, n), buf);
    out.push({ name: n, size: buf.length, mime });
  }
  return out;
}
function magicOk(b: Buffer, mime: string): boolean {
  const h = (s: number[]) => s.every((x, i) => b[i] === x);
  switch (mime) {
    case "image/png": return h([0x89, 0x50, 0x4e, 0x47]);
    case "image/jpeg": return h([0xff, 0xd8, 0xff]);
    case "image/gif": return h([0x47, 0x49, 0x46]);
    case "image/webp": return b.subarray(0, 4).toString() === "RIFF" && b.subarray(8, 12).toString() === "WEBP";
    case "image/svg+xml": return /^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE[^>]*>\s*)?<svg[\s>]/i.test(b.subarray(0, 4096).toString());
    default: return false;
  }
}
/** 只留最近的若干次运行目录与图片（按名字里的编号无序，按修改时间）。 */
function prune(dir: string, keep: number) {
  try {
    const ds = fs.readdirSync(dir).filter((n) => ID.run.test(n)).map((n) => ({ n, t: fs.statSync(path.join(dir, n)).mtimeMs })).sort((a, b) => b.t - a.t);
    for (const { n } of ds.slice(keep)) fs.rmSync(path.join(dir, n), { recursive: true, force: true });
  } catch { /* 目录还没有 */ }
}

/** 一次运行所在的身体上的一张图片（控制台显示、她用 view_image 看）。不在这具身体上返回 undefined。 */
export function runImagePath(run: string, name: string): string | undefined {
  if (!ID.run.test(String(run)) || typeof name !== "string" || name !== path.basename(name) || name.startsWith(".")) return undefined;
  const r = db().prepare("SELECT images FROM canvas_runs WHERE id=?").get(run) as any;
  if (!r || !safeJson<RunImage[]>(r.images, []).some((i) => i.name === name)) return undefined;
  const f = path.join(imageRoot(), run, name);
  return fs.existsSync(f) ? f : undefined;
}

/**
 * 运行一份代码 canvas 的某个版本（缺省当前版本）：写进新的运行目录，在沙箱里执行（sh.ts 的 shell，与她的命令同一个沙箱；
 * 真实环境也不例外），结果记下（复制给其他身体）。timeoutSec：多少秒没有任何输出就结束（默认 60，最多 600）；总时长另有 15 分钟上限。
 * 解释器不存在时不执行，结果里写明（退出码 127）。闸门与审计由调用方负责。find：查找命令（测试用）。
 */
export async function runCanvas(id: string, o: { version?: number | string; by: Author; timeoutSec?: number; signal?: AbortSignal; find?: (c: string) => string | undefined }): Promise<CanvasRun> {
  const d = mustDoc(id);
  if (d.kind !== "code") throw new CanvasError("这是一份文档，不是代码：只有代码 canvas 能运行");
  const { v, n } = versionOf(d.id, o.version);
  const lang = d.lang || "python";
  const runId = newId("run"), started = Date.now();
  const i = interpreter(lang, v.content, o.find);
  let code = 127, out = "", err = "", note = "", images: RunImage[] = [], dir = "";
  if ("missing" in i) {
    err = i.missing; note = "没有执行：解释器不存在";
  } else {
    dir = path.join(runRoot(), runId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, i.file), v.content);
    const total = AbortSignal.timeout(MAX_TOTAL_MS);
    const signal = o.signal ? AbortSignal.any([o.signal, total]) : total;
    const r = await shell(runScript(dir, i), Math.min(600, Math.max(1, Number(o.timeoutSec) || 60)) * 1000, { signal }); // 沙箱：shell 不带 host，永远经 wrapScript
    code = r.code; out = r.out; err = r.err;
    if (total.aborted) { err = err.replace(/\n（这一轮被停止，命令已结束）$/, ""); err += `\n（运行超过 ${MAX_TOTAL_MS / 60_000} 分钟，已结束）`; note = "超时"; }
    else if (o.signal?.aborted) note = "被停止";
    else if (/（\d+ 秒没有任何输出，已结束）$/.test(err)) note = "超时";
    images = collectImages(dir, runId, i.file);
    prune(runRoot(), 30); prune(imageRoot(), 200);
  }
  const run: CanvasRun = { id: runId, doc: d.id, version: v.id, ts: Date.now(), by: o.by, body: config.body, lang, code, out: clipOutput(out), err: clipOutput(err), images, ms: Date.now() - started, dir, note: note || `第 ${n} 版` };
  db().prepare("INSERT INTO canvas_runs(id,doc,version,ts,by,body,lang,code,out,err,images,ms,dir,note) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(run.id, run.doc, run.version, run.ts, run.by, run.body, run.lang, run.code, run.out, run.err, JSON.stringify(run.images), run.ms, run.dir, run.note);
  if (o.by === "agent") markSeen(`run:${run.id}`, "1");
  replicate({ runs: [run.id] });
  changed(d, "run", { author: o.by, run: run.id });
  return run;
}
export function runs(doc: string, limit = 5): CanvasRun[] {
  return (db().prepare("SELECT * FROM canvas_runs WHERE doc=? ORDER BY ts DESC, id DESC LIMIT ?").all(doc, limit) as any[]).map(rowRun);
}
const versionNumber = (doc: string, vid: string) => versions(doc).findIndex((v) => v.id === vid) + 1;

/** 给她看的一次运行的结果（工具结果与系统提示共用）。 */
export function describeRun(r: CanvasRun, budget = 8000): string {
  const n = versionNumber(r.doc, r.version);
  const half = Math.floor(budget / 2);
  const cut = (s: string) => (s.length > half ? `${s.slice(0, half)}…（共 ${s.length} 字符）` : s);
  const imgs = r.images.length ? `\n生成的图片（可以用 view_image 看）：${r.images.map((m) => path.join(imageRoot(), r.id, m.name)).join("、")}${r.body !== config.body ? `（在 ${r.body} 这具身体上）` : ""}` : "";
  const files = r.dir ? `\n运行目录（代码生成的其他文件在这里）：${r.dir}${r.body !== config.body ? `（在 ${r.body} 上）` : ""}` : "";
  return `${r.by === "agent" ? "你" : "对方"}运行了第 ${n || "?"} 版（${r.lang}，${new Date(r.ts).toLocaleString("zh-CN", { timeZone: config.timezone })}，用时 ${(r.ms / 1000).toFixed(1)} 秒${r.note && !/^第 \d+ 版$/.test(r.note) ? `，${r.note}` : ""}）：退出码 ${r.code}` +
    `\nstdout：${r.out.trim() ? `\n${cut(r.out)}` : "（空）"}\nstderr：${r.err.trim() ? `\n${cut(r.err)}` : "（空）"}${imgs}${files}`;
}

// ---------------------------------------------------------------- 系统提示：这个会话的 canvas
const FULL = 4000, BLOCK = 14_000;
/** 两个版本之间改动的那一段（去掉相同的开头与结尾的行），给她看对方改了什么。太长就只说改了多少行。 */
export function changedSpan(before: string, after: string, budget = 1500): string {
  const a = before.split("\n"), b = after.split("\n");
  let s = 0; while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let e = 0; while (e < a.length - s && e < b.length - s && a[a.length - 1 - e] === b[b.length - 1 - e]) e++;
  const del = a.slice(s, a.length - e), add = b.slice(s, b.length - e);
  const text = `第 ${s + 1} 行起：\n${del.map((l) => `- ${l}`).join("\n")}${del.length && add.length ? "\n" : ""}${add.map((l) => `+ ${l}`).join("\n")}`;
  return text.length <= budget ? text : `第 ${s + 1} 行起删去 ${del.length} 行、写入 ${add.length} 行（太长，用 canvas_read 看全文）`;
}
/** 大文档的概要：开头几行与 Markdown 标题大纲。 */
function outline(content: string): string {
  const lines = content.split("\n");
  const heads = lines.map((l, i) => (/^#{1,6}\s/.test(l) ? `  第 ${i + 1} 行 ${l.trim().slice(0, 80)}` : "")).filter(Boolean).slice(0, 40);
  return `开头：\n${lines.slice(0, 20).join("\n").slice(0, 1500)}${heads.length ? `\n标题大纲：\n${heads.join("\n")}` : ""}`;
}

/** 系统提示里的「Canvas」一节：没有 canvas 时为空。顺带记下她看到了哪一版（之后对方再改才标「对方改过」）。 */
export function canvasBlock(conv?: string): string {
  if (!conv) return "";
  let list: CanvasSummary[];
  try { list = listCanvases(conv); } catch { return ""; }
  if (!list.length) return "";
  const parts: string[] = [];
  let used = 0;
  for (const s of list.slice(0, 12)) {
    const h = head(s.id)!;
    if (!h) continue;
    const seen = seenOf(s.id);
    const userNew = h.author === "user" && seen !== h.id;
    let diff = "";
    if (userNew && seen) { const old = versions(s.id).find((v) => v.id === seen); if (old) diff = `\n对方改动的地方（与你上次看到的版本相比）：\n${changedSpan(old.content, h.content)}`; }
    const room = BLOCK - used;
    const body = h.content.length <= FULL && h.content.length < room - 500 ? `内容：\n\`\`\`${s.kind === "code" ? s.lang : "markdown"}\n${h.content}\n\`\`\`` : `内容较长（${h.content.length} 字符），这里只给概要，用 canvas_read 分页读：\n${outline(h.content)}`;
    const open = threads(s.id, h.content).filter((t) => !t.resolved).slice(0, 10).map((t) => {
      const where = t.quote ? `第 ${t.at.line}${t.at.endLine !== t.at.line ? `–${t.at.endLine}` : ""} 行「${t.quote.slice(0, 80)}${t.quote.length > 80 ? "…" : ""}」${t.at.status === "stale" ? "（原文已改掉，评论过时）" : ""}` : "整份文档";
      const last = t.replies.at(-1);
      return `- [${t.id}] ${t.author === "agent" ? "你" : "对方"}评论 ${where}：${t.text.slice(0, 200)}${t.suggestion !== null ? `（建议改为「${t.suggestion.slice(0, 120)}」）` : ""}${last ? `；最新回复（${last.author === "agent" ? "你" : "对方"}）：${last.text.slice(0, 200)}` : ""}`;
    });
    const run = runs(s.id, 1)[0];
    const runText = run ? `\n最近一次运行：${describeRun(run, 1200)}` : "";
    const text = `### 「${s.title}」（id: ${s.id}，${s.kind === "code" ? `代码 ${s.lang || "未标语言"}` : "Markdown 文档"}，第 ${s.version} 版，${h.author === "agent" ? "你" : "对方"}最后修改于 ${new Date(h.ts).toLocaleString("zh-CN", { timeZone: config.timezone })}）${userNew ? "\n对方在你上次看过之后改过这份 canvas。" : ""}${diff}\n${body}${open.length ? `\n未解决的评论：\n${open.join("\n")}` : ""}${runText}`;
    if (used + text.length > BLOCK && parts.length) { parts.push(`- 还有 ${list.length - parts.length} 份 canvas 放不下，用 canvas_list 看`); break; }
    parts.push(text); used += text.length;
    markSeen(s.id, h.id);
  }
  return `## Canvas（这个会话旁边的编辑区，对方和你一起改）\n对方在控制台里看得到这些 canvas、可以直接编辑、运行代码、选中一段加评论。长内容（文档、代码）放进 canvas 比贴在回复里好：用 canvas_create 新建，canvas_edit 修改（按片段查找替换或整体替换，每次一个新版本），canvas_read 分页读，canvas_run 运行代码，canvas_comment 回复 / 解决评论或对某段加评论与编辑建议。\n${parts.join("\n\n")}`;
}

// ---------------------------------------------------------------- 复制：其他身体发来的行（mesh/canvas.ts）。逐字段检查，不合格的整行丢弃
const BODY_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const TS_MIN = Date.UTC(2020, 0, 1);
const isStr = (v: unknown, max: number, min = 0): v is string => typeof v === "string" && v.length >= min && v.length <= max;
const okTs = (t: unknown) => typeof t === "number" && Number.isFinite(t) && t >= TS_MIN && t <= Date.now() + 10 * 60_000;
const okInt = (n: unknown, min = 0) => Number.isSafeInteger(n) && (n as number) >= min;
const okImages = (s: unknown) => { if (!isStr(s, 8192)) return false; const v = safeJson<unknown>(s, null); return Array.isArray(v) && v.length <= MAX_IMAGES && v.every((i: any) => !!i && isStr(i.name, 120, 1) && i.name === path.basename(i.name) && !i.name.startsWith(".") && okInt(i.size) && isStr(i.mime, 40) && Object.values(IMAGE_EXT).includes(i.mime)); };
/** 实时收到的行只能是发来的那具身体写的（body === from）；补齐时可以带着别的身体的行。 */
const okBody = (b: unknown, from: string, catchUp: boolean) => isStr(b, 40) && BODY_RE.test(b) && (catchUp || b === from);

export interface CanvasRows { docs?: unknown[]; versions?: unknown[]; comments?: unknown[]; runs?: unknown[] }
/** 写入其他身体发来的 canvas 行。返回新增或改变了的行数与丢弃的行数；有变化的 canvas 推 canvas.changed（kind: replica）。 */
export function applyCanvasRemote(rows: CanvasRows, o: { from: string; catchUp?: boolean }): { changed: number; rejected: number } {
  let n = 0, rejected = 0;
  const touched = new Map<string, string>(); // canvas → 会话
  const take = (x: unknown) => (Array.isArray(x) ? x.slice(0, 2000) : []);
  const cu = !!o.catchUp, soon = Date.now() + 5 * 60_000;
  const d = db();
  d.exec("BEGIN");
  try {
    for (const r of take(rows?.docs) as any[]) {
      if (!r || !ID.doc.test(r.id) || !isStr(r.conv, 200, 1) || !isStr(r.title, MAX_TITLE) || (r.kind !== "markdown" && r.kind !== "code") || normLang(r.lang) !== (r.lang ?? "")
        || !okTs(r.created) || !okTs(r.changed) || !(r.deleted === 0 || r.deleted === 1) || !okBody(r.body, o.from, cu)) { rejected++; continue; }
      const cur = d.prepare("SELECT * FROM canvas_docs WHERE id=?").get(r.id) as any;
      const changedAt = Math.min(r.changed, soon);
      if (!cur) d.prepare("INSERT INTO canvas_docs(id,conv,title,kind,lang,created,changed,deleted,body) VALUES(?,?,?,?,?,?,?,?,?)").run(r.id, r.conv, r.title, r.kind, r.lang ?? "", r.created, changedAt, r.deleted, r.body);
      else if (changedAt > Number(cur.changed)) d.prepare("UPDATE canvas_docs SET title=?, kind=?, lang=?, deleted=?, changed=?, body=? WHERE id=?").run(r.title, r.kind, r.lang ?? "", r.deleted, changedAt, r.body, r.id); // 会话与创建时间不随修改变
      else continue;
      n++; touched.set(r.id, cur?.conv ?? r.conv);
    }
    for (const r of take(rows?.versions) as any[]) {
      if (!r || !ID.version.test(r.id) || !ID.doc.test(r.doc) || !okTs(r.ts) || (r.author !== "agent" && r.author !== "user") || !okBody(r.body, o.from, cu)
        || !isStr(r.content, MAX_CONTENT) || !isStr(r.note ?? "", 500) || !(r.parent === null || r.parent === undefined || ID.version.test(r.parent))) { rejected++; continue; }
      if (!Number(d.prepare("INSERT OR IGNORE INTO canvas_versions(id,doc,ts,author,body,content,note,parent) VALUES(?,?,?,?,?,?,?,?)").run(r.id, r.doc, r.ts, r.author, r.body, r.content, r.note ?? "", r.parent ?? null).changes)) continue; // 版本不可变
      n++; touched.set(r.doc, (d.prepare("SELECT conv FROM canvas_docs WHERE id=?").get(r.doc) as any)?.conv ?? "");
    }
    for (const r of take(rows?.comments) as any[]) {
      const root = r?.thread === null || r?.thread === undefined;
      if (!r || !ID.comment.test(r.id) || !ID.doc.test(r.doc) || !(root || ID.comment.test(r.thread)) || !okTs(r.ts) || (r.author !== "agent" && r.author !== "user") || !okBody(r.body, o.from, cu)
        || !isStr(r.text, MAX_COMMENT) || !isStr(r.quote ?? "", MAX_COMMENT) || !okInt(r.start ?? 0) || !okInt(r.end ?? 0) || Number(r.end ?? 0) < Number(r.start ?? 0)
        || !(r.version === null || r.version === undefined || ID.version.test(r.version)) || !isStr(r.prefix ?? "", 200) || !isStr(r.suffix ?? "", 200)
        || !(r.resolved === 0 || r.resolved === 1) || !okTs(r.changed) || !(r.suggestion === null || r.suggestion === undefined || isStr(r.suggestion, 100_000))) { rejected++; continue; }
      const cur = d.prepare("SELECT changed FROM canvas_comments WHERE id=?").get(r.id) as any;
      const changedAt = Math.min(r.changed, soon);
      if (!cur) d.prepare("INSERT INTO canvas_comments(id,doc,thread,ts,author,body,text,quote,start,end,version,prefix,suffix,resolved,changed,suggestion) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(r.id, r.doc, root ? null : r.thread, r.ts, r.author, r.body, r.text, r.quote ?? "", r.start ?? 0, r.end ?? 0, r.version ?? null, r.prefix ?? "", r.suffix ?? "", r.resolved, changedAt, r.suggestion ?? null);
      else if (changedAt > Number(cur.changed)) d.prepare("UPDATE canvas_comments SET resolved=?, changed=?, body=? WHERE id=?").run(r.resolved, changedAt, r.body, r.id); // 只有解决状态会变，其余不可变
      else continue;
      n++; touched.set(r.doc, (d.prepare("SELECT conv FROM canvas_docs WHERE id=?").get(r.doc) as any)?.conv ?? "");
    }
    for (const r of take(rows?.runs) as any[]) {
      if (!r || !ID.run.test(r.id) || !ID.doc.test(r.doc) || !ID.version.test(r.version) || !okTs(r.ts) || (r.by !== "agent" && r.by !== "user") || !okBody(r.body, o.from, cu)
        || !isStr(r.lang, 20) || !Number.isSafeInteger(r.code) || !isStr(r.out, MAX_RUN_OUTPUT + 200) || !isStr(r.err, MAX_RUN_OUTPUT + 200) || !okImages(r.images) || !okInt(r.ms) || !isStr(r.dir ?? "", 1000) || !isStr(r.note ?? "", 200)) { rejected++; continue; }
      if (!Number(d.prepare("INSERT OR IGNORE INTO canvas_runs(id,doc,version,ts,by,body,lang,code,out,err,images,ms,dir,note) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(r.id, r.doc, r.version, r.ts, r.by, r.body, r.lang, r.code, r.out, r.err, r.images, r.ms, r.dir ?? "", r.note ?? "").changes)) continue;
      n++; touched.set(r.doc, (d.prepare("SELECT conv FROM canvas_docs WHERE id=?").get(r.doc) as any)?.conv ?? "");
    }
    d.exec("COMMIT");
  } catch (e) { d.exec("ROLLBACK"); throw e; }
  for (const [doc, conv] of touched) bus.emit("canvas.changed", { doc, conv, kind: "replica", from: o.from });
  return { changed: n, rejected };
}

/** 补齐用的摘要：每份 canvas、每条评论的修改时刻，每个版本与运行的 id（对方据此只要自己没有的）。 */
export function canvasDigest(): { docs: Record<string, number>; versions: string[]; comments: Record<string, number>; runs: string[] } {
  const d = db();
  const map = (rows: any[]) => Object.fromEntries(rows.map((r) => [r.id, Number(r.changed)]));
  return {
    docs: map(d.prepare("SELECT id, changed FROM canvas_docs LIMIT 20000").all() as any[]),
    versions: (d.prepare("SELECT id FROM canvas_versions LIMIT 200000").all() as any[]).map((r) => r.id),
    comments: map(d.prepare("SELECT id, changed FROM canvas_comments LIMIT 100000").all() as any[]),
    runs: (d.prepare("SELECT id FROM canvas_runs LIMIT 50000").all() as any[]).map((r) => r.id),
  };
}
/** 按 id 取原样的行（补齐时对方来要），合计不超过 bytes。 */
export function canvasRows(want: { docs?: unknown; versions?: unknown; comments?: unknown; runs?: unknown }, bytes = 4 << 20): CanvasRows {
  const out: Required<CanvasRows> = { docs: [], versions: [], comments: [], runs: [] };
  let used = 0;
  const pick = (table: string, ids: unknown, re: RegExp, into: unknown[]) => {
    for (const id of (Array.isArray(ids) ? ids : []).slice(0, 500)) {
      if (typeof id !== "string" || !re.test(id)) continue;
      const r = raw(table, id);
      if (!r) continue;
      const size = JSON.stringify(r).length;
      if (into.length && used + size > bytes) return;
      into.push(r); used += size;
    }
  };
  pick("canvas_docs", want?.docs, ID.doc, out.docs);
  pick("canvas_versions", want?.versions, ID.version, out.versions);
  pick("canvas_comments", want?.comments, ID.comment, out.comments);
  pick("canvas_runs", want?.runs, ID.run, out.runs);
  return out;
}
export const CANVAS_ID = ID;
