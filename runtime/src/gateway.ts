// 本地网关：HTTP + WebSocket（JSON-RPC 风格），缺省只监听 127.0.0.1（配置 gateway.host 可对局域网开放），令牌认证。控制台 App 与主机工具都通过它访问 agent。
//   GET  /health                 → { ok, version, mode }（无需令牌，供点火器探活）
//   GET  /auth/local             → { ok, token }：只给同一台机器上的浏览器（网页控制台免配对码），见 web.ts
//   GET  /…                      → 网页控制台的静态文件（current/web/ 存在时），见 web.ts
//   WS   /rpc?token=<令牌>        → 请求 {id, method, params} / 响应 {id, result | error} / 推送 {event, data}
import http from "node:http";
import fs from "node:fs";
import { saveUpload, fromUpload, resolveUpload, MAX_FILES, MAX_FILE_BYTES } from "./mind/attachments.ts";
const str64 = (v: unknown) => (typeof v === "string" && v ? v.slice(0, 64) : undefined);
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
import { hear, hearStream } from "./voice/hearing.ts";
import { mediaFile } from "./voice/player.ts";
import { webDir, isLocalBrowser, serveWeb } from "./web.ts";

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
    // conv：会话；turn：客户端给这一轮的标识；attachments：上传返回的附件（只按 rel 解析）
    "chat.send": (p) => {
      const files = (Array.isArray(p.attachments) ? p.attachments : []).slice(0, MAX_FILES).map((a: any) => fromUpload(String(a?.rel ?? ""))).filter(Boolean);
      const mode = ["steer", "queue", "interrupt"].includes(p.mode) ? p.mode : undefined; // 她工作时发消息的方式（默认插话）
      return converse("你", String(p.text ?? ""), "控制台", { conv: str64(p.conv), turn: str64(p.turn), attachments: files, mode });
    },
    "feishu.status": () => feishuStatus(),
    "feishu.set": (p) => setFeishu(p),
    "feishu.register": () => { registerFeishu((url) => broadcast("feishu.qr", { url })).then((s) => broadcast("feishu.registered", s), (e) => broadcast("feishu.error", { message: e.description ?? e.message })); return true; },
    "safeMode": () => safeMode,
  };

  // 配对：控制台请求 → 基座通过系统通知与飞书下发 6 位配对码 → 控制台提交配对码换取令牌（5 分钟有效，最多尝试 5 次）
  let pairing: { code: string; until: number; tries: number } | undefined;
  const json = (res: http.ServerResponse, code: number, body: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  const authed = (req: http.IncomingMessage) => {
    const given = Buffer.from(new URL(req.url ?? "", "http://x").searchParams.get("token") ?? String(req.headers["x-token"] ?? ""));
    return given.length === token.length && crypto.timingSafeEqual(given, Buffer.from(token));
  };
  const readBody = (req: http.IncomingMessage) => new Promise<any>((r) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { try { r(JSON.parse(b || "{}")); } catch { r({}); } }); });

  const web = webDir();
  if (web) log("gateway", `网页控制台：${web}`);
  const server = http.createServer(async (req, res) => {
    // 同一台机器上的浏览器直接拿令牌（网页控制台打开即登录）；跨源时允许本机其他端口的页面读取（开发时 flutter run）
    if (req.method === "GET" && req.url === "/auth/local") {
      if (!isLocalBrowser(req)) return json(res, 403, { ok: false, message: "只有这台机器上的浏览器可以直接登录；别的设备请用配对码" });
      if (req.headers.origin) res.setHeader("access-control-allow-origin", req.headers.origin);
      return json(res, 200, { ok: true, token });
    }
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
    // 附件上传：POST /upload?name=<文件名>，请求体为文件内容；返回附件信息（控制台随 chat.send 回传）
    if (req.method === "POST" && req.url?.startsWith("/upload")) {
      if (!authed(req)) return json(res, 401, { ok: false, message: "未授权" });
      const chunks: Buffer[] = []; let n = 0, over = false;
      req.on("data", (c: Buffer) => { n += c.length; if (n > MAX_FILE_BYTES) over = true; else chunks.push(c); });
      req.on("end", () => {
        if (over) return json(res, 413, { ok: false, message: `文件超过 ${MAX_FILE_BYTES >> 20} MiB` });
        try { json(res, 200, { ok: true, file: saveUpload(new URL(req.url!, "http://x").searchParams.get("name") || "file", Buffer.concat(chunks)) }); }
        catch (e: any) { json(res, 400, { ok: false, message: e.message }); }
      });
      return;
    }
    // 听觉：POST /hear?started=<这句话开始的毫秒时刻>。stream=1：请求体为边说边送的 16 kHz 单声道 16 位 PCM（分块传输，流式识别，中间结果经 hearing 事件推送）；
    // 否则请求体为一整句 WAV（一次识别）。两者都来自控制台 App 的耳朵。
    if (req.method === "POST" && req.url?.startsWith("/hear")) {
      if (!authed(req)) return json(res, 401, { ok: false, message: "未授权" });
      const q = new URL(req.url, "http://x").searchParams;
      if (q.get("stream") === "1") {
        try { return json(res, 200, await hearStream(req, Number(q.get("started")) || 0, str64(q.get("id")), false, q.get("bargein") === "1")); }
        catch (e: any) { return json(res, 500, { ok: false, message: e.message }); }
      }
      const chunks: Buffer[] = []; let n = 0, over = false;
      req.on("data", (c: Buffer) => { n += c.length; if (n > 4 << 20) over = true; else chunks.push(c); });
      req.on("end", async () => {
        if (over) return json(res, 413, { ok: false, message: "一句话不能超过 4 MiB" });
        try { json(res, 200, await hear(Buffer.concat(chunks), Number(new URL(req.url!, "http://x").searchParams.get("started")) || 0)); }
        catch (e: any) { json(res, 500, { ok: false, message: e.message }); }
      });
      return;
    }
    // 她的声音：GET /media/<文件名>，控制台 App 取合成语音来播放
    if (req.method === "GET" && req.url?.startsWith("/media/")) {
      if (!authed(req)) return json(res, 401, { ok: false, message: "未授权" });
      const f = mediaFile(decodeURIComponent(new URL(req.url, "http://x").pathname.slice("/media/".length)));
      if (!f) return json(res, 404, { ok: false, message: "没有这个文件" });
      res.writeHead(200, { "content-type": /\.mp3$/i.test(f) ? "audio/mpeg" : /\.wav$/i.test(f) ? "audio/wav" : "application/octet-stream", "content-length": fs.statSync(f).size });
      return void fs.createReadStream(f).pipe(res);
    }
    // 附件下载（预览）：GET /uploads/<rel>
    if (req.method === "GET" && req.url?.startsWith("/uploads/")) {
      if (!authed(req)) return json(res, 401, { ok: false, message: "未授权" });
      const f = resolveUpload(decodeURIComponent(new URL(req.url, "http://x").pathname.slice("/uploads/".length)));
      if (!f) return json(res, 404, { ok: false, message: "没有这个文件" });
      const a = fromUpload(decodeURIComponent(new URL(req.url, "http://x").pathname.slice("/uploads/".length)))!;
      res.writeHead(200, { "content-type": a.kind === "image" ? a.mime : a.kind === "text" ? "text/plain; charset=utf-8" : "application/octet-stream", "content-length": a.size });
      return void fs.createReadStream(f).pipe(res);
    }
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ ok: true, version: VERSION, safeMode, mode: safeMode ? "safe" : status().heart.mode }));
    }
    if (web && serveWeb(web, req, res)) return;
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
  bus.on("secret", (e) => broadcast("secret", e));
  bus.on("hearing", (e) => broadcast("hearing", e));
  bus.on("speaking", (e) => broadcast("speaking", e));
  bus.on("speak", (e) => broadcast("speak", e));
  bus.on("session.switch", (e) => broadcast("session.switch", e));

  server.listen(config.gateway.port, config.gateway.host, () => log("gateway", `监听 ${config.gateway.host}:${config.gateway.port}`));
}
