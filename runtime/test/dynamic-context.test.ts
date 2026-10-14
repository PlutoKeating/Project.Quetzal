import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { Msg } from "../src/providers/types.ts";
import type { MemoryDraft, MemoryEvidence } from "../src/memory/structured.ts";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "quetzal-dynamic-context-"));
process.env.QUETZAL_HOME = home;
const cfg = await import("../src/config.ts"); cfg.loadConfig();
cfg.saveConfig({ brain: { ...cfg.config.brain, memoryLearning: false, memorySemantic: false, maxOutputTokens: 256, contextWindow: 65536 } });
const store = await import("../src/store.ts"); store.openStore();
const soul = await import("../src/memory/soul-sync.ts"); await soul.ensureSoul();
const registry = await import("../src/providers/registry.ts");
const router = await import("../src/providers/router.ts");
const brain = await import("../src/mind/brain.ts");
const contextHost = await import("../src/mind/context.ts");
const memory = await import("../src/memory/structured.ts");
const { identity } = await import("../src/memory/identity.ts");
const { callTool } = await import("../src/mind/tools.ts");
const { Session, Stopped } = await import("../src/mind/activity.ts");

const seen: any[] = [];
let script: (request: any) => Promise<{ content?: string | null; tool_calls?: unknown[]; status?: number }> = async () => ({ content: "完成" });
const server = http.createServer((req, res) => {
  let text = "";
  req.on("data", (chunk) => { text += chunk; });
  req.on("end", () => {
    void (async () => {
      const request = JSON.parse(text); seen.push(request);
      const output = await script(request);
      if (output.status) { res.writeHead(output.status, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message: "synthetic failure" } })); return; }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: output.content ?? null, ...(output.tool_calls ? { tool_calls: output.tool_calls } : {}) } }], usage: { prompt_tokens: 10, completion_tokens: 2 } }));
    })().catch((error) => { res.writeHead(500); res.end(String(error instanceof Error ? error.message : "fixture failure")); });
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address(); assert.ok(address && typeof address !== "string");
const port = address.port;
function configure(models: { id: string; context: number; maxTokens?: number }[]) {
  registry.saveProviders({ providers: [{ id: "dynamic-provider", catalogId: "custom", name: "Synthetic", baseUrl: `http://127.0.0.1:${port}`, protocol: "openai-completions", enabled: true,
    keys: [{ id: "synthetic-key", label: "fixture", lastFour: "", enabled: true, secret: "synthetic-api-key" }],
    models: models.map((model, i) => ({ id: model.id, name: model.id, enabled: true, context: model.context, maxTokens: model.maxTokens ?? 256, sortOrder: i })) }], quickModelId: models[0]?.id }, registry.configVersion());
}
const joined = (request: any) => request.messages.map((message: any) => String(message.content ?? "")).join("\n");
const toolCall = (name: string, args: Record<string, unknown>, id = name) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
after(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); fs.rmSync(home, { recursive: true, force: true }); });

