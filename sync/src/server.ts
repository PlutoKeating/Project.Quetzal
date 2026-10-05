// 装配：HTTP（Hono）+ WebSocket（ws，noServer，挂在同一端口的 /v1/ws 上）。main.ts 与测试共用。
import { createAdaptorServer } from "@hono/node-server";
import { WebSocketServer } from "ws";
import type { Server } from "node:http";
import type { Config } from "./config.ts";
import { openDb } from "./db.ts";
import { Hub } from "./hub.ts";
import { createApp } from "./app.ts";
import { githubClient, type GitHubClient } from "./auth.ts";

export function createSyncServer(cfg: Config, opts: { github?: GitHubClient | null } = {}) {
  const db = openDb(cfg.dataDir);
  const hub = new Hub(db, cfg);
  const github = opts.github === null ? undefined : opts.github ?? githubClient(cfg);
  const app = createApp({ db, cfg, hub, github });
  const server = createAdaptorServer({ fetch: app.fetch }) as Server;
  // 信令消息很小（SDP 与 ICE 候选），64 KiB 足够；不开压缩（避免压缩相关的放大与侧信道问题）
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false });
  server.on("upgrade", (req, socket, head) => {
    if (new URL(req.url ?? "/", "http://x").pathname !== "/v1/ws") { socket.destroy(); return; }
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
