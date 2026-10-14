// 结构化记忆：纯状态变迁和检索；持久化、身份与灵魂同步由宿主负责。
import { rank } from "./retrieval.ts";

export type MemoryKind = "fact" | "preference" | "episode" | "experience";
export type MemoryState = "candidate" | "active" | "superseded" | "archived";
export type MemoryStage = "exploration" | "verification" | "completion" | "any";
export type MemoryZone = "golden" | "warning" | "preference";
export interface MemoryScope { agentId: string; userId?: string; sessionId?: string; taskType?: string }
export interface MemoryConditions { requiredTags: string[]; excludedTags: string[]; tools: string[] }
export interface MemoryEvidence {
  id: string; ref: string; origin: "user" | "tool" | "environment" | "document" | "evaluator" | "agent";
  observedAt: number; summary: string; verified: boolean;
}
export interface MemoryValidation {
  status: "unverified" | "verified" | "rejected";
  assessedAt?: number; evaluator?: string; score?: number; baselineScore?: number; evidenceIds: string[];
}
export interface MemoryRecord {
  id: string; version: number; kind: MemoryKind; state: MemoryState; text: string;
  scope: MemoryScope; createdAt: number; updatedAt: number; validFrom: number; validUntil?: number;
  slot?: string;
  conditions: MemoryConditions; stage: MemoryStage; zone: MemoryZone;
  preference?: "explicit" | "inferred"; parents: string[]; evidence: MemoryEvidence[];
  validation: MemoryValidation;
}
export interface MemoryDraft {
  id: string; kind: MemoryKind; text: string; scope: MemoryScope;
  conditions: MemoryConditions; stage: MemoryStage; zone: MemoryZone;
  preference?: "explicit" | "inferred"; validUntil?: number; evidenceIds: string[];
  slot?: string;
}
export interface MemoryQuery {
  scope: MemoryScope; text: string; now: number; stage: MemoryStage | "unknown"; tags: string[]; tools: string[]; limit: number;
}
export interface MemoryAssessment {
  accepted: boolean; independent: boolean; evaluator: string;
  score: number; baselineScore?: number; evidence: MemoryEvidence[];
}
export const memoryKey = (record: Pick<MemoryRecord, "id" | "version">) => `${record.id}@${record.version}`;
const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string" && x.length > 0);
const nonempty = (v: unknown): v is string => typeof v === "string" && !!v.trim();
const time = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0;

export function validateMemoryEvidence(value: unknown): asserts value is MemoryEvidence {
  if (!plain(value) || !nonempty(value.id) || !nonempty(value.ref) || !nonempty(value.summary) || !time(value.observedAt)
    || !["user", "tool", "environment", "document", "evaluator", "agent"].includes(String(value.origin)) || typeof value.verified !== "boolean") throw new Error("记忆来源证据不合法");
}

