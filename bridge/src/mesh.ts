// 灵魂桥作为只读成员接入多具身体的网状层（DISTRIBUTED.md B4）：
//   - 用同步服务绑定（kind 为 bridge），节点公钥经身体登记写进灵魂仓库（bodies/<身体>.json 的 meshKey）；
//   - 守护进程连上同一个 agent 在线的运行基座，定期取近况（此刻在哪具身体上做什么、最近的会话与最后几句），写进 ~/.agent-soul/<agent>/now.md；
//   - 只读：运行基座只允许它调用 presence.digest，它发出的事件对方一律丢弃；它不被调度、不选协调者，也不提供任何方法。
// 网状层的组件（node-datachannel 原生模块与 ws）按运行基座的锁定文件下载并核对 sha512，装在 ~/.agent-soul/mesh-modules/<版本>/。
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { ROOT, dirOf, repoDir } from "./config.ts";
import { loadNodeKey, fingerprint, isNodeKey, type NodeKey } from "../../runtime/src/mesh/identity.ts";
import type { Binding, BindStart } from "../../runtime/src/mesh/directory.ts";
import type { BridgeConfig } from "./types.ts";

const RUNTIME = fileURLToPath(new URL("../../runtime/", import.meta.url));
const LOCK = path.join(RUNTIME, "tool", "mesh-modules.lock.json");
const INSTALLER = path.join(RUNTIME, "tool", "install-mesh-modules.mjs");
const DIGEST_EVERY_MS = 60_000;
// 同步服务客户端依赖 ws（网状层组件之一）：用到时才加载，没装组件时其他命令照常可用
const directory = async () => { if (!modulesReady()) throw new Error("缺少网状层组件：先运行 mesh install"); return import("../../runtime/src/mesh/directory.ts"); };

export const nodeKeyPath = (agent: string) => path.join(dirOf(agent), "mesh_ed25519");
const bindingPath = (agent: string) => path.join(dirOf(agent), "sync.json");
export const nowPath = (agent: string) => path.join(dirOf(agent), "now.md");

/** 这个 agent 的节点密钥（第一次用到时生成，0600）。 */
export const nodeKey = (agent: string): NodeKey => loadNodeKey(nodeKeyPath(agent));
/** 已有节点密钥时的公钥（写进身体登记）；还没绑定过网状层则 undefined，不平白生成。 */
export function meshKeyIfAny(agent: string): string | undefined {
  return fs.existsSync(nodeKeyPath(agent)) ? nodeKey(agent).nodeKey : undefined;
}

export function readBinding(agent: string): Binding | undefined {
  try { const b = JSON.parse(fs.readFileSync(bindingPath(agent), "utf8")) as Binding; return b.token && b.server ? b : undefined; } catch { return undefined; }
}

// ---------- 组件
/** 这台机器对应的原生包平台：linux-<x64|arm64>-<gnu|musl>；不支持的返回 undefined。 */
function platform(): string | undefined {
  if (process.platform !== "linux" || !["x64", "arm64"].includes(process.arch)) return undefined;
  const glibc = (process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined)?.header?.glibcVersionRuntime;
  return `linux-${process.arch}-${glibc ? "gnu" : "musl"}`;
}
const modulesDir = () => path.join(ROOT, "mesh-modules", JSON.parse(fs.readFileSync(LOCK, "utf8")).common["node-datachannel"].version);
const runtimeModules = () => path.join(RUNTIME, "node_modules");
const resolveFromRuntime = (name: string) => createRequire(path.join(RUNTIME, "src", "mesh", "mesh.ts")).resolve(name);
export function modulesReady(): boolean {
  try { resolveFromRuntime("node-datachannel"); resolveFromRuntime("ws"); return true; } catch { return false; }
}

