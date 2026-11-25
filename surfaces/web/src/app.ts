import { LiveRegions } from "./a11y/live_regions.js";
import { DEFAULT_DENSITY, DensityController, type DensityStorage } from "./model/density.js";
import {
  PatchSequenceError,
  ViewStateModel,
  compareCodeUnits,
  densityLabel,
  isDensity,
  type Density,
  type ViewPatch,
  type ViewSnapshot,
} from "./model/state.js";
import { h } from "./render/dom.js";
import {
  DaemonUnavailable,
  type AppTransport,
  type ConnectionState,
  type ToolCardEvent,
  type TransportHandlers,
} from "./transport/client.js";
import type { SpineCache } from "./cache/wasm_cache.js";
import { renderCompanion } from "./tiers/companion/view.js";
import { renderInspector } from "./tiers/inspector/view.js";
import { renderWorkbench } from "./tiers/workbench/view.js";
import type { TierActions, TierContext, ToolCardState, TranscriptItem } from "./tiers/types.js";

export interface QuetzalcoatlAppOptions {
  transport: AppTransport;
  storage?: DensityStorage | null;
  cache?: SpineCache;
  density?: Density;
}

interface RenderOptions {
  focusHeading?: boolean;
  focusComposer?: boolean;
}

const DRAFT_KEY = "web-composer-draft";
const DRAFT_SAVE_DELAY_MS = 300;
const MAX_DRAFT_CHARS = 4096;

const SHORTCUTS: Record<string, Density> = {
  "1": "companion",
  "2": "workbench",
  "3": "inspector",
};

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 纯原生三档认知密度 Web 应用（无 UI 框架、无 WebView、无第三方运行时）。 */
export class QuetzalcoatlApp {
  readonly #root: HTMLElement;
  readonly #doc: Document;
  readonly #transport: AppTransport;
  readonly #density: DensityController;
  readonly #cache: SpineCache | null;
  readonly #model = new ViewStateModel();
  readonly #live: LiveRegions;
  readonly #storage: DensityStorage | null;
  readonly #transcript: TranscriptItem[] = [];
  readonly #cards: ToolCardState[] = [];
  readonly #selection = new Set<string>();
  readonly #lastSeq = new Map<string, number>();
  #online = false;
  #transportKind: "websocket" | "http" = "http";
  #offlineDetail = "";
  #started = false;
  #localSeq = 0;
  #eventSeq = 0;
  #lastUserText = "";
  #resyncInFlight = false;
  #draftTimer: ReturnType<typeof setTimeout> | null = null;
  readonly #encoder = new TextEncoder();
  readonly #decoder = new TextDecoder();
  #starting = false;
  #onboarded = false;
  #onboardingVisible = false;
  #onboardingStep = 1;
  #onboardingStepTimer: ReturnType<typeof setInterval> | null = null;
  #onboardingEndTimer: ReturnType<typeof setTimeout> | null = null;

  #host!: HTMLElement;
  #input!: HTMLTextAreaElement;
  #submit!: HTMLButtonElement;
  #transportEl!: HTMLElement;
  #cacheEl!: HTMLElement;
  #densityButtons = new Map<Density, HTMLButtonElement>();

  constructor(root: HTMLElement, options: QuetzalcoatlAppOptions) {
    this.#root = root;
    this.#doc = root.ownerDocument;
    this.#transport = options.transport;
    this.#storage = options.storage ?? null;
    this.#density = new DensityController(options.storage ?? null, options.density ?? DEFAULT_DENSITY);
    this.#cache = options.cache ?? null;
    this.#live = new LiveRegions(this.#doc);
    this.#model.setDensity(this.#density.current);
    this.#onboarded = this.#readOnboarded();
    this.#onboardingVisible = !this.#onboarded;
  }

