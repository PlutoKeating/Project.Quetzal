// 总览：居中的名字与「相处第 N 天」，其下一条三格的发丝线栅格——宿主、等你的事、同步。
import type { OverviewHost, SeaOverview } from "../api/types.js";
import { hrefFor, OVERVIEW } from "../shell/routes.js";
import { arrowIcon, h, type Child } from "../ui/dom.js";
import { daysTogether, formatAgo, formatDate } from "../ui/format.js";
import { command, dot, stateWord } from "../ui/marks.js";
import { BaseView, type ViewContext } from "./base.js";

/** 有几件事在等：他的变化、要拍板的事，以及还没签的底线。 */
export function pendingCount(overview: SeaOverview): number {
  return (
    overview.pending.disclosures +
    overview.pending.approvals +
    (overview.baseline.signed ? 0 : 1)
  );
}

function hubHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export class OverviewView extends BaseView<SeaOverview> {
  constructor(ctx: ViewContext) {
    super(ctx, OVERVIEW);
  }

  protected fetch(): Promise<SeaOverview> {
    return this.ctx.loadOverview();
  }

  protected render(): void {
    const overview = this.data;
    if (!overview) return;
    const now = this.ctx.now();
    // 这一页的标题就是他的名字；通用页首只在读不出来时出现。
    this.showHead(false);

    const counts: Child[] = [
      h("span", null, `${overview.counts.core_values} 条核心`),
      h("span", { "aria-hidden": "true" }, "·"),
      h("span", null, `${overview.counts.about_user} 条关于你`),
      h("span", { "aria-hidden": "true" }, "·"),
      h("span", null, `${overview.counts.memories} 件往事`),
    ];

    this.body.replaceChildren(
      h(
        "section",
        { class: "qz-presence", "aria-labelledby": "sea-overview-name" },
        h(
          "h1",
          { class: "qz-display", id: "sea-overview-name", tabindex: "-1", "data-role": "agent-name" },
          overview.agent.name,
        ),
        h(
          "p",
          { class: "qz-lead", "data-role": "days-together" },
          `相处第 ${daysTogether(overview.agent.since_ms, now)} 天`,
        ),
        h("p", { class: "qz-meta-line" }, ...counts),
      ),
      h(
        "div",
        { class: "qz-rail is-grid is-3", "data-role": "overview-rail" },
        this.#hostsCell(overview.hosts, now),
        this.#pendingCell(overview),
        this.#syncCell(overview, now),
      ),
    );

    this.defaultProvenance({
      facts: [
        { term: "相处自", value: formatDate(overview.agent.since_ms) },
        {
          term: "底线",
          value:
            overview.baseline.signed && overview.baseline.signed_at_ms !== null
              ? `${overview.baseline.directive_count} 条，自 ${formatDate(overview.baseline.signed_at_ms)} 起生效`
              : "待签署",
        },
        { term: "不主动提", value: `${overview.counts.muted} 条` },
      ],
    });
  }

  #cell(key: string, title: string, state: Node, ...children: Child[]): HTMLElement {
    return h(
      "section",
      { class: "qz-cell", "data-cell": key, "aria-labelledby": `sea-overview-${key}` },
      h(
        "div",
        { class: "qz-cell-head" },
        h("h2", { class: "qz-cell-title", id: `sea-overview-${key}` }, title),
        state,
      ),
      ...children,
    );
  }

  #hostsCell(hosts: readonly OverviewHost[], now: number): HTMLElement {
    const connected = hosts.filter((host) => host.connected).length;
    if (hosts.length === 0) {
      return this.#cell(
        "hosts",
        "宿主",
        stateWord("amber", "还没有"),
        h("p", null, "他还没有住进任何宿主。在终端运行 ", command("qz connect"), " 把他接进去。"),
        h("a", { class: "qz-link-arrow", href: hrefFor("hosts") }, "看怎么接", arrowIcon()),
      );
    }
    return this.#cell(
      "hosts",
      "宿主",
      connected > 0
        ? stateWord("ice", `${connected} 个通着`)
        : stateWord("amber", "都没接上"),
      h(
        "ul",
        { class: "qz-signals" },
        ...hosts.map((host) =>
          h(
            "li",
            { class: "qz-signal", "data-host": host.host },
            dot(host.connected ? "ice" : "amber"),
            h("span", null, host.name),
            h(
              "span",
              { class: "qz-meta" },
              host.connected
                ? "通"
                : host.last_seen_ms === null
                  ? "未接上"
                  : `未接上 · ${formatAgo(host.last_seen_ms, now)}见过`,
            ),
          ),
        ),
      ),
      h("a", { class: "qz-link-arrow", href: hrefFor("hosts") }, "看每一步通不通", arrowIcon()),
    );
  }

  #pendingCell(overview: SeaOverview): HTMLElement {
    const total = pendingCount(overview);
    if (total === 0) {
      return this.#cell(
        "pending",
        "等你的事",
        stateWord("neutral", "0 件"),
        h("p", { "data-role": "nothing-pending" }, "没有事在等你。"),
        h("p", { class: "qz-cell-note" }, "他变了、底线要签、有事要你拍板时，会出现在这里。"),
      );
    }
    const items: Child[] = [];
    if (overview.pending.disclosures > 0) {
      items.push(
        h(
          "li",
          { class: "qz-signal" },
          dot("amber"),
          h("a", { href: hrefFor("self") }, `${overview.pending.disclosures} 处变化等你看`),
        ),
      );
    }
    if (!overview.baseline.signed) {
      items.push(
        h(
          "li",
          { class: "qz-signal" },
          dot("amber"),
          h("a", { href: hrefFor("baseline") }, "底线待签署"),
        ),
      );
    }
    if (overview.pending.approvals > 0) {
      items.push(
        h(
          "li",
          { class: "qz-signal" },
          dot("amber"),
          h("span", null, `${overview.pending.approvals} 件事等你拍板`),
          h("span", { class: "qz-meta" }, "在宿主里拍板"),
        ),
      );
    }
    return this.#cell(
      "pending",
      "等你的事",
      stateWord("amber", `${total} 件`),
      h("ul", { class: "qz-signals" }, ...items),
    );
  }

  #syncCell(overview: SeaOverview, now: number): HTMLElement {
    const { sync } = overview;
    const state =
      sync.state === "synced"
        ? stateWord("ice", "已同步")
        : sync.state === "behind"
          ? stateWord("amber", "落后")
          : stateWord("neutral", "仅本机");
    const lines: Child[] = [
      h("li", { class: "qz-signal" }, h("span", null, `${sync.devices} 台设备上有他`)),
    ];
    if (sync.state === "local-only") {
      lines.push(
        h("li", { class: "qz-signal" }, h("span", null, "没有接同步，他只在这台设备上。")),
      );
    } else {
      lines.push(
        h(
          "li",
          { class: "qz-signal" },
          h("span", null, "上次同步"),
          h(
            "span",
            { class: "qz-meta" },
            sync.last_synced_ms === null ? "还没有过" : formatAgo(sync.last_synced_ms, now),
          ),
        ),
      );
      if (sync.hub_url !== null) {
        lines.push(
          h(
            "li",
            { class: "qz-signal" },
            h("span", null, "经由"),
            h("span", { class: "qz-meta", dir: "ltr" }, hubHost(sync.hub_url)),
          ),
        );
      }
    }
    return this.#cell(
      "sync",
      "同步",
      state,
      h("ul", { class: "qz-signals" }, ...lines),
      h("a", { class: "qz-link-arrow", href: hrefFor("devices") }, "看设备", arrowIcon()),
    );
  }
}
