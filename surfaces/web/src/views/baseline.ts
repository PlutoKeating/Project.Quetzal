// 底线：一份可编辑的短句清单与一个签署动作。
// 未签署时整页的状态词是琥珀色的「待签署」；签署后是冰蓝色的「自某日起生效」。部署约束列在下方，只读。
// 「签署」是全站唯一的白色主按钮。
import type { Baseline, Directive } from "../api/types.js";
import { viewInfo } from "../shell/routes.js";
import { byData, cls, h, redraw, type Child } from "../ui/dom.js";
import { formatDate, ordinal } from "../ui/format.js";
import { stateWord } from "../ui/marks.js";
import { describeError, situation } from "../ui/situation.js";
import { BaseView, type ViewContext } from "./base.js";

interface Clause {
  /** 界面里的稳定标识：已签署的条目用它的 id，新写的用一个本地序号。 */
  key: string;
  title: string;
  text: string;
}

interface Editing {
  /** 正在改哪一条；`null` 表示在写新的一条。 */
  key: string | null;
  title: string;
  text: string;
}

function toClauses(directives: readonly Directive[]): Clause[] {
  return directives.map((directive) => ({
    key: directive.id,
    title: directive.title,
    text: directive.text,
  }));
}

export class BaselineView extends BaseView<Baseline> {
  #clauses: Clause[] = [];
  #dirty = false;
  #editing: Editing | null = null;
  #selectedKey: string | null = null;
  #signing = false;
  #failure: string | null = null;
  #recent: string | null = null;
  #draftSeq = 0;
  // 口令框里正在输入的内容：页面别处重绘时不丢，签署成功后清掉。
  #secret = "";
  #secretRepeat = "";

  constructor(ctx: ViewContext) {
    super(ctx, viewInfo("baseline"));
  }

  protected fetch(): Promise<Baseline> {
    return this.ctx.api.baseline();
  }

