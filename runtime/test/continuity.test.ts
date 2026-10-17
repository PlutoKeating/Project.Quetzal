// 续做（#11）与工作状态同步（单具身体的部分）：
//   - task_state 记进按会话的记录（带阶段与标签），一改就广播；别处来的按会话后写胜、逐字段检查；新的一轮带上别处同步来的约束与未决问题。
//   - 进行中的一轮从开始起就有检查点（会话、起因、做了几步、最近的过程），结束时标为结束。
//   - 基座重启后：没做完的子 agent 从检查点续做（不再标为中断），没做完的对话在原会话里以「续做」的交接接着做，没做完的醒来按原来的起因接着做。
//   - 防重复：同一件事只给一具身体续做（记录的身体还活着就不给别人）；续做太多次的放弃并告诉她。
//   - 被别处接手：这里正在做的那一轮、那个子 agent 悄悄停下（不留回复、不送报告）。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

process.env.QUETZAL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "quetzal-continuity-"));
const { loadConfig, saveConfig } = await import("../src/config.ts");
loadConfig();
saveConfig({ body: "handset", brain: { memoryLearning: false, memorySemantic: false } });
const store = await import("../src/store.ts");
store.openStore();
const reg = await import("../src/providers/registry.ts");
const taskStates = await import("../src/mind/task-states.ts");
const agents = await import("../src/mind/agents.ts");
const continuity = await import("../src/mind/continuity.ts");
const { converse } = await import("../src/mind/brain.ts");
const { callTool } = await import("../src/mind/tools.ts");
const { createTurnContext } = await import("../src/mind/context.ts");
const { Session, liveTurns } = await import("../src/mind/activity.ts");
const { bus } = await import("../src/bus.ts");

const seen: any[] = [];
let scripted: ((j: any) => any) | undefined;
const llm = http.createServer((req, res) => {
  let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
    const j = JSON.parse(body); seen.push(j);
    const out = scripted?.(j) ?? { content: "好的" };
    if (out === "hang") return; // 一直不回：制造做到一半的一轮
    const send = (message: unknown) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 1, completion_tokens: 1 } })); };
    if (out.delay) setTimeout(() => send(out.message), out.delay); else send(out);
  });
});
await new Promise<void>((r) => llm.listen(0, "127.0.0.1", r));
reg.saveProviders({ providers: [{ id: "p", catalogId: "custom", name: "Mock", baseUrl: `http://127.0.0.1:${(llm.address() as any).port}`, protocol: "openai-completions" as const, enabled: true,
  keys: [{ id: "k", label: "k", lastFour: "", enabled: true, secret: "sk-mock-000000" }], models: [{ id: "m", name: "plain", enabled: true, context: 131072, maxTokens: 256, sortOrder: 0 }] }] }, reg.configVersion());
const textOf = (m: any) => (typeof m.content === "string" ? m.content : (m.content ?? []).map((c: any) => c.text ?? "").join(""));
const allText = (j: any) => j.messages.map(textOf).join("\n");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (f: () => boolean, ms = 10_000) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error("等待超时"); await sleep(20); } };
continuity.configureContinuity({ checkpointMs: 50 });
const stopContinuity = continuity.startContinuity();
after(() => { stopContinuity(); llm.closeAllConnections(); llm.close(); });

