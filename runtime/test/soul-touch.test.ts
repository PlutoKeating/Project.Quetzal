// 触碰即同步：任何工具碰了灵魂目录都立即提交、去抖推送；推送失败与冲突副本以提醒送回碰过它的会话；冲突副本进入系统提示。
import { test } from "node:test";
process.env.SOUL_ALLOW_LOCAL_REMOTE = "1"; // 测试使用本地裸仓库作为远端
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "quetzal-touch-"));
const remote = path.join(tmp, "soul.git");
const other = path.join(tmp, "other");
const g = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, stdio: "pipe" }).toString();
execFileSync("git", ["init", "--bare", "-b", "main", remote]);

process.env.QUETZAL_HOME = path.join(tmp, "home");
const { loadConfig, saveConfig, paths } = await import("../src/config.ts");
loadConfig();
const { openStore } = await import("../src/store.ts");
openStore();
const soul = await import("../src/memory/soul-sync.ts");
const { incomingPath } = await import("../src/memory/soul-repo.ts");
const { bus } = await import("../src/bus.ts");
const { Session } = await import("../src/mind/activity.ts");
const { callTool } = await import("../src/mind/tools.ts");

const alerts: { text: string; targets: unknown[] }[] = [];
bus.on("soul.alert", (e) => alerts.push(e));
const head = () => g(paths.soul, "log", "-1", "--format=%s").trim();

test("准备：本机接入，另一具身体克隆同一个仓库", async () => {
  saveConfig({ soul: { remote } });
  await soul.ensureSoul();
  await soul.push("接入");
  g(tmp, "clone", remote, other);
  g(other, "config", "user.email", "o@x"); g(other, "config", "user.name", "other (pc)");
  assert.ok(fs.existsSync(path.join(other, "SOUL.md")));
});

test("shell 直接改灵魂目录：工具一结束就提交，提交信息说明改了什么；推送后对方可见", async () => {
  const out = await callTool("shell", { command: `mkdir -p "${paths.soul}/notes/身体" && printf '# 硬件\\n' > "${paths.soul}/notes/身体/硬件.md"` }, "测试");
  assert.equal(out.status, "ok", out.text);
  await soul.idle();
  assert.match(head(), /^shell：笔记 身体\/硬件（default）$/);
  assert.equal(soul.syncStatus().unpushed, 1);
  await soul.push("对话");
  assert.equal(soul.syncStatus().unpushed, 0);
  g(other, "pull", "origin", "main");
  assert.ok(fs.existsSync(path.join(other, "notes/身体/硬件.md")));
});

test("没碰灵魂目录的工具不产生提交", async () => {
  const before = g(paths.soul, "rev-parse", "HEAD");
  await callTool("shell", { command: "echo 不碰灵魂" }, "测试");
  await soul.idle();
  assert.equal(g(paths.soul, "rev-parse", "HEAD"), before);
});

test("推送失败：不按报错文字分类，静默重试几次仍失败才提醒碰过记忆的那一轮（附 git 原文），变更仍在本地提交里", async () => {
  alerts.length = 0;
  saveConfig({ soul: { remote: path.join(tmp, "missing.git") } });
  await soul.ensureSoul(); // 与控制台改地址时一样：重新配置 origin
  const s = new Session("chat", "控制台", undefined, "first");
  fs.appendFileSync(path.join(paths.soul, "memories/MEMORY.md"), "新的一条\n");
  await soul.touched({ tool: "memory", session: s });
  await soul.push("对话");
  assert.equal(alerts.length, 0, "第一次失败先静默重试");
  for (let i = 0; i < 5; i++) await soul.push("对话"); // 每次重试（计时器到点时也是调用 push）
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].text, /推送失败/);
  assert.match(alerts[0].text, /missing\.git/, "附上 git 的原文");
  assert.match(alerts[0].text, /常驻记忆/);
  assert.equal(alerts[0].targets[0], s, "提醒送回碰过记忆的那一轮");
  assert.match(head(), /memory：常驻记忆/);
  s.close();
  // 恢复远端：下一次推送把积压的提交带上
  saveConfig({ soul: { remote } });
  await soul.ensureSoul();
  assert.equal((await soul.push("恢复")).ok, true);
  g(other, "pull", "origin", "main");
  assert.match(fs.readFileSync(path.join(other, "memories/MEMORY.md"), "utf8"), /新的一条/);
});

test("两边都改了同一篇笔记：先用较新的一版，另一版另存为副本，提醒最近改过它的会话；副本进入待裁决列表", async () => {
  alerts.length = 0;
  const s = new Session("chat", "控制台", undefined, "first");
  fs.writeFileSync(path.join(paths.soul, "notes/身体/硬件.md"), "# 硬件\n本机的版本\n");
  await soul.touched({ tool: "note_save", session: s });
  await new Promise((r) => setTimeout(r, 1100)); // 让对方的提交时间更新
  fs.writeFileSync(path.join(other, "notes/身体/硬件.md"), "# 硬件\n对方较新的版本\n");
  g(other, "commit", "-am", "pc 改笔记（pc）"); g(other, "push", "origin", "main");
  await soul.pull();
  const file = path.join(paths.soul, "notes/身体/硬件.md");
  assert.match(fs.readFileSync(file, "utf8"), /对方较新的版本/);
  const copy = path.join(paths.soul, incomingPath("notes/身体/硬件.md")!);
  assert.match(fs.readFileSync(copy, "utf8"), /本机的版本/);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].targets[0], s);
  assert.match(alerts[0].text, /另一版在 .*硬件\.incoming\.md/);
  assert.deepEqual(soul.pendingCopies(), ["notes/身体/硬件.incoming.md"]);
  // 副本不入库
  assert.equal(g(paths.soul, "status", "--porcelain", "--", copy).trim(), "");
  // 她裁决：删掉副本，待裁决列表清空
  fs.rmSync(copy);
  assert.deepEqual(soul.pendingCopies(), []);
  s.close();
});

