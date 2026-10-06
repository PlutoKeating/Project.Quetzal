// 同步服务的端到端测试：GitHub 登录（假客户端）、设备码绑定、CSRF、开放重定向、账户隔离、WebSocket 信令与在场、TURN 凭据、安全响应头。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { loadConfig } from "../src/config.ts";
import { createSyncServer } from "../src/server.ts";
import { turnCredential } from "../src/turn.ts";
import { safeReturnTo } from "../src/auth.ts";
import { normalizeUserCode, fingerprint, RateLimiter, ipKey, clientIp, jsonDepth } from "../src/util.ts";
import { openDb } from "../src/db.ts";
import { MAX_WS_PER_IP } from "../src/server.ts";
import { MAX_BUFFERED } from "../src/hub.ts";
import { DatabaseSync } from "node:sqlite";

const PUBLIC = "http://sync.test";
const cfg = loadConfig({
  SYNC_PUBLIC_URL: PUBLIC, SYNC_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "quetzal-sync-")),
  GITHUB_CLIENT_ID: "x", GITHUB_CLIENT_SECRET: "y", TURN_SECRET: "s".repeat(40),
  SYNC_TRUST_PROXY: "1", // 测试用 X-Forwarded-For 模拟不同的客户端地址（限流按地址计）
});
// 假 GitHub：授权码就是 GitHub 用户 id
const github = {
  authorizationUrl: (state: string) => new URL(`https://github.example/authorize?state=${state}`),
  user: async (code: string) => ({ id: Number(code), login: `user${code}`, name: `User ${code}` }),
};
const s = createSyncServer(cfg, { github });
let port = 0;
before(async () => { port = await s.listen(0, "127.0.0.1"); });
after(async () => { await s.close(); });

/** 带 Cookie 罐的请求（经 Hono 的 app.request，不走网络）。 */
class Browser {
  jar = new Map<string, string>();
  async req(p: string, init: RequestInit & { form?: Record<string, string> } = {}) {
    const headers = new Headers(init.headers);
    if (this.jar.size) headers.set("cookie", [...this.jar].map(([k, v]) => `${k}=${v}`).join("; "));
    let body = init.body;
    if (init.form) { body = new URLSearchParams(init.form).toString(); headers.set("content-type", "application/x-www-form-urlencoded"); }
    if ((init.method ?? "GET") !== "GET" && !headers.has("origin")) headers.set("origin", PUBLIC);
    const r = await s.app.request(PUBLIC + p, { ...init, headers, body, redirect: "manual" });
    for (const c of r.headers.getSetCookie()) {
      const [kv, ...attrs] = c.split(";"); const i = kv.indexOf("=");
      const k = kv.slice(0, i).trim(), v = kv.slice(i + 1).trim();
      if (!v || attrs.some((a) => /max-age=0|expires=thu, 01 jan 1970/i.test(a))) this.jar.delete(k); else this.jar.set(k, v);
    }
    return r;
  }
  async login(githubId: number) {
    const r = await this.req("/login?return_to=/account");
    const state = new URL(r.headers.get("location")!).searchParams.get("state")!;
    const cb = await this.req(`/auth/github/callback?code=${githubId}&state=${state}`);
    assert.equal(cb.status, 302);
    assert.equal(cb.headers.get("location"), "/account");
  }
}

