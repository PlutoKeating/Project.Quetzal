// 每个会话的工作状态（task_state：目标、约束、未决问题、阶段、标签）：属于心智，全网同步。
//   - 存在 kv「taskStates」（一个会话一条，最多 200 条，按修改时刻保留最近的）；之前版本存在 kv「context.state.<会话>」，读不到新记录时照旧读它。
//   - 多具身体时经 mesh/shared.ts 的 taskStates 分区按会话合并：修改较新的为准（后写胜；相同时刻按内容比较，各身体收敛到同一份），
//     所以对话换到另一具身体上继续（move_to、续做、对方从另一具身体的控制台说话）时，约束与未决问题跟着过去。
//   - 别处来的逐字段检查：会话编号、字符串数组的条数与长度、阶段只收认得的值、修改时刻不晚于「现在 + 5 分钟」。
import { kv } from "../store.ts";
import { bus } from "../bus.ts";
import { config } from "../config.ts";

export interface TaskStateRecord { conv: string; goal: string; constraints: string[]; openQuestions: string[]; phase: string; tags: string[]; updatedAt: number; body: string }

const KEY = "taskStates", MAX = 200, FUTURE_MS = 5 * 60_000;
const PHASES = new Set(["unknown", "exploration", "verification", "completion", "any"]);
const clean = (s: unknown, n: number) => (typeof s === "string" ? s.replace(/[\p{Cc}\p{Cf}]+/gu, " ").trim().slice(0, n) : "");
const list = (v: unknown) => (Array.isArray(v) ? v.slice(0, 20).map((x) => clean(x, 1000)).filter(Boolean) : []);

export const all = (): TaskStateRecord[] => kv.get<TaskStateRecord[]>(KEY, []);

/** 一个会话的工作状态（没有则看旧版本的记录）。 */
export function get(conv: string): (Partial<TaskStateRecord> & { constraints?: string[]; openQuestions?: string[] }) | null {
  return all().find((r) => r.conv === conv) ?? kv.get<TaskStateRecord | null>(`context.state.${conv}`, null);
}

function store(records: TaskStateRecord[], o: { remote?: boolean } = {}) {
  kv.set(KEY, records.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX));
  if (!o.remote) bus.emit("taskStates.changed");
}

/** 记下一个会话此刻的工作状态（context.ts 的 task_state 修改时调用）。 */
export function save(conv: string, s: { goal?: unknown; constraints?: unknown; openQuestions?: unknown; phase?: unknown; tags?: unknown }, now = Date.now()): TaskStateRecord {
  const r: TaskStateRecord = { conv: clean(conv, 200), goal: clean(s.goal, 4000), constraints: list(s.constraints), openQuestions: list(s.openQuestions),
    phase: typeof s.phase === "string" && PHASES.has(s.phase) ? s.phase : "unknown", tags: list(s.tags), updatedAt: now, body: config.body };
  store([...all().filter((x) => x.conv !== r.conv), r]);
  return r;
}

/** 别处来的一条：不合格返回 undefined。 */
export function sanitize(x: any, now = Date.now()): TaskStateRecord | undefined {
  if (!x || typeof x !== "object") return undefined;
  const conv = clean(x.conv, 200), updatedAt = typeof x.updatedAt === "number" && Number.isFinite(x.updatedAt) && x.updatedAt > 0 ? x.updatedAt : 0;
  if (!conv || conv !== x.conv || !updatedAt || updatedAt > now + FUTURE_MS) return undefined;
  const body = clean(x.body, 40);
  return { conv, goal: clean(x.goal, 4000), constraints: list(x.constraints), openQuestions: list(x.openQuestions), phase: typeof x.phase === "string" && PHASES.has(x.phase) ? x.phase : "unknown",
    tags: list(x.tags), updatedAt, body: /^[a-z0-9][a-z0-9-]{0,39}$/.test(body) ? body : "" };
}

/** 按会话合并别处的记录：修改较新的为准。返回是否有变化。 */
export function merge(theirs: unknown): boolean {
  if (!Array.isArray(theirs)) return false;
  const records = all(), byConv = new Map(records.map((r) => [r.conv, r]));
  let changed = false;
  for (const x of theirs.slice(0, MAX * 2)) {
    const r = sanitize(x);
    if (!r) continue;
    const mine = byConv.get(r.conv);
    if (mine && (mine.updatedAt > r.updatedAt || (mine.updatedAt === r.updatedAt && JSON.stringify(mine) >= JSON.stringify(r)))) continue;
    if (mine) Object.assign(mine, r); else { records.push(r); byConv.set(r.conv, r); }
    changed = true;
  }
  if (changed) store(records, { remote: true });
  return changed;
}
