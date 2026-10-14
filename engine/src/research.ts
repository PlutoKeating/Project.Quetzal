// 受限研究运行器：每个样本独立环境，执行与评分均不依赖生产宿主。
import { runTurn, type TurnControl, type TurnEvent, type ToolResult, type ToolRecord, type RunResult } from "./loop.ts";
import type { Msg, ToolDef, ChatRequest, ChatResult, ToolCall } from "./types.ts";

export interface ResearchLimits {
  maxSteps: number; maxModelCalls: number; maxToolCalls: number;
  maxReportedTokens: number; maxOutputTokens: number; timeoutMs: number;
}
export type ResearchTermination = "completed" | "step_limit" | "model_call_limit" | "tool_call_limit" | "token_limit" | "timeout" | "cancelled" | "error";
export interface Assessment { status: "success" | "failure" | "unknown"; score: number | null; evidence: string[] }
export interface ResearchTrace {
  events: TurnEvent[];
  models: { messages: Msg[]; response?: ChatResult }[];
  tools: ToolRecord[];
}
export interface ResearchSample {
  task: string; sample: number; termination: ResearchTermination;
  steps: number; modelCalls: number; toolCalls: number; reportedTokens: number;
  trace: ResearchTrace; result?: RunResult; assessment: Assessment; error?: string;
}
export interface ResearchEnvironment {
  messages: Msg[]; tools?: ToolDef[];
  chat(request: ChatRequest): Promise<ChatResult>;
  execute?(call: ToolCall, signal: AbortSignal): Promise<ToolResult>;
  redactArgs?(args: Record<string, unknown>): unknown;
  evaluate(sample: Readonly<ResearchSample>, signal: AbortSignal): Promise<Assessment>;
  cleanup(): void | Promise<void>;
}
export interface ResearchMetadata {
  datasetVersion?: string; modelVersion?: string; toolVersion?: string;
  strategyVersion?: string; experienceVersion?: string; seed?: number;
}
export interface ResearchOptions {
  task: string; samples: number; limits: ResearchLimits; signal?: AbortSignal;
  metadata?: Readonly<ResearchMetadata>;
  factory(input: { task: string; sample: number; signal: AbortSignal }): ResearchEnvironment | Promise<ResearchEnvironment>;
}
export interface ResearchGroup {
  task: string; samples: ResearchSample[];
  metadata: Readonly<ResearchMetadata>;
  limits: ResearchLimits;
  totals: { steps: number; modelCalls: number; toolCalls: number; reportedTokens: number; incompleteUsage: number; success: number; failure: number; unknown: number };
}
class ResearchStop extends Error {
  readonly termination: ResearchTermination;
  constructor(termination: ResearchTermination) { super(termination); this.termination = termination; }
}

/** 即使端口不响应取消，停止等待；不能终止端口已经发起的外部副作用。 */
function bounded<T>(work: () => T | Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(signal.reason);
    signal.addEventListener("abort", stop, { once: true });
    Promise.resolve().then(() => { if (signal.aborted) throw signal.reason; return work(); }).then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
  });
}

