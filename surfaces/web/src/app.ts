// 治理面的骨架：三栏，各有固定职责，从不互换。
//   左：导航——八页的入口，每个入口旁可以有一个信号点；上方是守护进程联系不上时的那一行。
//   中：正文——当前页。
//   右：出处——当前选中条目的来历；没有选中时是这一页的一句话说明。
// 这里只有「看」和「签」。没有任何地方可以输入一句话发给他。
import { DaemonUnreachable, type SeaApi } from "./api/client.js";
import type { SeaOverview } from "./api/types.js";
import { ProvenancePane, type Provenance } from "./shell/provenance.js";
import { hrefFor, OVERVIEW, PAGES, parseRoute, type Route, type ViewKey } from "./shell/routes.js";
import { Announcer } from "./ui/announcer.js";
import { confirmDialog, type ConfirmRequest } from "./ui/dialog.js";
import { h, onRovingKey, type Child } from "./ui/dom.js";
import { command, stateWord } from "./ui/marks.js";
import { describeError } from "./ui/situation.js";
import { AuditView } from "./views/audit.js";
import { BaselineView } from "./views/baseline.js";
import type { View, ViewContext, WriteControl } from "./views/base.js";
import { DevicesView } from "./views/devices.js";
import { HostsView } from "./views/hosts.js";
import { MemoriesView } from "./views/memories.js";
import { OverviewView } from "./views/overview.js";
import { SelfView } from "./views/self.js";
import { UsView } from "./views/us.js";
import { UserView } from "./views/user.js";

export type Connection = "connecting" | "online" | "unreachable";

export interface AppOptions {
  api: SeaApi;
  now?: () => number;
  /** 当前是否窄屏；默认读设计系统在骨架上声明的版面状态。 */
  narrow?: () => boolean;
  /** 联系不上时隔多久自动再试一次。 */
  retryMs?: number;
}

const DEFAULT_RETRY_MS = 4000;
const TITLE = "Quetzalcoatl";

interface NavSignal {
  /** 入口旁显示的数字；没有数字时只有一个点。 */
  count: number | null;
  /** 读屏读到的那句话。 */
  text: string;
}

/** 导航上的信号点：只表示「这一页有事在等你」，所以只有琥珀色。 */
export function navSignals(overview: SeaOverview | null): Partial<Record<ViewKey, NavSignal>> {
  if (!overview) return {};
  const signals: Partial<Record<ViewKey, NavSignal>> = {};
  if (overview.pending.disclosures > 0) {
    signals.self = {
      count: overview.pending.disclosures,
      text: `${overview.pending.disclosures} 处变化等你看`,
    };
  }
  if (!overview.baseline.signed) signals.baseline = { count: null, text: "待签署" };
  if (!overview.hosts.some((host) => host.connected)) {
    signals.hosts = { count: null, text: "没有接上任何宿主" };
  }
  if (overview.sync.state === "behind") signals.devices = { count: null, text: "同步落后" };
  return signals;
}

export class GovernanceApp {
  readonly #root: HTMLElement;
  readonly #api: SeaApi;
  readonly #now: () => number;
  readonly #narrow: () => boolean;
  readonly #retryMs: number;
  readonly #announcer = new Announcer();
  readonly #views = new Map<ViewKey, View>();
  readonly #provenance: ProvenancePane;
  readonly #status: HTMLElement;
  readonly #brand: HTMLAnchorElement;
  readonly #navList: HTMLElement;
  readonly #main: HTMLElement;
  readonly #ctx: ViewContext;

  #connection: Connection = "connecting";
  #overview: SeaOverview | null = null;
  #overviewInFlight: Promise<SeaOverview> | null = null;
  #route: Route = { info: OVERVIEW, param: null };
  #current: View | null = null;
  #retryTimer: ReturnType<typeof setTimeout> | null = null;
  #unlight: (() => void) | null = null;
  #disposed = false;
  readonly #onHashChange = (): void => void this.#navigate(true);
  readonly #onViewport = (): void => this.#provenance.place();

