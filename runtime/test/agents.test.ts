// 会话操作工具：切到新会话（回复落在新会话、飞书当前会话切换、交接）、压缩上下文（摘要之前的历史不进上下文）、子 agent（后台跑、对话、报告送回、停止）。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

process.env.QUETZAL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "quetzal-agents-"));
const { loadConfig } = await import("../src/config.ts");
loadConfig();
const store = await import("../src/store.ts");
store.openStore();
const reg = await import("../src/providers/registry.ts");
const { converse, history } = await import("../src/mind/brain.ts");
const { callTool } = await import("../src/mind/tools.ts");
const agents = await import("../src/mind/agents.ts");
const { bus } = await import("../src/bus.ts");
const { Session } = await import("../src/mind/activity.ts");

// 模拟模型：按最后一条用户消息里的关键字决定回复或调用工具
const seen: any[] = [];
let scripted: ((j: any) => any) | undefined; // 返回 null 表示不回应
const llm = http.createServer((req, res) => {
  let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
    const j = JSON.parse(body); seen.push(j);
    const out = scripted?.(j) ?? { content: "好的" };
    if (out === null) return; // 模型一直不回（测试停止子 agent 用）
    setTimeout(() => { // 子 agent 的调用慢一点，让中途对话来得及
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: out }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    }, /你是「/.test(j.messages[0].content) ? 250 : 0);
  });
});
await new Promise<void>((r) => llm.listen(0, "127.0.0.1", r));
reg.saveProviders({ providers: [{ id: "p", catalogId: "custom", name: "Mock", baseUrl: `http://127.0.0.1:${(llm.address() as any).port}`, protocol: "openai-completions" as const, enabled: true,
  keys: [{ id: "k", label: "k", lastFour: "", enabled: true, secret: "sk-mock-000000" }], models: [{ id: "m", name: "plain", enabled: true, context: 8000, maxTokens: 256, sortOrder: 0 }] }] }, reg.configVersion());
const lastText = (j: any) => { const m = j.messages.at(-1); return typeof m.content === "string" ? m.content : m.content.find((c: any) => c.type === "text")?.text ?? ""; };
const sysOf = (j: any) => j.messages[0].content as string;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("session_new：这一轮的回复落在新会话，交接作为新会话的第一条记录，控制台收到 session.switch", async () => {
  const events: any[] = []; bus.on("session.switch", (e) => events.push(e));
  store.ensureSession("old", "旧话题");
  store.addMessage("user", "控制台", "之前聊的东西", { session: "old" });
  let called = false;
  scripted = (j) => {
    if (!called) { called = true; return { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "session_new", arguments: JSON.stringify({ title: "新话题", handoff: "对方喜欢简短回答" }) } }] }; }
    return { content: "好，我们从这里重新开始。" };
  };
  const reply = await converse("你", "换个话题吧", "控制台", { conv: "old" });
  assert.equal(reply, "好，我们从这里重新开始。");
  const to = events[0].to;
  assert.equal(events[0].from, "old"); assert.equal(events[0].title, "新话题");
  assert.deepEqual(events.map((e) => !!e.done), [false, true]);
  assert.equal(store.getSession(to)!.title, "新话题");
  assert.deepEqual(store.sessionMessages(to).map((m) => [m.role, m.channel, m.text]), [["ambient", "交接", "对方喜欢简短回答"], ["agent", "控制台", "好，我们从这里重新开始。"]]);
  assert.deepEqual(store.sessionMessages("old").map((m) => m.role), ["user", "user"]); // 旧会话只有对方的话，回复去了新会话
  assert.match(history(to, Number.MAX_SAFE_INTEGER).map((m) => m.content).join("\n"), /交接\] 对方喜欢简短回答/);
  // 只能在对话中调用
  assert.match((await callTool("session_new", {}, "测试", { session: new Session("think") })).text, /只能在对话中/);
});

test("session_new 在飞书里：切换飞书当前会话", async () => {
  const s = new Session("chat", "飞书", "t", "feishu");
  const r = await callTool("session_new", { title: "飞书新会话" }, "测试", { session: s });
  assert.match(r.text, /已切到新会话「飞书新会话」/);
  assert.equal(store.kv.get("feishu.conv", ""), s.switchTo);
  assert.match(store.kv.get("feishu.conv", ""), /^feishu-/);
  s.close();
});

test("session_compact：她自己写摘要；之后的上下文只含摘要与新内容；不写时由模型代写", async () => {
  store.ensureSession("c", "长会话");
  for (let i = 1; i <= 5; i++) { store.addMessage("user", "控制台", `第${i}个问题`, { session: "c" }); store.addMessage("agent", "控制台", `第${i}个回答`, { session: "c" }); }
  const s = new Session("chat", "控制台", "t2", "c");
  const r = await callTool("session_compact", { summary: "对方问了五个问题，都答了；对方喜欢编号列表。" }, "测试", { session: s });
  assert.match(r.text, /已压缩/);
  store.addMessage("user", "控制台", "第6个问题", { session: "c" });
  const h = history("c", Number.MAX_SAFE_INTEGER).map((m) => String(m.content));
  assert.equal(h.length, 2);
  assert.match(h[0], /压缩了这个会话.*对方问了五个问题/);
  assert.match(h[1], /第6个问题/);
  assert.ok(!h.join("\n").includes("第3个回答")); // 更早的原文不再进入上下文
  assert.equal(store.sessionMessages("c").length, 12, "记录仍完整保留");
  // 不给 summary：快速模型代写
  scripted = (j) => ({ content: /压缩/.test(lastText(j)) ? "摘要：对方问了六个问题。" : "好的" });
  const r2 = await callTool("session_compact", {}, "测试", { session: s });
  assert.match(r2.text, /摘要：对方问了六个问题/);
  assert.match(sysOf(seen.at(-1)), /替一个 agent 压缩/);
  s.close();
});

