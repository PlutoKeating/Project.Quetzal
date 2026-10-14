import test from "node:test";
import assert from "node:assert/strict";
import { learnEpisode, evolveMemory, type MemoryEpisode, type PrimeLearningPorts } from "../src/prime.ts";
import { selectMemory, memoryKey, rollbackMemory, type MemoryDraft, type MemoryEvidence, type MemoryRecord, type MemoryAssessment } from "../src/memory.ts";

const evidence: MemoryEvidence = { id: "observed", ref: "synthetic/task", origin: "environment", observedAt: 10, summary: "合成预算任务有独立标准答案", verified: true };
const episode = (): MemoryEpisode => ({ id: "episode", scope: { agentId: "agent", userId: "owner" }, startedAt: 1, endedAt: 10, stage: "exploration", tags: ["planning"], tools: ["search"],
  turns: [{ role: "user", text: "先确认预算", evidenceIds: [evidence.id] }], evidence: [structuredClone(evidence)], outcome: { status: "success", evidenceIds: [evidence.id], score: 1 } });
const draft = (id = "exp"): MemoryDraft => ({ id, kind: "experience", text: "先确认预算再搜索", scope: episode().scope, conditions: { requiredTags: ["planning"], excludedTags: [], tools: ["search"] }, stage: "exploration", zone: "golden", evidenceIds: [evidence.id] });
const assessment = (id = "check"): MemoryAssessment => ({ accepted: true, independent: true, evaluator: "synthetic-rubric", score: 1, baselineScore: 0,
  evidence: [{ ...evidence, id, ref: `evaluation/${id}`, observedAt: 20, summary: "独立场景比对：预算约束已确认" }] });
const scenarioScore = (lesson: string) => {
  let budgetKnown = false;
  const confirmBudget = () => { budgetKnown = true; };
  const search = () => ({ matchesBudget: budgetKnown });
  if (lesson.includes("先确认预算")) confirmBudget();
  return search().matchesBudget ? 1 : 0;
};
const ports = (): PrimeLearningPorts => ({ async distill() { return [draft()]; }, async evaluate(input) { return { ...assessment(), score: scenarioScore(input.candidate.text) }; } });

// 评价环境的标准答案与模型输出分离，库中指导策略决定先确认还是先搜索。
const taskScore = (records: readonly MemoryRecord[]) => {
  const selected = selectMemory(records, { scope: episode().scope, text: "预算", now: 30, stage: "exploration", tags: ["planning"], tools: ["search"], limit: 3 });
  return scenarioScore(selected.map((r) => r.text).join("\n"));
};

test("真实异步蒸馏—独立验证—激活—检索闭环，对照未学习库", async () => {
  let distilled = 0, evaluated = 0;
  const learned = await learnEpisode([], episode(), { async distill(input) { distilled++; assert.equal(input.id, "episode"); return [draft()]; },
    async evaluate(input) { evaluated++; assert.equal(input.candidate.state, "candidate"); return { ...assessment(), score: scenarioScore(input.candidate.text) }; } }, { now: 20, minimumScore: 0.8 });
  assert.equal(distilled, 1); assert.equal(evaluated, 1); assert.equal(learned[0].state, "active");
  assert.equal(taskScore([]), 0); assert.equal(taskScore(learned), 1);
  assert.deepEqual(learned[0].evidence.map((e) => e.id), ["observed", "check"]);
});

test("同一轨迹重复学习合并等价经验，不创建重复活动记录", async () => {
  const learned = await learnEpisode([], episode(), ports(), { now: 20, minimumScore: 0.8 });
  const repeated = await learnEpisode(learned, episode(), ports(), { now: 30, minimumScore: 0.8 });
  assert.equal(repeated.length, 1); assert.equal(repeated[0].state, "active");
});

test("未知结果、模型自述成功、笔记资料都只能候选，不能当 reward", async () => {
  for (const variant of ["unknown", "agent", "document"] as const) {
    const input = episode();
    if (variant === "unknown") input.outcome.status = "unknown"; else input.evidence[0].origin = variant;
    let evaluated = 0;
    const learned = await learnEpisode([], input, { async distill() { return [draft()]; }, async evaluate() { evaluated++; return assessment(); } }, { now: 20, minimumScore: 0.8 });
    assert.equal(learned[0].state, "candidate"); assert.equal(evaluated, 0);
  }
});

