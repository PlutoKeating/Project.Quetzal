// 网状层：同一个 agent 的所有在线身体两两直连（全连接网状网）。同步服务只负责在场与信令转发，
// 公钥以灵魂仓库为准；每条连接见 link.ts。对上提供：请求 / 应答（request / handle）、事件（emitTo / broadcast → "event"）、在场（"peer"）。
import { EventEmitter } from "node:events";
import crypto from "node:crypto";
import { Directory, type Binding, type Peer } from "./directory.ts";
import { Link, type Ndc } from "./link.ts";
import { Opener, seal, fingerprint, type NodeKey } from "./identity.ts";

export interface MeshOptions {
  me: string;
  key: NodeKey;
  ndc: Ndc;
  binding: Binding;
  keyOf: (body: string) => string | undefined;   // 灵魂仓库 bodies/<身体>.json 的 meshKey
  refreshKeys?: () => Promise<unknown>;           // 遇到没登记的身体时先拉取一次灵魂仓库
  hello: () => { version: string; agentName?: string };
  log: (msg: string) => void;
  warn?: (msg: string) => void;                   // 安全相关的提醒（签名不符、公钥不一致），进时间线
  relayOnly?: boolean;
}

export type Handler = (params: any, from: string) => unknown | Promise<unknown>;
export interface PeerStatus { body: string; kind: string; version: string; online: boolean; lastSeen: number; link: string; path?: { local: string; remote: string; rtt: number }; error?: string; keyOk: boolean; fingerprint: string }

const REQUEST_TIMEOUT_MS = 30_000;

/** 事件：peer（PeerStatus：上线、下线、连上、断开、路径变化）、event（{from, name, data}）、state（目录连接状态变化）。 */
export class Mesh extends EventEmitter {
  readonly dir: Directory;
  private o: MeshOptions;
  private links = new Map<string, Link>();
  private opener: Opener;
  private handlers = new Map<string, Handler>();
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private warned = new Set<string>();

  constructor(o: MeshOptions) {
    super();
    this.o = o;
    this.opener = new Opener(o.me, o.keyOf);
    this.dir = new Directory(o.binding, o.hello);
    this.dir.on("online", () => this.emit("state"));
    this.dir.on("offline", () => this.emit("state"));
    this.dir.on("revoked", (e: string) => { this.o.warn?.(e); for (const l of this.links.values()) l.stop(); this.emit("state"); });
    this.dir.on("error", (e: string) => this.o.log(e));
    this.dir.on("peer", (p: Peer) => this.onPeer(p));
    this.dir.on("peer.removed", (body: string) => { this.links.get(body)?.stop(); this.links.delete(body); this.emit("peer", { body, online: false, link: "closed" }); });
    this.dir.on("signal", (s: { from: string; data: unknown }) => void this.onSignal(s.from, s.data));
  }

