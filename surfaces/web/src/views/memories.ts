// 往事：主从结构。左列是结果（上方一个搜索框与一个分段控件：全部、不主动提、已过期）；
// 右侧是选中条目的全文、来历、生效时间与三个动作。结果按页读取，不做无限长的单列。
import { DaemonUnreachable } from "../api/client.js";
import type { MemoriesPage, MemoryDetail, MemoryItem, MemoryState } from "../api/types.js";
import { hrefFor, viewInfo } from "../shell/routes.js";
import { byData, cls, h, redraw, searchIcon, type Child } from "../ui/dom.js";
import { excerpt, formatDate } from "../ui/format.js";
import { mutedMark, ownerMark, stateWord } from "../ui/marks.js";
import { describeError, situation } from "../ui/situation.js";
import { BaseView, type ViewContext } from "./base.js";
import {
  entryActions,
  entryProvenance,
  isExpired,
  sourceLabel,
  validityText,
  type DetailState,
} from "./entry.js";

type Filter = "all" | MemoryState;

const FILTERS: ReadonlyArray<{ key: Filter; label: string }> = [
  { key: "all", label: "全部" },
  { key: "muted", label: "不主动提" },
  { key: "expired", label: "已过期" },
];

const PAGE_SIZE = 50;
const SEARCH_DELAY_MS = 250;

export class MemoriesView extends BaseView<MemoriesPage> {
  #query = "";
  #filter: Filter = "all";
  #items: MemoryItem[] = [];
  #nextCursor: string | null = null;
  #total = 0;
  #selectedId: string | null = null;
  #detail: DetailState = null;
  #detailFailure: string | null = null;
  #notice: string | null = null;
  #loadingMore = false;
  #listFailure: string | null = null;
  #searchTimer: ReturnType<typeof setTimeout> | null = null;
  #listGeneration = 0;
  #detailGeneration = 0;
  readonly #recent = new Map<string, string>();

  readonly #search: HTMLInputElement;
  readonly #tabs: HTMLElement;
  readonly #count: HTMLElement;
  readonly #toolbar: HTMLElement;
  readonly #content: HTMLElement;