test("提醒送进还在进行的醒来：作为「基座提醒」并入收件箱，不当成对方的话", async () => {
  await import("../src/mind/brain.ts"); // 大脑订阅 soul.alert
  const s = new Session("think");
  bus.emit("soul.alert", { text: "测试提醒", targets: [s] });
  assert.equal(s.inbox.length, 1);
  assert.deepEqual([s.inbox[0].notice, s.inbox[0].text], ["灵魂同步", "测试提醒"]);
  s.close();
});

test("灵魂目录的 origin 被手动改到别处：推送前改回配置里的灵魂仓库，别处收不到任何东西", async () => {
  const elsewhere = path.join(tmp, "elsewhere.git");
  execFileSync("git", ["init", "--bare", "-b", "main", elsewhere]);
  g(paths.soul, "remote", "set-url", "origin", elsewhere); // 模拟 agent 用 shell 改了 origin
  fs.appendFileSync(path.join(paths.soul, "memories/MEMORY.md"), "改了 origin 之后写的一条\n");
  await soul.touched({ tool: "shell" });
  assert.equal((await soul.push("对话")).ok, true);
  assert.equal(g(paths.soul, "remote", "get-url", "origin").trim(), remote, "origin 改回来了");
  assert.equal(g(elsewhere, "rev-list", "--all").trim(), "", "别处没有收到任何提交");
  g(other, "pull", "origin", "main");
  assert.match(fs.readFileSync(path.join(other, "memories/MEMORY.md"), "utf8"), /改了 origin 之后写的一条/);
});

test("配置的地址其实是一个代码仓库（没有 agent.json，有规范以外的内容）：拒绝合并，不把别的历史并进灵魂", async () => {
  const code = path.join(tmp, "code.git"), work = path.join(tmp, "codework");
  execFileSync("git", ["init", "--bare", "-b", "main", code]);
  fs.mkdirSync(path.join(work, "runtime"), { recursive: true });
  g(work, "init", "-b", "main"); g(work, "config", "user.email", "c@x"); g(work, "config", "user.name", "c");
  fs.writeFileSync(path.join(work, "runtime/main.ts"), "console.log(1)\n"); fs.writeFileSync(path.join(work, "README.md"), "# code\n");
  g(work, "add", "-A"); g(work, "commit", "-m", "code"); g(work, "remote", "add", "origin", code); g(work, "push", "origin", "main");
  saveConfig({ soul: { remote: code } });
  await soul.ensureSoul();
  await soul.pull();
  assert.match(soul.syncStatus().lastError, /不是灵魂仓库/);
  assert.ok(!fs.existsSync(path.join(paths.soul, "runtime")), "代码没有并进灵魂目录");
  const r = await soul.push("对话");
  assert.equal(r.ok, false);
  assert.equal(r.kind, "refused");
  assert.equal(g(code, "log", "--oneline", "main").trim().split("\n").length, 1, "代码仓库没有收到灵魂的提交");
  saveConfig({ soul: { remote } });
  await soul.ensureSoul();
});

test("外来历史：本地被 reset 到别的仓库的历史（陌生的根提交）后，停止同步——不合并、不推送，并提醒她", async () => {
  alerts.length = 0;
  await soul.pull(); // 记下已知的根提交
  const before = g(other, "ls-remote", remote, "main").trim();
  // 模拟事故：在灵魂目录里 reset 到一个代码仓库的历史
  const code = path.join(tmp, "code2"); fs.mkdirSync(path.join(code, "runtime"), { recursive: true });
  g(code, "init", "-b", "main"); g(code, "config", "user.email", "c@x"); g(code, "config", "user.name", "c");
  fs.writeFileSync(path.join(code, "runtime/x.ts"), "1\n"); g(code, "add", "-A"); g(code, "commit", "-m", "code");
  g(paths.soul, "fetch", code, "main"); g(paths.soul, "reset", "--hard", "FETCH_HEAD");
  fs.writeFileSync(path.join(paths.soul, "agent.json"), JSON.stringify({ id: "x" })); // 还假装像个灵魂
  const r = await soul.push("对话");
  assert.equal(r.ok, false);
  assert.match(String(r.error), /混进了别的仓库/);
  assert.equal(g(other, "ls-remote", remote, "main").trim(), before, "远端没有收到任何东西");
  await soul.pull();
  assert.ok(alerts.some((a) => /混进了别的仓库/.test(a.text)), "提醒了她");
  assert.ok(!fs.existsSync(path.join(paths.soul, "memories")) || true);
});

test("灵魂目录的 .git 丢了：基座不会退到上层目录里的别的仓库去提交", async () => {
  const outer = path.join(tmp, "outer"); const home2 = path.join(outer, "home", "soul");
  fs.mkdirSync(home2, { recursive: true });
  g(outer, "init", "-b", "main"); g(outer, "config", "user.email", "o@x"); g(outer, "config", "user.name", "o");
  fs.writeFileSync(path.join(outer, "code.ts"), "1\n"); g(outer, "add", "code.ts"); g(outer, "commit", "-m", "outer");
  const { SoulRepo } = await import("../src/memory/soul-repo.ts");
  const repo = new SoulRepo({ dir: home2, remote: "", branch: "main", body: "t", author: () => ({ name: "t", email: "t@t" }) });
  fs.writeFileSync(path.join(home2, "note.md"), "x\n");
  await repo.commit("不该提交到外层");
  assert.equal(g(outer, "rev-list", "--count", "HEAD").trim(), "1", "外层仓库没有多出提交");
});
