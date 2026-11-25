import { h } from "../../render/dom.js";
import {
  messageList,
  offlinePanel,
  rowCard,
  selectionPanel,
  statusLine,
  tierShell,
  toolCards,
} from "../shared.js";
import type { TierContext } from "../types.js";

/** 工作台态：摘要 + 可操作细节，承载群组共享产物协同。 */
export function renderWorkbench(ctx: TierContext): HTMLElement {
  const artifacts = ctx.rows.filter((row) => row.kind === "artifact");
  const others = ctx.rows.filter((row) => row.kind !== "artifact");
  return tierShell("workbench", "工作台", "把共享产物、待办与提交清单放在同一页。", [
    statusLine(ctx),
    offlinePanel(ctx),
    selectionPanel(ctx),
    h(
      "p",
      { class: "muted session-line", "data-role": "session" },
      ctx.session.kind === "group"
        ? `当前为群组会话${ctx.session.roomId ? `（${ctx.session.roomId}）` : ""}：${ctx.session.detail}`
        : `当前为个人会话：${ctx.session.detail}`,
    ),
    artifacts.length > 0
      ? h(
          "section",
          { class: "stack", "aria-label": "共享产物" },
          h("h2", null, "共享产物"),
          ...artifacts.map((row) => rowCard(row, ctx, { actions: true })),
          h(
            "p",
            { class: "muted", id: "qz-commit-hint", "data-role": "commit-hint" },
            ctx.session.detail,
          ),
        )
      : null,
    others.length > 0
      ? h(
          "section",
          { class: "stack", "aria-label": "运行状态" },
          h("h2", null, "运行状态"),
          ...others.map((row) => rowCard(row, ctx)),
        )
      : null,
    messageList(ctx),
    toolCards(ctx),
  ]);
}
