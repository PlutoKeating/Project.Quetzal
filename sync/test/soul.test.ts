// 一个链接接入：身体申请设备码时带上部署公钥 → 人批准（可以先选 agent）→ 同一个标签页经 GitHub 跳一次 → 同步服务只给灵魂仓库加这一把公钥，
// 用户令牌立即吊销 → 身体轮询拿到身体令牌与仓库地址。以及管理员一键创建 GitHub App。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.ts";
import { createSyncServer } from "../src/server.ts";
import { sshFingerprint, pickSoulRepo, type SoulGitHub } from "../src/github-app.ts";

const PUBLIC = "https://sync.example";
const WEB = "https://www.example";
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "quetzal-sync-soul-"));
const cfg = loadConfig({ SYNC_PUBLIC_URL: PUBLIC, SYNC_WEB_URL: WEB, SYNC_DATA_DIR: dataDir, OIDC_ISSUER: "https://id.example", OIDC_CLIENT_ID: "x", OIDC_CLIENT_SECRET: "y", SYNC_TRUST_PROXY: "1", SYNC_ADMINS: "Admin7" });
const idp = {
  authorizationUrl: async ({ state }: { state: string }) => new URL(`https://id.example/authorize?state=${state}`),
  user: async (cb: URL) => { const code = cb.searchParams.get("code")!; return { sub: `sub-${code}`, login: `user${code}`, name: "", email: `user${code}@example.com` }; },
};

// 假的 GitHub：授权码换令牌（fetcher）与仓库操作（SoulGitHub）
const calls: string[] = [];
const fake = { installed: true, ghUser: 7, repos: [{ fullName: "user7/kaoru.soul", name: "kaoru.soul", private: true }], keyResult: true as true | { error: string } };
const fetcher = (async (url: string | URL | Request) => {
  const u = String(url);
  if (u.includes("/login/oauth/access_token")) return new Response(JSON.stringify({ access_token: "ghu_test" }), { headers: { "content-type": "application/json" } });
  if (u.includes("/app-manifests/")) return new Response(JSON.stringify({ id: 99, slug: "quetzal-test", client_id: "Iv1.abc", client_secret: "sec", html_url: "https://github.com/apps/quetzal-test" }), { status: 201 });
  return new Response("{}", { status: 404 });
}) as typeof fetch;
const soul: SoulGitHub = {
  app: { id: 99, slug: "quetzal-test", clientId: "Iv1.abc", clientSecret: "sec", htmlUrl: "" },
  user: async () => ({ id: fake.ghUser, login: `user${fake.ghUser}` }),
  installation: async () => (fake.installed ? { id: 1, all: false } : undefined),
  repos: async () => fake.repos,
  createRepo: async (_t, name) => { calls.push(`create ${name}`); return { fullName: `user7/${name}` }; },
  addDeployKey: async (_t, repo, title, key) => { calls.push(`key ${repo} ${title} ${key.split(" ")[0]}`); return fake.keyResult; },
  revoke: async (t) => { calls.push(`revoke ${t}`); },
};
const s = createSyncServer(cfg, { login: idp, soul, fetcher });
after(async () => { await s.close(); });