  constructor(root: HTMLElement, options: AppOptions) {
    this.#root = root;
    this.#now = options.now ?? (() => Date.now());
    this.#retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
    // 宽窄的分界只写在设计系统里：骨架在窄屏下把 --qz-app-layout 声明为 narrow，这里读它。
    this.#narrow =
      options.narrow ??
      (() => getComputedStyle(root).getPropertyValue("--qz-app-layout").trim() === "narrow");
    this.#api = this.#observe(options.api);

    this.#status = h("div", {
      class: "qz-app-status",
      role: "status",
      hidden: true,
      "data-role": "daemon-status",
    });
    this.#brand = h(
      "a",
      { class: "qz-brand", href: hrefFor("overview"), "data-nav": "overview" },
      h("span", { class: "qz-wordmark" }, TITLE),
      h("span", { class: "qz-sr-only" }, "总览"),
    );
    this.#navList = h("ul", { class: "qz-app-nav-list" });
    this.#main = h("main", { class: "qz-app-main", id: "sea-main", tabindex: "-1" });
    this.#provenance = new ProvenancePane(this.#narrow, (element) => {
      if (element.previousElementSibling !== this.#main) this.#main.after(element);
    });

    this.#ctx = {
      api: this.#api,
      now: this.#now,
      narrow: this.#narrow,
      writable: () => this.#connection === "online",
      guard: (control, blocked = false) => this.#guard(control, blocked),
      provenance: (content: Provenance, anchor: HTMLElement | null = null) =>
        this.#provenance.show(content, anchor),
      say: (message) => this.#announcer.say(message),
      alert: (message) => this.#announcer.alert(message),
      confirm: (request: ConfirmRequest) =>
        confirmDialog(
          {
            mount: this.#root,
            describe: describeError,
            alert: (message) => this.#announcer.alert(message),
          },
          request,
        ),
      loadOverview: () => this.#loadOverview(),
      overviewChanged: () => void this.#loadOverview().catch(() => undefined),
      relight: () => this.#relight(),
    };
  }

  async start(): Promise<void> {
    this.#root.replaceChildren(
      h("a", { class: "qz-skip-link", href: "#sea-main", "data-role": "skip-link" }, "跳到正文"),
      h(
        "header",
        { class: "qz-app-nav" },
        h(
          "div",
          { class: "qz-app-nav-inner" },
          this.#status,
          h(
            "div",
            { class: "qz-app-bar" },
            h("div", { class: "qz-app-brand" }, this.#brand),
            h("nav", { class: "qz-sidenav", "aria-label": "页面" }, this.#navList),
          ),
        ),
      ),
      this.#main,
      this.#provenance.element,
      this.#announcer.polite,
      this.#announcer.assertive,
    );
    this.#root.classList.add("qz-app");
    // 「跳到正文」只移动焦点，不改地址：地址里的 # 是页面路由。
    this.#root.querySelector<HTMLElement>('[data-role="skip-link"]')?.addEventListener("click", (event) => {
      event.preventDefault();
      this.#current?.focusHeading();
    });
    this.#main.addEventListener("keydown", onRovingKey);
    this.#renderNav();
    this.#renderStatus();
    globalThis.addEventListener("hashchange", this.#onHashChange);
    globalThis.addEventListener("resize", this.#onViewport);

    const overview = this.#loadOverview().catch(() => undefined);
    await this.#navigate(false);
    await overview;
    this.#root.removeAttribute("aria-busy");
    this.#root.dataset["boot"] = "ready";
  }

  dispose(): void {
    this.#disposed = true;
    globalThis.removeEventListener("hashchange", this.#onHashChange);
    globalThis.removeEventListener("resize", this.#onViewport);
    if (this.#retryTimer !== null) clearTimeout(this.#retryTimer);
    this.#unlight?.();
  }

  get connection(): Connection {
    return this.#connection;
  }

  /** 每一次调用的结局都告诉骨架：守护进程此刻联系得上吗。 */
  #observe(api: SeaApi): SeaApi {
    const track = <A extends unknown[], R>(call: (...args: A) => Promise<R>) => {
      return async (...args: A): Promise<R> => {
        try {
          const result = await call(...args);
          this.#setConnection("online");
          return result;
        } catch (error) {
          // 守护进程答复了一个错误，也说明它联系得上。
          this.#setConnection(error instanceof DaemonUnreachable ? "unreachable" : "online");
          throw error;
        }
      };
    };
    return {
      overview: track(() => api.overview()),
      self: track(() => api.self()),
      user: track(() => api.user()),
      us: track(() => api.us()),
      memories: track((query?: Parameters<SeaApi["memories"]>[0]) => api.memories(query)),
      memory: track((id: string) => api.memory(id)),
      baseline: track(() => api.baseline()),
      hosts: track(() => api.hosts()),
      devices: track(() => api.devices()),
      audit: track((query?: Parameters<SeaApi["audit"]>[0]) => api.audit(query)),
      entryUpdate: track((id: string, text: string) => api.entryUpdate(id, text)),
      entryMute: track((id: string, muted: boolean) => api.entryMute(id, muted)),
      entryErase: track((id: string) => api.entryErase(id)),
      baselineSign: track((directives: Parameters<SeaApi["baselineSign"]>[0], passphrase: string) =>
        api.baselineSign(directives, passphrase),
      ),
      focusSet: track((selfWeight: number) => api.focusSet(selfWeight)),
      rhythmSet: track((speakFirst: boolean, quietHours: readonly number[] | null) =>
        api.rhythmSet(speakFirst, quietHours),
      ),
      deviceRevoke: track((deviceId: string, passphrase: string) =>
        api.deviceRevoke(deviceId, passphrase),
      ),
    };
  }

  #setConnection(next: Connection): void {
    if (this.#disposed || next === this.#connection) return;
    const previous = this.#connection;
    this.#connection = next;
    this.#root.dataset["connection"] = next;
    this.#renderStatus();
    this.#applyWritable();
    if (next === "unreachable") {
      this.#announcer.alert("联系不上本机的守护进程。页面保留上一次的内容，写动作暂时不可用。");
      this.#scheduleRetry();
      return;
    }
    if (this.#retryTimer !== null) {
      clearTimeout(this.#retryTimer);
      this.#retryTimer = null;
    }
    if (previous === "unreachable") {
      this.#announcer.say("重新连上了守护进程。");
      // 重新连上：导航的信号点和眼前这一页都重读一遍。
      void this.#loadOverview().catch(() => undefined);
      void this.#current?.show(this.#route.param);
    }
  }

  #scheduleRetry(): void {
    if (this.#retryTimer !== null || this.#disposed) return;
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = null;
      this.#loadOverview().catch(() => {
        if (this.#connection === "unreachable") this.#scheduleRetry();
      });
    }, this.#retryMs);
  }

  #loadOverview(): Promise<SeaOverview> {
    this.#overviewInFlight ??= this.#api
      .overview()
      .then((overview) => {
        this.#overview = overview;
        this.#renderNav();
        return overview;
      })
      .finally(() => {
        this.#overviewInFlight = null;
      });
    return this.#overviewInFlight;
  }

  #guard<T extends WriteControl>(control: T, blocked: boolean): T {
    control.dataset["write"] = "true";
    control.dataset["blocked"] = String(blocked);
    control.disabled = blocked || this.#connection !== "online";
    return control;
  }

  #applyWritable(): void {
    const online = this.#connection === "online";
    for (const control of this.#root.querySelectorAll<WriteControl>("[data-write]")) {
      control.disabled = !online || control.dataset["blocked"] === "true";
    }
  }

  #renderStatus(): void {
    this.#root.dataset["connection"] = this.#connection;
    if (this.#connection !== "unreachable") {
      this.#status.hidden = true;
      this.#status.replaceChildren();
      return;
    }
    this.#status.hidden = false;
    this.#status.replaceChildren(
      stateWord("amber", "联系不上守护进程"),
      h("p", null, "下面是上一次的内容，写动作暂时不可用。在终端运行 ", command("qz up"), "。"),
      h(
        "button",
        {
          type: "button",
          class: "qz-btn-outline is-compact",
          "data-action": "reconnect",
          onclick: () => {
            void this.#loadOverview().catch(() => undefined);
            void this.#current?.show(this.#route.param);
          },
        },
        "重试",
      ),
    );
  }

  #renderNav(): void {
    const signals = navSignals(this.#overview);
    const currentKey = this.#route.info.key;
    if (currentKey === "overview") this.#brand.setAttribute("aria-current", "page");
    else this.#brand.removeAttribute("aria-current");
    this.#navList.replaceChildren(
      ...PAGES.map((page) => {
        const signal = signals[page.key];
        const children: Child[] = [h("span", null, page.label)];
        if (signal) {
          children.push(
            h(
              "span",
              { class: "qz-nav-signal", "data-role": "nav-signal" },
              h("span", { class: "qz-dot is-amber", "aria-hidden": "true" }),
              signal.count === null ? null : h("span", { "aria-hidden": "true" }, String(signal.count)),
              h("span", { class: "qz-sr-only" }, signal.text),
            ),
          );
        }
        return h(
          "li",
          null,
          h(
            "a",
            {
              href: hrefFor(page.key),
              "aria-current": page.key === currentKey ? "page" : null,
              "data-nav": page.key,
            },
            ...children,
          ),
        );
      }),
    );
  }

  #view(key: ViewKey): View {
    const existing = this.#views.get(key);
    if (existing) return existing;
    const ctx = this.#ctx;
    const created: View =
      key === "self"
        ? new SelfView(ctx)
        : key === "user"
          ? new UserView(ctx)
          : key === "us"
            ? new UsView(ctx)
            : key === "memories"
              ? new MemoriesView(ctx)
              : key === "baseline"
                ? new BaselineView(ctx)
                : key === "hosts"
                  ? new HostsView(ctx)
                  : key === "devices"
                    ? new DevicesView(ctx)
                    : key === "audit"
                      ? new AuditView(ctx)
                      : new OverviewView(ctx);
    this.#views.set(key, created);
    return created;
  }

  async #navigate(moveFocus: boolean): Promise<void> {
    const route = parseRoute(globalThis.location.hash);
    this.#route = route;
    const view = this.#view(route.info.key);
    this.#current = view;
    this.#root.dataset["view"] = route.info.key;
    document.title = route.info.key === "overview" ? TITLE : `${route.info.label} · ${TITLE}`;
    // 换页的一瞬间出处栏先回到这一页的一句话，不留空白，也不留上一页的条目。
    this.#provenance.show({ lead: route.info.sentence });
    this.#main.replaceChildren(view.element);
    this.#renderNav();
    if (moveFocus) {
      globalThis.scrollTo(0, 0);
      this.#navList.querySelector<HTMLElement>('[aria-current="page"]')?.scrollIntoView({
        block: "nearest",
        inline: "nearest",
      });
    }
    const shown = view.show(route.param);
    if (moveFocus) view.focusHeading();
    await shown;
    if (this.#current !== view) return;
    this.#applyWritable();
    // 标题可能在读取之后才出现（总览的标题是他的名字）。
    if (moveFocus && !view.element.contains(document.activeElement)) view.focusHeading();
  }

  #relight(): void {
    this.#unlight?.();
    this.#unlight = globalThis.QuetzalcoatlOptics?.init(this.#main) ?? null;
  }
}