  protected render(): void {
    const data = this.data;
    if (!data) return;
    // 还有没签的改动时，重新读取不覆盖手上的草稿。
    if (!this.#dirty && this.#editing === null) this.#clauses = toClauses(data.directives);
    this.#draw();
  }

  #status(): { tone: "ice" | "amber"; word: string } {
    const data = this.data;
    if (data?.signed && !this.#dirty && data.signed_at_ms !== null) {
      return { tone: "ice", word: `自 ${formatDate(data.signed_at_ms)} 起生效` };
    }
    if (data?.signed && this.#dirty) return { tone: "amber", word: "有改动待签署" };
    return { tone: "amber", word: "待签署" };
  }

  #draw(): void {
    const data = this.data;
    if (!data) return;
    const status = this.#status();
    const state = stateWord(status.tone, status.word);
    state.dataset["role"] = "baseline-state";
    this.setState(state);

    const children: Child[] = [];
    if (this.#clauses.length === 0 && this.#editing === null) {
      children.push(
        situation({
          kind: "baseline-empty",
          tone: "amber",
          word: "待签署",
          title: "你还没有写下底线",
          body: "底线是无论如何不许变的几件事。它不由他推断，也不随相处改变，只由你亲手写下并签署。没有底线时，他只受部署约束的限制。",
          steps: [
            { title: "写下", text: "每条一个短题和一句话。少而硬，三五条就够。" },
            { title: "签署", text: "输入口令并签署。第一次签署时，这个口令即被设定。" },
            { title: "生效", text: "签署之后，它们先于一切送进每一个宿主。" },
          ],
          action: { label: "写第一条", run: () => this.#startEditing(null) },
        }),
      );
    } else {
      children.push(this.#document(), this.#signBar(data));
    }
    children.push(this.#deployment(data.deployment));
    redraw(this.body, children);
    this.#updateProvenance();
  }

  #document(): HTMLElement {
    const adding = this.#editing !== null && this.#editing.key === null;
    return h(
      "section",
      { "aria-labelledby": "sea-baseline-own", "data-section": "directives" },
      h(
        "div",
        { class: "qz-view-section-head" },
        h("h2", { class: "qz-view-section-title", id: "sea-baseline-own" }, "你的底线"),
        h("p", { class: "qz-view-section-note" }, `${this.#clauses.length} 条`),
      ),
      h(
        "ol",
        { class: "qz-clauses", "data-role": "directives" },
        ...this.#clauses.map((clause, index) => this.#clause(clause, index)),
        adding ? this.#editorRow(this.#clauses.length) : null,
      ),
      this.#editing === null
        ? h(
            "div",
            { class: "qz-actions" },
            this.ctx.guard(
              h(
                "button",
                {
                  type: "button",
                  class: "qz-btn-outline is-compact",
                  "data-action": "add-directive",
                  "data-focus-key": "add-directive",
                  onclick: () => this.#startEditing(null),
                },
                "添一条",
              ),
              this.#signing,
            ),
          )
        : null,
    );
  }

  #clause(clause: Clause, index: number): HTMLElement {
    if (this.#editing !== null && this.#editing.key === clause.key) return this.#editorRow(index);
    const current = this.#selectedKey === clause.key;
    const locked = this.#editing !== null || this.#signing;
    return h(
      "li",
      { class: cls("qz-clause", current && "is-current"), "data-entry": clause.key },
      h("span", { class: "qz-clause-no", "aria-hidden": "true" }, ordinal(index)),
      h(
        "div",
        null,
        h(
          "h3",
          { class: "qz-clause-title" },
          h(
            "button",
            {
              type: "button",
              class: "qz-pick",
              "aria-current": current ? "true" : null,
              "data-focus-key": `clause:${clause.key}`,
              onclick: () => {
                this.#selectedKey = current ? null : clause.key;
                this.#draw();
              },
            },
            clause.title,
          ),
        ),
        h("p", { class: "qz-clause-text" }, clause.text),
      ),
      h(
        "div",
        { class: "qz-actions" },
        this.ctx.guard(
          h(
            "button",
            {
              type: "button",
              class: "qz-btn-outline is-compact",
              "data-action": "edit-directive",
              "data-focus-key": `clause-edit:${clause.key}`,
              "aria-label": `改「${clause.title}」`,
              onclick: () => this.#startEditing(clause.key),
            },
            "改",
          ),
          locked,
        ),
        this.ctx.guard(
          h(
            "button",
            {
              type: "button",
              class: "qz-btn-text",
              "data-action": "remove-directive",
              "data-focus-key": `clause-remove:${clause.key}`,
              "aria-label": `移除「${clause.title}」`,
              onclick: () => {
                this.#clauses = this.#clauses.filter((item) => item.key !== clause.key);
                if (this.#selectedKey === clause.key) this.#selectedKey = null;
                this.#dirty = true;
                this.#recent = null;
                this.ctx.say(`已从草稿里移除「${clause.title}」，签署之后生效。`);
                this.#draw();
              },
            },
            "移除",
          ),
          locked,
        ),
      ),
    );
  }

  #startEditing(key: string | null): void {
    const clause = key === null ? undefined : this.#clauses.find((item) => item.key === key);
    this.#editing = { key, title: clause?.title ?? "", text: clause?.text ?? "" };
    this.#failure = null;
    this.#draw();
    this.body.querySelector<HTMLElement>('[data-role="directive-title"]')?.focus();
  }

  #editorRow(index: number): HTMLElement {
    const editing = this.#editing;
    if (!editing) return h("li", null);
    const titleId = "sea-baseline-edit-title";
    const textId = "sea-baseline-edit-text";
    const title = this.ctx.guard(
      h("input", {
        id: titleId,
        type: "text",
        value: editing.title,
        maxlength: 40,
        autocomplete: "off",
        "data-role": "directive-title",
        "data-focus-key": "directive-title",
        oninput: () => {
          editing.title = title.value;
        },
      }),
    );
    const text = this.ctx.guard(
      h(
        "textarea",
        {
          id: textId,
          rows: 3,
          "data-role": "directive-text",
          "data-focus-key": "directive-text",
          oninput: () => {
            editing.text = text.value;
          },
        },
        editing.text,
      ),
    );
    const close = (): void => {
      const key = editing.key;
      this.#editing = null;
      this.#failure = null;
      this.#draw();
      (
        (key === null
          ? byData(this.body, "focus-key", "add-directive")
          : byData(this.body, "focus-key", `clause-edit:${key}`)) ??
        byData(this.body, "role", "situation-action")
      )?.focus();
    };
    const form = h(
      "form",
      { class: "qz-clause-form", novalidate: true, "data-role": "directive-editor" },
      h(
        "div",
        { class: "qz-field" },
        h("label", { class: "qz-field-label", for: titleId }, "短题"),
        h("div", { class: "qz-input" }, title),
      ),
      h(
        "div",
        { class: "qz-field" },
        h("label", { class: "qz-field-label", for: textId }, "短句"),
        h("div", { class: "qz-input is-multiline" }, text),
      ),
      this.#failure === null
        ? null
        : h("p", { class: "qz-field-hint is-amber", "data-role": "directive-error" }, this.#failure),
      h(
        "div",
        { class: "qz-actions" },
        this.ctx.guard(
          h(
            "button",
            {
              type: "submit",
              class: "qz-btn-outline is-compact",
              "data-action": "finish-directive",
              "data-focus-key": "finish-directive",
            },
            "写好了",
          ),
        ),
        h(
          "button",
          { type: "button", class: "qz-btn-text", "data-action": "cancel-directive", onclick: close },
          "取消",
        ),
      ),
    );
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const nextTitle = title.value.trim();
      const nextText = text.value.trim();
      if (nextTitle === "" || nextText === "") {
        this.#failure = "短题和短句都要写。";
        this.ctx.alert(this.#failure);
        this.#draw();
        return;
      }
      if (editing.key === null) {
        this.#draftSeq += 1;
        this.#clauses = [...this.#clauses, { key: `draft-${this.#draftSeq}`, title: nextTitle, text: nextText }];
        this.#dirty = true;
      } else {
        const before = this.#clauses.find((item) => item.key === editing.key);
        if (before && (before.title !== nextTitle || before.text !== nextText)) this.#dirty = true;
        this.#clauses = this.#clauses.map((item) =>
          item.key === editing.key ? { ...item, title: nextTitle, text: nextText } : item,
        );
      }
      this.#recent = null;
      this.ctx.say("已写进草稿，签署之后生效。");
      close();
    });
    return h(
      "li",
      { class: "qz-clause is-current", "data-entry": editing.key ?? "new" },
      h("span", { class: "qz-clause-no", "aria-hidden": "true" }, ordinal(index)),
      form,
    );
  }

