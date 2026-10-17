// 插件包：Claude Code 插件格式与 Agent Skills 目录的解析、预览、安装 / 更新 / 卸载（本地目录 fixture），插件目录（marketplace.json），推荐目录与她的推荐工具。
// 全部是临时目录里的合成数据，不访问网络、不克隆真实仓库。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "quetzal-plugins-"));
process.env.QUETZAL_HOME = home;
const { loadConfig, paths } = await import("../src/config.ts");
loadConfig();
const { openStore } = await import("../src/store.ts");
openStore();
fs.mkdirSync(paths.soul, { recursive: true });
const plugins = await import("../src/plugins/index.ts");
const { parsePlugin, parseMarketplace, marketSource, serverFrom } = await import("../src/plugins/package.ts");
const { CATALOG, searchCatalog } = await import("../src/plugins/catalog.ts");
const mcp = await import("../src/mcp/runtime.ts");
const { callTool } = await import("../src/mind/tools.ts");
const { pluginsBlock } = await import("../src/plugins/tools.ts");
after(async () => { await mcp.closeMcp(); (await import("../src/store.ts")).db.close(); fs.rmSync(home, { recursive: true, force: true }); });

const fixtures = fs.mkdtempSync(path.join(os.tmpdir(), "quetzal-plugin-src-"));
after(() => fs.rmSync(fixtures, { recursive: true, force: true }));
const write = (rel: string, text: string, mode = 0o644) => { const f = path.join(fixtures, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); fs.chmodSync(f, mode); };

