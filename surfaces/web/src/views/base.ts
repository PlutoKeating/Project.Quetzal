// 视图的共同骨架：页首（名字、一句话、这一页的状态词）加正文。
// 读取的四种结局在这里统一处理：读出来、联系不上、接口未就绪、读取失败。
import { DaemonUnreachable, SeaError, type SeaApi } from "../api/client.js";
import type { SeaOverview } from "../api/types.js";
import type { Provenance } from "../shell/provenance.js";
import type { ViewInfo } from "../shell/routes.js";
import type { ConfirmRequest } from "../ui/dialog.js";
import { h } from "../ui/dom.js";
import { failedSituation, notReadySituation, unreachableSituation } from "../ui/situation.js";

/** 可以被「写动作不可用」统一停用的控件。 */
export type WriteControl = HTMLButtonElement | HTMLInputElement | HTMLTextAreaElement;

export interface ViewContext {
  readonly api: SeaApi;
  now(): number;
  /** 当前是否窄屏（≤ 900px）。 */
  narrow(): boolean;
  /** 守护进程在线，写动作可用。 */
  writable(): boolean;
  /**
   * 登记一个写控件：守护进程联系不上时它会被停用。
   * @param blocked 视图自己的停用理由（例如还有没填完的内容）。
   */
  guard<T extends WriteControl>(control: T, blocked?: boolean): T;
  /** 更新出处栏。`anchor` 是选中条目所在的元素。 */
  provenance(content: Provenance, anchor?: HTMLElement | null): void;
  /** 读屏播报：成功。 */
  say(message: string): void;
  /** 读屏播报：失败。 */
  alert(message: string): void;
  confirm(request: ConfirmRequest): Promise<boolean>;
  /** 读总览并刷新导航上的信号点。 */
  loadOverview(): Promise<SeaOverview>;
  /** 一次写入之后：导航上的信号点可能变了。 */
  overviewChanged(): void;
  /** 正文重绘之后，让新的区块重新接住光。 */
  relight(): void;
}

export interface View {
  readonly info: ViewInfo;
  readonly element: HTMLElement;
  /** 进入这一页，或重新连上守护进程之后：读取并呈现。 */
  show(param: string | null): Promise<void>;
  /** 把焦点交给这一页的标题。 */
  focusHeading(): void;
}

export abstract class BaseView<T> implements View {
  readonly info: ViewInfo;
  readonly element: HTMLElement;
  protected readonly ctx: ViewContext;
  protected readonly head: HTMLElement;
  protected readonly body: HTMLElement;
  protected data: T | null = null;
  protected param: string | null = null;
  readonly #stateSlot: HTMLElement;
  #generation = 0;

  constructor(ctx: ViewContext, info: ViewInfo) {
    this.ctx = ctx;
    this.info = info;
    this.#stateSlot = h("div", { "data-role": "view-state" });
    this.head = h(
      "header",
      { class: "qz-view-head" },
      h(
        "div",
        null,
        h("h1", { class: "qz-title", tabindex: "-1", "data-role": "view-title" }, info.label),
        h("p", { class: "qz-view-lead" }, info.lead),
      ),
      this.#stateSlot,
    );
    this.body = h("div", { "data-role": "view-body" });
    this.element = h("div", { class: "qz-view", "data-view": info.key }, this.head, this.body);
  }

  async show(param: string | null): Promise<void> {
    this.param = param;
    this.#generation += 1;
    const generation = this.#generation;
    if (this.data === null) this.#renderWaiting();
    this.element.setAttribute("aria-busy", "true");
    try {
      const data = await this.fetch();
      if (generation !== this.#generation) return;
      this.data = data;
      this.element.removeAttribute("aria-busy");
      this.element.dataset["state"] = "ready";
      this.render();
    } catch (error) {
      if (generation !== this.#generation) return;
      this.element.removeAttribute("aria-busy");
      this.#renderFailure(error);
    }
    this.ctx.relight();
  }

  focusHeading(): void {
    this.element.querySelector<HTMLElement>("h1")?.focus();
  }

  /**
   * 通用页首在不在。总览读出来之后，标题就是他的名字，通用页首整个拿掉：
   * 一页始终只有一个一级标题。
   */
  protected showHead(visible: boolean): void {
    if (!visible) this.head.remove();
    else if (this.head.parentElement !== this.element) this.element.prepend(this.head);
  }

  protected abstract fetch(): Promise<T>;

  /** 用 `this.data` 画出正文，并更新出处栏。 */
  protected abstract render(): void;

  /** 这一页的状态词（例如底线页的「待签署」）。 */
  protected setState(node: Node | null): void {
    this.#stateSlot.replaceChildren(...(node ? [node] : []));
  }

  /** 没有选中任何条目时的出处：这一页的一句话说明。 */
  protected defaultProvenance(extra: Omit<Provenance, "lead" | "title"> = {}): void {
    this.ctx.provenance({ lead: this.info.sentence, ...extra });
  }

  protected reload(): void {
    void this.show(this.param);
  }

  #renderWaiting(): void {
    this.showHead(true);
    this.element.dataset["state"] = "waiting";
    this.body.replaceChildren(h("p", { class: "qz-meta", role: "status" }, "正在读取"));
    this.defaultProvenance();
  }

  #renderFailure(error: unknown): void {
    if (error instanceof DaemonUnreachable && this.data !== null) {
      // 联系不上时整页保留上一次的内容；骨架负责状态词，并停用写动作。
      return;
    }
    this.data = null;
    this.showHead(true);
    this.setState(null);
    const retry = (): void => this.reload();
    if (error instanceof DaemonUnreachable) {
      this.element.dataset["state"] = "unreachable";
      this.body.replaceChildren(unreachableSituation(retry));
    } else if (error instanceof SeaError && error.notReady) {
      this.element.dataset["state"] = "not-ready";
      this.body.replaceChildren(notReadySituation(error, retry));
    } else {
      this.element.dataset["state"] = "failed";
      this.body.replaceChildren(failedSituation(error, retry));
    }
    this.defaultProvenance();
  }
}
