// 全网共用（DISTRIBUTED.md C8、C9）：一处改了，所有身体跟着改。
//   - 设置分区：权限、预算、心脏（活跃度、暂停）、听觉、语音、大脑；模型供应商（含 Key）；语音密钥；急停（全网的）。
//     每个分区记着最近一次被修改的时刻（config.sharedRev），连上时互相比较，较新的生效；平时一改就广播。
//     Key 只经网状层端到端加密、双方以节点密钥认证过的通道传，接收方用自己的主密钥重新加密保存。
//   - 审批：一具身体上等待批准的事，所有身体的控制台都看得到；在哪里批准都行（转给发起的那具身体）。
//   - 预算：用量按身体记，每日预算看全网合计。
//   - 提醒：按条目合并（time/reminders.ts 的 merge：同一编号以较新的修改为准，删除留墓碑），不看分区的修改时刻；一改就广播，连上时互相拉一次。
//   - 来自别处的设置先校验：修改时刻不能晚于「现在 + 5 分钟」（一个远在未来的时刻会让这个分区再也改不动）；
//     每个分区只留认得的键、类型与缺省值一致的值。急停是「停优先」：别处停了随时跟着停；解除只解除对方明确解除的那几次急停（见 stopState）。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { textOf, type Mesh, type PeerStatus } from "./mesh.ts";
import { bus, type Approval } from "../bus.ts";
import { config, saveConfig, paths, defaults, SHARED_SECTIONS } from "../config.ts";
import { exportProviders, importProviders } from "../providers/registry.ts";
import { speechKey, setSpeechKeyRemote } from "../voice/azure.ts";
import { emergencyStop, releaseStop, stopScope, decide as decideLocal, approvals as localApprovals } from "../guard/guard.ts";
import { usageRows, applyUsage, kv } from "../store.ts";
import * as reminders from "../time/reminders.ts";
import { log } from "../log.ts";

const SECTIONS = [...SHARED_SECTIONS, "providers", "speechKey", "stop", "reminders"] as const;
const MERGED = new Set(["stop", "reminders"]); // 按内容合并、不看修改时刻的分区
type Section = (typeof SECTIONS)[number];
const FUTURE_MS = 5 * 60_000;
const BODY_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const STOP_ID = /^[0-9a-f]{16}$/;

// ---------- 急停：停优先
// 每一次全网急停有一个随机的编号，随 stop 分区同步：{stopped, ids（还在生效的急停）, released（已经解除的急停）}。
// 收到别处的：没见过、也没解除过的编号就跟着停（不看修改时刻，急停随时生效）；对方解除的编号里有我记着的才解除，
// 全部解除了才真正解除。所以一个过期的「解除」解不掉别处新发起的急停；本机控制台的解除总是生效，并作为新的修改广播出去。
interface StopRecord { line: string; active: string[]; released: string[] }
const STOP_KV = "mesh.stop";
const stopLine = () => { try { return fs.readFileSync(paths.stop, "utf8").split("\n")[0]; } catch { return ""; } };
const loadStop = (): StopRecord => { const r = kv.get<StopRecord>(STOP_KV, { line: "", active: [], released: [] }); return { line: String(r?.line ?? ""), active: Array.isArray(r?.active) ? r.active : [], released: Array.isArray(r?.released) ? r.released : [] }; };
const saveStop = (r: StopRecord) => kv.set(STOP_KV, { line: r.line, active: r.active.slice(-20), released: r.released.slice(-50) });

/** 本机此刻的全网急停状态（顺带登记本机新发起的急停、记下本机解除了的急停）。 */
export function stopState(): { stopped: boolean; ids: string[]; released: string[] } {
  const r = loadStop(), scope = stopScope();
  if (scope === "all") {
    const line = stopLine();
    if (line !== r.line) { r.line = line; r.active = [...r.active, crypto.randomBytes(8).toString("hex")]; saveStop(r); } // 本机新发起的急停
    return { stopped: true, ids: r.active.slice(-20), released: r.released.slice(-50) };
  }
  if (scope === undefined && r.active.length) { r.released = [...r.released, ...r.active]; r.active = []; r.line = ""; saveStop(r); } // 本机解除了
  return { stopped: false, ids: [], released: r.released.slice(-50) };
}