export function validateMemoryRecord(value: unknown): asserts value is MemoryRecord {
  if (!plain(value) || !nonempty(value.id) || !Number.isSafeInteger(value.version) || Number(value.version) < 1
    || !["fact", "preference", "episode", "experience"].includes(String(value.kind)) || !["candidate", "active", "superseded", "archived"].includes(String(value.state))
    || !nonempty(value.text) || value.text.length > 32_000 || !plain(value.scope) || !nonempty(value.scope.agentId)) throw new Error("记忆身份、内容或状态不合法");
  for (const key of ["userId", "sessionId", "taskType"]) if (value.scope[key] !== undefined && !nonempty(value.scope[key])) throw new Error("记忆 scope 不合法");
  if (value.slot !== undefined && (!nonempty(value.slot) || value.slot.length > 128 || !["fact", "preference"].includes(String(value.kind)))) throw new Error("事实槽位不合法");
  if (![value.createdAt, value.updatedAt, value.validFrom].every(time) || Number(value.updatedAt) < Number(value.createdAt)
    || (value.validUntil !== undefined && (!time(value.validUntil) || Number(value.validUntil) <= Number(value.validFrom)))) throw new Error("记忆时间不合法");
  if (!plain(value.conditions) || !strings(value.conditions.requiredTags) || !strings(value.conditions.excludedTags) || !strings(value.conditions.tools)
    || value.conditions.requiredTags.some((tag) => (value.conditions as MemoryConditions).excludedTags.includes(tag))
    || !["exploration", "verification", "completion", "any"].includes(String(value.stage)) || !["golden", "warning", "preference"].includes(String(value.zone))
    || !strings(value.parents)) throw new Error("记忆条件或阶段不合法");
  if (value.kind === "preference" && !["explicit", "inferred"].includes(String(value.preference))) throw new Error("偏好必须区分 explicit/inferred");
  if (!Array.isArray(value.evidence) || !value.evidence.length) throw new Error("记忆必须保留来源证据");
  const ids = new Set<string>();
  for (const e of value.evidence) {
    validateMemoryEvidence(e);
    if (ids.has(e.id)) throw new Error("记忆证据重复");
    ids.add(e.id);
  }
  if (value.kind === "preference" && value.preference === "explicit" && !value.evidence.some((e) => e.origin === "user" && e.verified)) throw new Error("显式偏好必须有已核对的用户来源");
  const v = value.validation;
  if (!plain(v) || !["unverified", "verified", "rejected"].includes(String(v.status)) || !strings(v.evidenceIds) || v.evidenceIds.some((id) => !ids.has(id))) throw new Error("验证信息不合法");
  const evidenceIds = v.evidenceIds;
  if (v.status === "verified" && (!time(v.assessedAt) || !nonempty(v.evaluator) || !Number.isFinite(v.score)
    || !evidenceIds.length || !value.evidence.some((e) => evidenceIds.includes(e.id) && e.verified && e.origin !== "agent" && (value.kind !== "experience" || e.origin !== "document")))) throw new Error("验证通过必须有独立来源证据");
  if (value.state === "active" && v.status !== "verified") throw new Error("未验证记忆不能激活");
}

/** 不把旧笔记正文或模型自述当作已核实事实；draft 引用只能来自调用方的来源清单。 */
export function createMemoryCandidate(draft: MemoryDraft, evidence: readonly MemoryEvidence[], now: number, parents: string[] = [], version = 1): MemoryRecord {
  const selected = evidence.filter((e) => draft.evidenceIds.includes(e.id));
  if (!draft.evidenceIds.length || draft.evidenceIds.some((id) => !selected.some((e) => e.id === id))) throw new Error("候选引用了未知来源证据");
  const record: MemoryRecord = { id: draft.id, version, kind: draft.kind, state: "candidate", text: draft.text.trim(),
    scope: structuredClone(draft.scope), createdAt: now, updatedAt: now, validFrom: now,
    ...(draft.validUntil !== undefined ? { validUntil: draft.validUntil } : {}),
    ...(draft.slot !== undefined ? { slot: draft.slot } : {}),
    conditions: structuredClone(draft.conditions), stage: draft.stage, zone: draft.zone,
    ...(draft.preference ? { preference: draft.preference } : {}), parents: [...parents], evidence: structuredClone(selected),
    validation: { status: "unverified", evidenceIds: [] } };
  validateMemoryRecord(record); return record;
}

export function assessMemory(record: MemoryRecord, assessment: MemoryAssessment, now: number, minimumScore: number): MemoryRecord {
  validateMemoryRecord(record);
  if (record.state !== "candidate") throw new Error("只评估候选版本");
  if (!Number.isFinite(minimumScore) || !Number.isFinite(assessment.score) || !nonempty(assessment.evaluator)
    || (assessment.baselineScore !== undefined && !Number.isFinite(assessment.baselineScore))) throw new Error("评估分数或评价者不合法");
  const evidence = mergeEvidence(record.evidence, assessment.evidence);
  const independent = assessment.evidence.filter((e) => e.verified && e.origin !== "agent" && (record.kind !== "experience" || e.origin !== "document"));
  const accepted = assessment.accepted === true && assessment.independent === true && independent.length > 0 && assessment.score >= minimumScore
    && (assessment.baselineScore === undefined || assessment.score >= assessment.baselineScore);
  const updated: MemoryRecord = { ...structuredClone(record), state: accepted ? "active" : "candidate", updatedAt: now, evidence,
    validation: { status: accepted ? "verified" : "rejected", assessedAt: now, evaluator: assessment.evaluator,
      score: assessment.score, ...(assessment.baselineScore !== undefined ? { baselineScore: assessment.baselineScore } : {}), evidenceIds: independent.map((e) => e.id) } };
  validateMemoryRecord(updated); return updated;
}

