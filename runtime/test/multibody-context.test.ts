// 多具身体时她看到的处境（issue #38）：别的身体暂时离线也标明消息从哪具身体进来；「其他会话」标明在哪具身体、谁说的；
// 别的身体上久无进展的一轮不再当它在进行；子 agent 不能换身体；醒来时派出的子 agent 报告不落进不相干的默认会话。
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "quetzal-multibody-"));
process.env.QUETZAL_HOME = path.join(tmp, "home");
const { loadConfig, saveConfig } = await import("../src/config.ts");
loadConfig();
saveConfig({ body: "laptop" });
const store = await import("../src/store.ts");
store.openStore();
const { setBodies, multiBody } = await import("../src/mind/bodies.ts");
const { entryBody, history } = await import("../src/mind/brain.ts");
const { systemPrompt } = await import("../src/mind/prompt.ts");
const { foldRemote, liveTurns, Session } = await import("../src/mind/activity.ts");
const { AGENT_TOOLS } = await import("../src/mind/agents.ts");
const { callTool } = await import("../src/mind/tools.ts");
const agents = await import("../src/mind/agents.ts");

const registry = [{ body: "laptop", uuid: "00000000-0000-8000-8000-000000000001" }, { body: "phone", uuid: "00000000-0000-8000-8000-000000000002" }];
const hooks = (online: string[]) => setBodies({ list: () => online.map((b) => ({ body: b, describe: "", tools: [] })), registry: () => registry, call: async () => ({ text: "", status: "ok" }), move: async () => "" });

test("只有这一具在线、但灵魂仓库登记了两具：仍标明消息从哪具身体进来", () => {
  setBodies(undefined);
  assert.equal(multiBody(), false);
  assert.equal(entryBody("laptop"), undefined, "真的只有一具身体时不标");
  hooks([]);
  assert.equal(multiBody(), true);
  assert.equal(entryBody("laptop"), "laptop", "别的身体暂时离线也标");
  store.ensureSession("c1", "开发", "控制台");
  const id = store.addMessage("user", "控制台", "你看不到我在哪跟你说话吗", { session: "c1", via: "laptop" });
  const text = history("c1", id + 1).map((m) => String(m.content)).join("\n");
  assert.match(text, /经 laptop 发来/);
});

test("「其他会话」：每条标明在哪具身体上、谁说的，子 agent 的报告不当成我说的话", () => {
  hooks([]);
  store.ensureSession("c2", "本机环境搭建", "控制台");
  store.addMessage("user", "控制台", "装一下 node", { session: "c2", via: "phone" });
  store.addMessage("ambient", "子agent", "子 agent「dev」完成了任务。报告：做完了", { session: "c2" });
  store.addMessage("agent", "控制台", "装好了", { session: "c2" });
  const p = systemPrompt("", { conv: "c1" });
  assert.match(p, /对方（经 phone）：装一下 node/);
  assert.match(p, /（子 agent 的报告，不是对方说的）：子 agent「dev」/);
  assert.match(p, /我（在 laptop 上）：装好了/);
  assert.doesNotMatch(p, /我[^：\n]*：子 agent「dev」/);
});

test("别的身体上的一轮久无进展：不再当它在进行（结束的消息丢了也不会一直把话转过去）", () => {
  mock.timers.enable({ apis: ["Date"], now: Date.now() });
  try {
    foldRemote({ session: "t-remote", conv: "c3", origin: "chat", channel: "控制台", ts: Date.now(), body: "phone", kind: "start", text: "在手机上" } as any);
    assert.ok(liveTurns().some((t) => t.turn === "t-remote"));
    mock.timers.tick(2 * 60_000);
    foldRemote({ session: "t-remote", conv: "c3", origin: "chat", channel: "控制台", ts: Date.now(), body: "phone", kind: "alive" } as any);
    mock.timers.tick(2 * 60_000);
    assert.ok(liveTurns().some((t) => t.turn === "t-remote"), "有心跳就还在");
    mock.timers.tick(2 * 60_000);
    assert.ok(!liveTurns().some((t) => t.turn === "t-remote"), "3 分钟没有任何进展就不算了");
  } finally { mock.timers.reset(); }
});

test("子 agent 不能换身体；醒来时派出的子 agent，报告送回这次醒来的会话或为它新开的会话", async () => {
  assert.ok(AGENT_TOOLS.has("move_to"));
  const wake = new Session("think"); wake.close();
  const r = await callTool("agent_spawn", { name: "调研", goal: "查点资料" }, "测试", { session: wake });
  assert.match(r.text, /报告会送回会话「子 agent「调研」」/);
  const sub = agents.list().find((a) => a.name === "调研")!;
  assert.notEqual(sub.parentConv, "first");
  assert.equal(store.getSession(sub.parentConv)?.title, "子 agent「调研」");
  agents.stop(sub.id);
});