/** 采用别处的急停状态（见上）。返回是否有变化。 */
function applyStop(v: unknown, from: string): boolean {
  if (!v || typeof v !== "object") return false;
  const ids = (x: unknown, n: number) => (Array.isArray(x) ? x.filter((i): i is string => typeof i === "string" && STOP_ID.test(i)).slice(-n) : []);
  const theirs = ids((v as any).ids, 20), theirReleased = ids((v as any).released, 50);
  stopState(); // 先把本机的状态登记好
  const r = loadStop();
  const rel = theirReleased.filter((id) => r.active.includes(id));
  const fresh = (v as any).stopped === true ? theirs.filter((id) => !r.active.includes(id) && !r.released.includes(id)) : [];
  if (!rel.length && !fresh.length) return false;
  r.active = [...r.active.filter((id) => !rel.includes(id)), ...fresh];
  r.released = [...r.released, ...rel];
  if (r.active.length && stopScope() === undefined) { emergencyStop(from, "（从其他身体同步）", { remote: true }); r.line = stopLine(); }
  else if (!r.active.length && stopScope() === "all") { releaseStop(from, { remote: true }); r.line = ""; }
  saveStop(r);
  return true;
}

// ---------- 设置分区的校验
/** 只留认得的键、类型与缺省值一致的值（数字为有限的非负数，文字最长 500）；权限只收 allow / ask / deny。不合格返回 undefined。 */
export function sanitizeSection(section: string, v: unknown): Record<string, unknown> | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const out: Record<string, unknown> = {};
  if (section === "permissions") {
    for (const [k, l] of Object.entries(v).slice(0, 100)) if (/^[a-z_]{1,40}$/.test(k) && (l === "allow" || l === "ask" || l === "deny")) out[k] = l;
    return out;
  }
  const def = (defaults as unknown as Record<string, Record<string, unknown>>)[section];
  if (!def || typeof def !== "object") return undefined;
  for (const [k, d] of Object.entries(def)) {
    const x = (v as Record<string, unknown>)[k];
    if (typeof d === "number" ? typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= 1e12
      : typeof d === "boolean" ? typeof x === "boolean"
      : typeof d === "string" ? typeof x === "string" && x.length <= 500 : false) out[k] = x;
  }
  if (section === "channels" && typeof out.feishuHolder === "string" && out.feishuHolder && !BODY_RE.test(out.feishuHolder)) delete out.feishuHolder;
  return out;
}

function read(section: Section): unknown {
  if (section === "providers") return exportProviders();
  if (section === "speechKey") return speechKey();
  if (section === "stop") return stopState();
  if (section === "reminders") return reminders.all();
  return (config as any)[section];
}

// ---------- 与每具身体对齐设置的结果（控制台「设备」页显示：哪些设置采用了对方的、失败的原因）
const LABEL: Record<string, string> = { reminders: "提醒", providers: "模型与 Key", speechKey: "语音密钥", permissions: "权限", budget: "预算", heart: "活跃度", hearing: "听觉", speech: "语音", brain: "大脑", channels: "通道", stop: "急停" };
export interface AlignStatus { at: number; took: string[]; error?: string }
const aligned = new Map<string, AlignStatus>();
const note = (body: string, took: string[], error?: string) => {
  const prev = aligned.get(body);
  aligned.set(body, { at: Date.now(), took: took.length ? took.map((n) => LABEL[n] ?? n) : error ? [] : prev?.took ?? [], ...(error ? { error } : {}) });
};
/** 与某具身体最近一次对齐设置的结果（还没对齐过为 undefined）。 */
export const alignStatus = (body: string): AlignStatus | undefined => aligned.get(body);

function write(section: Section, value: any, from: string): boolean {
  if (section === "providers") {
    const { rejected } = importProviders(value, `${from}（同步）`);
    if (rejected.length) {
      log("mesh", `${from} 同步来的模型供应商里有 ${rejected.length} 个不合格，保留本机原来的：${rejected.join("、")}`);
      note(from, [], `${from} 的模型供应商里有 ${rejected.length} 个没采用（地址不是 HTTPS）：${rejected.join("、")}`);
    }
  } else if (section === "speechKey") {
    if (typeof value !== "string" || value.length > 1000 || /[^\x21-\x7e]/.test(value)) throw new Error("语音密钥格式不对");
    setSpeechKeyRemote(value);
  } else if (section === "stop") return applyStop(value, from);
  else if (section === "reminders") return reminders.merge(value);
  else {
    const clean = sanitizeSection(section, value);
    if (!clean) throw new Error("格式不对");
    saveConfig({ [section]: clean }, { remote: true });
  }
  return true;
}

