import { test } from "node:test";
process.env.SOUL_ALLOW_LOCAL_REMOTE = "1"; // 测试使用本地裸仓库作为远端
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

// 模拟：另一具身体（Hermes）已有人格与记忆，推到了一个裸仓库；本机首次接入
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "quetzal-soul-"));
const remote = path.join(tmp, "soul.git");
const hermes = path.join(tmp, "hermes");
const g = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, stdio: "pipe" }).toString();
execFileSync("git", ["init", "--bare", "-b", "main", remote]);
fs.mkdirSync(path.join(hermes, "memories"), { recursive: true });
g(hermes, "init", "-b", "main");
g(hermes, "config", "user.email", "h@x"); g(hermes, "config", "user.name", "hermes");
fs.writeFileSync(path.join(hermes, "SOUL.md"), "# 神谷薰\n来自 Hermes 的人格\n");
fs.writeFileSync(path.join(hermes, "memories/MEMORY.md"), "喜欢猫\n§\n住在海边\n");
g(hermes, "add", "-A"); g(hermes, "commit", "-m", "hermes"); g(hermes, "remote", "add", "origin", remote); g(hermes, "push", "origin", "main");

process.env.QUETZAL_HOME = path.join(tmp, "home");
const { loadConfig, saveConfig } = await import("../src/config.ts");
loadConfig();
const { openStore } = await import("../src/store.ts");
openStore();
const soul = await import("../src/memory/soul-sync.ts");
const mem = await import("../src/memory/memory.ts");

test("首次接入：采用对方人格，合并记忆，推送后对方可见本机日记", async () => {
  await soul.ensureSoul();
  mem.editMemory("memory", "add", "第一次在手机里醒来");
  mem.writeJournal("初醒", "这里很安静");
  saveConfig({ soul: { remote } });
  await soul.pull();
  await soul.push("测试");
  assert.match(mem.soul(), /来自 Hermes 的人格/);
  assert.ok(soul.recent[0]?.incoming.length >= 1, "同步结果作为知觉被记录");
  assert.deepEqual(new Set(mem.entries("memory")), new Set(["喜欢猫", "住在海边", "第一次在手机里醒来"]));
  g(hermes, "pull", "origin", "main");
  assert.ok(fs.readdirSync(path.join(hermes, "journal")).includes("default"));
});

test("双方同时修改记忆：条目级合并，不丢内容", async () => {
  fs.appendFileSync(path.join(hermes, "memories/MEMORY.md"), "§\nHermes 新学到的事\n");
  g(hermes, "commit", "-am", "h2"); g(hermes, "push", "origin", "main");
  mem.editMemory("memory", "add", "手机这边新学到的事");
  await soul.push("本机");
  await soul.pull();
  const e = mem.entries("memory");
  assert.ok(e.includes("Hermes 新学到的事") && e.includes("手机这边新学到的事"), e.join("|"));
});

test("身份守卫：拒绝合并属于另一个 agent 的灵魂仓库", async () => {
  const other = path.join(tmp, "other.git");
  const w = path.join(tmp, "otherwork");
  execFileSync("git", ["init", "--bare", "-b", "main", other]);
  fs.mkdirSync(w);
  g(w, "init", "-b", "main"); g(w, "config", "user.email", "o@x"); g(w, "config", "user.name", "o");
  fs.writeFileSync(path.join(w, "agent.json"), JSON.stringify({ id: "00000000-0000-0000-0000-000000000000", name: "other", displayName: "别人" }));
  g(w, "add", "-A"); g(w, "commit", "-m", "o"); g(w, "remote", "add", "origin", other); g(w, "push", "origin", "main");
  const { identity, setIdentity } = await import("../src/memory/identity.ts");
  setIdentity({ displayName: "测试者" }); // 不再是种子身份
  saveConfig({ soul: { remote: other } });
  await soul.pull();
  assert.match(soul.syncStatus().lastError, /另一个 agent/);
  assert.equal(identity().displayName, "测试者");
  saveConfig({ soul: { remote } });
});

test("整理租约：另一具身体持有未过期租约时拿不到", async () => {
  fs.mkdirSync(path.join(hermes, "locks"), { recursive: true });
  g(hermes, "pull", "origin", "main");
  fs.writeFileSync(path.join(hermes, "locks/consolidation.json"), JSON.stringify({ body: "hermes", until: Date.now() + 60_000 }));
  g(hermes, "add", "-A"); g(hermes, "commit", "-m", "lease"); g(hermes, "push", "origin", "main");
  assert.equal(await soul.acquireLease(), false);
  fs.writeFileSync(path.join(hermes, "locks/consolidation.json"), JSON.stringify({ body: "hermes", until: 0 }));
  g(hermes, "commit", "-am", "expire"); g(hermes, "push", "origin", "main");
  assert.equal(await soul.acquireLease(), true);
  await soul.releaseLease();
});

test("历史与撤销", async () => {
  mem.editMemory("memory", "add", "要被撤销的条目");
  await soul.push("加一条");
  const h = await soul.history(5);
  assert.match(h[0].subject, /加一条/);
  await soul.revert(h[0].hash);
  assert.ok(!mem.entries("memory").includes("要被撤销的条目"));
});

test("人格冲突全自动解决：采用较新的版本，另一版本保留在历史中", async () => {
  g(hermes, "pull", "origin", "main");
  fs.writeFileSync(path.join(process.env.QUETZAL_HOME!, "soul/SOUL.md"), "# 本机版本\n");
  await soul.push("本机改人格");
  await new Promise((r) => setTimeout(r, 1100)); // 让对方的提交时间更新
  fs.writeFileSync(path.join(hermes, "SOUL.md"), "# Hermes 较新的版本\n");
  g(hermes, "commit", "-am", "hermes 改人格");
  g(hermes, "pull", "--no-rebase", "-X", "ours", "origin", "main"); g(hermes, "push", "origin", "main");
  await soul.pull();
  assert.match(mem.soul(), /Hermes 较新的版本/);
  assert.ok(!fs.existsSync(path.join(process.env.QUETZAL_HOME!, "soul/SOUL.incoming.md")));
  const log = execFileSync("git", ["-C", path.join(process.env.QUETZAL_HOME!, "soul"), "log", "--all", "--full-history", "-p", "--", "SOUL.md"]).toString();
  assert.match(log, /本机版本/);
});
