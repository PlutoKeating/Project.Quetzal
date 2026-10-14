import { documents } from './retrieval.ts';
// 结构化记忆的唯一持久真相仍是灵魂 notes/ 中的人可读 Markdown；索引与使用统计留本机。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { paths } from "../config.ts";
import { identity } from "./identity.ts";
import * as memory from "./memory.ts";
import * as soul from "./soul-sync.ts";
import { kv } from "../store.ts";
import { log } from "../log.ts";
import { validateMemoryRecord, createMemoryCandidate, assessMemory, installMemory, archiveMemory, rollbackMemory, sameMemory,
  selectMemory, memoryKey, type MemoryRecord, type MemoryDraft, type MemoryEvidence, type MemoryAssessment,
  type MemoryScope, type MemoryStage } from "../../../engine/src/memory.ts";

export type { MemoryRecord, MemoryDraft, MemoryEvidence, MemoryAssessment, MemoryScope, MemoryStage };
export const MEMORY_CATEGORY = "QuetzalMemory";
const FORMAT = "quetzal-memory-v1";
const recordId = /^[a-z0-9][a-z0-9_-]{0,43}$/;
const root = () => path.join(paths.soul, "notes", MEMORY_CATEGORY);
const fileOf = (record: Pick<MemoryRecord, "id" | "version">) => path.join(root(), `${record.id}_v${record.version}.md`);
const invalid = new Set<string>();

function safeDirectory() {
  for (const dir of [paths.soul, path.join(paths.soul, "notes"), root()]) {
    if (fs.existsSync(dir) && (!fs.lstatSync(dir).isDirectory() || fs.lstatSync(dir).isSymbolicLink())) throw new Error("结构化记忆目录不能是链接或普通文件");
  }
  fs.mkdirSync(root(), { recursive: true });
}

