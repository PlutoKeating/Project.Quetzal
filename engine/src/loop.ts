// 通用模型—工具循环。宿主通过 ports 提供模型、工具、上下文、审计与停止策略。
import type { ChatRequest, ChatResult, Msg, ToolCall, ToolDef } from "./types.ts";

export interface Step { tool: string; args: unknown; result: string; status: string }
export interface ToolResult { text: string; status: "ok" | "error" | "denied" }
export interface ToolRecord { call: string; session: string; ts: number; tool: string; args: unknown; result: string; status: ToolResult["status"]; ms: number }
export type TurnEvent =
  | { kind: "step"; step: number }
  | { kind: "text"; step: number; text: string; final: boolean }
  | { kind: "tool"; call: string; name: string; summary: string; status: "running" | ToolResult["status"]; ms?: number; result?: string };

/** 轮次的生命周期协议。可由任意宿主实现，无需启动 Quetzal runtime。 */
export interface TurnControl {
  readonly id: string;
  readonly signal: AbortSignal;
  readonly stepText: string;
  check(): void;
  touch(): void;
  emit(event: TurnEvent): void;
  beginLLM(): AbortSignal;
  endLLM(): void;
  delta(text: string): void;
  flush(): void;
  hold<T>(work: () => Promise<T>): Promise<T>;
}
export interface EnginePorts {
  chat(request: ChatRequest): Promise<ChatResult>;
  execute(call: ToolCall): Promise<ToolResult>;
  drain(messages: Msg[]): Promise<void>;
  pending(): boolean;
  incoming(): boolean;
  check(): void;
  interrupted(error: unknown): boolean;
  stopToolWait(reason: unknown): boolean;
  moved(): Record<string, unknown> | undefined;
  cleanText(text: string): string;
  redactArgs(args: Record<string, unknown>): unknown;
  summarize(args: unknown): string;
  recordTool(record: ToolRecord): void;
  warning(message: string): void;
}
export interface FinishTool extends ToolDef { name: "finish" }
export interface RunOptions {
  messages: Msg[];
  turn: TurnControl;
  tools: readonly ToolDef[];
  finishTool?: FinishTool;
  maxOutputTokens: number | (() => number);
}
export interface RunResult { text: string; finish?: Record<string, any>; steps: Step[]; tokens: number; model: string }

/** 模型某一步什么也没输出时的提醒（基座的话，不是对方说的）。 */
const BLANK = "（基座提醒，不是对方说的话：你上一步什么也没有输出——没有调用工具，也没有文字。还要做事就接着调用工具；做完了就用文字回复对方：做了什么、发现了什么、结论或下一步。）";
const BLANK_TRUNCATED = "（基座提醒，不是对方说的话：你上一步的输出到了长度上限，没有留下任何给对方的文字。不要再长篇思考，直接用文字回复对方：做了什么、发现了什么、结论或下一步。）";

/** 等工具做完；对方停止了这一轮就不再等（shell 的命令随之结束；等批准、等保密输入这类工具留在后台自行超时）。 */
function untilStopped<T>(p: Promise<T>, s: TurnControl, ports: EnginePorts): Promise<T> {
  if (s.signal.aborted) return Promise.reject(s.signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => { if (ports.stopToolWait(s.signal.reason)) reject(s.signal.reason); };
    s.signal.addEventListener("abort", onAbort, { once: true });
    p.then((v) => { s.signal.removeEventListener("abort", onAbort); resolve(v); }, (e) => { s.signal.removeEventListener("abort", onAbort); reject(e); });
  });
}

