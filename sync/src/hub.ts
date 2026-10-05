// 信令中心：每具在线身体一条 WebSocket。负责在场（谁在线）、同一 agent 的身体之间转发信令（WebRTC 的 SDP / ICE 候选，内容不透明、由身体自己签名），
// 以及签发 TURN 凭据。不存、不看信令内容；不记 IP。
// 一条连接出的任何错（坏消息、数据库错误）只断开这条连接，不影响进程与别的连接。
import type { WebSocket } from "ws";
import { z } from "zod";
import type { Db, Body } from "./db.ts";
import type { Config } from "./config.ts";
import { iceServers, turnUser, type IceServer } from "./turn.ts";
import { RateLimiter, jsonDepth, log, now } from "./util.ts";

export const PROTOCOL = 1;
const HELLO_TIMEOUT_MS = 10_000;
const PING_MS = 30_000;
/** 一条消息（含外层）最多嵌套 33 层，即 signal.data 最多 32 层。 */
export const MAX_DEPTH = 33;
/** 每条连接 10 秒内最多 200 条消息、512 KiB。 */
const MSG_PER_WINDOW = 200, BYTES_PER_WINDOW = 512 * 1024, WINDOW_MS = 10_000;
/** 接收方没读走的发送缓冲超过 1 MiB 就断开它（慢消费者），不再给它排队。 */
export const MAX_BUFFERED = 1 << 20;
/** 刷新 TURN 凭据每条连接每分钟最多一次。 */
const TURN_MIN_INTERVAL_MS = 60_000;

/** 关闭码。 */
export const CLOSE = { badMessage: 4400, unauthorized: 4401, revoked: 4403, slowConsumer: 4408, replaced: 4409, protocol: 4426, internal: 1011 } as const;

const BODY = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/);
const TEXT = (max: number) => z.string().max(max).regex(/^[^\p{Cc}]*$/u); // 不含控制字符
const ClientMsg = z.discriminatedUnion("t", [
  z.object({ t: z.literal("hello"), token: z.string().regex(/^qsb_[A-Za-z0-9_-]{20,100}$/), protocol: z.number().int(), version: TEXT(32).default(""), agentName: TEXT(80).trim().min(1).optional() }),
  z.object({ t: z.literal("signal"), to: BODY.optional(), id: z.string().regex(/^[\x21-\x7e]{1,64}$/).optional(), data: z.record(z.string(), z.unknown()) }),
  z.object({ t: z.literal("turn") }),
  z.object({ t: z.literal("ping") }),
]);

export interface Peer { body: string; kind: string; nodeKey: string; version: string; online: boolean; lastSeen: number }
interface Conn { ws: WebSocket; agent: number; body: string; kind: string; msgs: RateLimiter; bytes: RateLimiter; lastTurn: number; alive: boolean }

export class Hub {
  private conns = new Map<string, Conn>(); // "<agent 内部编号>/<body>"
  /** 每具身体当前的 TURN 凭据：剩余有效期过半之前重复发同一个，coturn 的配额与分配都落在同一个用户上。 */
  private turnCache = new Map<string, { iceServers: IceServer[]; expires: number }>();
  private timer: NodeJS.Timeout;
  private db: Db;
  private cfg: Config;
  constructor(db: Db, cfg: Config) {
    this.db = db; this.cfg = cfg;
    // 心跳：30 秒一次 ping，上一次没回 pong 就断开（半开连接会让在场状态失真）；顺带清理过期的 TURN 凭据缓存
    this.timer = setInterval(() => {
      for (const c of this.conns.values()) { if (!c.alive) { c.ws.terminate(); continue; } c.alive = false; try { c.ws.ping(); } catch { c.ws.terminate(); } }
      const t = now();
      for (const [k, v] of this.turnCache) if (v.expires <= t) this.turnCache.delete(k);
    }, PING_MS);
    this.timer.unref();
  }

  online(agent: number, body: string) { return this.conns.has(`${agent}/${body}`); }
  count() { return this.conns.size; }

