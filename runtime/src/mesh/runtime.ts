// 运行基座一侧的网状层：把 Mesh 绑定到运行时配置（同步服务地址、绑定令牌、节点密钥、灵魂仓库里登记的公钥）。
// node-datachannel 是可选依赖（原生模块）：加载不了时网状层关闭，身体之间退回只用 git 同步，状态里说明原因。
import fs from "node:fs";
import path from "node:path";
import { config, paths, saveConfig } from "../config.ts";
import { log } from "../log.ts";
import { bus } from "../bus.ts";
import { addTimeline } from "../store.ts";
import { identity } from "../memory/identity.ts";
import { VERSION } from "../version.ts";
import { loadNodeKey, fingerprint, isNodeKey, type NodeKey } from "./identity.ts";
import { Mesh } from "./mesh.ts";
import { startBinding, pollBinding, unbind as unbindRemote, serverOrigin, type Binding } from "./directory.ts";
import type { Ndc } from "./link.ts";

const BINDING = () => path.join(paths.secrets, "sync.json");
let key: NodeKey | undefined;
/** 这具身体的节点密钥（第一次用到时生成）。公钥写进灵魂仓库的身体登记。 */
export function nodeKey(): NodeKey { return (key ??= loadNodeKey(path.join(paths.secrets, "mesh_ed25519"))); }

let ndc: Ndc | undefined;
let ndcError = "";
async function loadNdc(): Promise<Ndc | undefined> {
  if (ndc || ndcError) return ndc;
  try { const m: any = await import("node-datachannel"); ndc = (m.default ?? m) as Ndc; }
  catch (e) { ndcError = `这具身体缺少网状层的原生组件 node-datachannel（${(e as Error).message.split("\n")[0]}）：重新运行安装即可补上；在此之前只用 git 同步`; log("mesh", ndcError); }
  return ndc;
}

function readBinding(): Binding | undefined {
  try { const b = JSON.parse(fs.readFileSync(BINDING(), "utf8")) as Binding; return b.token && b.server ? b : undefined; } catch { return undefined; }
}

/** 灵魂仓库里登记的某具身体的节点公钥（信任根）。 */
export function soulKeyOf(body: string): string | undefined {
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(body)) return undefined;
  try { const k = JSON.parse(fs.readFileSync(path.join(paths.soul, "bodies", `${body}.json`), "utf8")).meshKey; return isNodeKey(k) ? k : undefined; } catch { return undefined; }
}

export let mesh: Mesh | undefined;
let binding: { code: string; uri: string; expires: number; abort: AbortController } | undefined;
let lastError = "";

const changed = () => bus.emit("mesh", meshStatus());

/** 启动网状层（已绑定且组件可用时）。重复调用会先停掉旧的。 */
export async function startMesh() {
  stopMesh();
  if (!config.mesh.server) return changed();
  if (!(await loadNdc())) return changed(); // 配置了同步服务就先确认原生组件可用（状态如实显示）
  const b = readBinding();
  if (!b || serverOrigin(b.server) !== safeOrigin(config.mesh.server)) return changed();
  const { pull, push } = await import("../memory/soul-sync.ts");
  // 其他身体只认灵魂仓库里登记的公钥：本机的公钥还没登记（或换过）就立即推送一次身体登记
  if (soulKeyOf(config.body) !== nodeKey().nodeKey) void push("登记网状层公钥").catch(() => {});
  mesh = new Mesh({
    me: config.body, key: nodeKey(), ndc: ndc!, binding: b, keyOf: soulKeyOf, refreshKeys: () => pull(),
    hello: () => ({ version: VERSION, agentName: identity().displayName }),
    log: (m) => log("mesh", m),
    warn: (w) => { log("mesh", w); addTimeline("mesh", `网状层：${w}`, {}); },
  });
  mesh.on("state", changed);
  mesh.on("peer", changed);
  mesh.on("event", (e: { from: string; name: string; data: unknown }) => bus.emit("mesh.event", e));
  mesh.start();
  changed();
}
export function stopMesh() { mesh?.stop(); mesh = undefined; }

const safeOrigin = (s: string) => { try { return serverOrigin(s); } catch { return ""; } };

/** 网状层状态：state 为 off（没绑定或没启动）/ connecting / online / offline / unauthorized；peers 为同一 agent 的其他身体及连接情况。 */
export function meshStatus() {
  const b = readBinding(), live = mesh?.status();
  return {
    server: config.mesh.server, bound: !!b && serverOrigin(b.server) === safeOrigin(config.mesh.server), account: live?.account || b?.account || "",
    fingerprint: fingerprint(nodeKey().nodeKey), available: !ndcError,
    state: live?.state ?? "off", error: ndcError || lastError || live?.error || "", clockSkewMs: live?.clockSkewMs ?? 0,
    peers: live?.peers ?? [],
    binding: binding ? { code: binding.code, uri: binding.uri, expires: binding.expires } : null,
  };
}

/** 设置同步服务地址（换地址就得重新绑定）。 */
export async function setServer(server: string) {
  const origin = server.trim() ? serverOrigin(server) : "";
  if (origin === safeOrigin(config.mesh.server)) return meshStatus();
  stopMesh();
  saveConfig({ mesh: { server: origin } });
  lastError = "";
  await startMesh();
  return meshStatus();
}

/** 开始绑定：向同步服务申请设备码，返回给人看的短码与链接；后台轮询，批准后保存令牌并连上。进展经 mesh 事件推送。 */
export async function bind() {
  if (!config.mesh.server) throw new Error("先填写同步服务的地址");
  binding?.abort.abort();
  const id = identity();
  const start = await startBinding(config.mesh.server, { agent: { id: id.id, name: id.displayName }, body: config.body, kind: "runtime", nodeKey: nodeKey().nodeKey, version: VERSION });
  const abort = new AbortController();
  binding = { code: start.user_code, uri: start.verification_uri_complete, expires: Date.now() + start.expires_in * 1000, abort };
  lastError = "";
  changed();
  pollBinding(config.mesh.server, start, abort.signal).then(async (b) => {
    fs.writeFileSync(BINDING(), JSON.stringify(b, null, 2), { mode: 0o600 });
    binding = undefined;
    addTimeline("mesh", `这具身体绑定到了同步服务（账户 ${b.account}）`, { server: b.server });
    await startMesh();
  }, (e: Error) => { if (binding?.abort === abort) { binding = undefined; lastError = e.message; changed(); } });
  return meshStatus();
}

export function cancelBind() { binding?.abort.abort(); binding = undefined; changed(); return meshStatus(); }

/** 解绑：通知同步服务作废令牌，删除本机的绑定。节点密钥保留（它登记在灵魂仓库里）。 */
export async function unbindMesh() {
  const b = readBinding();
  stopMesh();
  if (b) await unbindRemote(b);
  fs.rmSync(BINDING(), { force: true });
  addTimeline("mesh", "这具身体从同步服务解绑了", {});
  changed();
  return meshStatus();
}

/** 网状层上的基础协作：自己推送了灵魂仓库就告诉其他身体，收到的身体立即拉取（不必等到下次醒来）。 */
export function wireMesh() {
  bus.on("soul.pushed", (e) => mesh?.broadcast("soul.pushed", { files: e.files.slice(0, 50) }));
  let pulling: NodeJS.Timeout | undefined;
  bus.on("mesh.event", (e) => {
    if (e.name !== "soul.pushed") return;
    clearTimeout(pulling); // 多具身体连着推送时合并成一次拉取
    pulling = setTimeout(() => { void import("../memory/soul-sync.ts").then((s) => s.pull()).catch(() => {}); }, 500);
  });
}
