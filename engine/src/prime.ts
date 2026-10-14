// PRIME：注入真实蒸馏／提案／独立评价端口，默认不把模型自述当作奖励。
import { createMemoryCandidate, assessMemory, installMemory, archiveMemory, mergeEvidence, memoryKey, validateMemoryRecord,
  type MemoryRecord, type MemoryDraft, type MemoryEvidence, type MemoryScope, type MemoryStage, type MemoryAssessment } from "./memory.ts";

export interface MemoryEpisode {
  id: string; scope: MemoryScope; startedAt: number; endedAt: number; stage: MemoryStage | "unknown";
  tags: string[]; tools: string[];
  turns: { role: "user" | "assistant" | "tool"; text: string; evidenceIds: string[] }[];
  evidence: MemoryEvidence[];
  outcome: { status: "success" | "failure" | "unknown"; evidenceIds: string[]; score?: number };
}
export interface PrimeEvaluationInput { candidate: MemoryRecord; parents: MemoryRecord[]; episode?: MemoryEpisode }
export interface PrimeLearningPorts {
  distill(episode: MemoryEpisode): Promise<MemoryDraft[]>;
  evaluate(input: PrimeEvaluationInput): Promise<MemoryAssessment>;
}
export type EvolutionOperation = "rewrite" | "generalize" | "combine" | "archive";
export interface EvolutionRequest { operation: EvolutionOperation; keys: string[]; now: number; minimumScore: number }
export interface PrimeEvolutionPorts {
  propose(input: { operation: Exclude<EvolutionOperation, "archive">; parents: MemoryRecord[] }): Promise<MemoryDraft>;
  evaluate(input: PrimeEvaluationInput): Promise<MemoryAssessment>;
}
const independent = (e: MemoryEvidence) => e.verified && e.origin !== "agent" && e.origin !== "document";
const sameScope = (a: MemoryScope, b: MemoryScope) => a.agentId === b.agentId && a.userId === b.userId;

export function validateEpisode(episode: MemoryEpisode): void {
  if (!episode.id || !episode.scope.agentId || !Number.isFinite(episode.startedAt) || !Number.isFinite(episode.endedAt)
    || episode.startedAt < 0 || episode.endedAt < episode.startedAt || !["exploration", "verification", "completion", "any", "unknown"].includes(episode.stage)
    || !["success", "failure", "unknown"].includes(episode.outcome.status)) throw new Error("轨迹身份、时间、阶段或结果不合法");
  const evidence = mergeEvidence(episode.evidence), ids = new Set(evidence.map((e) => e.id));
  for (const turn of episode.turns) if (!["user", "assistant", "tool"].includes(turn.role) || typeof turn.text !== "string" || turn.evidenceIds.some((id) => !ids.has(id))) throw new Error("轨迹轮次或来源引用不合法");
  if (episode.outcome.evidenceIds.some((id) => !ids.has(id)) || (episode.outcome.score !== undefined && !Number.isFinite(episode.outcome.score))) throw new Error("轨迹结果引用或分数不合法");
}
export function hasIndependentOutcome(episode: MemoryEpisode): boolean {
  return episode.outcome.status !== "unknown" && episode.evidence.some((e) => episode.outcome.evidenceIds.includes(e.id) && independent(e));
}

/** 真实异步蒸馏生成候选，证据必须引用原轨迹；无奖励时仍可提炼，但不宣称成功策略。 */
export async function distillEpisode(episode: MemoryEpisode, distill: PrimeLearningPorts["distill"], now: number): Promise<MemoryRecord[]> {
  validateEpisode(episode);
  const drafts = await distill(structuredClone(episode));
  if (!Array.isArray(drafts) || drafts.length > 32) throw new Error("蒸馏结果需为最多 32 项候选数组");
  const candidates: MemoryRecord[] = [];
  for (const draft of drafts) {
    if (!sameScope(draft.scope, episode.scope)) throw new Error("蒸馏不得改变 agent 或用户边界");
    if (draft.kind === "experience" && draft.zone === "preference") throw new Error("策略经验不能伪装为用户偏好");
    const candidate = createMemoryCandidate(draft, episode.evidence, now);
    if (candidates.some((old) => memoryKey(old) === memoryKey(candidate))) throw new Error("蒸馏候选 id 重复");
    candidates.push(candidate);
  }
  return candidates;
}

