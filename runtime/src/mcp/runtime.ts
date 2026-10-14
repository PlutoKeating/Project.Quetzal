// 配置只来自这具身体的 QUETZAL_HOME/config/mcp.json；不随灵魂或 mesh 同步。
import fs from "node:fs";
import path from "node:path";
import { config, paths, readSecret } from "../config.ts";
import { check } from "../guard/guard.ts";
import { wrapArgv } from "../sandbox.ts";
import { killTree } from "../platform.ts";
import { redactSecrets } from "../mind/secrets.ts";
import { audit } from "../store.ts";
import { log } from "../log.ts";
import { bus } from "../bus.ts";
import { StdioSource, type StdioServer, type Launch } from "./client.ts";

const sources: StdioSource[] = [];
const owned = new Set<StdioSource>();
const launching = new Set<string>();
let closing = false;
bus.on("state", () => { if (fs.existsSync(paths.stop)) for (const source of owned) source.cancelCalls(); });
const validId = /^[a-z][a-z0-9_]{0,23}$/;
const envName = /^[A-Z_][A-Z0-9_]*$/;
const plain = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);

export function parseServers(value: unknown): StdioServer[] {
  if (!plain(value) || !Array.isArray(value.servers) || value.servers.length > 16) throw new Error("MCP 配置需包含 servers 数组（最多 16 项）");
  const ids = new Set<string>();
  return value.servers.map((s: unknown) => {
    if (!plain(s) || typeof s.id !== "string" || !validId.test(s.id) || ids.has(s.id)) throw new Error("MCP 来源 id 不合法或重复");
    ids.add(s.id);
    if (s.transport !== "stdio" || typeof s.command !== "string" || !path.isAbsolute(s.command) || s.command.includes("\0")) throw new Error("MCP 首期只支持 stdio 和绝对路径 command");
    if (!Array.isArray(s.args) || s.args.length > 128 || s.args.some((a) => typeof a !== "string" || a.includes("\0") || a.length > 8192)) throw new Error("MCP args 需为有界字符串数组");
    if (s.cwd !== undefined && (typeof s.cwd !== "string" || !path.isAbsolute(s.cwd))) throw new Error("MCP cwd 需为绝对路径");
    for (const key of ["enabled", "sandbox"]) if (s[key] !== undefined && typeof s[key] !== "boolean") throw new Error(`MCP ${key} 需为布尔值`);
    const env = (x: unknown, secrets: boolean): Record<string, string> => {
      if (x === undefined) return {};
      if (!plain(x) || Object.keys(x).length > 64) throw new Error("MCP 环境配置不合法");
      for (const [k, v] of Object.entries(x)) if (!envName.test(k) || typeof v !== "string" || v.length > 8192 || v.includes("\0") || (secrets && !/^mcp_[a-zA-Z0-9_-]{1,100}$/.test(v))) throw new Error("MCP 环境变量或凭据引用不合法");
      return x as Record<string, string>;
    };
    const timeoutMs = s.timeoutMs ?? 30_000, maxResultChars = s.maxResultChars ?? 12_000;
    if (!Number.isInteger(timeoutMs) || Number(timeoutMs) < 100 || Number(timeoutMs) > 300_000 || !Number.isInteger(maxResultChars) || Number(maxResultChars) < 100 || Number(maxResultChars) > 60_000) throw new Error("MCP 超时或结果上限不合法");
    return { id: s.id, enabled: s.enabled === true, command: s.command, args: s.args as string[], cwd: s.cwd as string | undefined,
      sandbox: s.sandbox !== false, env: env(s.env, false), secrets: env(s.secrets, true), timeoutMs: Number(timeoutMs), maxResultChars: Number(maxResultChars) };
  });
}

export async function launchFor(server: StdioServer): Promise<Launch> {
  const env: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "LANG", "TMPDIR", "TEMP", "SystemRoot", "WINDIR", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "PATHEXT"]) if (process.env[key]) env[key] = process.env[key]!;
  Object.assign(env, server.env);
  for (const [key, name] of Object.entries(server.secrets)) {
    const file = path.join(paths.secrets, name);
    if (fs.lstatSync(file).isSymbolicLink() || !fs.lstatSync(file).isFile()) throw new Error("MCP 凭据引用不是普通文件");
    const value = readSecret(name);
    if (!value) throw new Error("MCP 凭据引用为空");
    env[key] = value;
  }
  if (!server.sandbox) return { command: server.command, args: server.args, cwd: server.cwd, env };
  // Windows 的 wrapArgv 经宿主环境构造 PowerShell；首期不声称其 stdio 隔离经过验证。
  if (process.platform === "win32") throw new Error("Windows MCP 沙箱 stdio 尚未支持；仅可由部署者显式选择 sandbox:false 并批准启动");
  const wrapped = await wrapArgv(server.command, server.args, server.cwd, env);
  if (!config.sandbox.allowUnsandboxed && wrapped.cmd === server.command) throw new Error("MCP 未取得可用沙箱");
  return { command: wrapped.cmd, args: wrapped.args, cwd: wrapped.cwd, env };
}

export const mcpBindings = () => sources.flatMap((s) => s.list());
export async function callMcp(name: string, args: Record<string, unknown>, signal?: AbortSignal) {
  for (const source of sources) {
    const binding = source.list().find((t) => t.name === name);
    if (binding) return source.call(binding.remote, args, signal);
  }
  throw new Error("MCP 工具来源已断开或不存在");
}

export async function startMcp(): Promise<void> {
  const file = path.join(paths.config, "mcp.json");
  if (!fs.existsSync(file)) return;
  try {
    if (fs.statSync(file).size > 131_072) throw new Error("MCP 配置文件过大");
    const servers = parseServers(JSON.parse(fs.readFileSync(file, "utf8")));
    await Promise.all(servers.filter((s) => s.enabled).map(async (server) => {
      if (closing || launching.has(server.id) || [...owned].some((s) => s.server.id === server.id)) return;
      launching.add(server.id);
      let source: StdioSource | undefined;
      try {
        if (!(await check(`mcp_start.${server.id}`, `启动 MCP ${server.id}`, "部署者启用的工具来源", { id: server.id, command: server.command, sandbox: server.sandbox }))) return;
        if (closing || fs.existsSync(paths.stop)) return;
        source = new StdioSource(server, await launchFor(server), redactSecrets);
        if (closing || fs.existsSync(paths.stop)) return;
        owned.add(source);
        await source.connect();
        if (closing || fs.existsSync(paths.stop)) { await source.close(); owned.delete(source); return; }
        sources.push(source);
        audit("system", "mcp.start", "", { id: server.id, sandbox: server.sandbox }, `ok: ${source.list().length} tools, protocol=${source.protocolVersion}`);
        log("mcp", `${server.id} 已连接（${source.list().length} 个工具，协议 ${source.protocolVersion}）`);
      } catch (e) {
        await source?.close().catch(() => {});
        if (source) owned.delete(source);
        const error = redactSecrets((e as Error).message);
        audit("system", "mcp.start", "", { id: server.id }, `error: ${error}`);
        log("mcp", `${server.id} 未连接：${error}`);
      } finally { launching.delete(server.id); }
    }));
  } catch (e) { log("mcp", `没有加载 MCP 配置：${redactSecrets((e as Error).message)}`); }
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
