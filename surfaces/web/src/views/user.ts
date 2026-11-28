// 我：两栏对照——左是偏好（他据此调整做法），右是事实（他据此理解我）。
// 选中一条，它就地展开三个动作；出处栏写明它从哪次相处来、有没有被纠正过。
import { SeaError } from "../api/client.js";
import type { MemoryItem, SeaUser } from "../api/types.js";
import { hrefFor, viewInfo } from "../shell/routes.js";
import { byData, cls, h, redraw, type Child } from "../ui/dom.js";
import { formatDate } from "../ui/format.js";
import { mutedMark, ownerMark } from "../ui/marks.js";
import { situation } from "../ui/situation.js";
import { BaseView, type ViewContext } from "./base.js";
import { entryActions, entryProvenance, type DetailState } from "./entry.js";

interface Entry {
  id: string;
  text: string;
  since_ms: number;
  by_owner: boolean;
  muted: boolean;
  /** 事实自带完整的条目；偏好只有陈述。 */
  item: MemoryItem | null;
}

interface Columns {
  preferences: Entry[];
  facts: Entry[];
}

export class UserView extends BaseView<SeaUser> {
  #columns: Columns = { preferences: [], facts: [] };
  #selectedId: string | null = null;
  readonly #details = new Map<string, DetailState>();
  readonly #recent = new Map<string, string>();
  #notice: string | null = null;

  constructor(ctx: ViewContext) {
    super(ctx, viewInfo("user"));
  }

  protected fetch(): Promise<SeaUser> {
    return this.ctx.api.user();
  }

  protected render(): void {
    const data = this.data;
    if (!data) return;
    this.#columns = {
      preferences: data.preferences.map((preference) => ({
        id: preference.id,
        text: preference.statement,
        since_ms: preference.since_ms,
        by_owner: preference.by_owner,
        // 契约里偏好没有 muted 字段：沿用这一次会话里已知的状态。
        muted: this.#find(preference.id)?.muted ?? false,
        item: null,
      })),
      facts: data.facts.map((fact) => ({
        id: fact.id,
        text: fact.text,
        since_ms: fact.since_ms,
        by_owner: fact.by_owner,
        muted: fact.muted,
        item: fact,
      })),
    };
    if (this.#selectedId !== null && !this.#find(this.#selectedId)) this.#selectedId = null;
    this.#draw();
  }

