// 运行基座一侧的网状层：把 Mesh 绑定到运行时配置（同步服务地址、绑定令牌、节点密钥、灵魂仓库里登记的公钥）。
// node-datachannel 是可选依赖（原生模块）：加载不了时网状层关闭，身体之间退回只用 git 同步，状态里说明原因。
import fs from "node:fs";
import path from "node:path";
import { config, paths, saveConfig, OFFICIAL_SYNC } from "../config.ts";
import { log } from "../log.ts";
import { bus } from "../bus.ts";
import { addTimeline } from "../store.ts";
import { identity } from "../memory/identity.ts";
import { VERSION } from "../version.ts";
import { fingerprint, isNodeKey, BODY_NAME } from "./identity.ts";
import { nodeKey } from "./node-key.ts";
import { installPresence } from "./presence.ts";
import { installCoordinator, coordinator } from "./coordinator.ts";
import { installPlacement } from "./placement.ts";
import { installLimbs } from "./limbs.ts";
import { installShared, alignStatus } from "./shared.ts";
import { installChannels } from "./channels.ts";
import { snapshot } from "../heart/heart.ts";
import { adapter } from "../body/twin.ts";
import { Mesh, filePins } from "./mesh.ts";
import { startBinding, pollBinding, unbind as unbindRemote, serverOrigin, type Binding } from "./directory.ts";
import type { Ndc } from "./link.ts";
import { installReplica } from "./replica.ts";

const BINDING = () => path.join(paths.secrets, "sync.json");
const PINS = () => path.join(paths.data, "mesh-pins.json"); // 钉住的各身体公钥与类型（TOFU，见 mesh.ts；不是秘密）
export { nodeKey };

let ndc: Ndc | undefined;
let ndcError = "";
async function loadNdc(): Promise<Ndc | undefined> {
  if (ndc || ndcError) return ndc;
  try { const m: any = await import("node-datachannel"); ndc = (m.default ?? m) as Ndc; }
  catch (e) { ndcError = `这具身体缺少网状层的原生组件 node-datachannel（${(e as Error).message.split("\n")[0]}）：重新运行安装即可补上；在此之前只用 git 同步`; log("mesh", ndcError); }
  return ndc;
}

export function readBinding(): Binding | undefined {
  try { const b = JSON.parse(fs.readFileSync(BINDING(), "utf8")) as Binding; return b.token && b.server ? b : undefined; } catch { return undefined; }
}

/** 灵魂仓库里登记的某具身体的节点公钥（信任根）。 */
export function soulKeyOf(body: string): string | undefined {
  const k = soulBody(body)?.meshKey; return isNodeKey(k) ? k : undefined;
}
/** 灵魂仓库里登记的某具身体的类型（runtime / bridge）。 */
export function soulKindOf(body: string): string | undefined {
  const k = soulBody(body)?.kind; return typeof k === "string" ? k : undefined;
}
function soulBody(body: string): Record<string, unknown> | undefined {
  if (!BODY_NAME.test(body)) return undefined;
  try { return JSON.parse(fs.readFileSync(path.join(paths.soul, "bodies", `${body}.json`), "utf8")); } catch { return undefined; }
}

export let mesh: Mesh | undefined;
let uninstall: (() => void) | undefined;
let binding: { code: string; uri: string; expires: number; abort: AbortController; check: string } | undefined;
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
    me: config.body, key: nodeKey(), ndc: ndc!, binding: b, keyOf: soulKeyOf, kindOf: soulKindOf, refreshKeys: () => pull(), pins: filePins(PINS()),
    hello: () => ({ version: VERSION, agentName: identity().displayName }),
    netEvents: adapter.onNetworkChange ? (cb) => adapter.onNetworkChange!(cb) : undefined, // 平台的网络变化通知（安卓 App）；其余靠轮询
    log: (m) => log("mesh", m),
    warn: (w) => { log("mesh", w); addTimeline("mesh", `网状层：${w}`, {}); }, // 已截断、限频（mesh.ts）
  });
  mesh.on("state", changed);
  mesh.on("peer", changed);
  mesh.on("reader", changed);
  mesh.on("event", (e: { from: string; name: string; data: unknown }) => bus.emit("mesh.event", e));
  const socialNow = () => { const d = snapshot().drives; return d.social >= 0.6 || d.expression >= 0.6; };
  const parts = [installReplica(mesh), installPresence(mesh), installCoordinator(mesh), installPlacement(mesh, VERSION, socialNow), installLimbs(mesh), installShared(mesh), installChannels(mesh)]; // 一个心智：对话、会话与时间线复制；进展与在场互通，发给别处进行中会话的话转过去
  uninstall = () => parts.forEach((u) => u());
  mesh.start();
  changed();
}
export function stopMesh() { uninstall?.(); uninstall = undefined; mesh?.stop(); mesh = undefined; }

const safeOrigin = (s: string) => { try { return serverOrigin(s); } catch { return ""; } };