test("实际 converse 每步重新检索：可信宿主激活的新记忆与本轮 note_save 在下一步注入", async () => {
  configure([{ id: "large", context: 131072 }]); seen.length = 0;
  const conv = "dynamic-memory-conv";
  let step = 0;
  const fact = "星轨计划已核实的事实：交付清单必须有来源编号";
  const note = "星轨计划本轮新笔记：检查清单新增轨道验证步骤";
  script = async () => {
    if (++step === 1) {
      // 来源与独立审核由测试宿主提供，模型不能把自述设置为 verified。
      const evidence: MemoryEvidence = { id: "trusted-source", ref: "synthetic-user-message:source", origin: "user", observedAt: Date.now(), summary: fact, verified: true };
      const draft: MemoryDraft = { id: "dynamic-fact", kind: "fact", text: fact, scope: { agentId: identity().id, userId: "owner", sessionId: conv }, conditions: { requiredTags: [], excludedTags: [], tools: [] }, stage: "any", zone: "golden", evidenceIds: [evidence.id] };
      await memory.recordMemory(draft, [evidence]);
      const active = await memory.reviewMemory("dynamic-fact@1", { accepted: true, independent: true, evaluator: "trusted-fixture-source-check", score: 1, evidence: [evidence] });
      assert.equal(active.state, "active");
      return { tool_calls: [toolCall("note_save", { title: "星轨计划新笔记", body: note, summary: "星轨计划验证步骤" })] };
    }
    return { content: "星轨计划调研完成" };
  };
  assert.equal(await brain.converse("你", "只读调研星轨计划，禁止对外发布", "控制台", { conv }), "星轨计划调研完成");
  assert.equal(seen.length, 2); assert.ok(!joined(seen[0]).includes(fact));
  assert.ok(joined(seen[1]).includes(fact)); assert.ok(joined(seen[1]).includes(note));
  const plan = store.kv.get<any>(`context.plan.${conv}`, null);
  assert.ok(plan.selectedIds.includes("memory:dynamic-fact@1")); assert.ok(plan.estimate.totalTokens <= 131072);
});

test("实际 router 故障转移分别按候选窗口重算，tiny pinned/schema窗口不发HTTP请求", async () => {
  configure([{ id: "large-fails", context: 65536 }, { id: "small-fallback", context: 12000 }]); seen.length = 0;
  script = async (request) => request.model === "large-fails" ? { status: 404 } : joined(request).startsWith("压缩历史资料") ? { content: "较早资料须按来源核查。" } : { content: "fallback完成" };
  const messages: Msg[] = [{ role: "system", content: "系统政策必须保留" }];
  for (let i = 0; i < 14; i++) messages.push({ role: "assistant", content: `旧答${i}` + "x".repeat(1800) });
  messages.push({ role: "user", content: "当前输入只读约束，不允许修改" });
  const context = contextHost.createTurnContext("fallback-turn", "fallback-conv", messages);
  try {
    const result = await router.chat(await context.prepare({ messages, maxTokens: 256 })); assert.equal(result.text, "fallback完成");
    const real = seen.filter((request) => !joined(request).startsWith("压缩历史资料"));
    assert.deepEqual(real.map((request) => request.model), ["large-fails", "small-fallback"]);
    assert.ok(joined(real[1]).length < joined(real[0]).length); assert.ok(joined(real[1]).includes("当前输入只读约束，不允许修改"));
    const plan = store.kv.get<any>("context.plan.fallback-conv", null); assert.equal(plan.estimate.contextWindow, 12000); assert.ok(plan.estimate.totalTokens <= 12000);
  } finally { context.close(); }
  configure([{ id: "tiny", context: 800 }]); seen.length = 0;
  const tiny = contextHost.createTurnContext("tiny-turn", "tiny-conv", [{ role: "system", content: "原政策不截断" }, { role: "user", content: "请求" }]);
  try {
    await assert.rejects(router.chat(await tiny.prepare({ messages: [{ role: "system", content: "原政策不截断" }, { role: "user", content: "请求" }], tools: [{ name: "huge-schema", description: "schema".repeat(1000), parameters: {} }], maxTokens: 100 })), /系统政策|窗口/);
    assert.equal(seen.length, 0);
  } finally { tiny.close(); }
});

