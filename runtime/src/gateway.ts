// 本地网关：HTTP + WebSocket（JSON-RPC 风格），令牌认证。控制台 App 与主机工具都通过它访问 agent。
//   监听：明文 HTTP 只在本机回环（127.0.0.1 与 ::1 的 gateway.port，不出这台机器）；对局域网开放时（gateway.lan，或 gateway.host 不是回环地址）
//   另开 HTTPS / WSS（gateway.host:gateway.lanPort，自签名证书，TLS 1.2 起，见 tls.ts），局域网上不再有明文。两个监听共用同一套处理。
//   GET  /health                 → { ok, version, mode }（无需令牌，供点火器探活）
//   GET  /auth/local             → { ok, token }：只给同一台机器上打开着网页控制台的浏览器（托管网页版且不是安卓时才有，只在明文回环监听上），见 web.ts
//   GET  /pair/info              → { ok, fingerprint, short, body, version, tls }（无需令牌：证书指纹，控制台配对时显示与核对）
//   POST /pair/start | /pair/finish → 配对码（8 位，冷却、失败锁定与退避）；加密监听上 /pair/finish 只收配对证明 {proof}（与证书指纹绑定），回环上另收 {code}
//   GET  /…                      → 网页控制台的静态文件（current/web/ 存在时），见 web.ts
//   WS   /rpc                    → 令牌在第一条消息 {"auth": "<令牌>"}（5 秒内）或旧式的 ?token=；之后 请求 {id, method, params} / 响应 {id, result | error} / 推送 {event, data}
//   HTTP 接口的令牌：Authorization: Bearer <令牌>、X-Quetzal-Token 头，或旧式的 ?token=（兼容旧控制台）
import http from "node:http";
import https from "node:https";
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
import { gatewayTls, PAIR_SALT, PAIR_ITER, PAIR_LEN as PROOF_LEN } from "./tls.ts";

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
/** 对局域网开放：显式的 gateway.lan，或 host 不是回环地址（兼容旧配置的 0.0.0.0）。 */
const LOOP_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
export const lanEnabled = (g: { host: string; lan?: boolean } = config.gateway) => g.lan === true || !LOOP_HOSTS.has(g.host);
/** HTTPS 监听的地址：host 是回环地址时（只开了 lan）为 0.0.0.0。 */
export const lanHost = (g: { host: string } = config.gateway) => (LOOP_HOSTS.has(g.host) ? "0.0.0.0" : g.host);
const same = (given: string, token: string) => { const g = Buffer.from(given), t = Buffer.from(token); return g.length === t.length && crypto.timingSafeEqual(g, t); };

export interface GatewayHandle { plain: http.Server; tls?: https.Server; fingerprint: string; ready: Promise<void>; close(): Promise<void> }

