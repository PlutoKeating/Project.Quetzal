import test from "node:test";
import assert from "node:assert/strict";
import { runTurn, type EnginePorts, type TurnControl, type TurnEvent, type ChatResult, type ToolCall, type Msg, type ToolRecord } from "../src/index.ts";

class TestTurn implements TurnControl {
  id = "isolated";
  controller = new AbortController();
  stepText = "";
  events: TurnEvent[] = [];
  get signal() { return this.controller.signal; }
  check() { if (this.signal.aborted) throw this.signal.reason; }
  touch() {}
  emit(event: TurnEvent) { this.events.push(event); }
  beginLLM() { this.stepText = ""; return this.signal; }
  endLLM() {}
  delta(text: string) { this.stepText += text; }
  flush() {}
  async hold<T>(work: () => Promise<T>) { return work(); }
}
const call = (name: string, id = name): ToolCall => ({ id, name, args: { query: "秘密" } });
const answer = (text: string, toolCalls: ToolCall[] = []): ChatResult => ({ text, toolCalls, usage: { input: 2, output: 3 }, model: "fake/model" });
function fixture(replies: ChatResult[]) {
  const turn = new TestTurn(), messages: Msg[] = [{ role: "user", content: "开始" }], records: ToolRecord[] = [];
  let requests = 0;
  const ports: EnginePorts = {
    async chat() { requests++; const reply = replies.shift(); assert.ok(reply, "不应发出额外模型请求"); return reply; },
    async execute() { return { text: "结果", status: "ok" }; },
    async drain() {}, pending: () => false, incoming: () => false, check() {},
    interrupted: () => false, stopToolWait: () => false, moved: () => undefined,
    cleanText: (text) => text, redactArgs: () => ({ query: "已脱敏" }), summarize: () => "摘要",
    recordTool: (record) => { records.push(record); }, warning() {},
  };
  const options = { messages, turn, tools: [{ name: "search", description: "搜索", parameters: {} }], maxOutputTokens: 100 };
  return { turn, messages, records, ports, options, requests: () => requests };
}

test("独立引擎执行模型和工具，保存完整脱敏轨迹，只取最终文字", async () => {
  const f = fixture([answer("过程", [call("search")]), answer("完成")]);
  const result = await runTurn(f.options, f.ports);
  assert.equal(result.text, "完成"); assert.equal(result.tokens, 10); assert.equal(result.model, "fake/model");
  assert.equal(result.steps.length, 1); assert.deepEqual(f.records[0].args, { query: "已脱敏" });
  assert.deepEqual(f.turn.events.map((e) => e.kind), ["step", "text", "tool", "tool", "step", "text"]);
  assert.equal(f.messages[2].role, "tool");
});

test("同响应工具串行执行，finish 不经工具端口，同响应后续工具仍执行", async () => {
  const done = { id: "end", name: "finish", args: { title: "结束", journal: "报告" } };
  const f = fixture([answer("", [call("a"), done, call("b")])]);
  const order: string[] = [];
  f.ports.execute = async (c) => { order.push(c.name); await Promise.resolve(); return { text: c.name, status: "ok" }; };
  const result = await runTurn({ ...f.options, finishTool: { name: "finish", description: "结束", parameters: {} } }, f.ports);
  assert.deepEqual(order, ["a", "b"]); assert.deepEqual(result.finish, done.args); assert.equal(f.requests(), 1);
});

test("失败和 denied 注入错误标志与重复提醒，保留完整记录并裁剪模型结果", async () => {
  const f = fixture([answer("", [call("search", "a"), call("search", "b")]), answer("结束")]);
  f.ports.execute = async () => ({ text: "x".repeat(13000), status: "denied" });
  await runTurn(f.options, f.ports);
  const results = f.messages.filter((m) => m.role === "tool");
  assert.equal(results.length, 2); assert.ok(results.every((m) => m.error));
  assert.match(results[1].content, /失败了 2 次/); assert.equal(f.records[0].result.length, 13000);
  assert.ok(results[0].content.length < 13000);
});

test("空回复仅提醒两次；图片待处理不改变原有空回复重试条件", async () => {
  const f = fixture([answer(""), answer(""), answer("")]);
  let pendingImages = true;
  f.ports.pending = () => pendingImages;
  f.ports.chat = async () => { if (f.messages.length >= 3) pendingImages = false; return answer(""); };
  await runTurn(f.options, f.ports);
  assert.equal(f.turn.events.filter((e) => e.kind === "step").length, 3);
  assert.equal(f.messages.filter((m) => m.content.includes("基座提醒")).length, 2);
});

test("终止响应同时收到新输入或图片时继续，drain 由宿主补入上下文", async () => {
  const f = fixture([answer("旧回复"), answer("新回复")]);
  let pending = false, calls = 0;
  f.ports.chat = async () => { pending = ++calls === 1; return answer(calls === 1 ? "旧回复" : "新回复"); };
  f.ports.pending = () => pending;
  f.ports.drain = async (messages) => { if (pending) { messages.push({ role: "user", content: "补充", images: [{ mime: "image/png", data: "image" }] }); pending = false; } };
  const result = await runTurn(f.options, f.ports);
  assert.equal(result.text, "新回复"); assert.ok(f.messages.some((m) => m.role === "user" && m.images?.length));
});