export async function runResearchGroup(options: ResearchOptions): Promise<ResearchGroup> {
  const limits = Object.freeze({ ...options.limits }), sampleCount = options.samples;
  const metadata = Object.freeze(structuredClone(options.metadata ?? {}));
  const required = { samples: sampleCount, maxSteps: limits.maxSteps, maxModelCalls: limits.maxModelCalls,
    maxToolCalls: limits.maxToolCalls, maxReportedTokens: limits.maxReportedTokens,
    maxOutputTokens: limits.maxOutputTokens, timeoutMs: limits.timeoutMs };
  for (const [name, value] of Object.entries(required)) {
    if (!Number.isSafeInteger(value) || value < (name === "maxToolCalls" ? 0 : 1)) throw new Error(`${name} 必须为有效的安全整数上限`);
  }
  if (limits.timeoutMs > 2_147_483_647) throw new Error("timeoutMs 超过定时器支持范围");
  const samples: ResearchSample[] = [], environments = new WeakSet<ResearchEnvironment>();
  for (let sample = 0; sample < sampleCount; sample++) {
    if (options.signal?.aborted) break;
    const ac = new AbortController();
    const stop = (reason: ResearchTermination) => { if (!ac.signal.aborted) ac.abort(new ResearchStop(reason)); };
    const externalStop = () => stop("cancelled");
    options.signal?.addEventListener("abort", externalStop, { once: true });
    const timer = setTimeout(() => stop("timeout"), limits.timeoutMs);
    const record: ResearchSample = {
      task: options.task, sample, termination: "error", steps: 0, modelCalls: 0, toolCalls: 0, reportedTokens: 0,
      trace: { events: [], models: [], tools: [] }, assessment: { status: "unknown", score: null, evidence: [] },
    };
    let env: ResearchEnvironment | undefined, cleaning: Promise<void> | undefined;
    const cleanup = (target: ResearchEnvironment) => cleaning ??= Promise.resolve().then(() => target.cleanup()).then(() => {});
    const check = () => { if (ac.signal.aborted) throw ac.signal.reason; };
    const limit = (used: number, max: number, reason: ResearchTermination) => { check(); if (used >= max) throw new ResearchStop(reason); };
    try {
      // 让事件循环有机会处理总超时；端口立即完成也不能无限占用微任务队列。
      const created = Promise.resolve().then(() => options.factory({ task: options.task, sample, signal: ac.signal }));
      void created.then((target) => { if (ac.signal.aborted) void cleanup(target).catch(() => {}); }, () => {});
      const target = await bounded(() => created, ac.signal);
      if (environments.has(target)) throw new Error("factory 必须为每个样本创建新的环境对象与状态");
      env = target;
      environments.add(env);
      let stepText = "";
      const turn: TurnControl = {
        id: `${options.task}/${sample}`, signal: ac.signal, get stepText() { return stepText; },
        check, touch() {}, flush() {}, endLLM() {}, delta(text) { stepText += text; },
        beginLLM() { stepText = ""; return ac.signal; },
        emit(event) {
          check();
          if (event.kind === "step") { limit(record.steps, limits.maxSteps, "step_limit"); record.steps++; }
          record.trace.events.push(structuredClone(event));
        },
        hold: (work) => bounded(work, ac.signal),
      };
      const environment = env;
      const tools = structuredClone(env.tools ?? []), allowedTools = new Set(tools.map((tool) => tool.name));
      record.result = await runTurn({ messages: structuredClone(env.messages), tools, turn, maxOutputTokens: limits.maxOutputTokens }, {
        async chat(request) {
          await bounded(() => new Promise<void>((resolve) => setTimeout(resolve, 0)), ac.signal);
          limit(record.modelCalls, limits.maxModelCalls, "model_call_limit");
          limit(record.reportedTokens, limits.maxReportedTokens, "token_limit");
          record.modelCalls++;
          const entry: ResearchTrace["models"][number] = { messages: structuredClone(request.messages) };
          record.trace.models.push(entry);
          const response = await bounded(() => environment.chat({ ...request, messages: structuredClone(request.messages), tools: structuredClone(request.tools) }), ac.signal);
          check();
          const used = response.usage.input + response.usage.output;
          if (![response.usage.input, response.usage.output].every((n) => Number.isSafeInteger(n) && n >= 0) || !Number.isSafeInteger(used)) throw new Error("模型用量报告必须为非负安全整数");
          record.reportedTokens += used;
          entry.response = structuredClone(response);
          if (record.reportedTokens > limits.maxReportedTokens) { stop("token_limit"); check(); }
          return structuredClone(response);
        },
        execute(call) {
          const work = bounded(() => {
            limit(record.toolCalls, limits.maxToolCalls, "tool_call_limit");
            record.toolCalls++;
            return allowedTools.has(call.name) && environment.execute ? environment.execute(structuredClone(call), ac.signal) : { text: "研究环境未提供该工具", status: "denied" as const };
          }, ac.signal);
          // 旧循环在 signal 已取消时可能不消费工具 promise；仍处理其拒绝。
          void work.catch(() => {});
          return work;
        },
        async drain() {}, pending: () => false, incoming: () => false, check,
        interrupted: () => false, stopToolWait: () => true, moved: () => undefined,
        cleanText: (text) => text, redactArgs: (args) => environment.redactArgs?.(args) ?? {},
        summarize: () => "研究工具调用",
        recordTool: (tool) => { record.trace.tools.push(structuredClone(tool)); }, warning() {},
      });
      record.termination = "completed";
      const assessment = await bounded(() => environment.evaluate(structuredClone(record), ac.signal), ac.signal);
      if (!["success", "failure", "unknown"].includes(assessment.status) || !(assessment.score === null || Number.isFinite(assessment.score)) || !Array.isArray(assessment.evidence) || !assessment.evidence.every((e) => typeof e === "string")) throw new Error("评分结果格式不合法");
      record.assessment = structuredClone(assessment);
    } catch (error) {
      record.termination = error instanceof ResearchStop ? error.termination : "error";
      stop(record.termination);
      record.error = error instanceof Error ? error.message : String(error);
      record.assessment = { status: "unknown", score: null, evidence: [`运行未完成独立评分：${record.termination}`] };
    } finally {
      clearTimeout(timer); options.signal?.removeEventListener("abort", externalStop);
      if (env) {
        // cleanup 必须调用；不合作的清理不能让研究调用永久悬挂。
        const cleanupControl = new AbortController();
        const cleanupTimer = setTimeout(() => cleanupControl.abort(new Error("cleanup timeout")), limits.timeoutMs);
        try { await bounded(() => cleanup(env!), cleanupControl.signal); }
        catch (error) { record.error = `${record.error ? record.error + "；" : ""}清理失败：${String(error)}`; }
        finally { clearTimeout(cleanupTimer); }
      }
    }
    samples.push(record);
  }
  const totals = { steps: 0, modelCalls: 0, toolCalls: 0, reportedTokens: 0, incompleteUsage: 0, success: 0, failure: 0, unknown: 0 };
  for (const sample of samples) {
    totals.steps += sample.steps; totals.modelCalls += sample.modelCalls; totals.toolCalls += sample.toolCalls; totals.reportedTokens += sample.reportedTokens;
    if (sample.trace.models.some((model) => !model.response)) totals.incompleteUsage++;
    totals[sample.assessment.status]++;
  }
  return { task: options.task, metadata, limits, samples, totals };
}
