// 工作区跟着任务走（#38 第二阶段、#37）：逻辑上她是同一个 agent，活在哪具身体上做是协调层的事，不是她要操心的事。
//   - 每个会话（以及每个子 agent）记一个工作区 = {身体, 目录}。来源：她在某具身体上 git clone / git init、cd 到一个目录里工作时自动登记（auto），
//     或用 workspace 工具显式设定 / 查看 / 清除（agent），或对方在控制台设定（user）。
//   - 会话的工作区存在本机 SQLite 的 workspaces 表里，经网状层在身体之间复制（mesh/workspace.ts）：与会话、消息同样的检查（字段形状与长度、
//     修改时刻钳在「现在 + 5 分钟」以内、实时收到的只能是发来的那具身体写的、补齐时可以带别的身体的），按修改时刻后写胜，清除留墓碑（dir 为空）。
//     子 agent 的工作区（键 agent:<它的会话 id>）只在执行它的那具身体上，不复制。
//   - 协调层据此路由：对话进来时，工作区在另一具在线的身体上，就把这一轮放到那具身体上执行（mesh/presence.ts 的路由）；离线时在本机执行，系统提示如实写明。
//     这一轮在工作区之外的身体上进行时（工作区是这一轮中途换的），shell 与 shell_jobs 默认放到工作区所在的身体上、在工作区目录里执行
//     （经 body_call 同样的通道，闸门与审计照旧）；read_document、view_image 给相对路径或工作区里的路径时读那具身体上的文件。
//   - 工作区不进灵魂仓库：它是「这件事在哪台设备上做」，属于协调层，不是人格或记忆。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { db } from "../store.ts";
import { config, paths } from "../config.ts";
import { workDir, protectedPath } from "../sandbox.ts";
import { bodyUuid, BODY_UUID } from "../body/uuid.ts";
import { remoteBodies, bodiesHooks, multiBody } from "./bodies.ts";
import { check } from "../guard/guard.ts";
import { redactArgs } from "./secrets.ts";
import { localOverview, describeOverview, forgetOverview, type Overview } from "./repos.ts";
import { log } from "../log.ts";

export type Source = "auto" | "agent" | "user";
/** dir 为空：已清除（墓碑，复制时让别处也清掉）。author：写下这一条的身体。 */
export interface Workspace { key: string; body: string; uuid?: string | null; dir: string; changed: number; source: Source; author: string }

const BODY_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const SOURCES = new Set<Source>(["auto", "agent", "user"]);
const TS_MIN = Date.UTC(2020, 0, 1);