export function mergeEvidence(...sets: readonly (readonly MemoryEvidence[])[]): MemoryEvidence[] {
  const out = new Map<string, MemoryEvidence>();
  for (const set of sets) for (const evidence of set) {
    validateMemoryEvidence(evidence);
    const old = out.get(evidence.id);
    if (old && JSON.stringify(old) !== JSON.stringify(evidence)) throw new Error("同一证据 id 的内容不可改写");
    out.set(evidence.id, structuredClone(evidence));
  }
  return [...out.values()];
}
const normalized = (text: string) => text.trim().replace(/\s+/g, " ").toLowerCase();
export function sameMemory(a: MemoryRecord, b: MemoryRecord): boolean {
  const conditions = (r: MemoryRecord) => JSON.stringify([...[r.conditions.requiredTags, r.conditions.excludedTags, r.conditions.tools].map((values) => [...new Set(values)].sort())]);
  return a.kind === b.kind && a.preference === b.preference && a.stage === b.stage && a.zone === b.zone
    && a.slot === b.slot
    && (["agentId", "userId", "sessionId", "taskType"] as const).every((key) => a.scope[key] === b.scope[key])
    && a.validUntil === b.validUntil && conditions(a) === conditions(b) && normalized(a.text) === normalized(b.text);
}

/** 保留全部版本，激活新版本后才替代指定父版本。组合经验不自动删除其来源经验。 */
export function installMemory(records: readonly MemoryRecord[], record: MemoryRecord, replace: readonly string[] = []): MemoryRecord[] {
  records.forEach(validateMemoryRecord); validateMemoryRecord(record);
  const duplicate = records.find((old) => ((old.state === "active" && record.state === "active" && record.validation.status === "verified")
    || (old.state === "candidate" && record.state === "candidate")) && sameMemory(old, record));
  if (duplicate && !replace.length) return records.map((old) => memoryKey(old) === memoryKey(duplicate) ? { ...structuredClone(old), evidence: mergeEvidence(old.evidence, record.evidence) } : structuredClone(old));
  if (records.some((old) => memoryKey(old) === memoryKey(record))) throw new Error("记忆版本已经存在");
  if (replace.length && record.state !== "active") throw new Error("未激活候选不能替代现有记忆");
  for (const key of replace) if (!record.parents.includes(key) || !records.some((old) => memoryKey(old) === key && old.id === record.id && old.scope.agentId === record.scope.agentId && old.updatedAt <= record.updatedAt)) throw new Error("替代只能针对同一记忆的父版本，且时间不能倒退");
  const next = [...records.map((old) => replace.includes(memoryKey(old)) ? { ...structuredClone(old), state: "superseded" as const, updatedAt: record.updatedAt } : structuredClone(old)), structuredClone(record)];
  next.forEach(validateMemoryRecord); return next;
}
export function archiveMemory(records: readonly MemoryRecord[], key: string, now: number): MemoryRecord[] {
  if (!records.some((r) => memoryKey(r) === key)) throw new Error("归档版本不存在");
  return records.map((r) => { validateMemoryRecord(r); const next = memoryKey(r) === key ? { ...structuredClone(r), state: "archived" as const, updatedAt: now } : structuredClone(r); validateMemoryRecord(next); return next; });
}
export function rollbackMemory(records: readonly MemoryRecord[], key: string, now: number): MemoryRecord[] {
  const original = records.find((r) => memoryKey(r) === key);
  if (!original || original.validation.status !== "verified" || (original.validUntil !== undefined && original.validUntil <= now)) throw new Error("不能恢复未验证或已失效版本");
  const restored: MemoryRecord = { ...structuredClone(original), version: Math.max(...records.filter((r) => r.id === original.id).map((r) => r.version)) + 1,
    state: "active", createdAt: now, updatedAt: now, parents: [key] };
  const replace = records.filter((r) => r.id === original.id && r.state === "active").map(memoryKey);
  restored.parents.push(...replace.filter((parent) => parent !== key));
  return installMemory(records, restored, replace);
}

