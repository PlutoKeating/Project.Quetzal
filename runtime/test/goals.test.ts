// 长期目标（#23）：goal 工具（新建、修改、一步一步推进、关闭、列出）、旧的 open_loop 与旧数据的迁移、系统提示与醒来时的候选意图、
// 心脏的牵挂按进行中的目标数、控制台的 goals / goals.close；别处来的记录逐字段检查、较新的为准、关闭的墓碑过期后不会复活。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.QUETZAL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "quetzal-goals-"));
const { loadConfig, saveConfig } = await import("../src/config.ts");
loadConfig();
saveConfig({ body: "handset" });
const store = await import("../src/store.ts");
store.openStore();
// 旧版本留下的未完成念头：第一次读取时迁移成没有步骤的目标
store.kv.set("openLoops", [{ id: "abc123", text: "把相册整理一下", ts: Date.now() - 60_000 }]);
const goals = await import("../src/mind/goals.ts");
const { callTool } = await import("../src/mind/tools.ts");
const { Session } = await import("../src/mind/activity.ts");
const { systemPrompt } = await import("../src/mind/prompt.ts");
const heart = await import("../src/heart/heart.ts");
const { invoke, status } = await import("../src/ops.ts");
const { bus } = await import("../src/bus.ts");

const chat = (conv: string) => { store.ensureSession(conv, "会话", "控制台"); const s = new Session("chat", "控制台", undefined, conv); s.close(); return s; };

test("旧的未完成念头迁移成目标，编号不变；open_loop 仍可用，和 goal 是同一份", async () => {
  assert.deepEqual(goals.openLoops().map((l) => [l.id, l.text]), [["abc123", "把相册整理一下"]]);
  assert.equal(store.kv.get<unknown[]>("openLoops", []).length, 1, "旧数据原样保留");
  const s = chat("c1");
  assert.match((await callTool("open_loop", { action: "add", text: "学会做咖喱" }, "测试", { session: s })).text, /已记下，现在有 2 件/);
  const id = goals.open().find((g) => g.title === "学会做咖喱")!.id;
  assert.deepEqual(goals.get(id)!.convs, ["c1"], "记下是在哪个会话里");
  assert.match((await callTool("open_loop", { action: "close", id: "abc123" }, "测试", { session: s })).text, /已放下，还剩 1 件/);
  assert.equal(goals.get("abc123")!.status, "done", "关闭的留作墓碑");
  assert.equal((await callTool("open_loop", { action: "close", id: "nope" }, "测试", { session: s })).status, "error", "没有这个目标就是失败");
  goals.close({ id });
});

test("goal：带步骤与进度，一步一步推进，做完提醒关闭；系统提示列出进行中的目标；牵挂按进行中的目标数", async () => {
  {
    const s = chat("c2");
    const add = await callTool("goal", { action: "add", title: "帮对方办好签证", detail: "下个月出发", steps: ["查材料清单", "预约", "递交"] }, "测试", { session: s });
    assert.equal(add.status, "ok");
    const id = add.text.match(/\[([0-9a-f]{8})\]/)![1];
    assert.match(add.text, /进度 0\/3（0%）[\s\S]*1\. ○ 查材料清单/);
    assert.equal(heart.snapshot().drives.openLoops, 1 / 5, "牵挂 = 进行中的目标数 / 5");
    assert.match((await callTool("goal", { action: "step_done", id, step: 1 }, "测试", { session: s })).text, /进度 1\/3（33%）[\s\S]*1\. ✓ 查材料清单/);
    assert.match((await callTool("goal", { action: "step_done", id, step: 2, status: "doing" }, "测试", { session: s })).text, /2\. … 预约/);
    assert.match((await callTool("goal", { action: "update", id, add_steps: ["取签证"] }, "测试", { session: s })).text, /进度 1\/4[\s\S]*4\. ○ 取签证/);
    assert.match((await callTool("goal", { action: "update", id, steps: ["查材料清单", "递交", "取签证"] }, "测试", { session: s })).text, /1\. ✓ 查材料清单\n  2\. ○ 递交/, "整份替换时同样文字的步骤保留状态");
    assert.equal((await callTool("goal", { action: "step_done", id, step: 9 }, "测试", { session: s })).status, "error");

    const p = systemPrompt("", { conv: "c2", dynamic: true });
    assert.match(p, new RegExp(`进行中的目标[\\s\\S]*\\[${id}\\] 帮对方办好签证（进度 1/3（33%）[\\s\\S]*接下来：2\\. 递交；3\\. 取签证`));
    assert.match(p, /牵挂（进行中的目标） 0\.20/);

    await callTool("goal", { action: "step_done", id, step: 2 }, "测试", { session: s });
    assert.match((await callTool("goal", { action: "step_done", id, step: 3 }, "测试", { session: s })).text, /每一步都做完了：确实做成了就用 close/);
    assert.match((await callTool("goal", { action: "close", id, note: "拿到了" }, "测试", { session: s })).text, /已完成「帮对方办好签证」，进行中的目标还有 0 个/);
    assert.equal(heart.snapshot().drives.openLoops, 0);
    assert.match(systemPrompt("", { dynamic: true }), /没有进行中的目标/);
    assert.match((await callTool("goal", { action: "list" }, "测试", { session: s })).text, /帮对方办好签证（已完成[\s\S]*拿到了/);
  }
});

