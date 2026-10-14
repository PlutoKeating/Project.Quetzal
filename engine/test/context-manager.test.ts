import test from "node:test";
import assert from "node:assert/strict";
import { ContextManager, ContextOverflow, withModelPreparation, type ContextInput, type ContextPlan, type TaskWorkingState } from "../src/context-manager.ts";
import { runTurn, type EnginePorts, type TurnControl, type TurnEvent } from "../src/loop.ts";
import type { Msg } from "../src/types.ts";

const state: TaskWorkingState = { goal: "完成调研", constraints: ["只能读取", "不得发消息或更改文件"], openQuestions: ["结论是否有证据"], evidence: [{ id: "e1", claim: "尚未验证", source: "source-1" }] };
const options = { reference: (id: string) => `原文:${id}`, summarize: async () => "已经读取旧资料；具体结论应按引用核验。" };
function history(): Msg[] {
  const messages: Msg[] = [{ role: "system", content: "绝不泄露凭据" }, { role: "user", content: "旧会话问题" }];
  for (let i = 0; i < 12; i++) messages.push({ role: "assistant", content: `较早回答 ${i} ` + "a".repeat(1400) });
  messages.push({ role: "user", content: "当前问题：只读调研，禁止发布" });
  return messages;
}
function input(messages = history()): ContextInput { return { messages, contextWindow: 8000, maxOutputTokens: 200, protectedFrom: messages.length - 1, state }; }
function assertPairs(messages: Msg[]) {
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (message.role === "assistant" && message.toolCalls?.length) {
      const expected = new Set(message.toolCalls.map((call) => call.id));
      while (messages[i + 1]?.role === "tool") { const result = messages[++i]; if (result.role === "tool") assert.ok(expected.delete(result.toolCallId)); }
      assert.equal(expected.size, 0);
    } else assert.notEqual(message.role, "tool");
  }
}

test("动态窗口view保留系统/当前用户约束和工作状态，原消息不删，摘要稳定独立slot且可缓存", async () => {
  let summaries = 0;
  const manager = new ContextManager({ ...options, summarize: async () => { summaries++; return "旧资料已读取，需要核查原文。"; } });
  const request = input(), original = structuredClone(request.messages);
  const plan = await manager.prepare(request);
  assert.ok(plan.estimate.totalTokens <= request.contextWindow); assert.equal(plan.estimate.method, "conservative-estimate");
  assert.ok(plan.messages.some((m) => m.role === "system" && m.content === "绝不泄露凭据"));
  assert.ok(plan.messages.some((m) => m.content === "当前问题：只读调研，禁止发布"));
  assert.ok(plan.messages.some((m) => m.content.includes("不得发消息或更改文件")));
  assert.ok(plan.summary); assert.equal(plan.summary.id, "context:summary"); assert.ok(plan.compactedIds.length > 0);
  assert.deepEqual(request.messages, original); assert.ok(manager.source(plan.compactedIds[0]));
  const initialCalls = summaries;
  const repeated = await manager.prepare(request); assert.equal(repeated.summary?.cached, true); assert.equal(summaries, initialCalls);
});

test("具体候选/小窗口fallback重新从完整历史准备，覆盖工具schema、输出预留与图片估计", async () => {
  const manager = new ContextManager(options), full = history();
  const large = await manager.prepare({ ...input(full), contextWindow: 30000 });
  const request = withModelPreparation({ messages: large.messages, maxTokens: 200 }, (limits) => manager.prepare({ ...input(full), ...limits }));
  const small = await request.prepareForModel!({ contextWindow: 7000, maxOutputTokens: 100, model: "small" });
  assert.ok(small.messages.length < large.messages.length); assert.equal(small.maxTokens, 100);
  assert.ok(small.messages.some((m) => m.content === "当前问题：只读调研，禁止发布"));
  assert.equal(full.length, 15);
  const pictured: Msg[] = [{ role: "system", content: "policy" }, { role: "user", content: "看图", images: [{ mime: "image/png", data: "AAAA" }] }];
  const plan = await manager.prepare({ messages: pictured, tools: [{ name: "tool", description: "schema", parameters: { type: "object" } }], contextWindow: 10000, maxOutputTokens: 100 });
  assert.ok(plan.estimate.imageTokens >= 4096); assert.ok(plan.estimate.toolsTokens > 0); assert.equal(plan.estimate.outputTokens, 100);
});

