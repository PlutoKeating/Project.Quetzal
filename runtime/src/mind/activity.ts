// 会话：一次对话 / 醒来的进展广播，以及会话时间墙。
//   时间墙按「无进展」计时：模型流的每个数据块、每一步开始、每个工具结束都会重置它；
//   工具执行期间与排队等待期间视为「在工作」，时间墙暂停（工具自身有超时，审批有 30 分钟上限）。
//   超过 SESSION_IDLE_MS 没有任何进展才中止整个会话，并中断正在进行的模型调用。
//   会话存续期间每隔 HEARTBEAT_MS 广播一次 alive，客户端据此判断基座仍在工作。
//   每一轮的进展同时折叠成快照（liveTurns）：客户端断线重连、从后台切回时据此完整恢复进行中的卡片；
//   其他会话的系统提示也据此知道「另一个自己」此刻在做什么。
import crypto from "node:crypto";
import { config } from "../config.ts";
import { bus, type Activity } from "../bus.ts";

export const SESSION_IDLE_MS = 120_000;
export const HEARTBEAT_MS = 15_000;

/** 对方打断：只中止正在进行的模型输出，不影响正在执行的工具。 */
export class Interrupted extends Error {
  constructor() { super("被对方打断"); this.name = "Interrupted"; }
}

/** 对方在她工作时发来的消息（插话 / 打断），在下一次模型调用前并入上下文。 */
export interface Incoming {
  id: number; text: string; mode: "steer" | "interrupt"; attachments: unknown[];
  via?: string; // 多具身体时：这句话从哪具身体进来（只在需要标注时给出）
  notice?: string; // 不是对方说的话，而是基座或子 agent 送来的提醒（通道名，如「灵魂同步」「子agent」）：按提醒的口吻并入
}

/** 对方停止了这一轮（控制台的停止按钮 / 连按两次 Esc）：中止模型输出与正在执行的命令，这一轮就此结束。 */
export class Stopped extends Error {
  constructor() { super("对方停止了这一轮"); this.name = "Stopped"; }
}

export class SessionTimeout extends Error {
  constructor() { super(`会话 ${SESSION_IDLE_MS / 1000} 秒没有任何进展，已中止`); this.name = "SessionTimeout"; }
}

type Payload = Omit<Activity, "session" | "conv" | "origin" | "channel" | "ts">;

/** 进行中的一轮：由进展事件折叠而成的快照。 */
export interface LiveTurn {
  turn: string; conv: string; origin: Activity["origin"]; channel: string; started: number; updated: number; body?: string; // body：在哪具身体上
  text: string; msg: number; status: "queued" | "running"; step: number; live: string; items: Record<string, unknown>[];
}
const live = new Map<string, LiveTurn>();
/** 所有进行中的轮次（按开始时间）。 */
export const liveTurns = (): LiveTurn[] => [...live.values()].sort((a, b) => a.started - b.started);

function fold(a: Activity) {
  if (a.kind === "start") live.set(a.session, { turn: a.session, conv: a.conv, origin: a.origin, channel: a.channel, started: a.ts, updated: a.ts, body: a.body, text: a.text ?? "", msg: a.msg ?? 0, status: "running", step: 0, live: "", items: [] });
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
    case "steer": // 插话 / 打断：在过程里打一个标记，前端据此把之前的过程截断在插话消息上方，之后的过程（含正在流式输出的文字）从插话下面重新开出
      t.items.push({ type: "steer", msg: a.msg, text: a.text ?? "", mode: a.mode, ambient: !!a.ambient });
      break;
    case "done": case "error": live.delete(a.session); break; // 回复已入库：快照立即移除，客户端取回时不会重复显示
    case "tool": {
      const item = { type: "tool", call: a.call, name: a.name, summary: a.summary, status: a.status, ms: a.ms, result: a.result };
      const i = t.items.findIndex((x) => x.type === "tool" && x.call === a.call);
      if (i >= 0) t.items[i] = item; else t.items.push(item);
      break;
    }
  }
}

/** 其他身体转来的进展：并进快照并推给本机的控制台（不再转发）。 */
export function foldRemote(a: Activity) { fold(a); bus.emit("activity", a); }
/** 采用另一具身体此刻进行中的轮次（刚连上时）。 */
export function adoptLive(turns: LiveTurn[], body: string) {
  for (const t of turns) if (t && typeof t.turn === "string" && !live.has(t.turn)) live.set(t.turn, { ...t, body });
}
/** 一具身体断开了：它那些进行中的轮次不再有进展，从快照里移除，并告诉控制台这一轮结束了（回复若已生成会经复制到达）。 */
export function dropBody(body: string) {
  for (const t of [...live.values()]) if (t.body === body) {
    live.delete(t.turn);
    bus.emit("activity", { session: t.turn, conv: t.conv, origin: t.origin, channel: t.channel, ts: Date.now(), body, kind: "error", message: `${body} 断开了，这一轮的进展暂时看不到` });
  }
}
/** 本机进行中的轮次（给刚连上的身体）。 */
export const localTurns = (me: string) => liveTurns().filter((t) => !t.body || t.body === me);

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
  /** session_new：这一轮结束时把回复放进这个新会话（她把对话切到了上下文干净的新会话）。 */
  switchTo?: string;
  /** move_to：她决定换到另一具身体继续。这一轮在这里结束，结果（对话为那边的回复）在 moveResult 里。 */
  movedTo?: string;
  moveResult?: Promise<string>;
  /** 醒来时 send_message 发到的会话：这次醒来之后再发、没有另外指定时接着发到这里（一次醒来的话放在一起）。 */
  sayTo?: string;

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
    const a = { session: this.id, conv: this.conv, origin: this.origin, channel: this.channel, ts: Date.now(), body: config.body, ...p } as Activity;
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

  /** 外部中止整个会话（停止子 agent、对方停止这一轮）。 */
  abort(reason: Error) { this.ac.abort(reason); this.llm?.abort(reason); }

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

  /** 这一轮已经结束（之后送来的提醒要开新的一轮）。 */
  closed = false;
  close() { this.closed = true; this.flush(); clearTimeout(this.timer); clearInterval(this.beat); live.delete(this.id); }
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
