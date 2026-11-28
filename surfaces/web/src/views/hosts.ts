// 宿主：每个宿主一行发丝线栅格，四格对应四项——送核心、送往事、收信号、压缩后不丢。
// 通的是冰蓝圆点加一句话，不通的是琥珀圆点加下一步怎么做。
import type { HostCheck, HostCheckKey, HostView, HostsView as HostsPayload } from "../api/types.js";
import { viewInfo } from "../shell/routes.js";
import { byData, cls, h, redraw, uniqueId, type Child } from "../ui/dom.js";
import { command, stateWord } from "../ui/marks.js";
import { commandBlock, situation } from "../ui/situation.js";
import { BaseView, type ViewContext } from "./base.js";

interface CheckInfo {
  key: HostCheckKey;
  label: string;
  /** 这一项查的是什么。 */
  meaning: string;
}

/** 四项的顺序固定：先送进去，再收回来，最后看压缩之后还在不在。 */
export const HOST_CHECKS: readonly CheckInfo[] = [
  { key: "core", label: "送核心", meaning: "每次模型调用之前，把他的核心和你的底线送进去。" },
  { key: "recall", label: "送往事", meaning: "把和眼前这件事相关的往事送进去。" },
  { key: "signal", label: "收信号", meaning: "调用之后，把这一轮的输出当作信号收回来。" },
  { key: "compaction", label: "压缩后不丢", meaning: "宿主压缩上下文之后，他的核心和往事仍然在。" },
];

interface Picked {
  host: string;
  key: HostCheckKey;
}

export class HostsView extends BaseView<HostsPayload> {
  #picked: Picked | null = null;

  constructor(ctx: ViewContext) {
    super(ctx, viewInfo("hosts"));
  }

  protected fetch(): Promise<HostsPayload> {
    return this.ctx.api.hosts();
  }

  protected render(): void {
    const data = this.data;
    if (!data) return;
    if (data.hosts.length === 0) {
      this.setState(stateWord("amber", "还没有接上"));
      this.#picked = null;
      redraw(this.body, [
        situation({
          kind: "hosts-empty",
          tone: "amber",
          word: "还没有接上",
          title: "他还没有住进任何宿主",
          body: "宿主是你已经在用的工具。对话和推理都发生在那里；他只是在每次模型调用之前被送进去，调用之后把信号收回来。",
          steps: [
            { title: "装一个宿主", text: "Claude Code、Codex、OpenCode 都可以。已经在用的那个最好。" },
            { title: "把他接进去", text: "在终端运行 qz connect。" },
            { title: "回来看四项", text: "每个宿主会在这里列出四项检查，逐项写明通不通。" },
          ],
          command: { label: "在终端把他接进本机的宿主：", text: "qz connect" },
        }),
      ]);
      this.defaultProvenance();
      return;
    }

    const failing = data.hosts.reduce(
      (count, host) =>
        count + (host.connected ? this.#checks(host).filter((check) => check.result?.ok === false).length : 0),
      0,
    );
    this.setState(
      failing === 0 ? stateWord("ice", "每一步都通") : stateWord("amber", `${failing} 步不通`),
    );
    redraw(this.body, [
      ...data.hosts.map((host) => this.#host(host)),
      h(
        "section",
        { class: "qz-view-section", "data-qz-lit": true, "aria-labelledby": "sea-hosts-doctor" },
        h(
          "div",
          { class: "qz-view-section-head" },
          h("h2", { class: "qz-view-section-title is-minor", id: "sea-hosts-doctor" }, "重新体检"),
          h("p", { class: "qz-view-section-note" }, "改过宿主的配置之后，在终端再查一遍。"),
        ),
        commandBlock("逐个宿主查这四项：", "qz doctor"),
      ),
    ]);
    this.#updateProvenance();
  }

  #checks(host: HostView): Array<{ info: CheckInfo; result: HostCheck | null }> {
    return HOST_CHECKS.map((info) => ({
      info,
      result: host.checks.find((check) => check.key === info.key) ?? null,
    }));
  }

  #host(host: HostView): HTMLElement {
    const headingId = uniqueId("host");
    const state = !host.installed
      ? stateWord("neutral", "未安装")
      : host.connected
        ? stateWord("ice", "已接上")
        : stateWord("amber", "未接上");
    return h(
      "section",
      {
        class: "qz-rail-group",
        "data-host": host.host,
        "data-installed": String(host.installed),
        "aria-labelledby": headingId,
      },
      h(
        "div",
        { class: "qz-rail-head" },
        h("h2", { class: "qz-rail-title", id: headingId }, host.name),
        state,
        host.version === null ? null : h("span", { class: "qz-meta", dir: "ltr" }, host.version),
      ),
      // 没接上时四项都不通、原因相同：只说一句该做什么，不铺四格一样的「不通」。
      host.connected
        ? h(
            "div",
            { class: "qz-rail is-grid", "data-role": "host-checks" },
            ...this.#checks(host).map(({ info, result }) => this.#check(host, info, result)),
          )
        : h(
            "p",
            { class: "qz-rail-group-note", "data-role": host.installed ? "host-not-connected" : "host-not-installed" },
            host.installed ? "装了，还没接上。在终端运行 " : "这台设备上没有装它。装上之后在终端运行 ",
            command("qz connect"),
            "，四项检查会列在这里。",
          ),
    );
  }

