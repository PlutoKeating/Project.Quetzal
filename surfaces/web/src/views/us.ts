// 我们：上半是共同的承诺；下半是一根横向的刻度——左端「他自己」，右端「我们」，
// 一个可拖动的刻度标记当前位置，下限处有一条不可越过的线。这是全站唯一的滑杆。
import type { Focus, Relation, SeaUs } from "../api/types.js";
import { hrefFor, viewInfo } from "../shell/routes.js";
import { byData, cls, h, redraw, type Child } from "../ui/dom.js";
import { ordinal, percent } from "../ui/format.js";
import { describeError, situation } from "../ui/situation.js";
import { BaseView, type ViewContext } from "./base.js";

const COMMIT_DELAY_MS = 350;

interface Picked {
  relationId: string;
  index: number;
}

export class UsView extends BaseView<SeaUs> {
  #picked: Picked | null = null;
  #recent: string | null = null;
  #failure: string | null = null;
  #commitTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(ctx: ViewContext) {
    super(ctx, viewInfo("us"));
  }

  protected fetch(): Promise<SeaUs> {
    return this.ctx.api.us();
  }

  protected render(): void {
    const data = this.data;
    if (!data) return;
    redraw(this.body, [this.#commitments(data.relations), this.#scaleSection(data.focus)]);
    this.#updateProvenance();
  }

  #commitments(relations: readonly Relation[]): HTMLElement {
    const withCommitments = relations.filter((relation) => relation.commitments.length > 0);
    const content: Child[] =
      withCommitments.length === 0
        ? [
            situation({
              kind: "commitments-empty",
              tone: "neutral",
              word: "还没有",
              title: "你们还没有共同的承诺",
              body: "承诺是你们在相处里一起定下、双方都认的事。它不是你单方面的要求——那是底线；也不是他单方面的看法——那是他的核心。",
              compact: true,
              headingLevel: 3,
              link: { label: "先看他眼里的你", href: hrefFor("user") },
            }),
          ]
        : withCommitments.map((relation) =>
            h(
              "div",
              { class: "qz-rail-group", "data-relation": relation.id },
              h(
                "div",
                { class: "qz-rail-head" },
                h("h3", { class: "qz-rail-title" }, `和${relation.peer}`),
                h(
                  "span",
                  { class: "qz-meta" },
                  `${relation.commitments.length} 条承诺 · 信任 ${percent(relation.trust)}`,
                ),
              ),
              h(
                "div",
                { class: "qz-rail is-grid is-2", "data-role": "commitments" },
              ...relation.commitments.map((commitment, index) => {
                const current =
                  this.#picked?.relationId === relation.id && this.#picked.index === index;
                return h(
                  "div",
                  {
                    class: cls("qz-cell is-pickable", current && "is-current"),
                    "data-entry": `${relation.id}:${index}`,
                  },
                  h("span", { class: "qz-cell-num" }, ordinal(index)),
                  h(
                    "p",
                    { class: "qz-cell-title" },
                    h(
                      "button",
                      {
                        type: "button",
                        class: "qz-pick",
                        "aria-current": current ? "true" : null,
                        "data-focus-key": `commitment:${relation.id}:${index}`,
                        onclick: () => {
                          this.#picked = current ? null : { relationId: relation.id, index };
                          this.render();
                        },
                      },
                      commitment,
                    ),
                  ),
                );
              }),
              ),
            ),
          );
    return h(
      "section",
      { "aria-labelledby": "sea-us-commitments", "data-section": "commitments" },
      h(
        "div",
        { class: "qz-view-section-head" },
        h("h2", { class: "qz-view-section-title", id: "sea-us-commitments" }, "共同的承诺"),
        h("p", { class: "qz-view-section-note" }, "一起定下、双方都认的事。"),
      ),
      ...content,
    );
  }

  #scaleSection(focus: Focus): HTMLElement {
    const limit = percent(1 - focus.floor_self);
    const value = Math.min(percent(focus.us_weight), limit);
    const readout = h("p", { class: "qz-meta-line", "data-role": "focus-readout" });
    const describe = (position: number): string =>
      `他自己 ${100 - position}，我们 ${position}`;
    const paint = (position: number): void => {
      readout.replaceChildren(
        h("span", null, `他自己 ${100 - position}`),
        h("span", { "aria-hidden": "true" }, "·"),
        h("span", null, `我们 ${position}`),
      );
    };
    paint(value);

    const input = this.ctx.guard(
      h("input", {
        type: "range",
        class: "qz-scale-input",
        min: 0,
        max: limit,
        step: 1,
        value,
        "aria-label": "他迎合的对象：往左是他自己，往右是我们",
        "aria-valuetext": describe(value),
        "aria-describedby": "sea-us-floor",
        "data-role": "focus-scale",
        "data-focus-key": "focus-scale",
      }),
      limit === 0,
    );
    input.addEventListener("input", () => {
      const position = input.valueAsNumber;
      input.setAttribute("aria-valuetext", describe(position));
      paint(position);
    });
    input.addEventListener("change", () => this.#scheduleCommit(input.valueAsNumber));

    const scale = h(
      "div",
      { class: "qz-scale", "data-role": "scale" },
      h(
        "div",
        { class: "qz-scale-ends", "aria-hidden": "true" },
        h("span", null, "他自己"),
        h("span", null, "我们"),
      ),
      h(
        "div",
        { class: "qz-scale-track" },
        h("div", { class: "qz-scale-ticks", "aria-hidden": "true" }),
        h("div", { class: "qz-scale-limit", "aria-hidden": "true", "data-role": "scale-limit" }),
        input,
      ),
      h(
        "div",
        { class: "qz-scale-legend" },
        readout,
        h(
          "p",
          { class: "qz-meta", id: "sea-us-floor", "data-role": "focus-floor" },
          focus.floor_locked
            ? `下限：他至少留 ${percent(focus.floor_self)} 给自己 · 已锁定`
            : `下限：他至少留 ${percent(focus.floor_self)} 给自己`,
        ),
      ),
    );
    // 下限的位置是数据，不是样式：经 CSSOM 写进自定义属性，不产生内联样式属性。
    scale.style.setProperty("--qz-scale-limit", String(limit));

    return h(
      "section",
      { class: "qz-view-section", "data-qz-lit": true, "aria-labelledby": "sea-us-focus", "data-section": "focus" },
      h(
        "div",
        { class: "qz-view-section-head" },
        h("h2", { class: "qz-view-section-title", id: "sea-us-focus" }, "他迎合谁"),
        h(
          "p",
          { class: "qz-view-section-note" },
          "往左，他更坚持自己的判断；往右，他更顺着你们的共识。竖线右边是他不会去的地方。",
        ),
      ),
      scale,
      this.#failure === null
        ? null
        : h("p", { class: "qz-field-hint is-amber", "data-role": "focus-error" }, this.#failure),
    );
  }

  #scheduleCommit(position: number): void {
    if (this.#commitTimer !== null) clearTimeout(this.#commitTimer);
    this.#commitTimer = setTimeout(() => {
      this.#commitTimer = null;
      void this.#commit(position);
    }, COMMIT_DELAY_MS);
  }

  async #commit(position: number): Promise<void> {
    const data = this.data;
    if (!data || position === percent(data.focus.us_weight)) return;
    try {
      this.data = await this.ctx.api.focusSet((100 - position) / 100);
      this.#failure = null;
      this.#recent = "刚刚由你调节";
      const settled = percent(this.data.focus.us_weight);
      this.ctx.say(`已调到：他自己 ${100 - settled}，我们 ${settled}。`);
    } catch (error) {
      // 没有调成：刻度回到守护进程里实际的位置。
      this.#failure = `没有调成：${describeError(error)}`;
      this.ctx.alert(this.#failure);
    }
    this.render();
  }

  #anchor(key: string): HTMLElement | null {
    return byData(this.body, "entry", key);
  }

  #updateProvenance(): void {
    const data = this.data;
    if (!data) return;
    const picked = this.#picked;
    const relation = picked ? data.relations.find((item) => item.id === picked.relationId) : undefined;
    const commitment = picked && relation ? relation.commitments[picked.index] : undefined;
    if (!picked || !relation || commitment === undefined) {
      this.#picked = null;
      this.defaultProvenance({
        facts: [
          { term: "他自己", value: String(percent(data.focus.self_weight)) },
          { term: "我们", value: String(percent(data.focus.us_weight)) },
          { term: "下限", value: `${percent(data.focus.floor_self)}${data.focus.floor_locked ? "，已锁定" : ""}` },
        ],
        recent: this.#recent,
      });
      return;
    }
    this.ctx.provenance(
      {
        title: commitment,
        lead: `这是他和${relation.peer}之间的承诺。`,
        facts: [
          { term: "关系", value: `和${relation.peer}` },
          { term: "信任", value: String(percent(relation.trust)) },
        ],
        list: { label: `他眼里的${relation.peer}`, items: relation.their_model },
        recent: this.#recent,
      },
      this.#anchor(`${relation.id}:${picked.index}`),
    );
  }
}
