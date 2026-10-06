// 网页前端（SYNC_WEB_URL）与控制台登录：给人看的入口跳到前端、登录后回到前端、/v1/web/* 的 CORS 与来源检查、
// 经接口批准身体、账户管理，以及控制台登录（只有本账户下的身体能申请；令牌只能用于账户接口；可吊销）。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.ts";
import { createSyncServer } from "../src/server.ts";
import { safeReturnTo } from "../src/auth.ts";

const PUBLIC = "https://sync.example";
const WEB = "https://www.example";
const cfg = loadConfig({
  SYNC_PUBLIC_URL: PUBLIC, SYNC_WEB_URL: WEB + "/zh", SYNC_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "quetzal-sync-web-")),
  OIDC_ISSUER: "https://id.example", OIDC_CLIENT_ID: "x", OIDC_CLIENT_SECRET: "y", TURN_SECRET: "s".repeat(40), SYNC_TRUST_PROXY: "1", SYNC_SESSION_DAYS: "7",
});
// 假身份服务：记下 PKCE 的 code_challenge 与回调时收到的 code_verifier、回调地址
const pkce = { challenge: "", verifier: "", callback: "" };
const login = {
  authorizationUrl: async ({ state, codeChallenge }: { state: string; codeChallenge: string }) => { pkce.challenge = codeChallenge; return new URL(`https://id.example/authorize?state=${state}`); },
  user: async (cb: URL, o: { codeVerifier: string }) => {
    pkce.verifier = o.codeVerifier; pkce.callback = cb.toString();
    const code = cb.searchParams.get("code")!;
    return { sub: `sub-${code}`, login: `user${code}`, name: `User ${code}`, email: `user${code}@example.com` };
  },
};
const s = createSyncServer(cfg, { login });
after(async () => { await s.close(); });

class Browser {
  jar = new Map<string, string>();
  ip: string;
  constructor(ip = `10.2.${crypto.randomInt(255)}.${crypto.randomInt(255)}`) { this.ip = ip; }
  async req(p: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    if (!headers.has("x-forwarded-for")) headers.set("x-forwarded-for", this.ip);
    if (this.jar.size) headers.set("cookie", [...this.jar].map(([k, v]) => `${k}=${v}`).join("; "));
    const r = await s.app.request(PUBLIC + p, { ...init, headers, redirect: "manual" });
    for (const c of r.headers.getSetCookie()) {
      const [kv, ...attrs] = c.split(";"); const i = kv.indexOf("=");
      const k = kv.slice(0, i).trim(), v = kv.slice(i + 1).trim();
      if (!v || attrs.some((a) => /max-age=0|expires=thu, 01 jan 1970/i.test(a))) this.jar.delete(k); else this.jar.set(k, v);
    }
    return r;
  }
  /** 网页前端发出的请求：带 Origin，JSON。 */
  web(p: string, body?: unknown, origin = WEB) {
    return this.req(p, body === undefined ? { headers: { origin } } : { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body) });
  }
  async login(id: number, returnTo = `${WEB}/zh/account`) {
    const r = await this.req(`/login?return_to=${encodeURIComponent(returnTo)}`);
    const state = new URL(r.headers.get("location")!).searchParams.get("state")!;
    return (await this.req(`/auth/oidc/callback?code=${id}&state=${state}`)).headers.get("location");
  }
}
const ip = () => `10.1.${crypto.randomInt(255)}.${crypto.randomInt(255)}`;
const api = (p: string, body: unknown, headers: Record<string, string> = {}) =>
  s.app.request(PUBLIC + p, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip(), ...headers }, body: JSON.stringify(body) });
