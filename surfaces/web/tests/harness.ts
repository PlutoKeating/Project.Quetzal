// 在 jsdom 里把治理面挂起来：一个替身守护进程、一个固定的「现在」、可选的窄屏。
import { afterEach, vi } from "vitest";
import { GovernanceApp } from "../src/app.js";
import { FakeApi, NOW } from "./fake_api.js";

export interface Mounted {
  root: HTMLElement;
  api: FakeApi;
  app: GovernanceApp;
  main: HTMLElement;
  aside: HTMLElement;
  /** 换到另一页，等它读完。 */
  go(hash: string): Promise<void>;
  /** 正文里按 `data-*` 找元素。 */
  q<T extends HTMLElement = HTMLElement>(selector: string): T;
  all<T extends HTMLElement = HTMLElement>(selector: string): T[];
  /** 读屏通道里此刻的内容。 */
  said(): string;
  alerted(): string;
}

const mounted: Array<{ app: GovernanceApp; root: HTMLElement }> = [];

afterEach(() => {
  for (const { app, root } of mounted.splice(0)) {
    app.dispose();
    root.remove();
  }
  document.querySelectorAll("dialog").forEach((dialog) => dialog.remove());
  window.location.hash = "";
  document.title = "";
});

function required<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`找不到 ${selector}`);
  return element;
}

export async function settle(): Promise<void> {
  for (let round = 0; round < 4; round += 1) {
    await new Promise((done) => setTimeout(done, 0));
  }
}

export async function mount(
  options: { api?: FakeApi; hash?: string; narrow?: boolean; retryMs?: number } = {},
): Promise<Mounted> {
  const api = options.api ?? new FakeApi();
  window.location.hash = options.hash ?? "";
  // jsdom 的 hashchange 是异步派发的：等它过去再启动，免得启动之后又被它带着重读一遍。
  await settle();
  const root = document.createElement("div");
  root.id = "app";
  document.body.append(root);
  const app = new GovernanceApp(root, {
    api,
    now: () => NOW,
    narrow: () => options.narrow ?? false,
    retryMs: options.retryMs ?? 60_000,
  });
  mounted.push({ app, root });
  await app.start();
  await settle();
  const main = required<HTMLElement>(root, "main");
  const aside = required<HTMLElement>(root, '[data-role="provenance"]');
  return {
    root,
    api,
    app,
    main,
    aside,
    async go(hash: string): Promise<void> {
      window.location.hash = hash;
      const key = hash.replace(/^#\/?/u, "").split("/")[0] || "overview";
      await vi.waitFor(() => {
        if (root.dataset["view"] !== key) throw new Error(`还没有换到 ${key}`);
        if (main.querySelector("[aria-busy='true']")) throw new Error("还在读取");
      });
      await settle();
    },
    q: <T extends HTMLElement = HTMLElement>(selector: string) => required<T>(root, selector),
    all: <T extends HTMLElement = HTMLElement>(selector: string) =>
      Array.from(root.querySelectorAll<T>(selector)),
    said: () => required<HTMLElement>(root, '[data-live="polite"]').textContent ?? "",
    alerted: () => required<HTMLElement>(root, '[data-live="assertive"]').textContent ?? "",
  };
}

/** 键盘用户的一次激活：先聚焦，再触发。 */
export function press(control: HTMLElement): void {
  control.focus();
  control.click();
}

/** 往输入框里打字，并触发它监听的事件。 */
export function type(input: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

export function submit(form: HTMLFormElement): void {
  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
}
