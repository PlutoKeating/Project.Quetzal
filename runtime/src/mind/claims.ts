// 认领（#7）：同一个 agent 的几个会话——同一具身体上的几个对话、醒来思考、别的身体上的会话——同时进行时，
// 用来避免两个会话同时去做同一件对外的事（开同一个 issue、发同一封邮件……）。
//   - 事情的名字（key）由她自己起，基座只做字面比较（合并空白、不分大小写），不判断语义上是不是同一件事。
//   - 认领带说明与期限（默认 30 分钟，最长 24 小时），到期自动失效；做完了用 release 放下。
//   - 存在 kv 里（重启后还在）；多具身体时经 mesh/shared.ts 的 claims 分区按条目合并（同一编号以修改较新的为准，放下的留墓碑到期限为止）。
//   - 认领的决定由协调者做（跟随者经 setClaimRouter 转过去），两具身体同时认领同一件事只有一个成功；连不上协调者时在本机决定
//     （断网分区各自决定，重新连上后两条认领都看得到）。
import crypto from "node:crypto";
import { kv } from "../store.ts";
import { bus } from "../bus.ts";
import { config } from "../config.ts";

export interface Claim {
  id: string;
  key: string;    // 她起的名字（原样保存，比较时规范化）
  note: string;   // 在做什么
  body: string;   // 在哪具身体上
  holder: string; // 哪个会话：对话为会话编号，醒来、做梦为那一轮的编号
  where: string;  // 给人看的会话描述：会话「标题」/ 醒来思考 / 做梦 / 子 agent「名字」
  ts: number;     // 认领的时刻
  until: number;  // 到期的时刻
  updated: number;
  released?: boolean;
}
export interface ClaimRequest { key: string; note?: string; minutes?: number; body: string; holder: string; where: string; force?: boolean }
export type ClaimResult = { ok: true; claim: Claim; renewed?: boolean } | { ok: false; by?: Claim; none?: boolean };

const KEY = "claims";
const MAX = 200;
export const DEFAULT_MINUTES = 30, MAX_MINUTES = 24 * 60;
const FUTURE_MS = 5 * 60_000;

const norm = (k: string) => k.replace(/\s+/g, " ").trim().toLowerCase();
const clean = (s: unknown, n: number) => (typeof s === "string" ? s.replace(/[\p{Cc}\p{Cf}]+/gu, " ").trim().slice(0, n) : "");

/** 全部记录（含放下的墓碑），过期的不再返回。 */
export const all = (now = Date.now()): Claim[] => kv.get<Claim[]>(KEY, []).filter((c) => c.until > now);
/** 还在生效的认领，按认领时刻排。 */
export const active = (now = Date.now()): Claim[] => all(now).filter((c) => !c.released).sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1));
/** 某件事此刻的认领者：同一件事有几条（断网分区时各自认领了）时，先认领的算。 */
export const holderOf = (key: string, now = Date.now()) => active(now).find((c) => norm(c.key) === norm(key));

function save(list: Claim[], o: { remote?: boolean } = {}) {
  const now = Date.now();
  kv.set(KEY, list.filter((c) => c.until > now).sort((a, b) => b.updated - a.updated).slice(0, MAX));
  if (!o.remote) bus.emit("claims.changed");
}

/** 在本机决定一次认领：没人认领就记下；同一个会话再认领就续期并更新说明；别的会话认领着就返回它。 */
export function take(r: ClaimRequest, now = Date.now()): ClaimResult {
  const key = clean(r.key, 200);
  if (!key) throw new Error("要认领的事需要一个名字（key）");
  const minutes = Math.min(Math.max(Number(r.minutes) || DEFAULT_MINUTES, 1), MAX_MINUTES);
  const list = all(now), cur = list.find((c) => !c.released && norm(c.key) === norm(key));
  const note = clean(r.note, 300);
  if (cur && !(cur.body === r.body && cur.holder === r.holder)) return { ok: false, by: cur };
  if (cur) {
    Object.assign(cur, { note: note || cur.note, until: now + minutes * 60_000, updated: now });
    save(list);
    return { ok: true, claim: cur, renewed: true };
  }
  const claim: Claim = { id: crypto.randomBytes(8).toString("hex"), key, note, body: clean(r.body, 40), holder: clean(r.holder, 80), where: clean(r.where, 120), ts: now, until: now + minutes * 60_000, updated: now };
  list.push(claim);
  save(list);
  return { ok: true, claim };
}

