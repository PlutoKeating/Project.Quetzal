// 本地网关：HTTP + WebSocket（JSON-RPC 风格），缺省只监听 127.0.0.1（配置 gateway.host 可对局域网开放），令牌认证。控制台 App 与主机工具都通过它访问 agent。
//   GET  /health                 → { ok, version, mode }（无需令牌，供点火器探活）
//   GET  /auth/local             → { ok, token }：只给同一台机器上打开着网页控制台的浏览器（托管网页版且不是安卓时才有），见 web.ts
//   POST /pair/start | /pair/finish → 配对码（8 位，冷却、失败锁定与退避）
//   GET  /…                      → 网页控制台的静态文件（current/web/ 存在时），见 web.ts
//   WS   /rpc                    → 令牌在第一条消息 {"auth": "<令牌>"}（5 秒内）或旧式的 ?token=；之后 请求 {id, method, params} / 响应 {id, result | error} / 推送 {event, data}
//   HTTP 接口的令牌：Authorization: Bearer <令牌>、X-Quetzal-Token 头，或旧式的 ?token=（兼容旧控制台）
import http from "node:http";
import fs from "node:fs";
import { saveUpload, fromUpload, resolveUpload, MAX_FILES, MAX_FILE_BYTES } from "./mind/attachments.ts";
const str64 = (v: unknown) => (typeof v === "string" && v ? v.slice(0, 64) : undefined);
import crypto from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import { config, readSecret, writeSecret, saveConfig, isTermux, randomCode } from "./config.ts";
import { audit } from "./store.ts";
import { bus } from "./bus.ts";
import { invoke, status } from "./ops.ts";
import { converse } from "./mind/brain.ts";
import { feishuStatus, setFeishu, registerFeishu } from "./channels/feishu.ts";
import { VERSION } from "./version.ts";
import { log } from "./log.ts";
import { adapter } from "./body/twin.ts";
import { hear, hearStream } from "./voice/hearing.ts";
import { mediaFile } from "./voice/player.ts";
import { webDir, isLocalBrowser, hostAllowed, fromDescendant, serveWeb } from "./web.ts";

export function gatewayToken(): string {
  let t = readSecret("gateway.token");
  if (!t) { t = crypto.randomBytes(24).toString("base64url"); writeSecret("gateway.token", t); }
  return t;
}

const PAIR_TTL = 5 * 60_000, PAIR_TRIES = 5, PAIR_LEN = 8, MAX_BODY = 16 << 10, AUTH_WAIT = 5000;
/** 配对码输入时允许的写法：大小写、空格与连字符不计。 */
const normCode = (c: unknown) => String(c ?? "").toUpperCase().replace(/[\s-]/g, "");

/** 从请求里取令牌：Authorization: Bearer、X-Quetzal-Token、旧的 X-Token，或查询参数 token（兼容）。 */
export function tokenOf(req: http.IncomingMessage): string {
  const auth = String(req.headers.authorization ?? "");
  const m = auth.match(/^Bearer\s+(\S+)$/i);
  if (m) return m[1];
  const h = req.headers["x-quetzal-token"] ?? req.headers["x-token"];
  if (typeof h === "string" && h) return h;
  return new URL(req.url ?? "", "http://x").searchParams.get("token") ?? "";
}
const same = (given: string, token: string) => { const g = Buffer.from(given), t = Buffer.from(token); return g.length === t.length && crypto.timingSafeEqual(g, t); };

