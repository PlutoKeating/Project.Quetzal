import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChatRequest, ChatResult } from "../src/providers/types.ts";
import type { EpisodeInput, LearningOptions } from "../src/memory/prime.ts";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "quetzal-prime-host-"));
process.env.QUETZAL_HOME = home;
const { loadConfig, paths } = await import("../src/config.ts");
loadConfig();
const { openStore, addMessage, ensureSession, saveToolCall, kv } = await import("../src/store.ts");
openStore();
await (await import("../src/memory/soul-sync.ts")).ensureSoul();
const host = await import("../src/memory/prime.ts");
const records = await import("../src/memory/structured.ts");
const scope = { agentId: (await import("../src/memory/identity.ts")).identity().id, userId: "owner" };
after(() => fs.rmSync(home, { recursive: true, force: true }));
const result = (value: unknown): ChatResult => ({ text: JSON.stringify(value), toolCalls: [], model: "synthetic", usage: { input: 100, output: 50 } });
const episode = (id: string, text = "我喜欢红茶"): EpisodeInput => {
  ensureSession(id, "合成任务", "test");
  const message = addMessage("user", "test", text, { session: id });
  return { episodeId: id, session: id, userInput: text, reply: "知道了", userSourceRef: `message:${message}`, scope };
};
const factChat = async (request: ChatRequest) => {
  const e = JSON.parse(String(request.messages.at(-1)!.content));
  const source = e.evidence.find((s: { origin: string }) => s.origin === "user");
  const quote = e.turns.find((t: { role: string }) => t.role === "user").text;
  return result({ items: [{ kind: "preference", preference: "explicit", text: quote, quote, evidenceIds: [source.id], stage: "any" }] });
};
const trustedPersonal: LearningOptions["confirmPersonal"] = async (record) => ({ accepted: true, independent: true,
  evaluator: "trusted-personal-semantics", score: 1, evidence: record.evidence.filter((e) => e.origin === "user" && e.verified) });

test("生产蒸馏个人记忆只候选，可信语义确认才激活，不重写USER；重复episode不再调模型", async () => {
  const unconfirmed = await host.learnEpisode(episode("unconfirmed"), { chat: factChat });
  assert.ok(unconfirmed.records.some((r) => r.kind === "preference" && r.state === "candidate"));
  const input = episode("exact");
  const learned = await host.learnEpisode(input, { chat: factChat, confirmPersonal: trustedPersonal });
  assert.equal(learned.status, "learned");
  const active = learned.records.find((r) => r.text === input.userInput && r.state === "active")!;
  assert.equal(active.state, "active");
  assert.equal(active.validation.evaluator, "trusted-personal-semantics");
  assert.ok(records.getMemoryCandidates("红茶", scope, "any", { includeLegacy: false }).some((r) => r.id === active.id));
  assert.equal(fs.existsSync(path.join(paths.soul, "memories", "USER.md")), true);
  assert.ok(!fs.readFileSync(path.join(paths.soul, "memories", "USER.md"), "utf8").includes(input.userInput));
  const repeated = await host.learnEpisode(input, { chat: async () => { throw new Error("不得重复调用"); } });
  assert.equal(repeated.status, "skipped");
});

test("否定、故事引用、虚构语境中的子串不得自动成为个人事实，完整语境作为观察保留", async () => {
  for (const [id, text] of [["denial", "不要把我喜欢红茶当成我的偏好"], ["quotation", "写故事，角色说我喜欢红茶"], ["fiction", "假设虚构的我喜欢红茶，继续这个场景"]]) {
    const input = episode(id, text); input.scope = { ...scope, userId: id };
    const learned = await host.learnEpisode(input, { chat: async (request) => {
      const e = JSON.parse(String(request.messages.at(-1)!.content));
      return result({ items: [{ kind: "preference", preference: "explicit", text: "我喜欢红茶", quote: "我喜欢红茶", evidenceIds: [e.evidence[0].id] }] });
    } });
    assert.ok(learned.records.some((r) => r.scope.userId === id && r.kind === "preference" && r.state === "candidate"));
    assert.ok(!learned.records.some((r) => r.scope.userId === id && r.kind === "preference" && r.state === "active"));
    assert.ok(learned.records.some((r) => r.scope.userId === id && r.kind === "episode" && r.state === "active" && r.text.includes(text)));
  }
});

