// 网状层：同一个 agent 的所有在线身体两两直连（全连接网状网）。同步服务只负责在场与信令转发，
// 公钥以灵魂仓库为准；每条连接见 link.ts。对上提供：请求 / 应答（request / handle）、事件（emitTo / broadcast → "event"）、在场（"peer"）。
// 两种成员（DISTRIBUTED.md B4）：运行基座是正式成员，互相复制、选协调者、被调度；灵魂桥（Hermes / OpenClaw）是只读成员，
// 只能调用登记为可读的方法（看在场与会话），发来的事件一律丢弃，不参与广播、心跳与调度。身体的类型以灵魂仓库的登记为准：
// 同步服务或灵魂仓库任一方说它是灵魂桥，就只当只读成员。
// 首次见到的身体记下它的公钥与类型（钉住，TOFU）：之后公钥变了、或从灵魂桥变成运行基座，在控制台确认（acceptPin）之前不连。
// 对方（以及同步服务）发来的任何东西都不能让进程崩溃：所有由对方触发的回调都接住异常，记一笔丢掉。
// 网络变了（netwatch.ts）：信令连接走不通就立即重连，已连上的连接立刻探一次，没连上的退避清零立即重来。
// 同步服务说某具身体下线了：直连还通着就留着（它可能只是和同步服务断了），断了以后不再重试；它发来验过签名的连接请求就恢复。
// 直连打不通的两具身体经第三具身体中转（route.ts）：对上层来说它们照样「连着」（PeerStatus.via 是中转的身体）。
import { EventEmitter } from "node:events";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Directory, type Binding, type Peer } from "./directory.ts";
import { Link, type Ndc } from "./link.ts";
import { Opener, seal, fingerprint, BODY_NAME, type NodeKey } from "./identity.ts";
import { Router } from "./route.ts";
import { watchNetwork, localAddresses } from "./netwatch.ts";

export interface MeshOptions {
  me: string;
  key: NodeKey;
  ndc: Ndc;
  binding: Binding;
  agent?: string;                                 // 这个 agent 的 id（写进签名信封与通道认证；缺省取绑定时同步服务给的）
  keyOf: (body: string) => string | undefined;   // 灵魂仓库 bodies/<身体>.json 的 meshKey
  refreshKeys?: () => Promise<unknown>;           // 遇到没登记的身体时先拉取一次灵魂仓库（最快一分钟一次）
  kindOf?: (body: string) => string | undefined; // 灵魂仓库 bodies/<身体>.json 的 kind
  pins?: PinStore;                                // 钉住的公钥与类型（缺省只在内存里）
  reader?: boolean;                               // 这一端自己是只读成员（灵魂桥）：只连运行基座，不提供方法
  hello: () => { version: string; agentName?: string };
  log: (msg: string) => void;
  warn?: (msg: string) => void;                   // 安全相关的提醒（签名不符、公钥不一致），进时间线；已截断、限频
  relayOnly?: boolean;
  netEvents?: (cb: (detail: string) => void) => (() => void) | void; // 平台的网络变化通知（适配器的 onNetworkChange）
  watchNetwork?: boolean;                         // 监视网络变化（缺省开）
}

export type Handler = (params: any, from: string) => unknown | Promise<unknown>;
export interface PeerStatus {
  body: string; kind: string; version: string; online: boolean; lastSeen: number; link: string; path?: { local: string; remote: string; rtt: number }; error?: string;
  keyOk: boolean; registered: boolean; fingerprint: string; pinMismatch?: boolean;
  via?: string;                                   // 直连不通、经这具身体中转（此时 link 为 open）
  attempts: number; since: number; lastOpen: number; // 直连连续失败的次数、进入当前状态的时刻、最近一次直连上的时刻
  candidates?: { local: string[]; remote: string[] }; // 最近一次直连尝试双方交换过的候选类型（诊断：谁拿不到中转地址）
}

