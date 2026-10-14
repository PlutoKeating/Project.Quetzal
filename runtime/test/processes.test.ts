// 进程列表直接读 /proc，不依赖 ps；标出她自己与她的后台任务；shell 输出为空且丢弃了 stderr 时提醒。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";

process.env.QUETZAL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "quetzal-proc-"));
const { loadConfig } = await import("../src/config.ts");
loadConfig();
const store = await import("../src/store.ts");
store.openStore();
const { listProcesses, describeProcesses } = await import("../src/mind/processes.ts");
const sh = await import("../src/sh.ts");
const { callTool } = await import("../src/mind/tools.ts");
const { describeBody } = await import("../src/body/twin.ts");

const linux = fs.existsSync("/proc/self/stat");

test("读进程列表：能看到自己，带父进程与启动时间", async (t) => {
  if (!linux && process.platform !== "win32") return t.skip("没有 /proc");
  const me = (await listProcesses()).find((p) => p.pid === process.pid)!;
  assert.ok(me, "列表里应有自己");
  assert.equal(me.ppid, process.ppid);
  assert.match(me.cmd, /node/);
  assert.ok(Math.abs(Date.now() - process.uptime() * 1000 - me.startedMs) < 5000, "启动时间应与 process.uptime 一致");
});

test("进程表：过滤、标出自己与后台任务", async (t) => {
  if (!linux && process.platform !== "win32") return t.skip("没有 /proc");
  const j = await sh.startJob("sleep 5");
  await new Promise((r) => setTimeout(r, 150));
  const all = await describeProcesses();
  assert.match(all, new RegExp(`^${process.pid}\\t${process.ppid}\\t\\S+\\t\\S+\\t.*node.* ←我自己（运行基座）$`, "m"));
  assert.match(all, new RegExp(`←我的后台任务 ${j.id}$`, "m"));
  // 数字同样是命令行子串，其他进程参数可能含本进程PID，不能假定仅一项。
  assert.match(await describeProcesses(String(process.pid)), new RegExp(`^${process.pid}\\t.* ←我自己（运行基座）$`, "m"));
  assert.match(await describeProcesses("绝不会有这个命令"), /没有匹配的进程；但我自己 pid \d+ 确实在运行/);
  sh.stopJob(j.id);
  const r = await callTool("processes", { filter: "node" }, "回应你");
  assert.equal(r.status, "ok");
  assert.match(r.text, /我自己是 pid \d+/);
});

test("数字过滤兼容命令行子串：显式PID碰撞时同时保留自己和匹配子进程", async (t) => {
  if (!linux && process.platform !== "win32") return t.skip("没有 /proc");
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "--", String(process.pid)], { stdio: "ignore", windowsHide: true });
  try {
    await once(child, "spawn");
    const filtered = await describeProcesses(String(process.pid), Number.MAX_SAFE_INTEGER);
    assert.match(filtered, new RegExp(`^${process.pid}\\t.* ←我自己（运行基座）$`, "m"));
    assert.match(filtered, new RegExp(`^${child.pid}\\t${process.pid}\\t`, "m"));
    const count = Number(filtered.match(new RegExp(`匹配「${process.pid}」(\\d+) 个`))?.[1]);
    const rows = filtered.split("\n").slice(2);
    assert.ok(count >= 2, "自己的PID与子进程命令参数都应匹配");
    assert.equal(count, rows.length, "报告的匹配数应等于实际列出的全部行数");
  } finally {
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
  }
});

test("shell：输出为空且命令丢弃了 stderr 时提醒，不把空当作「没有」", { skip: process.platform === "win32" && "提醒针对 POSIX shell 的 2>/dev/null" }, async () => {
  const r = await callTool("shell", { command: "ps --no-such-flag 2>/dev/null | grep xyz" }, "回应你");
  assert.match(r.text, /输出为空，而命令把 stderr 丢弃了/);
  const ok = await callTool("shell", { command: "echo hi 2>/dev/null" }, "回应你");
  assert.doesNotMatch(ok.text, /输出为空/);
  const plain = await callTool("shell", { command: "true" }, "回应你");
  assert.doesNotMatch(plain.text, /输出为空/);
});

test("身体段落里有自己的进程 pid", () => {
  assert.match(describeBody(), new RegExp(`你自己：运行基座是 node v[\\d.]+ 进程 pid ${process.pid}（父进程 ${process.ppid}）`));
});
