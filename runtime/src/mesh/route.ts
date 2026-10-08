// 经其他身体中转：两具身体之间打不通直连时（运营商级 NAT、UDP 被挡、中转服务器连不上），只要它们都连得上第三具身体，
// 消息就经它转过去。整个网仍是一个连通的整体：一位协调者、同一份在场与对话，不再分裂成几个互不相通的子网。
//   - 拓扑（链路状态）：每具身体把「此刻直连着哪些正式成员」签名后发给邻居，收到更新的就转给其他邻居（洪泛；按 (启动时刻, 序号) 只收更新的）。
//     连接变了立即发，平时每 30 秒刷新一次，90 秒没刷新的作废。两边都说连着对方才算一条边。
//     每具身体按同一张图求最短路（同样长时按名字），得到去往每具身体的下一跳；直连通的始终走直连。
//   - 转发：消息装进由发出者节点私钥签名的信封（谁发、发给谁、时间、随机数、内容原文的 sha256），中间的身体只按收件人往下转（最多 8 跳）。
//     收件人用灵魂仓库里登记的公钥验签，查时间窗（±5 分钟，且不早于本次启动前一分钟）与随机数（防重放），再当作发出者直接发来的处理。
//     所以中转的身体改不了、也冒充不了别的身体的消息。内容对中转的身体可见：同一个 agent 的身体彼此完全信任（DISTRIBUTED.md §6.1），
//     本来就复制着同样的对话与设置。
//   - 只读成员（灵魂桥）不参与：不中转、不经中转收发。版本较旧、不发拓扑的身体只走直连。
import crypto from "node:crypto";
import { sign, verify, BODY_NAME, type NodeKey } from "./identity.ts";

export const ROUTE_PROTOCOL = 1;
const ADVERT_MS = 30_000;            // 刷新自己的拓扑
const ADVERT_TTL_MS = 90_000;        // 这么久没刷新的拓扑作废
const MAX_NEIGHBORS = 64;
const MAX_HOPS = 8;
const WINDOW_MS = 5 * 60_000;        // 信封的时间窗
export const MAX_FORWARD = 24 << 20; // 经中转的单条消息上限（原文；装进信封再转义后仍在单条 32 MB 之内）
const NONCES = 20_000;

export interface RouterDeps {
  me: string;
  agent: string;
  key: NodeKey;
  keyOf: (body: string) => string | undefined;          // 灵魂仓库里登记的公钥
  eligible: (body: string) => boolean;                  // 可以经中转往来的身体：同步服务登记过的正式成员，公钥与钉住的一致
  direct: () => string[];                               // 此刻直连着的正式成员
  send: (body: string, m: Record<string, unknown>) => boolean; // 经直连发给邻居
  deliver: (from: string, m: Record<string, unknown>) => void;  // 发给自己的、验过签名的消息
  changed: (bodies: string[]) => void;                  // 这些身体经中转的可达性或下一跳变了
  log: (msg: string) => void;
}

interface Advert { s: number; q: number; n: string[]; sig: string; at: number }

