// 他：上半是核心价值的发丝线栅格（编号、陈述、自何时起），性情列在其后、字号小一级；
// 下半是「最近的变化」时间线，每一条可以展开证据链（哪几次相处、跨多少天）。
import type { CoreValue, SeaSelf, SelfChange, TemperamentItem } from "../api/types.js";
import { hrefFor, viewInfo } from "../shell/routes.js";
import { byData, cls, h, redraw, uniqueId, type Child } from "../ui/dom.js";
import { excerpt, formatDate, formatDateTime, isoTime, ordinal, spanDays } from "../ui/format.js";
import { dot, stateWord } from "../ui/marks.js";
import { situation } from "../ui/situation.js";
import { BaseView, type ViewContext } from "./base.js";

type Selection =
  | { kind: "value"; id: string }
  | { kind: "temperament"; id: string }
  | { kind: "change"; id: string }
  | null;

export class SelfView extends BaseView<SeaSelf> {
  #selection: Selection = null;
  readonly #expanded = new Set<string>();

  constructor(ctx: ViewContext) {
    super(ctx, viewInfo("self"));
  }

  protected fetch(): Promise<SeaSelf> {
    return this.ctx.api.self();
  }

  protected render(): void {
    const data = this.data;
    if (!data) return;
    const waiting = data.changes.filter((change) => !change.acknowledged).length;
    this.setState(waiting > 0 ? stateWord("amber", `${waiting} 处变化等你看`) : null);

    const empty =
      data.identity.length === 0 &&
      data.core_values.length === 0 &&
      data.temperament.length === 0 &&
      data.changes.length === 0;
    if (empty) {
      this.#selection = null;
      redraw(this.body, [
        situation({
          kind: "self-empty",
          tone: "neutral",
          word: "还没有成形",
          title: "他还没有长出自己的样子",
          body: "核心价值和性情不是填出来的。同一件事在多次相处里反复出现，经过冷却，才会沉淀成他的一部分。",
          steps: [
            { title: "把他接进宿主", text: "在终端运行 qz connect，他会住进你已经在用的工具。" },
            { title: "照常相处", text: "不用专门教他。聊过的事会被当作信号收回来。" },
            { title: "回来看", text: "他的核心每变一次，这里就多一条，并写明来处。" },
          ],
          link: { label: "看宿主接上没有", href: hrefFor("hosts") },
        }),
      ]);
      this.defaultProvenance();
      return;
    }

    redraw(this.body, [
      data.identity.length > 0
        ? h(
            "dl",
            { class: "qz-deflist", "data-role": "identity" },
            ...data.identity.flatMap((item) => [h("dt", null, item.label), h("dd", null, item.text)]),
          )
        : null,
      this.#coreSection(data.core_values),
      data.temperament.length > 0 ? this.#temperamentSection(data.temperament) : null,
      this.#changesSection(data),
    ]);
    this.#updateProvenance();
  }

