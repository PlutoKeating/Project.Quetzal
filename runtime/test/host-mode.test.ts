// 真实环境模式（host-mode.ts）：按会话进入与退出、她的请求必须经对方批准、空闲超时与急停自动退出、重启后不保持、
// 真实环境里的命令不经沙箱且进审计带标记、基座自己的与像令牌的环境变量不传给她的命令、系统提示写明当前模式。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

process.env.QUETZAL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "quetzal-host-"));
process.env.QUETZAL_SANDBOX = "none"; // 「沙箱」这一侧用部署者允许的不隔离运行代替：这里只比较两条路径的差别（环境变量），不依赖本机有没有 bwrap
process.env.MY_SERVICE_API_TOKEN = "should-not-reach-host-commands";
const { loadConfig, saveConfig, paths } = await import("../src/config.ts");
loadConfig();
saveConfig({ sandbox: { allowUnsandboxed: true }, permissions: { shell: "allow" } } as never);
const store = await import("../src/store.ts");
store.openStore();
const host = await import("../src/host-mode.ts");
const guard = await import("../src/guard/guard.ts");
const { callTool } = await import("../src/mind/tools.ts");
const { getJob } = await import("../src/sh.ts");
const { ops } = await import("../src/ops.ts");
const { systemPrompt } = await import("../src/mind/prompt.ts");
const { Session } = await import("../src/mind/activity.ts");

const win = process.platform === "win32";
const probe = win ? `if ($env:QUETZAL_HOME) { "home=$env:QUETZAL_HOME" } else { "home=none" }; if ($env:MY_SERVICE_API_TOKEN) { "tok=yes" } else { "tok=no" }`
  : `echo "home=\${QUETZAL_HOME:-none}"; echo "tok=\${MY_SERVICE_API_TOKEN:+yes}"`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const chat = (conv: string) => new Session("chat", "控制台", undefined, conv);
const lastAudit = (action: string) => store.listAudit(50).find((r: any) => r.action === action) as any;