const nodeKey = () => (crypto.generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" }) as { x: string }).x;

/** 经网页接口走完一次身体绑定，返回身体令牌。 */
async function bindViaWeb(b: Browser, agent: string, body: string) {
  const code = await (await api("/v1/device/code", { agent: { id: agent, name: "薰" }, body, kind: "runtime", nodeKey: nodeKey(), version: "1.0.1" })).json() as any;
  assert.equal(code.verification_uri_complete, `${WEB}/device?code=${code.user_code}`, "给人的链接指向网页前端");
  const look = await (await b.web("/v1/web/device/lookup", { code: code.user_code })).json() as any;
  assert.equal(look.body, body);
  assert.match(look.fingerprint, /^[0-9a-f]{4}( [0-9a-f]{4}){3}$/);
  assert.equal((await b.web("/v1/web/device/decide", { code: code.user_code, approve: true })).status, 200);
  const tok = await (await api("/v1/device/token", { device_code: code.device_code })).json() as any;
  assert.match(tok.access_token, /^qsb_/);
  assert.match(tok.console.access_token, /^qsc_/, "运行基座同一次批准也拿到控制台登录");
  return tok.access_token as string;
}

test("给人看的入口跳到网页前端；登录后回到网页前端，别的地址一律不回", async () => {
  const b = new Browser();
  assert.equal((await b.req("/")).headers.get("location"), `${WEB}/`);
  assert.equal((await b.req("/account")).headers.get("location"), `${WEB}/account`);
  assert.equal((await b.req("/device?code=bcdfghjk")).headers.get("location"), `${WEB}/device?code=BCDF-GHJK`);
  assert.equal(await b.login(1, `${WEB}/en/account/device?code=BCDF-GHJK`), `${WEB}/en/account/device?code=BCDF-GHJK`);
  assert.equal(await new Browser().login(2, "https://evil.example/steal"), `${WEB}/account`);
  assert.equal(safeReturnTo("//evil.example", WEB), `${WEB}/account`);
  assert.equal(safeReturnTo(`${WEB}//evil.example`, WEB), `${WEB}/account`);
});

test("/v1/web/*：CORS 只放行网页前端；改动请求必须带对的 Origin 与 JSON；没登录 401", async () => {
  const b = new Browser(); await b.login(3);
  const pre = await s.app.request(PUBLIC + "/v1/web/account", { method: "OPTIONS", headers: { origin: WEB, "access-control-request-method": "POST", "access-control-request-headers": "content-type" } });
  assert.equal(pre.headers.get("access-control-allow-origin"), WEB);
  assert.equal(pre.headers.get("access-control-allow-credentials"), "true");
  const evil = await s.app.request(PUBLIC + "/v1/web/account", { headers: { origin: "https://evil.example" } });
  assert.equal(evil.headers.get("access-control-allow-origin"), null, "别的源读不到响应");
  assert.equal((await b.req("/v1/web/logout", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 403, "没有 Origin");
  assert.equal((await b.web("/v1/web/logout", {}, "https://evil.example")).status, 403, "别的源");
  assert.equal((await b.req("/v1/web/logout", { method: "POST", headers: { origin: WEB, "content-type": "text/plain" }, body: "{}" })).status, 415, "不是 JSON（简单请求，不会预检）");
  const me = await (await b.web("/v1/web/session")).json() as any;
  assert.equal(me.user.login, "user3");
  assert.equal((await new Browser().web("/v1/web/account")).status, 401);
});

test("经网页接口批准身体、查看账户、解绑身体、删除 agent 与账户", async () => {
  const b = new Browser(); await b.login(4);
  const agent = crypto.randomUUID();
  await bindViaWeb(b, agent, "honor9");
  await bindViaWeb(b, agent, "pc");
  const acc = await (await b.web("/v1/web/account")).json() as any;
  assert.deepEqual(acc.agents.map((a: any) => [a.id, a.bodies.map((x: any) => x.body)]), [[agent, ["honor9", "pc"]]]);
  assert.equal(JSON.stringify(acc).includes("qsb_"), false, "不含令牌");
  assert.equal((await b.web("/v1/web/bodies/remove", { agent, body: "pc" })).status, 200);
  assert.equal((await b.web("/v1/web/bodies/remove", { agent, body: "nope" })).status, 404);
  const other = new Browser(); await other.login(6);
  assert.equal((await other.web("/v1/web/agents/remove", { agent })).status, 404, "别的账户删不了");
  assert.equal((await b.web("/v1/web/account/delete", {})).status, 400, "要确认");
  assert.equal((await b.web("/v1/web/account/delete", { confirm: true })).status, 200);
  assert.equal((await b.web("/v1/web/account")).status, 401);
});

test("控制台登录：只有本账户下的身体能申请；令牌只能用于账户接口；可在账户里看到并吊销", async () => {
  const owner = new Browser(); await owner.login(7);
  const agent = crypto.randomUUID();
  const bodyToken = await bindViaWeb(owner, agent, "honor9");
  assert.equal((await api("/v1/console/code", {})).status, 401, "要身体令牌");
  const code = await (await api("/v1/console/code", {}, { authorization: `Bearer ${bodyToken}` })).json() as any;
  assert.equal(code.verification_uri, `${WEB}/device`);

  // 别人（骗来的批准）不行
  const stranger = new Browser(); await stranger.login(8);
  assert.equal(((await (await stranger.web("/v1/web/device/lookup", { code: code.user_code })).json()) as any).error, "not_yours");
  assert.equal((await stranger.web("/v1/web/device/decide", { code: code.user_code, approve: true })).status, 409);

  const look = await (await owner.web("/v1/web/device/lookup", { code: code.user_code })).json() as any;
  assert.deepEqual([look.kind, look.body], ["console", "honor9"]);
  assert.equal((await owner.web("/v1/web/device/decide", { code: code.user_code, approve: true })).status, 200);
  const tok = await (await api("/v1/device/token", { device_code: code.device_code })).json() as any;
  assert.match(tok.access_token, /^qsc_/);
  assert.equal(tok.kind, "console");
  const asConsole = (p: string, body?: unknown) => s.app.request(PUBLIC + p, body === undefined
    ? { headers: { authorization: `Bearer ${tok.access_token}` } }
    : { method: "POST", headers: { authorization: `Bearer ${tok.access_token}`, "content-type": "application/json" }, body: JSON.stringify(body) });

  const acc = await (await asConsole("/v1/web/account")).json() as any;
  assert.equal(acc.user.login, "user7");
  assert.equal(acc.consoles.length, 2, "绑定时自动发的一个 + 这次单独申请的一个");
  assert.deepEqual(acc.consoles.filter((c: any) => c.current).map((c: any) => c.body), ["honor9"]);
  assert.equal((await s.app.request(PUBLIC + "/v1/web/account", { headers: { authorization: `Bearer ${bodyToken}` } })).status, 401, "身体令牌不能当账户令牌");
  assert.equal((await s.app.request(PUBLIC + "/v1/me", { headers: { authorization: `Bearer ${tok.access_token}` } })).status, 401, "账户令牌不能当身体令牌");
  assert.equal((await new Browser().req("/v1/web/account", { headers: { origin: WEB, cookie: `__Host-quetzal_session=${tok.access_token}` } })).status, 401, "控制台令牌不能当 Cookie 用");

  // 网页上吊销 → 控制台立即失效
  const handle = ((await (await asConsole("/v1/web/account")).json()) as any).consoles.find((c: any) => c.current).id;
  assert.equal((await owner.web("/v1/web/consoles/revoke", { id: handle })).status, 200);
  assert.equal((await asConsole("/v1/web/account")).status, 401);
});

test("一次登录：批准运行基座时同时发控制台令牌，能管理账户，随身体解绑作废；灵魂桥不发", async () => {
  const owner = new Browser(); await owner.login(17);
  const agent = crypto.randomUUID();
  const code = await (await api("/v1/device/code", { agent: { id: agent, name: "薰" }, body: "phone", kind: "runtime", nodeKey: nodeKey(), version: "1.2.0" })).json() as any;
  assert.equal((await owner.web("/v1/web/device/decide", { code: code.user_code, approve: true })).status, 200);
  const tok = await (await api("/v1/device/token", { device_code: code.device_code })).json() as any;
  const asConsole = (p: string) => s.app.request(PUBLIC + p, { headers: { authorization: `Bearer ${tok.console.access_token}` } });
  assert.equal(((await (await asConsole("/v1/web/account")).json()) as any).user.login, "user17");
  assert.ok(tok.console.expires_in > 0);
  assert.equal((await s.app.request(PUBLIC + "/v1/me", { method: "DELETE", headers: { authorization: `Bearer ${tok.access_token}` } })).status, 200);
  assert.equal((await asConsole("/v1/web/account")).status, 401, "身体解绑后控制台令牌作废");
  const bridge = await (await api("/v1/device/code", { agent: { id: agent, name: "薰" }, body: "hermes", kind: "bridge", nodeKey: nodeKey(), version: "1.2.0" })).json() as any;
  assert.equal((await owner.web("/v1/web/device/decide", { code: bridge.user_code, approve: true })).status, 200);
  const bt = await (await api("/v1/device/token", { device_code: bridge.device_code })).json() as any;
  assert.match(bt.access_token, /^qsb_/);
  assert.equal(bt.console, undefined);
});

test("换令牌：直连 github.com 不通时经中转；GitHub 明确拒绝时不换路；中转没配置时如实报错", async () => {
  const { exchangeCode } = await import("../src/auth.ts");
  const o = { id: "cid", secret: "sec", code: "c", redirectUri: `${PUBLIC}/soul/callback`, relay: "https://relay.example/token" };
  const calls: string[] = [];
  const ok = (j: unknown, status = 200) => new Response(JSON.stringify(j), { status, headers: { "content-type": "application/json" } });
  const down = (async (url: string) => { calls.push(new URL(url).host); if (url.includes("github.com")) throw new Error("connect timeout"); return ok({ access_token: "gho_x" }); }) as typeof fetch;
  assert.equal(await exchangeCode(o, down), "gho_x");
  assert.deepEqual(calls, ["github.com", "github.com", "relay.example"], "直连试两次再走中转");
  calls.length = 0;
  const denied = (async (url: string) => { calls.push(new URL(url).host); return ok({ error: "bad_verification_code" }); }) as typeof fetch;
  await assert.rejects(exchangeCode(o, denied), /拒绝了授权码：bad_verification_code/);
  assert.deepEqual(calls, ["github.com"]);
  const relayOff = (async (url: string) => { if (url.includes("github.com")) throw new Error("connect timeout"); return ok({ error: "relay_not_configured" }, 503); }) as typeof fetch;
  await assert.rejects(exchangeCode(o, relayOff), /无法连接 GitHub（relay\.example 返回 503 relay_not_configured）/);
  let body = "";
  await exchangeCode({ ...o, relay: undefined }, (async (_u: string, init: RequestInit) => { body = String(init.body); return ok({ access_token: "t" }); }) as typeof fetch);
  assert.deepEqual(Object.fromEntries(new URLSearchParams(body)), { client_id: "cid", client_secret: "sec", code: "c", redirect_uri: `${PUBLIC}/soul/callback` });
});

/** 身体代控制台申请登录、主人批准、身体拿到 qsc_ 令牌。 */
async function consoleLogin(owner: Browser, bodyToken: string) {
  const code = await (await api("/v1/console/code", {}, { authorization: `Bearer ${bodyToken}` })).json() as any;
  assert.equal((await owner.web("/v1/web/device/decide", { code: code.user_code, approve: true })).status, 200);
  const tok = await (await api("/v1/device/token", { device_code: code.device_code })).json() as any;
  assert.match(tok.access_token, /^qsc_/);
  return tok.access_token as string;
}
const asConsole = (token: string, p = "/v1/web/account", body?: unknown) => s.app.request(PUBLIC + p, body === undefined
  ? { headers: { authorization: `Bearer ${token}` } }
  : { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
const sha = (t: string) => crypto.createHash("sha256").update(t).digest("hex");
const DAY = 86_400_000;

test("短码：decide 输错也计数；用完次数后连对的码也是 429；过期与不存在是同一个错误", async () => {
  const b = new Browser(); await b.login(20);
  const code = await (await api("/v1/device/code", { agent: { id: crypto.randomUUID(), name: "x" }, body: "guess", kind: "runtime", nodeKey: nodeKey() })).json() as any;
  // 过期的码与不存在的码：同样的 404 bad_code
  const exp = await (await api("/v1/device/code", { agent: { id: crypto.randomUUID(), name: "x" }, body: "old", kind: "runtime", nodeKey: nodeKey() })).json() as any;
  s.db.raw.prepare("UPDATE device_codes SET expires = 1 WHERE user_code = ?").run(exp.user_code);
  for (const p of ["/v1/web/device/lookup", "/v1/web/device/decide"]) {
    const a = await b.web(p, { code: exp.user_code, approve: true }), n = await b.web(p, { code: "BCDF-GHJK", approve: true });
    assert.deepEqual([a.status, await a.json()], [n.status, await n.json()]);
    assert.equal(a.status, 404);
  }
  for (let i = 0; i < 6; i++) await b.web("/v1/web/device/decide", { code: "BCDF-GHJK", approve: true });
  const r = await b.web("/v1/web/device/lookup", { code: code.user_code });
  assert.equal(r.status, 429, "输错 10 次后，对的码也不给查");
  assert.equal((await b.web("/v1/web/device/decide", { code: code.user_code, approve: true })).status, 429);
});

test("短码：同一个地址换账户也只能输错 30 次", async () => {
  const ip = "198.51.100.30";
  let last = 0;
  for (let u = 0; u < 4; u++) {
    const b = new Browser(ip); await b.login(30 + u);
    for (let i = 0; i < 8; i++) last = (await b.web("/v1/web/device/lookup", { code: "BCDF-GHJK" })).status;
  }
  assert.equal(last, 429);
  const fresh = new Browser(ip); await fresh.login(40);
  assert.equal((await fresh.web("/v1/web/device/lookup", { code: "BCDF-GHJK" })).status, 429);
  const elsewhere = new Browser(); await elsewhere.login(41);
  assert.equal((await elsewhere.web("/v1/web/device/lookup", { code: "BCDF-GHJK" })).status, 404);
});

test("控制台登录的确认：给出发起它的身体的真实指纹与绑定时间；灵魂桥不能申请；重新绑定后旧码作废", async () => {
  const owner = new Browser(); await owner.login(50);
  const agent = crypto.randomUUID(), key = nodeKey();
  const reg = await (await api("/v1/device/code", { agent: { id: agent, name: "薰" }, body: "phone", kind: "runtime", nodeKey: key, version: "1" })).json() as any;
  await owner.web("/v1/web/device/decide", { code: reg.user_code, approve: true });
  const bodyToken = (await (await api("/v1/device/token", { device_code: reg.device_code })).json() as any).access_token;
  const code = await (await api("/v1/console/code", {}, { authorization: `Bearer ${bodyToken}` })).json() as any;
  const look = await (await owner.web("/v1/web/device/lookup", { code: code.user_code })).json() as any;
  const fp = crypto.createHash("sha256").update(Buffer.from(key, "base64url")).digest("hex").slice(0, 16).replace(/(.{4})(?!$)/g, "$1 ");
  assert.equal(look.kind, "console");
  assert.equal(look.bodyFingerprint, fp);
  assert.equal(look.fingerprint, fp);
  const bound = (await (await owner.web("/v1/web/account")).json() as any).agents.find((a: any) => a.id === agent).bodies[0].created;
  assert.equal(look.bodyBoundAt, bound);
  assert.ok(look.createdAt >= bound && look.createdAt <= Date.now());
  // 灵魂桥
  const br = await (await api("/v1/device/code", { agent: { id: agent, name: "薰" }, body: "bridge", kind: "bridge", nodeKey: nodeKey() })).json() as any;
  await owner.web("/v1/web/device/decide", { code: br.user_code, approve: true });
  const bridgeToken = (await (await api("/v1/device/token", { device_code: br.device_code })).json() as any).access_token;
  const denied = await api("/v1/console/code", {}, { authorization: `Bearer ${bridgeToken}` });
  assert.deepEqual([denied.status, ((await denied.json()) as any).error], [403, "runtime_only"]);
  // 同名身体重新绑定（新公钥）后，旧绑定发起的码不能再批准
  await bindViaWeb(owner, agent, "phone");
  assert.equal(((await (await owner.web("/v1/web/device/lookup", { code: code.user_code })).json()) as any).error, "not_yours");
});

test("控制台登录随身体解绑作废：网页解绑、DELETE /v1/me、同名重新绑定、删除 agent；1.0.1 的旧行也一样", async () => {
  const owner = new Browser(); await owner.login(51);
  const agent = crypto.randomUUID();
  const live = async (t: string) => (await asConsole(t)).status;

  const t1 = await bindViaWeb(owner, agent, "a1"); const c1 = await consoleLogin(owner, t1);
  assert.equal(await live(c1), 200);
  await owner.web("/v1/web/bodies/remove", { agent, body: "a1" });
  assert.equal(await live(c1), 401, "网页解绑");

  const t2 = await bindViaWeb(owner, agent, "a2"); const c2 = await consoleLogin(owner, t2);
  await s.app.request(PUBLIC + "/v1/me", { method: "DELETE", headers: { authorization: `Bearer ${t2}` } });
  assert.equal(await live(c2), 401, "身体自己解绑");

  const t3 = await bindViaWeb(owner, agent, "a3"); const c3 = await consoleLogin(owner, t3);
  await bindViaWeb(owner, agent, "a3");
  assert.equal(await live(c3), 401, "同名重新绑定");
  assert.equal(s.db.raw.prepare("SELECT count(*) AS n FROM sessions WHERE id = ?").get(sha(c3))!.n, 0, "库里也删了");

  const t4 = await bindViaWeb(owner, agent, "a4"); const c4 = await consoleLogin(owner, t4);
  // 模拟 1.0.1 建的旧行：没有 agent
  const legacy = "qsc_" + crypto.randomBytes(32).toString("base64url");
  const uid = (s.db.raw.prepare("SELECT user_id FROM sessions WHERE id = ?").get(sha(c4)) as any).user_id;
  s.db.raw.prepare("INSERT INTO sessions (id, user_id, expires, kind, label, agent, created, last_used) VALUES (?, ?, ?, 'console', 'a4', NULL, ?, ?)").run(sha(legacy), uid, Date.now() + DAY, Date.now(), Date.now());
  assert.equal(await live(legacy), 200);
  assert.equal((await owner.web("/v1/web/agents/remove", { agent })).status, 200);
  assert.equal(await live(c4), 401, "删除 agent");
  assert.equal(s.db.raw.prepare("SELECT count(*) AS n FROM sessions WHERE id = ?").get(sha(legacy))!.n, 0, "旧行按账户与身体名匹配");
});

test("会话寿命：控制台按 30 天续期、网页按 SYNC_SESSION_DAYS；自创建起最长 90 天", async () => {
  const owner = new Browser(); await owner.login(52);
  const tok = await consoleLogin(owner, await bindViaWeb(owner, crypto.randomUUID(), "life"));
  const set = s.db.raw.prepare("UPDATE sessions SET expires = ?, created = ? WHERE id = ?");
  const get = (id: string) => s.db.raw.prepare("SELECT expires, created FROM sessions WHERE id = ?").get(id) as { expires: number; created: number };
  set.run(Date.now() + DAY, Date.now(), sha(tok));
  await asConsole(tok);
  assert.ok(Math.abs(get(sha(tok)).expires - (Date.now() + 30 * DAY)) < 60_000, "控制台续期 30 天");
  const cookie = [...owner.jar].find(([k]) => k === "__Host-quetzal_session")![1];
  set.run(Date.now() + DAY, Date.now(), sha(cookie));
  await owner.web("/v1/web/session");
  assert.ok(Math.abs(get(sha(cookie)).expires - (Date.now() + 7 * DAY)) < 60_000, "网页续期 7 天");
  // 续期不超过创建后 90 天
  const created = Date.now() - 88 * DAY;
  set.run(Date.now() + DAY, created, sha(tok));
  await asConsole(tok);
  assert.equal(get(sha(tok)).expires, created + 90 * DAY);
  // 超过 90 天：即使没到期也作废
  set.run(Date.now() + DAY, Date.now() - 91 * DAY, sha(tok));
  assert.equal((await asConsole(tok)).status, 401);
  set.run(Date.now() + DAY, Date.now() - 91 * DAY, sha(cookie));
  assert.equal(((await (await owner.web("/v1/web/session")).json()) as any).user, null);
});

test("POST /v1/web/sessions/revoke-all：所有网页会话（含这一个）作废，控制台登录不受影响", async () => {
  const a = new Browser(); await a.login(53);
  const b = new Browser(); await b.login(53);
  const tok = await consoleLogin(a, await bindViaWeb(a, crypto.randomUUID(), "keep"));
  const r = await a.web("/v1/web/sessions/revoke-all", {});
  assert.deepEqual(await r.json(), { ok: true, revoked: 2 });
  assert.equal((await a.web("/v1/web/account")).status, 401);
  assert.equal((await b.web("/v1/web/account")).status, 401);
  assert.equal((await asConsole(tok)).status, 200);
  assert.equal((await new Browser().web("/v1/web/sessions/revoke-all", {})).status, 401);
});

test("/v1/web/* 的响应都带 Vary: Origin（含 401 与 403）", async () => {
  const b = new Browser();
  for (const r of [await b.web("/v1/web/session"), await b.web("/v1/web/account"), await b.web("/v1/web/logout", {}, "https://evil.example")]) {
    assert.match(r.headers.get("vary") ?? "", /Origin/, String(r.status));
  }
});

test("配置了 SYNC_WEB_URL 时自带网页的表单 POST 一律跳到网页前端，不做任何改动", async () => {
  const b = new Browser(); await b.login(54);
  for (const p of ["/device", "/device/decide", "/account/delete", "/account/agents/remove"]) {
    const r = await b.req(p, { method: "POST", headers: { origin: PUBLIC, "content-type": "application/x-www-form-urlencoded" }, body: "confirm=1&code=BCDFGHJK" });
    assert.equal(r.status, 303, p);
    assert.ok(r.headers.get("location")!.startsWith(WEB), p);
  }
  assert.equal((await b.web("/v1/web/account")).status, 200, "账户还在");
});

test("OAuth：临时 Cookie 用 __Host- 前缀；PKCE 的 verifier 与 challenge 对得上；缺 verifier 的回调不登录", async () => {
  const b = new Browser();
  const r = await b.req(`/login?return_to=${encodeURIComponent(WEB + "/zh/account")}`);
  assert.deepEqual([...b.jar.keys()].sort(), ["__Host-quetzal_oauth_nonce", "__Host-quetzal_oauth_state", "__Host-quetzal_oauth_verifier", "__Host-quetzal_return_to"]);
  const verifier = b.jar.get("__Host-quetzal_oauth_verifier")!;
  assert.equal(pkce.challenge, crypto.createHash("sha256").update(verifier).digest("base64url"));
  const state = new URL(r.headers.get("location")!).searchParams.get("state")!;
  b.jar.delete("__Host-quetzal_oauth_verifier");
  const cb = await b.req(`/auth/oidc/callback?code=55&state=${state}`);
  assert.match(cb.headers.get("location")!, /login=failed/);
  const c = new Browser(); await c.login(56);
  assert.equal(pkce.verifier.length >= 43, true, "回调把 verifier 交给换令牌");
  assert.match(pkce.callback, /^https:\/\/sync\.example\/auth\/oidc\/callback\?code=56&state=/, "换令牌用公开地址做 redirect_uri");
});

test("OIDC 客户端：发现文档、授权地址（PKCE S256 + nonce）、换令牌、校验 ID 令牌；邮箱没确认过不用", async () => {
  const { oidcClient } = await import("../src/auth.ts");
  const jose = await import("jose");
  const ISS = "https://id.example/auth/v1/";
  const { privateKey } = await jose.generateKeyPair("EdDSA", { crv: "Ed25519" });
  const calls: { url: string; init: RequestInit }[] = [];
  let claims: Record<string, unknown> = {};
  const json = (j: unknown) => new Response(JSON.stringify(j), { headers: { "content-type": "application/json" } });
  const fetcher = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    if (String(url) === `${ISS}.well-known/openid-configuration`) return json({ issuer: ISS, authorization_endpoint: `${ISS}oidc/authorize`, token_endpoint: `${ISS}oidc/token`, jwks_uri: `${ISS}oidc/certs`, id_token_signing_alg_values_supported: ["EdDSA"] });
    if (String(url) === `${ISS}oidc/token`) {
      const id_token = await new jose.SignJWT(claims).setProtectedHeader({ alg: "EdDSA" }).setIssuer(ISS).setAudience("quetzal-sync").setSubject("u-1").setIssuedAt().setExpirationTime("5m").sign(privateKey);
      return json({ access_token: "at", token_type: "Bearer", id_token, expires_in: 300 });
    }
    throw new Error(`unexpected ${url}`);
  }) as typeof fetch;
  const c = oidcClient(loadConfig({ SYNC_PUBLIC_URL: PUBLIC, OIDC_ISSUER: ISS, OIDC_CLIENT_ID: "quetzal-sync", OIDC_CLIENT_SECRET: "sec" }), fetcher)!;
  const u = await c.authorizationUrl({ state: "st", nonce: "no", codeChallenge: "ch" });
  assert.equal(u.origin + u.pathname, "https://id.example/auth/v1/oidc/authorize");
  assert.deepEqual(Object.fromEntries(u.searchParams), { client_id: "quetzal-sync", response_type: "code", redirect_uri: `${PUBLIC}/auth/oidc/callback`, scope: "openid profile email", state: "st", nonce: "no", code_challenge: "ch", code_challenge_method: "S256" });
  assert.equal(new Headers(calls[0].init.headers).get("user-agent"), "quetzal-sync");
  const cb = new URL(`${PUBLIC}/auth/oidc/callback?code=c1&state=st`);
  claims = { nonce: "no", preferred_username: "Kaoru@Example.com", email: "Kaoru@Example.com", email_verified: true, given_name: "Kaoru", family_name: "Kamiya" };
  assert.deepEqual(await c.user(cb, { state: "st", nonce: "no", codeVerifier: "v".repeat(43) }), { sub: "u-1", login: "Kaoru@Example.com", name: "Kaoru Kamiya", email: "kaoru@example.com" });
  const form = new URLSearchParams(String(calls.at(-1)!.init.body));
  assert.equal(form.get("code_verifier"), "v".repeat(43));
  assert.equal(form.get("redirect_uri"), `${PUBLIC}/auth/oidc/callback`);
  claims = { nonce: "no", email: "x@example.com", email_verified: false };
  assert.equal((await c.user(cb, { state: "st", nonce: "no", codeVerifier: "v".repeat(43) })).email, "", "没确认过的邮箱不当真（管理员靠它判断）");
  claims = { nonce: "other" };
  await assert.rejects(c.user(cb, { state: "st", nonce: "no", codeVerifier: "v".repeat(43) }), "nonce 不符");
  await assert.rejects(c.user(new URL(`${PUBLIC}/auth/oidc/callback?code=c1&state=forged`), { state: "st", nonce: "no", codeVerifier: "v".repeat(43) }), "state 不符");
});