class Browser {
  jar = new Map<string, string>();
  ip = `10.3.${crypto.randomInt(255)}.${crypto.randomInt(255)}`;
  async req(p: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    headers.set("x-forwarded-for", this.ip);
    if (this.jar.size) headers.set("cookie", [...this.jar].map(([k, v]) => `${k}=${v}`).join("; "));
    const r = await s.app.request(p.startsWith("http") ? p : PUBLIC + p, { ...init, headers, redirect: "manual" });
    for (const c of r.headers.getSetCookie()) {
      const [kv, ...attrs] = c.split(";"); const i = kv.indexOf("=");
      const k = kv.slice(0, i).trim(), v = kv.slice(i + 1).trim();
      if (!v || attrs.some((a) => /max-age=0|expires=thu, 01 jan 1970/i.test(a))) this.jar.delete(k); else this.jar.set(k, v);
    }
    return r;
  }
  web(p: string, body: unknown) { return this.req(p, { method: "POST", headers: { origin: WEB, "content-type": "application/json" }, body: JSON.stringify(body) }); }
  async login(id: number) {
    const r = await this.req(`/login?return_to=${encodeURIComponent(WEB + "/account")}`);
    const state = new URL(r.headers.get("location")!).searchParams.get("state")!;
    await this.req(`/auth/oidc/callback?code=${id}&state=${state}`);
  }
}
const ip = () => `10.4.${crypto.randomInt(255)}.${crypto.randomInt(255)}`;
const api = (p: string, body: unknown) => s.app.request(PUBLIC + p, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip() }, body: JSON.stringify(body) });
const nodeKey = () => (crypto.generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" }) as { x: string }).x;
const sshKey = () => {
  const raw = Buffer.from((crypto.generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" }) as { x: string }).x, "base64url");
  const part = (b: Buffer) => { const l = Buffer.alloc(4); l.writeUInt32BE(b.length); return Buffer.concat([l, b]); };
  return `ssh-ed25519 ${Buffer.concat([part(Buffer.from("ssh-ed25519")), part(raw)]).toString("base64")} soul-bridge@test`;
};

async function request(body: string, key: string, agent?: string) {
  const r = await api("/v1/device/code", { agent: { ...(agent ? { id: agent } : {}), name: "Kaoru" }, body, kind: "bridge", nodeKey: nodeKey(), version: "1.1.0", soulKey: key });
  assert.equal(r.status, 200);
  return await r.json() as { device_code: string; user_code: string; check: string };
}
const poll = async (device_code: string) => { const r = await api("/v1/device/token", { device_code }); return { status: r.status, json: await r.json() as any }; };

test("不合法的部署公钥直接拒收", async () => {
  const r = await api("/v1/device/code", { agent: { name: "x" }, body: "b", kind: "bridge", nodeKey: nodeKey(), soulKey: "ssh-rsa AAAAB3Nza" });
  assert.equal(r.status, 400);
});

test("一个链接接入：选 agent → 批准 → 经 GitHub 加部署密钥 → 身体拿到仓库地址，令牌被吊销", async () => {
  const b = new Browser(); await b.login(7);
  const key = sshKey();
  const start = await request("hermes-a", key);
  assert.match(start.check, /^\p{Extended_Pictographic}/u);
  const look = await b.web("/v1/web/device/lookup", { code: start.user_code });
  const L = await look.json() as any;
  assert.equal(L.check, start.check, "批准页的核对词与身体给出的一致");
  assert.equal(L.soulKey, sshFingerprint(key));
  assert.equal(L.soulLink, true);
  assert.deepEqual(L.choose, []); // 账户里还没有 agent：新建
  const dec = await (await b.web("/v1/web/device/decide", { code: start.user_code, approve: true, agent: "new" })).json() as any;
  assert.match(dec.next, /^https:\/\/sync\.example\/soul\/link\?t=qsl_/);
  assert.equal((await poll(start.device_code)).json.error, "authorization_pending", "仓库链接完成之前身体继续等");
  // 另一个浏览器（例如 App 打开的外部浏览器，没有登录会话）凭票据也能走
  const other = new Browser();
  const go = await other.req(dec.next);
  const gh = new URL(go.headers.get("location")!);
  assert.equal(gh.origin + gh.pathname, "https://github.com/login/oauth/authorize");
  assert.equal(gh.searchParams.get("client_id"), "Iv1.abc");
  assert.equal(gh.searchParams.get("code_challenge_method"), "S256");
  calls.length = 0;
  const back = await other.req(`/soul/callback?code=abc&state=${gh.searchParams.get("state")}`);
  const to = new URL(back.headers.get("location")!);
  assert.equal(to.origin + to.pathname, WEB + "/device");
  assert.equal(to.searchParams.get("soul"), "linked");
  assert.deepEqual(calls, ["key user7/kaoru.soul quetzal · hermes-a ssh-ed25519", "revoke ghu_test"]);
  const p = await poll(start.device_code);
  assert.equal(p.status, 200);
  assert.deepEqual(p.json.soul, { repo: "user7/kaoru.soul", remote: "git@github.com:user7/kaoru.soul.git" });
  assert.match(p.json.access_token, /^qsb_/);
  // 票据用过就失效
  const again = await other.req(dec.next);
  assert.equal(new URL(again.headers.get("location")!).searchParams.get("soul"), "expired");
});

test("账户里已有 agent：必须选一个；没装 App 时先去安装页，装完回来继续", async () => {
  const b = new Browser(); await b.login(7);
  const start = await request("hermes-b", sshKey());
  const L = await (await b.web("/v1/web/device/lookup", { code: start.user_code })).json() as any;
  assert.equal(L.choose.length, 1);
  assert.equal(L.choose[0].repo, "user7/kaoru.soul");
  assert.equal((await b.web("/v1/web/device/decide", { code: start.user_code, approve: true })).status, 400, "没选 agent 不行");
  const dec = await (await b.web("/v1/web/device/decide", { code: start.user_code, approve: true, agent: L.choose[0].id })).json() as any;
  fake.installed = false;
  const gh = new URL((await b.req(dec.next)).headers.get("location")!);
  const inst = new URL((await b.req(`/soul/callback?code=c1&state=${gh.searchParams.get("state")}`)).headers.get("location")!);
  assert.equal(inst.origin + inst.pathname, "https://github.com/apps/quetzal-test/installations/new");
  fake.installed = true;
  calls.length = 0;
  const done = new URL((await b.req(`/soul/callback?code=c2&installation_id=1&setup_action=install`)).headers.get("location")!);
  assert.equal(done.searchParams.get("soul"), "linked");
  assert.ok(calls.includes("revoke ghu_test"));
  const p = await poll(start.device_code);
  assert.equal(p.json.agent.id, L.choose[0].id, "接进了选定的 agent");
  assert.equal(p.json.soul.repo, "user7/kaoru.soul");
});

test("GitHub 账户不是这个账号第一次链接时用的那个：不加密钥，身体拿到失败原因", async () => {
  const b = new Browser(); await b.login(7);
  const start = await request("hermes-c", sshKey());
  const L = await (await b.web("/v1/web/device/lookup", { code: start.user_code })).json() as any;
  const dec = await (await b.web("/v1/web/device/decide", { code: start.user_code, approve: true, agent: L.choose[0].id })).json() as any;
  fake.ghUser = 8;
  calls.length = 0;
  const gh = new URL((await b.req(dec.next)).headers.get("location")!);
  const to = new URL((await b.req(`/soul/callback?code=x&state=${gh.searchParams.get("state")}`)).headers.get("location")!);
  fake.ghUser = 7;
  assert.equal(to.searchParams.get("soul"), "failed");
  assert.ok(!calls.some((x) => x.startsWith("key")));
  assert.ok(calls.includes("revoke ghu_test"), "失败也要吊销");
  const p = await poll(start.device_code);
  assert.equal(p.status, 200);
  assert.match(p.json.soul.error, /之前链接灵魂仓库用的那个/);
});

test("同一个 GitHub 账户不能被两个账号拿去链接", async () => {
  const b = new Browser(); await b.login(9);
  const start = await request("hermes-d", sshKey());
  const dec = await (await b.web("/v1/web/device/decide", { code: start.user_code, approve: true, agent: "new" })).json() as any;
  calls.length = 0;
  const gh = new URL((await b.req(dec.next)).headers.get("location")!);
  const to = new URL((await b.req(`/soul/callback?code=x&state=${gh.searchParams.get("state")}`)).headers.get("location")!);
  assert.equal(to.searchParams.get("soul"), "failed", "GitHub 账户 7 已经属于 sub-7");
  assert.ok(!calls.some((x) => x.startsWith("key")));
});

test("伪造的回调（state 不符、没有票据）什么都不做", async () => {
  const b = new Browser();
  const r = await b.req(`/soul/callback?code=x&state=y`);
  assert.equal(new URL(r.headers.get("location")!).searchParams.get("soul"), "expired");
  assert.equal(new URL((await b.req(`/soul/link?t=qsl_${"a".repeat(43)}`)).headers.get("location")!).searchParams.get("soul"), "expired");
});

test("挑灵魂仓库：已记下的 → <短名>.soul → 唯一的 .soul；分不清时不猜", () => {
  const r = (n: string, p = true) => ({ fullName: `u/${n}`, name: n, private: p });
  assert.equal(pickSoulRepo([r("a.soul"), r("kaoru.soul")], "u/a.soul", "Kaoru"), "u/a.soul");
  assert.equal(pickSoulRepo([r("a.soul"), r("kaoru.soul")], "", "Kaoru"), "u/kaoru.soul");
  assert.equal(pickSoulRepo([r("x.soul"), r("site")], "", "Kaoru"), "u/x.soul");
  assert.equal(pickSoulRepo([r("x.soul"), r("y.soul")], "", "Kaoru"), "ambiguous");
  assert.equal(pickSoulRepo([r("x.soul", false)], "", "Kaoru"), undefined, "公开仓库不算");
});

test("管理员一键创建 GitHub App：非管理员 403；清单页放宽 form-action；回来后保存凭据（0600）", async () => {
  const s2dir = fs.mkdtempSync(path.join(os.tmpdir(), "quetzal-sync-app-"));
  const s2 = createSyncServer(loadConfig({ SYNC_PUBLIC_URL: PUBLIC, SYNC_DATA_DIR: s2dir, OIDC_ISSUER: "https://id.example", OIDC_CLIENT_ID: "x", OIDC_CLIENT_SECRET: "y", SYNC_ADMINS: "Admin7@example.com" }), { login: idp, fetcher });
  try {
    const jar = new Map<string, string>();
    const req = async (p: string) => {
      const r = await s2.app.request(PUBLIC + p, { headers: { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; "), "x-forwarded-for": "10.9.9.9" }, redirect: "manual" });
      for (const c of r.headers.getSetCookie()) { const kv = c.split(";")[0]; const i = kv.indexOf("="); const v = kv.slice(i + 1); if (v) jar.set(kv.slice(0, i), v); else jar.delete(kv.slice(0, i)); }
      return r;
    };
    const login = async (id: number) => { const r = await req("/login"); const st = new URL(r.headers.get("location")!).searchParams.get("state"); await req(`/auth/oidc/callback?code=${id}&state=${st}`); };
    await login(8);
    assert.equal((await req("/setup/github-app")).status, 403);
    await login(7); // user7@example.com 不是管理员
    assert.equal((await req("/setup/github-app")).status, 403);
    jar.clear();
    const gh2 = { ...idp, user: async () => ({ sub: "sub-70", login: "admin", name: "", email: "admin7@example.com" }) };
    const s3 = createSyncServer(loadConfig({ SYNC_PUBLIC_URL: PUBLIC, SYNC_DATA_DIR: s2dir, OIDC_ISSUER: "https://id.example", OIDC_CLIENT_ID: "x", OIDC_CLIENT_SECRET: "y", SYNC_ADMINS: "Admin7@example.com" }), { login: gh2, fetcher });
    try {
      const req3 = async (p: string) => {
        const r = await s3.app.request(PUBLIC + p, { headers: { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; "), "x-forwarded-for": "10.9.9.8" }, redirect: "manual" });
        for (const c of r.headers.getSetCookie()) { const kv = c.split(";")[0]; const i = kv.indexOf("="); const v = kv.slice(i + 1); if (v) jar.set(kv.slice(0, i), v); else jar.delete(kv.slice(0, i)); }
        return r;
      };
      const r = await req3("/login"); await req3(`/auth/oidc/callback?code=1&state=${new URL(r.headers.get("location")!).searchParams.get("state")}`);
      const page = await req3("/setup/github-app");
      assert.equal(page.status, 200);
      assert.match(page.headers.get("content-security-policy")!, /form-action https:\/\/github\.com/);
      const html = await page.text();
      const state = /state=([\w-]+)"/.exec(html)![1];
      assert.match(html, /administration/);
      assert.equal((await req3(`/setup/github-app/done?code=m1&state=wrong`)).status, 400);
      assert.equal((await req3(`/setup/github-app/done?code=m1&state=${state}`)).status, 400, "失败一次 state 就作废，要重新发起");
      const state2 = /state=([\w-]+)"/.exec(await (await req3("/setup/github-app")).text())![1];
      const done = await req3(`/setup/github-app/done?code=m1&state=${state2}`);
      assert.equal(done.status, 302);
      const saved = path.join(s2dir, "github-app.json");
      assert.equal(fs.statSync(saved).mode & 0o777, 0o600);
      assert.equal(JSON.parse(fs.readFileSync(saved, "utf8")).slug, "quetzal-test");
      assert.equal(s3.auth.soul?.app.slug, "quetzal-test", "不用重启就换上");
    } finally { await s3.close(); }
  } finally { await s2.close(); }
});
