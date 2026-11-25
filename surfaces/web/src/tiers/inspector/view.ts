import { h } from "../../render/dom.js";
import { messageList, offlinePanel, rowCard, statusLine, tierShell, toolCards } from "../shared.js";
import type { TierContext } from "../types.js";

/** 检视态：主权工程视角，披露全部原始载荷与良知树。 */
export function renderInspector(ctx: TierContext): HTMLElement {
  const conscience = ctx.rows.filter((row) => row.kind === "conscience");
  const rest = ctx.rows.filter((row) => row.kind !== "conscience");
  return tierShell("inspector", "检视器", "逐字节核对本机状态：修订号、良知树与原始 JSON。", [
    statusLine(ctx),
    offlinePanel(ctx),
    h(
      "section",
      { class: "card", "aria-label": "原始快照" },
      h("h2", null, `原始快照 · rev ${ctx.rev}`),
      h("pre", { class: "raw-block raw-block--full", "data-role": "raw" }, ctx.rawSnapshot),
    ),
    conscience.length > 0
      ? h(
          "section",
          { class: "stack", "aria-label": "良知树" },
          h("h2", null, "良知树"),
          ...conscience.map((row) => rowCard(row, ctx)),
        )
      : null,
    rest.length > 0
      ? h(
          "section",
          { class: "stack", "aria-label": "全部状态行" },
          h("h2", null, "全部状态行"),
          ...rest.map((row) => rowCard(row, ctx)),
        )
      : null,
    messageList(ctx),
    toolCards(ctx),
  ]);
}