/** 同槽位的可信新事实生成原 id 的新版本；来源时间冲突只保存候选，不猜哪一版真。 */
export function upsertConfirmedMemory(records: readonly MemoryRecord[], incoming: MemoryRecord, now: number): MemoryRecord[] {
  records.forEach(validateMemoryRecord); validateMemoryRecord(incoming);
  const eligible = incoming.state === "active" && incoming.validation.status === "verified" && incoming.slot
    && (incoming.kind === "fact" || (incoming.kind === "preference" && incoming.preference === "explicit"));
  if (!eligible) return installMemory(records, incoming);
  const sameScope = (r: MemoryRecord) => (["agentId", "userId", "sessionId", "taskType"] as const).every((key) => r.scope[key] === incoming.scope[key]);
  const previous = records.filter((r) => r.state === "active" && r.slot === incoming.slot && sameScope(r));
  if (!previous.length) return installMemory(records, incoming);
  if (previous.length === 1 && sameMemory(previous[0], incoming)) return installMemory(records, incoming);
  const observedAt = (record: MemoryRecord) => {
    const evidence = record.evidence.filter((e) => e.verified && e.origin !== "agent" && record.validation.evidenceIds.includes(e.id));
    // 有用户原话时按原话观测时间判断，不能靠更晚的模型评价冒充更新的用户决定。
    const user = record.evidence.filter((e) => e.verified && e.origin === "user");
    return Math.max(...(user.length ? user : evidence).map((e) => e.observedAt));
  };
  const old = previous[0];
  const newer = previous.length === 1 && incoming.kind === old.kind && incoming.validFrom > old.validFrom
    && observedAt(incoming) > observedAt(old) && incoming.validFrom <= now && (incoming.validUntil === undefined || now < incoming.validUntil);
  const version = Math.max(...records.filter((r) => r.id === old.id).map((r) => r.version)) + 1;
  const revision: MemoryRecord = { ...structuredClone(incoming), id: old.id, version, createdAt: now, updatedAt: now,
    parents: [...new Set([...incoming.parents, memoryKey(old)])], evidence: mergeEvidence(old.evidence, incoming.evidence),
    ...(!newer ? { state: "candidate" as const, validation: { ...structuredClone(incoming.validation), status: "rejected" as const } } : {}) };
  return installMemory(records, revision, newer ? [memoryKey(old)] : []);
}

function eligibleMemory(records: readonly MemoryRecord[], query: MemoryQuery): MemoryRecord[] {
  if (!Number.isSafeInteger(query.limit) || query.limit < 0 || !time(query.now)) throw new Error("检索 limit 或时间不合法");
  return records.filter((record) => {
    validateMemoryRecord(record);
    return record.state === "active" && record.validation.status === "verified" && record.scope.agentId === query.scope.agentId
      && (["userId", "sessionId", "taskType"] as const).every((key) => !record.scope[key] || record.scope[key] === query.scope[key])
      && record.validFrom <= query.now && (record.validUntil === undefined || query.now < record.validUntil)
      && (record.stage === "any" || record.stage === query.stage)
      && record.conditions.requiredTags.every((tag) => query.tags.includes(tag)) && !record.conditions.excludedTags.some((tag) => query.tags.includes(tag))
      && record.conditions.tools.every((tool) => query.tools.includes(tool));
  });
}
function lexicalMemory(candidates: readonly MemoryRecord[], query: MemoryQuery): MemoryRecord[] {
  const docs = candidates.map((r) => ({ kind: "memory" as const, source: memoryKey(r), title: r.conditions.requiredTags.join(" "), text: r.text, mtime: r.updatedAt }));
  return query.text.trim() ? rank(query.text, docs, query.now).map((hit) => candidates.find((r) => memoryKey(r) === hit.source)!) : [...candidates].sort((a, b) => b.updatedAt - a.updatedAt);
}
export function selectMemory(records: readonly MemoryRecord[], query: MemoryQuery): MemoryRecord[] {
  return structuredClone(lexicalMemory(eligibleMemory(records, query), query).slice(0, query.limit));
}