test("工具响应作为完整组压缩/选择，极长结果保留call配对和真实引用投影", async () => {
  const messages: Msg[] = [{ role: "system", content: "policy" }, { role: "user", content: "目标" }];
  for (let i = 0; i < 10; i++) {
    messages.push({ role: "assistant", content: "", toolCalls: [{ id: `call-${i}`, name: "search", args: { i } }, { id: `other-${i}`, name: "read", args: {} }] });
    messages.push({ role: "tool", toolCallId: `call-${i}`, name: "search", content: "长证据".repeat(4000) });
    messages.push({ role: "tool", toolCallId: `other-${i}`, name: "read", content: "补充" });
  }
  const manager = new ContextManager(options), original = structuredClone(messages);
  const plan = await manager.prepare({ messages, contextWindow: 7000, maxOutputTokens: 100 });
  assertPairs(plan.messages); assert.ok(plan.projections.length > 0); assert.ok(plan.messages.some((m) => m.role === "tool" && m.content.includes("原文回查")));
  assert.deepEqual(messages, original);
  const projected = plan.projections[0]; assert.ok(manager.source(projected.id)?.content.length! > 10000);
});

test("未resolved同响应组全部固定，不能为塞入窗口拆掉同组已返回结果", async () => {
  const messages: Msg[] = [{ role: "system", content: "policy" }, { role: "user", content: "目标" }, { role: "assistant", content: "", toolCalls: [{ id: "a", name: "a", args: {} }, { id: "b", name: "b", args: {} }] }, { role: "tool", toolCallId: "a", name: "a", content: "已返回" }, { role: "user", content: "最新输入" }];
  const plan = await new ContextManager(options).prepare({ messages, contextWindow: 5000, maxOutputTokens: 100 });
  const assistant = plan.messages.find((m) => m.role === "assistant"); assert.ok(assistant?.role === "assistant"); assert.equal(assistant.toolCalls?.length, 2);
  assert.ok(plan.messages.some((m) => m.role === "tool" && m.toolCallId === "a"));
});

test("summary失败仅有完整引用时有限安全降级，没有引用则overflow；schema/pinned不能放下时不截政策", async () => {
  const failing = new ContextManager({ reference: options.reference, summarize: async () => { throw new Error("summary unavailable"); } });
  const plan = await failing.prepare(input()); assert.equal(plan.summary?.fallback, true); assert.ok(plan.summary?.text.includes("不能据此推断事实")); assert.ok(plan.estimate.totalTokens <= 8000);
  await assert.rejects(new ContextManager({ summarize: async () => { throw new Error("失败"); } }).prepare(input()), ContextOverflow);
  await assert.rejects(new ContextManager(options).prepare({ messages: [{ role: "system", content: "policy".repeat(1000) }, { role: "user", content: "请求" }], contextWindow: 1000, maxOutputTokens: 200 }), ContextOverflow);
  await assert.rejects(new ContextManager(options).prepare({ messages: [{ role: "user", content: "请求" }], tools: [{ name: "schema", description: "描述".repeat(2000), parameters: {} }], contextWindow: 1000, maxOutputTokens: 100 }), ContextOverflow);
});

test("工作状态不从最近字符伪造事实，动态记忆按完整条目预算选择", async () => {
  const manager = new ContextManager(), messages: Msg[] = [{ role: "user", content: "事实尚待确认" }];
  const plan = await manager.prepare({ messages, contextWindow: 3000, maxOutputTokens: 100, memory: [{ id: "relevant", text: "已确认事实", priority: 10 }, { id: "huge", text: "x".repeat(5000) }] });
  assert.ok(!plan.selectedIds.includes("context:working-state")); assert.ok(plan.selectedIds.includes("memory:relevant")); assert.deepEqual(plan.skippedMemoryIds, ["huge"]);
});