/** 下载并核对网状层组件，让程序目录里的运行基座源代码能找到它们（runtime/node_modules 指向共享目录；开发用的检出已有 node_modules 时不动）。 */
export async function installModules(say: (s: string) => void): Promise<boolean> {
  if (modulesReady()) return true;
  const plat = platform();
  if (!plat) { say(`这台机器（${process.platform}-${process.arch}）没有网状层组件的预编译包：灵魂桥只经灵魂仓库同步，看不到其他身体的近况`); return false; }
  const shared = modulesDir();
  if (!fs.existsSync(path.join(shared, "node_modules", "ws", "package.json"))) {
    say("下载多具身体直连的组件（约 4 MB，逐个核对校验值）…");
    fs.mkdirSync(shared, { recursive: true });
    const code = await new Promise<number>((resolve) => {
      const p = spawn(process.execPath, [INSTALLER, "--extra=bridge", LOCK, shared, plat, "https://registry.npmjs.org", "https://registry.npmmirror.com"], { stdio: ["ignore", "ignore", "pipe"] });
      let err = ""; p.stderr.on("data", (d) => (err += d));
      p.on("close", (c) => { if (c) say(`组件没有装上：${err.trim().split("\n").pop()}`); resolve(c ?? 1); });
    });
    if (code !== 0) return false;
  }
  const link = runtimeModules();
  if (!fs.existsSync(link)) { fs.rmSync(link, { force: true }); fs.symlinkSync(path.relative(RUNTIME, path.join(shared, "node_modules")), link); }
  return modulesReady();
}

// ---------- 绑定
/** 开始绑定：返回给人看的短码与链接，以及等待批准的 Promise（批准后保存令牌）。 */
export async function bind(c: BridgeConfig, server: string, version: string): Promise<{ start: BindStart; done: Promise<Binding> }> {
  const { startBinding, pollBinding, serverOrigin } = await directory();
  const origin = serverOrigin(server);
  let id: { id?: string; displayName?: string } = {};
  try { id = JSON.parse(fs.readFileSync(path.join(repoDir(c.agent), "agent.json"), "utf8")); } catch {}
  if (!id.id) throw new Error("灵魂仓库里还没有 agent.json：先完成 init 与第一次同步");
  const start = await startBinding(origin, { agent: { id: id.id, name: id.displayName ?? c.agent }, body: c.body, kind: "bridge", nodeKey: nodeKey(c.agent).nodeKey, version });
  const done = pollBinding(origin, start, AbortSignal.timeout(start.expires_in * 1000)).then((b) => {
    fs.writeFileSync(bindingPath(c.agent), JSON.stringify(b, null, 2), { mode: 0o600 });
    return b;
  });
  return { start, done };
}

export async function unbindMesh(agent: string) {
  const b = readBinding(agent);
  if (b) await directory().then((d) => d.unbind(b)).catch(() => {});
  fs.rmSync(bindingPath(agent), { force: true });
  fs.rmSync(nowPath(agent), { force: true });
}

export function meshStatus(c: BridgeConfig) {
  const b = readBinding(c.agent), key = meshKeyIfAny(c.agent);
  let now = "";
  try { now = fs.readFileSync(nowPath(c.agent), "utf8"); } catch {}
  return { bound: !!b, server: b?.server ?? "", account: b?.account ?? "", fingerprint: key ? fingerprint(key) : "", modules: modulesReady(), now };
}

// ---------- 守护：连上运行基座，定期取近况
interface Digest {
  body: string; at: number;
  live: { body: string; conv: string; origin: string; channel: string; started: number; status: string; text: string }[];
  sessions: { id: string; title: string; channel: string; updated: number; last: string }[];
  recent: { ts: number; role: string; body: string | null; text: string }[];
}

const time = (ms: number) => new Date(ms).toLocaleString("zh-CN", { hour12: false });

