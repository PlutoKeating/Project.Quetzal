// 会话：一次对话 / 醒来的进展广播，以及会话时间墙。
//   时间墙按「无进展」计时：模型流的每个数据块、每一步开始、每个工具结束都会重置它；
//   工具执行期间与排队等待期间视为「在工作」，时间墙暂停（工具自身有超时，审批有 30 分钟上限）。
//   超过 SESSION_IDLE_MS 没有任何进展才中止整个会话，并中断正在进行的模型调用。
//   会话存续期间每隔 HEARTBEAT_MS 广播一次 alive，客户端据此判断基座仍在工作。
//   每一轮的进展同时折叠成快照（liveTurns）：客户端断线重连、从后台切回时据此完整恢复进行中的卡片；
//   其他会话的系统提示也据此知道「另一个自己」此刻在做什么。
import crypto from "node:crypto";
import { bus, type Activity } from "../bus.ts";

export const SESSION_IDLE_MS = 120_000;
export const HEARTBEAT_MS = 15_000;

/** 对方打断：只中止正在进行的模型输出，不影响正在执行的工具。 */
export class Interrupted extends Error {
  constructor() { super("被对方打断"); this.name = "Interrupted"; }
}

/** 对方在她工作时发来的消息（插话 / 打断），在下一次模型调用前并入上下文。 */
export interface Incoming { id: number; text: string; mode: "steer" | "interrupt"; attachments: unknown[] }

export class SessionTimeout extends Error {
  constructor() { super(`会话 ${SESSION_IDLE_MS / 1000} 秒没有任何进展，已中止`); this.name = "SessionTimeout"; }
}

type Payload = Omit<Activity, "session" | "conv" | "origin" | "channel" | "ts">;

/** 进行中的一轮：由进展事件折叠而成的快照。 */
export interface LiveTurn {
  turn: string; conv: string; origin: Activity["origin"]; channel: string; started: number; updated: number;
  text: string; msg: number; status: "queued" | "running"; step: number; live: string; items: Record<string, unknown>[];
}
const live = new Map<string, LiveTurn>();
/** 所有进行中的轮次（按开始时间）。 */
export const liveTurns = (): LiveTurn[] => [...live.values()].sort((a, b) => a.started - b.started);

function fold(a: Activity) {
  if (a.kind === "start") live.set(a.session, { turn: a.session, conv: a.conv, origin: a.origin, channel: a.channel, started: a.ts, updated: a.ts, text: a.text ?? "", msg: a.msg ?? 0, status: "running", step: 0, live: "", items: [] });
  const t = live.get(a.session);
  if (!t) return;
  t.updated = a.ts;
  switch (a.kind) {
    case "queued": t.status = "queued"; break;
    case "step": t.status = "running"; t.step = a.step ?? t.step; break;
    case "delta": t.live += a.text ?? ""; break;
    case "text":
      if (a.final) t.live = a.text ?? "";
      else { if (a.text?.trim()) t.items.push({ type: "text", text: a.text.trim() }); t.live = ""; }
      break;
    case "steer": t.msg = a.msg ?? t.msg; break;
    case "done": case "error": live.delete(a.session); break; // 回复已入库：快照立即移除，客户端取回时不会重复显示 // 进行中的卡片挂到最新并入的那句话下面
    case "tool": {
      const item = { type: "tool", call: a.call, name: a.name, summary: a.summary, status: a.status, ms: a.ms, result: a.result };
      const i = t.items.findIndex((x) => x.type === "tool" && x.call === a.call);
      if (i >= 0) t.items[i] = item; else t.items.push(item);
      break;
    }
  }
}

