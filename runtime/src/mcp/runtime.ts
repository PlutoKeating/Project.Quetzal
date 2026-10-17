// MCP 来源的配置与生命周期。配置在这具身体的 QUETZAL_HOME/config/mcp.json（控制台「插件」页与插件安装都改它）：
//   - stdio：本机命令（绝对路径），缺省经沙箱启动，缺省仅本机；
//   - http / sse：远程 Streamable HTTP 或旧版 HTTP+SSE，只收 HTTPS（回环除外），可带 OAuth 2.1，缺省多端同步（不含令牌与凭据）。
// 每个来源启动前经闸门 mcp_start.<id>（缺省询问），工具调用另经 mcp.<id>.<工具>；改了配置即时启停，不必重启运行基座。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { config, paths, readSecret, writeSecret } from "../config.ts";
import { check, level } from "../guard/guard.ts";
import { wrapArgv } from "../sandbox.ts";
import { killTree } from "../platform.ts";
import { redactSecrets } from "../mind/secrets.ts";
import { audit } from "../store.ts";
import { log } from "../log.ts";
import { bus } from "../bus.ts";
import { McpSource, StdioSource, RemoteSource, isRemote, type McpServer, type StdioServer, type RemoteServer, type Launch, type McpInventory } from "./client.ts";
import { remoteUrl, mcpFetch } from "./net.ts";
import { Provider, beginLogin, completeLogin, forget, hasTokens, pendingLogins } from "./oauth.ts";

export type { StdioServer, RemoteServer, McpServer };
export const MAX_SOURCES = 32;
const MAX_FILE = 262_144;
const sources: McpSource[] = []; // 已连接、正在发布工具的
const owned = new Set<McpSource>(); // 这里启动的（含正在连接的），退出时关闭
const launching = new Set<string>();
let closing = false, started = false; // started：startMcp 调用过（安全模式不调用，之后的配置改动也不启动来源）
bus.on("state", () => { if (fs.existsSync(paths.stop)) for (const source of owned) source.cancelCalls(); });
export const validId = /^[a-z][a-z0-9_]{0,23}$/;
const envName = /^[A-Z_][A-Z0-9_]*$/;
const headerName = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,100}$/;
const secretRef = /^mcp_[a-zA-Z0-9_-]{1,100}$/;
const plain = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);

// ---------- 配置

function map(x: unknown, key: RegExp, val: (v: string) => boolean, what: string): Record<string, string> {
  if (x === undefined) return {};
  if (!plain(x) || Object.keys(x).length > 64) throw new Error(`MCP ${what}不合法`);
  for (const [k, v] of Object.entries(x)) if (!key.test(k) || typeof v !== "string" || v.length > 8192 || v.includes("\0") || /[\r\n]/.test(k) || !val(v)) throw new Error(`MCP ${what}不合法：${k}`);
  return { ...(x as Record<string, string>) };
}
const FORBIDDEN_HEADERS = new Set(["host", "content-length", "connection", "transfer-encoding", "mcp-session-id", "mcp-protocol-version"]);

