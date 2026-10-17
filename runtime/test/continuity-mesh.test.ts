// 两具身体真实连接（#11、#23）：进行中的工作全网同步；一具身体离线时，它手上没做完的事由协调层交给另一具在线的身体接着做。
//   - 长期目标、会话的工作状态、子 agent 的记录（含在哪具身体上）一改就同步到另一具身体。
//   - 同一件事只给一具身体续做：两具身体同时请求续做一具离线身体上的子 agent，只有一个成功（协调者决定）。
//   - 手机（跟随者）上跑到一半的子 agent：手机离线后，电脑（协调者）从检查点接着做，报告送回原来的会话。
//   - 手机上做到一半的一轮对话：手机离线后，电脑在原会话里以「续做」的交接接着做，回复照常进会话。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fork, type ChildProcess } from "node:child_process";

let has = true;
try { await import("node-datachannel"); } catch { has = false; }
const skip = !has && "这台机器没有 node-datachannel（可选依赖）";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "quetzal-continuity-mesh-"));
const procs: ChildProcess[] = [];
let close = () => {};
after(() => { for (const p of procs) p.kill(); close(); });

const until = async (f: () => Promise<boolean>, ms = 30_000) => { const t = Date.now(); while (!(await f())) { if (Date.now() - t > ms) throw new Error("等待超时"); await new Promise((r) => setTimeout(r, 100)); } };

