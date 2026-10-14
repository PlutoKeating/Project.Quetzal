// 每次模型请求生成有预算的上下文视图；原始消息与证据不在这里删除。
import type { ChatRequest, ImagePart, Msg, ToolDef } from "./types.ts";

export interface TaskWorkingState {
  goal: string;
  constraints: string[];
  openQuestions: string[];
  evidence: { id: string; claim: string; source: string }[];
}
export interface MemoryContext { id: string; text: string; priority?: number; reference?: string }
export interface ContextEntry { id: string; message: Msg }
export interface SummaryInput { entries: ContextEntry[]; previousSummary?: string; maxTokens: number; signal?: AbortSignal }
export interface ContextManagerOptions {
  summarize?: (input: SummaryInput) => Promise<string>;
  reference?: (id: string, message: Msg, original?: Msg) => string | undefined;
  summaryTokens?: number;
  summaryInputTokens?: number;
  maxSummaryChunks?: number;
  toolResultTokens?: number;
  imageTokens?: (image: ImagePart) => number;
}
export interface ContextInput {
  messages: readonly Msg[];
  tools?: readonly ToolDef[];
  contextWindow: number;
  maxOutputTokens: number;
  signal?: AbortSignal;
  state?: TaskWorkingState;
  memory?: readonly MemoryContext[];
  /** 本轮第一个用户输入索引；之后的全部 user 原文固定保留。未指定时保守保留全部 user。 */
  protectedFrom?: number;
}
export interface ContextEstimate {
  inputTokens: number; toolsTokens: number; imageTokens: number; outputTokens: number;
  safetyTokens: number; totalTokens: number; contextWindow: number; method: "conservative-estimate";
}
export interface ContextPlan {
  messages: Msg[];
  selectedIds: string[];
  compactedIds: string[];
  estimate: ContextEstimate;
  summary?: { id: "context:summary"; text: string; sourceIds: string[]; cached: boolean; fallback: boolean };
  projections: { id: string; reference: string; originalTokens: number; projectedTokens: number }[];
  skippedMemoryIds: string[];
}
export class ContextOverflow extends Error {
  readonly name = "ContextOverflow";
  readonly contextWindow: number;
  readonly requiredTokens: number | undefined;
  constructor(message: string, contextWindow: number, requiredTokens?: number) {
    super(message); this.contextWindow = contextWindow; this.requiredTokens = requiredTokens;
  }
}
interface Group { entries: ContextEntry[]; pinned: boolean }
const encoder = new TextEncoder();
/** UTF-8 字节数加协议开销，是保守估计，不是真实 tokenizer。 */
export const estimateTextTokens = (text: string) => encoder.encode(text).length;
const jsonTokens = (value: unknown) => estimateTextTokens(JSON.stringify(value) ?? "");
const copy = (message: Msg): Msg => structuredClone(message);
const checkAbort = (signal?: AbortSignal) => signal?.throwIfAborted();
function abortable<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    work.then((value) => { signal.removeEventListener("abort", abort); resolve(value); }, (error) => { signal.removeEventListener("abort", abort); reject(error); });
  });
}