/** 校验一个来源的配置。 */
export function parseServer(s: unknown): McpServer {
  if (!plain(s) || typeof s.id !== "string" || !validId.test(s.id)) throw new Error("MCP 来源 id 不合法（小写字母开头，最多 24 个小写字母、数字或下划线）");
  for (const key of ["enabled", "sandbox", "sync"]) if (s[key] !== undefined && typeof s[key] !== "boolean") throw new Error(`MCP ${key} 需为布尔值`);
  const timeoutMs = s.timeoutMs ?? 30_000, maxResultChars = s.maxResultChars ?? 12_000;
  if (!Number.isInteger(timeoutMs) || Number(timeoutMs) < 100 || Number(timeoutMs) > 300_000 || !Number.isInteger(maxResultChars) || Number(maxResultChars) < 100 || Number(maxResultChars) > 60_000) throw new Error("MCP 超时或结果上限不合法");
  const base = {
    id: s.id, enabled: s.enabled === true, timeoutMs: Number(timeoutMs), maxResultChars: Number(maxResultChars),
    ...(typeof s.title === "string" && s.title.trim() ? { title: s.title.trim().slice(0, 80) } : {}),
    ...(typeof s.plugin === "string" && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(s.plugin) ? { plugin: s.plugin } : {}),
    ...(typeof s.updated === "number" && Number.isFinite(s.updated) && s.updated > 0 ? { updated: s.updated } : {}),
  };
  if (s.transport === "http" || s.transport === "sse") {
    if (typeof s.url !== "string") throw new Error("远程 MCP 需要 url");
    const url = remoteUrl(s.url).toString();
    const headers = map(s.headers, headerName, () => true, "请求头");
    const headerSecrets = map(s.headerSecrets, headerName, (v) => secretRef.test(v), "请求头凭据引用");
    for (const k of [...Object.keys(headers), ...Object.keys(headerSecrets)]) if (FORBIDDEN_HEADERS.has(k.toLowerCase())) throw new Error(`MCP 请求头 ${k} 由协议管理，不能配置`);
    let oauth: RemoteServer["oauth"] = {};
    if (s.oauth === false) oauth = false;
    else if (s.oauth !== undefined) {
      if (!plain(s.oauth)) throw new Error("MCP oauth 需为对象或 false");
      const o = s.oauth;
      if ((o.clientId !== undefined && (typeof o.clientId !== "string" || !/^[\x21-\x7e]{1,200}$/.test(o.clientId))) || (o.scope !== undefined && (typeof o.scope !== "string" || !/^[\x20-\x7e]{0,500}$/.test(o.scope)))) throw new Error("MCP oauth 的 clientId / scope 不合法");
      oauth = { ...(o.clientId ? { clientId: o.clientId as string } : {}), ...(o.scope ? { scope: o.scope as string } : {}) };
    }
    return { ...base, transport: s.transport, url, headers, headerSecrets, oauth, sync: s.sync !== false };
  }
  if ((s.transport !== undefined && s.transport !== "stdio") || typeof s.command !== "string" || !path.isAbsolute(s.command) || s.command.includes("\0")) throw new Error("MCP 只支持 stdio（绝对路径 command）、http 与 sse");
  if (!Array.isArray(s.args) || s.args.length > 128 || s.args.some((a) => typeof a !== "string" || a.includes("\0") || a.length > 8192)) throw new Error("MCP args 需为有界字符串数组");
  if (s.cwd !== undefined && (typeof s.cwd !== "string" || !path.isAbsolute(s.cwd))) throw new Error("MCP cwd 需为绝对路径");
  return { ...base, transport: "stdio", command: s.command, args: s.args as string[], cwd: s.cwd as string | undefined,
    sandbox: s.sandbox !== false, env: map(s.env, envName, () => true, "环境变量"), secrets: map(s.secrets, envName, (v) => secretRef.test(v), "凭据引用"), sync: s.sync === true };
}

export function parseServers(value: unknown): McpServer[] {
  if (!plain(value) || !Array.isArray(value.servers) || value.servers.length > MAX_SOURCES) throw new Error(`MCP 配置需包含 servers 数组（最多 ${MAX_SOURCES} 项）`);
  const ids = new Set<string>();
  return value.servers.map((s: unknown) => {
    const server = parseServer(s);
    if (ids.has(server.id)) throw new Error("MCP 来源 id 重复");
    ids.add(server.id);
    return server;
  });
}

