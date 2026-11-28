// 条目（偏好、事实、往事）共用的部分：来历怎么写，三个固定动作怎么做。
import type {
  MemoryDetail,
  MemoryHistoryAction,
  MemoryItem,
  MemorySourceKind,
} from "../api/types.js";
import type { Provenance, ProvenanceEvent, ProvenanceFact } from "../shell/provenance.js";
import { h, redraw, uniqueId, type Child } from "../ui/dom.js";
import { formatDate } from "../ui/format.js";
import { describeError } from "../ui/situation.js";
import type { ViewContext } from "./base.js";

const SOURCE_KIND: Record<MemorySourceKind, string> = {
  host: "宿主里的相处",
  import: "导入",
  sayit: "SayIt",
  explore: "他自己的探索",
  owner: "你亲手写下",
};

const HISTORY_ACTION: Record<MemoryHistoryAction, string> = {
  created: "记下",
  corrected: "纠正",
  muted: "设为不主动提",
  unmuted: "恢复主动提",
  expired: "过期",
};

const ACTOR: Record<string, string> = {
  owner: "你",
  arbiter: "仲裁",
  import: "导入",
  system: "系统",
};

export function actorLabel(actor: string): string {
  return ACTOR[actor] ?? actor;
}

export function sourceLabel(item: Pick<MemoryItem, "source">): string {
  return `${item.source.label} · ${SOURCE_KIND[item.source.kind]}`;
}

/** 「生效时间」的一句话。 */
export function validityText(item: Pick<MemoryItem, "since_ms" | "valid_until_ms">, now: number): string {
  const since = `自 ${formatDate(item.since_ms)} 起`;
  if (item.valid_until_ms === null) return `${since}，一直有效`;
  const until = formatDate(item.valid_until_ms);
  return item.valid_until_ms <= now ? `${since}，已在 ${until} 过期` : `${since}，到 ${until} 为止`;
}

export function isExpired(item: Pick<MemoryItem, "valid_until_ms">, now: number): boolean {
  return item.valid_until_ms !== null && item.valid_until_ms <= now;
}

/** 一条来历读取的四种状态。 */
export type DetailState = MemoryDetail | "loading" | "missing" | null;

export interface EntryProvenanceInput {
  text: string;
  since_ms: number;
  by_owner: boolean;
  /** 列表里已经带着的部分（事实、往事有；偏好没有）。 */
  item: MemoryItem | null;
  detail: DetailState;
  recent: string | null;
  now: number;
}

/** 一条偏好、事实或往事的出处：它从哪次相处来，有没有被纠正过。 */
export function entryProvenance(input: EntryProvenanceInput): Provenance {
  const detail = typeof input.detail === "object" ? input.detail : null;
  const known = detail ?? input.item;
  const facts: ProvenanceFact[] = [];
  if (known) {
    facts.push({ term: "来自", value: sourceLabel(known) });
    facts.push({ term: "生效", value: validityText(known, input.now) });
    facts.push({ term: "层", value: known.layer, mono: true });
    if (known.untrusted) facts.push({ term: "核实", value: "来自外部，没有经过核实" });
  } else {
    facts.push({ term: "记下", value: `自 ${formatDate(input.since_ms)} 起` });
  }
  if (detail) {
    const corrections = detail.history.filter((entry) => entry.action === "corrected").length;
    facts.push({
      term: "纠正",
      value: corrections === 0 ? "没有被纠正过" : `被纠正过 ${corrections} 次`,
    });
    if (detail.supersedes !== null) {
      facts.push({ term: "取代", value: detail.supersedes, mono: true });
    }
  }
  const events: ProvenanceEvent[] = detail
    ? detail.history.map((entry) => ({
        at_ms: entry.at_ms,
        text: `${HISTORY_ACTION[entry.action]} · ${actorLabel(entry.by)}`,
        tone: entry.by === "owner" ? ("amber" as const) : ("neutral" as const),
      }))
    : [];
  let lead: string;
  if (input.detail === "missing") {
    lead = "这一条更早的来历读不出来，下面是已经知道的部分。";
  } else if (input.by_owner) {
    lead = "这一条由你亲手写过或改过。";
  } else {
    lead = "这一条是他从相处里记下的，你没有改过它。";
  }
  return {
    title: input.text,
    lead,
    facts,
    events: { label: "经过", items: events },
    pending: input.detail === "loading",
    recent: input.recent,
  };
}

export interface EntryActionsOptions {
  ctx: ViewContext;
  id: string;
  text: string;
  muted: boolean;
  /** 改好之后：新的原文。 */
  onUpdated(text: string): void;
  onMuted(muted: boolean): void;
  onErased(): void;
}

/**
 * 条目上固定的三个动作：改、不主动提、抹除。
 * 「改」就地换成一个文本框；「抹除」要再确认一次。
 */