class Turn implements TurnControl {
  id = "long-loop"; stepText = ""; controller = new AbortController(); events: TurnEvent[] = [];
  get signal() { return this.controller.signal; }
  check() { this.signal.throwIfAborted(); } touch() {} emit(event: TurnEvent) { this.events.push(event); }
  beginLLM() { return this.signal; } endLLM() {} delta(text: string) { this.stepText += text; } flush() {}
  async hold<T>(work: () => Promise<T>) { return work(); }
}
function ports(): EnginePorts { return { async chat() { return { text: "完成", toolCalls: [], usage: { input: 1, output: 1 }, model: "mock" }; }, async execute() { return { text: "", status: "ok" }; }, async drain() {}, pending: () => false, incoming: () => false, check() {}, interrupted: () => false, stopToolWait: () => true, moved: () => undefined, cleanText: (text) => text, redactArgs: (args) => args, summarize: () => "tool", recordTool() {}, warning() {} }; }

test("真实长工具循环每步prepare，原messages持续增长但实际请求都在预算内且保留成对工具", async () => {
  const manager = new ContextManager(options), messages: Msg[] = [{ role: "system", content: "只读" }, { role: "user", content: "完成长调研，不更改任何文件" }], turn = new Turn(), p = ports();
  const plans: ContextPlan[] = []; let calls = 0;
  p.prepareContext = async (request) => { const plan = await manager.prepare({ messages: request.messages, tools: request.tools, contextWindow: 7000, maxOutputTokens: request.maxTokens!, state, signal: request.signal }); plans.push(plan); return { ...request, messages: plan.messages }; };
  p.execute = async () => ({ text: "工具事实证据".repeat(2000), status: "ok" });
  p.chat = async (request) => {
    assertPairs(request.messages); assert.equal(request.signal, turn.signal);
    return ++calls <= 20 ? { text: "读资料", toolCalls: [{ id: `call-${calls}`, name: "search", args: {} }], usage: { input: 1, output: 1 }, model: "mock" } : { text: "完成", toolCalls: [], usage: { input: 1, output: 1 }, model: "mock" };
  };
  const result = await runTurn({ messages, turn, tools: [{ name: "search", description: "检索", parameters: {} }], maxOutputTokens: 100 }, p);
  assert.equal(result.text, "完成"); assert.equal(plans.length, 21); assert.ok(plans.every((plan) => plan.estimate.totalTokens <= 7000)); assert.ok(plans.some((plan) => plan.summary));
  assert.equal(messages.length, 43); assert.ok(messages.some((m) => m.role === "tool" && m.content.length >= 10000));
});

test("prepare传递同轮信号，summary取消不转成引用fallback也不调用主模型", async () => {
  const turn = new Turn(), p = ports(), messages = history(); let called = false;
  const manager = new ContextManager({ reference: options.reference, summarize: async ({ signal }) => { assert.equal(signal, turn.signal); turn.controller.abort(new Error("取消")); return "摘要"; } });
  p.prepareContext = async (request) => ({ ...request, messages: (await manager.prepare({ ...input(messages), signal: request.signal })).messages });
  p.chat = async () => { called = true; throw new Error("不应调用"); };
  await assert.rejects(runTurn({ messages, turn, tools: [], maxOutputTokens: 100 }, p), /取消/); assert.equal(called, false);
});

test("摘要分块调用有硬上限，仍有完整原文引用时安全降级；最新用户超长明确overflow", async () => {
  let calls = 0;
  const manager = new ContextManager({ reference: options.reference, summaryTokens: 256, summaryInputTokens: 2000, maxSummaryChunks: 2, summarize: async ({ entries, maxTokens }) => {
    calls++; assert.ok(entries.reduce((n, entry) => n + entry.message.content.length, 0) + maxTokens <= 2000); return "旧资料须回查";
  } });
  const plan = await manager.prepare({ ...input(), contextWindow: 5000 });
  assert.ok(calls <= 2); assert.equal(plan.summary?.fallback, true);
  await assert.rejects(manager.prepare({ messages: [{ role: "user", content: "用户硬约束".repeat(5000) }], contextWindow: 5000, maxOutputTokens: 100 }), ContextOverflow);
  assert.throws(() => new ContextManager({ summaryInputTokens: Infinity }), /正整数/);
});

test("摘要服务不处理signal时，取消仍及时终止prepare，不继续主模型", async () => {
  const controller = new AbortController();
  const manager = new ContextManager({ reference: options.reference, summarize: async () => { queueMicrotask(() => controller.abort(new Error("摘要取消"))); return new Promise(() => {}); } });
  await assert.rejects(manager.prepare({ ...input(), signal: controller.signal }), /摘要取消/);
});