const advertText = (agent: string, o: string, s: number, q: number, n: string[]) => `quetzal-mesh-route/${ROUTE_PROTOCOL}|${agent}|${o}|${s}|${q}|${n.join(",")}`;
const fwdText = (agent: string, o: string, d: string, ts: number, nonce: string, p: string) =>
  `quetzal-mesh-fwd/${ROUTE_PROTOCOL}|${agent}|${o}|${d}|${ts}|${nonce}|${crypto.createHash("sha256").update(p).digest("hex")}`;
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export class Router {
  private d: RouterDeps;
  private started = Date.now();
  private seq = 0;
  private adverts = new Map<string, Advert>();
  private next = new Map<string, string>();   // 经中转可达的身体 → 下一跳（不含直连的）
  private nonces = new Map<string, number>();
  private timer: NodeJS.Timeout;
  private soon?: NodeJS.Timeout;
  private dropped = 0;
  private stopped = false;

  constructor(d: RouterDeps) {
    this.d = d;
    this.timer = setInterval(() => this.tick(), ADVERT_MS);
    this.timer.unref?.();
  }
  stop() { this.stopped = true; clearInterval(this.timer); clearTimeout(this.soon); this.adverts.clear(); this.next.clear(); }

  /** 去往 body 的下一跳（只在直连不通、经中转可达时有值）。 */
  via(body: string): string | undefined { return this.next.get(body); }
  /** 经中转可达的身体。 */
  reachable(): string[] { return [...this.next.keys()]; }

  /** 直连的集合变了（某条连接连上或断开）：稍后（合并 200 毫秒内的变化）发出新的拓扑并重算路由。 */
  topologyChanged() {
    if (this.stopped) return;
    clearTimeout(this.soon);
    this.soon = setTimeout(() => { this.advertise(); this.recompute(); }, 200);
    this.soon.unref?.();
  }

  /** 新连上一个邻居：把自己的与知道的拓扑都给它，它不必等下一次刷新。 */
  greet(body: string) {
    this.d.send(body, this.own());
    for (const [o, a] of this.adverts) if (o !== body) this.d.send(body, { t: "rt", o, s: a.s, q: a.q, n: a.n, sig: a.sig });
  }

  private own() {
    const n = this.d.direct().filter((b) => BODY_NAME.test(b)).sort().slice(0, MAX_NEIGHBORS);
    return { t: "rt", o: this.d.me, s: this.started, q: this.seq, n, sig: sign(this.d.key, advertText(this.d.agent, this.d.me, this.started, this.seq, n)) };
  }
  private advertise() {
    this.seq++;
    const m = this.own();
    for (const b of this.d.direct()) this.d.send(b, m);
  }

  private tick() {
    const now = Date.now();
    let gone = false;
    for (const [o, a] of this.adverts) if (now - a.at > ADVERT_TTL_MS) { this.adverts.delete(o); gone = true; }
    for (const [n, at] of this.nonces) if (now - at > 2 * WINDOW_MS) this.nonces.delete(n);
    this.advertise();
    if (gone) this.recompute();
  }

  /** 处理邻居发来的拓扑（rt）与转发信封（fwd）；是这两种就返回 true。from 是直连认证过的邻居（正式成员）。 */
  onMessage(from: string, m: Record<string, unknown>): boolean {
    if (m.t === "rt") { this.onAdvert(from, m); return true; }
    if (m.t === "fwd") { this.onForward(from, m); return true; }
    return false;
  }

  private onAdvert(from: string, m: Record<string, unknown>) {
    const { o, s, q, n, sig } = m;
    if (typeof o !== "string" || !BODY_NAME.test(o) || o === this.d.me || !isNum(s) || !Number.isSafeInteger(q) || typeof sig !== "string" || sig.length > 200) return;
    if (!Array.isArray(n) || n.length > MAX_NEIGHBORS || !n.every((x) => typeof x === "string" && BODY_NAME.test(x))) return;
    if (s > Date.now() + WINDOW_MS) return;
    const old = this.adverts.get(o);
    if (old && (s < old.s || (s === old.s && (q as number) <= old.q))) return;
    if (!this.d.eligible(o)) return;
    const key = this.d.keyOf(o);
    if (!key || !verify(key, advertText(this.d.agent, o, s, q as number, n as string[]), sig)) return;
    const changed = !old || old.n.join(",") !== (n as string[]).join(",");
    this.adverts.set(o, { s, q: q as number, n: n as string[], sig, at: Date.now() });
    for (const b of this.d.direct()) if (b !== from && b !== o) this.d.send(b, { t: "rt", o, s, q, n, sig });
    if (changed) this.recompute();
  }

  /** 按拓扑求最短路（广度优先，邻居按名字排序，所以每具身体算出同样的路），更新经中转可达的身体与下一跳。 */
  recompute() {
    if (this.stopped) return;
    const me = this.d.me, direct = new Set(this.d.direct());
    const adj = (u: string): string[] => (u === me ? [...direct] : this.adverts.get(u)?.n ?? []);
    const linked = (u: string, v: string) => (v === me ? direct.has(u) : (this.adverts.get(v)?.n ?? []).includes(u));
    const hop = new Map<string, string>();
    const queue: string[] = [];
    for (const v of [...direct].sort()) { hop.set(v, v); queue.push(v); }
    while (queue.length) {
      const u = queue.shift()!;
      for (const v of [...adj(u)].sort()) {
        if (v === me || hop.has(v) || !linked(u, v) || !this.d.eligible(v)) continue;
        hop.set(v, hop.get(u)!);
        queue.push(v);
      }
    }
    const next = new Map([...hop].filter(([v]) => !direct.has(v)));
    const diff = [...new Set([...this.next.keys(), ...next.keys()])].filter((b) => this.next.get(b) !== next.get(b));
    this.next = next;
    if (diff.length) {
      for (const b of diff) if (next.has(b)) this.d.log(`与 ${b} 直连不通，经 ${next.get(b)} 中转`); else if (!direct.has(b)) this.d.log(`经中转也到不了 ${b} 了`);
      this.d.changed(diff);
    }
  }

  /** 把一条消息经中转发给 body（没有路由返回 false；消息太大抛错）。 */
  sendVia(body: string, inner: Record<string, unknown>): boolean {
    const hop = this.next.get(body);
    if (!hop) return false;
    const p = JSON.stringify(inner);
    if (p.length > MAX_FORWARD) throw new Error(`消息太大（${Math.round(p.length / 1048576)} MB），不能经其他身体中转`);
    const ts = Date.now(), nonce = crypto.randomBytes(16).toString("base64url");
    return this.d.send(hop, { t: "fwd", o: this.d.me, d: body, ttl: MAX_HOPS, ts, nonce, p, sig: sign(this.d.key, fwdText(this.d.agent, this.d.me, body, ts, nonce, p)) });
  }

  private onForward(from: string, m: Record<string, unknown>) {
    const { o, d, ttl, ts, nonce, p, sig } = m;
    if (typeof o !== "string" || !BODY_NAME.test(o) || typeof d !== "string" || !BODY_NAME.test(d) || !Number.isInteger(ttl) || (ttl as number) < 1 || (ttl as number) > MAX_HOPS) return this.drop(from, "格式不对");
    if (!isNum(ts) || typeof nonce !== "string" || nonce.length > 64 || typeof p !== "string" || p.length > MAX_FORWARD || typeof sig !== "string" || sig.length > 200) return this.drop(from, "格式不对");
    if (o === this.d.me) return; // 自己发的绕回来了
    if (d !== this.d.me) {
      // 替别人转：只按收件人找下一跳；不转回来处，跳数用完就丢
      const hop = this.d.direct().includes(d) ? d : this.next.get(d);
      if (!hop || hop === from || (ttl as number) <= 1) return this.drop(from, `到不了 ${d}`);
      this.d.send(hop, { ...m, ttl: (ttl as number) - 1 });
      return;
    }
    if (!this.d.eligible(o)) return this.drop(from, `${o} 不是可以往来的身体`);
    const now = Date.now();
    if (Math.abs(now - ts) > WINDOW_MS || ts < this.started - 60_000) return this.drop(from, "时间不对");
    if (this.nonces.has(nonce)) return this.drop(from, "重放");
    const key = this.d.keyOf(o);
    if (!key || !verify(key, fwdText(this.d.agent, o, d, ts, nonce, p), sig)) return this.drop(from, `签名不对（自称来自 ${o}）`);
    this.nonces.set(nonce, now);
    if (this.nonces.size > NONCES) this.nonces.delete(this.nonces.keys().next().value!);
    let inner: unknown;
    try { inner = JSON.parse(p); } catch { return this.drop(from, "内容不是 JSON"); }
    if (!inner || typeof inner !== "object" || Array.isArray(inner) || !["req", "res", "ev", "prog"].includes((inner as { t?: unknown }).t as string)) return this.drop(from, "内容不对");
    this.d.deliver(o, inner as Record<string, unknown>);
  }

  /** 丢弃一条转发（记一笔，限量：每次启动最多记 50 条）。 */
  private drop(from: string, why: string) { if (this.dropped++ < 50) this.d.log(`丢弃了经 ${from} 转来的一条消息：${why}`); }
}
