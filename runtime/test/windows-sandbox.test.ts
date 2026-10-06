// Windows 的命令沙箱（sandbox-runtime 的 srt-win）真机测试：只在 CI 的 windows runner 上、windows-install 之后跑（QUETZAL_TEST_SRT=1）。
//   她的命令以 srt-sandbox 用户运行：密钥目录与配置读不到、工作区与 data 可写、灵魂目录的 .git 不可写、保密库可读，
//   中文输出不乱码，连不到本机的网关（回环），公网照常经代理。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

const RUN = process.platform === "win32" && process.env.QUETZAL_TEST_SRT === "1";
const skip = !RUN && "只在装好沙箱的 Windows 上跑";

let ctx: any;
async function setup() {
  if (ctx) return ctx;
  process.env.QUETZAL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "quetzal-srt-"));
  process.env.QUETZAL_WORKSPACE = fs.mkdtempSync(path.join(os.tmpdir(), "quetzal-ws-"));
  process.env.QUETZAL_SRT_WIN = path.resolve("node_modules/@anthropic-ai/sandbox-runtime/vendor/srt-win", process.arch === "arm64" ? "arm64" : "x64", "srt-win.exe");
  const config = await import("../src/config.ts");
  config.loadConfig();
  (await import("../src/store.ts")).openStore();
  config.writeSecret("gateway.token", "gw_secret_value_123456789");
  fs.mkdirSync(path.join(config.paths.soul, ".git"), { recursive: true });
  const sandbox = await import("../src/sandbox.ts");
  const sh = await import("../src/sh.ts");
  await sandbox.prepareSandbox();
  ctx = { config, sandbox, sh };
  return ctx;
}

test("沙箱就绪：kind 为 srt", { skip }, async () => {
  const { sandbox } = await setup();
  const st = sandbox.sandboxStatus();
  assert.equal(st.kind, "srt", st.note);
});

test("密钥与配置读不到，工作区与 data 可写，.git 不可写，保密库可读，中文不乱码", { skip }, async () => {
  const { config, sh } = await setup();
  const { paths } = config;
  const r = await sh.shell(`try { Get-Content -LiteralPath '${path.join(paths.secrets, "gateway.token")}' -ErrorAction Stop; 'LEAK' } catch { 'denied' }`);
  assert.match(r.out, /denied/); assert.doesNotMatch(r.out, /gw_secret|LEAK/);
  assert.match((await sh.shell(`try { Get-ChildItem -LiteralPath '${paths.config}' -ErrorAction Stop | Out-Null; 'LEAK' } catch { 'denied' }`)).out, /denied/);
  assert.match((await sh.shell(`Set-Content -LiteralPath (Join-Path $PWD 'a.txt') -Value ok; Get-Content a.txt`)).out, /ok/, "工作区可写");
  assert.match((await sh.shell(`Set-Content -LiteralPath '${path.join(paths.data, "b.txt")}' -Value ok; 'wrote'`)).out, /wrote/);
  assert.match((await sh.shell(`try { Set-Content -LiteralPath '${path.join(paths.soul, ".git", "x")}' -Value x -ErrorAction Stop; 'LEAK' } catch { 'denied' }`)).out, /denied/);
  const { saveSecret } = await import("../src/mind/secrets.ts");
  const v = saveSecret("demo_token", "vault-value-123456");
  assert.match((await sh.shell(`Get-Content -LiteralPath '${v}'`)).out, /vault-value-123456/, "保密库可读");
  assert.match((await sh.shell("Write-Output '你好，世界'")).out, /你好，世界/);
});

test("连不到本机的端口（网关所在），后台任务与超时照常", { skip }, async () => {
  const { sh } = await setup();
  const srv = http.createServer((_q, s) => s.end("SECRET-GATEWAY")).listen(0, "127.0.0.1");
  await new Promise((r) => srv.once("listening", r));
  const port = (srv.address() as any).port;
  const r = await sh.shell(`try { (Invoke-WebRequest -UseBasicParsing -TimeoutSec 10 http://127.0.0.1:${port}/).Content } catch { 'blocked' }`, 60_000);
  srv.close();
  assert.doesNotMatch(r.out, /SECRET-GATEWAY/); assert.match(r.out, /blocked/);
  const j = await sh.startJob("Start-Sleep -Seconds 30; 'not-stopped'");
  sh.stopJob(j.id);
  for (let i = 0; i < 100 && !sh.getJob(j.id)!.ended; i++) await new Promise((res) => setTimeout(res, 100));
  assert.ok(sh.getJob(j.id)!.ended, "停止后结束"); assert.doesNotMatch(sh.getJob(j.id)!.out, /not-stopped/);
});