test("两具身体：目标、工作状态与子 agent 记录同步；离线身体手上没做完的子 agent 与对话由另一具接着做，只做一份", { skip, timeout: 120_000 }, async () => {
  const { fakeSync } = await import("./fixtures/fake-sync.ts");
  const { loadNodeKey } = await import("../src/mesh/identity.ts");
  const keys: Record<string, string> = {};
  for (const b of ["phone", "pc"]) { fs.mkdirSync(path.join(tmp, b, "secrets"), { recursive: true }); keys[b] = loadNodeKey(path.join(tmp, b, "secrets", "mesh_ed25519")).nodeKey; }
  const sync = await fakeSync({ ...keys });
  close = () => sync.close();
  const spawnBody = (name: string, priority: number) => {
    const p = fork(path.join(import.meta.dirname, "fixtures", "body.ts"), [], {
      execArgv: ["--experimental-strip-types", "--disable-warning=ExperimentalWarning"],
      env: { ...process.env, QUETZAL_HOME: path.join(tmp, name), BODY: name, SYNC: sync.url, KEYS: JSON.stringify(keys), PRIORITY: String(priority), GRACE_MS: "1500" }, stdio: ["ignore", "ignore", "inherit", "ipc"],
    });
    procs.push(p);
    let seq = 0;
    const waiting = new Map<number, (m: any) => void>();
    const ready = new Promise<void>((r) => p.on("message", (m: any) => { if (m.ready) r(); else waiting.get(m.id)?.(m); }));
    const call = <T = any>(cmd: string, args?: unknown) => new Promise<T>((resolve, reject) => {
      const id = ++seq; waiting.set(id, (m) => { waiting.delete(id); m.error ? reject(new Error(m.error)) : resolve(m.result); });
      p.send({ id, cmd, args });
    });
    return { ready, call };
  };
  const phone = spawnBody("phone", 0), pc = spawnBody("pc", 5);
  await Promise.all([phone.ready, pc.ready]);
  await until(async () => (await phone.call("coordinator")) === "pc" && (await pc.call("coordinator")) === "pc" && (await phone.call<string[]>("connected")).includes("pc"));

  // 长期目标：手机上记下，电脑上推进一步，手机上看到进度
  const added = await phone.call<string>("goal", { action: "add", title: "学会弹吉他", steps: ["买琴", "学和弦"], conv: "c-goal" });
  const gid = added.match(/\[([0-9a-f]{8})\]/)![1];
  await until(async () => (await pc.call<any[]>("goals")).some((g) => g.id === gid));
  await pc.call("goal", { action: "step_done", id: gid, step: 1 });
  await until(async () => (await phone.call<any[]>("goals")).find((g) => g.id === gid)?.steps[0].status === "done");
  assert.equal((await phone.call<any[]>("goals")).find((g) => g.id === gid).body, "pc", "记着最近在哪具身体上改的");

  // 会话的工作状态：按会话后写胜
  await phone.call("saveTaskState", { conv: "c-work", state: { goal: "写周报", constraints: ["不超过 300 字"], openQuestions: [], phase: "exploration", tags: ["写作"] } });
  await until(async () => (await pc.call<any>("taskState", { conv: "c-work" }))?.constraints?.[0] === "不超过 300 字");

  // 同一件事只给一具身体续做：一具离线身体（ghost）上的子 agent，两边同时请求
  const now = Date.now();
  const ghost = { id: "9a9a9a9a", name: "幽灵", goal: "随便", parentConv: "c-ghost", parentChannel: "控制台", status: "running", started: now, steps: 0, tokens: 0, body: "ghost", updated: now, epoch: 0 };
  await Promise.all([phone.call("mergeAgents", { records: [ghost] }), pc.call("mergeAgents", { records: [ghost] })]);
  const both = await Promise.all([phone.call<boolean>("take", { kind: "agent", id: ghost.id }), pc.call<boolean>("take", { kind: "agent", id: ghost.id })]);
  assert.equal(both.filter(Boolean).length, 1, JSON.stringify(both));
  await until(async () => { const a = (await phone.call<any[]>("agents")).find((x) => x.id === ghost.id), b = (await pc.call<any[]>("agents")).find((x) => x.id === ghost.id); return a?.epoch === 1 && b?.epoch === 1 && a.body === b.body; });

  // 手机上的子 agent：先做一步（note_list），第二次模型调用一直不回（做到一半）；记录与检查点同步到电脑
  await phone.call("llmScript", { messages: [{ content: "先看看", tool_calls: [{ id: "t1", type: "function", function: { name: "note_list", arguments: "{}" } }] }, { delay: 600_000, message: { content: "不会到这里" } }] });
  const aid = await phone.call<string>("spawnAgent", { name: "整理员", goal: "整理笔记", conv: "c-agent" });
  await until(async () => (await pc.call<any[]>("agents")).find((a) => a.id === aid)?.checkpoint?.steps === 1);
  const synced = (await pc.call<any[]>("agents")).find((a) => a.id === aid);
  assert.equal(synced.body, "phone"); assert.equal(synced.status, "running");
  assert.match(synced.checkpoint.summary, /note_list\(\) ✓/);
  // 她在电脑上对手机上的子 agent 说话：转过去
  assert.match(await pc.call<string>("agentMessage", { id: aid, text: "重点看最近的" }), /已送达/);

  // 手机上做到一半的一轮对话（模型一直不回）
  await phone.call("ensureSession", { id: "c-chat", title: "对话" });
  await phone.call("llmScript", { messages: [{ delay: 600_000, message: { content: "不会到这里" } }] });
  void phone.call("converse", { text: "帮我查一下明天的天气", conv: "c-chat" }).catch(() => {});
  await until(async () => (await pc.call<any[]>("turns")).some((t) => t.conv === "c-chat" && t.status === "running" && t.body === "phone"));

  // 手机离线：过了交接的宽限（测试里 1.5 秒），电脑接着做
  void phone.call("stop").catch(() => {});
  await until(async () => (await pc.call<any[]>("agents")).find((a) => a.id === aid)?.status === "done", 60_000);
  const done = (await pc.call<any[]>("agents")).find((a) => a.id === aid);
  assert.equal(done.body, "pc"); assert.equal(done.resumes, 1); assert.ok(done.epoch >= 1);
  assert.equal(done.result, "pc 的回复", "电脑上的模型回答的");
  const seen = (await pc.call<string[]>("llmSeen")).join("\n");
  assert.match(seen, /之前在 phone 上做，那具身体离线了，由 pc 接着做。你之前已经做了 1 步，检查点记下的过程：[\s\S]*note_list/);
  await until(async () => (await pc.call<any[]>("messages", { session: "c-agent" })).some((m) => /子 agent「整理员」完成了任务/.test(m.text)));

  await until(async () => (await pc.call<any[]>("messages", { session: "c-chat" })).some((m) => m.role === "agent"), 60_000);
  const msgs = await pc.call<any[]>("messages", { session: "c-chat" });
  assert.deepEqual(msgs.map((m) => [m.role, m.channel]), [["user", "控制台"], ["ambient", "续做"], ["agent", "续做"]]);
  assert.match(msgs[1].text, /之前在 phone 上做，那具身体离线了，由 pc 接着做/);
  assert.equal(msgs[2].text, "pc 的回复");
  assert.equal(msgs[2].body, "pc");
  const handed = (await pc.call<any[]>("turns")).find((t) => t.conv === "c-chat" && t.body === "phone");
  assert.equal(handed.status, "handed"); assert.equal(handed.by, "pc");
});