const nodeKey = () => (crypto.generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" }) as { x: string }).x;
const AGENT = crypto.randomUUID();
const api = (p: string, body: unknown, ip = `10.0.${crypto.randomInt(255)}.${crypto.randomInt(255)}`) =>
  s.app.request(PUBLIC + p, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": `1.2.3.4, ${ip}` }, body: JSON.stringify(body) });

/** 走完一次绑定：身体申请码 → 人登录、输入、批准 → 身体轮询拿令牌。 */
async function bind(b: Browser, body: string, agentId = AGENT, key = nodeKey(), kind = "runtime") {
  const code = await (await api("/v1/device/code", { agent: { id: agentId, name: "薰" }, body, kind, nodeKey: key, version: "1.0.0" })).json() as any;
  assert.match(code.user_code, /^[A-Z]{4}-[A-Z]{4}$/);
  const pending = await (await api("/v1/device/token", { device_code: code.device_code })).json() as any;
  assert.equal(pending.error, "authorization_pending");
  const confirm = await b.req("/device", { method: "POST", form: { code: code.user_code.toLowerCase().replace("-", "") } });
  assert.equal(confirm.status, 200);
  assert.ok((await confirm.text()).includes(fingerprint(key)), "确认页显示公钥指纹");
  const ok = await b.req("/device/decide", { method: "POST", form: { code: code.user_code, approve: "1" } });
  assert.equal(ok.status, 200);
  const tok = await api("/v1/device/token", { device_code: code.device_code });
  assert.equal(tok.status, 200);
  const j = await tok.json() as any;
  assert.match(j.access_token, /^qsb_/);
  return { token: j.access_token as string, res: j, key };
}

/** WebSocket 客户端：收到的消息排队，按类型等待。 */
async function connect(token?: string, protocol = 1, opts: { ip?: string; agentName?: string } = {}) {
  // 每条连接默认一个随机的客户端地址（服务端按地址限制并发连接数与握手频率）
  const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/ws`, { headers: { "x-forwarded-for": opts.ip ?? `10.9.${crypto.randomInt(255)}.${crypto.randomInt(255)}` } });
  const queue: any[] = []; const waiters: ((m: any) => void)[] = [];
  let closed: { code: number } | undefined;
  ws.on("message", (d) => { const m = JSON.parse(d.toString()); const w = waiters.shift(); if (w) w(m); else queue.push(m); });
  ws.on("close", (code) => { closed = { code }; });
  await new Promise((r) => ws.once("open", r));
  if (token) ws.send(JSON.stringify({ t: "hello", token, protocol, version: "1.0.0", ...(opts.agentName ? { agentName: opts.agentName } : {}) }));
  const next = (type?: string): Promise<any> => new Promise((resolve, reject) => {
    const take = () => { const i = queue.findIndex((m) => !type || m.t === type); if (i >= 0) return resolve(queue.splice(i, 1)[0]); waiters.push((m) => { if (!type || m.t === type) resolve(m); else { queue.push(m); take(); } }); };
    take(); setTimeout(() => reject(new Error(`等 ${type} 超时`)), 3000);
  });
  const closedWith = () => new Promise<number>((r) => { if (closed) return r(closed.code); ws.once("close", (c) => r(c)); });
  return { ws, next, closedWith, send: (m: unknown) => ws.send(JSON.stringify(m)), raw: (text: string) => ws.send(text) };
}

test("配置：缺公开地址报错，TURN 密钥太短报错", () => {
  assert.throws(() => loadConfig({}), /SYNC_PUBLIC_URL/);
  assert.throws(() => loadConfig({ SYNC_PUBLIC_URL: PUBLIC, TURN_SECRET: "short" }), /TURN_SECRET/);
  assert.deepEqual(loadConfig({ SYNC_PUBLIC_URL: "https://a.example", TURN_SECRET: "x".repeat(32) }).turn?.urls, ["turn:a.example:3478?transport=udp", "turn:a.example:3478?transport=tcp"]);
  // 隧道模式：公开地址经代理，STUN / TURN 用单独的直连主机名
  const tunneled = loadConfig({ SYNC_PUBLIC_URL: "https://a.example", TURN_SECRET: "x".repeat(32), TURN_HOST: "turn.a.example" });
  assert.deepEqual([tunneled.turn?.urls[0], tunneled.stun], ["turn:turn.a.example:3478?transport=udp", ["stun:turn.a.example:3478"]]);
  assert.deepEqual(loadConfig({ SYNC_PUBLIC_URL: "https://a.example", TURN_HOST: "2001:db8::1" }).stun, ["stun:[2001:db8::1]:3478"]);
  assert.throws(() => loadConfig({ SYNC_PUBLIC_URL: "https://a.example", TURN_HOST: "evil host/x" }), /TURN_HOST/);
});

test("TURN 凭据与 coturn 的 use-auth-secret 算法一致", () => {
  const c = turnCredential("secret", "abc-honor9", 3600, 1_700_000_000_000);
  assert.equal(c.username, `${1_700_000_000 + 3600}:abc-honor9`);
  assert.equal(c.credential, crypto.createHmac("sha1", "secret").update(c.username).digest("base64"));
});

test("短码规范化与开放重定向防护", () => {
  assert.equal(normalizeUserCode("bcdf ghjk"), "BCDF-GHJK");
  assert.equal(normalizeUserCode("BCDF-GHJA"), undefined); // A 不在字母表里
  for (const bad of ["//evil.example", "/\\evil.example", "https://evil.example", "javascript:alert(1)", "/a\nb"]) assert.equal(safeReturnTo(bad), "/account");
  assert.equal(safeReturnTo("/device?code=BCDF-GHJK"), "/device?code=BCDF-GHJK");
});

test("安全响应头：CSP 带 nonce、禁止被嵌入", async () => {
  const r = await s.app.request(PUBLIC + "/");
  const csp = r.headers.get("content-security-policy") ?? "";
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /frame-ancestors 'none'/);
  const nonce = csp.match(/style-src 'nonce-([^']+)'/)?.[1];
  assert.ok(nonce && (await r.text()).includes(`nonce="${nonce}"`));
  assert.equal(r.headers.get("x-frame-options"), "SAMEORIGIN");
});

test("OAuth：state 不符的回调不会登录", async () => {
  const b = new Browser();
  await b.req("/login");
  const r = await b.req("/auth/github/callback?code=1&state=forged");
  assert.equal(r.status, 302);
  assert.equal((await b.req("/account")).status, 302, "仍未登录，被送去登录");
});

test("CSRF：跨站来源的表单 POST 被拒绝", async () => {
  const b = new Browser(); await b.login(41);
  const r = await b.req("/account/delete", { method: "POST", form: { confirm: "1" }, headers: { origin: "https://evil.example" } });
  assert.equal(r.status, 403);
  assert.equal((await b.req("/account")).status, 200, "账户还在");
});

test("设备码绑定 → WebSocket 在场与信令 → 解绑立即断开", async () => {
  const b = new Browser(); await b.login(42);
  const phone = await bind(b, "honor9"), pc = await bind(b, "pc");
  assert.equal(phone.res.agent.id, AGENT);
  assert.equal(phone.res.account, "user42");

  const a = await connect(phone.token);
  const w = await a.next("welcome");
  assert.equal(w.agent.id, AGENT);
  assert.deepEqual(w.peers.map((p: any) => [p.body, p.online]), [["pc", false]]);
  assert.equal(w.iceServers.length, 2);
  assert.match(w.iceServers[1].username, /^\d+:[A-Za-z0-9_-]{22}$/, "TURN 用户名的标识部分是不透明的 HMAC");
  assert.ok(!w.iceServers[1].username.includes("honor9") && !w.iceServers[1].username.includes(AGENT.slice(0, 8)));

  const p = await connect(pc.token);
  await p.next("welcome");
  const seen = await a.next("peer");
  assert.deepEqual([seen.peer.body, seen.peer.online, seen.peer.nodeKey], ["pc", true, pc.key]);

  // 定向信令原样转发，带来源
  p.send({ t: "signal", to: "honor9", id: "1", data: { sdp: "offer", sig: "…" } });
  const sig = await a.next("signal");
  assert.deepEqual([sig.from, sig.id, sig.data.sdp], ["pc", "1", "offer"]);
  // 发给不在线的身体：明确报错
  a.send({ t: "signal", to: "nobody", id: "2", data: {} });
  assert.equal((await a.next("error")).code, "offline");
  // 刷新 TURN 凭据：刚发过（welcome 里），一分钟内再要被限流
  a.send({ t: "turn" });
  assert.equal((await a.next("error")).code, "rate_limited");

  // 网页上解绑 pc：它的连接立即被断开，honor9 收到 peer.removed，旧令牌作废
  const acc = await (await b.req("/account")).text();
  const agentRow = acc.match(/name="agent" value="(\d+)"/)![1];
  await b.req("/account/bodies/remove", { method: "POST", form: { agent: agentRow, body: "pc" } });
  assert.equal(await p.closedWith(), 4403);
  assert.equal((await a.next("peer.removed")).body, "pc");
  const again = await connect(pc.token);
  assert.equal(await again.closedWith(), 4401);
  a.ws.close();
});

test("同名身体重新绑定：旧连接被踢，旧令牌失效", async () => {
  const b = new Browser(); await b.login(43);
  const agent = crypto.randomUUID();
  const first = await bind(b, "tab", agent);
  const c1 = await connect(first.token); await c1.next("welcome");
  const second = await bind(b, "tab", agent);
  assert.equal(await c1.closedWith(), 4403);
  assert.equal(await (await connect(first.token)).closedWith(), 4401);
  const c2 = await connect(second.token); await c2.next("welcome"); c2.ws.close();
});

test("账户隔离：同一个 agent id 在两个账户下互不可见，谁也占不了谁", async () => {
  const agent = crypto.randomUUID();
  const alice = new Browser(); await alice.login(50);
  const mallory = new Browser(); await mallory.login(51);
  const m = await bind(mallory, "fake", agent); // 先用别人的 agent id 绑定
  const a = await bind(alice, "real", agent);   // 本人照样能绑定
  const ca = await connect(a.token), cm = await connect(m.token);
  assert.deepEqual((await ca.next("welcome")).peers, []);
  assert.deepEqual((await cm.next("welcome")).peers, []);
  cm.send({ t: "signal", data: { probe: 1 } }); // 广播也到不了另一个账户
  cm.send({ t: "signal", to: "real", data: {} });
  assert.equal((await cm.next("error")).code, "offline");
  ca.ws.close(); cm.ws.close();
});

test("WebSocket：坏令牌、协议版本不符、先发别的消息都被断开", async () => {
  assert.equal(await (await connect("qsb_" + "x".repeat(43))).closedWith(), 4401);
  const b = new Browser(); await b.login(60);
  const { token } = await bind(b, "old", crypto.randomUUID());
  const v = await connect(token, 99);
  assert.equal((await v.next("error")).code, "protocol");
  assert.equal(await v.closedWith(), 4426);
  const x = await connect();
  x.send({ t: "ping" });
  assert.equal(await x.closedWith(), 4401);
});

test("设备码：拒绝后身体收到 access_denied；输错短码有次数限制；非法请求 400", async () => {
  const b = new Browser(); await b.login(70);
  const code = await (await api("/v1/device/code", { agent: { id: crypto.randomUUID(), name: "x" }, body: "b1", kind: "runtime", nodeKey: nodeKey() })).json() as any;
  await b.req("/device/decide", { method: "POST", form: { code: code.user_code, approve: "0" } });
  assert.equal((await (await api("/v1/device/token", { device_code: code.device_code })).json() as any).error, "access_denied");
  assert.equal((await api("/v1/device/code", { agent: { id: "not-a-uuid", name: "x" }, body: "B!", kind: "x", nodeKey: "k" })).status, 400);
  let last = 0;
  for (let i = 0; i < 12; i++) last = (await b.req("/device", { method: "POST", form: { code: "BCDF-GHJK" } })).status;
  assert.ok((await (await b.req("/device", { method: "POST", form: { code: "BCDF-GHJK" } })).text()).length > 0);
  assert.equal(last, 400);
});

test("删除账户：会话、agent、身体全部删除，连接断开", async () => {
  const b = new Browser(); await b.login(80);
  const { token } = await bind(b, "gone", crypto.randomUUID());
  const c = await connect(token); await c.next("welcome");
  await b.req("/account/delete", { method: "POST", form: { confirm: "1" } });
  assert.equal(await c.closedWith(), 4403);
  assert.equal((await b.req("/account")).status, 302);
  assert.equal(await (await connect(token)).closedWith(), 4401);
});

test("/v1/health 与 /v1/me", async () => {
  const h = await (await s.app.request(PUBLIC + "/v1/health")).json() as any;
  assert.deepEqual([h.ok, h.login, h.turn, h.protocol], [true, true, true, 1]);
  const b = new Browser(); await b.login(90);
  const { token } = await bind(b, "me", crypto.randomUUID());
  const me = await (await s.app.request(PUBLIC + "/v1/me", { headers: { authorization: `Bearer ${token}` } })).json() as any;
  assert.equal(me.body, "me");
  assert.equal((await s.app.request(PUBLIC + "/v1/me", { method: "DELETE", headers: { authorization: `Bearer ${token}` } })).status, 200);
  assert.equal((await s.app.request(PUBLIC + "/v1/me", { headers: { authorization: `Bearer ${token}` } })).status, 401);
});

test("限流：同一地址 10 分钟内最多申请 10 次绑定码；X-Forwarded-For 只信最右一项", async () => {
  const req = { agent: { id: crypto.randomUUID(), name: "x" }, body: "rl", kind: "runtime", nodeKey: nodeKey() };
  const codes: number[] = [];
  for (let i = 0; i < 11; i++) codes.push((await api("/v1/device/code", req, "203.0.113.9")).status);
  assert.deepEqual(codes.slice(0, 10), Array(10).fill(200));
  assert.equal(codes[10], 429);
  // 伪造最左边的地址没用：限流看的是代理追加的最右一项
  const spoof = await s.app.request(PUBLIC + "/v1/device/code", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "9.9.9.9, 203.0.113.9" }, body: JSON.stringify(req) });
  assert.equal(spoof.status, 429);
});

test("请求体过大被拒绝（413）", async () => {
  const r = await api("/v1/device/token", { device_code: "x".repeat(20_000) });
  assert.equal(r.status, 413);
});

test("WebSocket：signal.data 深层嵌套被拒绝，服务不崩、别的连接照常；32 层以内照常转发", async () => {
  const b = new Browser(); await b.login(100);
  const agent = crypto.randomUUID();
  const one = await bind(b, "one", agent), two = await bind(b, "two", agent);
  const a = await connect(one.token); await a.next("welcome");
  const c = await connect(two.token); await c.next("welcome"); await a.next("peer");
  const deep = "[".repeat(30_000) + "]".repeat(30_000); // 6 万字节，帧上限以内
  a.raw(`{"t":"signal","to":"two","data":{"x":${deep}}}`);
  assert.equal((await a.next("error")).code, "bad_message");
  a.raw(`{"t":"signal","data":{"x":${"[".repeat(5000)}`); // 不完整的 JSON
  assert.equal((await a.next("error")).code, "bad_message");
  let ok: unknown = 1; for (let i = 0; i < 31; i++) ok = [ok];
  a.send({ t: "signal", to: "two", data: { ok } }); // data 自身 1 层 + 31 层 = 32 层
  assert.ok((await c.next("signal")).data.ok);
  c.send({ t: "ping" });
  assert.equal(typeof (await c.next("pong")).now, "number");
  assert.equal((await s.app.request(PUBLIC + "/v1/health")).status, 200);
  assert.equal(jsonDepth('{"a":"[[[[","b":[{}]}'), 3, "字符串里的括号不算");
  a.ws.close(); c.ws.close();
});

test("WebSocket：hello 之前格式不对就断开（4400）；每条连接按字节限流", async () => {
  const x = await connect();
  x.raw("not json");
  assert.equal(await x.closedWith(), 4400);
  const y = await connect();
  y.send({ t: "hello", token: "short", protocol: 1 });
  assert.equal(await y.closedWith(), 4400);
  const b = new Browser(); await b.login(101);
  const { token } = await bind(b, "bytes", crypto.randomUUID());
  const c = await connect(token); await c.next("welcome");
  const big = "x".repeat(60_000);
  for (let i = 0; i < 9; i++) c.send({ t: "signal", data: { big } }); // 9 × 60 KB > 512 KiB / 10 秒
  assert.equal((await c.next("error")).code, "rate_limited");
  c.ws.close();
});

test("WebSocket：接收方积压超过 1 MiB 时以 4408 断开它，不再排队", () => {
  const calls: unknown[] = [];
  const fake = { OPEN: 1, readyState: 1, bufferedAmount: MAX_BUFFERED, send: () => calls.push("send"), close: (code: number) => calls.push(code), terminate: () => calls.push("terminate") };
  assert.equal((s.hub as any).sendText(fake, "x"), false);
  assert.deepEqual(calls, [4408]);
  fake.bufferedAmount = 0;
  assert.equal((s.hub as any).sendText(fake, "x"), true);
});

test("WebSocket：每个地址同时最多 MAX_WS_PER_IP 条连接，关掉后又能连", async () => {
  const ip = "198.51.100.77";
  const open = [];
  for (let i = 0; i < MAX_WS_PER_IP; i++) open.push(await connect(undefined, 1, { ip }));
  const status = await new Promise<number>((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/ws`, { headers: { "x-forwarded-for": ip } });
    ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
    ws.on("open", () => resolve(101));
    ws.on("error", () => {});
  });
  assert.equal(status, 429);
  for (const c of open) { c.ws.close(); await c.closedWith(); }
  await new Promise((r) => setTimeout(r, 50));
  const again = await connect(undefined, 1, { ip });
  again.ws.close();
});