  get density(): Density {
    return this.#density.current;
  }

  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;
    this.#starting = true;
    this.#root.setAttribute("aria-busy", "true");
    this.#buildShell();
    this.#render();
    this.#scheduleOnboarding();
    await this.#restoreDraft();
    try {
      await this.#transport.connect(this.#handlers());
      if (!this.#online) {
        // 传输层已认证成功但尚未收到 ready 帧：先按在线渲染，ready/快照随后补齐。
        this.#online = true;
      }
      this.#starting = false;
      this.#root.removeAttribute("aria-busy");
      this.#render();
    } catch (error) {
      this.#starting = false;
      this.#online = false;
      this.#offlineDetail =
        error instanceof DaemonUnavailable ? error.detail : describe(error);
      // 先退出繁忙态，再播报错误：离线 alert 绝不能落在 aria-busy 子树里。
      this.#root.removeAttribute("aria-busy");
      this.#render();
      this.#live.announceEvent("error", {
        id: `daemon-offline-${this.#eventSeq}`,
        title: "本机守护进程未运行",
        detail: "当前为只读降级视图；启动 quetzalcoatld 后点“重试连接”。",
      });
      this.#eventSeq += 1;
    }
  }

  switchDensity(next: Density): void {
    if (!isDensity(next)) return;
    this.#density.set(next);
    this.#model.setDensity(next);
    this.#render({ focusHeading: true });
    this.#live.announceStatus(`已切换到${densityLabel(next)}视图`);
  }

  async sendMessage(text: string): Promise<void> {
    const value = text.trim();
    if (value.length === 0) return;
    this.#lastUserText = value;
    if (!this.#online) {
      this.#live.announceEvent("error", {
        id: `send-offline-${this.#eventSeq}`,
        title: "消息未发送：本机守护进程未运行",
      });
      this.#eventSeq += 1;
      return;
    }
    this.#localSeq += 1;
    this.#live.resetStream();
    this.#transcript.push({ id: `local-${this.#localSeq}`, role: "user", text: value });
    this.#render({ focusComposer: true });
    try {
      await this.#transport.sendChat(value);
    } catch (error) {
      this.#pushCard({
        kind: "error",
        id: `send-error-${this.#eventSeq}`,
        title: "消息发送失败",
        detail: describe(error),
      });
    }
  }

  reloadDensity(): void {
    this.#render({ focusHeading: false });
  }

  #handlers(): TransportHandlers {
    return {
      onSnapshot: (snapshot) => this.#applySnapshot(snapshot),
      onPatch: (patch) => this.#applyPatch(patch),
      onToken: (token) => this.#applyToken(token.messageId, token.seq, token.text),
      onToolCard: (card) => this.#applyToolCard(card),
      onConnection: (state) => this.#applyConnection(state),
    };
  }

  #applyConnection(state: ConnectionState): void {
    const wasOnline = this.#online;
    this.#online = state.online;
    if (state.transport === "websocket" || state.transport === "http") {
      this.#transportKind = state.transport;
    }
    this.#offlineDetail = state.online ? "" : state.detail ?? this.#offlineDetail;
    if (!state.online) {
      this.#live.announceEvent("error", {
        id: `connection-lost-${this.#eventSeq}`,
        title: "与守护进程的连接已断开",
        detail: state.detail ?? "正在尝试恢复",
      });
      this.#eventSeq += 1;
    } else if (!wasOnline && this.#started) {
      this.#live.announceStatus("已重新连上本机守护进程");
    }
    this.#render();
  }

  #applySnapshot(snapshot: ViewSnapshot): void {
    this.#model.replace(snapshot);
    this.#model.setDensity(this.#density.current);
    this.#online = true;
    this.#offlineDetail = "";
    this.#lastSeq.clear();
    this.#rebuildAssistantTranscript();
    this.#render();
  }

  #applyPatch(patch: ViewPatch): void {
    try {
      const outcome = this.#model.apply(patch);
      if (outcome === "duplicate") return;
    } catch (error) {
      if (error instanceof PatchSequenceError) {
        this.#live.announceEvent("error", {
          id: `patch-resync-${this.#eventSeq}`,
          title: "视图补丁序裂，正在重新同步",
          detail: error.message,
        });
        this.#eventSeq += 1;
        void this.#requestResync();
      }
      return;
    }
    for (const op of Array.isArray(patch.ops) ? patch.ops : []) {
      if (op.op === "upsert") {
        this.#mergeAssistantRow(op.row.key, op.row.kind, op.row.summary);
        continue;
      }
      const id = op.key.startsWith("chat/") ? op.key.slice(5) : op.key;
      const index = this.#transcript.findIndex((item) => item.id === id);
      if (index >= 0) this.#transcript.splice(index, 1);
      this.#lastSeq.delete(id);
    }
    this.#render();
  }

  #mergeAssistantRow(key: string, kind: string, summary: string): void {
    if (kind !== "assistant") return;
    const id = key.startsWith("chat/") ? key.slice(5) : key;
    if (id.length === 0 || summary.length === 0) return;
    const existing = this.#transcript.find((item) => item.id === id);
    if (existing) {
      if (existing.text !== summary) existing.text = summary;
      return;
    }
    this.#transcript.push({ id, role: "assistant", text: summary });
  }

  #applyToken(messageId: string, seq: number, text: string): void {
    const spoken = this.#live.appendToken(messageId, seq, text);
    if (!spoken) return;
    const last = this.#lastSeq.get(messageId) ?? -1;
    if (seq <= last) return;
    this.#lastSeq.set(messageId, seq);
    let item = this.#transcript.find((entry) => entry.id === messageId);
    if (!item) {
      item = { id: messageId, role: "assistant", text: "" };
      this.#transcript.push(item);
    }
    item.text += text;
    this.#render();
  }

  #applyToolCard(card: ToolCardEvent): void {
    this.#pushCard(card);
  }

  #pushCard(card: ToolCardEvent): void {
    this.#live.announceEvent(card.kind, {
      id: card.id,
      title: card.title,
      ...(card.detail ? { detail: card.detail } : {}),
    });
    if (!this.#cards.some((entry) => entry.id === card.id)) {
      this.#cards.push(card);
    }
    this.#render();
  }

  #rebuildAssistantTranscript(): void {
    const users = this.#transcript.filter((item) => item.role === "user");
    const assistants: TranscriptItem[] = [];
    for (const row of this.#model.rows().values()) {
      if (row.kind !== "assistant") continue;
      const id = row.key.startsWith("chat/") ? row.key.slice(5) : row.key;
      assistants.push({ id, role: "assistant", text: row.summary });
    }
    assistants.sort((left, right) => compareCodeUnits(left.id, right.id));
    this.#transcript.length = 0;
    this.#transcript.push(...users, ...assistants);
  }

  async #requestResync(): Promise<void> {
    if (this.#resyncInFlight) return;
    this.#resyncInFlight = true;
    try {
      const candidate = this.#transport as AppTransport & { resync?: () => Promise<void> };
      if (typeof candidate.resync === "function") {
        await candidate.resync();
      }
    } catch {
      // 无法重同步时保留本地状态，等待下一次快照。
    } finally {
      this.#resyncInFlight = false;
    }
  }

  #buildShell(): void {
    const nav = h("nav", { class: "density-nav", "data-density-controls": "", "aria-label": "认知密度" });
    for (const density of ["companion", "workbench", "inspector"] as const) {
      const index = density === "companion" ? "1" : density === "workbench" ? "2" : "3";
      const button = h(
        "button",
        {
          class: "btn density-btn",
          type: "button",
          "data-density": density,
          "aria-pressed": "false",
          "aria-label": `${densityLabel(density)}视图（快捷键 Alt+${index}）`,
          title: `Alt+${index}`,
          onClick: () => this.switchDensity(density),
        },
        densityLabel(density),
      );
      this.#densityButtons.set(density, button);
      nav.append(button);
    }

    this.#transportEl = h("span", { class: "meta-item", "data-role": "transport" }, "连接中");
    this.#cacheEl = h("span", { class: "meta-item", "data-role": "cache" }, "缓存：未检测");

    const header = h(
      "header",
      { class: "app-header" },
      h(
        "div",
        { class: "brand" },
        h("span", { class: "brand-mark", "aria-hidden": "true" }, "羽"),
        h("span", { class: "brand-name" }, "羽蛇神"),
      ),
      nav,
      h("div", { class: "meta" }, this.#transportEl, this.#cacheEl),
    );

    this.#host = h("main", { class: "tier-host", "data-role": "tier-host" });

    this.#input = h("textarea", {
      id: "qz-composer-input",
      class: "composer-input",
      "data-role": "composer-input",
      rows: "2",
      "aria-label": "说一句话，我来帮你安排",
      placeholder: "说一句话，我来帮你安排…",
    });
    this.#submit = h(
      "button",
      { class: "btn composer-submit", type: "submit", "data-role": "composer-submit" },
      "发送",
    );
    const form = h(
      "form",
      { class: "composer", "data-role": "composer", "aria-label": "对话输入" },
      this.#input,
      this.#submit,
    );
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const value = this.#input.value;
      this.#input.value = "";
      this.#clearDraft();
      void this.sendMessage(value);
    });
    this.#input.addEventListener("input", () => this.#queueDraftSave());

    this.#root.classList.add("qz-root");
    this.#root.replaceChildren(header, this.#host, form, this.#live.polite, this.#live.assertive);
    this.#doc.addEventListener("keydown", (event) => {
      if (!event.altKey || event.ctrlKey || event.metaKey) return;
      const density = SHORTCUTS[event.key];
      if (!density) return;
      event.preventDefault();
      this.switchDensity(density);
    });
  }

  async #restoreDraft(): Promise<void> {
    if (!this.#cache) return;
    try {
      const bytes = await this.#cache.get(DRAFT_KEY);
      if (bytes && bytes.byteLength > 0 && bytes.byteLength <= MAX_DRAFT_CHARS * 4) {
        this.#input.value = this.#decoder.decode(bytes);
      }
    } catch {
      // 缓存不可读不影响输入。
    }
  }

  #queueDraftSave(): void {
    if (!this.#cache) return;
    if (this.#draftTimer !== null) clearTimeout(this.#draftTimer);
    this.#draftTimer = setTimeout(() => {
      this.#draftTimer = null;
      const value = this.#input.value.slice(0, MAX_DRAFT_CHARS);
      void this.#cache?.set(DRAFT_KEY, this.#encoder.encode(value)).catch(() => undefined);
    }, DRAFT_SAVE_DELAY_MS);
  }

  #clearDraft(): void {
    if (!this.#cache) return;
    if (this.#draftTimer !== null) {
      clearTimeout(this.#draftTimer);
      this.#draftTimer = null;
    }
    void this.#cache.set(DRAFT_KEY, new Uint8Array()).catch(() => undefined);
  }

  #actions(): TierActions {
    return {
      toggleSelection: (key) => {
        if (this.#selection.has(key)) this.#selection.delete(key);
        else this.#selection.add(key);
        this.#render();
      },
      copyReference: (key) => {
        const clipboard = this.#doc.defaultView?.navigator?.clipboard;
        if (clipboard && typeof clipboard.writeText === "function") {
          void clipboard.writeText(`qz://${key}`).catch(() => undefined);
        }
        this.#live.announceStatus("已复制引用");
      },
      resolveApproval: (id) => {
        const index = this.#cards.findIndex((card) => card.id === id);
        if (index >= 0) this.#cards.splice(index, 1);
        this.#live.announceStatus("已记录你的选择（仅保存在本机）");
        this.#render();
      },
      retryConnection: () => {
        void this.#retryConnection();
      },
      retryMessage: () => {
        if (this.#lastUserText.length > 0) void this.sendMessage(this.#lastUserText);
      },
      commitArtifact: (key) => {
        void this.#commitArtifact(key);
      },
      skipOnboarding: () => {
        this.#completeOnboarding(true);
      },
    };
  }

  async #commitArtifact(key: string): Promise<void> {
    const commit = this.#transport.commitArtifact;
    if (typeof commit !== "function") {
      this.#pushCard({
        kind: "error",
        id: `commit-unsupported-${this.#eventSeq}`,
        title: "当前传输不支持产物提交",
      });
      return;
    }
    try {
      const result = await commit.call(this.#transport, key);
      if (result.ok) {
        this.#live.announceStatus(result.detail);
      } else {
        this.#pushCard({
          kind: "error",
          id: `commit-error-${this.#eventSeq}`,
          title: "产物提交失败",
          detail: `${result.detail}${result.code ? `（${result.code}）` : ""}`,
        });
      }
    } catch (error) {
      this.#pushCard({
        kind: "error",
        id: `commit-error-${this.#eventSeq}`,
        title: "产物提交失败",
        detail: describe(error),
      });
    }
  }

  #readOnboarded(): boolean {
    try {
      return this.#storage?.getItem("qz.web.onboarded") === "1";
    } catch {
      return false;
    }
  }

  #writeOnboarded(): void {
    try {
      this.#storage?.setItem("qz.web.onboarded", "1");
    } catch {
      // 持久化失败不影响本次会话内的隐藏。
    }
  }

  #scheduleOnboarding(): void {
    if (!this.#onboardingVisible) return;
    this.#onboardingStepTimer = setInterval(() => {
      if (!this.#onboardingVisible) return;
      if (this.#onboardingStep < 3) {
        this.#onboardingStep += 1;
        this.#render();
      }
    }, 4000);
    this.#onboardingEndTimer = setTimeout(() => {
      this.#completeOnboarding(true);
    }, 10_000);
  }

  #completeOnboarding(persist: boolean): void {
    this.#onboardingVisible = false;
    this.#onboarded = true;
    if (this.#onboardingStepTimer !== null) {
      clearInterval(this.#onboardingStepTimer);
      this.#onboardingStepTimer = null;
    }
    if (this.#onboardingEndTimer !== null) {
      clearTimeout(this.#onboardingEndTimer);
      this.#onboardingEndTimer = null;
    }
    if (persist) this.#writeOnboarded();
    this.#render();
  }

  #sessionInfo(): TierContext["session"] {
    const rows = [...this.#model.rows().values()];
    const row = rows.find((candidate) => candidate.kind === "session");
    if (!row) {
      return {
        kind: "personal",
        roomId: null,
        detail: "提交产物需要先加入群组房间；当前为个人会话。",
      };
    }
    let kind: "personal" | "group" = "personal";
    let roomId: string | null = null;
    if (row.raw_json) {
      try {
        const parsed: unknown = JSON.parse(row.raw_json);
        if (typeof parsed === "object" && parsed !== null) {
          const record = parsed as Record<string, unknown>;
          if (record["kind"] === "group") kind = "group";
          if (typeof record["room_id"] === "string") roomId = record["room_id"];
        }
      } catch {
        // 畸形会话行按个人会话 fail-closed。
      }
    }
    return {
      kind,
      roomId,
      detail: row.detail ?? (kind === "group" ? row.summary : "当前为个人会话。"),
    };
  }

  async #retryConnection(): Promise<void> {
    this.#offlineDetail = "";
    this.#starting = true;
    this.#root.setAttribute("aria-busy", "true");
    this.#render();
    try {
      await this.#transport.connect(this.#handlers());
      this.#online = true;
    } catch (error) {
      this.#online = false;
      this.#offlineDetail = error instanceof DaemonUnavailable ? error.detail : describe(error);
    }
    this.#starting = false;
    this.#root.removeAttribute("aria-busy");
    this.#render();
  }

  #tierContext(): TierContext {
    // 密度是纯视图关注点：投影永远以用户当前选择为准，服务端补丁不得把界面拉回 Workbench。
    this.#model.setDensity(this.#density.current);
    return {
      density: this.#density.current,
      rev: this.#model.rev,
      rows: this.#model.visibleRows(),
      transcript: this.#transcript,
      cards: this.#cards,
      selection: this.#selection,
      online: this.#online,
      starting: this.#starting,
      offlineDetail: this.#offlineDetail,
      session: this.#sessionInfo(),
      onboarding: this.#onboardingVisible
        ? { step: this.#onboardingStep, total: 3 }
        : null,
      rawSnapshot: JSON.stringify(this.#model.snapshot(), null, 2),
      actions: this.#actions(),
    };
  }

  #render(options: RenderOptions = {}): void {
    this.#root.dataset.density = this.#density.current;
    this.#root.dataset.connection = this.#online ? "online" : "offline";
    this.#root.dataset.transport = this.#online ? this.#transportKind : "offline";

    for (const [density, button] of this.#densityButtons) {
      button.setAttribute("aria-pressed", density === this.#density.current ? "true" : "false");
    }
    this.#transportEl.textContent = !this.#online
      ? "离线"
      : this.#transportKind === "websocket"
        ? "WebSocket"
        : "HTTP 回退";
    this.#renderCache();

    const active = this.#doc.activeElement as HTMLElement | null;
    const focusKey = active?.closest<HTMLElement>("[data-focus-key]")?.dataset["focusKey"] ?? null;
    // 标题自身在重渲染时会被替换：记住"焦点原本在标题上"，替换后重新落位，
    // 避免流式事件追加渲染导致键盘用户丢失焦点。
    const keepHeadingFocus = active?.tagName === "H1" && this.#host.contains(active);

    const ctx = this.#tierContext();
    const tier =
      this.#density.current === "companion"
        ? renderCompanion(ctx)
        : this.#density.current === "workbench"
          ? renderWorkbench(ctx)
          : renderInspector(ctx);
    this.#host.replaceChildren(tier);

    this.#input.disabled = this.#starting || !this.#online;
    this.#submit.disabled = this.#starting || !this.#online;

    if (options.focusHeading || keepHeadingFocus) {
      this.#host.querySelector<HTMLElement>("h1")?.focus();
    } else if (options.focusComposer && this.#online) {
      this.#input.focus();
    } else if (focusKey) {
      const restored = [...this.#host.querySelectorAll<HTMLElement>("[data-focus-key]")].find(
        (element) => element.dataset["focusKey"] === focusKey,
      );
      restored?.focus();
    }
  }

  #renderCache(): void {
    this.#cacheEl.replaceChildren();
    this.#cacheEl.removeAttribute("data-cache-degraded");
    this.#cacheEl.removeAttribute("title");
    const cache = this.#cache;
    if (!cache) {
      this.#cacheEl.textContent = "缓存：未检测";
      return;
    }
    if (cache.status.degraded) {
      this.#cacheEl.dataset["cacheDegraded"] = cache.status.degraded;
      this.#cacheEl.textContent = "缓存：内存（刷新后草稿丢失）";
      this.#cacheEl.setAttribute("title", cache.status.detail);
      return;
    }
    this.#cacheEl.textContent = "缓存：OPFS 单写者";
    this.#cacheEl.setAttribute("title", cache.status.detail);
  }
}

export { PatchSequenceError };