test("超长tool观测引用回查实际完整存储，分页可重建全文且跨会话与结束轮次拒绝", async () => {
  configure([{ id: "large", context: 131072 }]); script = async () => ({ content: "完成" });
  const turn = "source-turn", conv = "source-conv", full = `HEAD:${"完整工具证据".repeat(6000)}:TAIL`;
  store.saveToolCall({ call: "full-call", session: turn, ts: Date.now(), tool: "synthetic-tool", args: {}, result: full, status: "ok", ms: 1 });
  const messages: Msg[] = [{ role: "system", content: "policy" }, { role: "user", content: "读取证据" }, { role: "assistant", content: "", toolCalls: [{ id: "full-call", name: "synthetic-tool", args: {} }] }, { role: "tool", toolCallId: "full-call", name: "synthetic-tool", content: full.slice(0, 12000) }];
  const context = contextHost.createTurnContext(turn, conv, messages);
  const other = contextHost.createTurnContext("other-turn", "other-conv", [{ role: "user", content: "其他任务" }]);
  try {
    await router.chat(await context.prepare({ messages, maxTokens: 256 }));
    const plan = store.kv.get<any>(`context.plan.${conv}`, null); assert.equal(plan.projections.length, 1);
    const reference = plan.projections[0].reference.match(/ref=(".*")\)/)?.[1]; assert.ok(reference);
    const ref = JSON.parse(reference);
    let assembled = "", offset = 0;
    while (true) {
      const page = contextHost.contextRead(turn, ref, offset, 1000); const newline = page.indexOf("\n"); const chunk = page.slice(newline + 1); assembled += chunk; offset += chunk.length;
      if (chunk.length < 1000) break;
    }
    assert.equal(JSON.parse(assembled).result, full);
    assert.throws(() => contextHost.contextRead("other-turn", ref), /不属于当前会话|不存在/);
    assert.throws(() => contextHost.contextRead(turn, ref, -1), /分页/);
    context.close(); assert.throws(() => contextHost.contextRead(turn, ref), /权限/);
  } finally { context.close(); other.close(); }
});

test("task_state实际工具拒绝已结束和已取消轮次，不能在取消后更新约束", async () => {
  const session = new Session("chat", "控制台", "state-turn", "state-conv");
  const context = contextHost.createTurnContext(session.id, session.conv, [{ role: "user", content: "只读任务" }]);
  try {
    const updated = await callTool("task_state", { constraints: ["禁止写入"], openQuestions: ["来源是否一致"] }, "synthetic", { session });
    assert.equal(updated.status, "ok"); assert.deepEqual(context.snapshot().state.constraints, ["禁止写入"]);
    await router.chat(await context.prepare({ messages: [{ role: "user", content: "只读任务" }], maxTokens: 256, signal: session.beginLLM() }));
    session.endLLM(); assert.match(joined(seen.at(-1)), /禁止写入[\s\S]*来源是否一致/);
    session.abort(new Stopped());
    const cancelled = await callTool("task_state", { constraints: ["取消后不能覆盖"] }, "synthetic", { session });
    assert.equal(cancelled.status, "error"); assert.deepEqual(context.snapshot().state.constraints, ["禁止写入"]);
    const cancelledRead = await callTool("context_read", { ref: "missing" }, "synthetic", { session }); assert.equal(cancelledRead.status, "error");
    const finished = new Session("chat", "控制台", "finished-state-turn", "finished-state-conv");
    const finishedContext = contextHost.createTurnContext(finished.id, finished.conv, [{ role: "user", content: "已经结束的任务" }]);
    try {
      finishedContext.close(); const ended = await callTool("task_state", {}, "synthetic", { session: finished });
      assert.equal(ended.status, "error"); assert.match(ended.text, /没有任务工作状态/);
    } finally { finishedContext.close(); finished.close(); }
  } finally { context.close(); session.close(); }
});

test("真实摘要模型请求共享signal，summary取消后不调用主任务模型且不转成成功fallback", async () => {
  configure([{ id: "summary-only", context: 6000 }]); seen.length = 0;
  const controller = new AbortController();
  script = async (request) => {
    assert.ok(joined(request).startsWith("压缩历史资料"));
    controller.abort(new Error("cancel-summary-fixture"));
    return { content: "取消后摘要无效" };
  };
  const messages: Msg[] = [{ role: "system", content: "policy" }];
  for (let i = 0; i < 12; i++) messages.push({ role: "assistant", content: "history".repeat(300) });
  messages.push({ role: "user", content: "只读约束必须保留" });
  const context = contextHost.createTurnContext("cancel-summary-turn", "cancel-summary-conv", messages);
  try { await assert.rejects(router.chat(await context.prepare({ messages, maxTokens: 256, signal: controller.signal })), /cancel-summary-fixture/); assert.equal(seen.length, 1); }
  finally { context.close(); }
});

