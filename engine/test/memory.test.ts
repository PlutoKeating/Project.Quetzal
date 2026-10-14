import test from "node:test";
import assert from "node:assert/strict";
import { createMemoryCandidate, assessMemory, installMemory, selectMemory, retrieveMemory, archiveMemory, rollbackMemory, upsertConfirmedMemory, memoryKey, validateMemoryRecord,
  type MemoryDraft, type MemoryEvidence, type MemoryRecord } from "../src/memory.ts";

const source: MemoryEvidence = { id: "source", ref: "episode/1", origin: "tool", observedAt: 10, summary: "核对预算后任务通过", verified: true };
const evaluation: MemoryEvidence = { id: "evaluation", ref: "test/1", origin: "environment", observedAt: 20, summary: "独立任务比对通过", verified: true };
const draft = (id = "exp"): MemoryDraft => ({ id, kind: "experience", text: "先确认预算再搜索", scope: { agentId: "agent-a", userId: "owner" },
  conditions: { requiredTags: ["planning"], excludedTags: ["urgent"], tools: ["search"] }, stage: "exploration", zone: "golden", evidenceIds: [source.id] });
const candidate = () => createMemoryCandidate(draft(), [source], 10);
const active = () => assessMemory(candidate(), { accepted: true, independent: true, evaluator: "fixture", score: 1, evidence: [evaluation] }, 20, 0.8);
const query = { scope: { agentId: "agent-a", userId: "owner" }, text: "预算", now: 30, stage: "exploration" as const, tags: ["planning"], tools: ["search"], limit: 4 };

test("来源、偏好性质和验证必需；旧笔记与模型自述不自动激活", () => {
  const c = candidate(); assert.equal(c.state, "candidate"); assert.equal(selectMemory([c], query).length, 0);
  assert.throws(() => createMemoryCandidate({ ...draft(), evidenceIds: ["invented"] }, [source], 10), /未知来源/);
  assert.throws(() => createMemoryCandidate({ ...draft(), kind: "preference", preference: "explicit" }, [source], 10), /用户来源/);
  const user = { ...source, origin: "user" as const };
  const preference = createMemoryCandidate({ ...draft(), kind: "preference", preference: "explicit" }, [user], 10);
  assert.equal(preference.preference, "explicit");
  const inferred = createMemoryCandidate({ ...draft(), kind: "preference", preference: "inferred" }, [source], 10);
  assert.equal(inferred.state, "candidate");
  for (const origin of ["agent", "document"] as const) {
    const rejected = assessMemory(c, { accepted: true, independent: true, evaluator: "model", score: 1, evidence: [{ ...evaluation, origin }] }, 20, 0.8);
    assert.equal(rejected.state, "candidate"); assert.equal(rejected.validation.status, "rejected");
  }
  assert.throws(() => validateMemoryRecord({ ...c, state: "active" }), /不能激活/);
});

test("检索同时过滤 scope、条件、阶段、有效期与状态，不将匹配关键词当真实性", () => {
  const record = active(); assert.equal(selectMemory([record], query).length, 1);
  assert.equal(selectMemory([record], { ...query, scope: { agentId: "other", userId: "owner" } }).length, 0);
  assert.equal(selectMemory([record], { ...query, scope: { agentId: "agent-a", userId: "other" } }).length, 0);
  assert.equal(selectMemory([record], { ...query, scope: { agentId: "agent-a" } }).length, 0);
  assert.equal(selectMemory([record], { ...query, tags: ["planning", "urgent"] }).length, 0);
  assert.equal(selectMemory([record], { ...query, tags: [] }).length, 0);
  assert.equal(selectMemory([record], { ...query, tools: [] }).length, 0);
  assert.equal(selectMemory([record], { ...query, stage: "completion" }).length, 0);
  assert.equal(selectMemory([record], { ...query, stage: "unknown" }).length, 0);
  assert.equal(selectMemory([{ ...record, validUntil: 30 }], query).length, 0);
  assert.equal(selectMemory([{ ...record, validFrom: 40 }], query).length, 0);
  assert.equal(selectMemory([{ ...record, scope: { ...record.scope, sessionId: "s" } }], query).length, 0);
  const found = selectMemory([record], query); found[0].text = "changed"; assert.equal(record.text, "先确认预算再搜索");
});