test("事实与偏好不被自动激活，蒸馏不能跨用户或发明来源", async () => {
  const personal = ports(); personal.distill = async () => [{ ...draft(), kind: "fact" }, { ...draft("pref"), kind: "preference", preference: "inferred", zone: "preference" }];
  personal.evaluate = async () => { throw new Error("不应自动评估个人事实"); };
  const records = await learnEpisode([], episode(), personal, { now: 20, minimumScore: 0.8 });
  assert.ok(records.every((r) => r.state === "candidate"));
  const cross = ports(); cross.distill = async () => [{ ...draft(), scope: { agentId: "agent", userId: "another" } }];
  await assert.rejects(learnEpisode([], episode(), cross, { now: 20, minimumScore: 0.8 }), /用户边界/);
  cross.distill = async () => [{ ...draft(), evidenceIds: ["hallucinated"] }];
  await assert.rejects(learnEpisode([], episode(), cross, { now: 20, minimumScore: 0.8 }), /未知来源/);
});

test("演化提案退化不替代；合格改写保留父版本，并可恢复原经验", async () => {
  const learned = await learnEpisode([], episode(), ports(), { now: 20, minimumScore: 0.8 });
  const original = structuredClone(learned);
  const evolutionPorts = { async propose() { return { ...draft(), text: "先确认预算及日期再搜索" }; }, async evaluate() { return { ...assessment("rewrite-check"), score: 0.5, baselineScore: 1 }; } };
  const rejected = await evolveMemory(learned, { operation: "rewrite", keys: [memoryKey(learned[0])], now: 30, minimumScore: 0.8 }, evolutionPorts);
  assert.equal(rejected[0].state, "active"); assert.equal(rejected[1].state, "candidate"); assert.equal(rejected[1].validation.status, "rejected");
  evolutionPorts.evaluate = async () => ({ ...assessment("rewrite-check"), score: 1, baselineScore: 1 });
  const updated = await evolveMemory(learned, { operation: "rewrite", keys: [memoryKey(learned[0])], now: 30, minimumScore: 0.8 }, evolutionPorts);
  assert.equal(updated[0].state, "superseded"); assert.equal(updated[1].state, "active"); assert.equal(updated[1].version, 2);
  assert.deepEqual(learned, original); assert.deepEqual(updated[1].parents, ["exp@1"]);
  const restored = rollbackMemory(updated, "exp@1", 40);
  assert.equal(restored.at(-1)!.version, 3); assert.equal(restored.at(-1)!.text, original[0].text);
});

test("泛化需独立对照，组合保留来源，归档不删除且不调用模型", async () => {
  const learned = await learnEpisode([], episode(), ports(), { now: 20, minimumScore: 0.8 });
  const second = { ...structuredClone(learned[0]), id: "second", text: "核对日期再搜索" };
  const proposed = { async propose() { return { ...draft("combined"), text: "先确认预算与核对日期再搜索", stage: "any" as const }; }, async evaluate() { return assessment("combined-check"); } };
  const combined = await evolveMemory([...learned, second], { operation: "combine", keys: ["exp@1", "second@1"], now: 30, minimumScore: 0.8 }, proposed);
  assert.equal(combined.length, 3); assert.ok(combined.every((r) => r.state === "active")); assert.deepEqual(combined[2].parents, ["exp@1", "second@1"]);
  assert.ok(combined[2].evidence.some((e) => e.id === "check"));
  const noBaseline = { async propose() { return { ...draft(), stage: "any" as const }; }, async evaluate() { const result = assessment(); delete result.baselineScore; return result; } };
  const generalized = await evolveMemory(learned, { operation: "generalize", keys: ["exp@1"], now: 30, minimumScore: 0.8 }, noBaseline);
  assert.equal(generalized[1].state, "candidate");
  const archived = await evolveMemory(learned, { operation: "archive", keys: ["exp@1"], now: 30, minimumScore: 0.8 }, { async propose() { throw new Error("不调用"); }, async evaluate() { throw new Error("不调用"); } });
  assert.equal(archived[0].state, "archived"); assert.equal(archived.length, 1);
});