/** 仅策略经验进入自动验证闭环，个人事实／偏好留作候选，不改人格或 USER。 */
export async function learnEpisode(records: readonly MemoryRecord[], episode: MemoryEpisode, ports: PrimeLearningPorts,
  options: { now: number; minimumScore: number }): Promise<MemoryRecord[]> {
  let next = records.map((r) => { validateMemoryRecord(r); return structuredClone(r); });
  const candidates = await distillEpisode(episode, ports.distill.bind(ports), options.now);
  for (let candidate of candidates) {
    if (next.some((old) => old.id === candidate.id && old.version !== candidate.version)) throw new Error("已演化的记忆应通过演化接口更新");
    if (candidate.kind === "experience" && hasIndependentOutcome(episode)) {
      const assessment = await ports.evaluate({ candidate: structuredClone(candidate), parents: [], episode: structuredClone(episode) });
      // LLM 自述或普通文档不提供结果证据，哪怕 accepted=true 也不能激活。
      candidate = assessMemory(candidate, { ...assessment, independent: assessment.independent && assessment.evidence.some(independent) }, options.now, options.minimumScore);
    }
    next = installMemory(next, candidate);
  }
  return next;
}

/** 改写／泛化形成新版本；组合保留父经验；归档保留证据和历史，不以低频删除。 */
export async function evolveMemory(records: readonly MemoryRecord[], request: EvolutionRequest, ports: PrimeEvolutionPorts): Promise<MemoryRecord[]> {
  records.forEach(validateMemoryRecord);
  if (!["rewrite", "generalize", "combine", "archive"].includes(request.operation)) throw new Error("未知演化操作");
  if (!request.keys.length || new Set(request.keys).size !== request.keys.length) throw new Error("演化必须指定唯一父版本");
  const parents = request.keys.map((key) => {
    const record = records.find((r) => memoryKey(r) === key);
    if (!record || record.kind !== "experience" || record.state !== "active") throw new Error("只演化已激活的策略经验");
    return record;
  });
  if (request.operation === "archive") return request.keys.reduce((all, key) => archiveMemory(all, key, request.now), records.map((r) => structuredClone(r)));
  if (request.operation === "combine" ? parents.length < 2 : parents.length !== 1) throw new Error("组合至少两个父版本，改写／泛化仅一个父版本");
  if (parents.some((p) => !sameScope(p.scope, parents[0].scope))) throw new Error("不能组合不同 agent 或用户的经验");
  const proposal = await ports.propose({ operation: request.operation, parents: structuredClone(parents) });
  if (proposal.kind !== "experience" || !sameScope(proposal.scope, parents[0].scope) || proposal.zone === "preference") throw new Error("演化不得改个人事实、偏好或跨用户泛化");
  const combine = request.operation === "combine";
  if (combine ? records.some((r) => r.id === proposal.id) : proposal.id !== parents[0].id) throw new Error("组合需新 id，改写／泛化保留原 id");
  const version = combine ? 1 : Math.max(...records.filter((r) => r.id === proposal.id).map((r) => r.version)) + 1;
  const evidence = mergeEvidence(...parents.map((p) => p.evidence));
  let candidate = createMemoryCandidate(proposal, evidence, request.now, request.keys, version);
  candidate.evidence = evidence; // 不允许提案选择性丢弃失败证据或父版本来源。
  const assessment = await ports.evaluate({ candidate: structuredClone(candidate), parents: structuredClone(parents) });
  // 演化必须对照旧库；没有 baseline 分数或独立证据只能保留候选。
  const independentAssessment = { ...assessment, independent: assessment.independent && assessment.baselineScore !== undefined && assessment.evidence.some(independent) };
  candidate = assessMemory(candidate, independentAssessment, request.now, request.minimumScore);
  return installMemory(records, candidate, candidate.state === "active" && !combine ? request.keys : []);
}