/** 把近况写成给 agent 看的 Markdown。 */
export function renderNow(d: Digest | undefined, peers: string[], me: string): string {
  const out = [`# 此刻：我的其他身体`, "", `（由灵魂桥自动更新，${time(Date.now())}；这具身体 ${me} 是只读成员，只能看，不能在别的身体上做事）`, ""];
  if (!d) return [...out, peers.length ? "连上了其他身体，还没取到近况。" : "现在没有连上任何运行基座（它们可能都不在线）。"].join("\n") + "\n";
  out.push(`连着的身体：${peers.join("、")}（近况取自 ${d.body}）`, "");
  out.push("## 正在进行", "");
  if (!d.live.length) out.push("没有正在进行的事。");
  const doing: Record<string, string> = { think: "自己醒来思考", dream: "做梦", agent: "一个子 agent 在工作" };
  for (const t of d.live) out.push(`- 在 ${t.body} 上${t.origin === "chat" ? `和人说话（${t.channel}）` : doing[t.origin] ?? t.origin}，${t.status === "queued" ? "排队中" : "进行中"}，${time(t.started)} 开始：${t.text}`);
  out.push("", "## 最近的会话", "");
  for (const s of d.sessions) out.push(`- ${s.title || "（无标题）"}（${s.channel}，${time(s.updated)}）：${s.last}`);
  if (d.recent.length) {
    out.push("", `## 最近一个会话的最后几句（${d.sessions[0]?.title ?? ""}）`, "");
    for (const m of d.recent) out.push(`- ${time(m.ts)} ${m.role === "user" ? "对方" : m.role === "agent" ? `我${m.body ? `（在 ${m.body}）` : ""}` : "环境的声音"}：${m.text.replace(/\n+/g, " ")}`);
  }
  return out.join("\n") + "\n";
}

/** 在守护进程里运行：已绑定且组件可用时连上网状层，返回停止函数；否则返回 undefined 并说明原因。 */
export async function startMesh(c: BridgeConfig, version: string, log: (m: string) => void, refreshKeys: () => Promise<unknown>): Promise<(() => void) | undefined> {
  const b = readBinding(c.agent);
  if (!b) return undefined;
  if (!modulesReady()) { log("已绑定同步服务，但缺少网状层组件：运行 mesh install 补上"); return undefined; }
  const ndcMod: any = await import(pathToFileURL(resolveFromRuntime("node-datachannel")).href);
  const { Mesh } = await import("../../runtime/src/mesh/mesh.ts"); // 依赖 ws：组件就绪后才加载
  const soulBody = (body: string): Record<string, unknown> | undefined => {
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(body)) return undefined;
    try { return JSON.parse(fs.readFileSync(path.join(repoDir(c.agent), "bodies", `${body}.json`), "utf8")); } catch { return undefined; }
  };
  let agentName = c.agent;
  try { agentName = JSON.parse(fs.readFileSync(path.join(repoDir(c.agent), "agent.json"), "utf8")).displayName ?? c.agent; } catch {}
  const mesh = new Mesh({
    me: c.body, key: nodeKey(c.agent), ndc: ndcMod.default ?? ndcMod, binding: b, reader: true,
    keyOf: (body) => { const k = soulBody(body)?.meshKey; return isNodeKey(k) ? k : undefined; },
    kindOf: (body) => { const k = soulBody(body)?.kind; return typeof k === "string" ? k : undefined; },
    refreshKeys, hello: () => ({ version, agentName }), log, warn: (w) => log(`网状层：${w}`),
  });
  let last: Digest | undefined;
  const refresh = async () => {
    const peers = mesh.connected();
    last = undefined;
    for (const p of peers) {
      try { last = await mesh.request<Digest>(p, "presence.digest", {}, 15_000); break; } catch (e) { log(`从 ${p} 取近况失败：${(e as Error).message}`); }
    }
    fs.writeFileSync(nowPath(c.agent), renderNow(last, peers, c.body));
  };
  mesh.on("peer", (s: { link: string }) => { if (s.link === "open" || s.link === "closed") void refresh(); });
  const timer = setInterval(() => void refresh(), DIGEST_EVERY_MS);
  mesh.start();
  void refresh();
  log(`网状层：以只读成员接入（${b.server}，账户 ${b.account}）`);
  return () => { clearInterval(timer); mesh.stop(); };
}
