// 保密传递（pass_secret）：对方在对话里发来的保密值不进入对话记录、模型上下文与审计，只落进保密库；工具输出里出现的保密值被替换。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

process.env.QUETZAL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "quetzal-secrets-"));
const { loadConfig, paths } = await import("../src/config.ts");
loadConfig();
const store = await import("../src/store.ts");
store.openStore();
const reg = await import("../src/providers/registry.ts");
const { bus } = await import("../src/bus.ts");
const sec = await import("../src/mind/secrets.ts");
const { converse } = await import("../src/mind/brain.ts");
const { callTool } = await import("../src/mind/tools.ts");
const { systemPrompt } = await import("../src/mind/prompt.ts");
const { ops } = await import("../src/ops.ts");
const { Session } = await import("../src/mind/activity.ts");

const events: any[] = [];
bus.on("secret", (e) => events.push(e));
const spellOf = (conv: string) => sec.pendingSecrets().find((x) => x.conv === conv)!.spell;
const mode = (f: string) => fs.statSync(f).mode & 0o777;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const TOKEN = "tok_Zq8Jx2LmN4pR7sT9vW1yB3dF5hK6", CF = "cf-PLAIN-9f8e7d6c5b4a";

test("协议：每条消息一项，结束口令落盘；回执与工具结果都不含明文", async () => {
  events.length = 0;
  const result = sec.requestSecrets("c1", "飞书", "登录 gh 与 wrangler", [{ name: "github_token", hint: "GitHub 的 PAT" }, { name: "cf_token", hint: "Cloudflare API Token" }]);
  await sleep(0);
  assert.ok(sec.capturing("c1"));
  assert.equal(events[0].status, "open");
  const spell = events[0].spell;
  assert.match(spell, /^done-[a-z2-9]{6}$/);
  assert.match(sec.secretNotice(events[0]), /github_token[\s\S]*cf_token/);
  assert.ok(sec.secretNotice(events[0]).includes(spell));

  const a1 = sec.intake("c1", `  ${TOKEN}\n`)!;
  assert.match(a1, /已收到第 1\/2 项「github_token」（32 个字符/);
  assert.match(a1, /下一项：「cf_token」/);
  const a2 = sec.intake("c1", CF)!;
  assert.match(a2, /已收齐/);
  assert.match(sec.intake("c1", "多出来的一条")!, /已经收齐，这一条没有保存/);
  assert.equal(fs.readdirSync(paths.vault).length, 0); // 结束口令之前不落盘
  const a3 = sec.intake("c1", spell.toUpperCase())!; // 口令不区分大小写
  assert.match(a3, /已存入保密库 2 项：github_token、cf_token/);
  assert.match(a3, /撤回/); // 聊天软件里留有记录：提醒撤回
  for (const a of [a1, a2, a3]) assert.ok(!a.includes(TOKEN) && !a.includes(CF));

  const text = await result;
  assert.match(text, /已存入保密库 2 项/);
  assert.ok(!text.includes(TOKEN) && !text.includes(CF));
  const f = path.join(paths.vault, "github_token");
  assert.ok(text.includes(f));
  assert.equal(fs.readFileSync(f, "utf8"), TOKEN); // 单行的值原样写入（去掉首尾空白）
  if (process.platform !== "win32") assert.equal(mode(f), 0o600); // Windows 上 chmod 只改只读位，权限靠 ACL（另有测试）
  if (process.platform !== "win32") assert.equal(mode(paths.vault), 0o700); // Windows 上 chmod 只改只读位，权限靠 ACL（另有测试）
  if (process.platform !== "win32") assert.equal(mode(path.join(paths.vault, "index.json")), 0o600); // Windows 上 chmod 只改只读位，权限靠 ACL（另有测试）
  assert.ok(!fs.readFileSync(path.join(paths.vault, "index.json"), "utf8").includes(TOKEN));
  assert.deepEqual(events.map((e) => [e.status, e.got]), [["open", 0], ["progress", 1], ["progress", 2], ["done", 2]]);
  assert.ok(!JSON.stringify(events).includes(TOKEN));
  assert.ok(!sec.capturing("c1"));
  assert.equal(sec.intake("c1", "之后的消息照常处理"), undefined);
  assert.deepEqual(sec.listSecrets().map((x) => [x.name, x.hint, x.channel, x.bytes]), [["cf_token", "Cloudflare API Token", "飞书", CF.length], ["github_token", "GitHub 的 PAT", "飞书", TOKEN.length]]);
});