/** 钉住的身体：第一次见到时的公钥与类型。 */
export interface Pin { meshKey: string; kind: "runtime" | "bridge"; at: number }
export interface PinStore { get(body: string): Pin | undefined; set(body: string, pin: Pin | undefined): void }
export function memoryPins(): PinStore {
  const m = new Map<string, Pin>();
  return { get: (b) => m.get(b), set: (b, p) => { if (p) m.set(b, p); else m.delete(b); } };
}
/** 存在文件里的钉住记录（运行基座用 data/mesh-pins.json；不是秘密，只是公钥）。 */
export function filePins(file: string): PinStore {
  let all: Record<string, Pin> = {};
  try { const v = JSON.parse(fs.readFileSync(file, "utf8")); if (v && typeof v === "object") all = v; } catch {}
  const save = () => { try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(all, null, 2)); } catch {} };
  return {
    get: (b) => (Object.hasOwn(all, b) ? all[b] : undefined),
    set: (b, p) => { if (!BODY_NAME.test(b)) return; if (p) all[b] = p; else delete all[b]; if (Object.keys(all).length > 500) delete all[Object.keys(all)[0]]; save(); },
  };
}

const REQUEST_TIMEOUT_MS = 30_000;
const REFRESH_MIN_MS = 60_000;        // 因为没登记的身体而拉取灵魂仓库：最快一分钟一次
const READER_MAX_MESSAGE = 256 << 10; // 只读成员发来的单条消息上限
const KIND_CACHE_MS = 10_000;
const WARN_WINDOW_MS = 10 * 60_000, WARN_MAX = 20; // 提醒限频：10 分钟内最多 20 条

/** 给人看（也进时间线、会复制给其他身体）的外来字符串：单行、去掉控制字符、截断。 */
export function clip(s: unknown, n = 80): string {
  const t = textOf(s).replace(/[\p{Cc}\p{Cf}]+/gu, " ").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
}

/** 任意值转成文字，不会抛错（对方发来的对象可能带着不能调用的 toString）。 */
export function textOf(s: unknown): string {
  if (typeof s === "string") return s;
  if (s === null || s === undefined) return "";
  if (typeof s === "number" || typeof s === "boolean") return String(s);
  try { return JSON.stringify(s) ?? ""; } catch { return ""; }
}

/** 有上限的「见过」集合（按最近使用淘汰）。 */
class Recent {
  private m = new Map<string, true>();
  private cap: number;
  constructor(cap: number) { this.cap = cap; }
  has(k: string) { return this.m.has(k); }
  add(k: string) { this.m.delete(k); this.m.set(k, true); if (this.m.size > this.cap) this.m.delete(this.m.keys().next().value!); }
}

