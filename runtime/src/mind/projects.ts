// 项目（#30）：把相关的会话组织在一起。名字、说明、颜色 / 图标（可选）与项目级说明——项目级说明作为这个项目下所有会话的额外上下文，
// 注入系统提示（mind/prompt.ts 的 projectBlock）。一个会话至多属于一个项目（store.ts 的 sessions.project）。
//   存储：每个项目一个对象，放在 SQLite 的 kv（"projects"）。删除留墓碑（deleted），多具身体之间按条目合并（同一编号以较新的修改为准），
//         所以两具身体同时各建一个不会互相覆盖（mesh/shared.ts 的 projects 分区）。
//   删除项目不删会话：只解除归属（store.clearSessionProject，经会话复制同步）；别处还指着已删除项目的会话一律当作不属于项目。
//   项目的说明是对方（或她自己）写的，和会话的标题一样属于这个心智的数据，不进灵魂仓库（与会话、对话一样只在身体之间复制）。
import crypto from "node:crypto";
import { kv, clearSessionProject, PROJECT_ID_RE } from "../store.ts";
import { bus } from "../bus.ts";

export interface Project {
  id: string; name: string; description: string; instructions: string;
  color?: string; icon?: string; // color：#rrggbb；icon：控制台认得的图标名（小写字母与下划线），不认得的显示缺省图标
  created: number; updated: number; archived?: boolean; deleted?: boolean;
}
export type ProjectPatch = Partial<Pick<Project, "name" | "description" | "instructions" | "color" | "icon" | "archived">>;

const KEY = "projects";
const MAX = 200; // 现存项目的上限（另留最多 200 个墓碑）
const FUTURE_MS = 5 * 60_000;
export const LIMITS = { name: 60, description: 500, instructions: 8000 } as const;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/, ICON_RE = /^[a-z_]{1,40}$/;

/** 全部项目（含墓碑）：多具身体之间合并用。 */
export const all = (): Project[] => kv.get<Project[]>(KEY, []);
/** 现存的项目（没删的）；archived 为真只看归档的、为假只看没归档的、不给全都要。按名字排。 */
export function list(o: { archived?: boolean } = {}): Project[] {
  return all().filter((p) => !p.deleted && (o.archived === undefined || !!p.archived === o.archived)).sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
}
/** 现存的项目编号（store.listSessions 据此把归属已删除项目的会话算作不属于项目）。 */
export const liveIds = () => all().filter((p) => !p.deleted).map((p) => p.id);
export const get = (id: string): Project | undefined => all().find((p) => p.id === id && !p.deleted);
/** 按编号或名字找（她用工具时常写名字）；名字不分大小写，找不到返回 undefined。 */
export function find(ref: string): Project | undefined {
  const r = String(ref ?? "").trim();
  if (!r) return undefined;
  const live = all().filter((p) => !p.deleted);
  return live.find((p) => p.id === r) ?? live.find((p) => p.name.toLowerCase() === r.toLowerCase());
}

function save(list: Project[], o: { remote?: boolean } = {}) {
  const keep = list.filter((p) => !p.deleted).slice(0, MAX);
  const tomb = list.filter((p) => p.deleted).sort((a, b) => b.updated - a.updated).slice(0, 200);
  kv.set(KEY, [...keep, ...tomb]);
  if (!o.remote) bus.emit("projects.changed"); // mesh/shared.ts 广播给其他身体
  bus.emit("projects", list.filter((p) => !p.deleted)); // 网关推给控制台
}

const clip = (v: unknown, n: number) => String(v ?? "").replace(/\r\n/g, "\n").trim().slice(0, n);
/** 控制台与工具给的修改：裁剪长度，颜色与图标不合格就不要（空字符串表示去掉）。 */
function clean(p: ProjectPatch): ProjectPatch {
  const out: ProjectPatch = {};
  if (p.name !== undefined) out.name = clip(p.name, LIMITS.name).replace(/\s+/g, " ");
  if (p.description !== undefined) out.description = clip(p.description, LIMITS.description);
  if (p.instructions !== undefined) out.instructions = clip(p.instructions, LIMITS.instructions);
  if (p.color !== undefined) { const c = String(p.color ?? "").trim(); if (!c || COLOR_RE.test(c)) out.color = c.toLowerCase(); else throw new Error("颜色要写成 #rrggbb"); }
  if (p.icon !== undefined) { const i = String(p.icon ?? "").trim(); if (!i || ICON_RE.test(i)) out.icon = i; else throw new Error("图标名只能是小写字母与下划线"); }
  if (p.archived !== undefined) out.archived = p.archived === true;
  return out;
}

