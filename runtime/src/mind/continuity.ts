// 续做（#11）：agent 是一个完整的生命，任何时候都能干活——基座重启、手上有活的那具身体离线，都不让进行中的事就此断掉。
//   - 检查点：本机每一轮（对话、醒来、做梦）从开始起就记一条记录（会话、通道、这一轮的起因、做了几步、最近的过程），
//     有进展时最快每 10 秒更新一次，结束（回复、出错、被停止、换身体）时标为结束。子 agent 的检查点在 mind/agents.ts 里，同一个道理。
//     记录属于心智：存在 kv「turns」，多具身体时经 mesh/shared.ts 的 turns 分区按条目合并（先比 epoch，再比修改时刻）；结束的留一天作墓碑。
//   - 基座重启后（resumeHere）：还标着「进行中」、却没有在跑的本机轮次与子 agent，从检查点续做——对话在原会话里以「续做」的交接接着做
//     （通道「续做」的环境输入，回复照常进会话），醒来按原来的起因接着做，子 agent 带上之前做到哪里的交接接着跑。
//   - 一具身体离线时，它手上没做完的轮次与子 agent 由协调层交给另一具在线的身体接着做（mesh/continuity.ts 调 takeOver）。
//   - 防重复：同一件事只能被一具身体续做。谁续做由协调者决定（decideTake，经网状层的 work.take，与 claims.op 同样的做法）：
//     记录的身体还在线就不给别人；给了就把记录改到接手的身体上（epoch 加一）并广播，原来的身体回来时看到记录被接手，立即停下它手上的那一份。
//     连不上协调者时在本机决定（断网分区各自续做，重新连上后 epoch 与修改时刻较大的一份为准，另一份停下）。
//   - 同一件事最多续做 MAX_RESUMES 次（反复在同一处崩溃时不无限重来）；开始超过 6 小时的轮次不再续做。
import { bus, type Activity } from "../bus.ts";
import { kv, addTimeline } from "../store.ts";
import { config } from "../config.ts";
import { liveTurns, sessionById, HandedOver } from "./activity.ts";
import * as agents from "./agents.ts";
import { converse, wake, resumeAgent } from "./brain.ts";
import { log } from "../log.ts";

export interface TurnRecord {
  id: string; origin: "chat" | "think" | "dream"; conv: string; channel: string; body: string;
  text: string; started: number; updated: number; epoch: number;
  status: "running" | "ended" | "handed"; by?: string; // handed：交给了 by 那具身体接着做
  steps: number; summary: string; resumes: number;
}
export type WorkKind = "agent" | "turn";
export interface TakeResult { ok: boolean; record?: unknown }

const KEY = "turns", MAX = 100, ENDED_KEEP_MS = 86_400_000, FUTURE_MS = 5 * 60_000;
export const MAX_RESUMES = 3;
const STALE_MS = 6 * 3_600_000;
/** 可调的时间（测试用小一些）：检查点的间隔、离线多久交给别的身体、多久巡查一次、启动后多久续做本机没做完的。 */
export const timing = { checkpointMs: 10_000, graceMs: 90_000, sweepMs: 15_000, resumeDelayMs: 15_000 };
export const configureContinuity = (t: Partial<typeof timing>) => { Object.assign(timing, t); if (t.checkpointMs) agents.agentTiming.checkpointMs = t.checkpointMs; };

const BODY = /^[a-z0-9][a-z0-9-]{0,39}$/;
const clean = (v: unknown, n: number) => (typeof v === "string" ? v.replace(/[\p{Cc}\p{Cf}]+/gu, " ").slice(0, n) : "");
const text = (v: unknown, n: number) => (typeof v === "string" ? v.replace(/[\p{Cc}\p{Cf}]+/gu, (c) => (c === "\n" ? c : " ")).slice(0, n) : "");
const num = (v: unknown, max = 1e15) => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= max ? v : 0);