  start() { this.dir.connect(); }
  stop() {
    for (const l of this.links.values()) l.stop(true);
    this.links.clear();
    this.dir.close();
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error("网状层已停止")); }
    this.pending.clear();
  }

  private onPeer(p: Peer) {
    if (p.body === this.o.me) return;
    // 同步服务转告的公钥与灵魂仓库登记的不一致：以灵魂仓库为准，并提醒（可能是重新绑定还没同步到，也可能有人冒充）
    const soulKey = this.o.keyOf(p.body);
    if (soulKey && p.nodeKey !== soulKey && !this.warned.has(`key:${p.body}:${p.nodeKey}`)) {
      this.warned.add(`key:${p.body}:${p.nodeKey}`);
      this.o.warn?.(`同步服务上 ${p.body} 的节点公钥（${fingerprint(p.nodeKey)}）与灵魂仓库登记的（${fingerprint(soulKey)}）不一致：以灵魂仓库为准，连接时会核对`);
    }
    // 目前只与运行基座直连；灵魂桥（只读成员）以后接入网状层
    if (p.kind !== "runtime") return;
    const link = this.link(p.body);
    if (p.online) { if (link.state === "idle" || link.state === "closed") link.start(); }
    else link.stop();
    this.emit("peer", this.peerStatus(p.body));
  }

  private link(body: string): Link {
    let l = this.links.get(body);
    if (l) return l;
    l = new Link({
      me: this.o.me, peer: body, key: this.o.key, ndc: this.o.ndc, relayOnly: this.o.relayOnly,
      peerKey: () => this.o.keyOf(body),
      iceServers: () => ({ servers: this.dir.iceServers, issued: this.dir.iceIssued, ttl: this.dir.iceTtl }),
      signal: (b) => { this.dir.signal(body, seal(this.o.key, this.o.me, body, b)); },
      log: (m) => this.o.log(m),
    });
    l.on("open", () => { this.o.log(`与 ${body} 连上了（${l!.path?.local ?? "?"}↔${l!.path?.remote ?? "?"}）`); this.emit("peer", this.peerStatus(body)); });
    l.on("close", (why: string) => { this.o.log(`与 ${body} 断开：${why}`); this.emit("peer", this.peerStatus(body)); });
    l.on("path", () => this.emit("peer", this.peerStatus(body)));
    l.on("message", (m: any) => this.onMessage(body, m));
    this.links.set(body, l);
    return l;
  }

  private async onSignal(from: string, data: unknown, retried = false): Promise<void> {
    const r = this.opener.open(data);
    if (!r.ok) {
      if (!retried && /没有登记/.test(r.error) && this.o.refreshKeys) { await this.o.refreshKeys().catch(() => {}); return this.onSignal(from, data, true); }
      const k = `sig:${from}:${r.error}`;
      if (!this.warned.has(k)) { this.warned.add(k); this.o.warn?.(`拒绝了来自 ${from} 的信令：${r.error}`); }
      return;
    }
    if (r.env.from !== from) return; // 同步服务标注的来源与签名的来源不一致：丢弃
    this.link(from).onSignal(r.env.body);
  }

  // ---------- 消息：req / res / ev
  private onMessage(from: string, m: any) {
    if (m.t === "req" && typeof m.id === "string" && typeof m.m === "string") {
      const h = this.handlers.get(m.m);
      const reply = (ok: boolean, v: unknown) => this.links.get(from)?.send({ t: "res", id: m.id, ok, ...(ok ? { r: v } : { e: String(v) }) });
      if (!h) return reply(false, `没有这个方法：${m.m}`);
      Promise.resolve().then(() => h(m.p, from)).then((v) => reply(true, v ?? null), (e) => reply(false, (e as Error).message ?? e));
      return;
    }
    if (m.t === "res" && typeof m.id === "string") {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id); clearTimeout(p.timer);
      return m.ok ? p.resolve(m.r) : p.reject(new Error(String(m.e)));
    }
    if (m.t === "ev" && typeof m.e === "string") this.emit("event", { from, name: m.e, data: m.d });
  }

  /** 注册一个可以被其他身体调用的方法。 */
  handle(method: string, fn: Handler) { this.handlers.set(method, fn); }

  /** 调用另一具身体上的方法（对方必须在线且连上；没连上会排队等待，直到超时）。 */
  request<T = unknown>(body: string, method: string, params?: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
    const l = this.links.get(body);
    if (!l || l.state === "closed") return Promise.reject(new Error(`${body} 不在网上`));
    const id = crypto.randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${body} 在 ${Math.round(timeoutMs / 1000)} 秒内没有回应 ${method}`)); }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      if (!l.send({ t: "req", id, m: method, p: params })) { this.pending.delete(id); clearTimeout(timer); reject(new Error(`发给 ${body} 失败`)); }
    });
  }

  /** 发一个事件给某具身体 / 所有连上的身体。 */
  emitTo(body: string, name: string, data?: unknown) { return this.links.get(body)?.send({ t: "ev", e: name, d: data }) ?? false; }
  broadcast(name: string, data?: unknown) { for (const [b, l] of this.links) if (l.state === "open") l.send({ t: "ev", e: name, d: data }); }

  /** 此刻连上的身体。 */
  connected(): string[] { return [...this.links].filter(([, l]) => l.state === "open").map(([b]) => b); }

  peerStatus(body: string): PeerStatus {
    const p = this.dir.peers.get(body), l = this.links.get(body), soulKey = this.o.keyOf(body);
    return {
      body, kind: p?.kind ?? "", version: p?.version ?? "", online: !!p?.online, lastSeen: p?.lastSeen ?? 0,
      link: l?.state ?? "none", path: l?.path, error: l?.lastError || undefined,
      keyOk: !!soulKey && soulKey === p?.nodeKey, fingerprint: p?.nodeKey ? fingerprint(p.nodeKey) : "",
    };
  }

  status() {
    return {
      state: this.dir.state, error: this.dir.error, account: this.dir.account, agent: this.dir.agent, server: this.o.binding.server,
      clockSkewMs: this.dir.clockSkew,
      peers: [...this.dir.peers.keys()].filter((b) => b !== this.o.me).sort().map((b) => this.peerStatus(b)),
    };
  }
}