test("评估退化保持候选；归档不删除，恢复生成新版本与可审查父关系", () => {
  const c = candidate(); const old = active();
  assert.equal(assessMemory(c, { accepted: true, independent: true, evaluator: "test", score: 0.9, baselineScore: 1, evidence: [evaluation] }, 20, 0.8).state, "candidate");
  const archived = archiveMemory([old], memoryKey(old), 30);
  assert.equal(archived[0].state, "archived"); assert.deepEqual(archived[0].evidence, old.evidence);
  const restored = rollbackMemory(archived, memoryKey(old), 40);
  assert.equal(restored.length, 2); assert.equal(restored[1].version, 2); assert.equal(restored[1].state, "active");
  assert.ok(restored[1].parents.includes(memoryKey(old))); assert.equal(archived[0].state, "archived");
});

test("等价重复记忆合并证据；版本替代只在激活后发生，不能重写证据", () => {
  const old = active();
  const duplicate: MemoryRecord = { ...structuredClone(old), id: "duplicate", text: "  先确认预算再搜索  ", evidence: [...old.evidence, { ...source, id: "additional", ref: "episode/2" }] };
  const deduplicated = installMemory([old], duplicate);
  assert.equal(deduplicated.length, 1); assert.equal(deduplicated[0].evidence.length, 3);
  const newer = { ...structuredClone(old), version: 2, text: "先确认预算和约束再搜索", parents: [memoryKey(old)], updatedAt: 30 };
  const installed = installMemory([old], newer, [memoryKey(old)]);
  assert.equal(installed[0].state, "superseded"); assert.equal(installed[1].state, "active");
  assert.throws(() => installMemory([old], { ...newer, state: "candidate" }, [memoryKey(old)]), /未激活/);
  assert.throws(() => installMemory([old], { ...duplicate, evidence: duplicate.evidence.map((e) => e.id === source.id ? { ...e, summary: "篡改" } : e) }), /不可改写/);
});

test("可信同槽位事实更新保留逻辑 id、来源和历史版本；同时间冲突只留候选", () => {
  const confirmed = (id: string, text: string, observedAt: number, validFrom: number, userId = "owner") => {
    const quote = { ...source, id: `quote-${id}`, ref: `message/${id}`, origin: "user" as const, observedAt, summary: text };
    const c = createMemoryCandidate({ ...draft(id), kind: "fact", text, slot: "residence.city", scope: { agentId: "agent-a", userId }, evidenceIds: [quote.id] }, [quote], validFrom);
    return assessMemory(c, { accepted: true, independent: true, evaluator: "explicit-user", score: 1, evidence: [quote] }, validFrom, 1);
  };
  const old = confirmed("city", "现在住在甲城", 10, 10);
  const input = [old]; const changed = upsertConfirmedMemory(input, confirmed("new", "现在改住乙城", 30, 30), 30);
  assert.equal(input[0].state, "active"); assert.equal(changed[0].state, "superseded");
  assert.equal(changed[1].id, "city"); assert.equal(changed[1].version, 2); assert.deepEqual(changed[1].parents, ["city@1"]);
  assert.deepEqual(changed[1].evidence.map((e) => e.id), ["quote-city", "quote-new"]);
  assert.equal(selectMemory(changed, { ...query, text: "乙城" }).length, 1);
  const conflict = upsertConfirmedMemory([old], confirmed("ambiguous", "现在住在丙城", 10, 30), 30);
  assert.equal(conflict[0].state, "active"); assert.equal(conflict[1].state, "candidate"); assert.equal(conflict[1].validation.status, "rejected");
  const otherUser = upsertConfirmedMemory([old], confirmed("other", "住乙城", 40, 40, "another"), 40);
  assert.ok(otherUser.every((r) => r.state === "active")); assert.equal(otherUser[1].id, "other");
  const noSlot = confirmed("unslotted", "我改变了住处", 40, 40); delete noSlot.slot;
  assert.equal(upsertConfirmedMemory([old], noSlot, 40)[0].state, "active");
});

test("事实槽位的更新不能靠更晚评价替代同时间原话，推断偏好不会覆盖明确偏好", () => {
  const quote = { ...source, origin: "user" as const, observedAt: 10 };
  const pref = { ...draft(), kind: "preference" as const, preference: "explicit" as const, slot: "communication.style" };
  const old = assessMemory(createMemoryCandidate(pref, [quote], 10), { accepted: true, independent: true, evaluator: "user", score: 1, evidence: [quote] }, 10, 1);
  const nextQuote = { ...quote, id: "quote-new", summary: "相反偏好" };
  const c = createMemoryCandidate({ ...pref, id: "new", text: "只要简短回答", evidenceIds: [nextQuote.id] }, [nextQuote], 30);
  const next = assessMemory(c, { accepted: true, independent: true, evaluator: "later", score: 1, evidence: [evaluation] }, 40, 1);
  const conflict = upsertConfirmedMemory([old], next, 40);
  assert.equal(conflict[0].state, "active"); assert.equal(conflict[1].state, "candidate");
  const inferred = { ...next, id: "inferred", preference: "inferred" as const };
  assert.equal(upsertConfirmedMemory([old], inferred, 40)[0].state, "active");
});