export function startGateway(safeMode: boolean): GatewayHandle {
  let token = gatewayToken();
  const cert = gatewayTls(config.body);
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
  //   配对证明：proof = hex(PBKDF2-HMAC-SHA256(配对码, "quetzal-pair-v2|" + 证书指纹, 100000, 32))，生成码时就算好（之后每次核对只是比较，不耗 CPU）。
  let pairing: { code: string; until: number; tries: number; notified: number; proof: Promise<string> } | undefined;
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
  const proofOf = (code: string) => new Promise<string>((r, j) => crypto.pbkdf2(code, PAIR_SALT + cert.fingerprint, PAIR_ITER, PROOF_LEN, "sha256", (e, k) => (e ? j(e) : r(k.toString("hex")))));
  const pairNotice = (p: NonNullable<typeof pairing>) => {
    p.notified = Date.now();
    const text = `控制台配对码 ${p.code.slice(0, 4)}-${p.code.slice(4)} · 证书指纹 ${cert.short}（5 分钟内有效）`;
    void adapter.notify?.("控制台配对", text).catch(() => {});
    bus.emit("notice", text);
  };
  // 本机登录只在：托管着网页控制台、不是安卓（别的应用也能连 127.0.0.1）时提供
  const localLogin = () => !!web && !isTermux && adapter.name !== "termux";

  const web = webDir();
  if (web) log("gateway", `网页控制台：${web}`);
  const handle = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const secure = !!(req.socket as { encrypted?: boolean }).encrypted; // 来自 HTTPS 监听（局域网）
    // 同一台机器上的浏览器直接拿令牌（网页控制台打开即登录）；跨源时允许本机其他端口的页面读取（开发时 flutter run）。只在明文回环监听上
    if (req.method === "GET" && req.url === "/auth/local") {
      if (secure || !localLogin() || !isLocalBrowser(req, port()) || fromDescendant(req, port())) return json(res, 403, { ok: false, message: "只有这台机器上打开的网页控制台可以直接登录；别的设备请用配对码" });
      return json(res, 200, { ok: true, token }, { "access-control-allow-origin": String(req.headers.origin), vary: "Origin" }); // Origin 已核对在允许的集合里
    }
    // 配对前的信息：证书指纹（控制台显示给人核对，网页版据此计算配对证明）、身体名、版本
    if (req.method === "GET" && req.url === "/pair/info") {
      if (!hostAllowed(req, config.gateway.host)) return json(res, 403, { ok: false, message: "Host 不对" });
      return json(res, 200, { ok: true, fingerprint: cert.fingerprint, short: cert.short, body: config.body, version: VERSION, tls: true });
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
        const code = randomCode(PAIR_LEN);
        pairing = { code, until: now + PAIR_TTL, tries: 0, notified: 0, proof: proofOf(code) };
        pairing.proof.catch(() => {});
        pairNotice(pairing);
        return json(res, 200, { ok: true, expires: pairing.until });
      }
      let body: any;
      try { body = await readBody(req); } catch (e: any) { return json(res, e.status ?? 400, { ok: false, message: e.message }); }
      // 加密监听上只收配对证明：配对码不上网络，证明与这张证书绑定，中间人（换了证书）算出来的对不上
      const proof = typeof body.proof === "string" ? body.proof.toLowerCase() : undefined;
      if (secure && proof === undefined) return json(res, 400, { ok: false, message: "加密连接上配对需要配对证明（proof），请升级控制台" });
      if (!pairing || now > pairing.until || pairing.tries >= PAIR_TRIES) { pairing = undefined; return json(res, 410, { ok: false, message: "配对码已失效，请重新获取" }); }
      const p = pairing;
      p.tries++; // 先计数再等待：并发的请求也逐个计入
      let ok: boolean;
      try { ok = proof !== undefined ? same(proof, await p.proof) : same(normCode(body.code), p.code); }
      catch { return json(res, 500, { ok: false, message: "配对证明计算失败" }); }
      if (pairing !== p) return json(res, 410, { ok: false, message: "配对码已失效，请重新获取" }); // 等待期间换了码
      if (!ok) {
        fails++;
        if (fails > PAIR_TRIES) lockedUntil = Date.now() + Math.min(3600_000, 30_000 * 2 ** (fails - PAIR_TRIES - 1));
        if (p.tries >= PAIR_TRIES) pairing = undefined;
        log("gateway", `${proof !== undefined ? "配对证明" : "配对码"}不正确（累计失败 ${fails} 次）`);
        return json(res, 403, { ok: false, message: "配对码不正确" });
      }
      pairing = undefined; fails = 0; lockedUntil = 0;
      return json(res, 200, { ok: true, token, fingerprint: cert.fingerprint });
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
  };
  const server = http.createServer(handle);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 << 20 });
  const upgrade = (req: http.IncomingMessage, sock: import("node:stream").Duplex, head: Buffer) => {
    const u = new URL(req.url ?? "", "http://x");
    if (u.pathname !== "/rpc") return sock.destroy();
    const given = tokenOf(req);
    if (given && !same(given, token)) return sock.destroy(); // 带了令牌却不对：直接拒绝；没带的等第一条消息
    wss.handleUpgrade(req, sock, head, (ws) => wss.emit("connection", ws, !!given));
  };
  server.on("upgrade", upgrade);
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

  // 明文只在回环：127.0.0.1（失败照旧抛出，由守护者处理），::1 尽力而为（没有 IPv6 的机器跳过）
  const listen = (s: http.Server, port: number, host: string, quiet = false) => new Promise<void>((r) => {
    const fail = (e: any) => { if (!quiet) log("gateway", `监听 ${host}:${port} 失败：${e.message}`); r(); };
    s.once("error", fail);
    s.listen(port, host, () => { s.off("error", fail); log("gateway", `监听 ${host.includes(":") ? `[${host}]` : host}:${(s.address() as any).port}${s instanceof https.Server ? "（HTTPS / WSS）" : ""}`); r(); });
  });
  const v6 = http.createServer(handle);
  v6.on("upgrade", upgrade);
  let tls: https.Server | undefined;
  if (lanEnabled()) {
    tls = https.createServer({ key: cert.key, cert: cert.cert, minVersion: "TLSv1.2" }, handle);
    tls.on("upgrade", upgrade);
    tls.on("tlsClientError", () => {}); // 握手失败（浏览器不信任自签名证书、端口扫描）是常态，不记
  }
  const ready = (async () => {
    await new Promise<void>((r) => server.listen(config.gateway.port, "127.0.0.1", () => { log("gateway", `监听 127.0.0.1:${port()}（明文，只在本机）`); r(); }));
    await listen(v6, port(), "::1", true);
    if (tls) {
      await listen(tls, config.gateway.lanPort, lanHost());
      if (tls.listening) log("gateway", `局域网：https://<这台机器的地址>:${(tls.address() as any)?.port ?? config.gateway.lanPort}，证书指纹 ${cert.short}`);
    }
  })();
  const close = async () => {
    for (const c of clients) c.terminate();
    for (const s of [server, v6, tls]) if (s?.listening) await new Promise<void>((r) => { s.close(() => r()); s.closeAllConnections(); });
  };
  return { plain: server, tls, fingerprint: cert.fingerprint, ready, close };
}