// ---------- 轮次的检查点
export function turns(now = Date.now()): TurnRecord[] {
  return kv.get<TurnRecord[]>(KEY, []).filter((t) => (t.status === "running" ? now - t.started < 24 * 3_600_000 : now - t.updated < ENDED_KEEP_MS));
}
const find = (id: string) => turns().find((t) => t.id === id);
function store(list: TurnRecord[], o: { remote?: boolean } = {}) {
  kv.set(KEY, list.sort((a, b) => b.updated - a.updated).slice(0, MAX));
  if (!o.remote) bus.emit("turns.changed");
}
function upsert(r: TurnRecord) { store([...turns().filter((t) => t.id !== r.id), r]); }

/** 续做出来的那一轮：开始时记下这是第几次续做（同一会话 / 同一种醒来的下一轮）。 */
const resuming = new Map<string, number>();
const resumeKey = (origin: string, conv: string) => `${origin}:${conv}`;

const dirty = new Set<string>();
let flushTimer: NodeJS.Timeout | undefined;
function flush() {
  flushTimer = undefined;
  if (!dirty.size) return;
  const list = turns(), live = liveTurns();
  for (const id of dirty) {
    const r = list.find((t) => t.id === id), t = live.find((x) => x.turn === id);
    if (!r || r.status !== "running" || r.body !== config.body || !t) continue;
    r.steps = t.items.filter((x) => x.type === "tool").length;
    r.summary = agents.describeSteps(t.items, 20).slice(-6000);
    r.updated = Date.now();
  }
  dirty.clear();
  store(list);
}

/** 本机的进展事件折叠成检查点（子 agent 的在 agents.ts 里记）。 */
export function onActivity(a: Activity) {
  if ((a.body && a.body !== config.body) || a.origin === "agent") return;
  if (a.kind === "start") {
    const key = resumeKey(a.origin, a.origin === "chat" ? a.conv : "");
    const resumes = resuming.get(key) ?? 0;
    resuming.delete(key);
    upsert({ id: a.session, origin: a.origin as TurnRecord["origin"], conv: a.conv, channel: a.channel, body: config.body, text: text(a.text, 2000), started: a.ts, updated: a.ts, epoch: 0, status: "running", steps: 0, summary: "", resumes });
  } else if (a.kind === "done" || a.kind === "error") {
    dirty.delete(a.session);
    const r = find(a.session);
    if (r && r.status === "running" && r.body === config.body) { Object.assign(r, { status: "ended", updated: Date.now(), summary: "" }); upsert(r); } // 结束的只留作墓碑：过程不再随同步传来传去
  } else if ((a.kind === "tool" && a.status !== "running") || (a.kind === "text" && !a.final) || a.kind === "steer") {
    dirty.add(a.session);
    flushTimer ??= setTimeout(flush, timing.checkpointMs);
    flushTimer.unref?.();
  }
}

/** 别处来的一条检查点：不合格返回 undefined。 */
export function sanitizeTurn(x: any, now = Date.now()): TurnRecord | undefined {
  if (!x || typeof x !== "object" || typeof x.id !== "string" || !/^[\w-]{1,80}$/.test(x.id)) return undefined;
  const origin = x.origin === "chat" || x.origin === "think" || x.origin === "dream" ? x.origin : undefined;
  const status = x.status === "running" || x.status === "ended" || x.status === "handed" ? x.status : undefined;
  const started = num(x.started), updated = num(x.updated), body = clean(x.body, 40);
  if (!origin || !status || !started || !updated || started > now + FUTURE_MS || updated > now + FUTURE_MS || !BODY.test(body)) return undefined;
  const conv = clean(x.conv, 200);
  if (origin === "chat" && !conv) return undefined;
  const by = clean(x.by, 40);
  return { id: x.id, origin, conv, channel: clean(x.channel, 20), body, text: text(x.text, 2000), started, updated, epoch: num(x.epoch, 1e6), status, ...(by && BODY.test(by) ? { by } : {}),
    steps: num(x.steps, 1e6), summary: text(x.summary, 6000), resumes: num(x.resumes, 100) };
}
const newer = (a: TurnRecord, b: TurnRecord) => a.epoch !== b.epoch ? a.epoch > b.epoch : a.updated !== b.updated ? a.updated > b.updated : JSON.stringify(a) > JSON.stringify(b);