interface Tomb { id: string; updated: number }
const file = () => path.join(paths.config, "mcp.json");
let configError = "";
/** 读取配置；文件不合格时记下原因，当作没有来源（不覆盖原文件，等部署者修好）。 */
export function readServers(): { servers: McpServer[]; deleted: Tomb[] } {
  if (!fs.existsSync(file())) { configError = ""; return { servers: [], deleted: [] }; }
  try {
    if (fs.statSync(file()).size > MAX_FILE) throw new Error("MCP 配置文件过大");
    const raw = JSON.parse(fs.readFileSync(file(), "utf8"));
    const servers = parseServers(raw);
    const deleted = Array.isArray(raw.deleted) ? raw.deleted.filter((t: unknown): t is Tomb => plain(t) && typeof t.id === "string" && validId.test(t.id) && typeof t.updated === "number").slice(0, 200) : [];
    configError = "";
    return { servers, deleted };
  } catch (e) { configError = redactSecrets((e as Error).message); throw e; }
}
function writeServers(servers: McpServer[], deleted: Tomb[]) {
  if (servers.length > MAX_SOURCES) throw new Error(`最多 ${MAX_SOURCES} 个 MCP 来源`);
  fs.mkdirSync(paths.config, { recursive: true });
  const tmp = `${file()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ servers, deleted: deleted.slice(-200) }, null, 2));
  fs.renameSync(tmp, file());
}

// ---------- 启动

export async function launchFor(server: StdioServer): Promise<Launch> {
  const env: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "LANG", "TMPDIR", "TEMP", "SystemRoot", "WINDIR", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "PATHEXT"]) if (process.env[key]) env[key] = process.env[key]!;
  Object.assign(env, server.env);
  for (const [key, name] of Object.entries(server.secrets)) env[key] = secretValue(name);
  if (!server.sandbox) return { command: server.command, args: server.args, cwd: server.cwd, env };
  // Windows 的 wrapArgv 经宿主环境构造 PowerShell；首期不声称其 stdio 隔离经过验证。
  if (process.platform === "win32") throw new Error("Windows MCP 沙箱 stdio 尚未支持；仅可由部署者显式选择 sandbox:false 并批准启动");
  const wrapped = await wrapArgv(server.command, server.args, server.cwd, env);
  if (!config.sandbox.allowUnsandboxed && wrapped.cmd === server.command) throw new Error("MCP 未取得可用沙箱");
  return { command: wrapped.cmd, args: wrapped.args, cwd: wrapped.cwd, env };
}
/** 凭据引用：secrets/ 下 mcp_ 前缀的普通文件（不收符号链接）。 */
function secretValue(name: string): string {
  const f = path.join(paths.secrets, name);
  if (!secretRef.test(name) || fs.lstatSync(f).isSymbolicLink() || !fs.lstatSync(f).isFile()) throw new Error("MCP 凭据引用不是普通文件");
  const value = readSecret(name);
  if (!value) throw new Error("MCP 凭据引用为空");
  return value;
}
function remoteFor(server: RemoteServer): RemoteSource {
  const headers: Record<string, string> = { ...server.headers };
  for (const [k, name] of Object.entries(server.headerSecrets)) headers[k] = secretValue(name);
  return new RemoteSource(server, { headers, fetch: mcpFetch(new URL(server.url)), ...(server.oauth !== false ? { authProvider: new Provider(server) } : {}) }, redactSecrets);
}

type State = "off" | "starting" | "auth" | "online" | "error" | "denied";
const states = new Map<string, { state: State; error?: string; at: number }>();
const setState = (id: string, state: State, error?: string) => { states.set(id, { state, ...(error ? { error } : {}), at: Date.now() }); bus.emit("plugins.changed"); };
const unauthorized = (e: unknown) => { const x = e as { name?: string; code?: unknown; status?: number; message?: string }; return x?.name === "UnauthorizedError" || x?.status === 401 || /unauthori[sz]ed|401/i.test(String(x?.message ?? "")); };

async function startOne(server: McpServer): Promise<void> {
  if (closing || !started || launching.has(server.id) || [...owned].some((s) => s.server.id === server.id)) return;
  launching.add(server.id);
  let source: McpSource | undefined;
  try {
    setState(server.id, "starting");
    const what = isRemote(server) ? { id: server.id, url: server.url, transport: server.transport } : { id: server.id, command: server.command, sandbox: server.sandbox };
    if (!(await check(`mcp_start.${server.id}`, `启动 MCP ${server.id}`, server.plugin ? `插件 ${server.plugin} 的工具来源` : "部署者启用的工具来源", what))) { setState(server.id, "denied", "启动没有被允许"); return; }
    if (closing || fs.existsSync(paths.stop)) { setState(server.id, "off"); return; }
    source = isRemote(server) ? remoteFor(server) : new StdioSource(server, await launchFor(server), redactSecrets);
    if (closing || fs.existsSync(paths.stop)) { setState(server.id, "off"); return; }
    owned.add(source);
    await source.connect();
    if (closing || fs.existsSync(paths.stop)) { await source.close(); owned.delete(source); setState(server.id, "off"); return; }
    const s = source;
    s.onclose = () => { const i = sources.indexOf(s); if (i >= 0) sources.splice(i, 1); owned.delete(s); if (states.get(server.id)?.state === "online") setState(server.id, "error", "连接已断开"); };
    sources.push(s);
    setState(server.id, "online");
    const inv = s.contents();
    audit("system", "mcp.start", "", what, `ok: ${inv.tools.length} tools, ${inv.resources.length + inv.templates.length} resources, ${inv.prompts.length} prompts, protocol=${s.protocolVersion}`);
    log("mcp", `${server.id} 已连接（${inv.tools.length} 个工具、${inv.resources.length + inv.templates.length} 个资源、${inv.prompts.length} 个提示词，协议 ${s.protocolVersion}）`);
  } catch (e) {
    await source?.close().catch(() => {});
    if (source) owned.delete(source);
    const error = redactSecrets((e as Error).message);
    if (isRemote(server) && server.oauth !== false && unauthorized(e)) setState(server.id, "auth", "需要登录：在控制台「插件」页点登录，在浏览器里完成授权");
    else setState(server.id, "error", error.slice(0, 500));
    audit("system", "mcp.start", "", { id: server.id }, `error: ${error}`);
    log("mcp", `${server.id} 未连接：${error}`);
  } finally { launching.delete(server.id); }
}

async function stopOne(id: string) {
  for (const source of [...owned].filter((s) => s.server.id === id)) {
    const i = sources.indexOf(source);
    if (i >= 0) sources.splice(i, 1);
    source.onclose = undefined;
    const pid = source.pid;
    source.cancelCalls();
    if (pid) killTree(pid);
    await source.close().catch(() => {});
    owned.delete(source);
  }
}

/** 让运行中的来源与配置一致：删掉的、停用的、改过的关掉，启用而没在运行的启动（不等待审批）。 */
export async function reconcile(): Promise<void> {
  let servers: McpServer[];
  try { servers = readServers().servers; } catch (e) { log("mcp", `没有加载 MCP 配置：${redactSecrets((e as Error).message)}`); return; }
  for (const source of [...owned]) {
    const now = servers.find((s) => s.id === source.server.id);
    if (!now || !now.enabled || JSON.stringify({ ...now, updated: 0 }) !== JSON.stringify({ ...source.server, updated: 0 })) await stopOne(source.server.id);
  }
  for (const id of [...states.keys()]) if (!servers.some((s) => s.id === id && s.enabled)) states.delete(id);
  await Promise.all(servers.filter((s) => s.enabled).map((s) => startOne(s)));
}

export const mcpBindings = () => sources.flatMap((s) => s.list());
export async function callMcp(name: string, args: Record<string, unknown>, signal?: AbortSignal) {
  for (const source of sources) {
    const binding = source.list().find((t) => t.name === name);
    if (binding) return binding.kind === "tool" ? source.call(binding.remote, args, signal) : source.meta(binding.kind, args, signal);
  }
  throw new Error("MCP 工具来源已断开或不存在");
}

export async function startMcp(): Promise<void> {
  started = true;
  if (!fs.existsSync(file())) return;
  await reconcile();
}

export async function closeMcp() {
  closing = true;
  sources.splice(0);
  await Promise.all([...owned].map(async (source) => {
    const pid = source.pid;
    source.cancelCalls();
    if (pid) killTree(pid); // SDK spawn未detached；POSIX进程组不可用时只终止直接子进程
    await source.close().catch(() => {});
    owned.delete(source);
  }));
}
// 现有运维操作直接 process.exit；exit 回调不能 await SDK 清理，至少终止自有 server。
process.once("exit", () => { for (const s of owned) if (s.pid) killTree(s.pid); });

// ---------- 管理（控制台「插件」页、插件安装）

export interface SourceView {
  id: string; title: string; transport: "stdio" | "http" | "sse"; enabled: boolean; sync: boolean; plugin?: string;
  command?: string; args?: string[]; sandbox?: boolean; url?: string; oauth: boolean; loggedIn: boolean; loginPending: boolean;
  state: State; error?: string; protocol?: string; tools: number; resources: number; prompts: number; secrets: string[];
}
const view = (s: McpServer): SourceView => {
  const live = sources.find((x) => x.server.id === s.id);
  const st = s.enabled ? states.get(s.id) ?? { state: started ? "starting" as State : "off" as State } : { state: "off" as State };
  const inv = live?.contents();
  return {
    id: s.id, title: s.title ?? s.id, transport: isRemote(s) ? s.transport : "stdio", enabled: s.enabled, sync: s.sync === true, ...(s.plugin ? { plugin: s.plugin } : {}),
    ...(isRemote(s) ? { url: s.url } : { command: s.command, args: s.args, sandbox: s.sandbox }),
    oauth: isRemote(s) && s.oauth !== false, loggedIn: isRemote(s) && hasTokens(s.id), loginPending: pendingLogins().includes(s.id),
    state: st.state, ...("error" in st && st.error ? { error: st.error } : {}), ...(live?.protocolVersion ? { protocol: live.protocolVersion } : {}),
    tools: inv?.tools.length ?? 0, resources: (inv?.resources.length ?? 0) + (inv?.templates.length ?? 0), prompts: inv?.prompts.length ?? 0,
    secrets: Object.values(isRemote(s) ? s.headerSecrets : s.secrets).filter((n) => !readSecret(n)), // 引用了、但这具身体上还没有值的凭据
  };
};
export function listSources(): { sources: SourceView[]; error: string; max: number } {
  let servers: McpServer[] = [];
  try { servers = readServers().servers; } catch { /* configError 里有原因 */ }
  return { sources: servers.map(view), error: configError, max: MAX_SOURCES };
}
/** 详情：它提供的工具 / 资源 / 提示词，以及这具身体上的权限档位（启动、全部工具、每个工具；没单独设置的是继承来的）。 */
export function sourceDetail(id: string): (SourceView & { contents: McpInventory; permissions: { start: string; tools: string; perTool: { tool: string; name: string; level: string }[] } }) | null {
  const s = readServers().servers.find((x) => x.id === id);
  if (!s) return null;
  const live = sources.find((x) => x.server.id === id);
  const contents = live?.contents() ?? { tools: [], resources: [], templates: [], prompts: [] };
  const perTool = (live?.list() ?? []).map((b) => ({ tool: b.kind === "tool" ? b.remote : `（${b.remote}）`, name: b.name, level: level(`mcp.${id}.${b.name}`) }));
  return { ...view(s), contents, permissions: { start: level(`mcp_start.${id}`), tools: level(`mcp.${id}`), perTool } };
}
export const findServer = (id: string) => { try { return readServers().servers.find((s) => s.id === id); } catch { return undefined; } };
export const findRemote = (id: string) => { const s = findServer(id); return s && isRemote(s) ? s : undefined; };

/** 一个没被占用的来源 id（插件里的服务名不一定合规）。 */
export function freeId(want: string, taken: Set<string> = new Set(readServers().servers.map((s) => s.id))): string {
  let base = want.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^[^a-z]+/, "").replace(/_+$/, "").slice(0, 20) || "mcp";
  if (!/^[a-z]/.test(base)) base = `m${base}`.slice(0, 20);
  if (!taken.has(base)) return base;
  for (let i = 2; i < 1000; i++) if (!taken.has(`${base}_${i}`)) return `${base}_${i}`;
  return `mcp_${crypto.randomBytes(4).toString("hex")}`;
}

/** 写凭据值：secrets/mcp_<来源>_<名字>（0600），返回引用名。 */
export function storeSecret(id: string, key: string, value: string): string {
  if (!value || value.length > 8192 || /[\r\n\0]/.test(value)) throw new Error(`凭据 ${key} 不合法`);
  const name = `mcp_${id}_${key.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "secret"}`;
  writeSecret(name, value);
  return name;
}

/** 新增来源（控制台或插件安装）：secretValues 为要存进 secrets/ 的凭据（env 名或请求头名 → 值）。 */
export function addSource(raw: Record<string, unknown>, actor: string, secretValues: Record<string, string> = {}): SourceView {
  const { servers, deleted } = readServers();
  if (servers.length >= MAX_SOURCES) throw new Error(`最多 ${MAX_SOURCES} 个 MCP 来源`);
  const id = typeof raw.id === "string" && raw.id ? raw.id : freeId(String(raw.title ?? "mcp"), new Set(servers.map((s) => s.id)));
  if (servers.some((s) => s.id === id)) throw new Error(`已有来源 ${id}`);
  const remote = raw.transport === "http" || raw.transport === "sse";
  const refs: Record<string, string> = {};
  for (const [k, v] of Object.entries(secretValues)) if (v) refs[k] = storeSecret(id, k, v);
  const server = parseServer({ ...raw, id, updated: Date.now(),
    ...(remote ? { headerSecrets: { ...(plain(raw.headerSecrets) ? raw.headerSecrets : {}), ...refs } } : { secrets: { ...(plain(raw.secrets) ? raw.secrets : {}), ...refs } }) });
  writeServers([...servers, server], deleted.filter((t) => t.id !== id));
  audit(actor, "mcp.add", "", { id, transport: server.transport ?? "stdio", ...(isRemote(server) ? { url: server.url } : { command: server.command }), plugin: server.plugin }, "ok");
  changed(server.sync === true);
  return view(server);
}

/** 整个替换一个来源的配置（插件更新）：保留 OAuth 登录；新给的凭据覆盖，原来为它保存的凭据引用沿用。 */
export function replaceSource(id: string, raw: Record<string, unknown>, actor: string, secretValues: Record<string, string> = {}): SourceView {
  const { servers, deleted } = readServers();
  const i = servers.findIndex((s) => s.id === id);
  if (i < 0) throw new Error(`没有来源 ${id}`);
  const before = servers[i];
  const remote = raw.transport === "http" || raw.transport === "sse";
  const kept = Object.fromEntries(Object.entries(isRemote(before) ? before.headerSecrets : before.secrets).filter(([, n]) => n.startsWith(`mcp_${id}_`)));
  const refs: Record<string, string> = { ...kept };
  for (const [k, v] of Object.entries(secretValues)) if (v) refs[k] = storeSecret(id, k, v);
  const server = parseServer({ ...raw, id, sync: before.sync, updated: Date.now(), ...(remote ? { headerSecrets: refs } : { secrets: refs }) });
  servers[i] = server;
  writeServers(servers, deleted);
  audit(actor, "mcp.replace", "", { id, plugin: server.plugin }, "ok");
  changed(before.sync === true || server.sync === true);
  return view(server);
}

/** 改启用、同步方式。 */
export function updateSource(id: string, patch: { enabled?: boolean; sync?: boolean }, actor: string): SourceView {
  const { servers, deleted } = readServers();
  const i = servers.findIndex((s) => s.id === id);
  if (i < 0) throw new Error(`没有来源 ${id}`);
  const before = servers[i];
  const next = { ...before, ...(typeof patch.enabled === "boolean" ? { enabled: patch.enabled } : {}), ...(typeof patch.sync === "boolean" ? { sync: patch.sync } : {}), updated: Date.now() } as McpServer;
  servers[i] = next;
  writeServers(servers, deleted);
  audit(actor, "mcp.update", "", { id, ...patch }, "ok");
  changed(before.sync === true || next.sync === true); // 改成仅本机时也要告诉其他身体（它们删掉副本）
  return view(next);
}

/** 删除来源：连同 OAuth 令牌与为它保存的凭据（secrets/mcp_<来源>_*）。多端同步的留下删除记录，其他身体一起删。 */
export function removeSource(id: string, actor: string): boolean {
  const { servers, deleted } = readServers();
  const s = servers.find((x) => x.id === id);
  if (!s) return false;
  writeServers(servers.filter((x) => x.id !== id), s.sync ? [...deleted.filter((t) => t.id !== id), { id, updated: Date.now() }] : deleted);
  forgetLocal(s);
  audit(actor, "mcp.remove", "", { id }, "ok");
  changed(s.sync === true);
  return true;
}
function forgetLocal(s: McpServer) {
  forget(s.id);
  for (const name of Object.values(isRemote(s) ? s.headerSecrets : s.secrets)) if (name.startsWith(`mcp_${s.id}_`)) try { fs.rmSync(path.join(paths.secrets, name), { force: true }); } catch {}
}
const changed = (sync: boolean) => { if (sync) bus.emit("mcp.changed"); bus.emit("plugins.changed"); void reconcile(); };

/** 重新连接一个来源（登录之后、出错之后）。 */
export async function restartSource(id: string): Promise<SourceView> {
  const s = findServer(id);
  if (!s) throw new Error(`没有来源 ${id}`);
  await stopOne(id);
  states.delete(id);
  if (s.enabled) void startOne(s);
  return view(s);
}

/** OAuth：开始登录，返回要在浏览器里打开的地址（已登录则 authorized 为真并重新连接）。 */
export async function login(id: string, actor: string): Promise<{ url?: string; authorized?: boolean }> {
  const s = findRemote(id);
  if (!s) throw new Error(`没有远程来源 ${id}`);
  if (s.oauth === false) throw new Error(`${id} 没有启用 OAuth`);
  const url = await beginLogin(s, mcpFetch(new URL(s.url)));
  audit(actor, "mcp.login", "", { id }, url ? "redirect" : "authorized");
  bus.emit("plugins.changed");
  if (!url) { await restartSource(id); return { authorized: true }; }
  return { url };
}
/** 回调：网关的 /mcp/oauth/callback，或控制台粘贴回来的地址里的查询参数。 */
export async function finishLogin(params: URLSearchParams, actor: string): Promise<string> {
  const id = await completeLogin(params, findRemote, (s) => mcpFetch(new URL(s.url)));
  audit(actor, "mcp.login", "", { id }, "ok");
  await restartSource(id);
  return id;
}
export async function logout(id: string, actor: string) {
  const s = findRemote(id);
  if (!s) throw new Error(`没有远程来源 ${id}`);
  forget(id);
  audit(actor, "mcp.logout", "", { id }, "ok");
  await restartSource(id);
  return view(s);
}

// ---------- 多端同步（mesh/shared.ts 的 mcp 分区）：同保密库的做法，按条目、较新的修改生效；令牌与凭据值从不同步

export interface McpRecord { id: string; updated: number; sync?: boolean; deleted?: boolean; server?: Record<string, unknown> }
export function exportMcp(): McpRecord[] {
  let r: { servers: McpServer[]; deleted: Tomb[] };
  try { r = readServers(); } catch { return []; }
  const out: McpRecord[] = r.deleted.map((t) => ({ id: t.id, updated: t.updated, deleted: true }));
  for (const s of r.servers) {
    const updated = s.updated ?? 0;
    if (!s.sync) { out.push({ id: s.id, updated, sync: false }); continue; }
    const { updated: _u, ...server } = s;
    out.push({ id: s.id, updated, sync: true, server: server as unknown as Record<string, unknown> });
  }
  return out.slice(0, 200);
}

/** 采用别处的：逐条校验，比本机较新的才采用；本机的「仅本机」来源不被别处同名的覆盖。返回是否有变化。 */
export function mergeMcp(list: unknown): boolean {
  if (!Array.isArray(list)) return false;
  let r: { servers: McpServer[]; deleted: Tomb[] };
  try { r = readServers(); } catch { return false; } // 本机配置坏了：不动它
  const limit = Date.now() + 5 * 60_000;
  let changedAny = false;
  for (const x of list.slice(0, 200) as McpRecord[]) {
    if (!plain(x) || typeof x.id !== "string" || !validId.test(x.id) || typeof x.updated !== "number" || !Number.isFinite(x.updated) || x.updated > limit) continue;
    const i = r.servers.findIndex((s) => s.id === x.id);
    const local = i >= 0 ? r.servers[i] : undefined;
    const tomb = r.deleted.find((t) => t.id === x.id);
    if (x.updated <= Math.max(local?.updated ?? 0, tomb?.updated ?? 0)) continue;
    if (local && !local.sync) continue; // 本机的仅本机来源：不受别处同名来源影响
    if (x.deleted || x.sync === false) {
      if (!local) continue;
      r.servers.splice(i, 1);
      forgetLocal(local);
      if (x.deleted) r.deleted = [...r.deleted.filter((t) => t.id !== x.id), { id: x.id, updated: x.updated }];
      changedAny = true;
      continue;
    }
    let server: McpServer;
    try { server = parseServer({ ...x.server, id: x.id, updated: x.updated, sync: true }); } catch (e) { log("mcp", `别处同步来的来源 ${x.id} 不合格，没有采用：${(e as Error).message}`); continue; }
    if (i >= 0) r.servers[i] = server;
    else { if (r.servers.length >= MAX_SOURCES) continue; r.servers.push(server); }
    r.deleted = r.deleted.filter((t) => t.id !== x.id);
    changedAny = true;
  }
  if (changedAny) { writeServers(r.servers, r.deleted); bus.emit("plugins.changed"); void reconcile(); }
  return changedAny;
}