export interface MemoryCandidateView {
  key: string; kind: MemoryKind; text: string; stage: MemoryStage; zone: MemoryZone; preference?: "explicit" | "inferred";
}
export interface MemoryRetrievalPorts {
  select(input: { query: MemoryQuery; candidates: MemoryCandidateView[] }): Promise<string[]>;
}
export interface MemoryRetrievalOptions { candidateLimit?: number; maxViewChars?: number }

/** 有界候选的语义选择；模型不能改变资格门禁或将短视图冒充原始记录。 */
export async function retrieveMemory(records: readonly MemoryRecord[], query: MemoryQuery, ports?: MemoryRetrievalPorts,
  options: MemoryRetrievalOptions = {}): Promise<MemoryRecord[]> {
  if (!ports) return selectMemory(records, query);
  const candidateLimit = options.candidateLimit ?? 20, maxViewChars = options.maxViewChars ?? 256;
  if (!Number.isSafeInteger(candidateLimit) || candidateLimit < 1 || candidateLimit > 20
    || !Number.isSafeInteger(maxViewChars) || maxViewChars < 1 || maxViewChars > 1000) throw new Error("语义候选数量或短视图上限不合法");
  const snapshot = structuredClone(query), eligible = structuredClone(eligibleMemory(records, snapshot));
  if (!eligible.length || !snapshot.limit) return [];
  const lexical = lexicalMemory(eligible, snapshot), recent = [...eligible].sort((a, b) => b.updatedAt - a.updatedAt);
  const personal = eligible.filter((r) => r.kind === "fact" || r.kind === "preference");
  const strategy = eligible.filter((r) => r.kind === "experience" || r.kind === "episode");
  const chosen = new Map<string, MemoryRecord>();
  const add = (list: readonly MemoryRecord[], count: number) => {
    let added = 0;
    for (const record of list) {
      if (added >= count || chosen.size >= candidateLimit) break;
      if (!chosen.has(memoryKey(record))) { chosen.set(memoryKey(record), record); added++; }
    }
  };
  const fill = (group: MemoryRecord[], quota: number, longTerm: boolean) => {
    const inGroup = new Set(group.map(memoryKey)), reserve = longTerm ? Math.min(2, Math.max(0, quota - 1)) : 0;
    const before = chosen.size;
    add(lexical.filter((r) => inGroup.has(memoryKey(r))), quota - reserve);
    // 旧的已知偏好／事实不被所有近期 episode 挤掉；选择器仍可以全部拒绝。
    if (reserve) add([...group].sort((a, b) => Number(b.kind === "preference") - Number(a.kind === "preference") || a.createdAt - b.createdAt), Math.min(reserve, quota - (chosen.size - before)));
    add(recent.filter((r) => inGroup.has(memoryKey(r))), Math.max(0, quota - (chosen.size - before)));
  };
  fill(personal, Math.ceil(candidateLimit / 2), true);
  fill(strategy, Math.floor(candidateLimit / 2), false);
  add(lexical, candidateLimit - chosen.size); add(recent, candidateLimit - chosen.size);
  const views: MemoryCandidateView[] = [...chosen].map(([key, record]) => ({ key, kind: record.kind, text: record.text.slice(0, maxViewChars),
    stage: record.stage, zone: record.zone, ...(record.preference ? { preference: record.preference } : {}) }));
  const keys = await ports.select({ query: structuredClone(snapshot), candidates: structuredClone(views) });
  if (!Array.isArray(keys) || keys.some((key) => typeof key !== "string")) throw new Error("语义选择器需返回记忆版本键数组");
  return structuredClone([...new Set(keys)].filter((key) => chosen.has(key)).slice(0, snapshot.limit).map((key) => chosen.get(key)!));
}
