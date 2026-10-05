// 两具身体之间的一条连接：WebRTC（node-datachannel / libdatachannel）。ICE 负责穿透（局域网、IPv6、STUN 反射地址，打不通走 TURN 中转），
// DTLS 负责加密，SCTP 数据通道负责可靠有序。信令（SDP 与候选）经同步服务转发，由发送方节点私钥签名；数据通道打开后，
// 双方再用节点密钥对两端的 DTLS 证书指纹做一次挑战与应答，确认通道另一端就是灵魂仓库登记的那具身体。
import { EventEmitter } from "node:events";
import crypto from "node:crypto";
import type { PeerConnection, DataChannel, IceServer as NdcIceServer } from "node-datachannel";
import { sign, verify, type NodeKey } from "./identity.ts";
import type { IceServer } from "./directory.ts";

export type Ndc = typeof import("node-datachannel");
export type LinkState = "idle" | "connecting" | "authenticating" | "open" | "closed";

const CHUNK = 48 * 1024;           // 单条 SCTP 消息上限之内
const MAX_MESSAGE = 32 << 20;      // 重组后的单条消息上限
const PING_MS = 15_000;
const DEAD_MS = 45_000;            // 这么久收不到任何东西就算断了
const CONNECT_TIMEOUT_MS = 30_000; // 建立连接（含认证）的时限

export interface LinkDeps {
  me: string;
  peer: string;
  key: NodeKey;
  peerKey: () => string | undefined;          // 灵魂仓库里登记的对方公钥
  iceServers: () => { servers: IceServer[]; issued: number; ttl: number };
  signal: (body: Record<string, unknown>) => void; // 签名并经同步服务发给对方
  ndc: Ndc;
  log: (msg: string) => void;
  relayOnly?: boolean;                          // 测试用：只走 TURN 中转
}

/** 把同步服务给的 ICE 服务器（WebRTC 的 RTCIceServer 格式）转成 libdatachannel 的格式。 */
export function toNdcIce(servers: IceServer[]): NdcIceServer[] {
  const out: NdcIceServer[] = [];
  for (const s of servers) for (const u of s.urls) {
    const m = u.match(/^(stun|turns?):(\[[^\]]+\]|[^:?]+)(?::(\d+))?(?:\?transport=(udp|tcp))?$/);
    if (!m) continue;
    const hostname = m[2].replace(/^\[|\]$/g, ""), port = Number(m[3] ?? (m[1] === "turns" ? 5349 : 3478));
    if (m[1] === "stun") out.push({ hostname, port });
    else out.push({ hostname, port, username: s.username, password: s.credential, relayType: m[1] === "turns" ? "TurnTls" : m[4] === "tcp" ? "TurnTcp" : "TurnUdp" });
  }
  return out;
}

/** SDP 里的 DTLS 证书指纹（a=fingerprint:sha-256 …），规范化为小写无冒号。 */
export const sdpFingerprint = (sdp: string | undefined) => (sdp?.match(/a=fingerprint:sha-256 ([0-9A-Fa-f:]+)/)?.[1] ?? "").replace(/:/g, "").toLowerCase();
/** 通道绑定串：谁签、给谁、对方的挑战、签名方与验证方各自的 DTLS 指纹。 */
const binding = (signer: string, verifier: string, nonce: string, signerFp: string, verifierFp: string) => `quetzal-mesh-auth/1|${signer}|${verifier}|${nonce}|${signerFp}|${verifierFp}`;

/**
 * 事件：open（认证通过、可以收发）、message（对象）、close（原因）、path（{local, remote, rtt}）。
 * 名字字典序较小的一方发起（发 offer），另一方应答；任何一方都可以请求重连（hello）。gen 区分每一次连接尝试，过期的信令直接丢弃。
 */
export class Link extends EventEmitter {
  state: LinkState = "idle";
  path: { local: string; remote: string; rtt: number } | undefined;
  lastError = "";
  readonly initiator: boolean;
  private d: LinkDeps;
  private pc?: PeerConnection;
  private dc?: DataChannel;
  private gen = "";
  private issued = 0;
  private challenge = "";
  private verified = false;
  private acked = false;
  private queue: string[] = [];
  private chunks = new Map<string, { parts: string[]; got: number; size: number }>();
  private lastSeen = 0;
  private pinger?: NodeJS.Timeout;
  private connectTimer?: NodeJS.Timeout;
  private retryTimer?: NodeJS.Timeout;
  private retries = 0;
  private stopped = false;
  private openedAt = 0;

  constructor(d: LinkDeps) {
    super();
    this.d = d;
    this.initiator = d.me < d.peer;
  }

  /** 开始（或重新开始）连接。发起方建立新的 PeerConnection 并发 offer；应答方请对方发起。 */
  start() {
    this.stopped = false;
    clearTimeout(this.retryTimer);
    if (this.initiator) this.open(crypto.randomUUID());
    else this.d.signal({ kind: "hello" });
  }