export function entryActions(options: EntryActionsOptions): HTMLElement {
  const { ctx, id } = options;
  const container = h("div", { "data-role": "entry-actions", "data-for": id });
  let editing = false;
  let busy = false;
  let failure: string | null = null;
  // 文本框里正在写的内容：重绘（保存中、保存失败）不会把它丢掉。
  let draft = options.text;

  const fail = (prefix: string, error: unknown): void => {
    failure = `${prefix}：${describeError(error)}`;
    ctx.alert(failure);
  };

  // 写操作在途时不停用按钮：停用会让键盘焦点掉到页面外面。只标记忙碌，并挡住重复触发。
  const run = async (prefix: string, work: () => Promise<void>): Promise<void> => {
    if (busy) return;
    busy = true;
    failure = null;
    container.setAttribute("aria-busy", "true");
    try {
      await work();
    } catch (error) {
      fail(prefix, error);
      draw();
    } finally {
      busy = false;
      container.removeAttribute("aria-busy");
    }
  };

  const failureNode = (): Child =>
    failure === null
      ? null
      : h("p", { class: "qz-field-hint is-amber", "data-role": "entry-error" }, failure);

  const drawButtons = (): Child[] => [
    h(
      "div",
      { class: "qz-actions" },
      ctx.guard(
        h(
          "button",
          {
            type: "button",
            class: "qz-btn-outline is-compact",
            "data-action": "edit",
            "data-focus-key": `edit:${id}`,
            onclick: () => {
              editing = true;
              failure = null;
              draft = options.text;
              draw();
              container.querySelector<HTMLTextAreaElement>("textarea")?.focus();
            },
          },
          "改",
        ),
      ),
      ctx.guard(
        h(
          "button",
          {
            type: "button",
            class: "qz-btn-outline is-compact",
            "aria-pressed": options.muted,
            "data-action": "mute",
            "data-focus-key": `mute:${id}`,
            onclick: () => {
              const next = !options.muted;
              void run("没有改成", async () => {
                await ctx.api.entryMute(id, next);
                ctx.say(next ? "已设为不主动提。" : "已恢复主动提。");
                options.onMuted(next);
              });
            },
          },
          "不主动提",
        ),
      ),
      ctx.guard(
        h(
          "button",
          {
            type: "button",
            class: "qz-btn-outline is-compact",
            "data-action": "erase",
            "data-focus-key": `erase:${id}`,
            onclick: () => {
              void ctx
                .confirm({
                  title: "抹除这一条？",
                  word: "不可恢复",
                  quote: options.text,
                  paragraphs: [
                    "它会从所有设备上消失，而且不可恢复。",
                    "如果只是不想让他主动提起，用「不主动提」就够了。",
                  ],
                  confirmLabel: "抹除",
                  action: async () => {
                    await ctx.api.entryErase(id);
                  },
                })
                .then((done) => {
                  if (!done) return;
                  ctx.say("已抹除这一条。");
                  options.onErased();
                });
            },
          },
          "抹除",
        ),
      ),
    ),
    failureNode(),
  ];

  const drawEditor = (): Child[] => {
    const fieldId = uniqueId("edit");
    const textarea = ctx.guard(
      h(
        "textarea",
        {
          id: fieldId,
          rows: 4,
          "data-role": "entry-edit-text",
          "data-focus-key": `edit-text:${id}`,
          oninput: () => {
            draft = textarea.value;
          },
        },
        draft,
      ),
    );
    const close = (): void => {
      editing = false;
      failure = null;
      draw();
      container.querySelector<HTMLElement>('[data-action="edit"]')?.focus();
    };
    const form = h(
      "form",
      { class: "qz-clause-form", novalidate: true, "data-role": "entry-editor" },
      h(
        "div",
        { class: "qz-field" },
        h("label", { class: "qz-field-label", for: fieldId }, "改成"),
        h("div", { class: "qz-input is-multiline" }, textarea),
      ),
      failureNode(),
      h(
        "div",
        { class: "qz-actions" },
        ctx.guard(
          h(
            "button",
            {
              type: "submit",
              class: "qz-btn-outline is-compact",
              "data-action": "save",
              "data-focus-key": `save:${id}`,
            },
            "保存",
          ),
        ),
        h(
          "button",
          { type: "button", class: "qz-btn-text", "data-action": "cancel-edit", onclick: close },
          "取消",
        ),
      ),
    );
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const next = textarea.value.trim();
      if (next === "") {
        failure = "改成什么？这一条不能是空的。";
        ctx.alert(failure);
        draw();
        return;
      }
      if (next === options.text) {
        close();
        return;
      }
      void run("没有改成", async () => {
        await ctx.api.entryUpdate(id, next);
        ctx.say("已改好这一条。");
        editing = false;
        options.onUpdated(next);
      });
    });
    return [form];
  };

  function draw(): void {
    redraw(container, editing ? drawEditor() : drawButtons());
  }

  draw();
  return container;
}
