// 长期目标（#23）：「未完成的念头」升级为可以带步骤与进度的目标。她用 goal 工具管理（open_loop 仍可用：没有步骤的目标）。
//   - 每个目标：标题、说明、步骤（每步 todo / doing / done / skipped）、进度（做完的步数 / 不算跳过的步数）、最近推进的时刻、关联的会话、最近在哪具身体上改的。
//   - 属于心智（DISTRIBUTED.md §2.1）：存在 kv 里；多具身体时经 mesh/shared.ts 的 goals 分区按条目合并（同一编号以修改较新的为准，相同时刻按内容比较，
//     保证各身体收敛到同一份）；关闭（完成 / 放下）的目标留 30 天作墓碑，过了就两边同时不再收，所以不会被别处的旧副本复活。
//   - 心脏的「牵挂」按进行中的目标数计算（heart.ts 的 setOpenLoops，公式不变：数目 / 5，封顶 1）；系统提示列出进行中的目标；醒来时回顾与推进目标是候选意图之一。
//   - 旧的未完成念头（kv「openLoops」）第一次读取时迁移成没有步骤的目标（编号不变，旧数据原样保留，回到旧版本也不丢）。
import crypto from "node:crypto";
import { kv } from "../store.ts";
import { bus } from "../bus.ts";
import { config } from "../config.ts";
import { setOpenLoops } from "../heart/heart.ts";

export type StepStatus = "todo" | "doing" | "done" | "skipped";
export interface GoalStep { id: string; text: string; status: StepStatus; updated: number }
export interface Goal {
  id: string; title: string; detail: string; steps: GoalStep[];
  status: "open" | "done" | "dropped"; note: string; // note：关闭时的说明
  created: number; updated: number; progressed: number; // progressed：最近一次推进（新建、步骤变化）的时刻
  convs: string[]; body: string; // 关联的会话（最近的在后）；最近在哪具身体上改的
}

const KEY = "goals", LEGACY = "openLoops", MIGRATED = "goals.migrated";
export const MAX_GOALS = 200, MAX_STEPS = 30;
const KEEP_CLOSED_MS = 30 * 86_400_000, FUTURE_MS = 5 * 60_000;
const ID = /^[0-9a-z]{4,16}$/;
const STATUS = new Set(["todo", "doing", "done", "skipped"]);
const clean = (s: unknown, n: number) => (typeof s === "string" ? s.replace(/[\p{Cc}\p{Cf}]+/gu, " ").trim().slice(0, n) : "");
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

/** 旧的未完成念头迁移成没有步骤的目标（只做一次；旧数据不删）。 */
function migrate(list: Goal[]): Goal[] {
  if (kv.get<boolean>(MIGRATED, false)) return list;
  const old = kv.get<{ id?: string; text?: string; ts?: number }[]>(LEGACY, []);
  for (const l of Array.isArray(old) ? old : []) {
    const title = clean(l?.text, 300), ts = num(l?.ts) || Date.now();
    if (!title) continue;
    const id = typeof l.id === "string" && ID.test(l.id) && !list.some((g) => g.id === l.id) ? l.id : newId();
    list.push({ id, title, detail: "", steps: [], status: "open", note: "", created: ts, updated: ts, progressed: ts, convs: [], body: config.body });
  }
  kv.set(MIGRATED, true);
  kv.set(KEY, list);
  return list;
}
const newId = () => crypto.randomBytes(4).toString("hex");

/** 全部记录（含关闭的墓碑；过了保留期的不再返回）。 */
export function all(now = Date.now()): Goal[] {
  return migrate(kv.get<Goal[]>(KEY, [])).filter((g) => g.status === "open" || g.updated > now - KEEP_CLOSED_MS);
}
/** 进行中的目标：最近推进的在前。 */
export const open = (): Goal[] => all().filter((g) => g.status === "open").sort((a, b) => b.progressed - a.progressed || (a.id < b.id ? -1 : 1));
export const get = (id: string) => all().find((g) => g.id === id);

