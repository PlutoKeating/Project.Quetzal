// 控制台登录与账户代理：身体令牌申请码 → 人批准 → 账户令牌存进 secrets（0600）→ 账户接口带上它；令牌失效时回到未登录。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

process.env.QUETZAL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "quetzal-account-"));
const { paths, loadConfig } = await import("../src/config.ts");
loadConfig();
const { openStore } = await import("../src/store.ts");
openStore();
const acct = await import("../src/mesh/account.ts");

// 模拟同步服务：轮询第二次时批准
let polls = 0, revoked = false;
const seen: string[] = [];
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    const auth = req.headers.authorization ?? "";
    seen.push(`${req.method} ${req.url} ${auth.slice(7, 11)}`);
    const send = (status: number, j: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(j)); };
    if (req.url === "/v1/console/code") return auth === "Bearer qsb_body" ? send(200, { device_code: "dc", user_code: "BCDF-GHJK", verification_uri_complete: "https://web.example/device?code=BCDF-GHJK", expires_in: 900, interval: 1 }) : send(401, { error: "unauthorized" });
    if (req.url === "/v1/device/token") return ++polls < 2 ? send(400, { error: "authorization_pending" }) : send(200, { access_token: "qsc_account", token_type: "bearer", account: "pluto", kind: "console" });
    if (req.url?.startsWith("/v1/web/")) {
      if (auth !== "Bearer qsc_account" || revoked) return send(401, { error: "unauthorized" });
      if (req.url === "/v1/web/account") return send(200, { user: { login: "pluto", name: "" }, agents: [], consoles: [], limits: { agents: 20, bodies: 16 } });
      if (req.url === "/v1/web/device/lookup") return JSON.parse(body).code === "BCDF-GHJK" ? send(200, { code: "BCDF-GHJK" }) : send(404, { error: "bad_code" });
      if (req.url === "/v1/web/logout") return send(200, { ok: true });
    }
    send(404, { error: "not_found" });
  });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
after(() => server.close());

test("没绑定：不能登录账户", async () => {
  assert.equal(acct.accountStatus().bound, false);
  await assert.rejects(acct.signIn(), /先在「设备」里登录/);
});

test("控制台登录 → 账户接口 → 令牌被吊销后回到未登录", async () => {
  fs.mkdirSync(paths.secrets, { recursive: true });
  fs.writeFileSync(path.join(paths.secrets, "sync.json"), JSON.stringify({ server: url, token: "qsb_body", agent: "a", body: "honor9", account: "pluto" }));
  const started = await acct.signIn();
  assert.deepEqual([started.bound, started.signedIn, started.signing?.code], [true, false, "BCDF-GHJK"]);
  const t = Date.now();
  while (!acct.accountStatus().signedIn) { if (Date.now() - t > 8000) throw new Error("等登录超时"); await new Promise((r) => setTimeout(r, 100)); }
  const file = path.join(paths.secrets, "sync-account.json");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(acct.accountStatus().account, "pluto");
  assert.equal(((await acct.account.get()) as any).user.login, "pluto");
  await assert.rejects(acct.account.lookup("XXXX-XXXX"), /bad_code/);
  revoked = true;
  await assert.rejects(acct.account.get(), /失效/);
  assert.equal(fs.existsSync(file), false, "失效的令牌删掉了");
  assert.equal(acct.accountStatus().signedIn, false);
  assert.ok(seen.some((x) => x.startsWith("POST /v1/console/code qsb_")), "申请码时带的是身体令牌");
});

test("一次登录：绑定时随批准拿到的控制台令牌直接存下，账户页即为已登录；格式不对的不收", async () => {
  revoked = false;
  const { pollBinding } = await import("../src/mesh/binding.ts");
  const fake = http.createServer((req, res) => {
    let body = ""; req.on("data", (d) => (body += d)); req.on("end", () => {
      const code = JSON.parse(body).device_code;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ access_token: "qsb_new", agent: { id: "a" }, body: "honor9", account: "pluto", console: { access_token: code === "good" ? "qsc_account" : "not a token", expires_in: 1 } }));
    });
  });
  await new Promise<void>((r) => fake.listen(0, "127.0.0.1", () => r()));
  const furl = `http://127.0.0.1:${(fake.address() as { port: number }).port}`;
  const start = (device_code: string) => ({ device_code, user_code: "X", verification_uri: "", verification_uri_complete: "", expires_in: 30, interval: 1 });
  const bad = await pollBinding(furl, start("bad"), new AbortController().signal);
  assert.equal(bad.consoleToken, undefined);
  const b = await pollBinding(furl, start("good"), new AbortController().signal);
  fake.close();
  assert.equal(b.consoleToken, "qsc_account");
  acct.adoptConsoleToken(url, b.consoleToken!, b.account);
  assert.deepEqual([acct.accountStatus().signedIn, acct.accountStatus().account], [true, "pluto"]);
  assert.equal(fs.statSync(path.join(paths.secrets, "sync-account.json")).mode & 0o777, 0o600);
  assert.equal(((await acct.account.get()) as any).user.login, "pluto");
});