/** 远端的设置比本机新的就采用（逐个分区）。修改时刻晚于「现在 + 5 分钟」的拒收；急停不看修改时刻（见 applyStop）。 */
function adopt(sections: unknown, from: string): string[] {
  const took: string[] = [];
  if (!sections || typeof sections !== "object") return took;
  for (const [name, s] of Object.entries(sections as Record<string, { rev: unknown; value: unknown }>)) {
    if (!(SECTIONS as readonly string[]).includes(name) || typeof s?.rev !== "number" || !Number.isFinite(s.rev)) continue;
    if (s.rev > Date.now() + FUTURE_MS) { log("mesh", `${from} 的设置 ${name} 修改时刻在未来（时钟不准？），不采用`); continue; }
    if (!MERGED.has(name) && s.rev <= (config.sharedRev[name] ?? 0)) continue;
    try {
      if (!write(name as Section, s.value, from)) continue;
      if (s.rev > (config.sharedRev[name] ?? 0)) saveConfig({ sharedRev: { [name]: s.rev } }, { remote: true });
      took.push(name);
    } catch (e) {
      const why = name === "providers" || name === "speechKey" ? "格式不对" : String((e as Error).message).slice(0, 200);
      log("mesh", `采用 ${from} 的设置 ${name} 失败：${why}`);
      note(from, [], `没能采用 ${from} 的${LABEL[name] ?? name}：${why}`);
    }
  }
  if (took.length) { bus.emit("state"); log("mesh", `采用了 ${from} 较新的设置：${took.join("、")}`); bus.emit("shared.applied", took); }
  return took;
}

const pack = (names: readonly string[]) => Object.fromEntries(names.filter((n) => (SECTIONS as readonly string[]).includes(n)).map((n) => [n, { rev: config.sharedRev[n] ?? 0, value: read(n as Section) }]));

// ---------- 审批
/** 其他身体上等待批准的事（多具身体时，所有控制台都看得到）。键为「身体/编号」：不同身体的编号即使相同也不会混。 */
const remote = new Map<string, Approval>();
const rkey = (body: string, id: string) => `${body}/${id}`;
export const remoteApprovals = () => [...remote.values()].filter((a) => a.status === "pending");
const clipText = (v: unknown, n: number) => textOf(v).replace(/[\p{Cc}\p{Cf}]+/gu, " ").slice(0, n);
/** 别处发来的审批：字段检查与截断，body 一律是发来的那具身体。不合格返回 undefined。 */
function approvalOf(x: any, body: string): Approval | undefined {
  if (!x || typeof x !== "object" || typeof x.id !== "string" || !/^[0-9a-f]{8,32}$/.test(x.id)) return undefined;
  if (x.status !== "pending" && x.status !== "approved" && x.status !== "denied") return undefined;
  let args: unknown = x.args ?? null;
  try { if (JSON.stringify(args).length > 8000) args = "（参数太长，省略）"; } catch { args = null; }
  return { id: x.id, action: clipText(x.action, 200), reason: clipText(x.reason, 2000), args, status: x.status, body };
}
function rememberRemote(a: Approval) {
  const k = rkey(a.body!, a.id);
  if (a.status === "pending") { remote.delete(k); remote.set(k, a); if (remote.size > 500) remote.delete(remote.keys().next().value!); }
  else remote.delete(k);
}

/**
 * 补修订号：有同步功能之前（或升级前）配好的设置没有修改时刻（修订号 0）。两具身体都是 0 时谁也不比谁新、谁也不拉谁，
 * 早就配好的模型、Key 永远传不到新身体上。所以启动时给本机**确实有内容**的分区补一个修订号，取那份数据文件的修改时刻
 * （如实反映它是什么时候配的，不用「现在」，免得一具身体重启就压过别处后来的修改）；空的、与缺省相同的不补，好让它从别处拉。
 * 返回补了的分区。
 */
export function backfillRevs(): string[] {
  const mtime = (f: string) => { try { return Math.min(Math.floor(fs.statSync(f).mtimeMs), Date.now()); } catch { return 0; } };
  const stamp: Record<string, number> = {};
  for (const s of SECTIONS) {
    if (MERGED.has(s) || (config.sharedRev[s] ?? 0) > 0) continue;
    let t = 0;
    if (s === "providers") { if (exportProviders().providers.length) t = mtime(path.join(paths.config, "providers.json")); }
    else if (s === "speechKey") { if (speechKey()) t = mtime(path.join(paths.secrets, "azure_speech_key")); }
    else if (JSON.stringify((config as any)[s]) !== JSON.stringify((defaults as any)[s])) t = mtime(path.join(paths.config, "quetzal.json"));
    if (t > 0) stamp[s] = t;
  }
  const names = Object.keys(stamp);
  if (names.length) { saveConfig({ sharedRev: stamp }, { remote: true }); log("mesh", `补了修订号（之前配好、还没同步过的设置）：${names.join("、")}`); }
  return names;
}