export function readStructuredRecords(): MemoryRecord[] {
  if (!fs.existsSync(root()) || fs.lstatSync(root()).isSymbolicLink()) return [];
  const records: MemoryRecord[] = [];
  for (const entry of fs.readdirSync(root(), { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md") || entry.name.includes(".incoming")) continue;
    const file = path.join(root(), entry.name);
    try {
      if (fs.statSync(file).size > 262_144) throw new Error("记忆文件过大");
      const text = fs.readFileSync(file, "utf8"), json = /\n```json\s*\n([\s\S]+?)\n```(?:\n|$)/.exec(text);
      if (!text.startsWith("# ") || !json) throw new Error("缺少记忆格式标记");
      const data: unknown = JSON.parse(json[1]);
      if (!data || typeof data !== "object" || !("format" in data) || data.format !== FORMAT || !("record" in data)) throw new Error("记忆格式版本不支持");
      validateMemoryRecord(data.record);
      const record = structuredClone(data.record);
      if (!recordId.test(record.id) || path.basename(fileOf(record)) !== entry.name) throw new Error("记忆文件与 id / version 不匹配");
      validateMemoryRecord(record);
      records.push(record);
    } catch (e) {
      // 保留原文件供裁决；不能将损坏或候选的 JSON 当旧笔记绕过状态门禁。
      if (!invalid.has(entry.name)) { log("memory", `跳过结构化记忆 ${entry.name}：${(e as Error).message}`); invalid.add(entry.name); }
    }
  }
  return records;
}

function markdown(record: MemoryRecord): string {
  validateMemoryRecord(record);
  if (!recordId.test(record.id)) throw new Error("记忆 id 只能使用有界的小写字母、数字、下划线与连字符");
  const title = `${record.kind} · ${record.id} · v${record.version}`;
  const text = `# ${title}\n\n> ${record.state} · ${record.text.replace(/\s+/g, " ").slice(0, 120)}\n\n\`\`\`json\n${JSON.stringify({ format: FORMAT, record }, null, 2)}\n\`\`\`\n\n${record.text}\n\n来源：${record.evidence.map((e) => e.ref).join("；")}\n`;
  if (Buffer.byteLength(text) > 262_144) throw new Error("结构化记忆文件超过大小上限");
  return text;
}
function writeRecord(record: MemoryRecord) {
  const text = markdown(record), file = fileOf(record);
  if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw new Error("记忆文件不能是符号链接");
  const tmp = `${file}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  try { fs.writeFileSync(tmp, text, { mode: 0o600 }); fs.renameSync(tmp, file); }
  finally { fs.rmSync(tmp, { force: true }); }
}

/** 全库更新在锁内重新读取；merge 冲突和并发学习不能覆盖彼此刚落盘的版本。 */
export async function updateStructuredRecords(change: (records: MemoryRecord[]) => MemoryRecord[], reason = "结构化记忆", signal?: AbortSignal): Promise<MemoryRecord[]> {
  signal?.throwIfAborted();
  if (fs.existsSync(paths.stop)) throw new Error("急停中，不更新记忆");
  const saved = await memory.exclusive(() => {
    signal?.throwIfAborted();
    if (fs.existsSync(paths.stop)) throw new Error("急停中，不更新记忆");
    const current = readStructuredRecords(), next = change(structuredClone(current)).map((record) => structuredClone(record));
    const keys = new Set<string>();
    for (const record of next) { markdown(record); if (keys.has(memoryKey(record))) throw new Error("结构化记忆版本重复"); keys.add(memoryKey(record)); }
    if (current.some((record) => !keys.has(memoryKey(record)))) throw new Error("历史记忆只能归档或替代，不能删除版本");
    safeDirectory();
    for (const record of next) {
      const old = current.find((r) => memoryKey(r) === memoryKey(record));
      if (!old || JSON.stringify(old) !== JSON.stringify(record)) writeRecord(record);
    }
    return next;
  });
  await soul.touched({ tool: reason }).catch((e) => log("memory", `记忆已保存，自动同步待重试：${(e as Error).message}`));
  return saved;
}

export async function recordMemory(draft: MemoryDraft, evidence: MemoryEvidence[], o: { now?: number; parents?: string[]; version?: number; signal?: AbortSignal } = {}): Promise<MemoryRecord> {
  const candidate = createMemoryCandidate(structuredClone(draft), structuredClone(evidence), o.now ?? Date.now(), o.parents, o.version);
  if (!recordId.test(candidate.id)) throw new Error("记忆 id 不合法");
  const records = await updateStructuredRecords((records) => {
    if (records.some((r) => r.id === candidate.id && (r.scope.agentId !== candidate.scope.agentId || r.scope.userId !== candidate.scope.userId))) throw new Error("同一记忆 id 不能改换 agent 或用户");
    if (candidate.version > 1 && (!candidate.parents.length || candidate.parents.some((key) => !records.some((r) => r.id === candidate.id && memoryKey(r) === key)))) throw new Error("记忆新版本必须引用同一记忆的父版本");
    return installMemory(records, candidate);
  }, "记录记忆候选", o.signal);
  return records.find((r) => memoryKey(r) === memoryKey(candidate)) ?? records.find((r) => sameMemory(r, candidate)) ?? candidate;
}

/** 评估证据由宿主提供，不能由 distill 模型自行宣称 verified。 */
export async function reviewMemory(key: string, assessment: MemoryAssessment, o: { now?: number; signal?: AbortSignal } = {}): Promise<MemoryRecord> {
  let assessed: MemoryRecord | undefined;
  await updateStructuredRecords((records) => {
    const record = records.find((r) => memoryKey(r) === key);
    if (!record) throw new Error("记忆候选不存在");
    assessed = assessMemory(record, structuredClone(assessment), o.now ?? Date.now(), 1);
    return records.map((r) => memoryKey(r) === key ? assessed! : assessed!.state === "active" && assessed!.parents.includes(memoryKey(r)) && r.id === assessed!.id
      ? { ...r, state: "superseded" as const, updatedAt: assessed!.updatedAt } : r);
  }, "验证记忆候选", o.signal);
  return assessed!;
}
export const archiveRecord = (key: string, signal?: AbortSignal) => updateStructuredRecords((records) => archiveMemory(records, key, Date.now()), "归档记忆", signal);
export const rollbackRecord = (key: string, signal?: AbortSignal) => updateStructuredRecords((records) => rollbackMemory(records, key, Date.now()), "恢复记忆版本", signal);

/** 旧材料只核实文件存在，不核实其断言；统一标为 episode/warning，不参与 golden 经验评估。 */
export function readLegacyRecords(scope: MemoryScope = { agentId: identity().id }): MemoryRecord[] {
  const sources: { ref: string; text: string; ts: number }[] = [];
  for (const kind of ["memory", "user"] as const) memory.entries(kind).forEach((text, index) => sources.push({ ref: `legacy:${kind}:${index}`, text, ts: 0 }));
  for (const note of memory.listNotes()) {
    if (note.name.split("/")[0].toLowerCase() === MEMORY_CATEGORY.toLowerCase()) continue;
    sources.push({ ref: `legacy:notes/${note.name}.md`, text: memory.readNote(note.name), ts: note.mtime });
  }
  for (const journal of documents(["journal"])) sources.push({ ref: `legacy:${journal.source}`, text: journal.text, ts: journal.mtime });
  return sources.map((source) => {
    const id = `legacy_${crypto.createHash("sha256").update(`${source.ref}\0${source.text}`).digest("hex").slice(0, 24)}`;
    const evidence: MemoryEvidence = { id: `${id}_source`, ref: source.ref, origin: "document", observedAt: source.ts, summary: "只核实旧材料存在，内容未经事实验证", verified: true };
    return { id, version: 1, kind: "episode", state: "active", text: `【旧记忆未核实，仅参考】\n${source.text}`.slice(0, 32_000),
      scope: { agentId: scope.agentId }, createdAt: source.ts, updatedAt: source.ts, validFrom: 0,
      conditions: { requiredTags: [], excludedTags: [], tools: [] }, stage: "any", zone: "warning", parents: [], evidence: [evidence],
      validation: { status: "verified", assessedAt: source.ts, evaluator: "legacy-material-exists", score: 1, evidenceIds: [evidence.id] } };
  });
}

export function getMemoryCandidates(query: string, scope: MemoryScope = { agentId: identity().id }, phase: MemoryStage | "unknown" = "unknown",
  o: { tags?: string[]; tools?: string[]; limit?: number; includeLegacy?: boolean } = {}): MemoryRecord[] {
  const records = [...readStructuredRecords(), ...(o.includeLegacy === false ? [] : readLegacyRecords(scope))];
  return selectMemory(records, { scope, text: query, now: Date.now(), stage: phase, tags: o.tags ?? [], tools: o.tools ?? [], limit: o.limit ?? 12 });
}
export function recordMemoryUse(keys: string[], episodeId: string) {
  const stats = kv.get<Record<string, { uses: number; lastEpisode: string; lastUsed: number }>>("memory.uses", {});
  for (const key of keys) stats[key] = { uses: (stats[key]?.uses ?? 0) + 1, lastEpisode: episodeId, lastUsed: Date.now() };
  kv.set("memory.uses", Object.fromEntries(Object.entries(stats).sort((a, b) => b[1].lastUsed - a[1].lastUsed).slice(0, 2000)));
}
