// 信号的词汇表（docs/GOVERNANCE_SURFACE.md 2.4）：冰蓝 = 已生效、已验证、通；琥珀 = 需要你、是你说的、不通。
// 颜色从不单独承担含义：每一个信号都带着文字。
import { h } from "./dom.js";

export type Tone = "ice" | "amber" | "neutral";

function toneClass(tone: Tone): string {
  // 中性的状态词只陈述事实，不向人要什么：比两种信号色都安静。
  return tone === "neutral" ? " is-quiet" : ` is-${tone}`;
}

/** 状态词：一个圆点加一句话。 */
export function stateWord(tone: Tone, text: string): HTMLElement {
  return h(
    "span",
    { class: `qz-state${toneClass(tone)}`, "data-tone": tone },
    h("i", { "aria-hidden": "true" }),
    text,
  );
}

/** 6px 圆点；`neutral` 是空心环（没有发生、没有选中）。 */
export function dot(tone: Tone): HTMLElement {
  return tone === "neutral"
    ? h("span", { class: "qz-ring", "aria-hidden": "true" })
    : h("span", { class: `qz-dot is-${tone}`, "aria-hidden": "true" });
}

/** 「你说的」：这一条由本人亲手写过或改过。 */
export function ownerMark(): HTMLElement {
  const mark = stateWord("amber", "你说的");
  mark.dataset["mark"] = "owner";
  return mark;
}

/** 「不主动提」：他记得，但不会主动提起。 */
export function mutedMark(): HTMLElement {
  const mark = stateWord("neutral", "不主动提");
  mark.dataset["mark"] = "muted";
  return mark;
}

/** 句子里的一条命令：等宽、LTR。 */
export function command(text: string): HTMLElement {
  return h("code", { class: "qz-code-chip", dir: "ltr" }, text);
}