export async function runTurn(options: RunOptions, ports: EnginePorts): Promise<RunResult> {
  const { messages, turn: s, tools, finishTool, maxOutputTokens } = options;
  if (finishTool && finishTool.name !== "finish") throw new Error("结束工具的名称必须为 finish");
  const withFinish = !!finishTool;
  const definitions = [...tools, ...(finishTool ? [finishTool] : [])];
  const steps: Step[] = [];
  let tokens = 0, text = "", finish: Record<string, any> | undefined, model = "", blanks = 0;
  const failures = new Map<string, number>(); // 这一轮里每个（工具, 参数）失败了几次
  for (let i = 0; !finish; i++) {
    s.check(); s.touch();
    ports.check();
    await ports.drain(messages);
    s.emit({ kind: "step", step: i + 1 });
    let r: ChatResult;
    try {
      r = await ports.chat({
        messages, tools: definitions, maxTokens: typeof maxOutputTokens === "function" ? maxOutputTokens() : maxOutputTokens, session: s.id,
        signal: s.beginLLM(), onChunk: () => s.touch(), onText: (t) => s.delta(t),
      });
    } catch (e) {
      if (!ports.interrupted(e) || s.signal.aborted) throw e;
      s.flush(); // 被打断：保留已经说出的部分，下一步带着对方的新消息继续
      const partial = ports.cleanText(s.stepText).trim();
      if (partial) messages.push({ role: "assistant", content: `${partial}\n（输出被对方打断）` });
      s.emit({ kind: "text", step: i + 1, text: partial ? `${partial}（被打断）` : "（被打断）", final: false });
      continue;
    } finally { s.endLLM(); }
    s.flush();
    r.text = ports.cleanText(r.text);
    tokens += r.usage.input + r.usage.output; model = r.model;
    // 一步什么也没给（没有工具调用、也没有文字）：多半是输出长度用完在思考上，或供应商回了空。对话里这不能算结束——
    // 不把空的一步放进上下文，提醒她一句再来，最多两次；仍然是空的才结束（converse 会说明这一轮没有回复）
    if (!withFinish && !r.toolCalls.length && !r.text.trim() && !ports.incoming() && blanks < 2) {
      blanks++;
      ports.warning(`第 ${i + 1} 步模型没有输出${r.truncated ? "（到了输出长度上限）" : ""}，提醒后重试（${blanks}/2）`);
      messages.push({ role: "user", content: r.truncated ? BLANK_TRUNCATED : BLANK });
      continue;
    }
    s.emit({ kind: "text", step: i + 1, text: r.text, final: !r.toolCalls.length });
    messages.push({ role: "assistant", content: r.text, toolCalls: r.toolCalls });
    if (!r.toolCalls.length) {
      // 回复只取结束这一轮的那一步：之前各步的文字已作为中途的话进了过程记录，拿来顶替空的最后一步，同一段话就会在过程与回复里各出现一次
      if (!ports.pending()) { text = r.text; break; }
      // 本想结束，但对方刚补充了消息：这段话留作过程中的叙述，接着处理新消息
      if (r.text.trim()) s.emit({ kind: "text", step: i + 1, text: r.text, final: false });
      continue;
    }
    for (const c of r.toolCalls) {
      const card = { call: c.id, name: c.name, summary: c.name === "finish" ? String(c.args.title ?? "") : ports.summarize(ports.redactArgs(c.args)) }; // 参数里的保密值不进进展事件与过程记录
      if (c.name === "finish") {
        finish = c.args; messages.push({ role: "tool", toolCallId: c.id, name: c.name, content: "好的" });
        s.emit({ kind: "tool", ...card, status: "ok", ms: 0 });
        continue;
      }
      s.emit({ kind: "tool", ...card, status: "running" });
      const t0 = Date.now();
      const out = await s.hold(() => untilStopped(ports.execute(c), s, ports)); // 执行工具即在工作：暂停会话时间墙；对方停止时不等工具做完
      s.emit({ kind: "tool", ...card, status: out.status, ms: Date.now() - t0, result: out.text.split("\n").find((l) => l.trim())?.slice(0, 120) ?? "" });
      steps.push({ tool: c.name, args: ports.redactArgs(c.args), result: out.text.slice(0, 1500), status: out.status });
      try { ports.recordTool({ call: c.id, session: s.id, ts: Date.now(), tool: c.name, args: ports.redactArgs(c.args), result: out.text, status: out.status, ms: Date.now() - t0 }); } catch (e) { ports.warning(`没能存下工具调用的完整记录：${(e as Error).message}`); }
      // 失败（含被拒绝）写在结果的最前面：只给原文时，「exit 1」之类的结果她容易当成做成了
      let content = out.text.slice(0, 12000);
      if (out.status !== "ok") {
        const same = JSON.stringify([c.name, c.args]);
        const n = (failures.get(same) ?? 0) + 1;
        failures.set(same, n);
        content = `【这次调用${out.status === "denied" ? "没有被允许" : "失败了"}】\n${content}${n > 1 ? `\n（基座提醒，不是对方说的话：同样的调用、同样的参数，这一轮已经失败了 ${n} 次。原样重试不会有不同的结果：先看清失败的原因，换个做法，或者告诉对方卡在哪里。）` : ""}`;
      }
      messages.push({ role: "tool", toolCallId: c.id, name: c.name, content, ...(out.status !== "ok" ? { error: true } : {}) });
    }
    const moved = ports.moved();
    if (moved) { // move_to：换到另一具身体继续，这一轮在这里结束
      if (withFinish && !finish) finish = moved;
      break;
    }
  }
  return { text, finish, steps, tokens, model };
}
