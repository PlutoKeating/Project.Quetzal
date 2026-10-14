// 真实 brain 后台队列、quick 供应商路由与管理 ops；所有数据和模拟服务只存在临时 home。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { MemoryEpisode } from "../../engine/src/prime.ts";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "quetzal-memory-production-"));
process.env.QUETZAL_HOME = home;
const { loadConfig, saveConfig, paths } = await import("../src/config.ts");
loadConfig(); saveConfig({ brain: { memoryLearning: true, memorySemantic: false, memoryLearningTimeoutMs: 5000 } });
const store = await import("../src/store.ts"); store.openStore();
await (await import("../src/memory/soul-sync.ts")).ensureSoul();
const registry = await import("../src/providers/registry.ts");
const { identity } = await import("../src/memory/identity.ts");
const memory = await import("../src/memory/structured.ts");
const prime = await import("../src/memory/prime.ts");
const { invoke } = await import("../src/ops.ts");
const { converse } = await import("../src/mind/brain.ts");
const seen: { model: string; system: string }[] = [];
const server = http.createServer((req, res) => {
  let body = ""; req.on("data", (chunk) => { body += chunk; });
  req.on("end", () => {
    const request = JSON.parse(body), system = String(request.messages[0].content);
    seen.push({ model: request.model, system });
    let text = "收到，已记录本轮回复";
    if (system.startsWith("你为 agent 蒸馏")) {
      const episode = JSON.parse(request.messages[1].content);
      const source = episode.evidence.find((e: { origin: string }) => e.origin === "user");
      text = JSON.stringify({ items: episode.outcome.status === "success"
        ? [{ kind: "experience", text: "合成已完成轮次的结果核对观察", evidenceIds: episode.outcome.evidenceIds }]
        : [{ kind: "preference", preference: "explicit", text: "我希望回复简短", quote: "我希望回复简短", evidenceIds: [source.id], slot: "user.reply.length" }] });
    } else if (system.startsWith("评审")) {
      const payload = JSON.parse(request.messages[1].content);
      text = JSON.stringify({ accepted: true, evidenceIds: payload.independentOutcome.map((e: { id: string }) => e.id) });
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10 } }));
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
registry.saveProviders({ quickModelId: "quick", providers: [{ id: "fixture", catalogId: "custom", name: "合成供应商", baseUrl,
  protocol: "openai-completions", enabled: true, keys: [{ id: "fixture-key", label: "合成", lastFour: "", enabled: true, secret: "synthetic-test-key" }],
  models: ["main", "quick"].map((id, sortOrder) => ({ id, name: id, enabled: true, context: 131072, maxTokens: 4096, sortOrder })) }] }, registry.configVersion());
after(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); store.db.close(); fs.rmSync(home, { recursive: true, force: true }); });
async function eventually(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check()) { if (Date.now() > deadline) throw new Error("后台学习未在预算内完成"); await new Promise((resolve) => setTimeout(resolve, 20)); }
}

test("实际对话回复后后台quick提炼，管理确认及真实整体反馈经ops触发独立语义评审", async () => {
  store.ensureSession("production-chat", "生产闭环合成会话");
  assert.equal(await converse("你", "我希望回复简短", "合成测试", { conv: "production-chat", turn: "production-turn" }), "收到，已记录本轮回复");
  await eventually(() => memory.readStructuredRecords().some((r) => r.kind === "preference" && r.state === "candidate"));
  assert.ok(seen.some((r) => r.model === "main"));
  assert.ok(seen.some((r) => r.model === "quick" && r.system.startsWith("你为 agent 蒸馏")));
  const candidate = memory.readStructuredRecords().find((r) => r.kind === "preference" && r.state === "candidate")!;
  await assert.rejects(invoke("memory.confirm", { key: `${candidate.id}@1` }, ""), /身份/);
  const confirmed = await invoke("memory.confirm", { key: `${candidate.id}@1` }, "synthetic-manager");
  assert.equal(confirmed.state, "active");
  const episode = store.kv.get<MemoryEpisode[]>("prime.episodes", []).find((e) => e.id === "production-turn")!;
  assert.equal(episode.outcome.status, "unknown");
  await assert.rejects(invoke("memory.feedback", { episodeId: episode.id, status: "success", session: "wrong-session" }, "synthetic-manager"), /会话/);
  await assert.rejects(invoke("memory.feedback", { episodeId: episode.id, status: "success" }, ""), /身份/);
  const reviewed = await invoke("memory.feedback", { episodeId: episode.id, status: "success" }, "synthetic-manager");
  assert.equal(reviewed.status, "learned"); assert.equal(reviewed.episode.outcome.status, "success");
  const evidence = reviewed.episode.evidence.find((e: { id: string }) => reviewed.episode.outcome.evidenceIds.includes(e.id));
  assert.equal(evidence.origin, "user");
  assert.ok(store.sessionMessages("production-chat").some((m) => `message:${m.id}` === evidence.ref && m.role === "user" && m.text.includes("整个任务成功")));
  assert.ok(memory.readStructuredRecords().some((r) => r.kind === "experience" && r.state === "active" && r.validation.evaluator === "host-grounded-semantic-faithfulness"));
  assert.ok(seen.some((r) => r.model === "quick" && r.system.startsWith("评审")));
  assert.ok(store.listAudit(30).some((row) => row.action === "memory.feedback" && row.actor === "synthetic-manager"));
});

test("生成轨迹亦保留local会话来源，其他agent与急停禁止管理反馈，不伪造来源", async () => {
  store.ensureSession("generated-session", "合成生成任务");
  prime.recordEpisode({ episodeId: "generated-turn", session: "generated-session", userInput: "合成自主任务", reply: "完成", userOrigin: "agent", scope: { agentId: identity().id } });
  const origin = store.kv.get<Record<string, { session: string; ref?: string }>>("prime.origins", {})["generated-turn"];
  assert.equal(origin.session, "generated-session"); assert.equal(origin.ref, undefined);
  prime.recordEpisode({ episodeId: "foreign-turn", session: "generated-session", userInput: "其他agent", reply: "完成", scope: { agentId: "foreign-agent" } });
  await assert.rejects(invoke("memory.feedback", { episodeId: "foreign-turn", status: "success" }, "synthetic-manager"), /当前Agent/);
  const count = store.sessionMessages("generated-session").length;
  fs.writeFileSync(paths.stop, "合成急停");
  try { await assert.rejects(invoke("memory.feedback", { episodeId: "generated-turn", status: "failure" }, "synthetic-manager"), /急停/); }
  finally { fs.rmSync(paths.stop); }
  assert.equal(store.sessionMessages("generated-session").length, count);
  const feedback = await invoke("memory.feedback", { episodeId: "generated-turn", status: "failure" }, "synthetic-manager");
  assert.equal(feedback.status, "learned"); assert.equal(feedback.episode.outcome.status, "failure");
  assert.ok(store.sessionMessages("generated-session").some((m) => m.role === "user" && m.text.includes("整个任务失败")));
});