test("同call编号跨轮次重复后，原引用仍精确回查自己的完整工具记录", async () => {
  configure([{ id: "large", context: 131072 }]); script = async () => ({ content: "完成" });
  const turn = "duplicate-source-turn", conv = "duplicate-source-conv";
  const full = `ORIGINAL:${"原证据".repeat(5000)}:END`;
  store.saveToolCall({ call: "shared-call", session: turn, ts: 1, tool: "synthetic", args: {}, result: full, status: "ok", ms: 1 });
  const messages: Msg[] = [{ role: "user", content: "本轮证据" }, { role: "assistant", content: "", toolCalls: [{ id: "shared-call", name: "synthetic", args: {} }] }, { role: "tool", toolCallId: "shared-call", name: "synthetic", content: full.slice(0, 12000) }];
  const context = contextHost.createTurnContext(turn, conv, messages);
  try {
    await router.chat(await context.prepare({ messages, maxTokens: 256 }));
    const plan = store.kv.get<any>(`context.plan.${conv}`, null), ref = JSON.parse(plan.projections[0].reference.match(/ref=(".*")\)/)[1]);
    store.saveToolCall({ call: "shared-call", session: "unrelated-turn", ts: Date.now(), tool: "synthetic", args: {}, result: "OTHER-CONV-SECRET", status: "ok", ms: 1 });
    let text = "", offset = 0;
    for (;;) { const page = contextHost.contextRead(turn, ref, offset, 2000), chunk = page.slice(page.indexOf("\n") + 1); text += chunk; offset += chunk.length; if (chunk.length < 2000) break; }
    assert.equal(JSON.parse(text).result, full); assert.ok(!text.includes("OTHER-CONV-SECRET"));
  } finally { context.close(); }
});

test("task_state tags真实开启条件记忆；管理工具不读取或归档其他会话/用户的记录", async () => {
  configure([{ id: "large", context: 131072 }]); script = async () => ({ content: "完成" }); seen.length = 0;
  const session = new Session("chat", "控制台", "tags-turn", "tags-conv");
  const messages: Msg[] = [{ role: "user", content: "核对青松项目的发布证据" }];
  const context = contextHost.createTurnContext(session.id, session.conv, messages);
  async function record(id: string, scope: MemoryDraft["scope"], requiredTags: string[]) {
    const evidence: MemoryEvidence = { id: `${id}-evidence`, ref: `synthetic-host:${id}`, origin: "environment", observedAt: Date.now(), summary: `${id}独立测试来源`, verified: true };
    const candidate = await memory.recordMemory({ id, kind: "fact", text: `青松项目 ${id} 独立证据`, scope, conditions: { requiredTags, excludedTags: [], tools: [] }, stage: "any", zone: "golden", evidenceIds: [evidence.id] }, [evidence]);
    await memory.reviewMemory(`${candidate.id}@1`, { accepted: true, independent: true, evaluator: "trusted-fixture-review", score: 1, evidence: [evidence] });
  }
  try {
    await record("tagged-record", { agentId: identity().id, userId: "owner", sessionId: session.conv }, ["release-check"]);
    await record("other-conv-record", { agentId: identity().id, userId: "owner", sessionId: "other-conv" }, []);
    await record("other-user-record", { agentId: identity().id, userId: "different-owner" }, []);
    await router.chat(await context.prepare({ messages, maxTokens: 256 }));
    assert.ok(!store.kv.get<any>(`context.plan.${session.conv}`, null).selectedIds.includes("memory:tagged-record@1"));
    const patched = await callTool("task_state", { tags: ["release-check"] }, "fixture", { session }); assert.equal(patched.status, "ok");
    await router.chat(await context.prepare({ messages, maxTokens: 256 }));
    assert.ok(store.kv.get<any>(`context.plan.${session.conv}`, null).selectedIds.includes("memory:tagged-record@1"));
    const listed = await callTool("memory_records", {}, "fixture", { session }); assert.equal(listed.status, "ok");
    assert.ok(listed.text.includes("tagged-record@1")); assert.ok(!listed.text.includes("other-conv-record")); assert.ok(!listed.text.includes("other-user-record"));
    for (const key of ["other-conv-record@1", "other-user-record@1"]) {
      const denied = await callTool("memory_evolve", { operation: "archive", keys: [key] }, "fixture", { session });
      assert.equal(denied.status, "error"); assert.match(denied.text, /范围/);
      assert.equal(memory.readStructuredRecords().find((r) => `${r.id}@${r.version}` === key)?.state, "active");
    }
  } finally { context.close(); session.close(); }
});