  #signBar(data: Baseline): HTMLElement {
    // 从没签过：这一次的口令即被设定，所以要输两遍。
    const first = data.signed_at_ms === null;
    // 已经签署、又没有改动：没有东西可签，口令框收起，按钮停用。
    const settled = data.signed && !this.#dirty;
    const blocked = settled || this.#editing !== null || this.#clauses.length === 0;
    const passphrase = this.ctx.guard(
      h("input", {
        id: "sea-baseline-passphrase",
        type: "password",
        autocomplete: first ? "new-password" : "current-password",
        "aria-describedby": "sea-baseline-passphrase-hint",
        "data-role": "sign-passphrase",
        "data-focus-key": "sign-passphrase",
        oninput: () => {
          this.#secret = passphrase.value;
        },
      }),
    );
    passphrase.value = this.#secret;
    const repeat = first
      ? this.ctx.guard(
          h("input", {
            id: "sea-baseline-passphrase-repeat",
            type: "password",
            autocomplete: "new-password",
            "data-role": "sign-passphrase-repeat",
            "data-focus-key": "sign-passphrase-repeat",
            oninput: (event) => {
              if (event.target instanceof HTMLInputElement) this.#secretRepeat = event.target.value;
            },
          }),
        )
      : null;
    if (repeat) repeat.value = this.#secretRepeat;
    const button = this.ctx.guard(
      h(
        "button",
        { type: "submit", class: "qz-btn-white", "data-action": "sign", "data-focus-key": "sign" },
        this.#signing ? "正在签署" : "签署",
      ),
      blocked,
    );
    const form = h(
      "form",
      {
        class: "qz-sign-bar",
        novalidate: true,
        "data-role": "sign-bar",
        "aria-labelledby": "sea-baseline-sign",
        "aria-busy": this.#signing,
      },
      h(
        "div",
        null,
        h("h2", { class: "qz-cell-title", id: "sea-baseline-sign" }, settled ? "已经签署" : "签署这份底线"),
        h(
          "p",
          { class: "qz-view-section-note" },
          settled
            ? "上面的每一条都在生效。改动任何一条之后，需要重新签署。"
            : "签署之后，上面的每一条先于一切送进每一个宿主；之前签过的那一份随之作废。",
        ),
        settled
          ? null
          : h(
              "div",
              { class: "qz-sign-bar-fields" },
              h(
                "div",
                { class: "qz-field" },
                h("label", { class: "qz-field-label", for: "sea-baseline-passphrase" }, first ? "设定口令" : "口令"),
                h("div", { class: "qz-input is-secret" }, passphrase),
                h(
                  "p",
                  { class: "qz-field-hint", id: "sea-baseline-passphrase-hint" },
                  first
                    ? "第一次签署时，这个口令即被设定。以后签署和吊销设备都要用它。"
                    : "第一次签署时设定的那个口令。",
                ),
              ),
              repeat
                ? h(
                    "div",
                    { class: "qz-field" },
                    h("label", { class: "qz-field-label", for: "sea-baseline-passphrase-repeat" }, "再输一遍"),
                    h("div", { class: "qz-input is-secret" }, repeat),
                  )
                : null,
            ),
      ),
      button,
      this.#failure !== null && this.#editing === null
        ? h("p", { class: "qz-field-hint is-amber", "data-role": "sign-error" }, this.#failure)
        : null,
    );
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (blocked || this.#signing) return;
      const secret = passphrase.value;
      if (secret === "") return this.#refuse("先输入口令。", passphrase);
      if (repeat && repeat.value !== secret) return this.#refuse("两遍口令不一样。", repeat);
      void this.#sign(secret);
    });
    return form;
  }

  #refuse(message: string, focus: HTMLElement): void {
    this.#failure = message;
    this.ctx.alert(message);
    const key = focus.dataset["focusKey"];
    this.#draw();
    if (key !== undefined) byData(this.body, "focus-key", key)?.focus();
  }

  async #sign(passphrase: string): Promise<void> {
    const data = this.data;
    if (!data) return;
    this.#signing = true;
    this.#failure = null;
    this.#draw();
    try {
      const signed = await this.ctx.api.baselineSign(
        this.#clauses.map(({ title, text }) => ({ title, text })),
        passphrase,
      );
      this.data = {
        ...data,
        signed: true,
        signed_at_ms: signed.signed_at_ms,
        directives: this.#clauses.map((clause) => ({ id: clause.key, title: clause.title, text: clause.text })),
      };
      this.#dirty = false;
      this.#secret = "";
      this.#secretRepeat = "";
      this.#recent = "刚刚由你签署";
      this.ctx.say(`已签署，${this.#clauses.length} 条底线自现在起生效。`);
      this.ctx.overviewChanged();
    } catch (error) {
      this.#failure = `没有签成：${describeError(error)}`;
      this.ctx.alert(this.#failure);
    }
    this.#signing = false;
    this.#draw();
    // 签成了：口令框已经收起，焦点交给页面标题；没签成：回到口令框。
    const passphraseField = byData(this.body, "focus-key", "sign-passphrase");
    if (passphraseField) passphraseField.focus();
    else this.focusHeading();
  }

  #deployment(items: readonly Directive[]): HTMLElement {
    const content: Child =
      items.length === 0
        ? situation({
            kind: "deployment-empty",
            tone: "neutral",
            word: "没有",
            title: "这份部署没有附加约束",
            body: "部署约束由安装和运营这套系统的一方定下。这里没有，他只受你的底线限制。",
            compact: true,
            headingLevel: 3,
          })
        : h(
            "div",
            { class: "qz-rail is-grid is-2", "data-role": "deployment" },
            ...items.map((item) =>
              h(
                "div",
                { class: "qz-cell", "data-entry": item.id },
                h("h3", { class: "qz-cell-title" }, item.title),
                h("p", null, item.text),
              ),
            ),
          );
    return h(
      "section",
      { class: "qz-view-section", "data-qz-lit": true, "aria-labelledby": "sea-baseline-deployment", "data-section": "deployment" },
      h(
        "div",
        { class: "qz-view-section-head" },
        h("h2", { class: "qz-view-section-title is-minor", id: "sea-baseline-deployment" }, "部署约束"),
        h("p", { class: "qz-view-section-note" }, "由部署这套系统的一方定下。只读，不在这里签。"),
      ),
      content,
    );
  }

  #anchor(key: string): HTMLElement | null {
    return byData(this.body, "entry", key);
  }

  #updateProvenance(): void {
    const data = this.data;
    if (!data) return;
    const status = this.#status();
    const signedFact = {
      term: "签署",
      value: data.signed_at_ms === null ? "还没有签过" : `${formatDate(data.signed_at_ms)}，由你`,
    };
    const clause = this.#clauses.find((item) => item.key === this.#selectedKey);
    if (!clause) {
      this.#selectedKey = null;
      this.defaultProvenance({
        facts: [
          { term: "状态", value: status.word },
          signedFact,
          { term: "条数", value: `${this.#clauses.length} 条你的底线，${data.deployment.length} 条部署约束` },
        ],
        recent: this.#recent,
      });
      return;
    }
    const signedVersion = data.directives.find((item) => item.id === clause.key);
    const unchanged =
      data.signed && signedVersion?.title === clause.title && signedVersion.text === clause.text;
    this.ctx.provenance(
      {
        title: clause.title,
        lead: unchanged
          ? "这一条由你写下，并且已经签署生效。"
          : "这一条由你写下，还在草稿里。签署之后才生效。",
        facts: [{ term: "状态", value: unchanged ? status.word : "待签署" }, signedFact],
        recent: this.#recent,
      },
      this.#anchor(clause.key),
    );
  }
}
