// 会话：一次对话 / 醒来的进展广播，以及会话时间墙。
//   时间墙按「无进展」计时：模型流的每个数据块、每一步开始、每个工具结束都会重置它；
//   工具执行期间与排队等待期间视为「在工作」，时间墙暂停（工具自身有超时，审批有 30 分钟上限）。
//   超过 SESSION_IDLE_MS 没有任何进展才中止整个会话，并中断正在进行的模型调用。
//   会话存续期间每隔 HEARTBEAT_MS 广播一次 alive，客户端据此判断基座仍在工作。
import crypto from "node:crypto";
import { bus, type Activity } from "../bus.ts";

export const SESSION_IDLE_MS = 120_000;
export const HEARTBEAT_MS = 15_000;

export class SessionTimeout extends Error {
  constructor() { super(`会话 ${SESSION_IDLE_MS / 1000} 秒没有任何进展，已中止`); this.name = "SessionTimeout"; }
}

type Payload = Omit<Activity, "session" | "origin" | "channel" | "ts">;

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

  constructor(origin: Activity["origin"], channel = "", id?: string) {
    this.origin = origin; this.channel = channel;
    this.id = id || crypto.randomUUID();
    this.beat = setInterval(() => { if (!this.signal.aborted) this.emit({ kind: "alive" }); }, HEARTBEAT_MS);
    this.beat.unref?.();
    this.touch();
  }

  get signal() { return this.ac.signal; }

  emit(p: Payload) { bus.emit("activity", { session: this.id, origin: this.origin, channel: this.channel, ts: Date.now(), ...p } as Activity); }

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

  /** 模型流式输出的文字，合并后每 200ms 广播一次。 */
  delta(text: string) {
    this.buf += text;
    this.flushTimer ??= setTimeout(() => this.flush(), 200);
  }

  flush() {
    clearTimeout(this.flushTimer); this.flushTimer = undefined;
    if (this.buf) { this.emit({ kind: "delta", text: this.buf }); this.buf = ""; }
  }

  close() { this.flush(); clearTimeout(this.timer); clearInterval(this.beat); }
}

/** 工具调用的一行摘要：优先取常见的主参数，否则取第一个字符串参数。 */
export function summarize(args: Record<string, unknown> = {}): string {
  const keys = ["command", "query", "url", "title", "name", "id", "text", "target", "action"];
  const v = keys.map((k) => args[k]).find((x) => typeof x === "string" && x) ?? Object.values(args).find((x) => typeof x === "string" && x)
    ?? (Object.keys(args).length ? JSON.stringify(args) : "");
  const s = String(v).replace(/\s+/g, " ").trim();
  return s.length > 100 ? s.slice(0, 100) + "…" : s;
}