export function startGateway(safeMode: boolean) {
  let token = gatewayToken();
  const clients = new Set<WebSocket>();
  const broadcast = (event: string, data: unknown) => { const s = JSON.stringify({ event, data }); for (const c of clients) c.send(s); };

  const extra: Record<string, (p: any, ws?: WebSocket) => Promise<unknown> | unknown> = {
    // conv：会话；turn：客户端给这一轮的标识；attachments：上传返回的附件（只按 rel 解析）
    "chat.send": (p) => {
      const files = (Array.isArray(p.attachments) ? p.attachments : []).slice(0, MAX_FILES).map((a: any) => fromUpload(String(a?.rel ?? ""))).filter(Boolean);
      const mode = ["steer", "queue", "interrupt"].includes(p.mode) ? p.mode : undefined; // 她工作时发消息的方式（默认插话）
      return converse("你", String(p.text ?? ""), "控制台", { conv: str64(p.conv), turn: str64(p.turn), attachments: files, mode });
    },
    "feishu.status": () => feishuStatus(),
    "feishu.set": (p) => setFeishu(p),
    // 多具身体：指定持有飞书长连接的身体（全网共用的设置；空 = 各自连，只适合一具身体）
    "feishu.setHolder": (p) => { const b = String(p.body ?? "").trim(); if (b && !/^[a-z0-9][a-z0-9-]{0,39}$/.test(b)) throw new Error("身体名不对"); saveConfig({ channels: { feishuHolder: b } }); return feishuStatus(); },
    "feishu.register": () => { registerFeishu((url) => broadcast("feishu.qr", { url })).then((s) => broadcast("feishu.registered", s), (e) => broadcast("feishu.error", { message: e.description ?? e.message })); return true; },
    "safeMode": () => safeMode,
    // 换一个新的网关令牌：保存、断开其他所有连接（它们手里的旧令牌作废），把新令牌返回给发起的这个控制台
    "gateway.rotateToken": (_p, ws?: WebSocket) => {
      token = crypto.randomBytes(24).toString("base64url");
      writeSecret("gateway.token", token);
      for (const c of clients) if (c !== ws) c.close(4001, "令牌已更换");
      audit("控制台", "gateway.rotateToken", "", {}, "ok");
      log("gateway", "网关令牌已更换，其他连接已断开");
      return { token };
    },
  };

  // 配对：控制台请求 → 基座通过系统通知与飞书下发 8 位配对码 → 控制台提交配对码换取令牌。
  //   一个码 5 分钟有效、最多试 5 次；有效期内再请求不换新码（也不清零次数），只是 30 秒后可以再提醒一次；
  //   累计失败超过 5 次后全局锁定，按 30 秒 × 2^(n-5) 退避（最长 1 小时），成功一次清零。
  let pairing: { code: string; until: number; tries: number; notified: number } | undefined;
  let fails = 0, lockedUntil = 0;
  const json = (res: http.ServerResponse, code: number, body: unknown, headers: Record<string, string> = {}) => { res.writeHead(code, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(body)); };
  const authed = (req: http.IncomingMessage) => same(tokenOf(req), token);
  // 请求体最多 16 KB（上传与听觉另有自己的上限），超过的回 413
  const readBody = (req: http.IncomingMessage) => new Promise<any>((r, j) => {
    let b = "", n = 0;
    req.on("data", (c: Buffer) => { n += c.length; if (n > MAX_BODY) { j(Object.assign(new Error("请求体太大"), { status: 413 })); req.destroy(); } else b += c; });
    req.on("end", () => { try { r(JSON.parse(b || "{}")); } catch { r({}); } });
  });
  const port = () => (server.address() as any)?.port ?? config.gateway.port;
  const pairNotice = (p: NonNullable<typeof pairing>) => {
    p.notified = Date.now();
    const text = `控制台配对码：${p.code.slice(0, 4)}-${p.code.slice(4)}（5 分钟内有效）`;
    void adapter.notify?.("控制台配对", text).catch(() => {});
    bus.emit("notice", text);
  };
  // 本机登录只在：托管着网页控制台、不是安卓（别的应用也能连 127.0.0.1）时提供
  const localLogin = () => !!web && !isTermux && adapter.name !== "termux";

  const web = webDir();
  if (web) log("gateway", `网页控制台：${web}`);
  const server = http.createServer(async (req, res) => {
    // 同一台机器上的浏览器直接拿令牌（网页控制台打开即登录）；跨源时允许本机其他端口的页面读取（开发时 flutter run）
    if (req.method === "GET" && req.url === "/auth/local") {
      if (!localLogin() || !isLocalBrowser(req, port()) || fromDescendant(req, port())) return json(res, 403, { ok: false, message: "只有这台机器上打开的网页控制台可以直接登录；别的设备请用配对码" });
      return json(res, 200, { ok: true, token }, { "access-control-allow-origin": String(req.headers.origin), vary: "Origin" }); // Origin 已核对在允许的集合里
    }
    if (req.method === "POST" && (req.url === "/pair/start" || req.url === "/pair/finish")) {
      if (!hostAllowed(req, config.gateway.host)) return json(res, 403, { ok: false, message: "Host 不对" });
      const now = Date.now();
      if (now < lockedUntil) return json(res, 429, { ok: false, message: `失败次数太多，请 ${Math.ceil((lockedUntil - now) / 1000)} 秒后再试`, retryAfter: Math.ceil((lockedUntil - now) / 1000) });
      if (req.url === "/pair/start") {
        if (pairing && now < pairing.until && pairing.tries < PAIR_TRIES) { // 还有效：不换码、不清零次数
          if (now - pairing.notified > 30_000) pairNotice(pairing);
          return json(res, 200, { ok: true, expires: pairing.until });
        }
        pairing = { code: randomCode(PAIR_LEN), until: now + PAIR_TTL, tries: 0, notified: 0 };
        pairNotice(pairing);
        return json(res, 200, { ok: true, expires: pairing.until });
      }
      let body: any;
      try { body = await readBody(req); } catch (e: any) { return json(res, e.status ?? 400, { ok: false, message: e.message }); }
      if (!pairing || now > pairing.until || pairing.tries >= PAIR_TRIES) { pairing = undefined; return json(res, 410, { ok: false, message: "配对码已失效，请重新获取" }); }
      pairing.tries++;
      if (!same(normCode(body.code), pairing.code)) {
        fails++;
        if (fails > PAIR_TRIES) lockedUntil = now + Math.min(3600_000, 30_000 * 2 ** (fails - PAIR_TRIES - 1));
        if (pairing.tries >= PAIR_TRIES) pairing = undefined;
        log("gateway", `配对码不正确（累计失败 ${fails} 次）`);
        return json(res, 403, { ok: false, message: "配对码不正确" });
      }
      pairing = undefined; fails = 0; lockedUntil = 0;
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
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 << 20 });
  server.on("upgrade", (req, sock, head) => {
    const u = new URL(req.url ?? "", "http://x");
    if (u.pathname !== "/rpc") return sock.destroy();
    const given = tokenOf(req);
    if (given && !same(given, token)) return sock.destroy(); // 带了令牌却不对：直接拒绝；没带的等第一条消息
    wss.handleUpgrade(req, sock, head, (ws) => wss.emit("connection", ws, !!given));
  });
  const welcome = (ws: WebSocket) => { clients.add(ws); ws.send(JSON.stringify({ event: "hello", data: { version: VERSION, safeMode } })); };
  wss.on("connection", (ws: WebSocket, ok: boolean) => {
    let authed = ok;
    // 没在地址里带令牌：第一条消息必须是 {"auth": "<令牌>"}，5 秒内不来就断开
    const timer = authed ? undefined : setTimeout(() => ws.close(4401, "未授权"), AUTH_WAIT);
    if (authed) welcome(ws);
    ws.on("close", () => { clearTimeout(timer); clients.delete(ws); });
    ws.on("message", async (raw) => {
      if (!authed) {
        let m: any; try { m = JSON.parse(String(raw)); } catch { m = {}; }
        if (typeof m.auth !== "string" || !same(m.auth, token)) return ws.close(4401, "未授权");
        authed = true; clearTimeout(timer); welcome(ws);
        return;
      }
      if (!clients.has(ws)) return;
      let id: unknown;
      try {
        const m = JSON.parse(String(raw)); id = m.id;
        const result = extra[m.method] ? await extra[m.method](m.params ?? {}, ws) : await invoke(m.method, m.params, "控制台");
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
  bus.on("mesh", (s) => broadcast("mesh", s));
  bus.on("account", (s) => broadcast("account", s));
  bus.on("replica.applied", (e) => { if (e.table !== "timeline") broadcast("replica", { table: e.table, from: e.from, convs: [...new Set(e.rows.map((r) => r.session ?? r.id).filter(Boolean))].slice(0, 50) }); });

  server.listen(config.gateway.port, config.gateway.host, () => log("gateway", `监听 ${config.gateway.host}:${config.gateway.port}`));
}