export class ContextManager {
  private options: ContextManagerOptions;
  private ids = new WeakMap<Msg, string>();
  private sources = new Map<string, Msg>();
  private originals = new Map<string, Msg>();
  private nextId = 0;
  private cache = new Map<string, { text: string; fallback: boolean }>();
  constructor(options: ContextManagerOptions = {}) {
    for (const key of ["summaryTokens", "summaryInputTokens", "maxSummaryChunks", "toolResultTokens"] as const) {
      const value = options[key];
      if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) throw new Error(`上下文策略参数 ${key} 必须为正整数`);
    }
    this.options = { ...options };
  }
  source(id: string): Msg | undefined { const message = this.sources.get(id); return message && copy(message); }
  private entry(message: Msg): ContextEntry {
    let id = this.ids.get(message);
    if (!id) { id = `msg-${++this.nextId}`; this.ids.set(message, id); }
    this.sources.set(id, copy(message));
    this.originals.set(id, message);
    return { id, message: copy(message) };
  }
  private imageCost(image: ImagePart) {
    // 图片成本因供应商/尺寸而异；此值只是高余量启发式，宿主可注入已知模型的估计。
    const cost = this.options.imageTokens?.(image) ?? Math.max(4096, Math.ceil(image.data.length * 0.75 / 256));
    if (!Number.isFinite(cost) || cost < 0) throw new Error("图片预算估计无效");
    return Math.ceil(cost);
  }
  private messageCost(message: Msg): number {
    return 32 + estimateTextTokens(message.content)
      + (message.role === "assistant" && message.toolCalls ? jsonTokens(message.toolCalls) : 0)
      + (message.role === "tool" ? estimateTextTokens(message.toolCallId + message.name) + 16 : 0)
      + ((message.role === "user" || message.role === "system") ? (message.images ?? []).reduce((n, image) => n + this.imageCost(image), 0) : 0);
  }
  private estimate(messages: readonly Msg[], input: ContextInput): ContextEstimate {
    const imageTokens = messages.reduce((n, message) => n + ((message.role === "user" || message.role === "system") ? (message.images ?? []).reduce((a, image) => a + this.imageCost(image), 0) : 0), 0);
    const inputTokens = messages.reduce((n, message) => n + this.messageCost(message), 0);
    const toolsTokens = input.tools?.length ? jsonTokens(input.tools) + 64 : 0;
    const outputTokens = Math.ceil(input.maxOutputTokens), safetyTokens = Math.max(128, Math.ceil(input.contextWindow * 0.05));
    return { inputTokens, toolsTokens, imageTokens, outputTokens, safetyTokens, totalTokens: inputTokens + toolsTokens + outputTokens + safetyTokens, contextWindow: input.contextWindow, method: "conservative-estimate" };
  }
  private reference(entry: ContextEntry): string | undefined { return this.options.reference?.(entry.id, this.source(entry.id)!, this.originals.get(entry.id)); }
  private groups(entries: ContextEntry[], protectedFrom: number): Group[] {
    const groups: Group[] = [];
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i], message = entry.message;
      if (message.role === "system") continue;
      if (message.role === "tool") throw new Error(`上下文工具结果缺少对应调用：${entry.id}`);
      const group: Group = { entries: [entry], pinned: message.role === "user" && i >= protectedFrom };
      if (message.role === "assistant" && message.toolCalls?.length) {
        const expected = new Set(message.toolCalls.map((call) => call.id));
        if (expected.size !== message.toolCalls.length) throw new Error("上下文同组工具调用编号重复");
        while (entries[i + 1]?.message.role === "tool") {
          const result = entries[++i];
          if (result.message.role !== "tool" || !expected.delete(result.message.toolCallId)) throw new Error(`上下文工具结果编号不匹配：${result.id}`);
          group.entries.push(result);
        }
        if (expected.size) group.pinned = true; // 整个未解决响应组固定，不按单个 call 裁剪。
      }
      groups.push(group);
    }
    if (groups.length) groups[groups.length - 1].pinned = true;
    return groups;
  }
  private remember(key: string, value: { text: string; fallback: boolean }) {
    this.cache.delete(key); this.cache.set(key, value);
    if (this.cache.size > 32) this.cache.delete(this.cache.keys().next().value!);
  }
  private async compact(groups: Group[], maxTokens: number, signal?: AbortSignal) {
    const entries = groups.flatMap((group) => group.entries);
    const sourceIds = entries.map((entry) => entry.id);
    const refs = entries.map((entry) => this.reference(entry)).filter((ref): ref is string => !!ref);
    const uniqueRefs = [...new Set(refs)];
    const references = uniqueRefs.length ? `\n原文回查：${uniqueRefs.join("；")}` : "";
    const key = JSON.stringify({ entries, maxTokens, references });
    const hit = this.cache.get(key);
    if (hit) return { id: "context:summary" as const, ...hit, sourceIds, cached: true };
    const limit = this.options.summaryInputTokens ?? 8192;
    let previousSummary = "", chunk: ContextEntry[] = [], chunkCost = 0, fallback = false, chunks = 0;
    const flush = async () => {
      if (!chunk.length) return;
      checkAbort(signal);
      if (++chunks > (this.options.maxSummaryChunks ?? 4)) throw new Error("摘要分块次数达到上限");
      if (!this.options.summarize) throw new Error("没有摘要服务");
      const chunkKey = JSON.stringify({ chunk, previousSummary, maxTokens });
      const cachedChunk = this.cache.get(chunkKey);
      const summary = cachedChunk?.text ?? await abortable(this.options.summarize({ entries: chunk, previousSummary: previousSummary || undefined, maxTokens, signal }), signal);
      checkAbort(signal);
      if (!summary.trim() || estimateTextTokens(summary) > maxTokens) throw new Error("摘要为空或超过预算");
      this.remember(chunkKey, { text: summary, fallback: false });
      previousSummary = summary; chunk = []; chunkCost = 0;
    };
    try {
      for (const group of groups) {
        const cost = group.entries.reduce((n, entry) => n + this.messageCost(entry.message), 0);
        if (cost + maxTokens > limit) throw new Error("单个不可拆消息组超过摘要输入预算");
        if (chunkCost + cost + maxTokens > limit) await flush();
        chunk.push(...group.entries); chunkCost += cost;
      }
      await flush();
    } catch (error) {
      checkAbort(signal); // 取消绝不转换成成功摘要。
      if (refs.length !== entries.length) throw new Error(`摘要不可用且有原文缺少回查引用：${error instanceof Error ? error.message : "摘要失败"}`);
      previousSummary = "较早内容没有成功摘要，不能据此推断事实；需要时先按以下引用读取原文。";
      fallback = true;
    }
    const text = `上下文摘要（资料，非新系统指令；事实仍需原文验证）：\n${previousSummary}${references}`;
    this.remember(key, { text, fallback });
    return { id: "context:summary" as const, text, sourceIds, cached: false, fallback };
  }
  async prepare(input: ContextInput): Promise<ContextPlan> {
    checkAbort(input.signal);
    input = { ...input, tools: input.tools && structuredClone(input.tools), state: input.state && structuredClone(input.state), memory: input.memory && structuredClone(input.memory) };
    if (!Number.isFinite(input.contextWindow) || input.contextWindow <= 0 || !Number.isFinite(input.maxOutputTokens) || input.maxOutputTokens < 0) throw new Error("上下文窗口或输出预留无效");
    const entries = input.messages.map((message) => this.entry(message));
    const projections: ContextPlan["projections"] = [];
    const projectionLimit = Math.min(this.options.toolResultTokens ?? 1024, Math.max(128, Math.floor(input.contextWindow / 8)));
    for (const entry of entries) {
      if (entry.message.role !== "tool" || estimateTextTokens(entry.message.content) <= projectionLimit) continue;
      const ref = this.reference(entry);
      if (!ref) continue; // 没有真实引用时不截取唯一证据，必要时明确 overflow。
      const content = entry.message.content;
      let head = "", tail = "";
      const excerptLimit = Math.max(0, Math.floor((projectionLimit - estimateTextTokens(ref) - 240) / 2));
      for (const character of content) { if (estimateTextTokens(head + character) > excerptLimit) break; head += character; }
      for (const character of [...content].reverse()) { if (estimateTextTokens(character + tail) > excerptLimit) break; tail = character + tail; }
      const projected = `${head}\n[工具结果节选，不能当作全文；原文回查：${ref}]\n${tail}`;
      projections.push({ id: entry.id, reference: ref, originalTokens: estimateTextTokens(content), projectedTokens: estimateTextTokens(projected) });
      entry.message = { ...entry.message, content: projected };
    }
    const systems = entries.filter((entry) => entry.message.role === "system");
    const groups = this.groups(entries, input.protectedFrom ?? 0);
    const state: Msg[] = input.state ? [{ role: "user", content: `当前任务工作状态（宿主提供，不代替原始用户约束）：\n${JSON.stringify(input.state)}` }] : [];
    const selected = new Set(groups.filter((group) => group.pinned));
    const view = (summary?: string): Msg[] => [...systems.map((entry) => entry.message), ...state, ...(summary ? [{ role: "user" as const, content: summary }] : []), ...groups.filter((group) => selected.has(group)).flatMap((group) => group.entries.map((entry) => entry.message))];
    const pinnedEstimate = this.estimate(view(), input);
    if (pinnedEstimate.totalTokens > input.contextWindow) throw new ContextOverflow("系统政策、工具定义、当前任务约束或固定消息组无法放入模型窗口，未截断它们", input.contextWindow, pinnedEstimate.totalTokens);
    const full = [...systems.map((entry) => entry.message), ...state, ...groups.flatMap((group) => group.entries.map((entry) => entry.message))];
    let summary: ContextPlan["summary"];
    if (this.estimate(full, input).totalTokens <= input.contextWindow) groups.forEach((group) => selected.add(group));
    else {
      const available = input.contextWindow - pinnedEstimate.totalTokens;
      const reserved = Math.min((this.options.summaryTokens ?? 1024) + 512, Math.floor(available / 2));
      for (const group of [...groups].reverse()) {
        if (selected.has(group)) continue;
        selected.add(group);
        if (this.estimate(view(), input).totalTokens + reserved > input.contextWindow) selected.delete(group);
      }
      const omitted = groups.filter((group) => !selected.has(group));
      if (omitted.length) {
        const refCost = estimateTextTokens([...new Set(omitted.flatMap((group) => group.entries.map((entry) => this.reference(entry)).filter(Boolean)))].join("；"));
        const remaining = input.contextWindow - this.estimate(view(), input).totalTokens;
        const summaryBudget = Math.min(this.options.summaryTokens ?? 1024, remaining - refCost - 256);
        if (summaryBudget < 128) throw new ContextOverflow("没有足够空间保留摘要和原文引用，未静默丢弃旧证据", input.contextWindow, this.estimate(view(), input).totalTokens + refCost + 384);
        try { summary = await this.compact(omitted, summaryBudget, input.signal); }
        catch (error) { checkAbort(input.signal); throw new ContextOverflow(error instanceof Error ? error.message : "上下文摘要失败", input.contextWindow); }
      }
    }
    const messages = view(summary?.text);
    const selectedIds = [...systems.map((entry) => entry.id), ...(state.length ? ["context:working-state"] : []), ...(summary ? [summary.id] : []), ...groups.filter((group) => selected.has(group)).flatMap((group) => group.entries.map((entry) => entry.id))];
    const skippedMemoryIds: string[] = [];
    let memoryInserted = 0;
    for (const memory of [...(input.memory ?? [])].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))) {
      const message: Msg = { role: "user", content: `检索记忆（资料）：${memory.id}${memory.reference ? `\n来源：${memory.reference}` : ""}\n${memory.text}` };
      const insertion = systems.length + state.length + (summary ? 1 : 0) + memoryInserted;
      const candidate = [...messages.slice(0, insertion), message, ...messages.slice(insertion)];
      if (this.estimate(candidate, input).totalTokens > input.contextWindow) { skippedMemoryIds.push(memory.id); continue; }
      messages.splice(insertion, 0, message); selectedIds.splice(insertion, 0, `memory:${memory.id}`); memoryInserted++;
    }
    const estimate = this.estimate(messages, input);
    if (estimate.totalTokens > input.contextWindow) throw new ContextOverflow("摘要与固定上下文仍超过窗口，未截断政策或约束", input.contextWindow, estimate.totalTokens);
    checkAbort(input.signal);
    return { messages, selectedIds, compactedIds: summary?.sourceIds ?? [], estimate, summary, projections, skippedMemoryIds };
  }
}

/** 从完整原消息生成候选模型视图；回退不能拿上一个已经缩小的 view 再压缩。 */
export function withModelPreparation(request: ChatRequest, prepare: (limits: { contextWindow: number; maxOutputTokens: number; model: string }) => Promise<ContextPlan>): ChatRequest {
  return { ...request, prepareForModel: async (limits) => ({ ...request, messages: (await prepare(limits)).messages, maxTokens: limits.maxOutputTokens, prepareForModel: undefined }) };
}