test("interrupt 保留部分输出，不算整轮停止", async () => {
  const f = fixture([]), interrupted = new Error("打断"); let calls = 0;
  f.ports.interrupted = (e) => e === interrupted;
  f.ports.chat = async (request) => { if (++calls === 1) { request.onText?.("部分文字"); throw interrupted; } return answer("继续完成"); };
  const result = await runTurn(f.options, f.ports);
  assert.equal(result.text, "继续完成"); assert.ok(f.messages.some((m) => m.content.includes("部分文字\n（输出被对方打断）")));
});

test("普通停止结束工具等待，不要求未完成工具返回", async () => {
  const f = fixture([answer("", [call("search")])]), stopped = new Error("停止");
  f.ports.stopToolWait = (e) => e === stopped;
  f.ports.execute = async () => { queueMicrotask(() => f.turn.controller.abort(stopped)); return new Promise(() => {}); };
  await assert.rejects(runTurn(f.options, f.ports), (e) => e === stopped);
  assert.equal(f.records.length, 0);
});

test("未分类为普通停止的取消保持原语义：等当前工具结束，再终止下一步", async () => {
  const f = fixture([answer("", [call("search")])]), stopped = new Error("子 agent 停止");
  let completed = false;
  f.ports.execute = async () => {
    queueMicrotask(() => f.turn.controller.abort(stopped));
    await new Promise((resolve) => setTimeout(resolve, 5));
    completed = true; return { text: "已结束", status: "ok" };
  };
  await assert.rejects(runTurn(f.options, f.ports), (e) => e === stopped);
  assert.ok(completed); assert.equal(f.records.length, 1);
});

test("mesh 交接结束本地循环，并在 finish 路径补交接报告", async () => {
  const f = fixture([answer("", [call("move_to")])]);
  f.ports.moved = () => ({ title: "换身体", journal: "交接" });
  const result = await runTurn({ ...f.options, finishTool: { name: "finish", description: "结束", parameters: {} } }, f.ports);
  assert.deepEqual(result.finish, { title: "换身体", journal: "交接" }); assert.equal(f.requests(), 1);
});

test("记录失败只警告，不使已经成功的工具失败；外部 STOP 在模型请求前生效", async () => {
  const f = fixture([answer("", [call("search")]), answer("完成")]); let warnings = 0;
  f.ports.recordTool = () => { throw new Error("不能保存"); }; f.ports.warning = () => { warnings++; };
  assert.equal((await runTurn(f.options, f.ports)).text, "完成"); assert.equal(warnings, 1);
  const blocked = fixture([]); blocked.ports.check = () => { throw new Error("急停"); };
  await assert.rejects(runTurn(blocked.options, blocked.ports), /急停/); assert.equal(blocked.requests(), 0);
});

test("工具定义入口快照，输出上限可每步读取宿主最新配置", async () => {
  const f = fixture([]); let limit = 100, calls = 0;
  const limits: number[] = [], toolCounts: number[] = [];
  f.ports.chat = async (request) => {
    limits.push(request.maxTokens!); toolCounts.push(request.tools!.length);
    return ++calls === 1 ? answer("", [call("search")]) : answer("完成");
  };
  f.ports.execute = async () => {
    limit = 200; f.options.tools.push({ name: "new", description: "新增", parameters: {} });
    return { text: "结果", status: "ok" };
  };
  await runTurn({ ...f.options, maxOutputTokens: () => limit }, f.ports);
  assert.deepEqual(limits, [100, 200]); assert.deepEqual(toolCounts, [1, 1]);
});

test("并行两轮分别维护上下文、失败计数与输出，不共享内部状态", async () => {
  const a = fixture([answer("A过程", [call("search", "a1"), call("search", "a2")]), answer("A完成")]);
  const b = fixture([answer("B过程", [call("search", "b1")]), answer("B完成")]);
  a.options.messages[0].content = "任务A"; b.options.messages[0].content = "任务B";
  let arrivals = 0;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  for (const f of [a, b]) {
    const chat = f.ports.chat;
    f.ports.chat = async (request) => {
      if (f.requests() === 0) { if (++arrivals === 2) release(); await barrier; }
      return chat(request);
    };
    f.ports.execute = async () => { await Promise.resolve(); return { text: "失败", status: "error" }; };
  }
  const [ra, rb] = await Promise.all([runTurn(a.options, a.ports), runTurn(b.options, b.ports)]);
  assert.equal(ra.text, "A完成"); assert.equal(rb.text, "B完成");
  assert.equal(ra.steps.length, 2); assert.equal(rb.steps.length, 1);
  const failuresA = a.messages.filter((m) => m.role === "tool");
  const failuresB = b.messages.filter((m) => m.role === "tool");
  assert.match(failuresA[1].content, /失败了 2 次/); assert.doesNotMatch(failuresB[0].content, /失败了 2 次/);
  assert.ok(a.messages.every((m) => !m.content.includes("B"))); assert.ok(b.messages.every((m) => !m.content.includes("A")));
});

test("JS 宿主配置其他结束工具名称时早报错，未提供 schema 的 finish 保留兼容识别", async () => {
  const invalid = fixture([]);
  Reflect.set(invalid.options, "finishTool", { name: "done", description: "结束", parameters: {} });
  await assert.rejects(runTurn(invalid.options, invalid.ports), /名称必须为 finish/); assert.equal(invalid.requests(), 0);
  const legacy = fixture([answer("", [{ id: "done", name: "finish", args: { title: "完成" } }])]);
  legacy.ports.execute = async () => { throw new Error("finish 不应进普通工具"); };
  assert.deepEqual((await runTurn(legacy.options, legacy.ports)).finish, { title: "完成" });
});
