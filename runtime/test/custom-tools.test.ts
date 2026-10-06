// 自造工具：写入校验、热加载进工具表、sh / node 两种实现、依赖缺失不挂载、技能文档随灵魂仓库、删除与启停、身份自编。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.QUETZAL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "quetzal-tools-"));
const { loadConfig, paths } = await import("../src/config.ts");
loadConfig();
const store = await import("../src/store.ts");
store.openStore();
const ct = await import("../src/mind/custom-tools.ts");
const { allTools, callTool, builtinNames } = await import("../src/mind/tools.ts");
const { systemPrompt } = await import("../src/mind/prompt.ts");
const { identity } = await import("../src/memory/identity.ts");

const names = () => allTools().map((t) => t.name);
// Windows 身体上没有 sh：同一套测试用 PowerShell 的 ps1 实现（意图相同，实现各写各的）
const WIN = process.platform === "win32";
const RT = WIN ? "ps1" : "sh";
const SRC = WIN ? {
  echo: "'hi'", bad: "if ( {", greet: '"hi $env:ARG_who x$env:ARG_n json=$($env:ARGS_JSON)"', fail: '[Console]::Error.WriteLine("oops"); exit 3',
} : { echo: "echo hi", bad: "if then fi (", greet: 'read json\necho "hi $ARG_who x$ARG_n json=$json"', fail: "echo oops >&2; exit 3" };

test("写入校验：名字、保留名、schema、语法、新工具必须带技能文档", async () => {
  const reserved = new Set(builtinNames());
  await assert.rejects(ct.writeTool({ name: "Bad Name", description: "x", runtime: RT, source: SRC.echo, skill: "s" }, reserved), /name 只能/);
  await assert.rejects(ct.writeTool({ name: "shell", description: "x", runtime: RT, source: SRC.echo, skill: "s" }, reserved), /内置工具/);
  await assert.rejects(ct.writeTool({ name: "no-skill", description: "x", runtime: RT, source: SRC.echo }, reserved), /技能/);
  await assert.rejects(ct.writeTool({ name: "bad-schema", description: "x", runtime: RT, source: SRC.echo, skill: "s", parameters: { type: "array" } as any }, reserved), /type 必须是 object/);
  await assert.rejects(ct.writeTool({ name: "bad-sh", description: "x", runtime: RT, source: SRC.bad, skill: "s" }, reserved), /语法检查/);
  if (WIN) await assert.rejects(ct.writeTool({ name: "posix-only", description: "x", runtime: "sh", source: "echo hi", skill: "s" }, reserved), /这具身体是 Windows/);
  await assert.rejects(ct.writeTool({ name: "bad-node", description: "x", runtime: "node", source: "export default (", skill: "s" }, reserved), /语法检查/);
  assert.ok(!fs.existsSync(path.join(paths.tools, "bad-sh")), "语法不通过的新工具不留目录");
  await assert.rejects(ct.writeTool({ name: "bad-perm", description: "x", runtime: RT, source: SRC.echo, skill: "s", permission: "root" }, reserved), /permission 必须是/);
});