test("管理员确认核对来源且只管理者路径激活个人候选", async () => {
  const input = episode("managed", "我希望以后使用简短回复");
  const learned = await host.learnEpisode(input, { chat: factChat });
  const candidate = learned.records.find((r) => r.kind === "preference" && r.text === input.userInput)!;
  assert.equal(candidate.state, "candidate");
  const confirmed = await host.confirmPersonalMemory(`${candidate.id}@1`, { actor: "synthetic-manager" });
  assert.equal(confirmed.state, "active");
  assert.equal(confirmed.validation.evaluator, "manager-personal-confirmation");
  const again = await host.learnEpisode(episode("managed-again", input.userInput), { chat: factChat });
  const repeated = again.records.find((r) => r.kind === "preference" && r.text === input.userInput && r.state === "candidate")!;
  const deduplicated = await host.confirmPersonalMemory(`${repeated.id}@1`, { actor: "synthetic-manager" });
  assert.equal(deduplicated.id, confirmed.id);
  assert.ok(deduplicated.evidence.length > confirmed.evidence.length);
});

test("推断、agent生成任务和无Message来源都不能伪装用户明确偏好", async () => {
  const inferred = await host.learnEpisode(episode("inferred", "我买了一本书"), { chat: async (request) => {
    const e = JSON.parse(String(request.messages.at(-1)!.content));
    return result({ items: [{ kind: "preference", preference: "inferred", text: "可能喜欢阅读", evidenceIds: [e.evidence[0].id] }] });
  } });
  assert.equal(inferred.records.find((r) => r.text === "可能喜欢阅读")!.state, "candidate");
  const generated: EpisodeInput = { episodeId: "agent-task", session: "task", userInput: "我喜欢下雨", reply: "合成任务", userOrigin: "agent", scope };
  const learned = await host.learnEpisode(generated, { chat: async (request) => {
    const e = JSON.parse(String(request.messages.at(-1)!.content));
    return result({ items: [{ kind: "preference", preference: "explicit", text: "我喜欢下雨", quote: "我喜欢下雨", evidenceIds: [e.evidence[0].id] }] });
  } });
  assert.notEqual(learned.records.find((r) => r.text === "我喜欢下雨")?.state, "active");
  assert.equal(host.recordEpisode({ ...generated, episodeId: "missing-ref", userOrigin: "user" }).evidence[0].verified, false);
});

test("更晚明确事实同slot自动升版，旧引用和来源保留，其他用户不覆盖", async () => {
  const chat = async (request: ChatRequest) => {
    const e = JSON.parse(String(request.messages.at(-1)!.content)), quote = e.turns[0].text;
    return result({ items: [{ kind: "fact", slot: "user.city", text: quote, quote, evidenceIds: [e.evidence[0].id] }] });
  };
  const first = await host.learnEpisode(episode("city-before", "我现在住上海"), { chat, confirmPersonal: trustedPersonal });
  const old = first.records.find((r) => r.slot === "user.city")!;
  await new Promise((resolve) => setTimeout(resolve, 5));
  const next = await host.learnEpisode(episode("city-after", "我现在住深圳"), { chat, confirmPersonal: trustedPersonal });
  assert.equal(next.records.find((r) => r.id === old.id && r.version === 1)!.state, "superseded");
  const active = next.records.find((r) => r.id === old.id && r.version === 2)!;
  assert.equal(active.state, "active"); assert.equal(active.text, "我现在住深圳");
  assert.ok(active.evidence.some((e) => e.summary === "我现在住上海"));
  assert.deepEqual(active.parents, [`${old.id}@1`]);
  const other = episode("city-other", "我现在住北京"); other.scope = { ...scope, userId: "another" };
  const distinct = await host.learnEpisode(other, { chat, confirmPersonal: trustedPersonal });
  assert.equal(distinct.records.find((r) => r.id === old.id && r.version === 2)!.state, "active");
  assert.ok(distinct.records.some((r) => r.text === "我现在住北京" && r.id !== old.id));
});

