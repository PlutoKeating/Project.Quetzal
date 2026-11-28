// 记录：时间线，按天分组，每条一行等宽的时间、动作与对象；选中后出处栏显示完整内容。
import { DaemonUnreachable, SeaError } from "../api/client.js";
import type { AuditItem, AuditPage, MemoryDetail } from "../api/types.js";
import { hrefFor, viewInfo } from "../shell/routes.js";
import { byData, cls, h, redraw, type Child } from "../ui/dom.js";
import { formatClock, formatDate, formatDateTime, formatDayHeading, isoTime } from "../ui/format.js";
import { describeError, situation } from "../ui/situation.js";
import { BaseView, type ViewContext } from "./base.js";
import { actorLabel } from "./entry.js";

const PAGE_SIZE = 50;

/** 写入的种类怎么读出来；不认识的种类原样显示。 */
const KIND_LABEL: Record<string, string> = {
  entry_created: "记下",
  entry_update: "改",
  entry_mute: "不主动提",
  entry_unmute: "恢复主动提",
  entry_erase: "抹除",
  entry_expired: "过期",
  core_change: "核心变化",
  baseline_sign: "签署底线",
  focus_set: "调节",
  device_added: "加入设备",
  device_revoke: "吊销设备",
  import: "导入",
};

export function auditKindLabel(kind: string): string {
  return KIND_LABEL[kind] ?? kind;
}

type EntryState = MemoryDetail | "loading" | "gone";

export class AuditView extends BaseView<AuditPage> {
  #items: AuditItem[] = [];
  #nextCursor: string | null = null;
  #selectedSeq: number | null = null;
  #loadingMore = false;
  #failure: string | null = null;
  readonly #entries = new Map<string, EntryState>();

  constructor(ctx: ViewContext) {
    super(ctx, viewInfo("audit"));
  }

  protected fetch(): Promise<AuditPage> {
    return this.ctx.api.audit({ limit: PAGE_SIZE });
  }

  protected render(): void {
    const page = this.data;
    if (!page) return;
    this.#items = [...page.items];
    this.#nextCursor = page.next_cursor;
    this.#failure = null;
    if (!this.#items.some((item) => item.seq === this.#selectedSeq)) this.#selectedSeq = null;
    this.#draw();
  }

  #draw(): void {
    if (this.#items.length === 0) {
      redraw(this.body, [
        situation({
          kind: "audit-empty",
          tone: "neutral",
          word: "还没有",
          title: "还没有任何写入",
          body: "他记下一件事、你改了一条、底线被签署、设备被吊销——每一次写入都会在这里留下一行：谁，在什么时候，写了什么。",
          steps: [
            { title: "他写下的", text: "从相处里沉淀的往事，经过独立审查才写入。" },
            { title: "你写下的", text: "你在这里改的、抹的、签的每一步。" },
            { title: "系统写下的", text: "导入、过期、设备的加入与吊销。" },
          ],
          link: { label: "看他记得的往事", href: hrefFor("memories") },
        }),
      ]);
      this.defaultProvenance();
      return;
    }

    const now = this.ctx.now();
    const groups: Child[] = [];
    let day = "";
    let rows: HTMLElement[] = [];
    const flush = (): void => {
      if (rows.length > 0) groups.push(h("ol", { class: "qz-timeline" }, ...rows));
      rows = [];
    };
    for (const item of this.#items) {
      const key = formatDate(item.at_ms);
      if (key !== day) {
        flush();
        day = key;
        groups.push(h("h2", { class: "qz-timeline-day", "data-day": key }, formatDayHeading(item.at_ms, now)));
      }
      rows.push(this.#row(item));
    }
    flush();

    redraw(this.body, [
      h("div", { "data-role": "audit-timeline", "data-roving": true }, ...groups),
      h(
        "div",
        { class: "qz-list-foot" },
        h("span", { class: "qz-meta", "data-role": "audit-shown" }, `已显示 ${this.#items.length} 条`),
        this.#nextCursor === null
          ? h("span", { class: "qz-meta" }, "这是最早的一条")
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
              this.#loadingMore ? "正在读取" : "更早的记录",
            ),
      ),
      this.#failure === null
        ? null
        : h("p", { class: "qz-field-hint is-amber", "data-role": "audit-error" }, this.#failure),
    ]);
    this.#updateProvenance();
  }

  #row(item: AuditItem): HTMLElement {
    const current = item.seq === this.#selectedSeq;
    return h(
      "li",
      {
        class: cls(
          "qz-timeline-item qz-row is-ledger",
          item.actor === "owner" && "is-amber",
          current && "is-current",
        ),
        "data-entry": String(item.seq),
        "data-actor": item.actor,
      },
      h("time", { class: "qz-ledger-time", datetime: isoTime(item.at_ms) }, formatClock(item.at_ms)),
      h("span", { class: "qz-ledger-kind" }, auditKindLabel(item.kind)),
      h(
        "button",
        {
          type: "button",
          class: "qz-pick",
          "aria-current": current ? "true" : null,
          "data-focus-key": `audit:${item.seq}`,
          onclick: () => this.#select(item),
        },
        h("span", { class: "qz-row-text" }, item.summary),
      ),
      h("span", { class: "qz-meta" }, actorLabel(item.actor)),
    );
  }

