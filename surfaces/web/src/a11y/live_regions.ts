// 双通道无障碍播报器：
// - 礼貌通道（aria-live="polite"）只承载流式正文，按标点或 250ms 空闲整句刷写，
//   避免屏幕阅读器逐 token 结巴；每 token 仍按 `messageId#seq` 恰好一次；
// - 断言通道（aria-live="assertive"）只承载工具、审批与错误事件；
// 两个通道在类型层与运行时都不共享文本，杜绝同一 token 被"双声道"重复朗读。

export type LiveEventKind = "tool" | "approval" | "error";

export interface LiveEvent {
  id: string;
  title: string;
  detail?: string;
}

const MAX_POLITE_CHARS = 240;
const MAX_PENDING_CHARS = 80;
const POLITE_IDLE_FLUSH_MS = 250;
const MAX_SEEN_TOKENS = 2048;
const MAX_ASSERTIVE_CHARS = 480;
const FLUSH_PUNCTUATION = /[。！？!?；;，,、：:.\n]/u;
const KIND_LABEL: Record<LiveEventKind, string> = {
  tool: "工具",
  approval: "需要你确认",
  error: "出错了",
};

export class LiveRegions {
  readonly polite: HTMLElement;
  readonly assertive: HTMLElement;
  readonly #doc: Document;
  readonly #seenTokens = new Set<string>();
  readonly #seenEvents = new Set<string>();
  readonly #politePieces: Text[] = [];
  #pending = "";
  #flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(doc: Document) {
    this.#doc = doc;
    this.polite = doc.createElement("div");
    this.polite.id = "qz-live-polite";
    this.polite.className = "sr-only";
    this.polite.setAttribute("role", "status");
    this.polite.setAttribute("aria-live", "polite");
    this.polite.setAttribute("aria-atomic", "false");
    this.polite.setAttribute("data-live-channel", "polite");

    this.assertive = doc.createElement("div");
    this.assertive.id = "qz-live-assertive";
    this.assertive.className = "sr-only";
    this.assertive.setAttribute("role", "alert");
    this.assertive.setAttribute("aria-live", "assertive");
    this.assertive.setAttribute("aria-atomic", "true");
    this.assertive.setAttribute("data-live-channel", "assertive");
  }

  /** 追加一个流式 token；重复 seq 返回 false 且不改变两个通道。 */
  appendToken(messageId: string, seq: number, text: string): boolean {
    if (text.length === 0) return false;
    const tokenId = `${messageId}#${seq}`;
    if (this.#seenTokens.has(tokenId)) return false;
    if (this.#seenTokens.size >= MAX_SEEN_TOKENS) {
      const oldest = this.#seenTokens.values().next();
      if (!oldest.done) this.#seenTokens.delete(oldest.value);
    }
    this.#seenTokens.add(tokenId);
    this.#pending += text;
    if (
      FLUSH_PUNCTUATION.test(text) ||
      this.#pending.length >= MAX_PENDING_CHARS
    ) {
      this.#flush();
      return true;
    }
    this.#scheduleFlush();
    return true;
  }

  #scheduleFlush(): void {
    if (this.#flushTimer !== null) return;
    this.#flushTimer = setTimeout(() => {
      this.#flushTimer = null;
      this.#flush();
    }, POLITE_IDLE_FLUSH_MS);
  }

  #flush(): void {
    if (this.#flushTimer !== null) {
      clearTimeout(this.#flushTimer);
      this.#flushTimer = null;
    }
    if (this.#pending.length === 0) return;
    const node = this.#doc.createTextNode(this.#pending);
    this.#pending = "";
    this.polite.append(node);
    this.#politePieces.push(node);
    this.#trimPolite();
  }

  #trimPolite(): void {
    let size = this.#politePieces.reduce((total, piece) => total + (piece.data?.length ?? 0), 0);
    while (size > MAX_POLITE_CHARS && this.#politePieces.length > 1) {
      const removed = this.#politePieces.shift();
      if (!removed) break;
      size -= removed.data?.length ?? 0;
      removed.remove();
    }
  }

  /** 重置当前流缓冲（开始新消息时调用），已去重的 token 仍不会被重播。 */
  resetStream(): void {
    if (this.#flushTimer !== null) {
      clearTimeout(this.#flushTimer);
      this.#flushTimer = null;
    }
    this.#pending = "";
    this.#politePieces.length = 0;
    this.polite.textContent = "";
  }

  /** 工具 / 审批 / 错误事件只进入断言通道。 */
  announceEvent(kind: LiveEventKind, event: LiveEvent): void {
    if (this.#seenEvents.has(event.id)) return;
    if (this.#seenEvents.size >= 256) {
      const oldest = this.#seenEvents.values().next();
      if (!oldest.done) this.#seenEvents.delete(oldest.value);
    }
    this.#seenEvents.add(event.id);
    const detail = event.detail ? `：${event.detail}` : "";
    this.assertive.append(this.#doc.createTextNode(`${KIND_LABEL[kind]}：${event.title}${detail}。`));
    while ((this.assertive.textContent?.length ?? 0) > MAX_ASSERTIVE_CHARS) {
      const first = this.assertive.firstChild;
      if (!first) break;
      first.remove();
    }
  }

  /** 状态类播报（密度切换等）走礼貌通道，先刷出未完结缓冲以保持顺序。 */
  announceStatus(text: string): void {
    if (text.length === 0) return;
    this.#flush();
    const node = this.#doc.createTextNode(`${text}。`);
    this.polite.append(node);
    // 状态播报与 token 共享同一个 240 字符窗口，避免状态消息无限增长。
    this.#politePieces.push(node);
    this.#trimPolite();
  }
}
