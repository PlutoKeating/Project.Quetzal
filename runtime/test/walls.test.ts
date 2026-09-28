// 时间墙：模型流式调用的解析与中止；会话时间墙按「无进展」计时，工具执行期间暂停。
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { adapters, type Target } from "../src/providers/adapters.ts";
import { Session, SESSION_IDLE_MS, SessionTimeout, summarize } from "../src/mind/activity.ts";
import { bus, type Activity } from "../src/bus.ts";

/** 起一个本地 SSE 服务：按顺序、间隔 gap 毫秒发出 events；stall 为 true 时发完不结束。 */
async function server(events: string[], opts: { gap?: number; stall?: boolean; json?: unknown } = {}) {
  const s = http.createServer(async (_req, res) => {
    if (opts.json) { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify(opts.json)); }
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const e of events) { res.write(e); await new Promise((r) => setTimeout(r, opts.gap ?? 5)); }
    if (!opts.stall) res.end();
  });
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const t = (protocol: Target["protocol"]): Target => ({ protocol, baseUrl: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, apiKey: "k", model: "m", maxTokens: 100 });
  return { t, close: () => { s.closeAllConnections(); s.close(); } };
}
const data = (j: unknown, event = "") => `${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(j)}\n\n`;

test("Chat Completions 流：拼接文字与分片的工具参数，逐块回调", async () => {
  const srv = await server([
    data({ choices: [{ delta: { content: "你" } }] }),
    data({ choices: [{ delta: { content: "好" } }] }),
    data({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "shell", arguments: '{"comm' } }] } }] }),
    data({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'and":"ls"}' } }] } }] }),
    data({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 3 } }),
    "data: [DONE]\n\n",
  ]);
  const texts: string[] = []; let chunks = 0;
  const r = await adapters["openai-completions"](srv.t("openai-completions"), { messages: [{ role: "user", content: "hi" }], onText: (x) => texts.push(x), onChunk: () => chunks++ });
  srv.close();
  assert.equal(r.text, "你好");
  assert.deepEqual(texts, ["你", "好"]);
  assert.ok(chunks >= 1);
  assert.deepEqual(r.toolCalls, [{ id: "c1", name: "shell", args: { command: "ls" } }]);
  assert.deepEqual(r.usage, { input: 7, output: 3 });
});

test("Anthropic Messages 流：文字块与工具块", async () => {
  const srv = await server([
    data({ type: "message_start", message: { usage: { input_tokens: 5 } } }, "message_start"),
    data({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    data({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "看看" } }),
    data({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "t1", name: "recall", input: {} } }),
    data({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"query":"猫"}' } }),
    data({ type: "message_delta", usage: { output_tokens: 4 } }),
  ]);
  const r = await adapters["anthropic-messages"](srv.t("anthropic-messages"), { messages: [{ role: "user", content: "hi" }] });
  srv.close();
  assert.equal(r.text, "看看");
  assert.deepEqual(r.toolCalls, [{ id: "t1", name: "recall", args: { query: "猫" } }]);
  assert.deepEqual(r.usage, { input: 5, output: 4 });
});

test("供应商不支持流式、直接返回 JSON 时按非流式解析", async () => {
  const srv = await server([], { json: { choices: [{ message: { content: "OK" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } } });
  const r = await adapters["openai-completions"](srv.t("openai-completions"), { messages: [{ role: "user", content: "hi" }] });
  srv.close();
  assert.equal(r.text, "OK");
});

test("会话中止会立即打断正在进行的流，且不再重试", async () => {
  const srv = await server([data({ choices: [{ delta: { content: "…" } }] })], { stall: true });
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 50);
  await assert.rejects(adapters["openai-completions"](srv.t("openai-completions"), { messages: [{ role: "user", content: "hi" }], signal: ac.signal }),
    (e: any) => e.message === "会话已中止" && e.immediate === true);
  srv.close();
});

test("会话时间墙：有进展就重置，无进展满时长才中止", () => {
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  try {
    const s = new Session("chat");
    mock.timers.tick(SESSION_IDLE_MS - 1000); s.touch();
    mock.timers.tick(SESSION_IDLE_MS - 1000);
    assert.equal(s.signal.aborted, false);
    mock.timers.tick(1000);
    assert.equal(s.signal.aborted, true);
    assert.ok(s.signal.reason instanceof SessionTimeout);
    s.close();
  } finally { mock.timers.reset(); }
});

test("会话时间墙：工具执行期间暂停，结束后重新计时", async () => {
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  try {
    const s = new Session("chat");
    let finish!: () => void;
    const held = s.hold(() => new Promise<void>((r) => (finish = r)));
    mock.timers.tick(SESSION_IDLE_MS * 5);
    assert.equal(s.signal.aborted, false);
    finish(); await held;
    mock.timers.tick(SESSION_IDLE_MS - 1);
    assert.equal(s.signal.aborted, false);
    mock.timers.tick(1);
    assert.equal(s.signal.aborted, true);
    s.close();
  } finally { mock.timers.reset(); }
});

test("会话心跳与流式文字合并广播", () => {
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const got: Activity[] = [];
  const on = (a: Activity) => got.push(a);
  bus.on("activity", on);
  try {
    const s = new Session("chat", "控制台", "abc");
    s.delta("你"); s.delta("好");
    mock.timers.tick(200);
    mock.timers.tick(15_000);
    s.close();
    assert.deepEqual(got.map((a) => [a.session, a.kind, a.text]), [["abc", "delta", "你好"], ["abc", "alive", undefined]]);
  } finally { bus.off("activity", on); mock.timers.reset(); }
});

test("工具摘要取主参数并截断为一行", () => {
  assert.equal(summarize({ command: "ls\n  -la" }), "ls -la");
  assert.equal(summarize({ x: 1, note: "嗨" }), "嗨");
  assert.equal(summarize({}), "");
  assert.equal(summarize({ query: "a".repeat(200) }).length, 101);
});