/** 进度：做完的步数 / 不算跳过的步数；没有步骤时为 undefined。 */
export function progress(g: Goal): { done: number; total: number; ratio: number } | undefined {
  const counted = g.steps.filter((s) => s.status !== "skipped");
  if (!counted.length) return undefined;
  const done = counted.filter((s) => s.status === "done").length;
  return { done, total: counted.length, ratio: done / counted.length };
}

function save(list: Goal[], o: { remote?: boolean } = {}) {
  const now = Date.now();
  const kept = list.filter((g) => g.status === "open" || g.updated > now - KEEP_CLOSED_MS)
    .sort((a, b) => Number(b.status === "open") - Number(a.status === "open") || b.updated - a.updated).slice(0, MAX_GOALS);
  kv.set(KEY, kept);
  if (!o.remote) bus.emit("goals.changed"); // 本机改的：网状层广播给其他身体
  setOpenLoops(kept.filter((g) => g.status === "open").length); // 心脏的牵挂随之更新（本机改的与别处来的都算；跟随者转给协调者）
  bus.emit("state");
}

const steps = (texts: unknown, now: number, prev: GoalStep[] = []): GoalStep[] =>
  (Array.isArray(texts) ? texts : []).map((t) => clean(t, 300)).filter(Boolean).slice(0, MAX_STEPS)
    .map((text, i) => { const same = prev.find((p) => p.text === text); return { id: String(i + 1), text, status: same?.status ?? "todo", updated: same?.updated ?? now }; });
const touch = (g: Goal, now: number, conv?: string, progressed = false) => {
  g.updated = now; g.body = config.body;
  if (progressed) g.progressed = now;
  if (conv) g.convs = [...g.convs.filter((c) => c !== conv), clean(conv, 200)].slice(-10);
};

/** 新建一个目标。 */
export function add(a: { title: unknown; detail?: unknown; steps?: unknown; conv?: string }, now = Date.now()): Goal {
  const title = clean(a.title, 300);
  if (!title) throw new Error("目标需要一个标题（title）");
  const list = all(now);
  if (list.filter((g) => g.status === "open").length >= MAX_GOALS) throw new Error(`进行中的目标已经有 ${MAX_GOALS} 个，先关掉一些`);
  const g: Goal = { id: newId(), title, detail: clean(a.detail, 2000), steps: steps(a.steps, now), status: "open", note: "", created: now, updated: now, progressed: now, convs: [], body: config.body };
  touch(g, now, a.conv, true);
  list.push(g);
  save(list);
  return g;
}

const find = (list: Goal[], id: unknown) => {
  const g = list.find((x) => x.id === clean(id, 16));
  if (!g) throw new Error(`没有这个目标：${clean(id, 16) || "（没给 id）"}（用 goal 的 list 看现有的）`);
  return g;
};

/** 修改：标题、说明、整份步骤（同样文字的步骤保留状态）、追加步骤。 */
export function update(a: { id: unknown; title?: unknown; detail?: unknown; steps?: unknown; add_steps?: unknown; conv?: string }, now = Date.now()): Goal {
  const list = all(now), g = find(list, a.id);
  if (g.status !== "open") throw new Error(`目标「${g.title}」已经关闭了`);
  let progressed = false;
  if (a.title !== undefined) { const t = clean(a.title, 300); if (!t) throw new Error("标题不能为空"); g.title = t; }
  if (a.detail !== undefined) g.detail = clean(a.detail, 2000);
  if (a.steps !== undefined) { g.steps = steps(a.steps, now, g.steps); progressed = true; }
  if (a.add_steps !== undefined) {
    const more = steps(a.add_steps, now).filter((s) => !g.steps.some((x) => x.text === s.text));
    if (g.steps.length + more.length > MAX_STEPS) throw new Error(`一个目标最多 ${MAX_STEPS} 步`);
    g.steps = [...g.steps, ...more].map((s, i) => ({ ...s, id: String(i + 1) }));
    progressed = progressed || more.length > 0;
  }
  touch(g, now, a.conv, progressed);
  save(list);
  return g;
}