test("TURN：每具身体一个固定的不透明标识，过半有效期之前重复发同一个凭据", async (t) => {
  const b = new Browser(); await b.login(102);
  const agent = crypto.randomUUID();
  const p = await bind(b, "turn1", agent), q = await bind(b, "turn2", agent);
  const c1 = await connect(p.token); const w1 = await c1.next("welcome"); c1.ws.close(); await c1.closedWith();
  const c2 = await connect(p.token); const w2 = await c2.next("welcome"); c2.ws.close();
  assert.deepEqual(w1.iceServers[1], w2.iceServers[1], "重连拿到同一个凭据");
  const c3 = await connect(q.token); const w3 = await c3.next("welcome"); c3.ws.close();
  assert.notEqual(w1.iceServers[1].username.split(":")[1], w3.iceServers[1].username.split(":")[1], "不同身体标识不同");
  // 时间推进：过半有效期之前是同一个，之后换新的（标识不变，到期时间变）
  const hub = s.hub as any, ttl = cfg.turn!.ttl, t0 = Date.now();
  t.mock.method(Date, "now", () => t0);
  const first = hub.ice(9999, "x");
  t.mock.method(Date, "now", () => t0 + ttl * 400);
  const early = hub.ice(9999, "x");
  t.mock.method(Date, "now", () => t0 + ttl * 600);
  const late = hub.ice(9999, "x");
  assert.equal(early.iceServers[1].username, first.iceServers[1].username);
  assert.ok(early.ttl < first.ttl, "ttl 是剩余秒数");
  assert.notEqual(late.iceServers[1].username, first.iceServers[1].username);
  assert.equal(late.iceServers[1].username.split(":")[1], first.iceServers[1].username.split(":")[1]);
});