  private open(gen: string) {
    this.teardown();
    this.gen = gen;
    this.openedAt = Date.now();
    this.state = "connecting";
    this.verified = false; this.acked = false;
    const ice = this.d.iceServers();
    this.issued = ice.issued;
    const pc = new this.d.ndc.PeerConnection(`${this.d.me}->${this.d.peer}`, {
      iceServers: toNdcIce(ice.servers), iceTransportPolicy: this.d.relayOnly ? "relay" : "all", enableIceTcp: false,
    });
    this.pc = pc;
    pc.onLocalDescription((sdp, type) => { if (this.pc === pc) this.d.signal({ kind: "desc", gen, sdp, type }); });
    pc.onLocalCandidate((candidate, mid) => { if (this.pc === pc) this.d.signal({ kind: "cand", gen, candidate, mid }); });
    pc.onStateChange((s) => {
      if (this.pc !== pc) return;
      if (s === "connected") this.updatePath();
      if (s === "failed" || s === "closed" || s === "disconnected") this.fail(`连接${s === "failed" ? "失败" : "断开"}（${s}）`);
    });
    pc.onDataChannel((dc) => { if (this.pc === pc) this.attach(dc); });
    if (this.initiator) this.attach(pc.createDataChannel("quetzal", { protocol: "quetzal-mesh/1" }));
    clearTimeout(this.connectTimer);
    this.connectTimer = setTimeout(() => { if (this.pc === pc && this.state !== "open") this.fail("30 秒内没有连上"); }, CONNECT_TIMEOUT_MS);
    this.connectTimer.unref?.();
  }

  /** 收到对方经同步服务转来的、已验过签名的信令。 */
  onSignal(b: Record<string, unknown>) {
    if (this.stopped) return;
    switch (b.kind) {
      case "hello": // 对方请我发起（只有发起方处理）。对方发 hello 说明它那边没有连接（新启动或刚断开），即使我以为还连着也重来；2 秒内的重复请求忽略
        if (this.initiator && Date.now() - this.openedAt > 2000) this.open(crypto.randomUUID());
        return;
      case "desc": {
        const gen = String(b.gen ?? "");
        if (b.type === "offer") {
          if (this.initiator) return; // 双方都发起不会发生（发起方由名字决定），忽略异常的 offer
          if (gen !== this.gen) this.open(gen); // 新的一次连接尝试：丢掉旧的
          this.pc?.setRemoteDescription(String(b.sdp), "offer");
        } else if (b.type === "answer" && gen === this.gen) this.pc?.setRemoteDescription(String(b.sdp), "answer");
        return;
      }
      case "cand":
        if (String(b.gen ?? "") === this.gen && typeof b.candidate === "string") { try { this.pc?.addRemoteCandidate(b.candidate, String(b.mid ?? "0")); } catch {} }
        return;
      case "bye": this.fail("对方关闭了连接", true); return;
    }
  }

  private attach(dc: DataChannel) {
    this.dc = dc;
    dc.onOpen(() => {
      if (this.dc !== dc) return;
      this.state = "authenticating";
      this.lastSeen = Date.now();
      this.challenge = crypto.randomBytes(24).toString("base64url");
      this.raw({ t: "auth", nonce: this.challenge });
    });
    dc.onMessage((m) => { if (this.dc === dc) this.receive(typeof m === "string" ? m : Buffer.from(m as ArrayBuffer).toString("utf8")); });
    dc.onClosed(() => { if (this.dc === dc) this.fail("数据通道关闭"); });
    dc.onError((e) => { if (this.dc === dc) this.fail(`数据通道出错：${e}`); });
  }

  private fps() {
    return { local: sdpFingerprint(this.pc?.localDescription()?.sdp), remote: sdpFingerprint(this.pc?.remoteDescription()?.sdp) };
  }

  private receive(text: string) {
    this.lastSeen = Date.now();
    let m: any;
    try { m = JSON.parse(text); } catch { return; }
    if (m.t === "chunk") return this.reassemble(m);
    // 认证之前只处理认证消息
    if (m.t === "auth" && typeof m.nonce === "string" && m.nonce.length <= 64) {
      const { local, remote } = this.fps();
      return this.raw({ t: "auth.sig", sig: sign(this.d.key, binding(this.d.me, this.d.peer, m.nonce, local, remote)) });
    }
    if (m.t === "auth.sig") {
      const key = this.d.peerKey();
      const { local, remote } = this.fps();
      if (!key || !local || !remote || typeof m.sig !== "string" || !verify(key, binding(this.d.peer, this.d.me, this.challenge, remote, local), m.sig)) {
        return this.fail("对方没有通过节点密钥认证（与灵魂仓库登记的公钥不符，或 DTLS 指纹被替换）", true);
      }
      this.verified = true;
      this.raw({ t: "auth.ok" });
      return this.maybeOpen();
    }
    if (m.t === "auth.ok") { this.acked = true; return this.maybeOpen(); }
    if (this.state !== "open") return;
    if (m.t === "ping") return this.raw({ t: "pong", ts: m.ts });
    if (m.t === "pong") return;
    this.emit("message", m);
  }