/** 事件：peer（PeerStatus：上线、下线、连上、断开、路径变化）、reader（只读成员的 PeerStatus）、event（{from, name, data}）、state（目录连接状态变化）。 */
export class Mesh extends EventEmitter {
  readonly dir: Directory;
  private o: MeshOptions;
  private agent: string;
  private links = new Map<string, Link>();
  private opener: Opener;
  private pins: PinStore;
  private handlers = new Map<string, Handler>();
  private readable = new Set<string>();   // 只读成员可以调用的方法
  private readers = new Set<string>();    // 连着的只读成员
  private mismatch = new Set<string>();   // 公钥或类型与钉住的不符、等待确认的身体
  private sigErrors = new Map<string, string>(); // 最近一次拒绝某具身体的连接请求的原因（控制台显示；认证通过后清掉）
  private pending = new Map<string, { body: string; resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private warned = new Recent(200);
  private warnTimes: number[] = [];
  private kinds = new Map<string, { kind: string | undefined; at: number }>();
  private lastRefresh = 0;
  private refreshing?: Promise<void>;
  private router?: Router;                // 经其他身体中转（只读成员没有）
  private unwatch?: () => void;

  constructor(o: MeshOptions) {
    super();
    this.o = o;
    this.agent = o.agent ?? o.binding.agent ?? "";
    this.pins = o.pins ?? memoryPins();
    this.opener = new Opener(o.me, this.agent, o.keyOf);
    this.dir = new Directory(o.binding, o.hello);
    this.dir.on("online", this.safe(() => this.fire("state")));
    this.dir.on("offline", this.safe(() => this.fire("state")));
    this.dir.on("revoked", this.safe((e: string) => { this.warn(clip(e, 200)); for (const l of this.links.values()) l.stop(); this.fire("state"); }));
    this.dir.on("error", this.safe((e: string) => this.o.log(clip(e, 200))));
    this.dir.on("peer", this.safe((p: Peer) => this.onPeer(p, true)));
    this.dir.on("peer.removed", this.safe((body: string) => { this.links.get(body)?.stop(); this.links.delete(body); this.router?.recompute(); this.fire(this.readers.delete(body) ? "reader" : "peer", { body, online: false, link: "closed" }); }));
    this.dir.on("signal", this.safe((s: { from: string; data: unknown }) => { this.onSignal(s.from, s.data).catch((e) => this.o.log(`处理 ${s.from} 的信令出错：${clip((e as Error)?.message, 200)}`)); }));
    if (!o.reader) this.router = new Router({
      me: o.me, agent: this.agent, key: o.key, keyOf: o.keyOf, log: o.log,
      eligible: (b) => this.routable(b), direct: () => this.directMembers(), send: (b, m) => this.sendDirect(b, m),
      deliver: (from, m) => this.dispatch(from, m, false), changed: (bodies) => bodies.forEach((b) => this.emitPeer(b)),
    });
  }

  start() {
    this.dir.connect();
    if (this.o.watchNetwork !== false) this.unwatch = watchNetwork({ onChange: (w) => this.onNetwork(w), target: () => this.dir.remoteAddress(), platform: this.o.netEvents });
  }
  stop() {
    this.unwatch?.(); this.unwatch = undefined;
    this.router?.stop();
    for (const l of this.links.values()) l.stop(true);
    this.links.clear();
    this.dir.close();
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error("网状层已停止")); }
    this.pending.clear();
  }

  /** 由对方触发的回调：异常接住，记一笔丢掉。 */
  private safe<A extends unknown[]>(f: (...a: A) => void): (...a: A) => void {
    return (...a: A) => { try { f(...a); } catch (e) { this.o.log(`网状层处理出错（已丢弃）：${clip((e as Error)?.message ?? e, 200)}`); } };
  }
  /** 逐个调用监听者，一个出错不影响别的、也不往上抛（异步监听者的拒绝同样接住）。 */
  private fire(name: string, ...args: unknown[]) {
    for (const l of this.listeners(name)) {
      try {
        const r = (l as (...a: unknown[]) => unknown)(...args);
        if (r && typeof (r as Promise<unknown>).then === "function") (r as Promise<unknown>).then(undefined, (e) => this.o.log(`网状层的 ${name} 处理出错（已丢弃）：${clip((e as Error)?.message ?? e, 200)}`));
      } catch (e) { this.o.log(`网状层的 ${name} 处理出错（已丢弃）：${clip((e as Error)?.message ?? e, 200)}`); }
    }
  }

  /** 安全提醒：截断、去重（最近 200 条）、限频。 */
  private warn(text: string, once?: string) {
    if (once) { if (this.warned.has(once)) return; this.warned.add(once); }
    const now = Date.now();
    this.warnTimes = this.warnTimes.filter((t) => now - t < WARN_WINDOW_MS);
    if (this.warnTimes.length >= WARN_MAX) { this.o.log(`（提醒太多，未进时间线）${clip(text, 300)}`); return; }
    this.warnTimes.push(now);
    this.o.warn?.(clip(text, 300));
  }

  /**
   * 网络变了（netwatch 报告，或测试直接调用）：信令连接走不通就立即重连；已连上的直连立刻探一次（本机地址没了、几秒没回音就重建），
   * 没连上的退避清零、立即重来。被停下的（对方不在线）不动。
   */
  onNetwork(why: string) {
    this.o.log(`网络变了（${why}）：检查各条连接`);
    const addrs = localAddresses();
    this.dir.checkPath(addrs).catch(() => {});
    for (const l of this.links.values()) { if (l.state === "open") l.probe(addrs); else if (l.state !== "closed") l.start(true, true); }
  }

  /** 同步服务的在场：fromDir 为真表示同步服务刚发来（重新连上时的整份名单、或这具身体上下线），没连上的连接退避清零、立即重来。 */
  private onPeer(p: Peer, fromDir = false) {
    if (p.body === this.o.me) return;
    // 同步服务转告的公钥与灵魂仓库登记的不一致：以灵魂仓库为准，并提醒（可能是重新绑定还没同步到，也可能有人冒充）
    const soulKey = this.o.keyOf(p.body);
    if (soulKey && p.nodeKey !== soulKey) this.warn(`同步服务上 ${p.body} 的节点公钥（${fingerprint(p.nodeKey)}）与灵魂仓库登记的（${fingerprint(soulKey)}）不一致：以灵魂仓库为准，连接时会核对`, `key:${p.body}:${p.nodeKey}`);
    if (!this.admit(p.body, p.kind)) {
      const l = this.links.get(p.body);
      if (l) { l.stop(); this.emitPeer(p.body); }
      return;
    }
    const link = this.link(p.body);
    if (p.online) { if (link.state === "idle" || link.state === "closed" || (fromDir && link.state !== "open")) link.start(fromDir); }
    else if (link.state === "open") link.probe(); // 直连还通着就探一次、通就留着：它可能只是和同步服务断了；不通则断开，之后不再重试（见 wantRetry）
    else link.stop();
    this.emitPeer(p.body);
  }

  /** 直连断开后还要不要再试：同步服务说它在线、或我们和同步服务断着（不知道）、或它两分钟内发来过信令。 */
  private wantRetry(body: string) {
    return this.dir.state !== "online" || !!this.dir.peers.get(body)?.online || Date.now() - (this.links.get(body)?.lastSignalAt ?? 0) < 120_000;
  }

  /** 可以经中转往来的身体：同步服务登记过、灵魂仓库登记了公钥、是正式成员、钉住的公钥与类型对得上。 */
  private routable(body: string): boolean {
    if (!BODY_NAME.test(body) || body === this.o.me || this.mismatch.has(body)) return false;
    const p = this.dir.peers.get(body);
    if (!p || !this.o.keyOf(body) || this.isReaderNow(body) || this.isReader(body, p.kind) !== false) return false;
    return this.checkPin(body, "runtime");
  }

  /** 这具身体能不能连、以什么身份连：类型认得、钉住的公钥与类型对得上。会更新只读成员的集合；类型变了就重连。 */
  private admit(body: string, dirKind: string): boolean {
    if (!BODY_NAME.test(body)) return false;
    const reader = this.isReader(body, dirKind);
    if (reader === undefined || (reader && this.o.reader)) return false; // 不认识的类型不连；只读成员之间不连
    if (!this.checkPin(body, reader ? "bridge" : "runtime")) return false;
    const was = this.readers.has(body);
    if (reader) this.readers.add(body); else this.readers.delete(body);
    const l = this.links.get(body);
    if (l && was !== reader && l.state !== "idle" && l.state !== "closed") { l.stop(); l.start(); }
    return true;
  }

  /** 钉住（TOFU）：第一次见到就记下公钥与类型；之后公钥变了、或从灵魂桥变成运行基座，要在控制台确认（acceptPin）。降为灵魂桥无害，直接记下。 */
  private checkPin(body: string, kind: "runtime" | "bridge"): boolean {
    const key = this.o.keyOf(body);
    if (!key) return true; // 灵魂仓库里没登记公钥：连接认证本来就过不了，不必钉
    const pin = this.pins.get(body);
    if (!pin) { this.pins.set(body, { meshKey: key, kind, at: Date.now() }); this.mismatch.delete(body); return true; }
    const keyChanged = pin.meshKey !== key, upgraded = pin.kind === "bridge" && kind === "runtime";
    if (keyChanged || upgraded) {
      if (!this.mismatch.has(body)) {
        this.mismatch.add(body);
        this.warn(keyChanged
          ? `灵魂仓库里 ${body} 的节点公钥变了（原来 ${fingerprint(pin.meshKey)}，现在 ${fingerprint(key)}）：确认是重装或换了密钥之前不和它连接（控制台确认后恢复）`
          : `${body} 从灵魂桥变成了运行基座：确认之前不和它连接（控制台确认后恢复）`);
      }
      return false;
    }
    if (pin.kind === "runtime" && kind === "bridge") this.pins.set(body, { ...pin, kind: "bridge" });
    this.mismatch.delete(body);
    return true;
  }

  /** 确认某具身体新的公钥 / 类型（钉住现在灵魂仓库里登记的），并重新连接。 */
  acceptPin(body: string): PeerStatus {
    this.pins.set(body, undefined);
    this.mismatch.delete(body);
    this.kinds.delete(body);
    const p = this.dir.peers.get(body);
    if (p) this.onPeer(p);
    this.router?.recompute();
    return this.peerStatus(body);
  }

  /**
   * 灵魂仓库更新之后：核对每条连接认证时用的公钥是否还是登记的那把，不是就断开；并按新的登记重新分类、核对钉住的公钥。
   * 运行基座在每次拉取灵魂仓库后调用。
   */
  reverify() {
    this.kinds.clear();
    for (const [body, l] of this.links) {
      try {
        const key = this.o.keyOf(body);
        if (l.authKey && l.authKey !== key && l.state !== "idle" && l.state !== "closed") {
          this.o.log(`灵魂仓库里 ${body} 的节点公钥${key ? "换了" : "没有了"}：断开现有连接`);
          l.stop();
        }
        const p = this.dir.peers.get(body);
        if (p) this.onPeer(p);
      } catch (e) { this.o.log(`核对 ${body} 出错：${clip((e as Error)?.message, 200)}`); }
    }
    this.router?.recompute();
  }

  /** 这具身体是不是只读成员：同步服务与灵魂仓库都说是运行基座才算正式成员；任一方说是灵魂桥就是只读成员；都不是则 undefined。 */
  private isReader(body: string, dirKind: string): boolean | undefined {
    const soulKind = this.soulKind(body);
    if (dirKind === "bridge" || soulKind === "bridge") return true;
    if (dirKind === "runtime" && (soulKind === undefined || soulKind === "runtime")) return false;
    return undefined;
  }
  /** 收发每条消息时的判断：曾被认作只读成员、灵魂仓库说是灵魂桥、或钉住的是灵魂桥，都按只读成员对待。 */
  private isReaderNow(body: string) { return this.readers.has(body) || this.soulKind(body) === "bridge" || this.pins.get(body)?.kind === "bridge"; }
  private soulKind(body: string): string | undefined {
    if (!this.o.kindOf) return undefined;
    const c = this.kinds.get(body), now = Date.now();
    if (c && now - c.at < KIND_CACHE_MS) return c.kind;
    const kind = this.o.kindOf(body);
    this.kinds.set(body, { kind, at: now });
    if (this.kinds.size > 500) this.kinds.delete(this.kinds.keys().next().value!);
    return kind;
  }
  private emitPeer(body: string) { this.fire(this.readers.has(body) ? "reader" : "peer", this.peerStatus(body)); }

  private link(body: string): Link {
    let l = this.links.get(body);
    if (l) return l;
    l = new Link({
      me: this.o.me, peer: body, agent: this.agent, key: this.o.key, ndc: this.o.ndc, relayOnly: this.o.relayOnly,
      peerKey: () => this.o.keyOf(body),
      iceServers: () => ({ servers: this.dir.iceServers, issued: this.dir.iceIssued, ttl: this.dir.iceTtl }),
      signal: (b) => { this.dir.signal(body, seal(this.o.key, this.agent, this.o.me, body, b)); },
      log: (m) => this.o.log(m),
      maxMessage: () => (this.isReaderNow(body) ? READER_MAX_MESSAGE : 32 << 20),
      shouldRetry: () => this.wantRetry(body),
    });
    l.on("open", () => {
      this.o.log(`与 ${body} 连上了（${l!.path?.local ?? "?"}↔${l!.path?.remote ?? "?"}）${this.readers.has(body) ? "（只读成员）" : ""}`);
      if (this.router && !this.isReaderNow(body)) { this.router.recompute(); this.router.greet(body); this.router.topologyChanged(); }
      this.emitPeer(body);
    });
    l.on("close", (why: string) => {
      this.o.log(`与 ${body} 断开：${why}`);
      this.router?.recompute(); // 先算出能不能经别的身体中转：能的话对上层来说它一直连着，不闪断
      this.router?.topologyChanged();
      this.emitPeer(body);
    });
    l.on("path", () => this.emitPeer(body));
    l.on("retry", () => this.emitPeer(body));
    l.on("message", (m: Record<string, unknown>) => {
      try { this.onMessage(body, m); } catch (e) { this.o.log(`处理 ${body} 的消息出错（已丢弃）：${clip((e as Error)?.message, 200)}`); }
    });
    this.links.set(body, l);
    return l;
  }

  private async onSignal(from: string, data: unknown, retried = false): Promise<void> {
    // 只处理已经认得的身体（同步服务登记过、类型认得、钉住的公钥对得上）：不认识的直接丢弃，不去拉灵魂仓库
    if (this.mismatch.has(from)) return;
    if (!this.links.has(from)) { const p = this.dir.peers.get(from); if (!p || !this.admit(from, p.kind)) return; }
    const r = this.opener.open(data);
    if (!r.ok) {
      if (!retried && r.unknown && (await this.refresh())) return this.onSignal(from, data, true);
      this.warn(`拒绝了来自 ${clip(from, 40)} 的信令：${clip(r.error, 120)}`, `sig:${from}:${r.error}`);
      this.sigErrors.set(from, `拒绝了它的连接请求：${clip(r.error, 120)}`);
      return;
    }
    if (r.env.from !== from) return; // 同步服务标注的来源与签名的来源不一致：丢弃
    this.sigErrors.delete(from);
    const l = this.link(from), b = r.env.body;
    if (l.state === "closed" && (b.kind === "hello" || (b.kind === "desc" && b.type === "offer"))) {
      // 被停下的连接（同步服务说过它下线了）：它发来了验过签名的连接请求，说明它此刻在线（同步服务的通知可能还在路上，或我们漏了）
      const p = this.dir.peers.get(from);
      if (this.dir.state === "unauthorized" || !p || !this.admit(from, p.kind)) return;
      l.resume();
    }
    l.onSignal(b);
  }

  /** 拉取一次灵魂仓库（遇到没登记的身体时）：最快一分钟一次，同时只有一次。返回是否真的拉了。 */
  private async refresh(): Promise<boolean> {
    if (!this.o.refreshKeys) return false;
    if (this.refreshing) { await this.refreshing; return true; }
    if (Date.now() - this.lastRefresh < REFRESH_MIN_MS) return false;
    this.lastRefresh = Date.now();
    this.refreshing = Promise.resolve().then(() => this.o.refreshKeys!()).then(() => {}, () => {}).finally(() => { this.refreshing = undefined; });
    await this.refreshing;
    this.reverify();
    return true;
  }

  // ---------- 消息：req / res / ev（以及中转用的 rt / fwd，见 route.ts）
  private onMessage(from: string, m: Record<string, unknown>) {
    const reader = this.isReaderNow(from);
    if (m.t === "rt" || m.t === "fwd") { if (!reader && this.router) this.router.onMessage(from, m); return; } // 只读成员不参与中转
    this.dispatch(from, m, reader);
  }

  /** 处理一条请求 / 回应 / 事件：from 是直连认证过的对端，或经中转验过签名的发出者。 */
  private dispatch(from: string, m: Record<string, unknown>, reader: boolean) {
    if (m.t === "req" && typeof m.id === "string" && m.id.length <= 64 && typeof m.m === "string" && m.m.length <= 100) {
      if (this.o.reader) return; // 只读成员不提供方法
      const id = m.id, method = m.m;
      const h = reader && !this.readable.has(method) ? undefined : this.handlers.get(method);
      const reply = (ok: boolean, v: unknown) => {
        try { this.sendTo(from, { t: "res", id, ok, ...(ok ? { r: v } : { e: clip(v, 2000) }) }); }
        catch (e) { try { this.sendTo(from, { t: "res", id, ok: false, e: clip((e as Error).message, 200) }); } catch {} }
      };
      if (!h) return reply(false, reader && this.handlers.has(method) ? `只读成员不能调用 ${method}` : `没有这个方法：${clip(method, 100)}`);
      Promise.resolve().then(() => h(m.p, from)).then((v) => reply(true, v ?? null), (e) => reply(false, (e as Error)?.message ?? e));
      return;
    }
    if (m.t === "res" && typeof m.id === "string") {
      const p = this.pending.get(m.id);
      if (!p || p.body !== from) return; // 只认发给它的那具身体的回应
      this.pending.delete(m.id); clearTimeout(p.timer);
      return m.ok ? p.resolve(m.r) : p.reject(new Error(clip(m.e, 2000)));
    }
    if (m.t === "ev" && typeof m.e === "string" && m.e.length <= 100 && !reader) this.fire("event", { from, name: m.e, data: m.d }); // 只读成员发来的事件丢弃
  }

  /** 注册一个可以被其他身体调用的方法；readable 为真时只读成员（灵魂桥）也可以调用——只给不改变任何状态的方法。 */
  handle(method: string, fn: Handler, readable = false) { this.handlers.set(method, fn); if (readable) this.readable.add(method); }

  /** 发给某具身体：直连通着走直连；不通但经中转可达就经中转；直连正在连就排队等它连上。返回是否发出（或排进队列）。 */
  private sendTo(body: string, m: Record<string, unknown>): boolean {
    const l = this.links.get(body);
    if (l?.state === "open") return l.send(m);
    if (this.router?.via(body) && !this.isReaderNow(body)) return this.router.sendVia(body, m);
    return !!l && l.state !== "closed" && l.send(m);
  }
  /** 只经直连发（中转自己用）：没连上就不发。 */
  private sendDirect(body: string, m: Record<string, unknown>): boolean {
    const l = this.links.get(body);
    if (l?.state !== "open") return false;
    try { return l.send(m); } catch (e) { this.o.log(`发给 ${body} 失败：${clip((e as Error).message, 200)}`); return false; }
  }
  /** 此刻直连着的正式成员。 */
  private directMembers(): string[] { return [...this.links].filter(([b, l]) => l.state === "open" && !this.isReaderNow(b)).map(([b]) => b); }

  /** 调用另一具身体上的方法（对方必须在线且连上，直连或经中转；直连没连上会排队等待，直到超时）。 */
  request<T = unknown>(body: string, method: string, params?: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
    const l = this.links.get(body);
    if ((!l || l.state === "closed") && !(this.router?.via(body) && !this.isReaderNow(body))) return Promise.reject(new Error(`${body} 不在网上`));
    const id = crypto.randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${body} 在 ${Math.round(timeoutMs / 1000)} 秒内没有回应 ${method}`)); }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { body, resolve: resolve as (v: unknown) => void, reject, timer });
      let sent = false;
      try { sent = this.sendTo(body, { t: "req", id, m: method, p: params }); } catch (e) { this.pending.delete(id); clearTimeout(timer); return reject(e as Error); }
      if (!sent) { this.pending.delete(id); clearTimeout(timer); reject(new Error(`发给 ${body} 失败`)); }
    });
  }

  /** 发一个事件给某具身体 / 所有连上的身体（直连或经中转）。 */
  emitTo(body: string, name: string, data?: unknown) { try { return this.sendTo(body, { t: "ev", e: name, d: data }); } catch { return false; } }
  broadcast(name: string, data?: unknown) { for (const b of this.connected()) { try { this.sendTo(b, { t: "ev", e: name, d: data }); } catch (e) { this.o.log(`广播 ${name} 给 ${b} 失败：${clip((e as Error).message, 200)}`); } } }

  /** 此刻连上的正式成员（运行基座）：直连的，加上直连不通、经中转可达的。只读成员不在其中：不被调度、不选协调者、不收广播。 */
  connected(): string[] {
    const out = this.directMembers();
    for (const b of this.router?.reachable() ?? []) if (!out.includes(b)) out.push(b);
    return out;
  }
  /** 此刻连上的只读成员（灵魂桥）。 */
  connectedReaders(): string[] { return [...this.links].filter(([b, l]) => l.state === "open" && this.isReaderNow(b)).map(([b]) => b); }

  peerStatus(body: string): PeerStatus {
    const p = this.dir.peers.get(body), l = this.links.get(body), soulKey = this.o.keyOf(body), mismatch = this.mismatch.has(body);
    const direct = l?.state === "open", via = direct || this.isReaderNow(body) ? undefined : this.router?.via(body);
    const cands = l?.candidates();
    return {
      body, kind: this.readers.has(body) ? "bridge" : p?.kind ?? "", version: p?.version ?? "", online: !!p?.online || direct || !!via, lastSeen: p?.lastSeen ?? 0,
      link: direct || via ? "open" : l?.state ?? "none", path: l?.path, error: l?.lastError || this.sigErrors.get(body) || undefined,
      keyOk: !!soulKey && soulKey === p?.nodeKey && !mismatch, registered: !!soulKey, fingerprint: p?.nodeKey ? fingerprint(p.nodeKey) : "",
      ...(mismatch ? { pinMismatch: true } : {}), ...(via ? { via } : {}),
      attempts: l?.attempts ?? 0, since: l?.since ?? 0, lastOpen: l?.lastOpen ?? 0,
      ...(cands && (cands.local.length || cands.remote.length) ? { candidates: cands } : {}),
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