test("hello：只有运行基座能改 agent 的显示名，灵魂桥不能", async () => {
  const b = new Browser(); await b.login(103);
  const agent = crypto.randomUUID();
  const br = await bind(b, "bridge", agent, nodeKey(), "bridge");
  const c = await connect(br.token, 1, { agentName: "冒名" });
  assert.equal((await c.next("welcome")).agent.name, "薰");
  c.ws.close();
  const rt = await bind(b, "rt", agent);
  const d = await connect(rt.token, 1, { agentName: "新名字" });
  assert.equal((await d.next("welcome")).agent.name, "新名字");
  d.ws.close();
});

test("客户端地址：CF-Connecting-IP 优先，其次 X-Forwarded-For 最右一项；IPv6 按 /64 聚合", () => {
  const h = (m: Record<string, string>) => (n: string) => m[n];
  assert.equal(clientIp(h({ "cf-connecting-ip": "203.0.113.5", "x-forwarded-for": "1.1.1.1, 2.2.2.2" }), "127.0.0.1", true), "203.0.113.5");
  assert.equal(clientIp(h({ "x-forwarded-for": "1.1.1.1, 2.2.2.2" }), "127.0.0.1", true), "2.2.2.2");
  assert.equal(clientIp(h({ "cf-connecting-ip": "203.0.113.5" }), "127.0.0.1", false), "127.0.0.1", "不信代理时不看请求头");
  assert.equal(clientIp(h({ "cf-connecting-ip": "garbage" }), "127.0.0.1", true), "127.0.0.1");
  assert.equal(ipKey("2001:db8:1:2:3:4:5:6"), "2001:db8:1:2::/64");
  assert.equal(ipKey("2001:db8:1:2::9"), "2001:db8:1:2::/64");
  assert.equal(ipKey("2001:db8::1"), "2001:db8:0:0::/64");
  assert.equal(ipKey("::ffff:192.0.2.1"), "192.0.2.1");
  assert.equal(ipKey("192.0.2.1"), "192.0.2.1");
});