  private maybeOpen() {
    if (!this.verified || !this.acked || this.state === "open") return;
    this.state = "open";
    this.retries = 0; this.lastError = "";
    clearTimeout(this.connectTimer);
    this.updatePath();
    clearInterval(this.pinger);
    this.pinger = setInterval(() => this.tick(), PING_MS);
    this.pinger.unref?.();
    for (const q of this.queue.splice(0)) this.write(q);
    this.emit("open");
  }

  private tick() {
    if (this.state !== "open") return;
    if (Date.now() - this.lastSeen > DEAD_MS) return this.fail("45 秒没有收到对方的任何消息");
    this.raw({ t: "ping", ts: Date.now() });
    this.updatePath();
    // 走 TURN 中转时，凭据到期后中转分配无法续期：在到期前（80%）由发起方用新凭据重建连接
    const ice = this.d.iceServers();
    if (this.initiator && this.path?.local === "relay" && ice.ttl && Date.now() - this.issued > ice.ttl * 800) {
      this.d.log(`${this.d.peer}：中转凭据快到期，重建连接`);
      this.open(crypto.randomUUID());
    }
  }

  private updatePath() {
    const p = this.pc?.getSelectedCandidatePair();
    if (!p) return;
    const next = { local: p.local.type, remote: p.remote.type, rtt: Math.round(this.pc?.rtt() ?? 0) };
    const changed = !this.path || next.local !== this.path.local || next.remote !== this.path.remote;
    this.path = next;
    if (changed) this.emit("path", next);
  }

  /** 发送一条消息（对象）。还没连上时排队（最多 500 条）。 */
  send(m: unknown): boolean {
    const text = JSON.stringify(m);
    if (text.length > MAX_MESSAGE) throw new Error("消息太大");
    if (this.state !== "open") { if (this.queue.length < 500) { this.queue.push(text); return true; } return false; }
    return this.write(text);
  }

  private raw(m: unknown) { try { this.dc?.sendMessage(JSON.stringify(m)); } catch {} }

  private write(text: string): boolean {
    if (!this.dc?.isOpen()) { this.queue.push(text); return false; }
    try {
      if (text.length <= CHUNK) return this.dc.sendMessage(text);
      const id = crypto.randomBytes(8).toString("hex"), n = Math.ceil(text.length / CHUNK);
      for (let i = 0; i < n; i++) this.dc.sendMessage(JSON.stringify({ t: "chunk", id, i, n, d: text.slice(i * CHUNK, (i + 1) * CHUNK) }));
      return true;
    } catch (e) { this.lastError = `发送失败：${(e as Error).message}`; return false; }
  }

  private reassemble(m: { id: string; i: number; n: number; d: string }) {
    if (typeof m.id !== "string" || !Number.isInteger(m.i) || !Number.isInteger(m.n) || m.n < 1 || m.n > MAX_MESSAGE / CHUNK + 1 || m.i < 0 || m.i >= m.n || typeof m.d !== "string") return;
    let c = this.chunks.get(m.id);
    if (!c) { if (this.chunks.size > 16) this.chunks.delete(this.chunks.keys().next().value!); c = { parts: new Array(m.n), got: 0, size: 0 }; this.chunks.set(m.id, c); }
    if (c.parts[m.i] !== undefined) return;
    c.parts[m.i] = m.d; c.got++; c.size += m.d.length;
    if (c.size > MAX_MESSAGE) { this.chunks.delete(m.id); return; }
    if (c.got === m.n) { this.chunks.delete(m.id); this.receive(c.parts.join("")); }
  }

  /** 连接失败：清理，按退避重试（1 秒到 1 分钟）。fatal 为真时（认证失败、对方主动关闭）等更久再试。 */
  private fail(reason: string, fatal = false) {
    if (this.state === "closed" && this.stopped) return;
    const was = this.state;
    this.lastError = reason;
    this.teardown();
    this.state = "idle";
    if (was === "open") this.emit("close", reason);
    if (this.stopped) return;
    const delay = fatal ? 5 * 60_000 : Math.min(60_000, 1000 * 2 ** this.retries++) * (0.5 + Math.random() / 2);
    this.d.log(`${this.d.peer}：${reason}，${Math.round(delay / 1000)} 秒后重试`);
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.start(), delay);
    this.retryTimer.unref?.();
  }

  private teardown() {
    clearInterval(this.pinger); clearTimeout(this.connectTimer);
    const pc = this.pc, dc = this.dc;
    this.pc = undefined; this.dc = undefined; this.path = undefined;
    // 不在 libdatachannel 的回调栈里同步销毁（可能触发原生层的重入）：推迟到下一轮事件循环
    setImmediate(() => { try { dc?.close(); } catch {} try { pc?.close(); } catch {} });
  }

  /** 对方下线或被解绑：停止并不再重试。 */
  stop(notify = false) {
    if (notify && this.state === "open") this.d.signal({ kind: "bye" });
    this.stopped = true;
    clearTimeout(this.retryTimer);
    const was = this.state;
    this.teardown();
    this.state = "closed";
    this.queue = [];
    if (was === "open") this.emit("close", "已停止");
  }
}