test("子 agent：独立的系统提示在后台跑，中途能对话，完成后报告以环境输入送回派出它的会话，由她决定怎么用", async () => {
  store.ensureSession("p", "主会话");
  const activity: any[] = []; bus.on("activity", (a) => { if (a.origin === "agent") activity.push(a); });
  let agentCalls = 0;
  scripted = (j) => {
    const sys = sysOf(j);
    if (/你是「调研员」/.test(sys)) { // 子 agent 的模型调用
      agentCalls++;
      if (agentCalls < 3) return { content: /补充了新消息/.test(lastText(j)) ? "收到补充，继续查。" : "我先查一下。", tool_calls: [{ id: `a${agentCalls}`, type: "function", function: { name: "note_list", arguments: "{}" } }] };
      return { content: null, tool_calls: [{ id: "fin", type: "function", function: { name: "finish", arguments: JSON.stringify({ title: "查完了", journal: "结论：A 比 B 好，因为……" }) } }] };
    }
    if (/子 agent 送回的报告|子 agent「调研员」完成了任务/.test(lastText(j))) return { content: "报告收到，我来告诉对方。" };
    return { content: "好的" };
  };
  const s = new Session("chat", "控制台", "t3", "p");
  const r = await callTool("agent_spawn", { name: "调研员", goal: "比较 A 和 B", persona: "严谨的研究者", scope: "只看公开资料", background: "A 与 B 都是数据库", context: "对方倾向 A" }, "测试", { session: s });
  const id = r.text.match(/id (\w+)/)![1];
  assert.match(r.text, /已派出「调研员」/);
  assert.equal(agents.get(id)!.status, "running");
  await sleep(150);
  const sys = seen.find((j) => /你是「调研员」/.test(sysOf(j)))!;
  assert.match(sysOf(sys), /## 人设\n严谨的研究者/); assert.match(sysOf(sys), /## 领域范围\n只看公开资料/); assert.match(sysOf(sys), /## 知识背景\nA 与 B 都是数据库/);
  assert.match(lastText(sys), /任务：比较 A 和 B[\s\S]*对方倾向 A/);
  assert.ok(!sys.tools.some((t: any) => t.function.name === "agent_spawn"), "子 agent 不能再派子 agent");
  assert.ok(sys.tools.some((t: any) => t.function.name === "finish"));
  // 中途对话
  assert.match((await callTool("agent_message", { id, text: "重点看成本" }, "测试", { session: s })).text, /已送达/);
  for (let i = 0; i < 40 && agents.get(id)!.status === "running"; i++) await sleep(100);
  const a = agents.get(id)!;
  assert.equal(a.status, "done");
  assert.equal(a.title, "查完了");
  assert.match(a.result!, /A 比 B 好/);
  assert.ok(seen.some((j) => /你是「调研员」/.test(sysOf(j)) && /补充了新消息：\n重点看成本/.test(lastText(j))), "子 agent 看到了她的消息");
  assert.match((await callTool("agent_status", { id }, "测试", { session: s })).text, /已完成（查完了）[\s\S]*报告：\n结论/);
  assert.match((await callTool("agent_message", { id, text: "再看看" }, "测试", { session: s })).text, /已经完成/);
  // 报告送回主会话：环境输入（通道「子agent」），她据此回应
  await sleep(300);
  const msgs = store.sessionMessages("p");
  assert.deepEqual(msgs.map((m) => [m.role, m.channel]), [["ambient", "子agent"], ["agent", "子agent"]]);
  assert.match(msgs[0].text, /子 agent「调研员」完成了任务（查完了）/);
  assert.equal(msgs[1].text, "报告收到，我来告诉对方。");
  assert.ok(activity.some((x) => x.kind === "start") && activity.some((x) => x.kind === "done"), "进展作为 origin=agent 的轮次广播");
  assert.ok(store.listTimeline(10).some((e) => e.kind === "agent" && /完成：查完了/.test(e.title)));
  s.close();
});

test("子 agent：可以被停止", async () => {
  scripted = () => null; // 模型一直不回
  const s = new Session("chat", "控制台", "t4", "p");
  const id = (await callTool("agent_spawn", { name: "慢工", goal: "慢慢来" }, "测试", { session: s })).text.match(/id (\w+)/)![1];
  await sleep(50);
  assert.match((await callTool("agent_stop", { id }, "测试", { session: s })).text, /已停止/);
  for (let i = 0; i < 30 && agents.get(id)!.status === "running"; i++) await sleep(100);
  assert.equal(agents.get(id)!.status, "stopped");
  assert.match((await callTool("agent_status", {}, "测试", { session: s })).text, /慢工 · 已停止/);
  s.close();
  llm.close();
});