test("重来、只给一部分、取消、超时、按钮结束", async () => {
  let r = sec.requestSecrets("c2", "控制台", "", ["a_key", "b_key"]);
  const spell = spellOf("c2");
  sec.intake("c2", "wrong-value-1");
  assert.match(sec.intake("c2", `${spell} 重来`)!, /已清空，重新开始。第 1 项：「a_key」/);
  assert.match(sec.intake("c2", `${spell} 什么`)!, /没有认出这条口令/);
  assert.match(sec.intake("c2", "   ")!, /只接收文字/);
  sec.intake("c2", "right-value-1");
  const ack = sec.intake("c2", spell)!;
  assert.match(ack, /已存入保密库 1 项：a_key。[\s\S]*没有提供：b_key/);
  assert.ok(!ack.includes("撤回")); // 控制台不留聊天记录
  assert.match(await r, /对方没有提供：b_key/);
  assert.equal(fs.readFileSync(path.join(paths.vault, "a_key"), "utf8"), "right-value-1");
  assert.ok(!fs.existsSync(path.join(paths.vault, "b_key")));

  r = sec.requestSecrets("c2", "控制台", "", ["c_key"]);
  sec.intake("c2", "discarded-value");
  assert.equal(sec.intake("c2", `${spellOf("c2")} 取消`), "已取消，没有保存任何内容。");
  assert.match(await r, /取消了/);
  assert.ok(!fs.existsSync(path.join(paths.vault, "c_key")));

  r = sec.requestSecrets("c2", "控制台", "", ["c_key"], 40);
  sec.intake("c2", "discarded-value");
  assert.match(await r, /没有等到对方输入完毕[\s\S]*已收到的 1 项也已丢弃/);
  assert.ok(!sec.capturing("c2") && !fs.existsSync(path.join(paths.vault, "c_key")));

  r = sec.requestSecrets("c2", "控制台", "", ["c_key"]);
  const id = sec.pendingSecrets().find((x) => x.conv === "c2")!.id;
  sec.intake("c2", "button-value");
  assert.equal((ops["secrets.end"]({ id }) as any).status, "done"); // 按钮与结束口令等价
  assert.equal(ops["secrets.end"]({ id }), null);
  await r;
  assert.equal(fs.readFileSync(path.join(paths.vault, "c_key"), "utf8"), "button-value");

  r = sec.requestSecrets("c2", "控制台", "", ["pem"]);
  sec.intake("c2", "-----BEGIN KEY-----\nAAAAB3NzaC1yc2EAAAADAQAB\n-----END KEY-----");
  sec.intake("c2", spellOf("c2"));
  await r;
  assert.ok(fs.readFileSync(path.join(paths.vault, "pem"), "utf8").endsWith("-----END KEY-----\n")); // 多行的值以换行结尾
});

test("参数校验：名字不合规、重复、同一会话重复发起", async () => {
  await assert.rejects(sec.requestSecrets("c3", "控制台", "", [{ name: "../etc/passwd" }]), /名字不合规/);
  await assert.rejects(sec.requestSecrets("c3", "控制台", "", ["index.json"]), /名字不合规/);
  await assert.rejects(sec.requestSecrets("c3", "控制台", "", ["a", "a"]), /重复/);
  await assert.rejects(sec.requestSecrets("c3", "控制台", "", []), /1–20 项/);
  const r = sec.requestSecrets("c3", "控制台", "", ["x1"]);
  await assert.rejects(sec.requestSecrets("c3", "控制台", "", ["x2"]), /已经有一次保密输入/);
  sec.intake("c3", `${spellOf("c3")} 取消`);
  await r;
});

