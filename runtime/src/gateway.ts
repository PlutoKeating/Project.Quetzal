// 本地网关：HTTP + WebSocket（JSON-RPC 风格），只监听 127.0.0.1，令牌认证。控制台 App 与主机工具都通过它访问 agent。
//   GET  /health                 → { ok, version, mode }（无需令牌，供点火器探活）
//   WS   /rpc?token=<令牌>        → 请求 {id, method, params} / 响应 {id, result | error} / 推送 {event, data}
import http from "node:http";
import crypto from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import { config, readSecret, writeSecret } from "./config.ts";
import { bus } from "./bus.ts";
import { invoke, status } from "./ops.ts";
import { converse } from "./mind/brain.ts";
import { feishuStatus, setFeishu, registerFeishu } from "./channels/feishu.ts";
import { VERSION } from "./version.ts";
import { log } from "./log.ts";
import { adapter } from "./body/twin.ts";

export function gatewayToken(): string {
  let t = readSecret("gateway.token");
  if (!t) { t = crypto.randomBytes(24).toString("base64url"); writeSecret("gateway.token", t); }
  return t;
}

export function startGateway(safeMode: boolean) {
  const token = gatewayToken();
  const clients = new Set<WebSocket>();
  const broadcast = (event: string, data: unknown) => { const s = JSON.stringify({ event, data }); for (const c of clients) c.send(s); };

  const extra: Record<string, (p: any) => Promise<unknown> | unknown> = {
    "chat.send": (p) => converse("你", String(p.text), "控制台", typeof p.session === "string" ? p.session.slice(0, 64) : undefined),
    "feishu.status": () => feishuStatus(),
    "feishu.set": (p) => setFeishu(p),
    "feishu.register": () => { registerFeishu((url) => broadcast("feishu.qr", { url })).then((s) => broadcast("feishu.registered", s), (e) => broadcast("feishu.error", { message: e.description ?? e.message })); return true; },
    "safeMode": () => safeMode,
  };

  // 配对：控制台请求 → 基座通过系统通知与飞书下发 6 位配对码 → 控制台提交配对码换取令牌（5 分钟有效，最多尝试 5 次）
  let pairing: { code: string; until: number; tries: number } | undefined;
  const json = (res: http.ServerResponse, code: number, body: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  const readBody = (req: http.IncomingMessage) => new Promise<any>((r) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { try { r(JSON.parse(b || "{}")); } catch { r({}); } }); });

  const server = http.createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/pair/start") {
      pairing = { code: String(crypto.randomInt(100000, 1000000)), until: Date.now() + 5 * 60_000, tries: 0 };
      const text = `控制台配对码：${pairing.code}（5 分钟内有效）`;
      void adapter.notify?.("控制台配对", text).catch(() => {});
      bus.emit("notice", text);
      return json(res, 200, { ok: true });
    }
    if (req.method === "POST" && req.url === "/pair/finish") {
      const { code } = await readBody(req);
      if (!pairing || Date.now() > pairing.until || ++pairing.tries > 5) { pairing = undefined; return json(res, 410, { ok: false, message: "配对码已失效，请重新获取" }); }
      if (String(code) !== pairing.code) return json(res, 403, { ok: false, message: "配对码不正确" });
      pairing = undefined;
      return json(res, 200, { ok: true, token });
    }
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ ok: true, version: VERSION, safeMode, mode: safeMode ? "safe" : status().heart.mode }));
    }
    res.writeHead(404).end();
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, sock, head) => {
    const u = new URL(req.url ?? "", "http://x");
    const given = Buffer.from(u.searchParams.get("token") ?? "");
    if (u.pathname !== "/rpc" || given.length !== token.length || !crypto.timingSafeEqual(given, Buffer.from(token))) return sock.destroy();
    wss.handleUpgrade(req, sock, head, (ws) => wss.emit("connection", ws));
  });
  wss.on("connection", (ws) => {
    clients.add(ws);
    ws.send(JSON.stringify({ event: "hello", data: { version: VERSION, safeMode } }));
    ws.on("close", () => clients.delete(ws));
    ws.on("message", async (raw) => {
      let id: unknown;
      try {
        const m = JSON.parse(String(raw)); id = m.id;
        const result = extra[m.method] ? await extra[m.method](m.params ?? {}) : await invoke(m.method, m.params, "控制台");
        ws.send(JSON.stringify({ id, result }));
      } catch (e: any) { ws.send(JSON.stringify({ id, error: { code: e.code ?? "ERROR", message: e.message } })); }
    });
  });

  let pending: NodeJS.Timeout | undefined;
  bus.on("state", () => { pending ??= setTimeout(() => { pending = undefined; if (clients.size) broadcast("state", status()); }, 500); });
  bus.on("timeline", (e) => broadcast("timeline", e));
  bus.on("approval", (a) => broadcast("approval", a));
  bus.on("say", (t) => broadcast("say", t));
  bus.on("activity", (a) => broadcast("activity", a));

  server.listen(config.gateway.port, "127.0.0.1", () => log("gateway", `监听 127.0.0.1:${config.gateway.port}`));
}