/** 一步的状态（缺省 done）。step：第几步（从 1 起）或那一步的文字。 */
export function stepDone(a: { id: unknown; step: unknown; status?: unknown; conv?: string }, now = Date.now()): Goal {
  const list = all(now), g = find(list, a.id);
  if (g.status !== "open") throw new Error(`目标「${g.title}」已经关闭了`);
  const key = typeof a.step === "number" ? String(a.step) : clean(a.step, 300);
  const s = g.steps.find((x) => x.id === key) ?? g.steps.find((x) => x.text === key);
  if (!s) throw new Error(`目标「${g.title}」里没有这一步：${key || "（没给 step）"}（共 ${g.steps.length} 步，用编号）`);
  const status = (typeof a.status === "string" && STATUS.has(a.status) ? a.status : "done") as StepStatus;
  s.status = status; s.updated = now;
  touch(g, now, a.conv, true);
  save(list);
  return g;
}

/** 关闭：完成（done）或放下（dropped）。 */
export function close(a: { id: unknown; outcome?: unknown; note?: unknown; conv?: string }, now = Date.now()): Goal {
  const list = all(now), g = find(list, a.id);
  if (g.status !== "open") return g;
  g.status = a.outcome === "dropped" ? "dropped" : "done"; g.note = clean(a.note, 1000);
  touch(g, now, a.conv, true);
  save(list);
  return g;
}

/** 别处来的一条记录：字段类型与长度、时刻（修改时刻不能在未来；关闭的过了保留期不收）。不合格返回 undefined。 */
export function sanitize(x: any, now = Date.now()): Goal | undefined {
  if (!x || typeof x !== "object" || typeof x.id !== "string" || !ID.test(x.id)) return undefined;
  const created = num(x.created), updated = num(x.updated), progressed = num(x.progressed) || updated;
  if (!created || !updated || updated > now + FUTURE_MS || created > now + FUTURE_MS || progressed > now + FUTURE_MS) return undefined;
  const status = x.status === "open" || x.status === "done" || x.status === "dropped" ? x.status : undefined;
  const title = clean(x.title, 300);
  if (!status || !title || (status !== "open" && updated <= now - KEEP_CLOSED_MS)) return undefined;
  const st: GoalStep[] = (Array.isArray(x.steps) ? x.steps : []).slice(0, MAX_STEPS).flatMap((s: any, i: number) => {
    const text = clean(s?.text, 300);
    return text ? [{ id: String(i + 1), text, status: (STATUS.has(s?.status) ? s.status : "todo") as StepStatus, updated: Math.min(num(s?.updated) || updated, now + FUTURE_MS) }] : [];
  });
  const body = clean(x.body, 40);
  return { id: x.id, title, detail: clean(x.detail, 2000), steps: st, status, note: clean(x.note, 1000), created, updated, progressed,
    convs: (Array.isArray(x.convs) ? x.convs : []).map((c: unknown) => clean(c, 200)).filter(Boolean).slice(-10), body: /^[a-z0-9][a-z0-9-]{0,39}$/.test(body) ? body : "" };
}

/** 合并别处的记录：同一编号取修改较新的（相同时刻按内容比较，各身体收敛到同一份）；新的直接收下。返回是否有变化。 */
export function merge(theirs: unknown): boolean {
  if (!Array.isArray(theirs)) return false;
  const list = all(), byId = new Map(list.map((g) => [g.id, g]));
  let changed = false;
  for (const x of theirs.slice(0, MAX_GOALS * 2)) {
    const g = sanitize(x);
    if (!g) continue;
    const mine = byId.get(g.id);
    if (mine && (mine.updated > g.updated || (mine.updated === g.updated && JSON.stringify(mine) >= JSON.stringify(g)))) continue;
    if (mine) Object.assign(mine, g); else { list.push(g); byId.set(g.id, g); }
    changed = true;
  }
  if (changed) save(list, { remote: true });
  return changed;
}

