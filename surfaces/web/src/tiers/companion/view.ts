import { h } from "../../render/dom.js";
import { messageList, offlinePanel, statusLine, tierShell, toolCards } from "../shared.js";
import type { TierContext } from "../types.js";

/** 陪伴态：零术语、大触控目标，只披露一句话摘要。 */
export function renderCompanion(ctx: TierContext): HTMLElement {
  const artifactSummaries = ctx.rows
    .filter((row) => row.kind === "artifact" || row.kind === "conscience")
    .slice(0, 3)
    .map((row) => h("li", null, row.summary));
  return tierShell("companion", "需要我做什么？", "写一句话就行，我来帮你安排。", [
    h(
      "div",
      { class: "card welcome-card", "data-role": "welcome" },
      h("h2", null, "我是羽蛇神"),
      h("p", null, "你说一件事，我把它记下来、排好顺序，再提醒你。"),
      h("p", { class: "muted" }, "所有内容只留在这台设备上，不会自动发到外面。"),
    ),
    statusLine(ctx),
    offlinePanel(ctx),
    artifactSummaries.length > 0
      ? h("ul", { class: "plain-list", "data-role": "highlights" }, ...artifactSummaries)
      : null,
    messageList(ctx),
    toolCards(ctx),
  ]);
}