test("tool ok不等于任务成功；真实单调用失败只激活限定工具的warning观察", async () => {
  const input = episode("tools");
  saveToolCall({ call: "failed-call", session: "tools", ts: Date.now(), tool: "calc", args: {}, result: "invalid input", status: "error", ms: 1 });
  input.toolRecords = [{ call: "failed-call", tool: "calc", result: "invalid input", status: "error" }];
  input.outcome = "failure";
  const e = host.recordEpisode(input);
  assert.equal(e.outcome.status, "unknown");
  const otherTurn = host.recordEpisode({ ...input, episodeId: "other-tool-turn" });
  assert.equal(otherTurn.evidence.find((proof) => proof.origin === "tool")!.verified, false);
  const learned = await host.learnEpisode(e, { chat: async (request) => {
    const body = JSON.parse(String(request.messages.at(-1)!.content));
    const proof = body.evidence.find((p: { origin: string }) => p.origin === "tool");
    return result({ items: [{ kind: "experience", text: "模型猜测所有计算任务都会失败", zone: "warning", tools: ["calc"], evidenceIds: [proof.id] }] });
  } });
  const warning = learned.records.find((r) => r.validation.evaluator === "verified-tool-failure-observation")!;
  assert.equal(warning.state, "active");
  assert.match(warning.text, /不代表任务失败/);
  assert.ok(!warning.text.includes("所有计算任务都会失败"));
  assert.deepEqual(warning.conditions.tools, ["calc"]);
});

test("独立任务证据可评估经验；演化无baseline只candidate，可信对照才替代", async () => {
  const input = episode("reward");
  input.outcome = "success"; input.outcomeEvidenceIds = ["check"];
  input.taskEvidence = [{ id: "check", ref: "synthetic-verifier:answer", origin: "environment", observedAt: Date.now(), summary: "真实合成断言7===7", verified: true }];
  const chat = async (request: ChatRequest) => result(String(request.messages[0].content).startsWith("评审") ? { accepted: false, evidenceIds: ["check"] }
    : { items: [{ kind: "experience", text: "合成任务核对数字", tools: [], evidenceIds: ["check"] }] });
  const unassessed = await host.learnEpisode(input, { chat });
  assert.equal(unassessed.records.find((r) => r.text === "合成任务核对数字")!.state, "candidate");
  const assessedInput = episode("reward-assessed");
  assessedInput.outcome = input.outcome; assessedInput.outcomeEvidenceIds = input.outcomeEvidenceIds; assessedInput.taskEvidence = input.taskEvidence;
  const learned = await host.learnEpisode(assessedInput, { chat,
    evaluate: async () => ({ accepted: true, independent: true, evaluator: "synthetic-task-strategy-check", score: 1, evidence: input.taskEvidence! }) });
  const active = learned.records.find((r) => r.text === "合成任务核对数字" && r.state === "active")!;
  assert.equal(active.state, "active");
  const proposal = async () => result({ text: "核对固定任务的数字与出处", evidenceIds: ["check"], tools: [] });
  const candidate = await host.evolveMemory({ operation: "rewrite", keys: [`${active.id}@1`] }, { chat: proposal });
  assert.equal(candidate.status, "evolved");
  assert.equal(candidate.records.find((r) => r.id === active.id && r.version === 2)!.state, "candidate");
  assert.equal(candidate.records.find((r) => r.id === active.id && r.version === 1)!.state, "active");
  const verified = await host.evolveMemory({ operation: "rewrite", keys: [`${active.id}@1`] }, { chat: proposal,
    evaluate: async () => ({ accepted: true, independent: true, evaluator: "fixed-task-comparison", score: 1, baselineScore: 1, evidence: input.taskEvidence! }) });
  assert.equal(verified.records.find((r) => r.id === active.id && r.version === 1)!.state, "superseded");
  assert.equal(verified.records.find((r) => r.id === active.id && r.version === 3)!.state, "active");
});