test("控制台：status 带进行中的目标（步骤与进度），goals.close 关闭并记审计", async () => {
  const g = goals.add({ title: "读完一本书", steps: ["第一章", "第二章"] });
  goals.stepDone({ id: g.id, step: 1 });
  const v = (status() as any).goals.find((x: any) => x.id === g.id);
  assert.deepEqual(v.progress, { done: 1, total: 2, ratio: 0.5 });
  assert.deepEqual(v.steps.map((x: any) => x.status), ["done", "todo"]);
  let changed = 0; const on = () => changed++; bus.on("goals.changed", on);
  const after = await invoke("goals.close", { id: g.id, outcome: "dropped" }, "控制台");
  bus.off("goals.changed", on);
  assert.ok(!(after as any[]).some((x) => x.id === g.id));
  assert.equal(goals.get(g.id)!.status, "dropped");
  assert.equal(goals.get(g.id)!.note, "控制台关闭的");
  assert.equal(changed, 1, "关闭会广播给其他身体");
  assert.ok(store.listAudit(5).some((a: any) => a.action === "goals.close"));
  assert.ok((await invoke("goals", { closed: true }, "控制台") as any[]).some((x) => x.id === g.id));
});

test("合并别处的记录：逐字段检查，同一编号以较新的为准（相同时刻按内容收敛），关闭的墓碑过了保留期不收也不复活", () => {
  const now = Date.now();
  const rec = { id: "0011aabb", title: "一起去爬山", detail: "", steps: [{ id: "1", text: "选路线", status: "done", updated: now }, { text: "看天气", status: "weird" }], status: "open", note: "", created: now, updated: now, progressed: now, convs: ["x"], body: "pc" };
  let remote = 0; const on = () => remote++; bus.on("goals.changed", on);
  assert.equal(goals.merge([rec, { ...rec, id: "BAD!" }, { ...rec, id: "0022aabb", updated: now + 3_600_000 }, { ...rec, id: "0033aabb", title: "  " }, { ...rec, id: "0044aabb", status: "done", updated: now - 40 * 86_400_000 }]), true);
  bus.off("goals.changed", on);
  assert.equal(remote, 0, "别处来的不再广播出去");
  const g = goals.get("0011aabb")!;
  assert.deepEqual(g.steps.map((s) => [s.id, s.text, s.status]), [["1", "选路线", "done"], ["2", "看天气", "todo"]]);
  assert.equal(g.body, "pc");
  for (const id of ["0022aabb", "0033aabb", "0044aabb"]) assert.equal(goals.get(id), undefined, `不收 ${id}`);
  assert.equal(goals.merge([{ ...rec, title: "旧标题", updated: now - 1 }]), false, "较旧的不覆盖");
  const a = { ...rec, title: "版本 A", updated: now + 1 }, b = { ...rec, title: "版本 B", updated: now + 1 };
  goals.merge([a]); goals.merge([b]); const first = goals.get("0011aabb")!.title;
  goals.merge([a]); assert.equal(goals.get("0011aabb")!.title, first, "相同时刻按内容比较：无论先收到哪个都收敛到同一份");
  assert.equal(first, "版本 B");
  assert.equal(goals.merge([{ ...rec, status: "done", updated: now + 2 }]), true);
  assert.equal(goals.get("0011aabb")!.status, "done", "别处关闭了");
  assert.equal(goals.merge([{ ...rec, updated: now + 1 }]), false, "旧的「进行中」重放不会让它复活");
});
