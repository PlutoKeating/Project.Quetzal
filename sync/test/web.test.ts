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
  GITHUB_CLIENT_ID: "x", GITHUB_CLIENT_SECRET: "y", TURN_SECRET: "s".repeat(40), SYNC_TRUST_PROXY: "1",
});
const github = {
  authorizationUrl: (state: string) => new URL(`https://github.example/authorize?state=${state}`),
  user: async (code: string) => ({ id: Number(code), login: `user${code}`, name: `User ${code}` }),
};
const s = createSyncServer(cfg, { github });
after(async () => { await s.close(); });

class Browser {
  jar = new Map<string, string>();
  async req(p: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
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
    return (await this.req(`/auth/github/callback?code=${id}&state=${state}`)).headers.get("location");
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
  assert.equal(acc.consoles.length, 1);
  assert.deepEqual([acc.consoles[0].body, acc.consoles[0].current], ["honor9", true]);
  assert.equal((await s.app.request(PUBLIC + "/v1/web/account", { headers: { authorization: `Bearer ${bodyToken}` } })).status, 401, "身体令牌不能当账户令牌");
  assert.equal((await s.app.request(PUBLIC + "/v1/me", { headers: { authorization: `Bearer ${tok.access_token}` } })).status, 401, "账户令牌不能当身体令牌");
  assert.equal((await new Browser().req("/v1/web/account", { headers: { origin: WEB, cookie: `__Host-quetzal_session=${tok.access_token}` } })).status, 401, "控制台令牌不能当 Cookie 用");

  // 网页上吊销 → 控制台立即失效
  const handle = ((await (await owner.web("/v1/web/account")).json()) as any).consoles[0].id;
  assert.equal((await owner.web("/v1/web/consoles/revoke", { id: handle })).status, 200);
  assert.equal((await asConsole("/v1/web/account")).status, 401);
});