test("历史压缩引用恢复1200字符附注之外的完整process和实际tool_records全文", async () => {
  configure([{ id: "large", context: 131072 }]); seen.length = 0;
  const mem = await import("../src/memory/memory.ts");
  const toolFull = `${"工具全文".repeat(5000)}FULL_TOOL_TAIL`;
  mem.saveNote("历史完整证据", toolFull);
  let step = 0;
  script = async () => ++step === 1 ? { content: `${"完整过程".repeat(700)}PROCESS_AFTER_1200`, tool_calls: [toolCall("note_read", { name: "历史完整证据" }, "historical-full-call")] } : { content: "历史任务完成" };
  const conv = "historical-process-conv";
  await brain.converse("你", "读取历史完整证据，只读", "控制台", { conv });
  const reply = store.sessionMessages(conv).findLast((message) => message.role === "agent"); assert.ok(reply);
  assert.ok(JSON.stringify(reply.process).includes("PROCESS_AFTER_1200"));
  const recovered = brain.history(conv, Number.MAX_SAFE_INTEGER);
  assert.ok(!recovered.some((message) => message.content.includes("PROCESS_AFTER_1200")), "历史视图只含短过程附注，后部必须通过来源回查");
  const messages: Msg[] = [{ role: "system", content: "只读政策" }, ...recovered];
  for (let i = 0; i < 12; i++) messages.push({ role: "assistant", content: "older-history".repeat(200) });
  messages.push({ role: "user", content: "新任务仍须保留用户约束" });
  const turn = "historical-recall-turn", context = contextHost.createTurnContext(turn, conv, messages);
  configure([{ id: "compact", context: 8000 }]); script = async (request) => joined(request).startsWith("压缩历史资料") ? { content: "较早资料需按原文回查。" } : { content: "准备完成" };
  try {
    await router.chat(await context.prepare({ messages, maxTokens: 256 }));
    const plan = store.kv.get<any>(`context.plan.${conv}`, null); assert.ok(plan.compactedIds.length > 0);
    const sourceId = plan.compactedIds.find((id: string) => {
      const source = store.readContextSource(`${turn}/${id}`, conv); if (!source) return false;
      return JSON.parse(source).messageRef?.id === reply.id;
    }); assert.ok(sourceId, "历史附注保留SQLite原消息指针，而非只保存短附注");
    let full = "", offset = 0;
    for (;;) { const page = contextHost.contextRead(turn, `${turn}/${sourceId}`, offset, 2000), chunk = page.slice(page.indexOf("\n") + 1); full += chunk; offset += chunk.length; if (chunk.length < 2000) break; }
    const parsed = JSON.parse(full);
    assert.ok(JSON.stringify(parsed.message.process).includes("PROCESS_AFTER_1200"));
    assert.ok(parsed.tools[0].result === mem.readNote("历史完整证据"), "回查工具结果需与实际note_read完整输出一致（含标题）"); assert.ok(parsed.tools[0].result.includes("FULL_TOOL_TAIL"));
  } finally { context.close(); }
});