test("sh / ps1 工具：参数经 stdin JSON 与环境变量传入，热加载进工具表并经闸门调用", async () => {
  const r = await ct.writeTool({
    name: "greet", description: "打招呼", runtime: RT, permission: "shell", timeout: 60,
    parameters: { type: "object", properties: { who: { type: "string" }, n: { type: "number" } }, required: ["who"] },
    source: SRC.greet,
    skill: "## 用途\n对人打招呼。\n## 参数\nwho：对谁；n：次数。",
  }, new Set(builtinNames()));
  assert.match(r, /已创建工具 greet/);
  assert.ok(names().includes("greet"));
  const out = await callTool("greet", { who: "PK", n: 2 }, "测试");
  assert.equal(out.status, "ok");
  assert.equal(out.text.trim(), 'hi PK x2 json={"who":"PK","n":2}');
  // 技能文档：Agent Skills 规范的 SKILL.md，进了灵魂目录
  const skill = fs.readFileSync(path.join(paths.soul, "skills", "greet", "SKILL.md"), "utf8");
  assert.match(skill, /^---\nname: greet\ndescription: 打招呼\n/);
  assert.match(skill, /quetzal-tool: greet/);
  assert.match(skill, /## 用途/);
  assert.equal(ct.parseSkill(skill).description, "打招呼");
  // 工具表与审计
  assert.equal(allTools().find((t) => t.name === "greet")!.permission, "shell");
  assert.ok(store.listAudit(5).some((a) => a.action === "greet"));
});

test("node 工具：默认导出 async (args) => string，改写后重新加载，超时会终止", async () => {
  const reserved = new Set(builtinNames());
  await ct.writeTool({ name: "add_up", description: "求和", runtime: "node", source: "export default async ({ a, b }) => String(a + b);", skill: "求两数之和", timeout: WIN ? 30 : 2 }, reserved);
  assert.equal((await callTool("add_up", { a: 1, b: 2 }, "测试")).text, "3");
  const r = await ct.writeTool({ name: "add_up", runtime: "node", source: "export default async ({ a, b }) => ({ sum: a * b });" } as any, reserved); // 改写：没给的字段沿用
  assert.match(r, /已更新工具 add_up/);
  assert.equal(ct.readTool("add_up")!.manifest.description, "求和");
  assert.equal((await callTool("add_up", { a: 2, b: 3 }, "测试")).text, '{\n  "sum": 6\n}');
  await ct.writeTool({ name: "slow", description: "慢", runtime: "node", source: "export default () => new Promise(() => {});", skill: "永远不返回", timeout: 1 }, reserved);
  const t0 = Date.now();
  const out = await callTool("slow", {}, "测试");
  assert.equal(out.status, "error");
  assert.match(out.text, /超过 1 秒/);
  assert.ok(Date.now() - t0 < 3000);
  await ct.writeTool({ name: "fail_sh", description: "失败", runtime: RT, source: SRC.fail, skill: "总是失败" }, reserved);
  assert.match((await callTool("fail_sh", {}, "测试")).text, /退出码 3：oops/);
});

test("缺依赖的工具不挂载、停用的不挂载；系统提示列出三类", async () => {
  const reserved = new Set(builtinNames());
  const r = await ct.writeTool({ name: "need_x", description: "需要不存在的命令", runtime: RT, source: "no-such-cmd-xyz", requires: ["no-such-cmd-xyz"], skill: "依赖 no-such-cmd-xyz" }, reserved);
  assert.match(r, /缺少 no-such-cmd-xyz/);
  assert.ok(!names().includes("need_x"));
  assert.ok(ct.setToolEnabled("greet", false));
  assert.ok(!names().includes("greet"));
  // 其他身体写的技能：只有文档没有实现
  fs.mkdirSync(path.join(paths.soul, "skills", "from-other-body"), { recursive: true });
  fs.writeFileSync(path.join(paths.soul, "skills", "from-other-body", "SKILL.md"), "---\nname: from-other-body\ndescription: 另一具身体沉淀的流程\n---\n步骤……\n");
  const p = systemPrompt();
  assert.match(p, /## 技能与自造工具/);
  assert.match(p, /本机可用：add_up/);
  assert.match(p, /缺依赖：need_x（缺 no-such-cmd-xyz）/);
  assert.match(p, /被对方停用：greet/);
  assert.match(p, /本机没有实现.*from-other-body（另一具身体沉淀的流程）/);
  assert.deepEqual(ct.listSkills().map((s) => [s.name, s.implemented]), [["add-up", true], ["fail-sh", true], ["from-other-body", false], ["greet", true], ["need-x", true], ["slow", true]]);
  assert.ok(ct.setToolEnabled("greet", true));
  assert.ok(names().includes("greet"));
});

test("删除：默认保留技能文档；skill=true 一并删除", async () => {
  assert.match(ct.deleteTool("slow"), /技能文档保留/);
  assert.ok(fs.existsSync(path.join(paths.soul, "skills", "slow", "SKILL.md")));
  assert.match(ct.deleteTool("fail_sh", true), /技能文档也已/);
  assert.ok(!fs.existsSync(path.join(paths.soul, "skills", "fail-sh")));
  assert.ok(!names().includes("slow"));
  assert.match(ct.deleteTool("nope"), /本机没有工具/);
});

test("edit_identity：只改给的字段，留痕，身份进入系统提示", async () => {
  const before = identity();
  const out = await callTool("edit_identity", { displayName: "小风", color: "#123456" }, "测试");
  assert.match(out.text, /displayName=小风/);
  const after = identity();
  assert.equal(after.displayName, "小风");
  assert.equal(after.color, "#123456");
  assert.equal(after.id, before.id);
  assert.equal(after.seed, undefined);
  assert.ok(store.listTimeline(5).some((e) => e.kind === "identity" && /名字、主题色/.test(e.title)));
  assert.match((await callTool("edit_identity", { color: "red" }, "测试")).text, /RRGGBB/);
  assert.match((await callTool("edit_identity", {}, "测试")).text, /没有要改/);
  assert.match(systemPrompt(), /你的名字是「小风」/);
  assert.doesNotMatch(systemPrompt(), /初始身份/); // 不再是种子身份
});