/** 网状层状态：state 为 off（没绑定或没启动）/ connecting / online / offline / unauthorized；peers 为同一 agent 的其他身体及连接情况。 */
export function meshStatus() {
  const b = readBinding(), live = mesh?.status();
  return {
    server: config.mesh.server, priority: config.mesh.priority, body: config.body, bound: !!b && serverOrigin(b.server) === safeOrigin(config.mesh.server), account: live?.account || b?.account || "",
    fingerprint: fingerprint(nodeKey().nodeKey), available: !ndcError,
    state: live?.state ?? "off", error: ndcError || lastError || live?.error || "", clockSkewMs: live?.clockSkewMs ?? 0,
    peers: (live?.peers ?? []).map((p) => ({ ...p, settings: alignStatus(p.body) ?? null })), coordinator: coordinator(),
    binding: binding ? { code: binding.code, uri: binding.uri, expires: binding.expires, check: binding.check } : null,
  };
}

/** 设置同步服务地址（换地址就得重新绑定）。清空即恢复官方同步服务。 */
export async function setServer(server: string) {
  const origin = server.trim() ? serverOrigin(server) : OFFICIAL_SYNC;
  if (origin === safeOrigin(config.mesh.server)) return meshStatus();
  stopMesh();
  saveConfig({ mesh: { server: origin } });
  lastError = "";
  await startMesh();
  return meshStatus();
}

/** 一个链接接入（同步服务协议 §2.1）：ops 层登记「这具身体的部署公钥」与「采用批准时链接好的灵魂仓库」（mesh 不直接依赖 ops，避免循环）。 */
let soulLink: { key(): Promise<string>; adopt(remote: string): Promise<void> } | undefined;
export function registerSoulLink(l: NonNullable<typeof soulLink>) { soulLink = l; }

/** 开始绑定：向同步服务申请设备码，返回给人看的短码、核对词与链接；后台轮询，批准后保存令牌并连上。进展经 mesh 事件推送。
 *  同时带上部署公钥：批准时同步服务经 GitHub 把它加到灵魂仓库。身份还是种子（新装的身体）时不报 agent id，由批准的人选——
 *  老用户的新设备就这样接进已有的 agent，不会多出一个新 agent。 */
export async function bind() {
  if (!config.mesh.server) throw new Error("先填写同步服务的地址");
  binding?.abort.abort();
  const id = identity();
  const fresh = !!(id as { seed?: boolean }).seed && !config.soul.remote;
  const soulKey = config.soul.sshMode === "deploy" ? await soulLink?.key().catch(() => undefined) : undefined;
  const start = await startBinding(config.mesh.server, { agent: { ...(fresh ? {} : { id: id.id }), name: id.displayName }, body: config.body, kind: "runtime", nodeKey: nodeKey().nodeKey, version: VERSION, ...(soulKey ? { soulKey } : {}) });
  const abort = new AbortController();
  binding = { code: start.user_code, uri: start.verification_uri_complete, expires: Date.now() + start.expires_in * 1000, abort, check: start.check ?? "" };
  lastError = "";
  changed();
  pollBinding(config.mesh.server, start, abort.signal).then(async (b) => {
    const { soul, consoleToken, ...saved } = b;
    fs.writeFileSync(BINDING(), JSON.stringify(saved, null, 2), { mode: 0o600 });
    if (consoleToken) (await import("./account.ts")).adoptConsoleToken(b.server, consoleToken, b.account);
    binding = undefined;
    addTimeline("mesh", `这具身体绑定到了同步服务（账户 ${b.account}）`, { server: b.server });
    if (soul && "remote" in soul && soulLink) {
      if (!config.soul.remote) await soulLink.adopt(soul.remote).then(() => addTimeline("soul", `接入了灵魂仓库 ${soul.repo}`, { repo: soul.repo }), (e: Error) => addTimeline("soul", `接入灵魂仓库失败：${e.message}`, {}));
    } else if (soul && "error" in soul) addTimeline("soul", `没能自动链接灵魂仓库：${soul.error}`, {});
    await startMesh();
  }, (e: Error) => { if (binding?.abort === abort) { binding = undefined; lastError = e.message; changed(); } });
  return meshStatus();
}

/**
 * 确认某具身体换了节点公钥（或从灵魂桥变成运行基座）：钉住灵魂仓库里现在登记的，重新连接。
 * 在此之前网状层不和它连接（状态里 pinMismatch 为真）。网关方法 mesh.acceptPin 调用这里。
 */
export function acceptPin(body: string) {
  if (typeof body !== "string" || !BODY_NAME.test(body)) throw new Error("身体名不对");
  if (!mesh) throw new Error("网状层没有启动");
  mesh.acceptPin(body);
  addTimeline("mesh", `确认了 ${body} 新的节点公钥与类型`, { body });
  changed();
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
    pulling = setTimeout(() => { void import("../memory/soul-sync.ts").then((s) => s.pull()).then(() => mesh?.reverify()).catch(() => {}); }, 500);
  });
  // 灵魂仓库拉到了别处的变更（任何一次拉取）：按新的登记核对各条连接的公钥与类型
  bus.on("sense", (kind) => { if (kind === "soul_synced") mesh?.reverify(); });
}
