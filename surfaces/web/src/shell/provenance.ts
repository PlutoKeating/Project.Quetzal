// 出处栏：当前选中条目的来历。没有选中时是这一页的一句话说明，永不留空。
// 窄屏下它不再是一栏，而是跟着选中的那一条出现在它正下方。
import { h, type Child } from "../ui/dom.js";
import { formatDateTime, isoTime } from "../ui/format.js";
import { stateWord, type Tone } from "../ui/marks.js";

export interface ProvenanceFact {
  term: string;
  value: string;
  mono?: boolean;
}

export interface ProvenanceEvent {
  at_ms: number | null;
  text: string;
  tone?: Tone;
}

export interface Provenance {
  /** 选中条目的原文或名字；没有选中时省略。 */
  title?: string;
  /** 一句话：必填，出处栏因此永不留空。 */
  lead: string;
  facts?: readonly ProvenanceFact[];
  events?: { label: string; items: readonly ProvenanceEvent[] };
  list?: { label: string; items: readonly string[] };
  link?: { label: string; href: string };
  /** 正在读取这一条更完整的来历。 */
  pending?: boolean;
  /** 写操作刚刚成功时追加的那一行，例如「刚刚由你修改」。 */
  recent?: string | null;
}

export class ProvenancePane {
  readonly element: HTMLElement;
  readonly #inner: HTMLElement;
  readonly #body: HTMLElement;
  readonly #narrow: () => boolean;
  readonly #home: () => void;
  #anchor: HTMLElement | null = null;

  /**
   * @param narrow 当前是否窄屏
   * @param home   把出处栏放回它在骨架里的位置
   */
  constructor(narrow: () => boolean, home: (element: HTMLElement) => void) {
    this.#narrow = narrow;
    this.#body = h("div", { "data-role": "provenance-body" });
    this.#inner = h(
      "div",
      { class: "qz-app-aside-inner" },
      h("h2", { class: "qz-sidenav-label", id: "sea-provenance-label" }, "出处"),
      this.#body,
    );
    this.element = h(
      "aside",
      { class: "qz-app-aside", "aria-labelledby": "sea-provenance-label", "data-role": "provenance" },
      this.#inner,
    );
    this.#home = () => home(this.element);
  }

  /**
   * @param anchor 选中的那一条所在的元素；窄屏下出处跟到它里面。
   */
  show(content: Provenance, anchor: HTMLElement | null = null): void {
    this.#anchor = anchor;
    this.#body.replaceChildren(...this.#render(content));
    this.element.dataset["selected"] = content.title === undefined ? "false" : "true";
    this.place();
  }

  /** 视口在宽窄之间切换，或选中的条目被重绘之后，重新摆放。 */
  place(): void {
    const anchor = this.#anchor;
    if (this.#narrow() && anchor !== null && anchor.isConnected) {
      if (this.element.parentElement !== anchor) anchor.append(this.element);
      this.element.classList.add("is-following");
      return;
    }
    this.element.classList.remove("is-following");
    this.#home();
  }

  #render(content: Provenance): Node[] {
    const nodes: Child[] = [];
    if (content.title !== undefined) {
      nodes.push(h("p", { class: "qz-aside-title", "data-role": "provenance-title" }, content.title));
    }
    nodes.push(h("p", { class: "qz-aside-lead", "data-role": "provenance-lead" }, content.lead));
    if (content.facts && content.facts.length > 0) {
      nodes.push(
        h(
          "dl",
          { class: "qz-deflist qz-aside-block", "data-role": "provenance-facts" },
          ...content.facts.flatMap((fact) => [
            h("dt", null, fact.term),
            h("dd", { class: fact.mono ? "is-mono" : null }, fact.value),
          ]),
        ),
      );
    }
    if (content.list && content.list.items.length > 0) {
      nodes.push(
        h(
          "div",
          { class: "qz-aside-block" },
          h("p", { class: "qz-sidenav-label" }, content.list.label),
          h(
            "ul",
            { class: "qz-signals" },
            ...content.list.items.map((item) => h("li", { class: "qz-signal" }, item)),
          ),
        ),
      );
    }
    if (content.events && content.events.items.length > 0) {
      nodes.push(
        h(
          "div",
          { class: "qz-aside-block", "data-role": "provenance-events" },
          h("p", { class: "qz-sidenav-label" }, content.events.label),
          h(
            "ol",
            { class: "qz-timeline is-compact" },
            ...content.events.items.map((event) =>
              h(
                "li",
                { class: event.tone === "amber" ? "qz-timeline-item is-amber" : "qz-timeline-item" },
                event.at_ms === null
                  ? null
                  : h(
                      "time",
                      { class: "qz-timeline-time", datetime: isoTime(event.at_ms) },
                      formatDateTime(event.at_ms),
                    ),
                h("p", { class: "qz-timeline-text" }, event.text),
              ),
            ),
          ),
        ),
      );
    }
    if (content.pending) {
      nodes.push(h("p", { class: "qz-meta qz-aside-block", role: "status" }, "正在读取它的来历"));
    }
    if (content.link) {
      nodes.push(
        h(
          "p",
          { class: "qz-aside-block" },
          h("a", { class: "qz-btn-outline is-compact", href: content.link.href }, content.link.label),
        ),
      );
    }
    if (content.recent) {
      const recent = stateWord("amber", content.recent);
      recent.dataset["role"] = "provenance-recent";
      nodes.push(h("p", { class: "qz-aside-block" }, recent));
    }
    return nodes.filter((node): node is Node => node instanceof Node);
  }
}