/** 在本机放下一次认领。别的会话的认领要 force 才放（例如那个会话已经结束、忘了放下）。 */
export function release(r: Omit<ClaimRequest, "note" | "minutes">, now = Date.now()): ClaimResult {
  const list = all(now), cur = list.find((c) => !c.released && norm(c.key) === norm(clean(r.key, 200)));
  if (!cur) return { ok: false, none: true };
  if (!(cur.body === r.body && cur.holder === r.holder) && !r.force) return { ok: false, by: cur };
  Object.assign(cur, { released: true, updated: now });
  save(list);
  return { ok: true, claim: cur };
}

/** 合并别处的记录：同一编号取修改较新的；新的直接收下。返回是否有变化。 */
export function merge(theirs: unknown): boolean {
  if (!Array.isArray(theirs)) return false;
  const list = all(), byId = new Map(list.map((c) => [c.id, c]));
  let changed = false;
  for (const x of theirs.slice(0, MAX)) {
    const c = sanitize(x);
    if (!c) continue;
    const mine = byId.get(c.id);
    if (mine && mine.updated >= c.updated) continue;
    if (mine) Object.assign(mine, c); else { list.push(c); byId.set(c.id, c); }
    changed = true;
  }
  if (changed) save(list, { remote: true });
  return changed;
}

/** 别处来的一条记录：字段类型与长度、时刻（过期的不收，修改时刻不能在未来，期限不超过 24 小时）。不合格返回 undefined。 */
export function sanitize(x: any, now = Date.now()): Claim | undefined {
  if (!x || typeof x !== "object" || typeof x.id !== "string" || !/^[0-9a-f]{16}$/.test(x.id)) return undefined;
  const t = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
  const ts = t(x.ts), until = t(x.until), updated = t(x.updated);
  if (!ts || !updated || until <= now || updated > now + FUTURE_MS || ts > now + FUTURE_MS || until > now + MAX_MINUTES * 60_000 + FUTURE_MS) return undefined;
  const key = clean(x.key, 200), body = clean(x.body, 40), holder = clean(x.holder, 80);
  if (!key || !body || !holder) return undefined;
  return { id: x.id, key, note: clean(x.note, 300), body, holder, where: clean(x.where, 120), ts, until, updated, ...(x.released === true ? { released: true } : {}) };
}

// ---------- 多具身体：认领由协调者决定（mesh/shared.ts 注入）
type Router = (op: "take" | "release", r: ClaimRequest) => Promise<ClaimResult> | undefined;
let router: Router | undefined;
export const setClaimRouter = (f: Router | undefined) => { router = f; };

async function routed(op: "take" | "release", r: ClaimRequest): Promise<ClaimResult> {
  const remote = router?.(op, r);
  if (remote) {
    try {
      const res = await remote;
      if (res && typeof res === "object" && typeof res.ok === "boolean") {
        const c = sanitize(res.ok ? res.claim : res.by);
        if (c) merge([c]); // 协调者的结果先在本机记下（广播随后也会到）
        if (!res.ok) return { ok: false, ...(c ? { by: c } : {}), ...(res.none ? { none: true } : {}) };
        if (c) return { ok: true, claim: c, ...(res.renewed ? { renewed: true } : {}) };
      } // 回应不合格：在本机决定
    } catch { /* 连不上协调者：在本机决定 */ }
  }
  return op === "take" ? take(r) : release(r);
}
/** 认领（多具身体时经协调者）。 */
export const claim = (r: ClaimRequest) => routed("take", r);
/** 放下（多具身体时经协调者）。 */
export const unclaim = (r: ClaimRequest) => routed("release", r);

// ---------- 给她看
const at = (ts: number) => new Date(ts).toLocaleTimeString("zh-CN", { timeZone: config.timezone, hour: "2-digit", minute: "2-digit" });
/** 一条认领的描述：谁、在哪个会话、做什么、到几点。 */
export function describe(c: Claim, me?: { body: string; holder: string }): string {
  const mine = me && c.body === me.body && c.holder === me.holder;
  return `「${c.key}」${c.note ? `：${c.note}` : ""}（${mine ? "就是这个会话" : `${c.body === config.body ? "这具身体" : c.body} 上的${c.where || "一个会话"}`}，${at(c.ts)} 认领，到 ${at(c.until)}）`;
}
