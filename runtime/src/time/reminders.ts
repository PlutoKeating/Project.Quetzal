// 提醒：对方让她「到时候提醒我」的事。与心脏无关——心脏决定她自己什么时候醒，没有定时；提醒是答应了对方的事，必须准点。
//   存储：每条一个对象，放在 SQLite 的 kv（"reminders"）。删除留墓碑（deleted），多具身体之间按条目合并（较新的修改为准），
//         所以两具身体同时各加一条不会互相覆盖（见 mesh/shared.ts 的 reminders 分区）。
//   规则：一次性（at）或重复（cron：5 段 cron 表达式，按创建时写死的时区解释，可带 until 截止）。下一次的时刻由 croner 计算
//         （MIT、零依赖，只当计算器用、不起它的定时器；OpenClaw 同样用它）；跨夏令时按当地钟点。
//   触发：只有此刻持有心跳的那具身体负责（其他身体是跟随者，不触发），到点交给 onDue（main 里：不经模型，直接把提醒发给对方，再告诉她）。
//         设备关机、休眠错过的：12 小时内的照常提醒（说明晚了多久）；重复的只补最近错过的一次；更早的记为错过。
//         网络分区时两边各有一个持心跳的身体，同一条可能各响一次（至少一次，不保证恰好一次）。
//   软提醒（soft）：不急的事给一个时间窗 [at, at + span)。窗里不定时，等「对方此刻在身边」的时刻——这具身体亮屏、被拿起、接上电源，
//         或对方刚发来消息——再提醒，并说明为什么是现在；夜里（22:00–08:00）不因这些信号打扰。到窗口的最后一刻还没遇到，就照常准点发出。
//         思路来自独立项目「等合适时机提醒」的做法：有信号才说为什么是现在，没有信号不编理由；下一步要小（step）。
import crypto from "node:crypto";
import { config } from "../config.ts";
import { kv } from "../store.ts";
import { bus } from "../bus.ts";
import { log } from "../log.ts";
import { Cron } from "croner";
import { parts, validZone } from "./zone.ts";

export interface Reminder {
  id: string; text: string; at: number; cron?: string; until?: number; tz: string; // at：下一次的时刻；cron：重复规则（没有就是一次性）；until：重复到何时为止
  created: number; updated: number; deleted?: boolean; done?: boolean; fired?: number;
  conv?: string; by: string; // 在哪个会话里答应的；谁设的（agent / 控制台）
  span?: number; // 软提醒的时间窗长度（毫秒）：窗口是 [at, at + span)
  step?: string; // 一句很小的下一步（「先把药盒放到桌上」），发出时附在后面
}

/** 软提醒的窗口最后一刻（准点提醒就是 at）。 */
export const deadline = (r: Pick<Reminder, "at" | "span">) => r.at + (r.span ?? 0);
/** 夜里不因为「在身边」的信号打扰（只对软提醒；窗口最后一刻照常）。 */
const QUIET = { from: 22, to: 8 };
export const quiet = (ts: number, tz: string) => { const h = parts(ts, tz).h; return h >= QUIET.from || h < QUIET.to; };

const KEY = "reminders";
const LATE_MS = 12 * 3_600_000; // 错过多久以内照常提醒
const MAX = 500;

export const all = (): Reminder[] => kv.get<Reminder[]>(KEY, []);
/** 还在生效的（没删、没完成），按下一次的时刻排。 */
export const active = (): Reminder[] => all().filter((r) => !r.deleted && !r.done).sort((a, b) => a.at - b.at);

function save(list: Reminder[], o: { remote?: boolean } = {}) {
  // 墓碑与完成的只留最近的一些，免得无限增长
  const keep = list.filter((r) => !r.deleted && !r.done);
  const old = list.filter((r) => r.deleted || r.done).sort((a, b) => b.updated - a.updated).slice(0, 200);
  kv.set(KEY, [...keep, ...old].slice(0, MAX + 200));
  if (!o.remote) bus.emit("reminders.changed");
  bus.emit("state");
  arm();
}

