// 同步服务的客户端（协议见 sync/docs/PROTOCOL.md）：设备码绑定、信令 WebSocket（在场、转发信令、TURN 凭据），断线指数退避重连。
// 同步服务只是目录与信令：这里收到的 nodeKey 只用来提醒不一致，身体之间核对公钥以灵魂仓库为准（见 mesh.ts）。
// 同步服务发来的每条消息都按严格的形状检查（身体名、长度、数量），不合格的丢弃：被攻破的同步服务也不能让进程崩溃。
import { EventEmitter } from "node:events";
import { WebSocket } from "ws";
import { isNodeKey, BODY_NAME } from "./identity.ts";

export const PROTOCOL = 1;

export interface Peer { body: string; kind: string; nodeKey: string; version: string; online: boolean; lastSeen: number }
export interface IceServer { urls: string[]; username?: string; credential?: string }
export { serverOrigin, startBinding, pollBinding, unbind, type Binding, type BindStart, type SoulLink } from "./binding.ts";
import { serverOrigin, type Binding } from "./binding.ts";

// ---------- 同步服务消息的形状检查
const MAX_PEERS = 1000;
const str = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max;
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
/** 一具身体的登记；不合格返回 undefined。 */
export function peerOf(x: unknown): Peer | undefined {
  if (!isObj(x) || !str(x.body, 40) || !BODY_NAME.test(x.body) || !str(x.kind, 20)) return undefined;
  if (!(x.nodeKey === "" || x.nodeKey === undefined || isNodeKey(x.nodeKey))) return undefined;
  return { body: x.body, kind: x.kind, nodeKey: x.nodeKey ?? "", version: str(x.version, 64) ? x.version : "", online: x.online === true, lastSeen: num(x.lastSeen) ? x.lastSeen : 0 };
}
/** ICE 服务器列表：最多 10 个，每个最多 10 个 stun / turn / turns 地址。 */
export function iceOf(list: unknown): IceServer[] {
  if (!Array.isArray(list)) return [];
  const out: IceServer[] = [];
  for (const s of list.slice(0, 10)) {
    if (!isObj(s) || !Array.isArray(s.urls)) continue;
    const urls = s.urls.filter((u: unknown): u is string => str(u, 256) && /^(stun|turns?):/.test(u)).slice(0, 10);
    if (!urls.length) continue;
    out.push({ urls, ...(str(s.username, 256) ? { username: s.username } : {}), ...(str(s.credential, 256) ? { credential: s.credential } : {}) });
  }
  return out;
}
const ttlOf = (v: unknown) => (num(v) && v > 0 ? Math.min(v, 7 * 86400) : 0);

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
    ws.on("message", (raw) => {
      if (this.ws !== ws) return;
      let m: unknown;
      try { m = JSON.parse(raw.toString()); } catch { return; }
      try { if (isObj(m)) this.onMessage(m); } catch (e) { this.emit("error", `处理同步服务的消息出错（已丢弃）：${String((e as Error)?.message ?? e).slice(0, 200)}`); }
    });
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

  private onMessage(m: Record<string, any>) {
    switch (m.t) {
      case "welcome": {
        const peers = Array.isArray(m.peers) ? m.peers.slice(0, MAX_PEERS).map(peerOf).filter((p: Peer | undefined): p is Peer => !!p) : [];
        this.retry = 0; this.state = "online"; this.error = "";
        this.agent = { id: str(m.agent?.id, 200) ? m.agent.id : "", name: str(m.agent?.name, 200) ? m.agent.name : "" };
        this.account = str(m.account, 200) ? m.account : "";
        this.clockSkew = num(m.now) ? Date.now() - m.now : 0;
        this.peers = new Map(peers.map((p: Peer) => [p.body, p]));
        this.setIce(m.iceServers, m.ttl);
        this.emit("online");
        for (const p of this.peers.values()) this.emit("peer", p);
        return;
      }
      case "peer": {
        const p = peerOf(m.peer);
        if (!p || (!this.peers.has(p.body) && this.peers.size >= MAX_PEERS)) return;
        this.peers.set(p.body, p); this.emit("peer", p); return;
      }
      case "peer.removed": if (str(m.body, 40) && BODY_NAME.test(m.body)) { this.peers.delete(m.body); this.emit("peer.removed", m.body); } return;
      case "signal": if (str(m.from, 40) && BODY_NAME.test(m.from) && isObj(m.data)) this.emit("signal", { from: m.from, data: m.data }); return;
      case "turn": this.setIce(m.iceServers, m.ttl); return;
      case "bye": this.error = m.reason === "replaced" ? "同一具身体的另一条连接顶替了这条（是不是在两个地方运行了同一个家目录？）" : "这具身体已在同步服务上被解绑"; return;
      case "error": this.emit("error", m.code === "offline" && str(m.to, 40) && BODY_NAME.test(m.to) ? `${m.to} 不在线` : `同步服务：${typeof m.code === "string" ? m.code.replace(/[^\w.-]/g, "").slice(0, 40) : "未知错误"}`); return;
    }
  }

  /** 记下 ICE 服务器；TURN 凭据到 80% 有效期时自动刷新。 */
  private setIce(servers: unknown, ttl: unknown) {
    this.iceServers = iceOf(servers); this.iceIssued = Date.now(); this.iceTtl = ttlOf(ttl);
    clearTimeout(this.turnTimer);
    if (this.iceTtl > 0) { this.turnTimer = setTimeout(() => this.send({ t: "turn" }), this.iceTtl * 800); this.turnTimer.unref?.(); }
    this.emit("turn", this.iceServers);
  }

  private send(m: unknown) { if (this.ws?.readyState === WebSocket.OPEN) { this.ws.send(JSON.stringify(m)); return true; } return false; }
  signal(to: string, data: unknown) { return this.send({ t: "signal", to, data }); }

  close() { this.closed = true; clearTimeout(this.timer); clearTimeout(this.turnTimer); this.ws?.close(1000); this.state = "offline"; }
}
