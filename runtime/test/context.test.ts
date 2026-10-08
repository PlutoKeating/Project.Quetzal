// 上下文的自我记录：对话历史带时间与每轮的过程记录；同一张图不重复发送；recent_actions 查审计。
// 背景：此前下一轮只看得到回复文字，她会对自己上一轮做过什么"失忆"，一会儿多说、一会儿又过度否认。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

process.env.QUETZAL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "quetzal-ctx-"));
const { loadConfig } = await import("../src/config.ts");
loadConfig();
const store = await import("../src/store.ts");
store.openStore();
const reg = await import("../src/providers/registry.ts");
const { Session } = await import("../src/mind/activity.ts");
const { converse, history, describeProcess, stripStamp } = await import("../src/mind/brain.ts");
const { callTool } = await import("../src/mind/tools.ts");
const { userMessage } = await import("../src/mind/attachments.ts");

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a5f2e2d20000000049454e44ae426082", "hex");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-img-"));
const img = path.join(dir, "shot.png"); fs.writeFileSync(img, PNG);
const attachment = { id: "a1", name: "shot.png", path: img, rel: "shot.png", mime: "image/png", size: PNG.length, kind: "image" as const };

test("过程记录：最近几轮给每一步，更早的只给工具计数", () => {
  const items = [
    { type: "text", text: "先看看" },
    { type: "tool", call: "c1", name: "view_image", summary: "/x/a.jpg", status: "ok", ms: 5, result: "✓ /x/a.jpg" },
    { type: "tool", call: "c2", name: "shell", summary: "ps -ef", status: "error", ms: 9, result: "出错了" },
  ];
  assert.equal(describeProcess(items, true), "说：「先看看」；view_image(/x/a.jpg) ✓ → ✓ /x/a.jpg；shell(ps -ef) ✗ → 出错了");
  assert.equal(describeProcess(items, false), "这一轮用了 2 个工具：view_image×1、shell×1（细节用 recent_actions 查）");
  assert.equal(describeProcess([{ type: "text", text: "嗯" }], false), "这一轮没有用工具，中途说过话");
  assert.equal(describeProcess(null, true), "");
  assert.match(describeProcess(Array.from({ length: 40 }, (_, i) => ({ type: "tool", name: "shell", summary: `cmd${i}`, status: "ok", result: "x".repeat(100) })), true), /…（共 40 步）$/);
});

test("对话历史：每条带时间，回复前附过程记录，插话有标记，附件只剩路径", () => {
  store.ensureSession("h", "历史");
  store.addMessage("user", "飞书", "看这张图", { session: "h", attachments: [attachment] });
  store.addMessage("agent", "飞书", "看到了", { session: "h", process: [{ type: "tool", call: "c", name: "view_image", summary: img, status: "ok", ms: 1, result: `✓ ${img}` }] });
  store.addMessage("user", "飞书", "等等", { session: "h", mode: "steer" });
  for (let i = 0; i < 4; i++) store.addMessage("agent", "飞书", `第${i}次回复`, { session: "h", process: [{ type: "tool", call: `t${i}`, name: "shell", summary: "ls", status: "ok", ms: 1, result: "ok" }] });
  const self = store.addMessage("user", "飞书", "现在这句", { session: "h" });
  const h = history("h", self);
  assert.equal(h.length, 12); // 每条回复前多一条基座附注
  assert.match(h[0].content, /^\[\d\d\/\d\d \d\d:\d\d\] 看这张图\n\[\d\d\/\d\d \d\d:\d\d 随这条消息发来的附件：shot\.png（.*shot\.png）；图片当时已附在消息里，现在只剩路径，想再看用 view_image\]$/);
  assert.equal(h[1].role, "user");
  assert.match(h[1].content, /^\[基座附注，不是对方的话｜\d\d\/\d\d \d\d:\d\d 你回复了下一条；这一轮的过程记录：这一轮用了 1 个工具：view_image×1（细节用 recent_actions 查）\]$/); // 较早的一轮：只有计数
  assert.deepEqual([h[2].role, h[2].content], ["assistant", "看到了"]); // 她的回复只留原文：不带时间与过程记录，免得模型照着格式自己编
  assert.match(h[3].content, /^\[\d\d\/\d\d \d\d:\d\d，插话\] 等等$/);
  assert.match(h[4].content, /过程记录：这一轮用了 1 个工具：shell×1/); // 倒数第 4 轮回复：计数
  for (let i = 6; i < 12; i += 2) { assert.match(h[i].content, /过程记录：shell\(ls\) ✓ → ok\]$/); assert.match(h[i + 1].content, /^第\d次回复$/); } // 最近 3 轮回复：每一步
  assert.ok(h.filter((m) => m.role === "assistant").every((m) => !m.content.startsWith("[")));
  assert.ok(!h.some((m) => m.content.includes("现在这句")));
});