  #find(id: string): Entry | undefined {
    return (
      this.#columns.preferences.find((entry) => entry.id === id) ??
      this.#columns.facts.find((entry) => entry.id === id)
    );
  }

  #draw(): void {
    const { preferences, facts } = this.#columns;
    if (preferences.length === 0 && facts.length === 0) {
      redraw(this.body, [
        situation({
          kind: "user-empty",
          tone: "neutral",
          word: "还没有",
          title: "他还没有记下关于你的事",
          body: "偏好和事实都从相处里来：你怎么说话、在意什么、提到过什么。不用专门告诉他，也不用在这里填。",
          steps: [
            { title: "把他接进宿主", text: "在终端运行 qz connect。" },
            { title: "照常用你的工具", text: "聊过的会被当作信号收回来，经过审查才写下。" },
            { title: "回来核对", text: "他记下的每一条都在这里，可以改、不主动提或抹除。" },
          ],
          link: { label: "看宿主接上没有", href: hrefFor("hosts") },
        }),
      ]);
      this.#updateProvenance();
      return;
    }
    redraw(this.body, [
      h(
        "div",
        { class: "qz-rail is-2", "data-role": "compare" },
        this.#column("preferences", "偏好", "他据此调整做法", preferences, {
          word: "还没有",
          title: "他还没有记下你的偏好",
          body: "你在相处里反复表现出的做法——怎么回答、多长、什么语气——会被记到这里。",
        }),
        this.#column("facts", "事实", "他据此理解你", facts, {
          word: "还没有",
          title: "他还没有记下关于你的事实",
          body: "你提到过的、关于你自己的事会被记到这里：你做什么、在意什么、正在经历什么。",
        }),
      ),
    ]);
    this.#updateProvenance();
  }

  #column(
    key: string,
    title: string,
    sub: string,
    entries: readonly Entry[],
    empty: { word: string; title: string; body: string },
  ): HTMLElement {
    const headingId = `sea-user-${key}`;
    const content: Child =
      entries.length === 0
        ? situation({
            kind: `${key}-empty`,
            tone: "neutral",
            ...empty,
            compact: true,
            headingLevel: 3,
          })
        : h(
            "ul",
            { class: "qz-list", "data-roving": true, "aria-labelledby": headingId },
            ...entries.map((entry) => this.#row(entry)),
          );
    return h(
      "section",
      { class: "qz-cell", "data-column": key, "aria-labelledby": headingId },
      h(
        "div",
        { class: "qz-cell-head" },
        h("h2", { class: "qz-cell-title", id: headingId }, title),
        h("span", { class: "qz-meta" }, `${entries.length} 条`),
      ),
      h("p", { class: "qz-cell-sub" }, sub),
      content,
    );
  }

  #row(entry: Entry): HTMLElement {
    const current = entry.id === this.#selectedId;
    return h(
      "li",
      { class: cls("qz-row", current && "is-current"), "data-entry": entry.id },
      h(
        "button",
        {
          type: "button",
          class: "qz-pick",
          "aria-current": current ? "true" : null,
          "aria-expanded": current,
          "data-focus-key": `entry:${entry.id}`,
          onclick: () => this.#select(entry.id),
        },
        h("span", { class: "qz-row-text" }, entry.text),
      ),
      h(
        "div",
        { class: "qz-row-meta" },
        h("span", { class: "qz-meta" }, `自 ${formatDate(entry.since_ms)} 起`),
        entry.by_owner ? ownerMark() : null,
        entry.muted ? mutedMark() : null,
      ),
      current
        ? h(
            "div",
            { class: "qz-row-detail" },
            entryActions({
              ctx: this.ctx,
              id: entry.id,
              text: entry.text,
              muted: entry.muted,
              onUpdated: (text) => {
                entry.text = text;
                entry.by_owner = true;
                if (entry.item) entry.item = { ...entry.item, text, by_owner: true };
                this.#changed(entry.id);
              },
              onMuted: (muted) => {
                entry.muted = muted;
                if (entry.item) entry.item = { ...entry.item, muted };
                this.#changed(entry.id);
              },
              onErased: () => {
                const column = this.#columns.facts.includes(entry)
                  ? this.#columns.facts
                  : this.#columns.preferences;
                const index = column.indexOf(entry);
                const neighbour = column[index + 1] ?? column[index - 1];
                this.#columns = {
                  preferences: this.#columns.preferences.filter((item) => item.id !== entry.id),
                  facts: this.#columns.facts.filter((item) => item.id !== entry.id),
                };
                this.#selectedId = null;
                this.#details.delete(entry.id);
                this.#notice = "刚刚由你抹除";
                this.ctx.overviewChanged();
                this.#draw();
                // 被抹除的那一行不在了：焦点交给相邻的一条，没有就交给页面标题。
                const next = neighbour ? byData(this.body, "focus-key", `entry:${neighbour.id}`) : null;
                if (next) next.focus();
                else this.focusHeading();
              },
            }),
          )
        : null,
    );
  }

  /** 写操作成功：这一条就地更新，出处栏追加一行，再把它的来历重新读一遍。 */
  #changed(id: string): void {
    this.#recent.set(id, "刚刚由你修改");
    this.#details.delete(id);
    this.ctx.overviewChanged();
    this.#draw();
    this.#loadDetail(id);
  }

  #select(id: string): void {
    this.#notice = null;
    this.#selectedId = this.#selectedId === id ? null : id;
    this.#draw();
    if (this.#selectedId !== null) this.#loadDetail(this.#selectedId);
  }

  #loadDetail(id: string): void {
    if (this.#details.has(id)) return;
    this.#details.set(id, "loading");
    this.#updateProvenance();
    this.ctx.api.memory(id).then(
      (detail) => {
        this.#details.set(id, detail);
        if (this.#selectedId === id) this.#updateProvenance();
      },
      (error: unknown) => {
        // 这一条的来历读不出来不影响它本身：出处栏照常显示已经知道的部分。
        if (error instanceof SeaError) this.#details.set(id, "missing");
        else this.#details.delete(id);
        if (this.#selectedId === id) this.#updateProvenance();
      },
    );
  }

  #anchor(id: string): HTMLElement | null {
    return byData(this.body, "entry", id);
  }

  #updateProvenance(): void {
    const entry = this.#selectedId === null ? undefined : this.#find(this.#selectedId);
    if (!entry) {
      this.defaultProvenance({ recent: this.#notice });
      return;
    }
    this.ctx.provenance(
      entryProvenance({
        text: entry.text,
        since_ms: entry.since_ms,
        by_owner: entry.by_owner,
        item: entry.item,
        detail: this.#details.get(entry.id) ?? null,
        recent: this.#recent.get(entry.id) ?? null,
        now: this.ctx.now(),
      }),
      this.#anchor(entry.id),
    );
  }
}
