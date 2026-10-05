// 信令中心：每具在线身体一条 WebSocket。负责在场（谁在线）、同一 agent 的身体之间转发信令（WebRTC 的 SDP / ICE 候选，内容不透明、由身体自己签名），
// 以及签发 TURN 凭据。不存、不看信令内容；不记 IP。
import type { WebSocket } from "ws";
import { z } from "zod";
import type { Db, Body } from "./db.ts";
import type { Config } from "./config.ts";
import { iceServers } from "./turn.ts";
import { RateLimiter, log, now } from "./util.ts";

export const PROTOCOL = 1;
const HELLO_TIMEOUT_MS = 10_000;
const PING_MS = 30_000;

const BODY = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/);
const ClientMsg = z.discriminatedUnion("t", [
  z.object({ t: z.literal("hello"), token: z.string().min(16).max(200), protocol: z.number().int(), version: z.string().max(32).default(""), agentName: z.string().min(1).max(80).optional() }),
  z.object({ t: z.literal("signal"), to: BODY.optional(), id: z.string().max(64).optional(), data: z.unknown() }),
  z.object({ t: z.literal("turn") }),
  z.object({ t: z.literal("ping") }),
]);

export interface Peer { body: string; kind: string; nodeKey: string; version: string; online: boolean; lastSeen: number }
interface Conn { ws: WebSocket; agent: number; agentId: string; body: string; limiter: RateLimiter; alive: boolean }

export class Hub {
  private conns = new Map<string, Conn>(); // "<agent 内部编号>/<body>"
  private timer: NodeJS.Timeout;
  private db: Db;
  private cfg: Config;
  constructor(db: Db, cfg: Config) {
    this.db = db; this.cfg = cfg;
    // 心跳：30 秒一次 ping，上一次没回 pong 就断开（半开连接会让在场状态失真）
    this.timer = setInterval(() => {
      for (const c of this.conns.values()) { if (!c.alive) { c.ws.terminate(); continue; } c.alive = false; c.ws.ping(); }
    }, PING_MS);
    this.timer.unref();
  }

  online(agent: number, body: string) { return this.conns.has(`${agent}/${body}`); }
  count() { return this.conns.size; }

  private peer(b: Body): Peer {
    return { body: b.body, kind: b.kind, nodeKey: b.node_key, version: b.version, online: this.online(b.agent, b.body), lastSeen: b.last_seen };
  }
  private send(ws: WebSocket, msg: unknown) { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg)); }
  /** 告诉同一 agent 的其他在线身体：某具身体的状态变了。 */
  private announce(agent: number, body: string) {
    const b = this.db.body(agent, body);
    for (const c of this.conns.values()) {
      if (c.agent !== agent || c.body === body) continue;
      this.send(c.ws, b ? { t: "peer", peer: this.peer(b) } : { t: "peer.removed", body });
    }
  }

  /** 新连接：10 秒内必须发 hello（带身体令牌），否则断开。 */
  accept(ws: WebSocket) {
    let conn: Conn | undefined;
    const helloTimer = setTimeout(() => { if (!conn) ws.close(4401, "hello timeout"); }, HELLO_TIMEOUT_MS);
    ws.on("pong", () => { if (conn) conn.alive = true; });
    ws.on("message", (raw, isBinary) => {
      if (isBinary) return ws.close(4400, "binary not supported");
      let msg: z.infer<typeof ClientMsg>;
      try { msg = ClientMsg.parse(JSON.parse(raw.toString())); } catch { return this.send(ws, { t: "error", code: "bad_message" }); }
      if (!conn) {
        if (msg.t !== "hello") return ws.close(4401, "hello first");
        clearTimeout(helloTimer);
        if (msg.protocol !== PROTOCOL) { this.send(ws, { t: "error", code: "protocol", supported: [PROTOCOL] }); return ws.close(4426, "protocol"); }
        const b = this.db.bodyByToken(msg.token);
        if (!b) { this.send(ws, { t: "error", code: "unauthorized" }); return ws.close(4401, "unauthorized"); }
        const key = `${b.agent}/${b.body}`;
        const old = this.conns.get(key);
        if (old) { this.send(old.ws, { t: "bye", reason: "replaced" }); old.ws.close(4409, "replaced"); }
        const agent = this.db.agent(b.agent)!;
        conn = { ws, agent: b.agent, agentId: agent.agent_id, body: b.body, limiter: new RateLimiter(200, 10_000), alive: true };
        this.conns.set(key, conn);
        this.db.seenBody(b.agent, b.body, msg.version || b.version);
        if (msg.agentName && msg.agentName !== agent.name) this.db.renameAgent(b.agent, msg.agentName);
        const owner = this.db.user(agent.user_id);
        this.send(ws, {
          t: "welcome", protocol: PROTOCOL, now: now(), agent: { id: agent.agent_id, name: msg.agentName ?? agent.name }, body: b.body, account: owner?.login ?? "",
          peers: this.db.bodiesOf(b.agent).filter((p) => p.body !== b.body).map((p) => this.peer(p)),
          ...iceServers(this.cfg, `${agent.agent_id.slice(0, 8)}-${b.body}`),
        });
        this.announce(b.agent, b.body);
        return;
      }
      if (!conn.limiter.take("m")) return this.send(ws, { t: "error", code: "rate_limited" });
      switch (msg.t) {
        case "ping": return this.send(ws, { t: "pong", now: now() });
        case "turn": return this.send(ws, { t: "turn", ...iceServers(this.cfg, `${conn.agentId.slice(0, 8)}-${conn.body}`) });
        case "signal": {
          const targets = [...this.conns.values()].filter((c) => c.agent === conn!.agent && c.body !== conn!.body && (!msg.to || c.body === msg.to));
          if (msg.to && !targets.length) return this.send(ws, { t: "error", code: "offline", to: msg.to, id: msg.id });
          for (const c of targets) this.send(c.ws, { t: "signal", from: conn.body, id: msg.id, data: msg.data });
          return;
        }
        case "hello": return this.send(ws, { t: "error", code: "already_hello" });
      }
    });
    ws.on("close", () => {
      clearTimeout(helloTimer);
      if (!conn) return;
      const key = `${conn.agent}/${conn.body}`;
      if (this.conns.get(key) !== conn) return; // 已被新连接替换，或已被踢出
      this.conns.delete(key);
      const b = this.db.body(conn.agent, conn.body);
      if (b) this.db.seenBody(conn.agent, conn.body, b.version);
      this.announce(conn.agent, conn.body);
    });
    ws.on("error", (e) => log("hub", `连接错误：${e.message}`));
  }

  /** 解绑身体或删除 agent / 账户后，立即断开对应的连接。 */
  kick(agent: number, body?: string) {
    for (const [key, c] of this.conns) {
      if (c.agent !== agent || (body && c.body !== body)) continue;
      this.send(c.ws, { t: "bye", reason: "revoked" });
      c.ws.close(4403, "revoked");
      this.conns.delete(key);
    }
    if (body) this.announce(agent, body);
  }

  close() { clearInterval(this.timer); for (const c of this.conns.values()) c.ws.close(1001, "server shutdown"); this.conns.clear(); }
}