/** 校验 cron 表达式（5 段：分 时 日 月 星期），不对时抛出能直接告诉模型的错误。 */
function cronOf(expr: string, tz: string): Cron {
  const e = String(expr ?? "").trim().replace(/\s+/g, " ");
  if (e.split(" ").length !== 5) throw new Error(`重复规则要写成 5 段 cron（分 时 日 月 星期），如「0 9 * * 1」是每周一 9:00；收到的是「${e}」`);
  try { return new Cron(e, { timezone: tz, paused: true }); } catch (err) { throw new Error(`重复规则「${e}」不对：${(err as Error).message}`); }
}

/** 规则在 after 之后（不含）的下一次时刻；没有了（过了 until）返回 undefined。 */
export function nextOf(r: Pick<Reminder, "cron" | "until" | "tz">, after: number): number | undefined {
  const t = cronOf(r.cron!, r.tz).nextRun(new Date(after))?.getTime();
  return t !== undefined && (r.until === undefined || t <= r.until) ? t : undefined;
}

/** 接下来的几次（给模型与人核对）。 */
export function upcoming(r: Pick<Reminder, "at" | "cron" | "until" | "tz">, n = 3): number[] {
  if (!r.cron) return [r.at];
  const out = [r.at];
  while (out.length < n) { const t = nextOf(r, out[out.length - 1]); if (t === undefined) break; out.push(t); }
  return out;
}

/** 新建一条。at：一次性的时刻（毫秒；软提醒是窗口开始）；cron：重复规则（这时 at 是从何时起算，省略为现在）；until：重复到何时为止；span：软提醒的窗口长度。 */
export function add(o: { text: string; at?: number; cron?: string; until?: number; span?: number; step?: string; conv?: string; by: string; tz?: string }, now = Date.now()): Reminder {
  const text = String(o.text ?? "").trim().slice(0, 500);
  const span = typeof o.span === "number" && Number.isFinite(o.span) && o.span > 0 ? Math.min(o.span, 90 * 86_400_000) : undefined;
  const step = typeof o.step === "string" && o.step.trim() ? o.step.trim().slice(0, 200) : undefined;
  if (!text) throw new Error("提醒的内容是空的");
  const tz = o.tz && validZone(o.tz) ? o.tz : config.timezone;
  const cron = o.cron ? String(o.cron).trim().replace(/\s+/g, " ") : undefined;
  const until = typeof o.until === "number" && Number.isFinite(o.until) ? o.until : undefined;
  let at: number;
  if (cron) {
    cronOf(cron, tz);
    const first = nextOf({ cron, until, tz }, Math.max(now, (o.at ?? now) - 1));
    if (first === undefined) throw new Error("按这个规则，截止之前一次也不会响");
    at = first;
  } else at = Number(o.at);
  if (!Number.isFinite(at)) throw new Error("没有给出提醒的时间");
  if (!cron && at + (span ?? 0) <= now - 60_000) throw new Error("这个时间已经过去了");
  if (active().length >= MAX) throw new Error(`提醒太多了（最多 ${MAX} 条），先删掉一些`);
  const r: Reminder = { id: crypto.randomBytes(4).toString("hex"), text, at, ...(cron ? { cron } : {}), ...(until !== undefined ? { until } : {}), ...(span ? { span } : {}), ...(step ? { step } : {}), tz, created: now, updated: now, conv: o.conv, by: o.by };
  save([...all(), r]);
  log("reminders", `新提醒 ${r.id}：${describe(r)}`);
  return r;
}

/** 取消（留墓碑）。id 可以是前缀。 */
export function cancel(id: string, now = Date.now()): Reminder {
  const list = all();
  const hits = list.filter((r) => !r.deleted && !r.done && r.id.startsWith(String(id ?? "").trim()));
  if (!id || hits.length !== 1) throw new Error(hits.length ? "有好几条对得上，给完整的编号" : "没有这条提醒");
  hits[0].deleted = true; hits[0].updated = now;
  save(list);
  return hits[0];
}

