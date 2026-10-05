// 同步服务的客户端（协议见 sync/docs/PROTOCOL.md）：设备码绑定、信令 WebSocket（在场、转发信令、TURN 凭据），断线指数退避重连。
// 同步服务只是目录与信令：这里收到的 nodeKey 只用来提醒不一致，身体之间核对公钥以灵魂仓库为准（见 mesh.ts）。
import { EventEmitter } from "node:events";
import { WebSocket } from "ws";

export const PROTOCOL = 1;

export interface Peer { body: string; kind: string; nodeKey: string; version: string; online: boolean; lastSeen: number }
export interface IceServer { urls: string[]; username?: string; credential?: string }
export interface Binding { server: string; token: string; agent: string; body: string; account: string }
export interface BindStart { user_code: string; verification_uri: string; verification_uri_complete: string; expires_in: number; interval: number; device_code: string }

/** 只接受 HTTPS 的同步服务（本机地址除外，开发与测试用）：令牌与信令不能走明文。返回规范化的源（origin）或抛错。 */
export function serverOrigin(input: string): string {
  let u: URL;
  try { u = new URL(input.trim()); } catch { throw new Error("同步服务地址不是合法的网址"); }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) throw new Error("同步服务必须使用 HTTPS（令牌与信令不能明文传输）");
  return u.origin;
}

async function post(url: string, body: unknown, signal?: AbortSignal) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: signal ?? AbortSignal.timeout(15_000) });
  return { status: r.status, json: await r.json().catch(() => ({})) as Record<string, any> };
}

/** 绑定第一步：申请设备码。 */
export async function startBinding(server: string, req: { agent: { id: string; name: string }; body: string; kind: "runtime" | "bridge"; nodeKey: string; version: string }): Promise<BindStart> {
  const r = await post(`${serverOrigin(server)}/v1/device/code`, req);
  if (r.status !== 200) throw new Error(r.json.error === "login_disabled" ? "这个同步服务还没有配置 GitHub 登录，暂时不能绑定" : r.json.error === "slow_down" ? "申请太频繁，请稍后再试" : `同步服务拒绝了绑定请求（${r.json.error ?? r.status}）`);
  return r.json as BindStart;
}

/** 绑定第二步：按间隔轮询，直到人在网页上批准或拒绝、或过期。返回令牌。 */
export async function pollBinding(server: string, b: BindStart, signal: AbortSignal): Promise<Binding> {
  let interval = Math.max(1, b.interval) * 1000;
  const deadline = Date.now() + b.expires_in * 1000;
  while (Date.now() < deadline) {
    await new Promise((r, j) => { const t = setTimeout(r, interval); signal.addEventListener("abort", () => { clearTimeout(t); j(new Error("已取消绑定")); }, { once: true }); });
    const r = await post(`${serverOrigin(server)}/v1/device/token`, { device_code: b.device_code }, AbortSignal.any([signal, AbortSignal.timeout(15_000)])).catch((e) => { if (signal.aborted) throw e; return { status: 0, json: {} as Record<string, any> }; });
    if (r.status === 200) return { server: serverOrigin(server), token: r.json.access_token, agent: r.json.agent?.id ?? "", body: r.json.body ?? "", account: r.json.account ?? "" };
    const err = r.json.error;
    if (err === "slow_down") interval += 5000;
    else if (err === "access_denied") throw new Error("绑定被拒绝了");
    else if (err === "expired_token" || err === "invalid_grant") throw new Error("绑定码已过期，请重新开始");
  }
  throw new Error("绑定码已过期，请重新开始");
}

/** 解绑：令牌作废（同步服务删除这具身体的登记）。 */
export async function unbind(b: Binding) {
  await fetch(`${serverOrigin(b.server)}/v1/me`, { method: "DELETE", headers: { authorization: `Bearer ${b.token}` }, signal: AbortSignal.timeout(10_000) }).catch(() => {});
}

export type DirectoryState = "connecting" | "online" | "offline" | "unauthorized";

/**
 * 信令连接。事件：online、offline、peer（Peer）、peer.removed（body）、signal（{from, data}）、turn（iceServers）、error（说明）、revoked。
 * 断线后指数退避重连（1 秒到 1 分钟，带抖动）；令牌失效（4401 / 4403）就不再重连，状态 unauthorized。
 */