test("task_state：按会话记下（含阶段与标签）并广播；别处的按会话后写胜、逐字段检查；新的一轮带上别处同步来的约束", async () => {
  store.ensureSession("ts", "工作");
  const s = new Session("chat", "控制台", undefined, "ts");
  const ctx = createTurnContext(s.id, "ts", [{ role: "user", content: "帮我写周报" }]);
  let changed = 0; const on = () => changed++; bus.on("taskStates.changed", on);
  const r = await callTool("task_state", { constraints: ["不超过 300 字"], openQuestions: ["要不要附图？"], tags: ["写作"], phase: "verification" }, "测试", { session: s });
  bus.off("taskStates.changed", on);
  ctx.close(); s.close();
  assert.equal(r.status, "ok");
  assert.equal(changed, 1);
  const rec = taskStates.get("ts")!;
  assert.deepEqual([rec.constraints, rec.openQuestions, rec.tags, rec.phase, rec.body], [["不超过 300 字"], ["要不要附图？"], ["写作"], "verification", "handset"]);

  const now = Date.now();
  assert.equal(taskStates.merge([{ ...rec, constraints: ["旧的"], updatedAt: now - 60_000 }]), false, "较旧的不覆盖");
  assert.equal(taskStates.merge([{ conv: "ts", goal: "g", constraints: ["用表格", 3], openQuestions: [], phase: "nope", tags: [], updatedAt: now + 1000, body: "pc" }, { conv: "x\u0000", updatedAt: now }, { conv: "y", updatedAt: now + 3_600_000 }]), true);
  const got = taskStates.get("ts")!;
  assert.deepEqual([got.constraints, got.phase, got.body], [["用表格"], "unknown", "pc"]);
  assert.equal(taskStates.all().length, 1, "不合格的不收");
  // 换到这具身体上的下一轮：约束与未决问题来自同步来的记录
  const s2 = new Session("chat", "控制台", undefined, "ts");
  const ctx2 = createTurnContext(s2.id, "ts", [{ role: "user", content: "继续" }]);
  assert.deepEqual(JSON.parse((await callTool("task_state", {}, "测试", { session: s2 })).text).constraints, ["用表格"]);
  ctx2.close(); s2.close();
  // 旧版本的记录（context.state.<会话>）照样读得到
  store.kv.set("context.state.old", { goal: "旧", constraints: ["旧约束"], openQuestions: [], evidence: [] });
  assert.deepEqual(taskStates.get("old")!.constraints, ["旧约束"]);
});

test("进行中的一轮从开始起就有检查点（起因、步数、最近的过程），结束时标为结束", async () => {
  store.ensureSession("cp", "检查点");
  let n = 0;
  scripted = (j) => (/检查点测试/.test(allText(j)) ? (++n === 1 ? { content: "先看看笔记", tool_calls: [{ id: "t1", type: "function", function: { name: "note_list", arguments: "{}" } }] } : { delay: 400, message: { content: "看完了" } }) : undefined);
  const p = converse("你", "检查点测试", "控制台", { conv: "cp" });
  await until(() => continuity.turns().some((x) => x.conv === "cp" && x.steps === 1));
  const mid = continuity.turns().find((x) => x.conv === "cp")!;
  assert.equal(mid.status, "running");
  assert.match(mid.summary, /- 说：「先看看笔记」\n- note_list\(\) ✓/);
  assert.equal(await p, "看完了");
  const t = continuity.turns().find((x) => x.conv === "cp")!;
  assert.equal(t.origin, "chat"); assert.equal(t.body, "handset"); assert.equal(t.text, "检查点测试");
  assert.equal(t.status, "ended");
  scripted = undefined;
});