/** 合并别处的检查点。这里还在做的一轮被别处接手了，就让这里的那一份停下。返回是否有变化。 */
export function mergeTurns(theirs: unknown): boolean {
  if (!Array.isArray(theirs)) return false;
  const list = turns(), byId = new Map(list.map((t) => [t.id, t]));
  let changed = false;
  for (const x of theirs.slice(0, MAX * 2)) {
    const r = sanitizeTurn(x);
    if (!r) continue;
    const mine = byId.get(r.id);
    if (mine && !newer(r, mine)) continue;
    if (mine) Object.assign(mine, r); else { list.push(r); byId.set(r.id, r); }
    changed = true;
    if (r.status === "handed" && r.by && r.by !== config.body) sessionById(r.id)?.abort(new HandedOver(r.by));
  }
  if (changed) store(list, { remote: true });
  return changed;
}

// ---------- 谁来续做：协调者决定
/**
 * 决定 by 能不能续做这件事（在协调者上执行；连不上协调者时在本机）。offered：请求方手上的记录（协调者也许还没收到），先合并。
 * 记录的身体还活着（alive）且不是 by，就不给；给了就把记录改到 by 上（epoch 加一）并广播。
 */
export function decideTake(kind: WorkKind, id: string, by: string, alive: (body: string) => boolean, offered?: unknown): TakeResult {
  if (offered) (kind === "agent" ? agents.merge([offered]) : mergeTurns([offered]));
  if (kind === "agent") {
    const a = agents.get(id);
    if (!a || a.status !== "running" || (a.body !== by && alive(a.body))) return { ok: false, record: a };
    return { ok: true, record: agents.handTo(id, by) };
  }
  const list = turns(), t = list.find((x) => x.id === id);
  if (!t || t.status !== "running" || (t.body !== by && alive(t.body))) return { ok: false, record: t };
  Object.assign(t, { status: "handed", by, epoch: t.epoch + 1, updated: Date.now(), summary: "" }); // 接手的身体已经拿着检查点
  store(list);
  if (by !== config.body) sessionById(id)?.abort(new HandedOver(by));
  return { ok: true, record: t };
}

type TakeRouter = (kind: WorkKind, id: string, record: unknown) => Promise<TakeResult> | undefined;
let router: TakeRouter | undefined;
/** 多具身体：续做的决定转给协调者（mesh/continuity.ts 注入）。 */
export const setTakeRouter = (f: TakeRouter | undefined) => { router = f; };

/** 请求续做（经协调者；连不上就在本机决定）。返回是否可以做。 */
export async function take(kind: WorkKind, id: string): Promise<boolean> {
  const offered = kind === "agent" ? agents.get(id) : find(id);
  const remote = router?.(kind, id, offered);
  if (remote) {
    try {
      const r = await remote;
      if (r && typeof r === "object" && typeof r.ok === "boolean") {
        if (r.record) (kind === "agent" ? agents.merge([r.record]) : mergeTurns([r.record]));
        return r.ok;
      }
    } catch { /* 连不上协调者：本机决定 */ }
  }
  return decideTake(kind, id, config.body, (b) => b === config.body).ok;
}

// ---------- 接着做
const at = (ts: number) => new Date(ts).toLocaleString("zh-CN", { timeZone: config.timezone, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });

/** 续做的交接：为什么续做、这一轮是怎么开始的、之前做了几步、检查点记下的过程。 */
export function handoff(t: TurnRecord, why: string): string {
  const start = t.origin === "chat" ? `这一轮从 ${at(t.started)} 开始（${t.channel === "续做" ? "它本身就是一次续做" : "起因是上面对话记录里还没回复的那句话"}）` : `这次${t.origin === "dream" ? "做梦" : "醒来"}从 ${at(t.started)} 开始，起因：${t.text || "（没有记下）"}`;
  return `${why}。${start}，之前做了 ${t.steps} 步${t.summary ? `，检查点记下的过程：\n${t.summary}` : "，还没有做完任何一步"}`;
}