/** 改时间、内容或重复规则（cron 为 null 时改成一次性）。 */
export function update(id: string, patch: { text?: string; at?: number; cron?: string | null; until?: number | null; span?: number | null; step?: string | null }, now = Date.now()): Reminder {
  const list = all();
  const hits = list.filter((x) => !x.deleted && !x.done && x.id.startsWith(String(id ?? "").trim()));
  if (!id || hits.length !== 1) throw new Error(hits.length ? "有好几条对得上，给完整的编号" : "没有这条提醒");
  const r = hits[0];
  if (typeof patch.text === "string" && patch.text.trim()) r.text = patch.text.trim().slice(0, 500);
  if (patch.span === null) delete r.span; else if (typeof patch.span === "number" && patch.span > 0) r.span = Math.min(patch.span, 90 * 86_400_000);
  if (patch.step === null || patch.step === "") delete r.step; else if (typeof patch.step === "string") r.step = patch.step.trim().slice(0, 200);
  if (patch.until === null) delete r.until; else if (typeof patch.until === "number" && Number.isFinite(patch.until)) r.until = patch.until;
  if (patch.cron === null) delete r.cron;
  else if (typeof patch.cron === "string") { cronOf(patch.cron, r.tz); r.cron = patch.cron.trim().replace(/\s+/g, " "); }
  if (typeof patch.at === "number" && Number.isFinite(patch.at)) r.at = r.cron ? (nextOf(r, patch.at - 1) ?? patch.at) : patch.at;
  else if (typeof patch.cron === "string" || typeof patch.until === "number") { const t = nextOf(r, now); if (t === undefined) throw new Error("按这个规则，截止之前不会再响了"); r.at = t; }
  if (!r.cron && deadline(r) <= now - 60_000) throw new Error("这个时间已经过去了");
  r.updated = now;
  save(list);
  return r;
}

const WD = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const two = (n: number) => String(n).padStart(2, "0");
/** 某时刻在时区里的说法：「10月8日（周四）08:00」。 */
export function when(ts: number, tz: string): string {
  const p = parts(ts, tz);
  return `${p.m}月${p.d}日（${WD[p.wd]}）${two(p.h)}:${two(p.mi)}`;
}

/** 常见的 cron 写法换成人话（每天 / 工作日 / 每周几 / 每月几号 / 每年几月几号）；认不出就原样给出。 */
export function cronText(expr: string): string {
  const [mi, h, dom, mon, dow] = expr.split(" ");
  if (!/^\d+$/.test(mi) || !/^\d+$/.test(h)) return `按规则「${expr}」`;
  const t = `${two(+h)}:${two(+mi)}`;
  const days = (s: string) => s.split(",").flatMap((x) => { const [a, b] = x.split("-").map(Number); return b !== undefined ? Array.from({ length: b - a + 1 }, (_, i) => a + i) : [a]; }).map((d) => WD[d % 7]);
  if (dom === "*" && mon === "*" && dow === "*") return `每天 ${t}`;
  if (dom === "*" && mon === "*" && (dow === "1-5" || dow === "MON-FRI")) return `每个工作日 ${t}`;
  if (dom === "*" && mon === "*" && /^[\d,-]+$/.test(dow)) return `每${days(dow).join("、")} ${t}`;
  if (/^\d+$/.test(dom) && mon === "*" && dow === "*") return `每月 ${dom} 号 ${t}`;
  if (/^\d+$/.test(dom) && /^\d+$/.test(mon) && dow === "*") return `每年 ${mon} 月 ${dom} 日 ${t}`;
  return `按规则「${expr}」`;
}