  private peer(b: Body): Peer {
    return { body: b.body, kind: b.kind, nodeKey: b.node_key, version: b.version, online: this.online(b.agent, b.body), lastSeen: b.last_seen };
  }
  /** 发一条已序列化的消息。接收方的发送缓冲积压超过上限时不再排队，以 4408 断开它（它重连后从头同步在场）。 */
  private sendText(ws: WebSocket, text: string) {
    if (ws.readyState !== ws.OPEN) return false;
    if (ws.bufferedAmount + text.length > MAX_BUFFERED) {
      ws.close(CLOSE.slowConsumer, "slow consumer");
      setTimeout(() => ws.terminate(), 2000).unref(); // 关闭帧排在积压的数据后面，对方不读就直接断
      return false;
    }
    ws.send(text);
    return true;
  }
  private send(ws: WebSocket, msg: unknown) { return this.sendText(ws, JSON.stringify(msg)); }
  /** 告诉同一 agent 的其他在线身体：某具身体的状态变了。 */
  private announce(agent: number, body: string) {
    const b = this.db.body(agent, body);
    const text = JSON.stringify(b ? { t: "peer", peer: this.peer(b) } : { t: "peer.removed", body });
    for (const c of this.conns.values()) if (c.agent === agent && c.body !== body) this.sendText(c.ws, text);
  }
  /** 这具身体的 ICE 服务器：缓存的 TURN 凭据剩余不到一半有效期时才换新的；ttl 是剩余秒数。 */
  private ice(agent: number, body: string): { iceServers: IceServer[]; ttl: number } {
    const turn = this.cfg.turn;
    if (!turn) return { iceServers: iceServers(this.cfg, "").iceServers, ttl: 0 };
    const key = `${agent}/${body}`, t = now();
    let c = this.turnCache.get(key);
    if (!c || c.expires - t < turn.ttl * 500) {
      const r = iceServers(this.cfg, turnUser(turn.secret, key), t);
      c = { iceServers: r.iceServers, expires: r.expires };
      this.turnCache.set(key, c);
    }
    return { iceServers: c.iceServers, ttl: Math.floor((c.expires - t) / 1000) };
  }

