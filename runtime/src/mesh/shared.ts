// 全网共用（DISTRIBUTED.md C8、C9）：一处改了，所有身体跟着改。
//   - 设置分区：权限、预算、心脏（活跃度、暂停）、听觉、语音、大脑；模型供应商（含 Key）；语音密钥；急停（全网的）。
//     每个分区记着最近一次被修改的时刻（config.sharedRev），连上时互相比较，较新的生效；平时一改就广播。
//     Key 只经网状层端到端加密、双方以节点密钥认证过的通道传，接收方用自己的主密钥重新加密保存。
//   - 审批：一具身体上等待批准的事，所有身体的控制台都看得到；在哪里批准都行（转给发起的那具身体）。
//   - 预算：用量按身体记，每日预算看全网合计。
import fs from "node:fs";
import type { Mesh, PeerStatus } from "./mesh.ts";
import { bus, type Approval } from "../bus.ts";
import { config, saveConfig, paths, SHARED_SECTIONS } from "../config.ts";
import { exportProviders, importProviders } from "../providers/registry.ts";
import { speechKey, setSpeechKeyRemote } from "../voice/azure.ts";
import { emergencyStop, releaseStop, stopScope, decide as decideLocal, approvals as localApprovals } from "../guard/guard.ts";
import { usageRows, applyUsage } from "../store.ts";
import { log } from "../log.ts";

const SECTIONS = [...SHARED_SECTIONS, "providers", "speechKey", "stop"] as const;
type Section = (typeof SECTIONS)[number];

function read(section: Section): unknown {
  if (section === "providers") return exportProviders();
  if (section === "speechKey") return speechKey();
  if (section === "stop") return { stopped: stopScope() === "all" };
  return (config as any)[section];
}

function write(section: Section, value: any, rev: number, from: string) {
  if (section === "providers") importProviders(value, `${from}（同步）`);
  else if (section === "speechKey") { if (typeof value === "string") setSpeechKeyRemote(value); }
  else if (section === "stop") { if (value?.stopped && !fs.existsSync(paths.stop)) emergencyStop(from, "（从其他身体同步）", { remote: true }); else if (!value?.stopped && stopScope() === "all") releaseStop(from, { remote: true }); }
  else saveConfig({ [section]: value }, { remote: true });
  saveConfig({ sharedRev: { [section]: rev } }, { remote: true });
  bus.emit("state");
}

/** 远端的设置比本机新的就采用（逐个分区）。 */
function adopt(sections: Record<string, { rev: number; value: unknown }>, from: string) {
  const took: string[] = [];
  for (const [name, s] of Object.entries(sections ?? {})) {
    if (!(SECTIONS as readonly string[]).includes(name) || typeof s?.rev !== "number") continue;
    if (s.rev <= (config.sharedRev[name] ?? 0)) continue;
    try { write(name as Section, s.value, s.rev, from); took.push(name); } catch (e) { log("mesh", `采用 ${from} 的设置 ${name} 失败：${(e as Error).message}`); }
  }
  if (took.length) { log("mesh", `采用了 ${from} 较新的设置：${took.join("、")}`); bus.emit("shared.applied", took); }
}

const pack = (names: readonly string[]) => Object.fromEntries(names.filter((n) => (SECTIONS as readonly string[]).includes(n)).map((n) => [n, { rev: config.sharedRev[n] ?? 0, value: read(n as Section) }]));

/** 其他身体上等待批准的事（多具身体时，所有控制台都看得到）。 */
const remote = new Map<string, Approval>();
export const remoteApprovals = () => [...remote.values()].filter((a) => a.status === "pending");

export function installShared(mesh: Mesh): () => void {
  mesh.handle("settings.revs", () => Object.fromEntries(SECTIONS.map((s) => [s, config.sharedRev[s] ?? 0])));
  mesh.handle("settings.get", (p: { sections: string[] }) => pack(Array.isArray(p?.sections) ? p.sections : []));
  mesh.handle("approval.decide", (p: { id: string; approve: boolean; note?: string }, from: string) => decideLocal(String(p?.id), !!p?.approve, `${from} 上的控制台`, String(p?.note ?? "")));
  mesh.handle("approvals.pending", () => localApprovals().map((a) => ({ ...a, body: config.body })));
  mesh.handle("usage.today", () => usageRows());

  const onShared = (sections: string[]) => mesh.broadcast("settings", pack(sections));
  const onApproval = (a: Approval) => { if (!a.body || a.body === config.body) mesh.broadcast("approval", { ...a, body: config.body }); };
  const onUsage = (row: unknown) => mesh.broadcast("usage", [row]);
  const onEvent = (e: { from: string; name: string; data: any }) => {
    if (e.name === "settings") adopt(e.data, e.from);
    else if (e.name === "approval" && e.data?.id) {
      const a = { ...e.data, body: e.from } as Approval;
      if (a.status === "pending") remote.set(a.id, a); else remote.delete(a.id);
      bus.emit("approval", a);
    } else if (e.name === "usage" && Array.isArray(e.data)) applyUsage(e.data);
  };
  const onPeer = async (s: PeerStatus) => {
    if (s.link !== "open") { for (const [id, a] of remote) if (a.body === s.body) remote.delete(id); return; }
    try {
      const revs = await mesh.request<Record<string, number>>(s.body, "settings.revs", {}, 15_000);
      const newer = Object.entries(revs ?? {}).filter(([n, r]) => typeof r === "number" && r > (config.sharedRev[n] ?? 0)).map(([n]) => n);
      if (newer.length) adopt(await mesh.request(s.body, "settings.get", { sections: newer }, 30_000), s.body);
      for (const a of await mesh.request<Approval[]>(s.body, "approvals.pending", {}, 15_000)) { remote.set(a.id, { ...a, body: s.body }); bus.emit("approval", { ...a, body: s.body }); }
      applyUsage(await mesh.request(s.body, "usage.today", {}, 15_000));
    } catch (e) { log("mesh", `与 ${s.body} 对齐设置失败：${(e as Error).message}`); }
  };

  bus.on("shared", onShared);
  bus.on("approval", onApproval);
  bus.on("usage", onUsage);
  mesh.on("event", onEvent);
  mesh.on("peer", onPeer);
  setApprovalRouter((id, approve, note) => {
    const a = remote.get(id);
    if (!a?.body) return undefined;
    return mesh.request<boolean>(a.body, "approval.decide", { id, approve, note }, 15_000);
  });
  return () => {
    bus.off("shared", onShared as any); bus.off("approval", onApproval as any); bus.off("usage", onUsage as any);
    mesh.off("event", onEvent); mesh.off("peer", onPeer); setApprovalRouter(undefined); remote.clear();
  };
}

/** 控制台批准 / 拒绝：本机的直接处理；其他身体上的转过去。 */
let routeApproval: ((id: string, approve: boolean, note: string) => Promise<boolean> | undefined) | undefined;
const setApprovalRouter = (f: typeof routeApproval) => { routeApproval = f; };
export async function decideAnywhere(id: string, approve: boolean, actor: string, note = ""): Promise<boolean> {
  if (decideLocal(id, approve, actor, note)) return true;
  return (await routeApproval?.(id, approve, note)) ?? false;
}