export class Directory extends EventEmitter {
  state: DirectoryState = "offline";
  error = "";
  peers = new Map<string, Peer>();
  iceServers: IceServer[] = [];
  iceIssued = 0;
  iceTtl = 0;
  agent = { id: "", name: "" };
  account = "";
  clockSkew = 0; // 本机时钟减去服务端时钟（毫秒）
  private ws?: WebSocket;
  private retry = 0;
  private timer?: NodeJS.Timeout;
  private turnTimer?: NodeJS.Timeout;
  private closed = false;
  private b: Binding;
  private hello: () => { version: string; agentName?: string };
  constructor(b: Binding, hello: () => { version: string; agentName?: string }) { super(); this.b = b; this.hello = hello; }

  connect() {
    this.closed = false;
    clearTimeout(this.timer);
    this.state = "connecting";
    const url = serverOrigin(this.b.server).replace(/^http/, "ws") + "/v1/ws";
    const ws = new WebSocket(url, { handshakeTimeout: 15_000, maxPayload: 1 << 20, perMessageDeflate: false });
    this.ws = ws;
    ws.on("open", () => ws.send(JSON.stringify({ t: "hello", token: this.b.token, protocol: PROTOCOL, ...this.hello() })));
    ws.on("message", (raw) => { let m: any; try { m = JSON.parse(raw.toString()); } catch { return; } this.onMessage(m); });
    ws.on("close", (code) => {
      if (this.ws !== ws) return;
      const wasOnline = this.state === "online";
      for (const p of this.peers.values()) p.online = false;
      clearTimeout(this.turnTimer);
      if (code === 4401 || code === 4403) { this.state = "unauthorized"; this.error = code === 4403 ? "这具身体已在同步服务上被解绑" : "同步服务不认这具身体的令牌（可能已被解绑），请重新绑定"; this.emit("revoked", this.error); }
      else {
        this.state = "offline";
        if (code === 4409) this.retry = Math.max(this.retry, 7); // 被同一身体的另一条连接顶替：慢慢再试，免得两个进程来回抢
        if (!this.closed) this.schedule();
      }
      if (wasOnline) this.emit("offline");
    });
    ws.on("error", (e) => { this.error = `连不上同步服务：${e.message}`; });
  }

  private schedule() {
    const base = Math.min(60_000, 1000 * 2 ** this.retry++);
    this.timer = setTimeout(() => this.connect(), base / 2 + Math.random() * base / 2);
    this.timer.unref?.();
  }

  private onMessage(m: any) {
    switch (m.t) {
      case "welcome":
        this.retry = 0; this.state = "online"; this.error = "";
        this.agent = m.agent; this.account = m.account; this.clockSkew = Date.now() - Number(m.now ?? Date.now());
        this.peers = new Map((m.peers as Peer[]).map((p) => [p.body, p]));
        this.setIce(m.iceServers, m.ttl);
        this.emit("online");
        for (const p of this.peers.values()) this.emit("peer", p);
        return;
      case "peer": this.peers.set(m.peer.body, m.peer); this.emit("peer", m.peer); return;
      case "peer.removed": this.peers.delete(m.body); this.emit("peer.removed", m.body); return;
      case "signal": this.emit("signal", { from: m.from, data: m.data }); return;
      case "turn": this.setIce(m.iceServers, m.ttl); return;
      case "bye": this.error = m.reason === "replaced" ? "同一具身体的另一条连接顶替了这条（是不是在两个地方运行了同一个家目录？）" : "这具身体已在同步服务上被解绑"; return;
      case "error": this.emit("error", m.code === "offline" ? `${m.to} 不在线` : `同步服务：${m.code}`); return;
    }
  }

  /** 记下 ICE 服务器；TURN 凭据到 80% 有效期时自动刷新。 */
  private setIce(servers: IceServer[], ttl: number) {
    this.iceServers = servers ?? []; this.iceIssued = Date.now(); this.iceTtl = ttl ?? 0;
    clearTimeout(this.turnTimer);
    if (this.iceTtl > 0) { this.turnTimer = setTimeout(() => this.send({ t: "turn" }), this.iceTtl * 800); this.turnTimer.unref?.(); }
    this.emit("turn", this.iceServers);
  }

  private send(m: unknown) { if (this.ws?.readyState === WebSocket.OPEN) { this.ws.send(JSON.stringify(m)); return true; } return false; }
  signal(to: string, data: unknown) { return this.send({ t: "signal", to, data }); }

  close() { this.closed = true; clearTimeout(this.timer); clearTimeout(this.turnTimer); this.ws?.close(1000); this.state = "offline"; }
}