// ---------- 存储
let opened: unknown;
const table = () => {
  if (opened !== db) { db.exec("CREATE TABLE IF NOT EXISTS workspaces(key TEXT PRIMARY KEY, body TEXT, uuid TEXT, dir TEXT, changed INTEGER, source TEXT, author TEXT)"); opened = db; }
  return db;
};
const replicable = (key: string) => !key.startsWith("agent:");
const listeners = new Set<(rows: Workspace[]) => void>();
/** 本机改了会话的工作区（网状层据此实时复制给其他身体）。 */
export const onWorkspaceChange = (fn: (rows: Workspace[]) => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
const emit = (rows: Workspace[]) => { for (const fn of listeners) { try { fn(rows); } catch (e) { log("workspace", `复制工作区失败：${(e as Error).message}`); } } };

const rowOf = (key: string): Workspace | undefined => table().prepare("SELECT * FROM workspaces WHERE key=?").get(key) as Workspace | undefined;
/** 这个键（会话 id，或子 agent 的 agent:<会话 id>）的工作区；没有或已清除返回 undefined。 */
export function getWorkspace(key: string | undefined): Workspace | undefined {
  const r = key ? rowOf(key) : undefined;
  return r && r.dir ? r : undefined;
}
function put(w: Workspace) {
  table().prepare("INSERT OR REPLACE INTO workspaces(key,body,uuid,dir,changed,source,author) VALUES(?,?,?,?,?,?,?)").run(w.key, w.body, w.uuid ?? null, w.dir, w.changed, w.source, w.author);
}
/** 设定工作区（本机写的：作者是这具身体）。修改时刻严格晚于上一次，后写胜。 */
export function setWorkspace(key: string, w: { body: string; dir: string; uuid?: string; source: Source }): Workspace {
  const cur = rowOf(key);
  const row: Workspace = { key, body: w.body, uuid: w.uuid ?? uuidOf(w.body) ?? null, dir: w.dir, changed: Math.max(Date.now(), (cur?.changed ?? 0) + 1), source: w.source, author: config.body };
  put(row);
  if (replicable(key)) emit([row]);
  return row;
}
export function clearWorkspace(key: string): boolean {
  const cur = rowOf(key);
  if (!cur || !cur.dir) return false;
  const row: Workspace = { ...cur, dir: "", changed: Math.max(Date.now(), cur.changed + 1), author: config.body };
  put(row);
  if (replicable(key)) emit([row]);
  return true;
}
/** 会话的全部工作区（含墓碑），给刚连上的身体补齐。 */
export const allWorkspaces = (): Workspace[] => table().prepare("SELECT * FROM workspaces WHERE key NOT LIKE 'agent:%' ORDER BY changed DESC LIMIT 5000").all() as unknown as Workspace[];

const okDir = (d: unknown): d is string => typeof d === "string" && d.length <= 1000 && !/[\u0000-\u001f\u007f]/.test(d) && (d === "" || d.startsWith("/") || /^[A-Za-z]:[\\/]/.test(d));
/**
 * 写入别处来的工作区（from：发来的身体；catchUp：连上时的补齐）。逐字段检查，不合格的丢弃；实时收到的只能是发来的身体写的。
 * 修改时刻钳在「现在 + 5 分钟」以内（远在未来的时刻会让这一条永远改不动）；较新的修改胜，同一时刻按作者的名字定，保证各身体收敛到同一份。
 */
export function mergeWorkspaces(rows: unknown, o: { from: string; catchUp?: boolean }): { changed: Workspace[]; rejected: number } {
  const changed: Workspace[] = [];
  let rejected = 0;
  if (!Array.isArray(rows)) return { changed, rejected };
  const soon = Date.now() + 5 * 60_000;
  for (const r of rows.slice(0, 5000) as Record<string, unknown>[]) {
    const ok = r && typeof r === "object" && typeof r.key === "string" && r.key.length >= 1 && r.key.length <= 200 && replicable(r.key)
      && typeof r.body === "string" && BODY_RE.test(r.body) && typeof r.author === "string" && BODY_RE.test(r.author) && okDir(r.dir)
      && (r.uuid === undefined || r.uuid === null || (typeof r.uuid === "string" && BODY_UUID.test(r.uuid)))
      && typeof r.changed === "number" && Number.isFinite(r.changed) && r.changed >= TS_MIN && (o.catchUp || r.author === o.from);
    if (!ok) { rejected++; continue; }
    const w: Workspace = { key: r.key as string, body: r.body as string, uuid: (r.uuid as string | null | undefined) ?? null, dir: r.dir as string, changed: Math.min(r.changed as number, soon),
      source: SOURCES.has(r.source as Source) ? r.source as Source : "auto", author: r.author as string };
    const cur = rowOf(w.key);
    if (cur && !(w.changed > cur.changed || (w.changed === cur.changed && w.author > cur.author))) continue;
    if (cur && cur.body === w.body && cur.dir === w.dir && cur.changed === w.changed && cur.author === w.author) continue;
    put(w); changed.push(w);
  }
  return { changed, rejected };
}

// ---------- 网状层（mesh/workspace.ts 设置）：哪些身体在线、它们的工作区概况、在那边核对目录、在那边派子 agent
export interface WorkspaceMesh {
  online: (body: string) => boolean;
  overview: (body: string) => Overview | undefined;
  probe: (body: string, dir: string) => Promise<{ dir: string; exists: boolean }>;
  runAgent: (body: string, p: Record<string, unknown>) => Promise<{ id: string; name: string; dir?: string }>;
}
let net: WorkspaceMesh | undefined;
export const setWorkspaceMesh = (m: WorkspaceMesh | undefined) => { net = m; };
export const online = (body: string) => body === config.body || !!net?.online(body);
/** 身体的 uuid：本机的、在线身体登记的，或灵魂仓库登记的。 */
export function uuidOf(body: string): string | undefined {
  if (body === config.body) return bodyUuid();
  return remoteBodies().find((b) => b.body === body)?.uuid ?? bodiesHooks()?.registry?.().find((r) => r.body === body)?.uuid;
}

// ---------- 会话 → 键
type Turn = { origin: string; conv: string; id: string };
/** 一轮所属的工作区键：对话 → 会话 id；子 agent → agent:<它的会话 id>；醒来、做梦没有工作区。 */
export const keyOf = (s?: Turn): string | undefined => !s ? undefined : s.origin === "chat" && s.conv ? s.conv : s.origin === "agent" ? `agent:${s.id}` : undefined;
export const workspaceOf = (s?: Turn) => getWorkspace(keyOf(s));

const label = (w: Pick<Workspace, "body" | "dir" | "uuid">) => { const u = w.uuid ?? uuidOf(w.body); return `${w.body}${u ? `（body: ${u}）` : ""} 的 ${w.dir}`; };
/** child 就是 parent 或在它里面（两边的路径分隔符都认：路径可能来自另一种系统的身体）。 */
const within = (child: string, parent: string) => { const p = parent.replace(/[\\/]+$/, ""); return child === p || child.startsWith(p + "/") || child.startsWith(p + "\\"); };

// ---------- 自动登记：从命令看出她在哪个目录里做持久的工作
const VALUE_FLAGS = new Set(["-b", "--branch", "--depth", "-o", "--origin", "--template", "--reference", "--separate-git-dir", "-c", "--config", "--filter", "-j", "--jobs", "-u", "--upload-pack", "--shallow-since", "--shallow-exclude", "--object-format", "--initial-branch"]);
function words(seg: string): string[] {
  const out: string[] = [];
  for (const m of seg.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}
const expand = (p: string, at: string): string | undefined => {
  const t = p.replace(/^~(?=$|[\\/])/, os.homedir()).replace(/^\$HOME(?=$|[\\/])/, os.homedir()).replace(/^\$env:USERPROFILE(?=$|[\\/])/i, os.homedir());
  return /[$`*?]/.test(t) ? undefined : path.resolve(at, t);
};
/** 往上找到所在 git 仓库的根（找不到返回 undefined）。 */
function repoTop(dir: string): string | undefined {
  for (let d = dir, i = 0; i < 40; i++) { if (fs.existsSync(path.join(d, ".git"))) return d; const up = path.dirname(d); if (up === d) return undefined; d = up; }
  return undefined;
}
/**
 * 一条命令执行完以后，它让哪个目录成了工作的地方（在执行命令的那具身体上算）：git clone 出来的目录、git init 的目录、cd 进去的目录（在仓库里就取仓库的根）。
 * 只认真实存在的目录；工作目录本身、基座的家目录（含灵魂仓库）、临时目录、受保护的目录不算。看不出来返回 undefined。
 */
export function workdirHint(command: string, cwd: string): string | undefined {
  let at = cwd, hit: string | undefined;
  for (const seg of command.split(/&&|\|\||;|\n|\|/)) {
    const [w0, ...rest] = words(seg.trim());
    if (!w0) continue;
    if (/^(cd|pushd|set-location|sl|chdir)$/i.test(w0)) {
      const t = rest.find((x) => !x.startsWith("-"));
      const d = t && expand(t, at);
      if (d) { at = d; hit = d; }
    } else if (w0 === "git" && (rest[0] === "clone" || rest[0] === "init")) {
      const pos: string[] = [];
      for (let i = 1; i < rest.length; i++) { if (VALUE_FLAGS.has(rest[i])) { i++; continue; } if (rest[i].startsWith("-")) continue; pos.push(rest[i]); }
      const name = rest[0] === "clone" ? pos[1] ?? pos[0]?.replace(/[\\/]+$/, "").split(/[\\/:]/).pop()?.replace(/\.git$/, "") : pos[0] ?? ".";
      const d = name && expand(name, at);
      if (d) hit = d;
    }
  }
  if (!hit) return undefined;
  try { if (!fs.statSync(hit).isDirectory()) return undefined; } catch { return undefined; }
  const top = repoTop(hit) ?? hit;
  const tmp = (() => { try { return fs.realpathSync(os.tmpdir()); } catch { return os.tmpdir(); } })();
  const scratch = !within(top, workDir()) && (within(top, tmp) || within(top, os.tmpdir())); // 工作目录之外的临时目录：多半是一次性的
  if (top === workDir() || top === os.homedir() || top === path.parse(top).root || within(top, paths.home) || scratch || protectedPath(top)) return undefined;
  return top;
}

/**
 * 她在 body 上把 dir 当成了工作的地方：登记为这一轮的工作区。cd 进工作区里面的子目录不改；她或对方明确设定过的，只有新的 git clone / init 才改。
 */
export function noteWorkdir(s: Turn | undefined, body: string, dir: string, command = ""): Workspace | undefined {
  const key = keyOf(s);
  if (!key || !okDir(dir) || !dir) return undefined;
  const cur = getWorkspace(key), fresh = /\bgit\s+(clone|init)\b/.test(command); // 新克隆、新建的仓库：换到新项目（即使在原来的工作区里面）
  if (cur && cur.body === body && (cur.dir === dir || (!fresh && within(dir, cur.dir)))) return undefined;
  if (cur && cur.source !== "auto" && !fresh) return undefined;
  if (body === config.body) forgetOverview(); // 刚克隆了仓库：身体概况下次重新扫
  log("workspace", `会话 ${key.slice(0, 40)} 的工作区登记为 ${body}:${dir}`);
  return setWorkspace(key, { body, dir, source: "auto" });
}

/** 这具身体上可以用作工作目录的目录（绝对路径、存在、不是受保护的目录）；不行返回 undefined。 */
export function usableDir(dir: unknown): string | undefined {
  if (typeof dir !== "string" || !okDir(dir) || !dir || !path.isAbsolute(dir)) return undefined;
  try { if (!fs.statSync(dir).isDirectory()) return undefined; } catch { return undefined; }
  return protectedPath(dir) || within(dir, paths.home) ? undefined : dir;
}

// ---------- 路由
/** 这个会话的一轮该放到哪具别的身体上：绑定了工作区、工作区在另一具身体上、那具身体在线。 */
export function routeBody(conv: string): string | undefined {
  const w = getWorkspace(conv);
  return w && w.body !== config.body && net?.online(w.body) ? w.body : undefined;
}

/** shell 在这具身体上执行时的工作目录：别处调来时带的（cwd），或这一轮的工作区就在这具身体上。 */
export function localCwd(ctx: { session?: Turn; cwd?: string }): { cwd?: string; note: string } {
  const want = ctx.cwd ?? (() => { const w = workspaceOf(ctx.session); return w && w.body === config.body ? w.dir : undefined; })();
  if (!want) return { note: "" };
  const cwd = usableDir(want);
  return cwd ? { cwd, note: "" } : { note: `（工作区目录 ${want} 在 ${config.body} 上不存在或不能用，命令在 ${workDir()} 里执行）\n` };
}

export const ROUTED = new Set(["shell", "shell_jobs"]);
/**
 * shell / shell_jobs：这一轮的工作区在另一具身体上时，放到那具身体上、在工作区目录里执行（经 body_call 同样的通道：那边按自己的闸门、两边都记审计）。
 * 返回 undefined 表示照常在这里执行；note 是要加在结果前面的说明（工作区所在的身体不在线）。
 */
export async function routeTool(name: string, args: Record<string, unknown>, ctx: { session?: Turn & { signal?: AbortSignal }; cwd?: string; signal?: AbortSignal; pinned?: boolean }): Promise<{ text: string; status: "ok" | "error" | "denied" } | { note: string } | undefined> {
  if (!ROUTED.has(name) || ctx.cwd !== undefined || ctx.pinned || args.body !== undefined) return undefined; // 别处调来的、她明确指定了身体的：不再路由
  const w = workspaceOf(ctx.session);
  if (!w || w.body === config.body) return undefined;
  const h = bodiesHooks();
  if (!h || !net?.online(w.body)) return { note: `（工作区在 ${w.body} 上，它此刻不在线：这条命令在 ${config.body} 上执行）\n` };
  const reason = `工作区在 ${w.body}：${ctx.session?.origin ?? ""} ${ctx.session?.conv ?? ""}`.trim();
  if (!(await check("body", name, reason, { body: w.body, ...redactArgs(args) }, ctx.signal ?? ctx.session?.signal))) return { text: "这个动作没有被允许（闸门拒绝或急停中）", status: "denied" };
  const r = await h.call(w.body, name, args, reason, ctx.signal ?? ctx.session?.signal, { cwd: w.dir });
  if (r.workdir) noteWorkdir(ctx.session, w.body, r.workdir, String(args.command ?? ""));
  return { text: `（在工作区所在的 ${w.body} 上、${w.dir} 里执行）\n${r.text}`, status: r.status };
}

/**
 * read_document、view_image 的路径：这一轮有工作区时，相对路径从工作区目录算；工作区在另一具在线的身体上时，相对路径与工作区里的路径
 * 指那具身体上的文件（自动带上它的 body）。她自己带了 body 的不动。
 */
export function workspaceFiles(names: string[], args: Record<string, any>, s?: Turn): Record<string, any> {
  const w = workspaceOf(s);
  if (!w || args.body !== undefined) return args;
  const remote = w.body !== config.body;
  const sep = /^[A-Za-z]:\\/.test(w.dir) ? "\\" : "/";
  const abs = (p: string) => p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("~");
  const join = (p: string) => remote ? `${w.dir.replace(/[\\/]+$/, "")}${sep}${p.replace(/^\.[\\/]/, "")}` : path.resolve(w.dir, p);
  if (!remote && !usableDir(w.dir)) return args;
  if (remote) {
    const u = net?.online(w.body) ? remoteBodies().find((b) => b.body === w.body)?.uuid : undefined;
    if (!u) return args;
    const list = names.flatMap((n) => (Array.isArray(args[n]) ? args[n] : args[n] ? [args[n]] : []).map(String));
    if (!list.length || !list.every((p) => !abs(p) || within(p, w.dir))) return args; // 有指向工作区之外的绝对路径：照她写的在这里读
    const out: Record<string, any> = { ...args, body: u };
    for (const n of names) out[n] = Array.isArray(args[n]) ? args[n].map((p: unknown) => (abs(String(p)) ? String(p) : join(String(p)))) : args[n] && !abs(String(args[n])) ? join(String(args[n])) : args[n];
    return out;
  }
  const out: Record<string, any> = { ...args };
  for (const n of names) out[n] = Array.isArray(args[n]) ? args[n].map((p: unknown) => (abs(String(p)) ? p : join(String(p)))) : typeof args[n] === "string" && args[n] && !abs(args[n]) ? join(args[n]) : args[n];
  return out;
}

// ---------- 子 agent：在工作区所在的身体上执行
// 在别的身体上派出的子 agent，记录由执行它的那具身体写、经 agents 分区同步（mind/agents.ts）：agent_status / agent_message / agent_stop
// 按记录里它所在的身体转过去，续做与离线接管也按记录走（mind/continuity.ts）；这里不另记。

/** 子 agent 在哪里做：她给了 body（uuid）就是那具身体；没给就继承派出它的这一轮的工作区；都没有就在这里。dir 不给时同一具身体上继承工作区目录。 */
export function agentPlace(a: { body?: unknown; dir?: unknown }, s: Turn | undefined, resolve: (arg: unknown) => { local: true } | { remote: { body: string } } | { error: string }): { body: string; dir?: string; note: string } | string {
  const parent = workspaceOf(s);
  let body: string;
  if (a.body !== undefined && a.body !== "") {
    const t = resolve(a.body);
    if ("error" in t) return t.error;
    body = "local" in t ? config.body : t.remote.body;
  } else body = parent?.body ?? config.body;
  let dir = typeof a.dir === "string" && a.dir.trim() ? a.dir.trim() : parent?.body === body ? parent.dir : undefined;
  if (body !== config.body && !online(body)) {
    if (a.body !== undefined && a.body !== "") return `${body} 不在线`;
    return { body: config.body, note: `（工作区所在的 ${body} 此刻不在线，子 agent 在 ${config.body} 上执行）` };
  }
  if (body === config.body && dir) {
    const d = usableDir(path.resolve(workDir(), dir));
    if (!d) return `${config.body} 上没有可以用作工作区的目录 ${dir}`;
    dir = d;
  }
  return { body, dir, note: "" };
}
/** 给子 agent 的系统提示里的「工作区」一段。 */
export const agentWorkspaceText = (body: string, dir?: string) => dir ? `你的工作区在 ${label({ body, dir })}：shell 默认在这个目录下执行，相对路径从这里算。` : "";
/** 在本机派出的子 agent：记下它的工作区（只在这具身体上）。 */
export function bindAgent(s: Turn | undefined, dir?: string) { if (s && dir) setWorkspace(`agent:${s.id}`, { body: config.body, dir, source: "agent" }); }
/** 在另一具身体上派出子 agent（网状层的 agent.run）；那边回传的记录立即并入本机（mesh/workspace.ts），进展经在场转回来，报告送回派出它的会话。 */
export async function runAgentOn(body: string, p: Record<string, unknown>): Promise<{ id: string; name: string; dir?: string }> {
  if (!net) throw new Error(`${body} 不在线`);
  return net.runAgent(body, p);
}

// ---------- 给她看的
/** 系统提示「工作区」一节（key：会话 id；醒来没有）。 */
export function workspaceBlock(key: string | undefined): string {
  if (!key) return "";
  const w = getWorkspace(key);
  if (!w) return `## 工作区\n这个会话还没有绑定工作区。你在某具身体上 git clone、git init、cd 到一个目录里工作时，基座会自动把那里登记为这个会话的工作区；之后这个会话的每一轮都放在那具身体上执行，shell 默认在那个目录下运行。也可以用 workspace 工具设定、查看或清除。${multiBody() ? "做哪件事用哪具身体由基座安排，你不用自己换身体。" : ""}`;
  if (w.body === config.body) return `## 工作区\n这个会话的工作区在 ${label(w)}，你此刻就在这具身体上：shell 默认在这个目录下执行，read_document、view_image 的相对路径也从这里算。${usableDir(w.dir) ? "" : "（这个目录现在不存在或不能用，命令会在工作目录里执行。）"}换别的项目时 cd / git clone 到别处（基座会自动更新），或用 workspace 改。`;
  if (net?.online(w.body)) return `## 工作区\n这个会话的工作区在 ${label(w)}。这一轮在 ${config.body} 上进行，但 shell、shell_jobs 由基座放到 ${w.body} 上、在这个目录下执行（闸门与审计照旧）；read_document、view_image 给相对路径或这个目录里的路径时，读的是 ${w.body} 上的文件。你不用自己换身体，之后这个会话的每一轮都会直接在 ${w.body} 上进行。`;
  return `## 工作区\n这个会话的工作区在 ${label(w)}，但 ${w.body} 此刻不在线。这一轮在 ${config.body} 上执行：shell 在这里运行，${w.body} 上的文件此刻取不到。你可以告诉对方在等 ${w.body} 上线，或用 workspace 改工作区（例如在这里重新克隆）。`;
}
/** 「其他会话」里每个会话后面的一句。 */
export const workspaceNote = (conv: string) => { const w = getWorkspace(conv); return w ? `；工作区：${w.body} 的 ${w.dir}${online(w.body) ? "" : "（此刻不在线）"}` : ""; };
/** 系统提示「身体」一节后面：这具身体上的 git 仓库。 */
export const localReposText = () => { try { return `\n${describeOverview(localOverview())}`; } catch { return ""; } };
/** 「其他身体」一节里每具身体后面：那具身体上的 git 仓库（连上时取回，隔一会儿刷新）。 */
export const remoteReposText = (body: string) => { const o = net?.overview(body); return o ? `\n${describeOverview(o, "  ")}` : ""; };

// ---------- workspace 工具（mind/tools.ts 挂进工具表）
export async function workspaceTool(a: Record<string, unknown>, s: Turn | undefined, resolve: (arg: unknown) => { local: true } | { remote: { body: string } } | { error: string }): Promise<string> {
  const key = keyOf(s);
  const show = () => {
    const w = getWorkspace(key);
    const lines = [w ? `这个${key?.startsWith("agent:") ? "子 agent" : "会话"}的工作区：${label(w)}${online(w.body) ? "" : `（${w.body} 此刻不在线）`}（${w.source === "auto" ? "基座按你的命令自动登记" : w.source === "user" ? "对方设定" : "你设定"}）` : "还没有绑定工作区。",
      `${config.body}（这具身体）：`, describeOverview(localOverview(true), "  ")];
    for (const b of remoteBodies()) { const o = net?.overview(b.body); lines.push(`${b.body}：`, o ? describeOverview(o, "  ") : "  （还没有取到它的概况）"); }
    return lines.join("\n");
  };
  if (a.action === undefined || a.action === "show") return show();
  if (!key) throw new Error("醒来、做梦时没有会话，没有工作区；在对话里或子 agent 里才能设定");
  if (a.action === "clear") return clearWorkspace(key) ? "已清除这个会话的工作区：之后的每一轮由收到消息的身体执行，shell 在工作目录里运行。" : "这个会话本来就没有工作区。";
  if (a.action !== "set") throw new Error("action 只能是 show / set / clear");
  if (typeof a.dir !== "string" || !a.dir.trim()) throw new Error("set 要给 dir（目录；相对路径从那具身体的工作目录算）");
  const t = a.body === undefined || a.body === "" ? { local: true as const } : resolve(a.body);
  if ("error" in t) throw new Error(t.error);
  const w = await assign(key, "local" in t ? config.body : t.remote.body, a.dir.trim(), "agent");
  return w.body === config.body ? `好，这个会话的工作区设为 ${label(w)}。`
    : `好，这个会话的工作区设为 ${label(w)}。之后这个会话的每一轮都放在 ${w.body} 上执行；这一轮剩下的 shell 也会在那边、这个目录下执行。`;
}
/** 把 key 的工作区设为 body 上的 dir（相对路径从那具身体的工作目录算）：目录要在那具身体上存在、能用作工作区（另一具身体上的经 body.workspace 核对）。 */
async function assign(key: string, body: string, dir: string, source: Source): Promise<Workspace> {
  const bad = (d: string) => new Error(`${body} 上没有可以用作工作区的目录 ${d}（要已经存在；基座的家目录与密钥目录不行）`);
  if (body === config.body) {
    const d = usableDir(path.resolve(workDir(), dir));
    if (!d) throw bad(dir);
    return setWorkspace(key, { body, dir: d, source });
  }
  if (!net?.online(body)) throw new Error(`${body} 不在线`);
  const p = await net.probe(body, dir);
  if (!p.exists) throw bad(p.dir);
  return setWorkspace(key, { body, dir: p.dir, source });
}

/** 控制台（网关的 workspace 方法）：会话的工作区与各具身体的概况。 */
export function workspaceView(conv: string) {
  const bodies = [{ body: config.body, online: true, overview: localOverview() as Overview | undefined }, ...remoteBodies().map((b) => ({ body: b.body, online: true, overview: net?.overview(b.body) }))];
  const w = getWorkspace(conv);
  return { workspace: w ? { ...w, online: online(w.body) } : null, bodies };
}
/** 控制台设定（对方明确设定的，自动登记不覆盖，见 noteWorkdir）。body 为身体名，缺省为这具身体。 */
export const setByUser = (conv: string, body: string | undefined, dir: string) => assign(conv, body || config.body, dir, "user");

export const WORKSPACE_TOOL = {
  name: "workspace", permission: "session",
  description: "这个会话（或子 agent）的工作区：在哪具身体的哪个目录里做这件事。有了工作区，这个会话的每一轮由基座放到工作区所在的身体上执行，shell 默认在工作区目录下运行——你不用自己换身体。git clone、git init、cd 到一个目录里工作时基座会自动登记，一般不用手动设。action=show 查看工作区与各具身体上有哪些 git 仓库；set 设定（dir 必填，要已经存在；body 填那具身体的 uuid，不填为这具身体）；clear 清除。",
  parameters: { type: "object", properties: { action: { type: "string", enum: ["show", "set", "clear"] }, body: { type: "string", description: "set 用：工作区所在身体的 uuid（不填为这具身体）" }, dir: { type: "string", description: "set 用：目录（相对路径从那具身体的工作目录算）" } }, required: ["action"] },
};
