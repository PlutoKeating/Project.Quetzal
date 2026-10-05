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
const { gitErrorKind, incomingPath } = await import("../src/memory/soul-repo.ts");
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

test("推送失败（非网络类）：立即提醒碰过记忆的那一轮，变更仍在本地提交里", async () => {
  alerts.length = 0;
  saveConfig({ soul: { remote: path.join(tmp, "missing.git") } });
  await soul.ensureSoul(); // 与控制台改地址时一样：重新配置 origin
  const s = new Session("chat", "控制台", undefined, "first");
  fs.appendFileSync(path.join(paths.soul, "memories/MEMORY.md"), "新的一条\n");
  await soul.touched({ tool: "memory", session: s });
  await soul.push("对话");
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].text, /推送失败/);
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

test("失败类别：网络类才静默重试", () => {
  assert.equal(gitErrorKind("ssh: Could not resolve hostname github.com: Temporary failure in name resolution"), "network");
  assert.equal(gitErrorKind("git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository."), "auth");
  assert.equal(gitErrorKind("Host key verification failed."), "hostkey");
  assert.equal(gitErrorKind(" ! [rejected]        HEAD -> main (fetch first)"), "rejected");
  assert.equal(gitErrorKind("ERROR: Repository not found."), "notfound");
});

test("提醒送进还在进行的醒来：作为「基座提醒」并入收件箱，不当成对方的话", async () => {
  await import("../src/mind/brain.ts"); // 大脑订阅 soul.alert
  const s = new Session("think");
  bus.emit("soul.alert", { text: "测试提醒", targets: [s] });
  assert.equal(s.inbox.length, 1);
  assert.deepEqual([s.inbox[0].notice, s.inbox[0].text], ["灵魂同步", "测试提醒"]);
  s.close();
});