/** 给人看的一句话：「10月8日（周四）08:00」或「每周一 09:00（下一次 10月12日（周一）09:00）」。 */
export function describe(r: Pick<Reminder, "at" | "cron" | "until" | "tz" | "span">): string {
  const win = r.span ? `${when(r.at, r.tz)} 至 ${when(r.at + r.span, r.tz)} 之间挑你在身边的时候` : when(r.at, r.tz);
  if (!r.cron) return win;
  return `${cronText(r.cron)}（下一次 ${win}${r.until !== undefined ? `，到 ${when(r.until, r.tz)} 为止` : ""}）`;
}

// ---------- 触发
export type DueHandler = (r: Reminder, lateMs: number, why?: string) => Promise<void>; // why：软提醒为什么是现在（没有信号就不写）
let onDue: DueHandler | undefined;
let timer: NodeJS.Timeout | undefined;
let canFire: () => boolean = () => true;

/** 到点的处理（brain 里注入），以及此刻能不能触发（多具身体时只有持心跳的那具身体能）。 */
/** delayMs：启动后等一会儿再第一次检查——刚启动时每具身体都以为自己持心跳，等网状层选出协调者，免得错过的提醒在几具身体上各响一次。 */
export function startReminders(h: DueHandler, may: () => boolean, delayMs = 0) {
  canFire = may;
  bus.on("state", () => arm()); // 换了协调者、急停解除……都重新看一眼
  // 软提醒的时机：这具身体被拿起、亮屏、接上电源；对方发来消息（一分钟后，免得打断正在进行的对话）
  const SENSE: Record<string, string> = { moved: "你这会儿在身边", screen_on: "你这会儿在身边", plugged: "你这会儿在身边" };
  bus.on("sense", (kind) => { if (SENSE[kind]) void onSignal(SENSE[kind]); });
  const talked = (e: { table: string; rows: any[] }) => {
    if (e.table === "messages" && e.rows.some((m) => m?.role === "user")) setTimeout(() => void onSignal("趁你刚找过我"), 60_000).unref?.();
  };
  bus.on("replica", talked); // 在这具身体上说的
  bus.on("replica.applied", talked); // 在别的身体上说的（持心跳的这具身体负责提醒）
  const go = () => { onDue = h; arm(); };
  if (delayMs > 0) setTimeout(go, delayMs).unref?.(); else go();
}

/** 定下一次检查：最近的那条到点时（最多一小时后再看一眼：时钟可能被改、设备可能休眠过）。 */
function arm() {
  clearTimeout(timer);
  if (!onDue) return;
  const list = active();
  if (!list.length) return;
  const due = Math.min(...list.map(deadline)); // 软提醒在窗口里等信号，定时器只管窗口的最后一刻
  const wait = Math.max(0, Math.min(due - Date.now(), 3_600_000));
  timer = setTimeout(tick, wait);
  timer.unref?.();
}

let ticking = false;
async function tick(now = Date.now()) {
  if (ticking) return;
  ticking = true;
  try {
    if (!canFire()) return;
    for (const r of active().filter((x) => deadline(x) <= now)) {
      const late = now - deadline(r);
      const list = all(), cur = list.find((x) => x.id === r.id)!;
      // 先改状态再提醒：提醒过程中出错也不会重复
      cur.fired = now; cur.updated = now;
      const next = cur.cron ? nextOf(cur, now) : undefined; // 重复的：错过好几次也只补最近的这一次，下一次从现在往后算
      if (next !== undefined) cur.at = next; else cur.done = true;
      save(list);
      if (late > LATE_MS) {
        log("reminders", `错过了 ${r.id}（晚了 ${Math.round(late / 3_600_000)} 小时）：${r.text}`);
        bus.emit("reminders.missed", { id: r.id, text: r.text, at: r.at }, late);
        continue;
      }
      try { await onDue!(r, late, r.span ? "说好的最晚就是现在" : undefined); } catch (e) { log("reminders", `提醒 ${r.id} 出错：${(e as Error).message}`); }
    }
  } finally { ticking = false; arm(); }
}

