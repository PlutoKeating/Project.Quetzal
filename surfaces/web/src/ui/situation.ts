// 状态版面：守护进程联系不上、接口未就绪、读取失败、某一页还是空的。
// 每一种都说清现状和下一步：一个状态词、一句标题、一段说明，再加步骤、命令或一个动作。
import { DaemonUnreachable, SeaError } from "../api/client.js";
import { h, type Child } from "./dom.js";
import { ordinal } from "./format.js";
import { stateWord, type Tone } from "./marks.js";

export interface SituationStep {
  title: string;
  text: string;
}

export interface SituationSpec {
  /** 机器可读的状态名，写进 `data-situation`。 */
  kind: string;
  tone: Tone;
  word: string;
  title: string;
  body: string;
  steps?: readonly SituationStep[];
  command?: { label: string; text: string };
  facts?: ReadonlyArray<{ term: string; value: string }>;
  action?: { label: string; run: () => void };
  link?: { label: string; href: string };
  /** 页面的一部分为空、其余部分不空时用紧凑版。 */
  compact?: boolean;
  headingLevel?: 2 | 3;
}

const COPIED_MS = 1800;

/** 一条可复制的终端命令。 */
export function commandBlock(label: string, text: string): HTMLElement {
  const button = h("button", { type: "button", class: "qz-btn-copy" }, "复制");
  button.addEventListener("click", () => {
    const clipboard = globalThis.navigator?.clipboard;
    if (!clipboard) return;
    void clipboard.writeText(text).then(
      () => {
        button.classList.add("is-copied");
        button.textContent = "已复制";
        setTimeout(() => {
          button.classList.remove("is-copied");
          button.textContent = "复制";
        }, COPIED_MS);
      },
      () => undefined,
    );
  });
  return h(
    "div",
    { class: "qz-cmd" },
    h("p", { class: "qz-cmd-label" }, label),
    h(
      "div",
      { class: "qz-cmd-frame" },
      h(
        "div",
        { class: "qz-cmd-body" },
        h("code", { class: "qz-cmd-text is-mono", dir: "ltr" }, text),
        button,
      ),
    ),
  );
}

export function situation(spec: SituationSpec): HTMLElement {
  const heading = spec.headingLevel === 3 ? "h3" : "h2";
  const children: Child[] = [
    stateWord(spec.tone, spec.word),
    h(heading, { class: "qz-situation-title" }, spec.title),
    h("p", { class: "qz-situation-body" }, spec.body),
  ];
  if (spec.steps && spec.steps.length > 0) {
    children.push(
      h(
        "div",
        { class: "qz-rail is-grid is-3", "data-role": "situation-steps" },
        ...spec.steps.map((step, index) =>
          h(
            "div",
            { class: "qz-cell" },
            h("span", { class: "qz-cell-num" }, ordinal(index)),
            h("p", { class: "qz-cell-title" }, step.title),
            h("p", null, step.text),
          ),
        ),
      ),
    );
  }
  if (spec.facts && spec.facts.length > 0) {
    children.push(
      h(
        "dl",
        { class: "qz-deflist" },
        ...spec.facts.flatMap((fact) => [
          h("dt", null, fact.term),
          h("dd", { class: "is-mono" }, fact.value),
        ]),
      ),
    );
  }
  if (spec.command) children.push(commandBlock(spec.command.label, spec.command.text));
  if (spec.action || spec.link) {
    const { action, link } = spec;
    children.push(
      h(
        "div",
        { class: "qz-actions" },
        action
          ? h(
              "button",
              {
                type: "button",
                class: "qz-btn-outline",
                "data-role": "situation-action",
                "data-focus-key": `situation:${spec.kind}`,
                onclick: () => action.run(),
              },
              action.label,
            )
          : null,
        link ? h("a", { class: "qz-btn-outline", href: link.href }, link.label) : null,
      ),
    );
  }
  return h(
    "section",
    {
      class: spec.compact ? "qz-situation is-compact" : "qz-situation",
      "data-situation": spec.kind,
    },
    ...children,
  );
}

/** 这一页从来没有读出来过，而守护进程联系不上。 */
export function unreachableSituation(retry: () => void): HTMLElement {
  return situation({
    kind: "unreachable",
    tone: "amber",
    word: "联系不上",
    title: "联系不上本机的守护进程",
    body: "治理面的每一页都从它读取。它没有在运行，或者刚刚被重启。启动之后这一页会自己读出来。",
    command: { label: "在终端启动它：", text: "qz up" },
    action: { label: "重试", run: retry },
  });
}

/** 握手成功，但守护进程不认识这一页要用的读取方法。 */
export function notReadySituation(error: SeaError, retry: () => void): HTMLElement {
  return situation({
    kind: "not-ready",
    tone: "amber",
    word: "接口未就绪",
    title: "这个守护进程还不提供这一页的内容",
    body: "页面已经连上它，本机握手也通过了，但它不认识这一页要用的读取方法。通常是守护进程的版本比治理面旧。",
    steps: [
      { title: "升级", text: "把 Quetzalcoatl 升级到最新版本。" },
      { title: "重启守护进程", text: "在终端先运行 qz down，再运行 qz up。" },
      { title: "回到这里", text: "点「重试」，这一页会重新读取。" },
    ],
    facts: [
      { term: "方法", value: error.method },
      { term: "答复", value: error.detail ? `${error.code} · ${error.detail}` : error.code },
    ],
    action: { label: "重试", run: retry },
  });
}

/** 守护进程答复了一个错误，或答复读不懂。 */
export function failedSituation(error: unknown, retry: () => void): HTMLElement {
  const facts =
    error instanceof SeaError
      ? [
          { term: "方法", value: error.method },
          { term: "代码", value: error.code },
        ]
      : [];
  return situation({
    kind: "failed",
    tone: "amber",
    word: "读取失败",
    title: "这一页没有读出来",
    body: describeError(error),
    facts,
    action: { label: "重试", run: retry },
  });
}

/** 把一次失败写成一句给人看的话。 */
export function describeError(error: unknown): string {
  if (error instanceof DaemonUnreachable) return "联系不上本机的守护进程。";
  if (error instanceof SeaError) {
    if (error.code === "MALFORMED_RESPONSE") return `守护进程的答复读不懂：${error.detail}。`;
    return error.detail !== "" ? error.detail : `守护进程拒绝了这次请求（${error.code}）。`;
  }
  return error instanceof Error ? error.message : String(error);
}