export function installShared(mesh: Mesh): () => void {
  backfillRevs();
  mesh.handle("settings.revs", () => Object.fromEntries(SECTIONS.map((s) => [s, config.sharedRev[s] ?? 0])));
  mesh.handle("settings.get", (p: { sections: unknown }) => pack(Array.isArray(p?.sections) ? p.sections.filter((x): x is string => typeof x === "string").slice(0, 20) : []));
  mesh.handle("approval.decide", (p: { id: string; approve: boolean; note?: string }, from: string) => decideLocal(typeof p?.id === "string" ? p.id : "", p?.approve === true, `${from} 上的控制台`, clipText(p?.note, 500)));
  mesh.handle("approvals.pending", () => localApprovals().map((a) => ({ ...a, body: config.body })));
  mesh.handle("usage.today", () => usageRows());

  const onShared = (sections: string[]) => mesh.broadcast("settings", pack(sections));
  const onApproval = (a: Approval) => { if (!a.body || a.body === config.body) mesh.broadcast("approval", { ...a, body: config.body }); };
  const onUsage = (row: unknown) => mesh.broadcast("usage", [row]);
  const onEvent = (e: { from: string; name: string; data: any }) => {
    if (e.name === "settings") { const took = adopt(e.data, e.from); if (took.length) note(e.from, took); }
    else if (e.name === "approval") {
      const a = approvalOf(e.data, e.from);
      if (!a) return;
      rememberRemote(a);
      bus.emit("approval", a);
    } else if (e.name === "usage") applyUsage(e.data, e.from);
  };
  const onPeer = async (s: PeerStatus) => {
    if (s.link !== "open") { for (const [k, a] of remote) if (a.body === s.body) remote.delete(k); return; }
    try {
      const revs = await mesh.request<Record<string, unknown>>(s.body, "settings.revs", {}, 15_000);
      const limit = Date.now() + FUTURE_MS;
      const newer = Object.entries(revs && typeof revs === "object" ? revs : {})
        .filter(([n, r]) => MERGED.has(n) || (typeof r === "number" && r <= limit && r > (config.sharedRev[n] ?? 0))).map(([n]) => n);
      const took = newer.length ? adopt(await mesh.request(s.body, "settings.get", { sections: newer }, 30_000), s.body) : [];
      if (!aligned.get(s.body)?.error || took.length) note(s.body, took);
      const pending = await mesh.request<unknown>(s.body, "approvals.pending", {}, 15_000);
      for (const x of Array.isArray(pending) ? pending.slice(0, 200) : []) { const a = approvalOf(x, s.body); if (a?.status === "pending") { rememberRemote(a); bus.emit("approval", a); } }
      applyUsage(await mesh.request(s.body, "usage.today", {}, 15_000), s.body);
    } catch (e) { log("mesh", `与 ${s.body} 对齐设置失败：${(e as Error).message}`); note(s.body, [], `对齐设置失败：${String((e as Error).message).slice(0, 200)}`); }
  };

  const onReminders = () => onShared(["reminders"]);
  bus.on("shared", onShared);
  bus.on("reminders.changed", onReminders);
  bus.on("approval", onApproval);
  bus.on("usage", onUsage);
  mesh.on("event", onEvent);
  mesh.on("peer", onPeer);
  setApprovalRouter((body, id, approve, note) => mesh.request<boolean>(body, "approval.decide", { id, approve, note }, 15_000));
  return () => {
    bus.off("shared", onShared as any); bus.off("reminders.changed", onReminders); bus.off("approval", onApproval as any); bus.off("usage", onUsage as any);
    mesh.off("event", onEvent); mesh.off("peer", onPeer); setApprovalRouter(undefined); remote.clear();
  };
}

/** 控制台批准 / 拒绝：本机的直接处理；其他身体上的转过去。 */
let routeApproval: ((body: string, id: string, approve: boolean, note: string) => Promise<boolean>) | undefined;
const setApprovalRouter = (f: typeof routeApproval) => { routeApproval = f; };
/**
 * 批准或拒绝一件等待中的事。body：它在哪具身体上（审批列表里每条都带着）；给了就只找那具身体上的。
 * 没给 body 时按编号找，本机与别处（或别处几具身体之间）编号相同、分不清是哪一件时不处理，返回 false。
 */
export async function decideAnywhere(id: string, approve: boolean, actor: string, note = "", body?: string): Promise<boolean> {
  if (typeof id !== "string" || !id) return false;
  const local = localApprovals().some((a) => a.id === id);
  const remotes = remoteApprovals().filter((a) => a.id === id && (!body || a.body === body));
  if (body === config.body || (!body && local && !remotes.length)) return decideLocal(id, approve, actor, note);
  if (!body && local) return false; // 分不清
  if (remotes.length !== 1 || !routeApproval) return false;
  return (await routeApproval(remotes[0].body!, id, approve, note).catch(() => false)) === true;
}
