// 设备：这台设备在最上；其余设备按最近在线排序；吊销是一个需要再次确认的动作。
import type { Device, DevicesView as DevicesPayload } from "../api/types.js";
import { viewInfo } from "../shell/routes.js";
import { byData, cls, h, redraw, type Child } from "../ui/dom.js";
import { formatAgo, formatDate, formatDateTime } from "../ui/format.js";
import { stateWord } from "../ui/marks.js";
import { commandBlock, situation } from "../ui/situation.js";
import { BaseView, type ViewContext } from "./base.js";

function hubHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export class DevicesView extends BaseView<DevicesPayload> {
  #selectedId: string | null = null;
  #recent: string | null = null;

  constructor(ctx: ViewContext) {
    super(ctx, viewInfo("devices"));
  }

  protected fetch(): Promise<DevicesPayload> {
    return this.ctx.api.devices();
  }

  /** 其余设备：不含这一台，最近在线的在前，从没在线过的在最后。 */
  #others(data: DevicesPayload): Device[] {
    return data.devices
      .filter((device) => device.id !== data.this_device.id)
      .sort((a, b) => (b.last_seen_ms ?? -Infinity) - (a.last_seen_ms ?? -Infinity));
  }

  protected render(): void {
    const data = this.data;
    if (!data) return;
    const now = this.ctx.now();
    const others = this.#others(data);
    const hub = data.hub;
    this.setState(
      hub.url === null
        ? stateWord("neutral", "仅本机")
        : hub.connected
          ? stateWord("ice", "已同步")
          : stateWord("amber", "同步不通"),
    );

    const thisCurrent = this.#selectedId === data.this_device.id;
    const content: Child[] =
      others.length === 0
        ? [
            situation({
              kind: "devices-only-this",
              tone: "neutral",
              word: "只有这一台",
              title: "他只在这台设备上",
              body: "再加一台设备，他会跟着你走：两边是同一个他，不需要重新介绍。配对时两台设备都要在你手上。",
              compact: true,
              headingLevel: 3,
            }),
            commandBlock("在这台设备的终端开始配对：", "qz pair start"),
          ]
        : [
            h(
              "ul",
              {
                class: "qz-list",
                "data-roving": true,
                "data-role": "other-devices",
                "aria-labelledby": "sea-devices-others",
              },
              ...others.map((device) => this.#row(device, now)),
            ),
          ];

    redraw(this.body, [
      h(
        "div",
        { class: "qz-rail is-grid is-2", "data-role": "this-device" },
        h(
          "section",
          {
            class: cls("qz-cell is-pickable", thisCurrent && "is-current"),
            "data-entry": data.this_device.id,
            "aria-labelledby": "sea-devices-this",
          },
          h(
            "div",
            { class: "qz-cell-head" },
            h("h2", { class: "qz-cell-title", id: "sea-devices-this" }, "这台设备"),
            stateWord("neutral", "正在用"),
          ),
          h(
            "p",
            null,
            h(
              "button",
              {
                type: "button",
                class: "qz-pick",
                "aria-current": thisCurrent ? "true" : null,
                "data-focus-key": `device:${data.this_device.id}`,
                onclick: () => this.#select(data.this_device.id),
              },
              data.this_device.name,
            ),
          ),
          h("p", { class: "qz-cell-note" }, `${formatDate(data.this_device.added_ms)} 加入`),
        ),
        h(
          "section",
          { class: "qz-cell", "data-cell": "hub", "aria-labelledby": "sea-devices-hub" },
          h(
            "div",
            { class: "qz-cell-head" },
            h("h2", { class: "qz-cell-title", id: "sea-devices-hub" }, "同步"),
            hub.url === null
              ? stateWord("neutral", "没有接")
              : hub.connected
                ? stateWord("ice", "连着")
                : stateWord("amber", "连不上"),
          ),
          hub.url === null
            ? h("p", null, "没有接同步，他只在这台设备上。设备丢了，他也就丢了。")
            : hub.connected
              ? h("p", null, "各台设备经它互相找到对方。它只转发密文，读不到内容。")
              : h("p", null, "连不上同步服务。这台设备上的改动会先留在本机，连上之后再对账。"),
          hub.url === null ? null : h("p", { class: "qz-cell-note", dir: "ltr" }, hubHost(hub.url)),
        ),
      ),
      h(
        "section",
        { class: "qz-view-section", "data-qz-lit": true, "aria-labelledby": "sea-devices-others", "data-section": "others" },
        h(
          "div",
          { class: "qz-view-section-head" },
          h("h2", { class: "qz-view-section-title", id: "sea-devices-others" }, "其余设备"),
          h(
            "p",
            { class: "qz-view-section-note" },
            others.length === 0 ? "没有" : `${others.length} 台 · 最近在线的在前`,
          ),
        ),
        ...content,
      ),
    ]);
    this.#updateProvenance();
  }

  #row(device: Device, now: number): HTMLElement {
    const current = device.id === this.#selectedId;
    return h(
      "li",
      { class: cls("qz-row has-action", current && "is-current"), "data-entry": device.id },
      h(
        "div",
        null,
        h(
          "button",
          {
            type: "button",
            class: "qz-pick",
            "aria-current": current ? "true" : null,
            "data-focus-key": `device:${device.id}`,
            onclick: () => this.#select(device.id),
          },
          h("span", { class: "qz-row-text" }, device.name),
        ),
        h(
          "div",
          { class: "qz-row-meta" },
          h(
            "span",
            { class: "qz-meta" },
            device.last_seen_ms === null ? "从没在线过" : `最近在线 ${formatAgo(device.last_seen_ms, now)}`,
          ),
          h("span", { class: "qz-meta" }, `${formatDate(device.added_ms)} 加入`),
          device.holds_control ? stateWord("neutral", "可以管理别的设备") : null,
        ),
      ),
      this.ctx.guard(
        h(
          "button",
          {
            type: "button",
            class: "qz-btn-outline is-compact qz-row-action",
            "data-action": "revoke",
            "data-focus-key": `revoke:${device.id}`,
            "aria-label": `吊销「${device.name}」`,
            onclick: () => this.#revoke(device),
          },
          "吊销",
        ),
      ),
    );
  }

  #select(id: string): void {
    this.#recent = null;
    this.#selectedId = this.#selectedId === id ? null : id;
    this.render();
  }

  #revoke(device: Device): void {
    void this.ctx
      .confirm({
        title: `吊销「${device.name}」？`,
        word: "不可撤回",
        paragraphs: [
          "这台设备会立刻失去读取和同步他的资格，已经同步过去的内容在它下次联网时作废。",
          "吊销之后不能撤回。要再用它，得重新配对。",
        ],
        confirmLabel: "吊销",
        passphrase: { label: "口令", hint: "第一次签署底线时设定的那个口令。" },
        action: async ({ passphrase }) => {
          this.data = await this.ctx.api.deviceRevoke(device.id, passphrase);
        },
      })
      .then((done) => {
        if (!done) return;
        if (this.#selectedId === device.id) this.#selectedId = null;
        this.#recent = "刚刚由你吊销";
        this.ctx.say(`已吊销「${device.name}」。`);
        this.ctx.overviewChanged();
        this.render();
        (
          byData(this.body, "role", "other-devices")?.querySelector<HTMLElement>(".qz-pick") ??
          byData(this.body, "focus-key", `device:${this.data?.this_device.id ?? ""}`)
        )?.focus();
      });
  }

  #updateProvenance(): void {
    const data = this.data;
    if (!data) return;
    const now = this.ctx.now();
    const id = this.#selectedId;
    if (id === data.this_device.id) {
      this.ctx.provenance(
        {
          title: data.this_device.name,
          lead: "你正在用的这一台。它不能在这里吊销自己；要让它退出，在另一台设备上吊销它。",
          facts: [
            { term: "加入", value: formatDateTime(data.this_device.added_ms) },
            { term: "标识", value: data.this_device.id, mono: true },
          ],
          recent: this.#recent,
        },
        byData(this.body, "entry", id),
      );
      return;
    }
    const device = id === null ? undefined : data.devices.find((item) => item.id === id);
    if (!device) {
      this.#selectedId = null;
      this.defaultProvenance({
        facts: [
          { term: "设备", value: `${this.#others(data).length + 1} 台` },
          { term: "同步", value: data.hub.url === null ? "没有接" : data.hub.connected ? "连着" : "连不上" },
        ],
        recent: this.#recent,
      });
      return;
    }
    this.ctx.provenance(
      {
        title: device.name,
        lead: device.holds_control
          ? "这台设备可以管理别的设备：批准配对，也可以吊销。"
          : "这台设备可以读取和同步他，但不能管理别的设备。",
        facts: [
          { term: "加入", value: formatDateTime(device.added_ms) },
          {
            term: "在线",
            value:
              device.last_seen_ms === null
                ? "从没在线过"
                : `${formatDateTime(device.last_seen_ms)}（${formatAgo(device.last_seen_ms, now)}）`,
          },
          { term: "标识", value: device.id, mono: true },
        ],
        recent: this.#recent,
      },
      byData(this.body, "entry", device.id),
    );
  }
}