test("默认quick独立语义评审共享预算，只采用宿主真实结果来源，不接受模型伪造verified", async () => {
  for (const forged of [false, true]) {
    const input = episode(`semantic-${forged}`, "固定任务：核对七等于七");
    input.outcome = "success"; input.outcomeEvidenceIds = ["semantic-proof"];
    input.taskEvidence = [{ id: "semantic-proof", ref: "synthetic:7===7", origin: "environment", observedAt: Date.now(), summary: "七等于七的固定断言通过", verified: true }];
    let calls = 0;
    const learned = await host.learnEpisode(input, { chat: async (request) => {
      calls++;
      if (String(request.messages[0].content).startsWith("评审")) {
        const payload = JSON.parse(String(request.messages[1].content));
        assert.equal(payload.independentOutcome[0].id, "semantic-proof");
        return result({ accepted: true, evidenceIds: [forged ? "invented" : "semantic-proof"], verified: true, independent: true });
      }
      return result({ items: [{ kind: "experience", text: `固定合成断言核对观察 ${forged}`, evidenceIds: ["semantic-proof"] }] });
    } });
    assert.equal(calls, 2); assert.equal(learned.status, "learned");
    const memory = learned.records.find((r) => r.text === `固定合成断言核对观察 ${forged}`)!;
    assert.equal(memory.state, forged ? "candidate" : "active");
    assert.equal(memory.validation.evaluator, "host-grounded-semantic-faithfulness");
    assert.ok(!memory.evidence.some((e) => e.id === "invented"));
  }
});

test("真实用户对已完成轨迹的晚到反馈可重新评价，不重跑生产工具", async () => {
  const input = episode("feedback", "合成任务查到数字");
  const distill = async (request: ChatRequest) => {
    const e = JSON.parse(String(request.messages.at(-1)!.content));
    return result({ items: [{ kind: "experience", text: "查数字后核对原始出处", evidenceIds: [e.evidence[0].id] }] });
  };
  const initial = await host.learnEpisode(input, { chat: distill });
  assert.equal(initial.records.find((r) => r.text === "查数字后核对原始出处")!.state, "candidate");
  await new Promise((resolve) => setTimeout(resolve, 5));
  const message = addMessage("user", "test", "刚才结果正确", { session: input.session });
  const reviewed = await host.learnEpisode({ ...input, feedback: { text: "刚才结果正确", sourceRef: `message:${message}`, verified: true, status: "success" } }, { chat: distill,
    evaluate: async ({ episode: e }) => ({ accepted: true, independent: true, evaluator: "trusted-feedback-strategy-check", score: 1,
      evidence: e!.evidence.filter((source) => e!.outcome.evidenceIds.includes(source.id)) }) });
  assert.equal(reviewed.episode.outcome.status, "success");
  assert.ok(reviewed.records.some((r) => r.text === "查数字后核对原始出处" && r.state === "active"));
  assert.ok(reviewed.records.some((r) => r.validation.evaluator === "trusted-feedback-strategy-check"));
});

test("预算、硬超时与急停阻止学习继续，不影响既有记忆", async () => {
  let calls = 0;
  const budget = await host.learnEpisode(episode("budget"), { maxTotalTokens: 1, chat: async () => { calls++; return result({ items: [] }); } });
  assert.equal(budget.status, "failed"); assert.equal(calls, 0);
  const timeout = await host.learnEpisode(episode("timeout"), { timeoutMs: 30, chat: async () => new Promise(() => {}) });
  assert.equal(timeout.status, "failed");
  const stopped = episode("stop");
  fs.writeFileSync(paths.stop, "合成急停");
  try { await assert.rejects(host.learnEpisode(stopped, { chat: factChat })); }
  finally { fs.rmSync(paths.stop); }
  assert.ok(kv.get("prime.budget", { tokens: 0 }).tokens > 0);
});
