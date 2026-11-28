// 再次确认：抹除一条、吊销一台设备之前的那一下。
// 原生 <dialog> 的模态：焦点被圈在里面，Esc 取消，关掉以后焦点回到触发它的按钮。
// 对话框里没有白色主按钮；一屏唯一的白色按钮留给底线页的「签署」。
import { h, uniqueId, type Child } from "./dom.js";
import { stateWord } from "./marks.js";

export interface ConfirmRequest {
  title: string;
  /** 琥珀状态词：这一步需要你。 */
  word: string;
  /** 被操作的那一条的原文。 */
  quote?: string;
  paragraphs: readonly string[];
  confirmLabel: string;
  passphrase?: { label: string; hint: string };
  /** 真正的写操作。失败时对话框留在原地并显示原因。 */
  action(input: { passphrase: string }): Promise<void>;
}

export interface DialogHost {
  /** 对话框挂在哪里。 */
  readonly mount: HTMLElement;
  /** 把一次失败写成一句给人看的话。 */
  describe(error: unknown): string;
  /** 断言通道播报。 */
  alert(message: string): void;
}

export function confirmDialog(host: DialogHost, request: ConfirmRequest): Promise<boolean> {
  const titleId = uniqueId("dialog-title");
  const bodyId = uniqueId("dialog-body");
  const inputId = uniqueId("dialog-passphrase");
  const hintId = uniqueId("dialog-hint");

  const cancel = h(
    "button",
    {
      type: "button",
      class: "qz-btn-text",
      "data-role": "dialog-cancel",
      // 没有口令要输时，默认停在「取消」上：回车不会误触不可恢复的动作。
      autofocus: request.passphrase ? null : true,
    },
    "取消",
  );
  const confirm = h(
    "button",
    { type: "submit", class: "qz-btn-outline", "data-role": "dialog-confirm" },
    request.confirmLabel,
  );
  const failure = h("p", {
    class: "qz-field-hint is-amber",
    "data-role": "dialog-error",
    hidden: true,
  });

  let passphraseInput: HTMLInputElement | null = null;
  const fields: Child[] = [];
  if (request.passphrase) {
    passphraseInput = h("input", {
      id: inputId,
      type: "password",
      autocomplete: "current-password",
      required: true,
      autofocus: true,
      "aria-describedby": hintId,
      "data-role": "dialog-passphrase",
    });
    fields.push(
      h(
        "div",
        { class: "qz-field" },
        h("label", { class: "qz-field-label", for: inputId }, request.passphrase.label),
        h("div", { class: "qz-input is-secret" }, passphraseInput),
        h("p", { class: "qz-field-hint", id: hintId }, request.passphrase.hint),
      ),
    );
  }

  const form = h(
    "form",
    { novalidate: true },
    stateWord("amber", request.word),
    h("h2", { class: "qz-dialog-title", id: titleId }, request.title),
    h(
      "div",
      { class: "qz-dialog-body", id: bodyId },
      request.quote ? h("blockquote", { class: "qz-prompt-quote" }, request.quote) : null,
      ...request.paragraphs.map((paragraph) => h("p", null, paragraph)),
    ),
    ...fields,
    failure,
    h("div", { class: "qz-dialog-actions" }, cancel, confirm),
  );
  const dialog = h(
    "dialog",
    { class: "qz-dialog", "aria-labelledby": titleId, "aria-describedby": bodyId },
    form,
  );

  return new Promise<boolean>((resolve) => {
    let busy = false;
    let done = false;

    // 在途时不停用控件（停用会把键盘焦点丢出对话框），只标记不可用并挡住重复触发。
    const setBusy = (value: boolean): void => {
      busy = value;
      confirm.setAttribute("aria-disabled", String(value));
      cancel.setAttribute("aria-disabled", String(value));
      if (passphraseInput) passphraseInput.readOnly = value;
      dialog.setAttribute("aria-busy", String(value));
    };

    const fail = (message: string): void => {
      failure.textContent = message;
      failure.hidden = false;
      host.alert(message);
    };

    cancel.addEventListener("click", () => {
      if (!busy) dialog.close();
    });
    dialog.addEventListener("cancel", (event) => {
      // 写操作在途时不让 Esc 把对话框关掉：结果必须被看见。
      if (busy) event.preventDefault();
    });
    dialog.addEventListener("close", () => {
      dialog.remove();
      resolve(done);
    });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (busy) return;
      const passphrase = passphraseInput?.value ?? "";
      if (passphraseInput && passphrase === "") {
        fail("先输入口令。");
        passphraseInput.focus();
        return;
      }
      failure.hidden = true;
      setBusy(true);
      request.action({ passphrase }).then(
        () => {
          done = true;
          setBusy(false);
          dialog.close();
        },
        (error: unknown) => {
          setBusy(false);
          fail(`没有做成：${host.describe(error)}`);
          (passphraseInput ?? confirm).focus();
        },
      );
    });

    host.mount.append(dialog);
    dialog.showModal();
  });
}