test("限流器：有硬上限，满了淘汰最早的条目；over 只看不计；可按权重计", () => {
  const r = new RateLimiter(2, 60_000, 3);
  for (const k of ["a", "b", "c", "d"]) r.take(k);
  assert.equal(r.size, 3);
  assert.equal(r.take("a"), true, "a 被淘汰过，重新计数");
  assert.equal(r.over("b"), false, "b 已被淘汰");
  r.take("b"); r.take("b");
  assert.equal(r.over("b"), true);
  assert.equal(r.take("b"), false);
  const bytes = new RateLimiter(100, 60_000);
  assert.equal(bytes.take("x", 60), true);
  assert.equal(bytes.take("x", 60), false);
});

test("数据库迁移：1.0.1 的会话表补上 agent 列，没有创建时间的旧行从升级时起算", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "quetzal-sync-mig-"));
  const old = new DatabaseSync(path.join(dir, "sync.db"));
  old.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, github_id INTEGER NOT NULL UNIQUE, login TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', created INTEGER NOT NULL, last_login INTEGER NOT NULL);
    CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires INTEGER NOT NULL,
      kind TEXT NOT NULL DEFAULT 'web', label TEXT NOT NULL DEFAULT '', created INTEGER NOT NULL DEFAULT 0, last_used INTEGER NOT NULL DEFAULT 0);
    INSERT INTO users VALUES (1, 1, 'u', '', 0, 0);
    INSERT INTO sessions (id, user_id, expires) VALUES ('h', 1, ${Date.now() + 86_400_000});`);
  old.close();
  const db = openDb(dir);
  const row = db.raw.prepare("SELECT * FROM sessions WHERE id = 'h'").get() as any;
  assert.equal(row.agent, null);
  assert.ok(row.created > Date.now() - 60_000);
  db.close();
});

test("核对表情：64 个各不相同，都是 Emoji 5.0 以前、默认彩色显示的（Android 8 的手机也显示得出来）", async () => {
  const { CHECK_EMOJI, checkWords } = await import("../src/util.ts");
  assert.equal(new Set(CHECK_EMOJI).size, 64);
  const newer = (cp: number) => (cp >= 0x1f96c && cp <= 0x1f97f) || (cp >= 0x1f997 && cp <= 0x1f9bf) || cp >= 0x1f9e7;
  const textDefault = new Set([..."🕯🏔🏝🏖🏕🗺🌡🕰"].map((c) => c.codePointAt(0)));
  for (const e of CHECK_EMOJI) {
    const cp = e.codePointAt(0)!;
    assert.equal([...e].length, 1, `${e} 是单个字符`);
    assert.ok(!newer(cp) && !textDefault.has(cp), `${e}（U+${cp.toString(16)}）在旧手机上显示不出来`);
  }
  assert.equal([...checkWords("a1b2c3")].length, 3);
});