  /** 新连接：10 秒内必须发 hello（带身体令牌），否则断开。hello 之前只接受这一条消息，格式不对就断开。 */
  accept(ws: WebSocket) {
    let conn: Conn | undefined;
    const helloTimer = setTimeout(() => { if (!conn) ws.close(CLOSE.unauthorized, "hello timeout"); }, HELLO_TIMEOUT_MS);
    ws.on("pong", () => { if (conn) conn.alive = true; });

    const hello = (msg: Extract<z.infer<typeof ClientMsg>, { t: "hello" }>) => {
      clearTimeout(helloTimer);
      if (msg.protocol !== PROTOCOL) { this.send(ws, { t: "error", code: "protocol", supported: [PROTOCOL] }); return ws.close(CLOSE.protocol, "protocol"); }
      const b = this.db.bodyByToken(msg.token);
      const agent = b && this.db.agent(b.agent);
      if (!b || !agent) { this.send(ws, { t: "error", code: "unauthorized" }); return ws.close(CLOSE.unauthorized, "unauthorized"); }
      const key = `${b.agent}/${b.body}`;
      const old = this.conns.get(key);
      if (old) { this.send(old.ws, { t: "bye", reason: "replaced" }); old.ws.close(CLOSE.replaced, "replaced"); }
      conn = { ws, agent: b.agent, body: b.body, kind: b.kind, msgs: new RateLimiter(MSG_PER_WINDOW, WINDOW_MS, 1), bytes: new RateLimiter(BYTES_PER_WINDOW, WINDOW_MS, 1), lastTurn: now(), alive: true };
      this.conns.set(key, conn);
      this.db.seenBody(b.agent, b.body, msg.version || b.version);
      // 只有运行基座能改 agent 的显示名（灵魂桥是只读成员）
      const rename = b.kind === "runtime" && msg.agentName && msg.agentName !== agent.name ? msg.agentName : undefined;
      if (rename) this.db.renameAgent(b.agent, rename);
      const owner = this.db.user(agent.user_id);
      this.send(ws, {
        t: "welcome", protocol: PROTOCOL, now: now(), agent: { id: agent.agent_id, name: rename ?? agent.name }, body: b.body, account: owner?.login ?? "",
        peers: this.db.bodiesOf(b.agent).filter((p) => p.body !== b.body).map((p) => this.peer(p)),
        ...this.ice(b.agent, b.body),
      });
      this.announce(b.agent, b.body);
    };

    const onMessage = (text: string) => {
      const c = conn;
      if (c) {
        const size = Buffer.byteLength(text);
        if (!c.msgs.take("m") || !c.bytes.take("b", size)) return this.send(ws, { t: "error", code: "rate_limited" });
      }
      let msg: z.infer<typeof ClientMsg> | undefined;
      if (jsonDepth(text) <= MAX_DEPTH) { try { const r = ClientMsg.safeParse(JSON.parse(text)); if (r.success) msg = r.data; } catch { /* 不是 JSON */ } }
      if (!c) { // 未认证：第一条消息必须是格式正确的 hello
        if (!msg) return ws.close(CLOSE.badMessage, "bad message");
        if (msg.t !== "hello") return ws.close(CLOSE.unauthorized, "hello first");
        return hello(msg);
      }
      if (!msg) return this.send(ws, { t: "error", code: "bad_message" });
      switch (msg.t) {
        case "ping": return this.send(ws, { t: "pong", now: now() });
        case "turn": {
          if (now() - c.lastTurn < TURN_MIN_INTERVAL_MS) return this.send(ws, { t: "error", code: "rate_limited" });
          c.lastTurn = now();
          return this.send(ws, { t: "turn", ...this.ice(c.agent, c.body) });
        }
        case "signal": {
          const targets = [...this.conns.values()].filter((x) => x.agent === c.agent && x.body !== c.body && (!msg.to || x.body === msg.to));
          if (msg.to && !targets.length) return this.send(ws, { t: "error", code: "offline", to: msg.to, id: msg.id });
          const out = JSON.stringify({ t: "signal", from: c.body, id: msg.id, data: msg.data }); // 深度已受限，序列化一次发给所有目标
          for (const x of targets) this.sendText(x.ws, out);
          return;
        }
        case "hello": return this.send(ws, { t: "error", code: "already_hello" });
      }
    };

    ws.on("message", (raw, isBinary) => {
      try {
        if (isBinary) return ws.close(CLOSE.badMessage, "binary not supported");
        onMessage(raw.toString());
      } catch (e) {
        log("hub", `处理消息出错，断开这条连接：${(e as Error).message}`);
        try { ws.close(CLOSE.internal, "internal error"); } catch { ws.terminate(); }
      }
    });
    ws.on("close", () => {
      clearTimeout(helloTimer);
      if (!conn) return;
      const key = `${conn.agent}/${conn.body}`;
      if (this.conns.get(key) !== conn) return; // 已被新连接替换，或已被踢出
      this.conns.delete(key);
      try {
        const b = this.db.body(conn.agent, conn.body);
        if (b) this.db.seenBody(conn.agent, conn.body, b.version);
        this.announce(conn.agent, conn.body);
      } catch (e) { log("hub", `连接关闭时出错：${(e as Error).message}`); }
    });
    ws.on("error", (e) => log("hub", `连接错误：${e.message}`));
  }

  /** 解绑身体或删除 agent / 账户后，立即断开对应的连接，作废缓存的 TURN 凭据。 */
  kick(agent: number, body?: string) {
    for (const [key, c] of this.conns) {
      if (c.agent !== agent || (body && c.body !== body)) continue;
      this.send(c.ws, { t: "bye", reason: "revoked" });
      c.ws.close(CLOSE.revoked, "revoked");
      this.conns.delete(key);
    }
    for (const key of this.turnCache.keys()) if (key === `${agent}/${body}` || (!body && key.startsWith(`${agent}/`))) this.turnCache.delete(key);
    if (body) this.announce(agent, body);
  }

  close() { clearInterval(this.timer); for (const c of this.conns.values()) c.ws.close(1001, "server shutdown"); this.conns.clear(); }
}