// 一个 Claude Code 插件：plugin.json、技能（带参考文档与脚本）、命令、子 agent、hooks、.mcp.json（本机 stdio、远程 http、这具身体上没有的命令）
write("demo/.claude-plugin/plugin.json", JSON.stringify({ name: "demo-kit", version: "1.2.0", description: "合成的演示插件", author: { name: "合成作者" }, license: "MIT", keywords: ["演示"] }));
write("demo/skills/note-taking/SKILL.md", "---\nname: note-taking\ndescription: 整理会议记录的步骤。\n---\n\n## 步骤\n先列要点。\n");
write("demo/skills/note-taking/references/guide.md", "# 参考\n");
write("demo/skills/note-taking/scripts/run.sh", "#!/bin/sh\necho hi\n", 0o755);
write("demo/skills/note-taking/tool.py", "print(1)\n");
write("demo/commands/hello.md", "---\ndescription: 打个招呼\n---\n向 $ARGUMENTS 问好。\n");
write("demo/agents/reviewer.md", "---\nname: reviewer\ndescription: 代码审阅者\n---\n你是一个仔细的审阅者。\n");
write("demo/hooks/hooks.json", JSON.stringify({ hooks: {} }));
write("demo/server.mjs", "// 合成的服务\n");
write("demo/.mcp.json", JSON.stringify({ mcpServers: {
  local: { command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/server.mjs", "--mode", "${DEMO_MODE:-fast}"], env: { DEMO_API_KEY: "${DEMO_API_KEY}", PLAIN: "yes" } },
  remote: { type: "http", url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer ${DEMO_TOKEN}", "X-Client": "quetzal" } },
  missing: { command: "definitely-not-a-real-command-xyz", args: [] },
  bad: { type: "http", url: "http://mcp.example.com/mcp" },
} }));
// 只有 Agent Skills 的目录（没有 plugin.json）
write("skills-only/skills/web-clip/SKILL.md", "---\nname: web-clip\ndescription: 摘录网页。\n---\n正文\n");
write("skills-only/skills/BadName/SKILL.md", "---\nname: Bad Name\ndescription: x\n---\n");
// 插件目录（marketplace）：相对路径的插件、github 来源、名字不合规的
write("market/.claude-plugin/marketplace.json", JSON.stringify({ name: "team-tools", owner: { name: "合成团队" }, metadata: { description: "合成的插件目录" }, plugins: [
  { name: "demo-kit", source: "./plugins/demo-kit", description: "演示插件", category: "productivity", keywords: ["演示", "会议"] },
  { name: "gh-helper", source: { source: "github", repo: "example/gh-helper" }, description: "GitHub 助手" },
  { name: "Bad Name", source: "./x" },
] }));
fs.cpSync(path.join(fixtures, "demo"), path.join(fixtures, "market/plugins/demo-kit"), { recursive: true });

test("解析 Claude Code 插件：技能只收文档、命令与子 agent、hooks 不执行、.mcp.json 的变量与命令", () => {
  const p = parsePlugin(path.join(fixtures, "demo"), "/opt/q/plugins/demo-kit", "demo");
  assert.equal(p.name, "demo-kit");
  assert.equal(p.format, "claude-plugin");
  assert.equal(p.version, "1.2.0");
  assert.equal(p.author, "合成作者");
  assert.deepEqual(p.skills.map((s) => s.name), ["note-taking"]);
  assert.deepEqual(p.skills[0].files.sort(), ["SKILL.md", "references/guide.md"]);
  assert.deepEqual(p.skills[0].skipped.sort(), ["scripts/run.sh", "tool.py"]);
  assert.deepEqual(p.commands.map((c) => c.name), ["hello"]);
  assert.deepEqual(p.agents.map((c) => [c.name, c.description]), [["reviewer", "代码审阅者"]]);
  assert.equal(p.hooks, true);
  assert.ok(p.warnings.some((w) => /hooks/.test(w)));
  const local = p.mcp.find((m) => m.name === "local")!;
  assert.ok(path.isAbsolute(String(local.server.command)), "node 解析为绝对路径");
  assert.equal((local.server.args as string[])[0], "/opt/q/plugins/demo-kit/server.mjs");
  assert.deepEqual(local.inputs.map((i) => [i.key, i.secret, i.required]), [["DEMO_MODE", false, false], ["DEMO_API_KEY", true, true]]);
  const remote = p.mcp.find((m) => m.name === "remote")!;
  assert.equal(remote.server.transport, "http");
  assert.equal(remote.problem, undefined);
  assert.match(String(p.mcp.find((m) => m.name === "missing")!.problem), /找不到命令/);
  assert.match(String(p.mcp.find((m) => m.name === "bad")!.problem), /HTTPS/);
  const skillsOnly = parsePlugin(path.join(fixtures, "skills-only"), "/x", "skills-only");
  assert.equal(skillsOnly.format, "skills");
  assert.deepEqual(skillsOnly.skills.map((s) => s.name), ["web-clip"]);
  assert.ok(skillsOnly.warnings.some((w) => /不符合 Agent Skills/.test(w)));
  assert.throws(() => parsePlugin(fixtures, "/x", "empty-dir-name"), /没有找到可以安装的内容/);
  assert.equal(serverFrom("s", { type: "streamable-http", url: "https://a.example/mcp" }, "/r", "p").server.transport, "http");
});

test("插件目录：marketplace.json 的来源写法与校验", () => {
  const m = parseMarketplace(JSON.parse(fs.readFileSync(path.join(fixtures, "market/.claude-plugin/marketplace.json"), "utf8")));
  assert.equal(m.name, "team-tools");
  assert.equal(m.owner, "合成团队");
  assert.deepEqual(m.plugins.map((p) => p.name), ["demo-kit", "gh-helper"]);
  assert.deepEqual(m.plugins[1].source, { kind: "git", url: "https://github.com/example/gh-helper.git" });
  assert.ok(m.warnings.length >= 1);
  assert.deepEqual(marketSource({ source: "git-subdir", url: "https://example.com/r.git", path: "plugins/x", ref: "v1" }), { kind: "git", url: "https://example.com/r.git", subdir: "plugins/x", ref: "v1" });
  assert.deepEqual(marketSource("demo", "./plugins"), { kind: "path", path: "plugins/demo" });
  assert.equal(marketSource({ source: "npm", package: "x" }), undefined);
  assert.throws(() => parseMarketplace({ name: "Bad Name", plugins: [] }));
});

test("预览 → 安装：技能写进灵魂仓库 skills/，MCP 来源加入配置（凭据进 secrets/），命令可取用；重复安装要替换；卸载全部收回", async () => {
  const v = await plugins.preview({ source: path.join(fixtures, "demo") });
  assert.equal(v.name, "demo-kit");
  assert.equal(v.hooks, true);
  assert.deepEqual(v.mcp.map((m) => [m.key, m.id, !!m.problem]), [["local", "local", false], ["remote", "remote", false], ["missing", "missing", true], ["bad", "bad", true]]);
  assert.equal(v.mcp.find((m) => m.key === "remote")!.sync, true);
  assert.equal(v.mcp.find((m) => m.key === "local")!.sync, false);
  await assert.rejects(plugins.install({ plan: v.plan, inputs: {} }, "测试"), /还没填/, "缺必填值时什么都不写");
  const v2 = await plugins.preview({ source: path.join(fixtures, "demo") });
  const rec = await plugins.install({ plan: v2.plan, inputs: { local: { DEMO_API_KEY: "synthetic-api-key-1" }, remote: { DEMO_TOKEN: "synthetic-token-2" } }, enable: false }, "测试");
  assert.deepEqual(rec.mcp.sort(), ["local", "remote"]);
  assert.deepEqual(rec.skills, ["note-taking"]);
  const skill = path.join(paths.soul, "skills", "note-taking");
  assert.ok(fs.existsSync(path.join(skill, "SKILL.md")));
  assert.ok(fs.existsSync(path.join(skill, "references", "guide.md")));
  assert.ok(!fs.existsSync(path.join(skill, "scripts")), "可执行实现不进灵魂仓库");
  assert.ok(fs.existsSync(path.join(home, "plugins", "demo-kit", "server.mjs")), "包留在这具身体上");
  const cfg = fs.readFileSync(path.join(paths.config, "mcp.json"), "utf8");
  assert.ok(!cfg.includes("synthetic-api-key-1") && !cfg.includes("synthetic-token-2"), "凭据值不进配置");
  const local = mcp.findServer("local") as any, remote = mcp.findServer("remote") as any;
  assert.equal(local.plugin, "demo-kit");
  assert.deepEqual(local.args.slice(1), ["--mode", "fast"]);
  assert.equal(local.env.PLAIN, "yes");
  assert.equal(fs.readFileSync(path.join(paths.secrets, local.secrets.DEMO_API_KEY), "utf8"), "synthetic-api-key-1");
  assert.equal(fs.readFileSync(path.join(paths.secrets, remote.headerSecrets.Authorization), "utf8"), "Bearer synthetic-token-2");
  assert.equal(remote.headers["X-Client"], "quetzal");
  // 命令与子 agent：她用 plugin_prompt 取用
  const cmd = await callTool("plugin_prompt", { plugin: "demo-kit", name: "hello", arguments: "小明" }, "合成");
  assert.equal(cmd.status, "ok");
  assert.match(cmd.text, /向 小明 问好/);
  assert.match(pluginsBlock(), /demo-kit\/hello/);
  // 再装一次：要替换；替换时同名来源沿用原来的 id
  const v3 = await plugins.preview({ source: path.join(fixtures, "demo") });
  assert.equal(v3.installed, "1.2.0");
  await assert.rejects(plugins.install({ plan: v3.plan, inputs: { local: { DEMO_API_KEY: "k" }, remote: { DEMO_TOKEN: "t" } } }, "测试"), /已安装/);
  const v4 = await plugins.preview({ source: path.join(fixtures, "demo") });
  const again = await plugins.install({ plan: v4.plan, inputs: { local: { DEMO_API_KEY: "k3" }, remote: { DEMO_TOKEN: "t3" } }, enable: false, replace: true }, "测试");
  assert.deepEqual(again.mcp.sort(), ["local", "remote"]);
  assert.equal(mcp.listSources().sources.length, 2);
  assert.equal(await plugins.uninstall({ name: "demo-kit" }, "测试"), true);
  assert.ok(!fs.existsSync(skill));
  assert.ok(!fs.existsSync(path.join(home, "plugins", "demo-kit")));
  assert.equal(mcp.listSources().sources.length, 0);
  assert.ok(!fs.existsSync(path.join(paths.secrets, "mcp_local_demo_api_key")), "为它保存的凭据一起删");
});

test("灵魂仓库里已有同名技能（她自己写的）：预览标出冲突，安装不覆盖、卸载也不删", async () => {
  const mine = path.join(paths.soul, "skills", "web-clip");
  fs.mkdirSync(mine, { recursive: true });
  fs.writeFileSync(path.join(mine, "SKILL.md"), "---\nname: web-clip\ndescription: 她自己写的\n---\n");
  const v = await plugins.preview({ source: path.join(fixtures, "skills-only") });
  assert.match(String(v.skills[0].conflict), /已有同名技能/);
  const rec = await plugins.install({ plan: v.plan }, "测试");
  assert.deepEqual(rec.skills, []);
  assert.match(fs.readFileSync(path.join(mine, "SKILL.md"), "utf8"), /她自己写的/);
  await plugins.uninstall({ name: "skills-only" }, "测试");
  assert.ok(fs.existsSync(path.join(mine, "SKILL.md")));
  assert.equal(plugins.cancel("nope"), false);
});

test("插件目录：添加本地目录，浏览，从目录里预览安装", async () => {
  const m = await plugins.addMarketplace(path.join(fixtures, "market"), "测试");
  assert.equal(m.name, "team-tools");
  await assert.rejects(plugins.addMarketplace(path.join(fixtures, "market"), "测试"), /已有插件目录/);
  const o = plugins.overview();
  assert.deepEqual(o.marketplaces.map((x) => x.name), ["team-tools"]);
  assert.deepEqual(o.marketplaces[0].plugins.map((p: any) => [p.name, p.installed]), [["demo-kit", false], ["gh-helper", false]]);
  const v = await plugins.preview({ marketplace: "team-tools", plugin: "demo-kit" });
  assert.equal(v.name, "demo-kit");
  assert.equal(v.source, "team-tools / demo-kit");
  await plugins.install({ plan: v.plan, inputs: { local: { DEMO_API_KEY: "k" }, remote: { DEMO_TOKEN: "t" } }, enable: false }, "测试");
  assert.equal(plugins.overview().marketplaces[0].plugins[0].installed, true);
  await plugins.uninstall({ name: "demo-kit" }, "测试");
  await plugins.refreshMarketplace("team-tools", "测试");
  assert.equal(plugins.removeMarketplace("team-tools", "测试"), true);
  assert.equal(plugins.overview().marketplaces.length, 0);
});

test("git 来源只收 https 公网地址，GitHub 简写展开", async () => {
  await assert.rejects(plugins.gitUrl("http://example.com/r.git"), /https/);
  await assert.rejects(plugins.gitUrl("git@example.com:o/r.git"), /不是本地目录/);
  await assert.rejects(plugins.gitUrl("file:///etc"), /https/);
  await assert.rejects(plugins.gitUrl("https://127.0.0.1/r.git"), /内网|本机/);
  await assert.rejects(plugins.gitUrl("https://u:p@example.com/r.git"), /用户名/);
  await assert.rejects(plugins.preview({ source: "relative/dir/that/is/not/url" }), /不是本地目录|https|解析/);
});

test("推荐目录：精选清单的条目完整；一键安装 Playwright（npx 用已有的 Node）、GitHub（令牌进 secrets/ 请求头）", async () => {
  for (const e of CATALOG) {
    assert.match(e.id, /^[a-z][a-z0-9_]{0,23}$/);
    assert.ok(e.license && /^https:\/\//.test(e.source) && e.keywords.length, e.id);
  }
  assert.ok(["playwright", "email", "google_calendar", "caldav", "outlook", "google_workspace", "github", "filesystem"].every((id) => CATALOG.some((e) => e.id === id)));
  assert.equal(searchCatalog("填网页表单")[0].id, "playwright");
  assert.ok(searchCatalog("发邮件").some((e) => e.category === "email"));
  assert.ok(searchCatalog("日历").some((e) => e.id === "caldav"));
  const pw = await plugins.preview({ catalog: "playwright" });
  assert.equal(pw.mcp[0].transport, "stdio");
  assert.deepEqual(pw.mcp[0].args, ["-y", "@playwright/mcp@latest", "--headless", "--isolated"]);
  assert.ok(pw.outward && /提交/.test(pw.outward));
  if (!pw.mcp[0].problem) {
    assert.ok(path.isAbsolute(pw.mcp[0].command!));
    const r = await plugins.install({ plan: pw.plan, enable: false }, "测试");
    assert.equal(mcp.findServer(r.mcp[0])?.plugin, "playwright");
    assert.equal((mcp.findServer(r.mcp[0]) as any).sandbox, true, "缺省经沙箱");
  }
  const gh = await plugins.preview({ catalog: "github" });
  await assert.rejects(plugins.install({ plan: gh.plan }, "测试"), /还没填/);
  const gh2 = await plugins.preview({ catalog: "github" });
  const r = await plugins.install({ plan: gh2.plan, inputs: { github: { token: "synthetic-pat-xyz" } }, enable: false }, "测试");
  const s = mcp.findServer(r.mcp[0]) as any;
  assert.equal(s.url, "https://api.githubcopilot.com/mcp/");
  assert.equal(s.oauth, false);
  assert.equal(fs.readFileSync(path.join(paths.secrets, s.headerSecrets.Authorization), "utf8"), "Bearer synthetic-pat-xyz");
  const cal = await plugins.preview({ catalog: "caldav" });
  if (!cal.mcp[0].problem) {
    const c = await plugins.install({ plan: cal.plan, inputs: { caldav: { base_url: "https://dav.example.com", username: "me", password: "synthetic-pw" } }, enable: false }, "测试");
    const cs = mcp.findServer(c.mcp[0]) as any;
    assert.equal(cs.env.CALDAV_BASE_URL, "https://dav.example.com");
    assert.equal(cs.env.CALDAV_PASSWORD, undefined, "密码不进配置");
    assert.equal(fs.readFileSync(path.join(paths.secrets, cs.secrets.CALDAV_PASSWORD), "utf8"), "synthetic-pw");
    await plugins.uninstall({ name: "caldav" }, "测试");
  }
});

test("主动推荐：她用 plugin_search 找、plugin_recommend 推荐；记在插件页，装了就消失；装过的、没有的不能推荐", async () => {
  const found = await callTool("plugin_search", { query: "日历" }, "合成");
  assert.equal(found.status, "ok");
  assert.match(found.text, /caldav/);
  const rec = await callTool("plugin_recommend", { id: "caldav", reason: "你常说要记日程" }, "合成");
  assert.equal(rec.status, "ok");
  assert.match(rec.text, /插件/);
  assert.deepEqual(plugins.overview().recommendations.map((r) => [r.id, r.reason]), [["caldav", "你常说要记日程"]]);
  assert.equal((await callTool("plugin_recommend", { id: "no_such", reason: "x" }, "合成")).status, "error");
  assert.equal((await callTool("plugin_recommend", { id: "github", reason: "x" }, "合成")).status, "error", "已经装了");
  assert.match(pluginsBlock(), /plugin_recommend/);
  const v = await plugins.preview({ catalog: "caldav" });
  if (!v.mcp[0].problem) {
    await plugins.install({ plan: v.plan, inputs: { caldav: { base_url: "https://dav.example.com", username: "me", password: "pw" } }, enable: false }, "测试");
    assert.equal(plugins.overview().recommendations.length, 0, "装了就不再显示");
  } else assert.equal(plugins.dismiss("caldav"), true);
});
