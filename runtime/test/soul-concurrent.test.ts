// 并发写记忆（#7）：几个会话同时写记忆、写的时候灵魂同步正在合并别的身体的改动——每一笔都要留下，不能被后来的覆盖。
import { test } from "node:test";
process.env.SOUL_ALLOW_LOCAL_REMOTE = "1"; // 测试使用本地裸仓库作为远端
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "quetzal-concurrent-"));
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
const mem = await import("../src/memory/memory.ts");
const { callTool } = await import("../src/mind/tools.ts");

test("准备：本机接入，另一具身体克隆同一个仓库", async () => {
  saveConfig({ soul: { remote } });
  await soul.ensureSoul();
  await soul.push("接入");
  g(tmp, "clone", remote, other);
  g(other, "config", "user.email", "o@x"); g(other, "config", "user.name", "other (pc)");
});

test("同一具身体上几个会话同时用 memory 工具写：每一条都在", async () => {
  const outs = await Promise.all(["会话一写的", "会话二写的", "醒来时写的"].map((c) => callTool("memory", { action: "add", target: "memory", content: c }, "测试")));
  assert.ok(outs.every((o) => o.status === "ok"), JSON.stringify(outs));
  for (const c of ["会话一写的", "会话二写的", "醒来时写的"]) assert.ok(mem.entries("memory").includes(c), c);
});

test("合并别的身体的改动时（常驻记忆两边都改过）写进来的记忆：等合并做完再写，三边的条目都保留", async () => {
  await soul.push("本机先推一次");
  g(other, "pull", "origin", "main");
  fs.appendFileSync(path.join(other, "memories/MEMORY.md"), "§\n另一具身体记下的\n");
  g(other, "commit", "-am", "pc 记了一条"); g(other, "push", "origin", "main");
  mem.editMemory("memory", "add", "本机合并前记下的"); // 与远端冲突：合并时要走条目级合并

  const merging = path.join(paths.soul, ".git", "MERGE_HEAD");
  let done = false, sawMerge = false;
  const pulling = soul.pull().finally(() => { done = true; });
  // 合并进行到一半（git merge 停在冲突上、基座正在逐个处理）时，另一个会话写记忆
  while (!done && !fs.existsSync(merging)) await new Promise((r) => setImmediate(r));
  if (fs.existsSync(merging)) sawMerge = true;
  const writing = callTool("memory", { action: "add", target: "memory", content: "合并时另一个会话写的" }, "测试");
  await Promise.all([pulling, writing]);

  const e = mem.entries("memory");
  for (const c of ["另一具身体记下的", "本机合并前记下的", "合并时另一个会话写的", "会话一写的"]) assert.ok(e.includes(c), `${c} 不见了：${e.join("|")}`);
  assert.doesNotMatch(fs.readFileSync(path.join(paths.soul, "memories/MEMORY.md"), "utf8"), /^(<{7}|>{7}|={7})/m, "没有冲突标记被当成条目写进去");
  assert.ok(sawMerge, "这次确实在合并途中写入（没赶上时这条测试失去意义）");
});

test("写锁：后来的写等前面的做完，出错不会卡住后面的", async () => {
  const order: string[] = [];
  const a = mem.exclusive(async () => { await new Promise((r) => setTimeout(r, 30)); order.push("a"); });
  const b = mem.exclusive(() => { throw new Error("坏了"); });
  const c = mem.exclusive(() => { order.push("c"); });
  await a; await assert.rejects(b, /坏了/); await c;
  assert.deepEqual(order, ["a", "c"]);
});