// ---------- 给她看与给控制台看
const at = (ts: number) => new Date(ts).toLocaleString("zh-CN", { timeZone: config.timezone, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
const MARK: Record<StepStatus, string> = { todo: "○", doing: "…", done: "✓", skipped: "–" };
const pct = (g: Goal) => { const p = progress(g); return p ? `进度 ${p.done}/${p.total}（${Math.round(p.ratio * 100)}%）` : "没有分步骤"; };

/** 一个目标的完整描述（goal 工具的回执）。 */
export function describe(g: Goal): string {
  const head = `[${g.id}] ${g.title}（${g.status === "open" ? pct(g) : g.status === "done" ? "已完成" : "已放下"}，最近推进 ${at(g.progressed)}${g.body && g.body !== config.body ? `，在 ${g.body} 上改的` : ""}）`;
  return [head, ...(g.detail ? [`  说明：${g.detail}`] : []), ...g.steps.map((s) => `  ${s.id}. ${MARK[s.status]} ${s.text}`), ...(g.note ? [`  ${g.note}`] : [])].join("\n");
}

/** 系统提示里的「进行中的目标」：每个目标一行，加上还没做完的前几步。 */
export function promptBlock(limit = 8): string {
  const list = open();
  if (!list.length) return "没有进行中的目标。以后还想继续、需要几步才能做成的事，用 goal 记下来（可以分步骤，做完一步标一步）。";
  const lines = list.slice(0, limit).map((g) => {
    const rest = g.steps.filter((s) => s.status === "todo" || s.status === "doing").slice(0, 3);
    return `- [${g.id}] ${g.title}（${pct(g)}，最近推进 ${at(g.progressed)}）${rest.length ? `\n  接下来：${rest.map((s) => `${s.id}. ${s.text}${s.status === "doing" ? "（进行中）" : ""}`).join("；")}` : ""}`;
  });
  return `进行中的目标（用 goal 管理：推进一步用 step_done，做完或不做了用 close）：\n${lines.join("\n")}${list.length > limit ? `\n- ……还有 ${list.length - limit} 个（goal 的 list 看全部）` : ""}`;
}

/** 控制台的目标视图。 */
export const view = (closed = false) => (closed ? all() : open()).map((g) => ({ ...g, progress: progress(g) ?? null }));

// ---------- 旧的 open_loop（没有步骤的目标）
export interface OpenLoop { id: string; text: string; ts: number }
export const openLoops = (): OpenLoop[] => open().map((g) => ({ id: g.id, text: g.title, ts: g.created }));
export const openCount = () => open().length;

/** goal 工具（mind/tools.ts 挂进工具表）。conv：在哪个会话里调用的（关联到目标上）。出错就抛（工具失败）。 */
export function goalTool(a: Record<string, any>, conv?: string): string {
  const c = conv || undefined;
  switch (a.action) {
    case "add": { const g = add({ title: a.title, detail: a.detail, steps: a.steps, conv: c }); return `已记下目标（进行中的目标现在有 ${openCount()} 个）：\n${describe(g)}`; }
    case "update": return `已修改：\n${describe(update({ id: a.id, title: a.title, detail: a.detail, steps: a.steps, add_steps: a.add_steps, conv: c }))}`;
    case "step_done": {
      const g = stepDone({ id: a.id, step: a.step, status: a.status, conv: c }), p = progress(g);
      return `已更新：\n${describe(g)}${p && p.done === p.total ? "\n每一步都做完了：确实做成了就用 close 关掉它。" : ""}`;
    }
    case "close": { const g = close({ id: a.id, outcome: a.outcome, note: a.note, conv: c }); return `已${g.status === "dropped" ? "放下" : "完成"}「${g.title}」，进行中的目标还有 ${openCount()} 个。`; }
    case "list": {
      const list = all().sort((x, y) => Number(y.status === "open") - Number(x.status === "open") || y.progressed - x.progressed);
      return list.length ? list.slice(0, 40).map(describe).join("\n\n") : "还没有目标";
    }
    default: throw new Error("action 只能是 add / update / step_done / close / list");
  }
}
