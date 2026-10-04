// 飞书执行过程卡片：按插话分段——插话那一刻上面的卡片定格，新的一段回复插话消息；耳朵听到的话并入时自行分段；最后的回复接在最后一段下面。
import { test } from "node:test";
import assert from "node:assert/strict";
import { ProgressCards } from "../src/channels/feishu-progress.ts";
import type { Activity } from "../src/bus.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function fake() {
  const sent: { id: string; replyTo?: string; data: any }[] = [];
  const updates: { id: string; data: any }[] = [];
  return {
    sent, updates,
    sender: {
      send: async (replyTo: string | undefined, data: unknown) => { const id = `m${sent.length + 1}`; sent.push({ id, replyTo, data }); return id; },
      update: async (id: string, data: unknown) => { updates.push({ id, data }); },
    },
  };
}
const text = (data: any) => data.body.elements[0].content as string;
const title = (data: any) => data.header.title.content as string;
const ev = (p: Partial<Activity>): Activity => ({ session: "s", conv: "c", origin: "chat", channel: "飞书", ts: Date.now(), kind: "tool", ...p } as Activity);

test("对方插话：上面的卡片定格，新的一段回复插话消息，之后的工具进新卡片；回复接在最后一段下面", async () => {
  const f = fake();
  const p = new ProgressCards(f.sender, "msg-1", "s");
  p.onActivity(ev({ kind: "tool", call: "c1", name: "shell", summary: "ls", status: "running" }));
  await sleep(10); // 第一张卡片立即发出
  p.onActivity(ev({ kind: "tool", call: "c1", name: "shell", summary: "ls", status: "ok", ms: 120 }));
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].replyTo, "msg-1");
  // 对方发来插话（通道先分段，再把消息交给 converse → 随后到来 steer 事件）
  p.split("msg-2");
  p.onActivity(ev({ kind: "steer", text: "顺便看看明天", msg: 7, mode: "steer" }));
  await sleep(10);
  const frozen = f.updates.at(-1)!;
  assert.equal(frozen.id, "m1"); assert.equal(title(frozen.data), "执行过程 · 1 个工具"); assert.match(text(frozen.data), /shell/);
  assert.ok(!text(frozen.data).includes("插话"), "定格的卡片里不再写插话");
  assert.equal(f.sent.length, 1, "分段本身不发新卡片，等下一条进展");
  p.onActivity(ev({ kind: "tool", call: "c2", name: "web_search", summary: "天气", status: "running" }));
  await sleep(10);
  assert.equal(f.sent.length, 2); assert.equal(f.sent[1].replyTo, "msg-2");
  assert.match(text(f.sent[1].data), /web_search/); assert.ok(!text(f.sent[1].data).includes("shell"), "新卡片不含上一段");
  assert.equal(p.replyTo, "msg-2");
  p.onActivity(ev({ kind: "tool", call: "c2", name: "web_search", summary: "天气", status: "ok", ms: 300 }));
  await p.close();
  const last = f.updates.at(-1)!;
  assert.equal(last.id, "m2"); assert.equal(title(last.data), "执行过程 · 1 个工具");
});

test("耳朵听到的话并入（没有对应的飞书消息）：由 steer 事件自己分段，新卡片第一行写听到的话", async () => {
  const f = fake();
  const p = new ProgressCards(f.sender, "msg-1", "s");
  p.onActivity(ev({ kind: "tool", call: "c1", name: "shell", summary: "ls", status: "ok", ms: 50 }));
  await sleep(10);
  p.onActivity(ev({ kind: "steer", text: "薰，等一下", msg: 9, mode: "interrupt", ambient: true }));
  await sleep(10);
  assert.equal(f.sent.length, 2);
  assert.equal(f.sent[1].replyTo, "msg-1", "没有新消息可回复时仍接在原消息下");
  assert.match(text(f.sent[1].data), /📨 \*听到你说：薰，等一下\*（已并入）/);
  assert.equal(title(f.updates.at(-1)!.data), "执行过程 · 1 个工具"); // 上一段定格
  await p.close();
});

test("没有任何进展时结束不发卡片；别的会话的事件不理", async () => {
  const f = fake();
  const p = new ProgressCards(f.sender, "msg-1", "s");
  p.onActivity(ev({ session: "other", kind: "tool", call: "x", name: "shell", status: "running" }));
  await p.close();
  assert.equal(f.sent.length, 0);
});