test("同一张图不重复发送：随消息附带过的、view_image 看过的", async () => {
  const s = new Session("chat", "控制台", "t-img", "c-img");
  const m = await userMessage("看图", [attachment], "回复", s.seen);
  assert.equal((m as any).images.length, 1);
  assert.ok(s.seen.has(img));
  const r1 = await callTool("view_image", { paths: [img] }, "回应你", { session: s });
  assert.match(r1.text, /已经在你眼前.*不再重复发送/);
  assert.doesNotMatch(r1.text, /下一步思考时出现/);
  assert.equal(s.images.length, 0);
  const other = path.join(dir, "other.png"); fs.writeFileSync(other, PNG);
  const r2 = await callTool("view_image", { paths: [other, other] }, "回应你", { session: s });
  assert.match(r2.text, /✓ .*other\.png\n= .*other\.png：这张图这一轮已经在你眼前/);
  assert.equal(s.images.length, 1);
  s.close();
});

test("recent_actions：按时间、工具名查自己的审计记录", async () => {
  const s = new Session("chat", "控制台", "t-aud", "c-aud");
  await callTool("view_image", { paths: [img] }, "回应你", { session: s });
  await callTool("open_loop", { action: "add", text: "记一下" }, "回应你", { session: s });
  s.close();
  const all = await callTool("recent_actions", {}, "回应你", { session: s });
  assert.match(all.text, /旧→新/);
  assert.match(all.text, /\d\d\/\d\d \d\d:\d\d:\d\d view_image\(.*shot\.png\)〔回应你〕 → ✓/);
  assert.match(all.text, /open_loop\(记一下\)〔回应你〕 → 已记下/);
  const one = await callTool("recent_actions", { name: "open_loop" }, "回应你", { session: s });
  assert.doesNotMatch(one.text, /view_image/);
  assert.match(one.text, /open_loop/);
  assert.match((await callTool("recent_actions", { name: "shell" }, "回应你")).text, /没有调用 shell 的记录/);
});

