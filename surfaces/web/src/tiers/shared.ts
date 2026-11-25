import { h } from "../render/dom.js";
import type { ProjectedRow } from "../model/state.js";
import type { TierContext } from "./types.js";

export function tierShell(
  density: TierContext["density"],
  title: string,
  lead: string,
  children: readonly (Node | null)[],
): HTMLElement {
  const section = h(
    "section",
    { class: `tier tier-${density}`, "data-tier": density, "aria-labelledby": "qz-tier-title" },
    h("h1", { id: "qz-tier-title", tabindex: "-1" }, title),
    h("p", { class: "tier-lead" }, lead),
  );
  for (const child of children) {
    if (child) section.append(child);
  }
  return section;
}

export function statusLine(ctx: TierContext): HTMLElement {
  const status = ctx.rows.find((row) => row.kind === "status");
  const text = ctx.starting
    ? "正在连接本机守护进程…"
    : ctx.online
      ? status?.summary ?? "已连接本机守护进程"
      : "离线 · 先启动本机守护进程";
  return h(
    "p",
    {
      class: ctx.online ? "status-line" : "status-line status-line--offline",
      "data-role": "status",
      role: "status",
    },
    text,
  );
}

export function offlinePanel(ctx: TierContext): HTMLElement | null {
  // 认证未决期间绝不闪现离线面板。
  if (ctx.online || ctx.starting) return null;
  return h(
    "div",
    {
      class: "card card--warning daemon-panel",
      "data-role": "daemon-panel",
      "data-daemon-state": "unavailable",
    },
    h("h2", null, "本机守护进程未运行"),
    h(
      "p",
      null,
      "你的数据仍在这台设备上，只是现在无法读写。启动 quetzalcoatld 后点“重试连接”。",
    ),
    ctx.offlineDetail ? h("p", { class: "muted" }, ctx.offlineDetail) : null,
    h(
      "button",
      {
        class: "btn",
        type: "button",
        "data-action": "retry-connection",
        "data-focus-key": "retry-connection",
        onClick: () => ctx.actions.retryConnection(),
      },
      "重试连接",
    ),
  );
}

export function messageList(ctx: TierContext): HTMLElement {
  const items = ctx.transcript.map((item) =>
    h(
      "li",
      {
        class: `message message--${item.role}`,
        "data-role": "message",
        "data-message-id": item.id,
        "data-message-role": item.role,
      },
      h("span", { class: "message-role" }, item.role === "user" ? "你" : "羽蛇神"),
      h("span", { class: "message-text" }, item.text),
    ),
  );
  return h(
    "ol",
    { class: "messages", "data-role": "messages", "aria-label": "对话记录" },
    ...items,
  );
}

export function toolCards(ctx: TierContext): HTMLElement {
  const cards = ctx.cards.map((card) => {
    const attrs: Record<string, string> = { class: `card tool-card tool-card--${card.kind}` };
    if (card.kind === "approval") attrs["data-approval-id"] = card.id;
    else if (card.kind === "error") attrs["data-error-id"] = card.id;
    else attrs["data-tool-id"] = card.id;
    const children: (Node | null)[] = [
      h("h3", null, card.title),
      card.detail ? h("p", { class: "muted" }, card.detail) : null,
    ];
    if (card.kind === "approval") {
      children.push(
        h(
          "div",
          { class: "card-actions" },
          h(
            "button",
            {
              class: "btn",
              type: "button",
              "data-action": "approve",
              "data-focus-key": `approve:${card.id}`,
              onClick: () => ctx.actions.resolveApproval(card.id),
            },
            "允许",
          ),
          h(
            "button",
            {
              class: "btn btn--quiet",
              type: "button",
              "data-action": "deny",
              "data-focus-key": `deny:${card.id}`,
              onClick: () => ctx.actions.resolveApproval(card.id),
            },
            "暂不允许",
          ),
        ),
      );
    }
    if (card.kind === "error") {
      children.push(
        h(
          "button",
          {
            class: "btn",
            type: "button",
            "data-action": "retry-message",
            "data-focus-key": `retry-message:${card.id}`,
            onClick: () => ctx.actions.retryMessage(),
          },
          "重试",
        ),
      );
    }
    return h("article", attrs, ...children);
  });
  return h("div", { class: "tool-cards", "data-role": "tool-cards" }, ...cards);
}

export function rowCard(
  row: ProjectedRow,
  ctx: TierContext,
  options: { actions?: boolean } = {},
): HTMLElement {
  const selected = ctx.selection.has(row.key);
  const children: (Node | null)[] = [h("h3", null, row.summary)];
  if (row.detail) children.push(h("p", { class: "muted" }, row.detail));
  if (row.raw_json) {
    children.push(
      h("pre", { class: "raw-block", "data-role": "raw" }, row.raw_json),
    );
  }
  if (options.actions) {
    const groupSession = ctx.session.kind === "group";
    const commitAttrs: Record<string, string | boolean | EventListener> = {
      class: "btn",
      type: "button",
      "data-action": "commit-artifact",
      "data-focus-key": `commit:${row.key}`,
    };
    if (groupSession) {
      commitAttrs["onClick"] = () => ctx.actions.commitArtifact(row.key);
    } else {
      commitAttrs["disabled"] = true;
      commitAttrs["aria-describedby"] = "qz-commit-hint";
    }
    children.push(
      h(
        "div",
        { class: "card-actions" },
        h(
          "button",
          {
            class: "btn btn--quiet",
            type: "button",
            "data-action": "copy-reference",
            "data-focus-key": `copy:${row.key}`,
            onClick: () => ctx.actions.copyReference(row.key),
          },
          "复制引用",
        ),
        h(
          "button",
          {
            class: "btn",
            type: "button",
            "data-action": "select-artifact",
            "data-focus-key": `select:${row.key}`,
            "aria-pressed": selected ? "true" : "false",
            onClick: () => ctx.actions.toggleSelection(row.key),
          },
          selected ? "已标记待提交" : "标记待提交",
        ),
        h("button", commitAttrs, "提交"),
      ),
    );
  }
  return h(
    "article",
    {
      class: "card row-card",
      "data-row-key": row.key,
      "data-row-kind": row.kind,
    },
    ...children,
  );
}

export function selectionPanel(ctx: TierContext): HTMLElement | null {
  if (ctx.selection.size === 0) return null;
  const items = [...ctx.selection].sort().map((key) => h("li", null, key));
  return h(
    "section",
    { class: "card selection-panel", "data-role": "selection", "aria-label": "提交清单" },
    h("h2", null, "提交清单"),
    h("ul", null, ...items),
    h(
      "p",
      { class: "muted" },
      "清单只保存在本机内存；真正提交需要守护进程在线。",
    ),
  );
}