  constructor(ctx: ViewContext) {
    super(ctx, viewInfo("memories"));
    this.#search = h("input", {
      type: "search",
      placeholder: "搜索往事",
      "aria-label": "搜索往事",
      autocomplete: "off",
      "data-role": "memory-search",
    });
    this.#search.addEventListener("input", () => {
      if (this.#searchTimer !== null) clearTimeout(this.#searchTimer);
      this.#searchTimer = setTimeout(() => {
        this.#searchTimer = null;
        const next = this.#search.value.trim();
        if (next === this.#query) return;
        this.#query = next;
        void this.#reloadList();
      }, SEARCH_DELAY_MS);
    });
    this.#tabs = h("div", {
      class: "qz-segmented",
      role: "tablist",
      "aria-label": "按状态看往事",
      "data-role": "memory-filter",
    });
    this.#tabs.addEventListener("keydown", (event) => this.#onTabKey(event));
    this.#count = h("span", { class: "qz-meta", "data-role": "memory-total" });
    this.#toolbar = h(
      "div",
      { class: "qz-toolbar" },
      h("label", { class: "qz-input" }, searchIcon(), this.#search),
      this.#tabs,
      this.#count,
    );
    this.#content = h("div", {
      id: "sea-memories-panel",
      role: "tabpanel",
      "data-role": "memory-panel",
    });
  }

  protected fetch(): Promise<MemoriesPage> {
    return this.ctx.api.memories(this.#listQuery());
  }

  protected render(): void {
    const page = this.data;
    if (!page) return;
    this.#items = [...page.items];
    this.#nextCursor = page.next_cursor;
    this.#total = page.total;
    this.#listFailure = null;
    // 从「记录」页带着一条往事的 id 过来：直接选中它，即使它不在这一页结果里。
    const linked = this.param !== null;
    if (linked) {
      this.#selectedId = this.param;
      this.#detail = null;
      this.#detailFailure = null;
      this.param = null;
    }
    this.#settleSelection(linked);
    this.#draw();
    if (this.#selectedId !== null) this.#loadDetail(this.#selectedId);
  }

  #listQuery(cursor?: string): {
    query?: string;
    state?: MemoryState;
    cursor?: string;
    limit: number;
  } {
    return {
      ...(this.#query === "" ? {} : { query: this.#query }),
      ...(this.#filter === "all" ? {} : { state: this.#filter }),
      ...(cursor === undefined ? {} : { cursor }),
      limit: PAGE_SIZE,
    };
  }

  /** 选中的条目不在结果里、也没有读出全文时：宽屏选第一条，窄屏回到列表。 */
  #settleSelection(linked: boolean): void {
    const id = this.#selectedId;
    if (id !== null) {
      if (linked) return;
      if (this.#items.some((item) => item.id === id)) return;
      if (this.#detailFor(id) !== null) return;
    }
    this.#selectedId = this.ctx.narrow() ? null : (this.#items[0]?.id ?? null);
    this.#detail = null;
    this.#detailFailure = null;
  }

  #detailFor(id: string): MemoryDetail | null {
    return typeof this.#detail === "object" && this.#detail !== null && this.#detail.id === id
      ? this.#detail
      : null;
  }

  async #reloadList(): Promise<void> {
    this.#listGeneration += 1;
    const generation = this.#listGeneration;
    this.#content.setAttribute("aria-busy", "true");
    try {
      const page = await this.ctx.api.memories(this.#listQuery());
      if (generation !== this.#listGeneration) return;
      this.data = page;
      this.#items = [...page.items];
      this.#nextCursor = page.next_cursor;
      this.#total = page.total;
      this.#listFailure = null;
      this.#selectedId = this.ctx.narrow() ? null : (this.#items[0]?.id ?? null);
      this.#detail = null;
      this.#detailFailure = null;
    } catch (error) {
      if (generation !== this.#listGeneration) return;
      this.#listFailure =
        error instanceof DaemonUnreachable ? null : `没有读出来：${describeError(error)}`;
      if (this.#listFailure !== null) this.ctx.alert(this.#listFailure);
    }
    this.#content.removeAttribute("aria-busy");
    this.#draw();
    if (this.#selectedId !== null) this.#loadDetail(this.#selectedId);
  }

  async #loadMore(): Promise<void> {
    const cursor = this.#nextCursor;
    if (cursor === null || this.#loadingMore) return;
    this.#loadingMore = true;
    this.#draw();
    try {
      const page = await this.ctx.api.memories(this.#listQuery(cursor));
      const known = new Set(this.#items.map((item) => item.id));
      this.#items.push(...page.items.filter((item) => !known.has(item.id)));
      this.#nextCursor = page.next_cursor;
      this.#total = page.total;
      this.#listFailure = null;
      this.ctx.say(`又读出 ${page.items.length} 件，共显示 ${this.#items.length} 件。`);
    } catch (error) {
      this.#listFailure =
        error instanceof DaemonUnreachable ? null : `没有读出来：${describeError(error)}`;
      if (this.#listFailure !== null) this.ctx.alert(this.#listFailure);
    }
    this.#loadingMore = false;
    this.#draw();
  }

  #loadDetail(id: string): void {
    if (this.#detailFor(id) !== null) return;
    this.#detailGeneration += 1;
    const generation = this.#detailGeneration;
    this.#detail = "loading";
    this.#detailFailure = null;
    this.#drawDetailAndProvenance();
    this.ctx.api.memory(id).then(
      (detail) => {
        if (generation !== this.#detailGeneration || this.#selectedId !== id) return;
        this.#detail = detail;
        this.#drawDetailAndProvenance();
      },
      (error: unknown) => {
        if (generation !== this.#detailGeneration || this.#selectedId !== id) return;
        if (error instanceof DaemonUnreachable) {
          this.#detail = null;
        } else {
          this.#detail = "missing";
          this.#detailFailure = describeError(error);
        }
        this.#drawDetailAndProvenance();
      },
    );
  }

  #select(id: string | null): void {
    this.#notice = null;
    this.#selectedId = id;
    this.#detail = null;
    this.#detailFailure = null;
    this.#draw();
    if (id !== null) {
      this.#loadDetail(id);
      if (this.ctx.narrow()) {
        this.#content.querySelector<HTMLElement>('[data-role="memory-back"]')?.focus();
      }
    }
  }

  #setFilter(filter: Filter): void {
    if (filter === this.#filter) return;
    this.#filter = filter;
    this.#drawToolbar();
    void this.#reloadList();
  }

  #onTabKey(event: KeyboardEvent): void {
    const index = FILTERS.findIndex((item) => item.key === this.#filter);
    let next = index;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") next = (index + 1) % FILTERS.length;
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      next = (index - 1 + FILTERS.length) % FILTERS.length;
    } else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = FILTERS.length - 1;
    else return;
    event.preventDefault();
    const target = FILTERS[next];
    if (!target) return;
    this.#setFilter(target.key);
    byData(this.#tabs, "filter", target.key)?.focus();
  }

  #drawToolbar(): void {
    redraw(
      this.#tabs,
      FILTERS.map((item) => {
        const active = item.key === this.#filter;
        return h(
          "button",
          {
            type: "button",
            id: `sea-memories-tab-${item.key}`,
            role: "tab",
            class: cls("qz-segment", active && "is-active"),
            "aria-selected": active,
            "aria-controls": "sea-memories-panel",
            tabindex: active ? 0 : -1,
            "data-filter": item.key,
            "data-focus-key": `filter:${item.key}`,
            onclick: () => this.#setFilter(item.key),
          },
          item.label,
        );
      }),
    );
    this.#content.setAttribute("aria-labelledby", `sea-memories-tab-${this.#filter}`);
    this.#count.textContent = `共 ${this.#total} 件`;
  }

  #draw(): void {
    if (this.#toolbar.parentElement !== this.body || this.#content.parentElement !== this.body) {
      this.body.replaceChildren(this.#toolbar, this.#content);
    }
    this.#drawToolbar();

    const nothingAtAll =
      this.#items.length === 0 && this.#query === "" && this.#filter === "all" && this.#selectedId === null;
    if (nothingAtAll && this.#listFailure === null) {
      redraw(this.#content, [
        situation({
          kind: "memories-empty",
          tone: "neutral",
          word: "还没有",
          title: "他还没有任何往事",
          body: "往事从相处里来。你在宿主里和他聊过的事，会被当作信号收回来，经过独立审查才写下。也可以把过去带进来。",
          steps: [
            { title: "把他接进宿主", text: "在终端运行 qz connect。" },
            { title: "照常相处", text: "聊过的会自己沉淀，不需要你确认。" },
            { title: "回来核对", text: "每一件都能在这里搜到、改掉、不主动提或抹除。" },
          ],
          link: { label: "看宿主接上没有", href: hrefFor("hosts") },
        }),
      ]);
      this.#updateProvenance();
      return;
    }

    const split = h(
      "div",
      {
        class: cls("qz-split", this.#selectedId !== null && "has-selection"),
        "data-role": "memory-split",
      },
      h("div", { class: "qz-split-list", "data-role": "memory-list" }, ...this.#listChildren()),
      h(
        "div",
        { class: "qz-split-detail" },
        h("div", { class: "qz-split-detail-inner", "data-role": "memory-detail" }, ...this.#detailChildren()),
      ),
    );
    redraw(this.#content, [split]);
    this.#updateProvenance();
  }

  #drawDetailAndProvenance(): void {
    const slot = this.#content.querySelector<HTMLElement>('[data-role="memory-detail"]');
    if (slot) redraw(slot, this.#detailChildren());
    this.#updateProvenance();
  }

  #listChildren(): Child[] {
    if (this.#items.length === 0) {
      return [this.#emptyList()];
    }
    const now = this.ctx.now();
    const remaining = Math.max(0, this.#total - this.#items.length);
    return [
      h(
        "ul",
        { class: "qz-list", "data-roving": true, "aria-label": "往事" },
        ...this.#items.map((item) => {
          const current = item.id === this.#selectedId;
          return h(
            "li",
            { class: cls("qz-row", current && "is-current"), "data-entry": item.id },
            h(
              "button",
              {
                type: "button",
                class: "qz-pick",
                "aria-current": current ? "true" : null,
                "data-focus-key": `memory:${item.id}`,
                onclick: () => this.#select(item.id),
              },
              h("span", { class: "qz-row-text" }, excerpt(item.text, 64)),
            ),
            h(
              "div",
              { class: "qz-row-meta" },
              h("span", { class: "qz-meta" }, `${formatDate(item.since_ms)} · ${item.source.label}`),
              item.by_owner ? ownerMark() : null,
              item.muted ? mutedMark() : null,
              isExpired(item, now) ? stateWord("neutral", "已过期") : null,
            ),
          );
        }),
      ),
      h(
        "div",
        { class: "qz-list-foot" },
        h("span", { class: "qz-meta", "data-role": "memory-shown" }, `已显示 ${this.#items.length} / ${this.#total}`),
        this.#nextCursor === null
          ? null
          : h(
              "button",
              {
                type: "button",
                class: "qz-btn-outline is-compact",
                disabled: this.#loadingMore,
                "data-action": "load-more",
                "data-focus-key": "load-more",
                onclick: () => void this.#loadMore(),
              },
              this.#loadingMore ? "正在读取" : remaining > 0 ? `再看 ${Math.min(PAGE_SIZE, remaining)} 件` : "再看一些",
            ),
      ),
      this.#listFailure === null
        ? null
        : h("p", { class: "qz-field-hint is-amber", "data-role": "memory-list-error" }, this.#listFailure),
    ];
  }

  #emptyList(): HTMLElement {
    if (this.#listFailure !== null) {
      return situation({
        kind: "memories-failed",
        tone: "amber",
        word: "读取失败",
        title: "这一组往事没有读出来",
        body: this.#listFailure,
        compact: true,
        headingLevel: 3,
        action: { label: "重试", run: () => void this.#reloadList() },
      });
    }
    if (this.#query !== "") {
      return situation({
        kind: "memories-no-match",
        tone: "neutral",
        word: "没有找到",
        title: `没有找到「${this.#query}」`,
        body: "换一个更短的词，或者换一种说法。他记下的是事情本身，不一定是你当时的原话。",
        compact: true,
        headingLevel: 3,
        action: {
          label: "清空搜索",
          run: () => {
            this.#search.value = "";
            this.#query = "";
            void this.#reloadList();
            this.#search.focus();
          },
        },
      });
    }
    if (this.#filter === "muted") {
      return situation({
        kind: "memories-none-muted",
        tone: "neutral",
        word: "没有",
        title: "没有不主动提的往事",
        body: "在一件往事上点「不主动提」，他仍然记得，但不会再主动提起。那样的往事会列在这里。",
        compact: true,
        headingLevel: 3,
        action: { label: "看全部往事", run: () => this.#setFilter("all") },
      });
    }
    return situation({
      kind: "memories-none-expired",
      tone: "neutral",
      word: "没有",
      title: "没有已过期的往事",
      body: "有些事只在一段时间里成立。过了期限，它们不再送进宿主，但仍然列在这里备查。",
      compact: true,
      headingLevel: 3,
      action: { label: "看全部往事", run: () => this.#setFilter("all") },
    });
  }

  #current(): MemoryItem | MemoryDetail | null {
    const id = this.#selectedId;
    if (id === null) return null;
    return this.#detailFor(id) ?? this.#items.find((item) => item.id === id) ?? null;
  }

  #detailChildren(): Child[] {
    const id = this.#selectedId;
    const back = h(
      "button",
      {
        type: "button",
        class: "qz-btn-text qz-split-back",
        "data-role": "memory-back",
        "data-focus-key": "memory-back",
        onclick: () => {
          const previous = this.#selectedId;
          this.#select(null);
          if (previous !== null) this.#focusRow(previous);
        },
      },
      "返回列表",
    );
    if (id === null) {
      return [
        situation({
          kind: "memories-nothing-selected",
          tone: "neutral",
          word: "没有选中",
          title: "选一件往事",
          body: "它的全文、来历、生效时间和三个动作会出现在这里。",
          compact: true,
          headingLevel: 3,
        }),
      ];
    }
    const item = this.#current();
    if (item === null) {
      if (this.#detail === "missing") {
        return [
          back,
          situation({
            kind: "memory-missing",
            tone: "amber",
            word: "读不出来",
            title: "这一件往事读不出来",
            body: this.#detailFailure ?? "它可能已经被抹除了。",
            compact: true,
            headingLevel: 3,
            action: { label: "回到列表", run: () => this.#select(this.#items[0]?.id ?? null) },
          }),
        ];
      }
      return [back, h("p", { class: "qz-meta", role: "status" }, "正在读取这一件往事")];
    }
    const now = this.ctx.now();
    return [
      back,
      h(
        "article",
        { class: "qz-detail", "aria-label": "选中的往事", "data-entry-detail": item.id },
        h(
          "div",
          { class: "qz-row-meta" },
          item.topic === null ? null : h("span", { class: "qz-meta" }, item.topic),
          item.by_owner ? ownerMark() : null,
          item.muted ? mutedMark() : null,
          isExpired(item, now) ? stateWord("neutral", "已过期") : null,
        ),
        h("p", { class: "qz-detail-text", "data-role": "memory-text" }, item.text),
        h(
          "dl",
          { class: "qz-deflist" },
          h("dt", null, "来历"),
          h("dd", null, sourceLabel(item)),
          h("dt", null, "生效"),
          h("dd", null, validityText(item, now)),
        ),
        entryActions({
          ctx: this.ctx,
          id: item.id,
          text: item.text,
          muted: item.muted,
          onUpdated: (text) => this.#patch(item.id, { text, by_owner: true }),
          onMuted: (muted) => this.#patch(item.id, { muted }),
          onErased: () => this.#erased(item.id),
        }),
      ),
    ];
  }

  #focusRow(id: string): void {
    byData(this.#content, "focus-key", `memory:${id}`)?.focus();
  }

  /** 写操作成功：列表里的这一条和右侧的全文就地更新，出处栏追加一行。 */
  #patch(id: string, change: Partial<Pick<MemoryItem, "text" | "by_owner" | "muted">>): void {
    this.#items = this.#items.map((item) => (item.id === id ? { ...item, ...change } : item));
    const detail = this.#detailFor(id);
    if (detail) this.#detail = { ...detail, ...change };
    this.#recent.set(id, "刚刚由你修改");
    this.ctx.overviewChanged();
    this.#draw();
    // 它的经过多了一步：安静地重读一遍，读不出来就保留眼前的内容。
    const generation = (this.#detailGeneration += 1);
    this.ctx.api.memory(id).then(
      (fresh) => {
        if (generation !== this.#detailGeneration || this.#selectedId !== id) return;
        this.#detail = fresh;
        this.#items = this.#items.map((item) => (item.id === id ? { ...item, ...fresh } : item));
        this.#drawDetailAndProvenance();
      },
      () => undefined,
    );
  }

  #erased(id: string): void {
    const index = this.#items.findIndex((item) => item.id === id);
    this.#items = this.#items.filter((item) => item.id !== id);
    this.#total = Math.max(0, this.#total - 1);
    this.#recent.delete(id);
    this.#notice = "刚刚由你抹除";
    this.#detail = null;
    this.#detailFailure = null;
    this.#detailGeneration += 1;
    const next = this.ctx.narrow() ? null : (this.#items[index] ?? this.#items[index - 1] ?? null);
    this.#selectedId = next?.id ?? null;
    this.ctx.overviewChanged();
    this.#draw();
    if (this.#selectedId !== null) {
      this.#loadDetail(this.#selectedId);
      this.#focusRow(this.#selectedId);
    } else {
      this.#search.focus();
    }
  }

  #updateProvenance(): void {
    const item = this.#current();
    if (item === null) {
      this.defaultProvenance({
        facts: [{ term: "共有", value: `${this.#total} 件` }],
        recent: this.#notice,
      });
      return;
    }
    this.ctx.provenance({
      ...entryProvenance({
        text: item.text,
        since_ms: item.since_ms,
        by_owner: item.by_owner,
        item,
        detail: this.#detail,
        recent: this.#recent.get(item.id) ?? null,
        now: this.ctx.now(),
      }),
      // 往事的出处栏还保留上一步的痕迹：刚抹除了另一条。
      ...(this.#notice !== null && !this.#recent.has(item.id) ? { recent: this.#notice } : {}),
    });
  }
}