  #select(selection: Selection): void {
    const same =
      this.#selection !== null &&
      selection !== null &&
      this.#selection.kind === selection.kind &&
      this.#selection.id === selection.id;
    this.#selection = same ? null : selection;
    this.render();
  }

  #isCurrent(kind: NonNullable<Selection>["kind"], id: string): boolean {
    return this.#selection?.kind === kind && this.#selection.id === id;
  }

  #coreSection(values: readonly CoreValue[]): HTMLElement {
    const content: Child =
      values.length === 0
        ? situation({
            kind: "core-empty",
            tone: "neutral",
            word: "还没有",
            title: "他的核心还没有成形",
            body: "同一件事在多次相处里反复出现，经过冷却，才会升为核心。这个过程不需要你批准，但每一次都会告诉你。",
            compact: true,
            headingLevel: 3,
          })
        : h(
            "div",
            { class: "qz-rail is-grid is-3", "data-role": "core-values" },
            ...values.map((value, index) => {
              const current = this.#isCurrent("value", value.id);
              return h(
                "div",
                {
                  class: cls("qz-cell is-pickable", current && "is-current"),
                  "data-entry": value.id,
                },
                h("span", { class: "qz-cell-num" }, ordinal(index)),
                h(
                  "h3",
                  { class: "qz-cell-title" },
                  h(
                    "button",
                    {
                      type: "button",
                      class: "qz-pick",
                      "aria-current": current ? "true" : null,
                      "data-focus-key": `value:${value.id}`,
                      onclick: () => this.#select({ kind: "value", id: value.id }),
                    },
                    value.statement,
                  ),
                ),
                h("p", { class: "qz-cell-note" }, `自 ${formatDate(value.since_ms)} 起`),
              );
            }),
          );
    return h(
      "section",
      { class: "qz-view-section", "data-qz-lit": true, "aria-labelledby": "sea-self-core" },
      h(
        "div",
        { class: "qz-view-section-head" },
        h("h2", { class: "qz-view-section-title", id: "sea-self-core" }, "核心价值"),
        h("p", { class: "qz-view-section-note" }, "一次施压改不了它；只有反复出现的证据可以。"),
      ),
      content,
    );
  }

  #temperamentSection(items: readonly TemperamentItem[]): HTMLElement {
    return h(
      "section",
      { class: "qz-view-section", "data-qz-lit": true, "aria-labelledby": "sea-self-temperament" },
      h(
        "div",
        { class: "qz-view-section-head" },
        h("h2", { class: "qz-view-section-title is-minor", id: "sea-self-temperament" }, "性情"),
        h("p", { class: "qz-view-section-note" }, "他说话和做事的习惯，比核心更容易变。"),
      ),
      h(
        "div",
        { class: "qz-rail is-grid is-3", "data-role": "temperament" },
        ...items.map((item) => {
          const current = this.#isCurrent("temperament", item.id);
          return h(
            "div",
            { class: cls("qz-cell is-pickable", current && "is-current"), "data-entry": item.id },
            h(
              "p",
              null,
              h(
                "button",
                {
                  type: "button",
                  class: "qz-pick",
                  "aria-current": current ? "true" : null,
                  "data-focus-key": `temperament:${item.id}`,
                  onclick: () => this.#select({ kind: "temperament", id: item.id }),
                },
                item.statement,
              ),
            ),
            h("p", { class: "qz-cell-note" }, `自 ${formatDate(item.since_ms)} 起`),
          );
        }),
      ),
    );
  }

  #changesSection(data: SeaSelf): HTMLElement {
    const content: Child =
      data.changes.length === 0
        ? situation({
            kind: "changes-empty",
            tone: "neutral",
            word: "没有变化",
            title: "他最近没有变",
            body: "他的核心每变一次，这里就多一条，并写明是从哪几次相处里长出来的。",
            compact: true,
            headingLevel: 3,
          })
        : h(
            "ol",
            { class: "qz-timeline", "data-role": "changes" },
            ...data.changes.map((change) => this.#changeItem(change, data)),
          );
    return h(
      "section",
      { class: "qz-view-section", "data-qz-lit": true, "aria-labelledby": "sea-self-changes" },
      h(
        "div",
        { class: "qz-view-section-head" },
        h("h2", { class: "qz-view-section-title", id: "sea-self-changes" }, "最近的变化"),
        h("p", { class: "qz-view-section-note" }, "他的变化不需要你批准，但每一次都告诉你。"),
      ),
      content,
    );
  }

  #changeItem(change: SelfChange, data: SeaSelf): HTMLElement {
    const current = this.#isCurrent("change", change.id);
    const open = this.#expanded.has(change.id);
    const target = this.#targetStatement(change.target_id, data);
    const span = spanDays(change.evidence.map((evidence) => evidence.at_ms));
    const evidenceId = uniqueId("evidence");
    return h(
      "li",
      {
        class: cls(
          "qz-timeline-item",
          !change.acknowledged && "is-amber",
          current && "is-current",
        ),
        "data-entry": change.id,
      },
      h(
        "time",
        { class: "qz-timeline-time", datetime: isoTime(change.at_ms) },
        formatDate(change.at_ms),
      ),
      h("p", { class: "qz-timeline-text" }, change.summary),
      h(
        "div",
        { class: "qz-row-meta" },
        target === null ? null : h("span", { class: "qz-meta" }, `落在「${excerpt(target, 18)}」`),
        change.acknowledged ? null : stateWord("amber", "等你看"),
      ),
      change.evidence.length === 0
        ? h("p", { class: "qz-meta" }, "这次变化没有附带证据")
        : h(
            "button",
            {
              type: "button",
              class: "qz-btn-text",
              "aria-expanded": open,
              "aria-controls": evidenceId,
              "data-action": "evidence",
              "data-focus-key": `change:${change.id}`,
              onclick: () => {
                if (open) this.#expanded.delete(change.id);
                else this.#expanded.add(change.id);
                this.#selection = { kind: "change", id: change.id };
                this.render();
              },
            },
            `证据：${change.evidence.length} 次相处，跨 ${span} 天`,
          ),
      open
        ? h(
            "ul",
            { class: "qz-signals", id: evidenceId, "data-role": "evidence" },
            ...change.evidence.map((evidence) =>
              h(
                "li",
                { class: "qz-signal" },
                dot("neutral"),
                h("span", null, `在 ${evidence.host} 里的一次相处`),
                h("span", { class: "qz-meta" }, formatDateTime(evidence.at_ms)),
              ),
            ),
          )
        : null,
    );
  }

  #targetStatement(targetId: string, data: SeaSelf): string | null {
    return (
      data.core_values.find((value) => value.id === targetId)?.statement ??
      data.temperament.find((item) => item.id === targetId)?.statement ??
      data.identity.find((item) => item.id === targetId)?.text ??
      null
    );
  }

  #anchor(id: string): HTMLElement | null {
    return byData(this.body, "entry", id);
  }

  #updateProvenance(): void {
    const data = this.data;
    const selection = this.#selection;
    if (!data || selection === null) {
      this.defaultProvenance();
      return;
    }
    if (selection.kind === "value") {
      const value = data.core_values.find((item) => item.id === selection.id);
      if (!value) return this.#clearSelection();
      const related = data.changes.filter((change) => change.target_id === value.id);
      this.ctx.provenance(
        {
          title: value.statement,
          lead: value.rationale ?? "他没有写下为什么。",
          facts: [
            { term: "层", value: "核心价值" },
            { term: "自", value: formatDate(value.since_ms) },
            { term: "证据", value: `${value.evidence_count} 次相处` },
          ],
          events: {
            label: "它的变化",
            items: related.map((change) => ({
              at_ms: change.at_ms,
              text: change.summary,
              tone: change.acknowledged ? ("neutral" as const) : ("amber" as const),
            })),
          },
        },
        this.#anchor(value.id),
      );
      return;
    }
    if (selection.kind === "temperament") {
      const item = data.temperament.find((entry) => entry.id === selection.id);
      if (!item) return this.#clearSelection();
      this.ctx.provenance(
        {
          title: item.statement,
          lead: "性情是他说话和做事的习惯。它跟着相处慢慢变，不需要证据链。",
          facts: [
            { term: "层", value: "性情" },
            { term: "自", value: formatDate(item.since_ms) },
          ],
        },
        this.#anchor(item.id),
      );
      return;
    }
    const change = data.changes.find((entry) => entry.id === selection.id);
    if (!change) return this.#clearSelection();
    const target = this.#targetStatement(change.target_id, data);
    const span = spanDays(change.evidence.map((evidence) => evidence.at_ms));
    this.ctx.provenance(
      {
        title: change.summary,
        lead:
          target === null
            ? "这次变化落在一条已经不在的条目上。"
            : `这次变化落在「${target}」上。`,
        facts: [
          { term: "时间", value: formatDateTime(change.at_ms) },
          {
            term: "证据",
            value:
              change.evidence.length === 0
                ? "没有附带"
                : `${change.evidence.length} 次相处，跨 ${span} 天`,
          },
          { term: "状态", value: change.acknowledged ? "已经告诉过你" : "等你看" },
        ],
        events: {
          label: "长出它的相处",
          items: change.evidence.map((evidence) => ({
            at_ms: evidence.at_ms,
            text: `在 ${evidence.host} 里`,
          })),
        },
      },
      this.#anchor(change.id),
    );
  }

  #clearSelection(): void {
    this.#selection = null;
    this.defaultProvenance();
  }
}