test("对话里：上一轮的工具过程进入下一轮的上下文", async () => {
  const seen: any[] = [];
  const server = http.createServer((req, res) => {
    let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
      const j = JSON.parse(body); seen.push(j);
      const n = j.messages.filter((m: any) => m.role === "tool").length;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(seen.length === 1 && n === 0
        ? { choices: [{ message: { content: "我先记一下", tool_calls: [{ id: "x1", type: "function", function: { name: "open_loop", arguments: JSON.stringify({ action: "add", text: "装 CLI" }) } }] } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }
        : { choices: [{ message: { content: "好了" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  reg.saveProviders({ providers: [{ id: "p", catalogId: "custom", name: "Mock", baseUrl: base, protocol: "openai-completions" as const, enabled: true,
    keys: [{ id: "k", label: "k", lastFour: "", enabled: true, secret: "sk-mock-000000" }], models: [{ id: "m", name: "plain", enabled: true, context: 8000, maxTokens: 256, sortOrder: 0 }] }] }, reg.configVersion());
  store.ensureSession("cv", "对话");
  assert.equal(await converse("你", "帮我装 CLI", "控制台", { conv: "cv" }), "好了");
  assert.deepEqual(store.sessionMessages("cv").at(-1)!.process!.map((x: any) => [x.type, x.name ?? x.text]), [["text", "我先记一下"], ["tool", "open_loop"]]);
  await converse("你", "你刚才做了什么", "控制台", { conv: "cv" });
  const msgs = seen.at(-1).messages, i = msgs.findIndex((m: any) => m.role === "assistant");
  assert.equal(msgs[i].content, "好了"); // 她的回复只留原文
  assert.equal(msgs[i - 1].role, "user");
  assert.match(msgs[i - 1].content, /^\[基座附注，不是对方的话｜\d\d\/\d\d \d\d:\d\d 你回复了下一条；这一轮的过程记录：说：「我先记一下」；open_loop\(装 CLI\) ✓ → 已记下，现在有 \d+ 件\]$/);
  assert.match(seen.at(-1).messages[0].content, /关于「我做过什么」/);
  server.close();
});

test("回复开头被模型仿写出来的「[时间｜这一轮的过程记录：…]」附注被剥掉；正常回复不受影响", () => {
  const r = stripStamp('[10/05 05:53｜这一轮的过程记录：voice_config(action=get)✓ → {"a":[1,2]}；voice_speak(你好)✓ → 说出来了]\n说了！你那边听到了吗？');
  assert.equal(r, "说了！你那边听到了吗？");
  assert.equal(stripStamp("[10/05 05:22]\n好的"), "好的");
  assert.equal(stripStamp("[基座附注，不是对方的话｜10/06 20:10 你回复了下一条；这一轮的过程记录：shell(ls) ✓]\n好的"), "好的");
  assert.equal(stripStamp("好的 [1] 和 [2]"), "好的 [1] 和 [2]");
  assert.equal(stripStamp("[参考] 这是正文"), "[参考] 这是正文");
});

test("消息从哪具身体进来：只有一具身体时不标；多具身体时历史与这一句都标明；旧消息没记就不标；复制来的 via 要像身体名", async () => {
  const { setBodies } = await import("../src/mind/bodies.ts");
  const { config } = await import("../src/config.ts");
  const { entryBody } = await import("../src/mind/brain.ts");
  store.ensureSession("via", "来源");
  store.addMessage("user", "控制台", "旧消息", { session: "via" });
  store.addMessage("user", "控制台", "这里说的", { session: "via", via: config.body });
  store.addMessage("user", "控制台", "别处说的", { session: "via", via: "pc", mode: "steer" });
  store.addMessage("ambient", "语音", "别处听到的", { session: "via", via: "pc" });
  const lines = () => history("via", Number.MAX_SAFE_INTEGER).map((m) => String(m.content));
  // 一具身体：这里进来的不标；从别处转来的（via 不是这具身体）照样标
  assert.deepEqual(lines().slice(0, 2).map((l) => l.includes("经")), [false, false]);
  assert.match(lines()[2], /^\[\d\d\/\d\d \d\d:\d\d，插话｜经 pc 发来\] 别处说的$/);
  assert.match(lines()[3], /环境声音：pc 这具身体的麦克风听到并识别的话/);
  assert.equal(entryBody(config.body), undefined);
  setBodies({ list: () => [{ body: "pc", describe: "", tools: [] }], call: async () => ({ text: "", status: "ok" }), move: async () => "" });
  try {
    assert.ok(!lines()[0].includes("经"), "旧消息没记来源，不猜");
    assert.match(lines()[1], new RegExp(`｜经 ${config.body} 发来\\] 这里说的$`));
    assert.equal(entryBody(config.body), config.body);
  } finally { setBodies(undefined); }
  // 复制来的行：via 不像身体名就整行丢弃，合格的照样写入
  const id = store.idPrefixOf("pc") * store.ID_RANGE + 7;
  const row = { id, ts: Date.now(), role: "user", channel: "控制台", text: "复制来的", session: "via", body: "pc" };
  assert.equal(store.applyRemote("messages", [{ ...row, via: "../x" }], { from: "pc" }).rejected, 1);
  assert.equal(store.applyRemote("messages", [{ ...row, via: "phone" }], { from: "pc" }).changed.length, 1);
  assert.equal(store.sessionMessages("via").find((m) => m.text === "复制来的")!.via, "phone");
});