test("对方在控制台打开：只对这个会话生效，命令不经沙箱、不带基座与令牌类的环境变量，审计带标记；退出后回到沙箱", async () => {
  const s = chat("h1"), other = chat("h2");
  try {
    assert.ok((await callTool("shell", { command: probe }, "测试", { session: s })).text.includes(`home=${paths.home}`), "沙箱这一侧照常带 QUETZAL_HOME");
    ops["host.enter"]({ conv: "h1" }, "控制台");
    assert.equal(host.hostModes().length, 1);
    assert.equal(host.hostModes()[0].by, "user");
    const r = await callTool("shell", { command: probe }, "测试", { session: s });
    assert.match(r.text, /真实环境/);
    assert.match(r.text, /home=none/);
    assert.doesNotMatch(r.text, /tok=yes/);
    assert.match(String(lastAudit("shell").args), /"realEnv":true/);
    assert.doesNotMatch((await callTool("shell", { command: probe }, "测试", { session: other })).text, /home=none/, "其他会话仍在沙箱里");
    assert.doesNotMatch(String(lastAudit("shell").args), /realEnv/);
    const sub = new Session("agent", "子agent", undefined, "h1"); // 子 agent 与父会话同一个 conv，也不算
    assert.doesNotMatch((await callTool("shell", { command: probe }, "测试", { session: sub })).text, /home=none/);
    sub.close();
    assert.match(systemPrompt("", { conv: "h1" }), /## 真实环境（此刻开启）/);
    assert.match(systemPrompt("", { conv: "h2" }), /## 命令在沙箱里/);
    assert.equal(ops["host.exit"]({ conv: "h1" }, "控制台"), true);
    assert.equal(host.hostActive("h1"), undefined);
    assert.doesNotMatch((await callTool("shell", { command: probe }, "测试", { session: s })).text, /home=none/);
    assert.ok(lastAudit("host.enter"));
    assert.ok(lastAudit("host.exit"));
  } finally { s.close(); other.close(); host.resetHost(); }
});

test("她请求进入：每次都要对方批准（即使执行命令是「允许」）；拒绝不进入；理由必填；只能在对话中；可以自己退出", async () => {
  const s = chat("h3");
  try {
    assert.match((await callTool("host_mode", { action: "request", reason: " " }, "测试", { session: s })).text, /要写明理由/);
    const think = new Session("think");
    assert.match((await callTool("host_mode", { action: "request", reason: "x" }, "测试", { session: think })).text, /只能在对话中/);
    think.close();

    let p = callTool("host_mode", { action: "request", reason: "gh 要用主机上的登录" }, "测试", { session: s });
    for (let i = 0; i < 50 && !guard.approvals().length; i++) await sleep(10);
    const a = guard.approvals()[0];
    assert.match(a.action, /真实环境/);
    assert.equal(a.reason, "gh 要用主机上的登录");
    assert.equal(host.hostActive("h3"), undefined, "批准之前不进入");
    guard.decide(a.id, false, "测试");
    assert.match((await p).text, /没有同意/);
    assert.equal(host.hostActive("h3"), undefined);

    p = callTool("host_mode", { action: "request", reason: "gh 要用主机上的登录" }, "测试", { session: s });
    for (let i = 0; i < 50 && !guard.approvals().length; i++) await sleep(10);
    guard.decide(guard.approvals()[0].id, true, "测试");
    assert.match((await p).text, /已进入真实环境/);
    assert.equal(host.hostActive("h3")?.by, "agent");
    assert.match((await callTool("host_mode", { action: "exit" }, "测试", { session: s })).text, /已退出/);
    assert.equal(host.hostActive("h3"), undefined);
  } finally { s.close(); host.resetHost(); }
});

test("空闲超时自动退出；退出时结束真实环境里的后台任务与前台命令", { skip: win && "用 sleep 与 POSIX 进程组" }, async () => {
  const s = chat("h4");
  try {
    host.enterHost("h4", "user", "", "控制台");
    const bg = await callTool("shell", { command: "sleep 30", background: true }, "测试", { session: s });
    const id = bg.text.match(/任务 (\w+)/)![1];
    const fg = callTool("shell", { command: "sleep 30; echo late", timeout: 60 }, "测试", { session: s });
    await sleep(300);
    host.ageHost("h4", host.IDLE_MS);
    const t0 = Date.now();
    assert.equal(host.hostActive("h4"), undefined, "过了空闲时限");
    const r = await fg;
    assert.ok(Date.now() - t0 < 5000, "前台命令被结束");
    assert.doesNotMatch(r.text, /late/);
    for (let i = 0; i < 50 && !getJob(id)!.ended; i++) await sleep(50);
    assert.ok(getJob(id)!.ended, "后台任务被停止");
    assert.match(String(lastAudit("host.exit").reason), /自动回到沙箱/);
  } finally { s.close(); host.resetHost(); }
});

test("急停：立即退出全部真实环境；急停中不能进入", async () => {
  host.enterHost("h5", "user", "", "控制台");
  host.enterHost("h6", "user", "", "控制台");
  guard.emergencyStop("测试", "急停测试", { scope: "body" });
  try {
    assert.equal(host.hostModes().length, 0);
    assert.throws(() => ops["host.enter"]({ conv: "h5" }, "控制台"), /急停/);
  } finally { guard.releaseStop("测试"); host.resetHost(); }
});

test("不持久：基座重启（新进程）后一律回到沙箱", () => {
  host.enterHost("h7", "user", "", "控制台");
  const src = path.resolve(import.meta.dirname, "../src");
  const imp = (f: string) => JSON.stringify(path.join(src, f));
  const out = execFileSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e",
    `const c = await import(${imp("config.ts")}); c.loadConfig(); (await import(${imp("store.ts")})).openStore(); const h = await import(${imp("host-mode.ts")}); console.log(JSON.stringify(h.hostModes())); process.exit(0);`],
    { env: process.env, encoding: "utf8" });
  assert.equal(out.trim(), "[]");
  host.resetHost();
});