export class Session {
  readonly id: string;
  readonly origin: Activity["origin"];
  readonly channel: string;
  private readonly ac = new AbortController();
  private timer?: NodeJS.Timeout;
  private readonly beat: NodeJS.Timeout;
  private holds = 0;
  private buf = "";
  private flushTimer?: NodeJS.Timeout;
  private llm?: AbortController;
  /** 对方在工作期间发来的消息。 */
  readonly inbox: Incoming[] = [];
  /** view_image 请求查看的图片：在下一次模型调用时放进上下文。 */
  readonly images: { image: import("../providers/types.ts").ImagePart; label: string }[] = [];
  /** 这一轮已经放进上下文的图片（绝对路径）：随消息附带的、view_image 看过的。同一张不再重复发送。 */
  readonly seen = new Set<string>();
  /** 本次模型调用已经流式输出的文字（被打断时保留）。 */
  stepText = "";

  readonly conv: string;

  constructor(origin: Activity["origin"], channel = "", id?: string, conv = "") {
    this.origin = origin; this.channel = channel; this.conv = conv;
    this.id = id || crypto.randomUUID();
    this.beat = setInterval(() => { if (!this.signal.aborted) this.emit({ kind: "alive" }); }, HEARTBEAT_MS);
    this.beat.unref?.();
    this.touch();
  }

  get signal() { return this.ac.signal; }

  emit(p: Payload) {
    const a = { session: this.id, conv: this.conv, origin: this.origin, channel: this.channel, ts: Date.now(), ...p } as Activity;
    fold(a);
    bus.emit("activity", a);
  }

  /** 这一轮的执行过程（工具卡片与中间叙述），随回复一起保存。 */
  process(): Record<string, unknown>[] { return live.get(this.id)?.items ?? []; }

  /** 有进展：重置时间墙。 */
  touch() {
    clearTimeout(this.timer);
    if (this.holds > 0 || this.signal.aborted) return;
    this.timer = setTimeout(() => this.ac.abort(new SessionTimeout()), SESSION_IDLE_MS);
    this.timer.unref?.();
  }

  /** 在工作（执行工具、排队）：期间暂停时间墙，结束后重新计时。 */
  async hold<T>(f: () => Promise<T>): Promise<T> {
    this.holds++; clearTimeout(this.timer);
    try { return await f(); } finally { this.holds--; this.touch(); }
  }

  /** 若已被时间墙中止，抛出原因。 */
  check() { if (this.signal.aborted) throw this.signal.reason ?? new SessionTimeout(); }

  /** 开始一次模型调用：返回合并了会话时间墙与「打断」的信号。 */
  beginLLM(): AbortSignal { this.llm = new AbortController(); this.stepText = ""; return AbortSignal.any([this.signal, this.llm.signal]); }
  endLLM() { this.llm = undefined; }
  /** 打断正在进行的模型输出；此刻没有模型调用（例如正在执行工具）时返回 false，消息会在工具结束后立即处理。 */
  interrupt(): boolean { if (!this.llm) return false; this.llm.abort(new Interrupted()); return true; }

  /** 模型流式输出的文字，合并后每 200ms 广播一次。 */
  delta(text: string) {
    this.stepText += text;
    this.buf += text;
    this.flushTimer ??= setTimeout(() => this.flush(), 200);
  }

  flush() {
    clearTimeout(this.flushTimer); this.flushTimer = undefined;
    if (this.buf) { this.emit({ kind: "delta", text: this.buf }); this.buf = ""; }
  }

  close() { this.flush(); clearTimeout(this.timer); clearInterval(this.beat); live.delete(this.id); }
}

/** 工具调用的一行摘要：优先取常见的主参数，否则取第一个字符串参数或字符串数组（如 view_image 的 paths）。 */
export function summarize(args: Record<string, unknown> = {}): string {
  const keys = ["command", "query", "url", "title", "name", "id", "text", "target", "action"];
  const v = keys.map((k) => args[k]).find((x) => typeof x === "string" && x) ?? Object.values(args).find((x) => typeof x === "string" && x)
    ?? (Object.values(args).find((x) => Array.isArray(x) && x.length && x.every((y) => typeof y === "string")) as string[] | undefined)?.join("、")
    ?? (Object.keys(args).length ? JSON.stringify(args) : "");
  const s = String(v).replace(/\s+/g, " ").trim();
  return s.length > 100 ? s.slice(0, 100) + "…" : s;
}
