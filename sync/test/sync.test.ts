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
import { normalizeUserCode, fingerprint } from "../src/util.ts";

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
async function bind(b: Browser, body: string, agentId = AGENT, key = nodeKey()) {
  const code = await (await api("/v1/device/code", { agent: { id: agentId, name: "薰" }, body, kind: "runtime", nodeKey: key, version: "1.0.0" })).json() as any;
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
async function connect(token?: string, protocol = 1) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/ws`);
  const queue: any[] = []; const waiters: ((m: any) => void)[] = [];
  let closed: { code: number } | undefined;
  ws.on("message", (d) => { const m = JSON.parse(d.toString()); const w = waiters.shift(); if (w) w(m); else queue.push(m); });
  ws.on("close", (code) => { closed = { code }; });
  await new Promise((r) => ws.once("open", r));
  if (token) ws.send(JSON.stringify({ t: "hello", token, protocol, version: "1.0.0" }));
  const next = (type?: string): Promise<any> => new Promise((resolve, reject) => {
    const take = () => { const i = queue.findIndex((m) => !type || m.t === type); if (i >= 0) return resolve(queue.splice(i, 1)[0]); waiters.push((m) => { if (!type || m.t === type) resolve(m); else { queue.push(m); take(); } }); };
    take(); setTimeout(() => reject(new Error(`等 ${type} 超时`)), 3000);
  });
  const closedWith = () => new Promise<number>((r) => { if (closed) return r(closed.code); ws.once("close", (c) => r(c)); });
  return { ws, next, closedWith, send: (m: unknown) => ws.send(JSON.stringify(m)) };
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
  assert.match(w.iceServers[1].username, /^\d+:/);

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
  // 刷新 TURN 凭据
  a.send({ t: "turn" });
  assert.equal((await a.next("turn")).iceServers.length, 2);

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
