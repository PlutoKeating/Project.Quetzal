// 一个链接接入（connect）：输出给人的链接与核对词后立即退出，后台等批准；不报读不到的 agent id，带上部署公钥；
// 设备码只在 0600 的文件里；connect --wait 报告结果。用本机的假同步服务。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFileSync, execFile } from "node:child_process";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-connect-"));
const cli = path.resolve("src/cli.ts");
let asked: any[] = [];
let soul: unknown = { error: "同步服务还没有配置 GitHub App" };
const server = http.createServer((req, res) => {
  let body = ""; req.on("data", (d) => (body += d));
  req.on("end", () => {
    const send = (j: unknown) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(j)); };
    if (req.url === "/v1/device/code") { asked.push(JSON.parse(body)); return send({ device_code: "qdc_secret_device_code", user_code: "BCDF-GHJK", verification_uri: "x", verification_uri_complete: "https://web.example/device?code=BCDF-GHJK", expires_in: 60, interval: 1, check: "🦊🌙🍵" }); }
    if (req.url === "/v1/device/token") return send({ access_token: "qsb_bridge", token_type: "bearer", agent: { id: "11111111-2222-4333-8444-555555555555", name: "小满" }, body: "hermes-pc", account: "pluto", ...(soul ? { soul } : {}) });
    res.writeHead(404); res.end();
  });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const SYNC = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
after(() => server.close());

const env = (home: string) => ({ ...process.env, SOUL_BRIDGE_HOME: path.join(tmp, home, ".agent-soul"), HOME: path.join(tmp, home), SOUL_BRIDGE_NO_SERVICE: "1", SOUL_ALLOW_LOCAL_REMOTE: "1" });
// 异步执行：假同步服务就在本进程里，同步执行会卡住它的事件循环
const run = (home: string, ...a: string[]) => new Promise<string>((r) => execFile(process.execPath, [cli, ...a], { env: env(home) }, (_e, out) => r(String(out))));
const hermes = (home: string) => { const h = path.join(tmp, home, ".hermes"); fs.mkdirSync(path.join(h, "memories"), { recursive: true }); fs.writeFileSync(path.join(h, "SOUL.md"), "# 小满\n\n我是小满。\n"); return h; };

test("新装的 Hermes：输出链接与核对词就退出；不报 agent id、带部署公钥；链接失败时 --wait 说明原因", async () => {
  const h = hermes("n1");
  const out = JSON.parse(await run("n1", "connect", "--framework", "hermes", "--home", h, "--server", SYNC, "--body", "hermes-pc"));
  assert.equal(out.needHuman, true);
  assert.equal(out.link, "https://web.example/device?code=BCDF-GHJK");
  assert.equal(out.check, "🦊🌙🍵");
  assert.match(out.say, /🦊🌙🍵/);
  assert.ok(!JSON.stringify(out).includes("qdc_secret_device_code"), "设备码不出现在输出里");
  const req = asked.at(-1);
  assert.equal(req.agent.id, undefined);
  assert.equal(req.kind, "bridge");
  assert.match(req.soulKey, /^ssh-ed25519 AAAA/);
  const w = JSON.parse(await run("n1", "connect", "--wait"));
  assert.equal(w.ok, false);
  assert.match(w.error, /GitHub App/);
});

test("已接入的 Hermes 再 connect：报 agent id；同步服务没给仓库时沿用已有的远端，保存绑定（0600）并完成", async () => {
  const remote = path.join(tmp, "agent.soul.git");
  execFileSync("git", ["init", "--bare", "-b", "main", remote]);
  const h = hermes("m1");
  await run("m1", "init", "--framework", "hermes", "--repo", remote, "--home", h, "--body", "hermes-pc", "--agent", "kaoru", "--poll", "0");
  const agentId = JSON.parse(execFileSync("git", ["--git-dir", remote, "show", "main:agent.json"]).toString()).id;
  soul = undefined;
  await run("m1", "connect", "--framework", "hermes", "--home", h, "--server", SYNC);
  assert.equal(asked.at(-1).agent.id, agentId);
  const w = await run("m1", "connect", "--wait");
  assert.match(w, /已接入：kaoru/);
  const bind = path.join(tmp, "m1", ".agent-soul", "kaoru", "sync.json");
  assert.equal(fs.statSync(bind).mode & 0o777, 0o600);
  assert.equal(JSON.parse(fs.readFileSync(bind, "utf8")).token, "qsb_bridge");
  assert.ok(!fs.existsSync(path.join(tmp, "m1", ".agent-soul", "kaoru", "connect-device.json")), "设备码文件用完即删");
});