/** 「对方此刻在身边」的信号：窗口已开、不在夜里的软提醒，现在就提醒（说明为什么）。 */
export async function onSignal(why: string, now = Date.now()) {
  if (!onDue || ticking || !canFire()) return;
  const due = active().filter((r) => r.span && r.at <= now && now < deadline(r) && !quiet(now, r.tz));
  if (!due.length) return;
  ticking = true;
  try {
    for (const r of due) {
      const list = all(), cur = list.find((x) => x.id === r.id)!;
      cur.fired = now; cur.updated = now;
      const next = cur.cron ? nextOf(cur, now) : undefined;
      if (next !== undefined) cur.at = next; else cur.done = true;
      save(list);
      try { await onDue(r, 0, why); } catch (e) { log("reminders", `提醒 ${r.id} 出错：${(e as Error).message}`); }
    }
  } finally { ticking = false; arm(); }
}

/** 推迟（对方说「晚点」）：准点的挪到 by；软提醒的窗口从 by 开始、长度不变。 */
export function snooze(id: string, by: number, now = Date.now()): Reminder {
  if (!(by > now)) throw new Error("推迟到的时间要在现在之后");
  return update(id, { at: by }, now);
}
export const _tick = tick; // 测试用

// ---------- 多具身体之间按条目合并（mesh/shared.ts 的 reminders 分区）
/** 合并别处的提醒：同一编号取修改时刻较新的；新的直接收下。返回是否有变化。 */
export function merge(theirs: unknown): boolean {
  if (!Array.isArray(theirs)) return false;
  const list = all(), byId = new Map(list.map((r) => [r.id, r]));
  let changed = false;
  for (const x of theirs.slice(0, MAX + 200)) {
    const r = sanitize(x);
    if (!r) continue;
    const mine = byId.get(r.id);
    if (mine && mine.updated >= r.updated) continue;
    if (mine) Object.assign(mine, r); else { list.push(r); byId.set(r.id, r); }
    changed = true;
  }
  if (changed) save(list, { remote: true });
  return changed;
}

function sanitize(x: any): Reminder | undefined {
  if (!x || typeof x !== "object" || typeof x.id !== "string" || !/^[0-9a-f]{8}$/.test(x.id)) return undefined;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= Date.now() + 50 * 365 * 86_400_000 ? v : undefined);
  const at = num(x.at), created = num(x.created), updated = num(x.updated);
  if (at === undefined || created === undefined || updated === undefined || updated > Date.now() + 5 * 60_000) return undefined;
  const text = typeof x.text === "string" ? x.text.replace(/[\p{Cc}\p{Cf}]+/gu, " ").trim().slice(0, 500) : "";
  if (!text) return undefined;
  const tz = typeof x.tz === "string" && validZone(x.tz) ? x.tz : config.timezone;
  let cron: string | undefined;
  if (x.cron !== undefined) { try { cron = String(x.cron).slice(0, 100); cronOf(cron, tz); } catch { return undefined; } }
  const until = num(x.until);
  return {
    id: x.id, text, at, ...(cron ? { cron } : {}), ...(until !== undefined ? { until } : {}), tz,
    created, updated, ...(x.deleted === true ? { deleted: true } : {}), ...(x.done === true ? { done: true } : {}),
    ...(num(x.fired) !== undefined ? { fired: num(x.fired) } : {}),
    ...(num(x.span) ? { span: Math.min(num(x.span)!, 90 * 86_400_000) } : {}),
    ...(typeof x.step === "string" && x.step.trim() ? { step: x.step.replace(/[\p{Cc}\p{Cf}]+/gu, " ").trim().slice(0, 200) } : {}),
    ...(typeof x.conv === "string" && x.conv.length <= 80 ? { conv: x.conv } : {}), by: typeof x.by === "string" ? x.by.slice(0, 40) : "agent",
  };
}