test("兜底：工具输出里出现的保密值被替换；保密库列表与删除", async () => {
  const f = path.join(paths.vault, "github_token");
  const out = await callTool("shell", { command: process.platform === "win32" ? `Get-Content -Raw '${f}'; "Bearer $((Get-Content -Raw '${f}').Trim())"` : `cat ${f}; echo; echo "Bearer $(cat ${f})"` }, "测试");
  assert.ok(!out.text.includes(TOKEN));
  assert.match(out.text, /‹secret:github_token›\n+Bearer ‹secret:github_token›/);
  assert.ok(!JSON.stringify(store.listAudit(20)).includes(TOKEN)); // 审计里也没有
  const pem = await callTool("shell", { command: process.platform === "win32" ? `Get-Content -TotalCount 2 '${path.join(paths.vault, "pem")}'` : `head -2 ${path.join(paths.vault, "pem")}` }, "测试"); // 多行的值：只输出其中几行也替换
  assert.ok(!pem.text.includes("AAAAB3NzaC1yc2EAAAADAQAB"));

  assert.match(systemPrompt(), /## 保密库[\s\S]*- github_token：GitHub 的 PAT（.*vault[\\/]github_token）/);
  assert.ok(!systemPrompt().includes(TOKEN));
  assert.ok(!JSON.stringify(ops.secrets()).includes(TOKEN));
  assert.equal(ops["secrets.delete"]({ name: "cf_token" }, "控制台"), true);
  assert.equal(ops["secrets.delete"]({ name: "../config/quetzal.json" }, "控制台"), false);
  assert.ok(!ops.secrets().some((x) => x.name === "cf_token"));
  assert.equal((await callTool("shell", { command: `echo ${CF}` }, "测试")).text.includes(CF), true); // 删除后不再替换
});

test("pass_secret 只能在对话中调用", async () => {
  const s = new Session("think");
  const r = await callTool("pass_secret", { purpose: "x", items: [{ name: "k" }] }, "测试", { session: s });
  s.close();
  assert.match(r.text, /只能在对话中调用/);
});

test("端到端：她调用 pass_secret，对方在对话里发值与口令；明文不进入对话记录、模型上下文与审计", async () => {
  const seen: any[] = [];
  const server = http.createServer((req, res) => {
    let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
      const j = JSON.parse(body); seen.push(j);
      const tool = j.messages.find((m: any) => m.role === "tool");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ usage: { prompt_tokens: 1, completion_tokens: 1 }, choices: [{ message: tool
        ? { content: "收到了，这就去登录。" }
        : { content: "我需要你的 npm 令牌。", tool_calls: [{ id: "c1", type: "function", function: { name: "pass_secret", arguments: JSON.stringify({ purpose: "登录 npm", items: [{ name: "npm_token", hint: "npm 的访问令牌" }] }) } }] } }] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  reg.saveProviders({ providers: [{ id: "p", catalogId: "custom", name: "Mock", baseUrl: `http://127.0.0.1:${(server.address() as any).port}`, protocol: "openai-completions" as const, enabled: true,
    keys: [{ id: "k", label: "k", lastFour: "", enabled: true, secret: "sk-mock-000000" }], models: [{ id: "m", name: "plain", enabled: true, context: 8000, maxTokens: 256, sortOrder: 0 }] }] }, reg.configVersion());

  const NPM = "npm_S3cr3tV4lu3ThatMustNeverLeak";
  events.length = 0;
  const main = converse("你", "帮我登录 npm", "控制台", { conv: "e2e" });
  for (let i = 0; i < 100 && !sec.capturing("e2e"); i++) await sleep(20);
  assert.ok(sec.capturing("e2e"));
  assert.deepEqual([events[0].status, events[0].conv, events[0].channel, events[0].purpose], ["open", "e2e", "控制台", "登录 npm"]);
  assert.match(await converse("你", NPM, "控制台", { conv: "e2e" }), /已收到第 1\/1 项「npm_token」/);
  assert.match(await converse("你", events[0].spell, "控制台", { conv: "e2e", mode: "interrupt" }), /已存入保密库 1 项/);
  assert.equal(await main, "收到了，这就去登录。");
  server.close();

  assert.equal(fs.readFileSync(path.join(paths.vault, "npm_token"), "utf8"), NPM);
  assert.deepEqual(store.sessionMessages("e2e").map((m) => m.text), ["帮我登录 npm", "收到了，这就去登录。"]); // 保密值与口令都没有成为对话
  assert.equal(seen.length, 2);
  const toolMsg = seen[1].messages.find((m: any) => m.role === "tool").content;
  assert.match(toolMsg, /npm_token → .*vault[\\/]npm_token/);
  for (const blob of [JSON.stringify(seen), JSON.stringify(store.listAudit(50)), JSON.stringify(store.listTimeline(20)), JSON.stringify(store.recentMessages(50)), JSON.stringify(events)])
    assert.ok(!blob.includes(NPM));
});