/** 在这具身体上接着做一轮（记录已经归这里）。 */
function runTurn(t: TurnRecord, why: string) {
  const note = handoff(t, why);
  addTimeline(t.origin === "chat" ? "chat" : t.origin, `续做：${why}`, { conv: t.conv, turn: t.id, from: t.body, steps: t.steps });
  log("continuity", `续做 ${t.origin} ${t.conv || t.id}：${why}`);
  resuming.set(resumeKey(t.origin, t.origin === "chat" ? t.conv : ""), t.resumes + 1);
  if (t.origin === "chat") return void converse("基座", note, "续做", { conv: t.conv, ambient: true, local: true }).catch((e) => log("continuity", `续做对话失败：${e.message}`));
  void wake(t.origin, `续做：${t.text || "之前没做完的事"}`, { intent: `接着之前没做完的这次${t.origin === "dream" ? "做梦" : "醒来"}做下去。${note}` }).catch((e) => log("continuity", `续做醒来失败：${e.message}`));
}

/** 放弃续做（太久了、或续做了太多次）：记录标为结束，留一笔。 */
function abandon(kind: WorkKind, id: string, why: string) {
  if (kind === "agent") {
    const a = agents.abandon(id, why);
    if (a) void converse("子agent", `子 agent「${a.name}」中断了：${why}${a.checkpoint?.summary ? `\n\n它中断前做的事：\n${a.checkpoint.summary}` : ""}`, "子agent", { conv: a.parentConv, ambient: true }).catch(() => {});
    return;
  }
  const list = turns(), t = list.find((x) => x.id === id);
  if (!t) return;
  Object.assign(t, { status: "ended", updated: Date.now() });
  store(list);
  addTimeline(t.origin === "chat" ? "chat" : t.origin, `没有续做：${why}`, { conv: t.conv, turn: t.id });
}

/** 一具身体（离线了的、或这具身体重启前）手上没做完的事：子 agent 与轮次。 */
export function pendingOf(body: string, now = Date.now()) {
  return {
    agents: agents.list().filter((a) => a.status === "running" && a.body === body && !agents.runningHere(a.id)),
    turns: turns(now).filter((t) => t.status === "running" && t.body === body && !sessionById(t.id)),
  };
}

/**
 * 接手一件事并接着做。by：在哪具身体上续做（就是这具）。why：给她看的原因。take 为真时先请求续做（经协调者），否则调用方已经决定好了。
 * 返回是否开始了。
 */
export async function continueWork(kind: WorkKind, id: string, why: string, o: { take?: boolean } = {}): Promise<boolean> {
  const rec = kind === "agent" ? agents.get(id) : find(id);
  if (!rec) return false;
  const resumes = kind === "agent" ? (rec as agents.SubAgent).resumes ?? 0 : (rec as TurnRecord).resumes;
  const started = kind === "agent" ? (rec as agents.SubAgent).started : (rec as TurnRecord).started;
  if (resumes >= MAX_RESUMES) { abandon(kind, id, `已经续做了 ${resumes} 次仍没做完`); return false; }
  if (kind === "turn" && Date.now() - started > STALE_MS) { abandon(kind, id, "开始太久了（超过 6 小时）"); return false; }
  const snapshot = kind === "turn" ? { ...(rec as TurnRecord) } : undefined;
  if (o.take !== false && !(await take(kind, id))) return false;
  if (kind === "agent") return resumeAgent(id, why);
  runTurn(snapshot!, why);
  return true;
}

/** 基座重启后：本机没做完的子 agent 与轮次从检查点续做。 */
export async function resumeHere(): Promise<number> {
  const { agents: a, turns: t } = pendingOf(config.body);
  let n = 0;
  for (const x of a) if (await continueWork("agent", x.id, "基座重启了，这个子 agent 之前没做完").catch(() => false)) n++;
  for (const x of t) if (await continueWork("turn", x.id, "基座重启了，这一轮之前没做完").catch(() => false)) n++;
  return n;
}

/** 装配（main.ts）：本机进展折叠成检查点；启动后一会儿续做本机没做完的事。 */
export function startContinuity(): () => void {
  bus.on("activity", onActivity);
  const t = setTimeout(() => { void resumeHere().catch((e) => log("continuity", `续做失败：${e.message}`)); }, timing.resumeDelayMs);
  t.unref?.();
  return () => { clearTimeout(t); bus.off("activity", onActivity as any); };
}