test("同文本候选不并入已确认活动记忆，也不污染其证据", () => {
  const old = active();
  const unconfirmed = createMemoryCandidate({ ...draft("story"), evidenceIds: ["story-source"] }, [{ ...source, id: "story-source", origin: "agent", verified: false }], 30);
  const records = installMemory([old], unconfirmed);
  assert.equal(records.length, 2); assert.equal(records[1].state, "candidate");
  assert.deepEqual(records[0].evidence, old.evidence);
  assert.equal(records[0].evidence.some((e) => e.id === "story-source"), false);
});

test("无词面重合可从合格短候选语义选择，返回完整克隆而非短视图", async () => {
  const record = { ...active(), kind: "preference" as const, preference: "explicit" as const, text: "偏爱红茶，习惯早餐饮用。".repeat(30),
    evidence: [...active().evidence, { ...source, id: "explicit", origin: "user" as const }] };
  assert.equal(selectMemory([record], { ...query, text: "早上喝点什么" }).length, 0);
  let calls = 0;
  const found = await retrieveMemory([record], { ...query, text: "早上喝点什么" }, { async select({ candidates }) {
    calls++; assert.equal(candidates.length, 1); assert.ok(candidates[0].text.length <= 256); return [candidates[0].key];
  } });
  assert.equal(calls, 1); assert.equal(found[0].text, record.text);
  found[0].text = "改动"; assert.notEqual(record.text, found[0].text);
});

test("语义选择不能绕 scope/阶段/条件/状态，非法键不透传且零命中不强塞记忆", async () => {
  const record = active(), other = { ...record, id: "foreign", scope: { agentId: "another" } };
  const gated = { ...record, id: "gated", conditions: { ...record.conditions, requiredTags: ["different"] } };
  const wrongStage = { ...record, id: "phase", stage: "completion" as const };
  const records = [record, other, gated, wrongStage, { ...candidate(), id: "candidate" }];
  const found = await retrieveMemory(records, query, { async select({ candidates }) {
    assert.deepEqual(candidates.map((c) => c.key), [memoryKey(record)]);
    return ["foreign@1", "gated@1", "candidate@1", "invented@1", memoryKey(record), memoryKey(record)];
  } });
  assert.deepEqual(found.map(memoryKey), [memoryKey(record)]);
  assert.deepEqual(await retrieveMemory(records, query, { async select() { return []; } }), []);
  assert.deepEqual(await retrieveMemory(records, query), selectMemory(records, query));
  assert.deepEqual(await retrieveMemory([gated], query, { async select() { throw new Error("不可调用"); } }), []);
});

test("有界分组配额保留长期偏好与近期经验，选择器修改短视图不能修改资格或来源", async () => {
  const make = (id: string, kind: "fact" | "preference" | "experience" | "episode", at: number): MemoryRecord => ({ ...active(), id, kind,
    ...(kind === "preference" ? { preference: "inferred" as const } : {}), text: `记录-${id}`, createdAt: at, updatedAt: at });
  const records = [make("old-preference", "preference", 1), ...Array.from({ length: 30 }, (_, i) => make(`fact-${i}`, "fact", 20 + i)),
    ...Array.from({ length: 30 }, (_, i) => make(`episode-${i}`, "episode", 60 + i))];
  const before = structuredClone(records);
  const found = await retrieveMemory(records, { ...query, text: "完全不同的问法", now: 100 }, { async select({ query: supplied, candidates }) {
    assert.equal(candidates.length, 20); assert.ok(candidates.some((c) => c.key === "old-preference@1"));
    assert.equal(candidates.filter((c) => c.kind === "episode").length, 10);
    supplied.scope.agentId = "another"; candidates[0].text = "污染";
    return ["old-preference@1"];
  } });
  assert.equal(found[0].scope.agentId, query.scope.agentId); assert.deepEqual(records, before);
});