test("基座重启后：没做完的子 agent 从检查点续做（不再标为中断），报告送回派出它的会话", async () => {
  store.ensureSession("parent", "主会话");
  const now = Date.now();
  store.kv.set("agents", [{ id: "a1b2c3d4", name: "调研员", goal: "比较 A 和 B", parentConv: "parent", parentChannel: "控制台", status: "running", started: now - 60_000, steps: 2, tokens: 10, body: "handset", updated: now - 30_000, epoch: 0,
    checkpoint: { at: now - 30_000, steps: 2, summary: "- web_search(A 的价格) ✓ → A 每月 10 元\n- web_search(B 的价格) ✓ → B 每月 12 元" } }]);
  agents.restore();
  assert.equal(agents.get("a1b2c3d4")!.status, "running", "重启后不再标为中断");
  assert.deepEqual(continuity.pendingOf("handset").agents.map((a) => a.id), ["a1b2c3d4"]);
  scripted = (j) => {
    if (/你是「调研员」/.test(textOf(j.messages[0]))) return { content: null, tool_calls: [{ id: "fin", type: "function", function: { name: "finish", arguments: JSON.stringify({ title: "A 便宜", journal: "A 比 B 便宜 2 元" }) } }] };
    if (/子 agent「调研员」完成了任务/.test(allText(j))) return { content: "报告收到。" };
    return undefined;
  };
  assert.equal(await continuity.resumeHere(), 1);
  await until(() => agents.get("a1b2c3d4")!.status === "done");
  const call = seen.find((j) => /你是「调研员」/.test(textOf(j.messages[0])))!;
  assert.match(allText(call), /基座重启了，这个子 agent 之前没做完。你之前已经做了 2 步，检查点记下的过程：\n- web_search\(A 的价格\) ✓ → A 每月 10 元/);
  assert.equal(agents.get("a1b2c3d4")!.resumes, 1);
  await until(() => store.sessionMessages("parent").some((m) => m.role === "agent"));
  assert.match(store.sessionMessages("parent")[0].text, /子 agent「调研员」完成了任务（A 便宜）/);
  scripted = undefined;
});

test("基座重启后：没做完的对话在原会话里以「续做」的交接接着做；没做完的醒来按原来的起因接着做", async () => {
  store.ensureSession("half", "做到一半");
  store.addMessage("user", "控制台", "帮我把照片按月份归档", { session: "half" });
  const now = Date.now();
  store.kv.set("turns", [
    { id: "turn-chat-1", origin: "chat", conv: "half", channel: "控制台", body: "handset", text: "帮我把照片按月份归档", started: now - 120_000, updated: now - 60_000, epoch: 0, status: "running", steps: 1, summary: "- shell(ls ~/照片) ✓ → 2024-01 2024-02", resumes: 0 },
    { id: "turn-think-1", origin: "think", conv: "", channel: "", body: "handset", text: "好奇心", started: now - 120_000, updated: now - 60_000, epoch: 0, status: "running", steps: 0, summary: "", resumes: 0 },
    { id: "turn-old", origin: "chat", conv: "half", channel: "控制台", body: "handset", text: "很久以前", started: now - 7 * 3_600_000, updated: now - 7 * 3_600_000, epoch: 0, status: "running", steps: 0, summary: "", resumes: 0 },
  ]);
  scripted = (j) => {
    const t = allText(j);
    if (/先别急着做事/.test(t)) return { content: JSON.stringify({ engage: true, intent: "x" }) };
    if (/续做：好奇心/.test(textOf(j.messages.at(-1))) || /接着之前没做完的这次醒来/.test(t)) return { content: null, tool_calls: [{ id: "f", type: "function", function: { name: "finish", arguments: JSON.stringify({ title: "续做的醒来", journal: "接着想完了" }) } }] };
    if (/基座提醒（续做）/.test(textOf(j.messages.at(-1)))) return { content: "照片按月份归好了。" };
    return undefined;
  };
  assert.equal(await continuity.resumeHere(), 2, "太久的那一轮不再续做");
  await until(() => store.sessionMessages("half").some((m) => m.role === "agent"));
  const msgs = store.sessionMessages("half");
  assert.deepEqual(msgs.map((m) => [m.role, m.channel]), [["user", "控制台"], ["ambient", "续做"], ["agent", "续做"]]);
  assert.match(msgs[1].text, /基座重启了，这一轮之前没做完。这一轮从 .* 开始（起因是上面对话记录里还没回复的那句话），之前做了 1 步，检查点记下的过程：\n- shell\(ls ~\/照片\)/);
  assert.equal(msgs[2].text, "照片按月份归好了。");
  const call = seen.findLast((j) => /基座提醒（续做）/.test(textOf(j.messages.at(-1))))!;
  assert.match(allText(call), /基座记下的检查点|不要从头重复/);
  assert.match(allText(call), /帮我把照片按月份归档/, "对方那句话在历史里");
  await until(() => store.listTimeline(50).some((e) => e.kind === "think" && e.title === "续做的醒来"));
  const ts = continuity.turns();
  assert.equal(ts.find((t) => t.id === "turn-chat-1")!.status, "handed");
  assert.equal(ts.find((t) => t.id === "turn-old")!.status, "ended");
  const next = ts.find((t) => t.conv === "half" && t.channel === "续做")!;
  assert.equal(next.resumes, 1, "续做出来的那一轮记着这是第几次续做");
  scripted = undefined;
});

