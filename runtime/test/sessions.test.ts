// 会话：多个会话并行且彼此可见；进行中的轮次有快照；图片只发给能看图的模型。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

process.env.QUETZAL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "quetzal-sessions-"));
const { loadConfig } = await import("../src/config.ts");
loadConfig();
const store = await import("../src/store.ts");
store.openStore();
const reg = await import("../src/providers/registry.ts");
const router = await import("../src/providers/router.ts");
const { Session, liveTurns } = await import("../src/mind/activity.ts");
const { converse } = await import("../src/mind/brain.ts");

// 模拟供应商：记录每次请求；回复慢一点，让两个会话真正重叠
const seen: any[] = [];
let script: ((j: any) => any) | undefined; // 设置时由它决定回复（choices[0]），否则回声
const server = http.createServer((req, res) => {
  let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
    const j = JSON.parse(body); seen.push(j);
    const user = j.messages.at(-1);
    const text = typeof user.content === "string" ? user.content : user.content.find((c: any) => c.type === "text").text;
    setTimeout(() => {
      res.writeHead(200, { "content-type": "application/json" });
      const choice = script?.(j) ?? { message: { content: `收到：${text.match(/对你说：\n(.*)/)?.[1] ?? "?"}` } };
      res.end(JSON.stringify({ choices: [choice], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    }, script ? 0 : 300);
  });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as any).port}`;
const provider = (models: any[]) => reg.saveProviders({ providers: [{ id: "p", catalogId: "custom", name: "Mock", baseUrl: base, protocol: "openai-completions" as const, enabled: true,
  keys: [{ id: "k", label: "k", lastFour: "", enabled: true, secret: "sk-mock-000000" }], models }] }, reg.configVersion());

test("会话表：创建、归档与找回、按会话取消息", () => {
  const s = store.ensureSession("s1", "新的对话");
  assert.equal(s.title, "新的对话");
  store.addMessage("user", "控制台", "你好", { session: "s1" });
  store.updateSession("s1", { archived: true });
  assert.ok(!store.listSessions().some((x) => x.id === "s1"));
  assert.ok(store.listSessions({ archived: true }).some((x) => x.id === "s1"));
  store.addMessage("agent", "控制台", "在呢", { session: "s1", process: [{ type: "tool", name: "shell" }] }); // 新消息让会话自动回到列表
  const back = store.listSessions().find((x) => x.id === "s1")!;
  assert.equal(back.count, 2);
  assert.equal(back.last, "在呢");
  const msgs = store.sessionMessages("s1");
  assert.deepEqual(msgs.map((m) => m.text), ["你好", "在呢"]);
  assert.deepEqual(msgs[1].process, [{ type: "tool", name: "shell" }]);
});

test("进行中的轮次：进展折叠成快照，结束后移除", () => {
  const s = new Session("chat", "控制台", "turn-1", "conv-1");
  s.emit({ kind: "start", text: "帮我查点东西" });
  s.emit({ kind: "step", step: 1 });
  s.emit({ kind: "text", step: 1, text: "我先看看", final: false });
  s.emit({ kind: "tool", call: "c1", name: "shell", summary: "ls", status: "running" });
  s.emit({ kind: "tool", call: "c1", name: "shell", summary: "ls", status: "ok", ms: 12 });
  s.emit({ kind: "delta", text: "找到了" });
  const t = liveTurns().find((x) => x.turn === "turn-1")!;
  assert.equal(t.conv, "conv-1");
  assert.equal(t.step, 1);
  assert.equal(t.live, "找到了");
  assert.deepEqual(t.items.map((x) => [x.type, x.status ?? x.text]), [["text", "我先看看"], ["tool", "ok"]]);
  assert.deepEqual(s.process(), t.items);
  s.close();
  assert.ok(!liveTurns().some((x) => x.turn === "turn-1"));
});

test("多个会话并行，且每个会话都能看到其他会话", async () => {
  provider([{ id: "m", name: "plain", enabled: true, context: 8000, maxTokens: 256, sortOrder: 0 }]);
  store.ensureSession("a", "新的对话"); store.ensureSession("b", "新的对话");
  store.addMessage("user", "控制台", "上周聊过的咖啡豆", { session: "b" });
  seen.length = 0;
  const t0 = Date.now();
  const [ra, rb] = await Promise.all([converse("你", "会话甲的问题", "控制台", { conv: "a" }), converse("你", "会话乙的问题", "控制台", { conv: "b" })]);
  if (process.platform !== "win32") assert.ok(Date.now() - t0 < 1500, "两个会话应当并行"); // Windows runner 上每轮的 git 与进程启动慢，计时不可比；并行逻辑与平台无关
  assert.equal(ra, "收到：会话甲的问题");
  assert.equal(rb, "收到：会话乙的问题");
  assert.deepEqual(store.sessionMessages("a").map((m) => m.role), ["user", "agent"]);
  assert.equal(store.getSession("a")!.title, "会话甲的问题"); // 首条消息自动成为标题
  const sysA = seen.find((j) => JSON.stringify(j.messages.at(-1)).includes("会话甲"))!.messages[0].content;
  assert.match(sysA, /其他会话/);
  assert.match(sysA, /咖啡豆/); // 看得到另一个会话的历史
  assert.match(sysA, /【进行中】会话「[^」]*」：对方说「会话乙的问题」/); // 也看得到另一个会话此刻正在进行
  // 会话自己的历史作为多轮上下文
  seen.length = 0;
  await converse("你", "接着说", "控制台", { conv: "a" });
  const ctx = seen[0].messages.map((m: any) => m.role);
  assert.deepEqual(ctx.slice(1), ["user", "user", "assistant", "user"]); // 她的回复前有一条基座附注（user 一侧）
});

test("同一会话内按顺序处理", async () => {
  seen.length = 0;
  const order: string[] = [];
  await Promise.all([1, 2, 3].map((i) => converse("你", `第${i}句`, "控制台", { conv: "a" }).then(() => order.push(`第${i}句`))));
  assert.deepEqual(order, ["第1句", "第2句", "第3句"]);
});

const lastUser = (j: any) => { const m = j.messages.filter((x: any) => x.role === "user").at(-1); return typeof m.content === "string" ? m.content : m.content[0].text; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("工作中发消息：默认插话，在这次模型调用后并入", async () => {
  seen.length = 0;
  store.ensureSession("st", "插话");
  const main = converse("你", "帮我查一下天气", "控制台", { conv: "st" });
  await sleep(100);
  assert.match(await converse("你", "顺便看看明天", "控制台", { conv: "st" }), /已送达/);
  await main;
  assert.equal(seen.length, 2); // 第一次调用结束后，带着补充的消息再调用一次（即使第一次本想结束）
  assert.match(lastUser(seen[1]), /补充了新消息：\n顺便看看明天/);
  assert.deepEqual(store.sessionMessages("st").map((m) => [m.role, m.mode]), [["user", null], ["user", "steer"], ["agent", null]]);
  const proc = store.sessionMessages("st")[2].process as any[];
  assert.equal(proc[0].type, "steer"); // 插话标记（插话到达的那一刻）：前端据此把之前的过程截断在插话消息上方
  assert.equal(proc[0].text, "顺便看看明天");
  assert.equal(proc[0].msg, store.sessionMessages("st")[1].id);
  assert.deepEqual(proc[1], { type: "text", text: "收到：帮我查一下天气" }); // 插话之后才完成的那段回复，留在过程里、显示在插话下方
  assert.ok(!liveTurns().some((t) => t.conv === "st")); // 结束后快照已移除
});

test("工作中发消息：打断只中止模型输出，立即带着新消息继续", async () => {
  seen.length = 0;
  store.ensureSession("it", "打断");
  const t0 = Date.now();
  const main = converse("你", "写一篇长文", "控制台", { conv: "it" });
  await sleep(100);
  assert.match(await converse("你", "停，先回答我", "控制台", { conv: "it", mode: "interrupt" }), /已打断/);
  await main;
  assert.ok(Date.now() - t0 < (process.platform === "win32" ? 1500 : 550), "第一次调用应被中止，而不是等它完成"); // Windows runner 的计时器粒度粗、启动慢 // 300ms 的第一次调用被打断 + 300ms 的第二次
  assert.equal(seen.length, 2);
  assert.match(lastUser(seen[1]), /打断了你：\n停，先回答我/);
});

test("工作中发消息：排队则作为下一轮", async () => {
  seen.length = 0;
  store.ensureSession("qu", "排队");
  const main = converse("你", "第一件事", "控制台", { conv: "qu" });
  await sleep(100);
  const second = await converse("你", "第二件事", "控制台", { conv: "qu", mode: "queue" });
  await main;
  assert.equal(second, "收到：第二件事");
  assert.equal(store.sessionMessages("qu").filter((m) => m.role === "agent").length, 2);
});

test("后台命令可以随时停止", async () => {
  const sh = await import("../src/sh.ts");
  const j = await sh.startJob("echo 开始; sleep 30; echo 不该出现");
  for (let i = 0; i < 100 && !/开始/.test(sh.getJob(j.id)!.out); i++) await sleep(200); // Windows：沙箱用户与 PowerShell 起来要一两秒
  assert.equal(sh.getJob(j.id)!.ended, undefined);
  assert.match(sh.getJob(j.id)!.out, /开始/);
  assert.match(sh.stopJob(j.id), /已停止/);
  await sleep(300);
  assert.ok(sh.getJob(j.id)!.ended);
  assert.doesNotMatch(sh.getJob(j.id)!.out, /不该出现/);
  assert.match(sh.stopJob(j.id), /已经结束/);
});

test("图片只发给能看图的模型；没有时去掉图片并说明", async () => {
  provider([
    { id: "m1", name: "plain", enabled: true, context: 8000, maxTokens: 256, sortOrder: 0 },
    { id: "m2", name: "eye", enabled: true, context: 8000, maxTokens: 256, sortOrder: 1, vision: true },
  ]);
  const img = { role: "user" as const, content: "你 通过控制台对你说：\n看图", images: [{ mime: "image/png", data: "iVBORw0KGgo=" }] };
  seen.length = 0;
  const r = await router.chat({ messages: [img] });
  assert.equal(r.model, "Mock/eye");
  assert.deepEqual(seen[0].messages[0].content[1], { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } });
  provider([{ id: "m1", name: "plain", enabled: true, context: 8000, maxTokens: 256, sortOrder: 0, vision: false }]);
  seen.length = 0;
  await router.chat({ messages: [img] });
  assert.equal(typeof seen[0].messages[0].content, "string");
  assert.match(seen[0].messages[0].content, /都不支持看图/);
  assert.equal(router.canSee({ provider: { catalogId: "x" } as any, model: { name: "gpt-4o-mini" } as any }), true);
});

test("模型某一步什么也没输出：提醒她再来，不留空回复", async () => {
  provider([{ id: "m", name: "plain", enabled: true, context: 8000, maxTokens: 256, sortOrder: 0 }]);
  const tool = { finish_reason: "tool_calls", message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "clock", arguments: "{}" } }] } };
  const blank = { finish_reason: "length", message: { content: "" } };
  // 先调一次工具，再空一步（输出长度用完），被提醒后回复
  let n = 0;
  script = (j) => { n++; return n === 1 ? tool : n === 2 ? blank : { finish_reason: "stop", message: { content: `总结好了：${j.messages.at(-1).content.includes("长度上限") ? "看到提醒" : "没看到"}` } }; };
  seen.length = 0;
  assert.equal(await converse("测试者", "空白测试一", "控制台", { conv: "blank-1" }), "总结好了：看到提醒");
  assert.ok(!seen.at(-1).messages.some((m: any) => m.role === "assistant" && !m.content && !m.tool_calls), "空的一步不进上下文");
  // 一直是空的：提醒两次后结束，回复说明没能把结果说出来
  n = 0;
  script = () => (++n === 1 ? tool : blank);
  const r = await converse("测试者", "空白测试二", "控制台", { conv: "blank-2" });
  assert.equal(n, 4);
  assert.match(r, /做了 1 步，但最后没能把结果说出来/);
  assert.equal(store.sessionMessages("blank-2").at(-1)!.text, r);
  script = undefined;
  server.close();
});

test("当前会话：对话中的 send_message 只进入当前对话；醒来时才作为主动消息发出", async () => {
  const { callTool } = await import("../src/mind/tools.ts");
  const { bus } = await import("../src/bus.ts");
  const said: string[] = [];
  const on = (t: string) => said.push(t);
  bus.on("say", on);
  const chat = new Session("chat", "飞书", "t-chat", "c-chat");
  chat.emit({ kind: "start", text: "在干啥" });
  const r1 = await callTool("send_message", { text: "我在查心跳" }, "回应你", { session: chat });
  assert.match(r1.text, /当前对话/);
  assert.deepEqual(said, []);
  assert.deepEqual(chat.process(), [{ type: "text", text: "我在查心跳" }]);
  chat.close();
  const think = new Session("think");
  const r2 = await callTool("send_message", { text: "我自己醒了" }, "光线变化", { session: think });
  assert.match(r2.text, /主动消息/);
  assert.deepEqual(said, ["我自己醒了"]);
  think.close();
  bus.off("say", on);
});