  #select(item: AuditItem): void {
    this.#selectedSeq = this.#selectedSeq === item.seq ? null : item.seq;
    this.#draw();
    if (this.#selectedSeq !== null && item.entry_id !== null) this.#loadEntry(item.entry_id);
  }

  /** 记录只带一句摘要；它写的那一条的完整内容另外读。 */
  #loadEntry(entryId: string): void {
    if (this.#entries.has(entryId)) return;
    this.#entries.set(entryId, "loading");
    this.#updateProvenance();
    this.ctx.api.memory(entryId).then(
      (detail) => {
        this.#entries.set(entryId, detail);
        this.#updateProvenance();
      },
      (error: unknown) => {
        if (error instanceof SeaError) this.#entries.set(entryId, "gone");
        else this.#entries.delete(entryId);
        this.#updateProvenance();
      },
    );
  }

  async #loadMore(): Promise<void> {
    const cursor = this.#nextCursor;
    if (cursor === null || this.#loadingMore) return;
    this.#loadingMore = true;
    this.#draw();
    try {
      const page = await this.ctx.api.audit({ cursor, limit: PAGE_SIZE });
      const known = new Set(this.#items.map((item) => item.seq));
      this.#items.push(...page.items.filter((item) => !known.has(item.seq)));
      this.#nextCursor = page.next_cursor;
      this.#failure = null;
      this.ctx.say(`又读出 ${page.items.length} 条更早的记录。`);
    } catch (error) {
      this.#failure = error instanceof DaemonUnreachable ? null : `没有读出来：${describeError(error)}`;
      if (this.#failure !== null) this.ctx.alert(this.#failure);
    }
    this.#loadingMore = false;
    this.#draw();
  }

  #updateProvenance(): void {
    const item = this.#items.find((entry) => entry.seq === this.#selectedSeq);
    if (!item) {
      this.defaultProvenance();
      return;
    }
    const entry = item.entry_id === null ? null : (this.#entries.get(item.entry_id) ?? null);
    const facts = [
      { term: "时间", value: formatDateTime(item.at_ms) },
      { term: "动作", value: auditKindLabel(item.kind) },
      { term: "由", value: actorLabel(item.actor) },
      { term: "序号", value: String(item.seq), mono: true },
    ];
    let lead = "这一次写入没有落在某一条往事上。";
    let list: { label: string; items: string[] } | undefined;
    let link: { label: string; href: string } | undefined;
    if (item.entry_id !== null) {
      if (entry === null || entry === "loading") {
        lead = "这一次写入落在一条往事上。";
      } else if (entry === "gone") {
        lead = "这一次写入落在一条往事上，那一条现在已经不在了。";
      } else {
        lead = "这一次写入落在下面这条往事上。";
        list = { label: "它现在的内容", items: [entry.text] };
        link = { label: "在往事里看它", href: hrefFor("memories", entry.id) };
      }
    }
    this.ctx.provenance(
      {
        title: item.summary,
        lead,
        facts,
        list,
        link,
        pending: entry === "loading",
      },
      byData(this.body, "entry", String(item.seq)),
    );
  }
}