test("谁来续做：记录的身体还活着就不给别人；不在了只给第一个来要的；续做太多次就放弃并告诉她", async () => {
  const now = Date.now();
  const rec = { id: "e5f6a7b8", name: "搬运工", goal: "搬", parentConv: "parent", parentChannel: "控制台", status: "running", started: now, steps: 0, tokens: 0, body: "laptop", updated: now, epoch: 0 };
  agents.merge([rec]);
  assert.equal(continuity.decideTake("agent", "e5f6a7b8", "tablet", (b) => b === "laptop").ok, false, "laptop 还在线");
  const first = continuity.decideTake("agent", "e5f6a7b8", "tablet", () => false), second = continuity.decideTake("agent", "e5f6a7b8", "handset", (b) => b === "tablet");
  assert.deepEqual([first.ok, second.ok], [true, false]);
  assert.equal(agents.get("e5f6a7b8")!.body, "tablet"); assert.equal(agents.get("e5f6a7b8")!.epoch, 1);
  // 续做了太多次
  agents.merge([{ ...rec, id: "c0ffee00", body: "handset", epoch: 0, resumes: continuity.MAX_RESUMES }]);
  assert.equal(await continuity.continueWork("agent", "c0ffee00", "测试"), false);
  assert.equal(agents.get("c0ffee00")!.status, "error");
  await until(() => store.sessionMessages("parent").some((m) => /子 agent「搬运工」中断了：已经续做了 3 次仍没做完/.test(m.text)));
});

test("被别处接手：这里正在做的那一轮停下、不留回复；跑着的子 agent 停下、不送报告", async () => {
  store.ensureSession("taken", "被接手");
  scripted = (j) => (/这一轮会被接手/.test(allText(j)) || /你是「慢工」/.test(textOf(j.messages[0])) ? "hang" : undefined);
  const p = converse("你", "这一轮会被接手", "控制台", { conv: "taken" });
  await until(() => liveTurns().some((t) => t.conv === "taken"));
  const rec = continuity.turns().find((t) => t.conv === "taken" && t.status === "running")!;
  assert.ok(rec, "开始时就有检查点");
  assert.equal(continuity.mergeTurns([{ ...rec, status: "handed", by: "laptop", epoch: rec.epoch + 1, updated: Date.now() }]), true);
  assert.equal(await p, "");
  assert.ok(!store.sessionMessages("taken").some((m) => m.role === "agent"), "这里不留回复：接手的身体会在同一个会话里回复");
  assert.ok(store.listTimeline(20).some((e) => /交给 laptop 接着做了/.test(e.title)));

  const s = new Session("chat", "控制台", undefined, "parent"); s.close();
  const id = (await callTool("agent_spawn", { name: "慢工", goal: "慢慢来" }, "测试", { session: s })).text.match(/id (\w+)/)![1];
  await sleep(50);
  const a = agents.get(id)!;
  const before = store.sessionMessages("parent").length;
  assert.equal(agents.merge([{ ...a, checkpoint: undefined, body: "laptop", epoch: a.epoch + 1, updated: Date.now() }]), true);
  await until(() => !agents.runningHere(id));
  assert.equal(agents.get(id)!.status, "running", "记录仍是进行中（在 laptop 上）");
  assert.match(agents.describe(id), /在 laptop 上进行中/);
  await sleep(200);
  assert.equal(store.sessionMessages("parent").length, before, "这里不送报告");
  scripted = undefined;
});
