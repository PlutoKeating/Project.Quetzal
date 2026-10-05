// 装配：HTTP（Hono）+ WebSocket（ws，noServer，挂在同一端口的 /v1/ws 上）。main.ts 与测试共用。
import { createAdaptorServer } from "@hono/node-server";
import { WebSocketServer } from "ws";
import type { Server } from "node:http";
import type { Config } from "./config.ts";
import { openDb } from "./db.ts";
import { Hub } from "./hub.ts";
import { createApp } from "./app.ts";
import { githubClient, type GitHubClient } from "./auth.ts";
import { RateLimiter, clientIp, ipKey } from "./util.ts";

/** 每个客户端地址同时最多几条 WebSocket（一户人家的几具身体共用一个出口地址也够用）。 */
export const MAX_WS_PER_IP = 20;

export function createSyncServer(cfg: Config, opts: { github?: GitHubClient | null } = {}) {
  const db = openDb(cfg.dataDir);
  const hub = new Hub(db, cfg);
  const github = opts.github === null ? undefined : opts.github ?? githubClient(cfg);
  const app = createApp({ db, cfg, hub, github });
  const server = createAdaptorServer({ fetch: app.fetch }) as Server;
  // 信令消息很小（SDP 与 ICE 候选），64 KiB 足够；不开压缩（避免压缩相关的放大与侧信道问题）
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false });
  // 握手之前按客户端地址（IPv6 按 /64）限制：同时最多 MAX_WS_PER_IP 条连接、每分钟最多 60 次握手。地址只在内存里
  const perIp = new Map<string, number>();
  const upgrades = new RateLimiter(60, 60_000);
  server.on("upgrade", (req, socket, head) => {
    if (new URL(req.url ?? "/", "http://x").pathname !== "/v1/ws") { socket.destroy(); return; }
    const ip = ipKey(clientIp((n) => { const v = req.headers[n]; return Array.isArray(v) ? v.join(",") : v; }, req.socket.remoteAddress, cfg.trustProxy));
    const n = perIp.get(ip) ?? 0;
    if (n >= MAX_WS_PER_IP || !upgrades.take(ip)) {
      socket.end("HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    perIp.set(ip, n + 1);
    socket.once("close", () => { const m = (perIp.get(ip) ?? 1) - 1; if (m > 0) perIp.set(ip, m); else perIp.delete(ip); });
    wss.handleUpgrade(req, socket, head, (ws) => hub.accept(ws));
  });
  const purge = setInterval(() => db.purge(), 3_600_000); // 每小时清理过期的会话与设备码
  purge.unref();
  db.purge();
  return {
    db, hub, app, server, github,
    listen: (port = cfg.port, host = cfg.host) => new Promise<number>((resolve) => server.listen(port, host, () => resolve((server.address() as { port: number }).port))),
    close: () => new Promise<void>((resolve) => {
      clearInterval(purge); hub.close(); wss.close();
      server.close(() => { db.close(); resolve(); });
      server.closeAllConnections?.();
    }),
  };
}
