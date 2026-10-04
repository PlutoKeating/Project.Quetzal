// 飞书的执行过程卡片：她工作时每个工具、每段中途叙述各占一行，每秒最多更新一次。
//   按插话分段：对方插话（或耳朵听到的话并入）的那一刻，当前卡片定格（标题带上这段用了几个工具），新的一段作为回复对方那条消息的新卡片
//   在下面重新开出——和控制台的分段显示一致，不会出现消息发在下面、过程还在上面的卡片里继续更新。
//   发送与更新由注入的 sender 完成（便于测试，也不依赖 lark）。
import type { Activity } from "../bus.ts";
import { md, card } from "./feishu-cards.ts";

export interface CardSender { send(replyTo: string | undefined, data: unknown): Promise<string | undefined>; update(messageId: string, data: unknown): Promise<void> }

const ICON = { running: "⏳", ok: "✅", error: "❌", denied: "🚫" } as const;
const code = (s: string) => "`" + s.replace(/`/g, "'") + "`";

interface Seg { lines: Map<string, string>; running: number; tools: number; messageId: string; done: boolean; replyTo?: string }

export class ProgressCards {
  private seg: Seg;
  private dirty = false;
  private timer?: NodeJS.Timeout;
  private q: Promise<unknown> = Promise.resolve();
  private pendingSplit = false;
  private closed = false;
  private sender: CardSender;
  readonly session: string;
  private log: (m: string) => void;
  constructor(sender: CardSender, replyTo: string | undefined, session: string, log: (m: string) => void = () => {}) {
    this.sender = sender; this.session = session; this.log = log;
    this.seg = ProgressCards.newSeg(replyTo);
  }
  private static newSeg(replyTo?: string): Seg { return { lines: new Map(), running: 0, tools: 0, messageId: "", done: false, replyTo }; }
  /** 当前这一段回复的是哪条消息（最后的回复也接在它下面）。 */
  get replyTo() { return this.seg.replyTo; }

  private render(s: Seg) {
    return card(s.done ? `执行过程 · ${s.tools} 个工具` : "执行过程", s.done ? "grey" : "indigo",
      [md([...s.lines.values(), ...(!s.done && s.running ? ["🧰 *正在调用工具…*"] : [])].join("\n") || "…")]);
  }
  private push(s: Seg) {
    this.q = this.q.then(async () => {
      if (!s.messageId) s.messageId = (await this.sender.send(s.replyTo, this.render(s))) ?? "";
      else await this.sender.update(s.messageId, this.render(s));
    }).catch((e) => this.log(`执行过程卡片更新失败：${e.message}`));
    return this.q;
  }
  private flush = () => {
    this.timer = undefined;
    if (!this.dirty) return this.q;
    this.dirty = false;
    return this.push(this.seg);
  };
  private schedule() { this.dirty = true; this.timer ??= setTimeout(this.flush, this.seg.messageId ? 1000 : 0); }

  /**
   * 对方插话了：当前卡片定格，新的一段回复对方的那条消息（replyTo）。通道收到对方的插话消息时调用（在把消息交给 converse 之前），
   * 随后到来的 steer 事件不再另起一段；没有对应消息的插话（耳朵听到的话）由 steer 事件自己分段。
   */
  split(replyTo?: string, line?: string) {
    if (this.closed) return;
    const old = this.seg;
    clearTimeout(this.timer); this.timer = undefined; this.dirty = false;
    if (old.lines.size || old.messageId) { old.done = true; void this.push(old); }
    this.seg = ProgressCards.newSeg(replyTo ?? old.replyTo);
    this.pendingSplit = !!replyTo;
    if (line) { this.seg.lines.set("steer", line); this.schedule(); }
  }

  onActivity = (a: Activity) => {
    if (a.session !== this.session || this.closed) return;
    const s = this.seg;
    if (a.kind === "tool") {
      if (a.status === "running") { s.running++; s.tools++; } else if (s.lines.has(a.call!)) s.running--; else s.tools++;
      const sec = a.ms != null && a.status !== "running" ? ` · ${(a.ms / 1000).toFixed(1)}s` : "";
      s.lines.set(a.call!, `${ICON[a.status!]} **${a.name}**${a.summary ? ` — ${code(a.summary)}` : ""}${sec}`);
    } else if (a.kind === "steer") {
      if (this.pendingSplit) { this.pendingSplit = false; return; } // 通道已经按对方的消息分过段
      this.split(undefined, `📨 *${a.ambient ? "听到你说" : "你插话"}：${(a.text ?? "").trim().replace(/\s+/g, " ").slice(0, 200)}*（已并入）`);
      return;
    } else if (a.kind === "text" && !a.final && a.text?.trim()) s.lines.set(`text-${a.ts}-${s.lines.size}`, `💬 ${a.text.trim().slice(0, 1500)}`); // 她中途说的话：完整一段
    else return;
    this.schedule();
  };

  /** 这一轮结束：最后一段定格。 */
  async close() {
    this.closed = true;
    clearTimeout(this.timer); this.timer = undefined;
    this.seg.done = true;
    if (this.seg.lines.size || this.seg.messageId) { this.dirty = false; await this.push(this.seg); }
    await this.q;
  }
}