export function create(p: ProjectPatch & { name: string }, now = Date.now()): Project {
  const c = clean(p);
  if (!c.name) throw new Error("项目要有名字");
  const list = all();
  if (list.filter((x) => !x.deleted).length >= MAX) throw new Error(`项目最多 ${MAX} 个`);
  if (list.some((x) => !x.deleted && x.name.toLowerCase() === c.name!.toLowerCase())) throw new Error(`已经有叫「${c.name}」的项目了`);
  const proj: Project = { id: crypto.randomBytes(8).toString("hex"), name: c.name, description: c.description ?? "", instructions: c.instructions ?? "", ...(c.color ? { color: c.color } : {}), ...(c.icon ? { icon: c.icon } : {}), created: now, updated: now };
  save([...list, proj]);
  return proj;
}

export function update(id: string, patch: ProjectPatch, now = Date.now()): Project {
  const list = all(), p = list.find((x) => x.id === id && !x.deleted);
  if (!p) throw new Error("没有这个项目");
  const c = clean(patch);
  if (c.name !== undefined && !c.name) throw new Error("项目要有名字");
  if (c.name && list.some((x) => x.id !== id && !x.deleted && x.name.toLowerCase() === c.name!.toLowerCase())) throw new Error(`已经有叫「${c.name}」的项目了`);
  Object.assign(p, c, { updated: Math.max(now, p.updated + 1) });
  if (p.color === "") delete p.color;
  if (p.icon === "") delete p.icon;
  if (!p.archived) delete p.archived;
  save(list);
  return p;
}

/** 删除项目（留墓碑）：会话不删，只解除归属。返回解除了几个会话的归属。 */
export function remove(id: string, now = Date.now()): number {
  const list = all(), p = list.find((x) => x.id === id && !x.deleted);
  if (!p) throw new Error("没有这个项目");
  Object.assign(p, { deleted: true, updated: Math.max(now, p.updated + 1), name: p.name, description: "", instructions: "" });
  save(list);
  return clearSessionProject(id);
}

// ---------- 多具身体之间按条目合并（mesh/shared.ts 的 projects 分区）
/** 合并别处的项目：同一编号取修改时刻较新的；新的直接收下。返回是否有变化。 */
export function merge(theirs: unknown, now = Date.now()): boolean {
  if (!Array.isArray(theirs)) return false;
  const list = all(), byId = new Map(list.map((p) => [p.id, p]));
  let changed = false;
  for (const x of theirs.slice(0, MAX + 200)) {
    const p = sanitize(x, now);
    if (!p) continue;
    const mine = byId.get(p.id);
    if (mine && mine.updated >= p.updated) continue;
    if (mine) { for (const k of Object.keys(mine)) delete (mine as any)[k]; Object.assign(mine, p); } else { list.push(p); byId.set(p.id, p); }
    changed = true;
  }
  if (changed) save(list, { remote: true });
  return changed;
}

/** 别处来的一个项目：字段类型与长度、时刻（修改时刻不能在未来）。不合格返回 undefined。 */
export function sanitize(x: any, now = Date.now()): Project | undefined {
  if (!x || typeof x !== "object" || typeof x.id !== "string" || !PROJECT_ID_RE.test(x.id)) return undefined;
  const t = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
  const created = t(x.created), updated = t(x.updated);
  if (!created || !updated || updated > now + FUTURE_MS || created > now + FUTURE_MS) return undefined;
  const str = (v: unknown, n: number) => (typeof v === "string" && v.length <= n ? v : undefined);
  const name = str(x.name, LIMITS.name), description = str(x.description ?? "", LIMITS.description), instructions = str(x.instructions ?? "", LIMITS.instructions);
  if (name === undefined || description === undefined || instructions === undefined) return undefined;
  if (!name.trim() && x.deleted !== true) return undefined;
  const color = typeof x.color === "string" && COLOR_RE.test(x.color) ? x.color.toLowerCase() : undefined;
  const icon = typeof x.icon === "string" && ICON_RE.test(x.icon) ? x.icon : undefined;
  return { id: x.id, name, description, instructions, ...(color ? { color } : {}), ...(icon ? { icon } : {}), created, updated, ...(x.archived === true ? { archived: true } : {}), ...(x.deleted === true ? { deleted: true } : {}) };
}

/** 系统提示里的一段：这个会话属于哪个项目、项目的说明（没有项目返回空串）。 */
export function promptBlock(projectId: string | null | undefined): string {
  const p = projectId ? get(projectId) : undefined;
  if (!p) return "";
  const lines = [`## 项目「${p.name}」\n这个会话属于项目「${p.name}」（id：${p.id}）${p.archived ? "（已归档）" : ""}。同一个项目下的会话谈的是相关的事。`];
  if (p.description.trim()) lines.push(`项目简介：${p.description.trim()}`);
  if (p.instructions.trim()) lines.push(`项目说明（为这个项目下所有会话写的上下文与要求，在这个会话里照着做；与红线冲突时以红线为准）：\n${p.instructions.trim()}`);
  lines.push("用 project 工具查看项目、把会话归到项目或移出。");
  return lines.join("\n");
}