  #check(host: HostView, info: CheckInfo, result: HostCheck | null): HTMLElement {
    const current = this.#picked?.host === host.host && this.#picked.key === info.key;
    let state: Node;
    let sentence: Child;
    if (result === null) {
      state = stateWord("neutral", "没有检查");
      sentence = "守护进程没有报告这一项。";
    } else if (result.ok) {
      state = stateWord("ice", "通");
      sentence = result.detail;
    } else {
      state = stateWord("amber", "不通");
      sentence = result.detail;
    }
    return h(
      "div",
      {
        class: cls("qz-cell is-pickable", current && "is-current"),
        "data-entry": `${host.host}:${info.key}`,
        "data-check": info.key,
        "data-ok": result === null ? "unknown" : String(result.ok),
      },
      h(
        "div",
        { class: "qz-cell-head" },
        h(
          "h3",
          { class: "qz-cell-title" },
          h(
            "button",
            {
              type: "button",
              class: "qz-pick",
              "aria-current": current ? "true" : null,
              "data-focus-key": `check:${host.host}:${info.key}`,
              onclick: () => {
                this.#picked = current ? null : { host: host.host, key: info.key };
                this.render();
              },
            },
            info.label,
          ),
        ),
        state,
      ),
      h("p", null, sentence),
    );
  }

  #updateProvenance(): void {
    const data = this.data;
    const picked = this.#picked;
    const host = picked ? data?.hosts.find((item) => item.host === picked.host) : undefined;
    const info = picked ? HOST_CHECKS.find((item) => item.key === picked.key) : undefined;
    if (!picked || !host || !info) {
      this.#picked = null;
      this.defaultProvenance();
      return;
    }
    const result = host.checks.find((check) => check.key === info.key) ?? null;
    const outcome = result === null ? "没有检查" : result.ok ? "通" : "不通";
    this.ctx.provenance(
      {
        title: `${host.name} · ${info.label}`,
        lead: info.meaning,
        facts: [
          { term: "结果", value: outcome },
          { term: "宿主", value: host.name },
          { term: "版本", value: host.version ?? "未知", mono: true },
          { term: "接上", value: host.connected ? "是" : "否" },
        ],
        list:
          result === null
            ? undefined
            : { label: result.ok ? "守护进程报告" : "下一步", items: [result.detail] },
      },
      byData(this.body, "entry", `${host.host}:${info.key}`),
    );
  }
}
