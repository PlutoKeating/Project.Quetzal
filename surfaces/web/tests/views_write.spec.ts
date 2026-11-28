import { describe, expect, it, vi } from "vitest";
import { FakeApi, freshFixture, PASSPHRASE } from "./fake_api.js";
import { mount, press, settle, submit, type, type Mounted } from "./harness.js";

function text(element: Element | null): string {
  return element?.textContent ?? "";
}

function dialog(): HTMLDialogElement {
  const found = document.querySelector<HTMLDialogElement>("dialog.qz-dialog");
  if (!found) throw new Error("没有打开的对话框");
  return found;
}

function inDialog<T extends HTMLElement>(selector: string): T {
  const found = dialog().querySelector<T>(selector);
  if (!found) throw new Error(`对话框里找不到 ${selector}`);
  return found;
}

async function select(ui: Mounted, id: string): Promise<void> {
  press(ui.q(`[data-entry="${id}"] .qz-pick`));
  await settle();
}

describe("改：就地换成文本框，保存后这一条就地更新", () => {
  it("我 · 改一条偏好：原地更新、标上「你说的」、出处栏追加「刚刚由你修改」", async () => {
    const ui = await mount({ hash: "#/user" });
    await select(ui, "pref-1");
    expect(ui.all('[data-entry="pref-1"] [data-mark="owner"]')).toHaveLength(0);

    press(ui.q('[data-entry="pref-1"] [data-action="edit"]'));
    const editor = ui.q<HTMLTextAreaElement>('[data-role="entry-edit-text"]');
    expect(editor.value).toBe("回答先给结论，再给理由。");
    expect(document.activeElement).toBe(editor);

    type(editor, "先给结论，再给理由，最后给出处。");
    submit(ui.q<HTMLFormElement>('[data-role="entry-editor"]'));
    await settle();

    expect(ui.api.callsTo("sea_entry_update")).toEqual([
      { method: "sea_entry_update", params: { id: "pref-1", text: "先给结论，再给理由，最后给出处。" } },
    ]);
    // 就地更新：没有换页，这一条还选中着。
    expect(window.location.hash).toBe("#/user");
    const row = ui.q('[data-entry="pref-1"]');
    expect(row.classList.contains("is-current")).toBe(true);
    expect(text(row.querySelector(".qz-row-text"))).toBe("先给结论，再给理由，最后给出处。");
    expect(text(row.querySelector('[data-mark="owner"]'))).toBe("你说的");
    expect(ui.all('[data-role="entry-editor"]')).toHaveLength(0);
    // 出处栏追加一行；读屏播报成功；不弹提示条。
    expect(text(ui.q('[data-role="provenance-recent"]'))).toBe("刚刚由你修改");
    expect(ui.q('[data-role="provenance-recent"]').classList.contains("is-amber")).toBe(true);
    expect(ui.said()).toBe("已改好这一条。");
    expect(ui.all('[role="alertdialog"], .toast, [data-role="toast"]')).toHaveLength(0);
    // 它的经过多了一步「纠正 · 你」。
    await vi.waitFor(() =>
      expect(text(ui.q('[data-role="provenance-events"]'))).toContain("纠正 · 你"),
    );
  });

  it("往事 · 改一条：列表里的摘要和右侧的全文一起更新", async () => {
    const ui = await mount({ hash: "#/memories" });
    press(ui.q('[data-role="memory-detail"] [data-action="edit"]'));
    type(ui.q<HTMLTextAreaElement>('[data-role="entry-edit-text"]'), "先写契约，再写实现，最后补测试。");
    submit(ui.q<HTMLFormElement>('[data-role="entry-editor"]'));
    await settle();

    expect(text(ui.q('[data-role="memory-text"]'))).toBe("先写契约，再写实现，最后补测试。");
    expect(text(ui.q('[data-entry="mem-1"] .qz-row-text'))).toBe("先写契约，再写实现，最后补测试。");
    expect(text(ui.q('[data-entry="mem-1"] [data-mark="owner"]'))).toBe("你说的");
    expect(text(ui.q('[data-role="provenance-recent"]'))).toBe("刚刚由你修改");
    expect(ui.q('[data-entry="mem-1"]').classList.contains("is-current")).toBe(true);
  });

  it("没有改动就不写；空的不让存", async () => {
    const ui = await mount({ hash: "#/user" });
    await select(ui, "pref-1");
    press(ui.q('[data-entry="pref-1"] [data-action="edit"]'));
    submit(ui.q<HTMLFormElement>('[data-role="entry-editor"]'));
    await settle();
    expect(ui.api.callsTo("sea_entry_update")).toHaveLength(0);
    expect(ui.all('[data-role="entry-editor"]')).toHaveLength(0);

    press(ui.q('[data-entry="pref-1"] [data-action="edit"]'));
    type(ui.q<HTMLTextAreaElement>('[data-role="entry-edit-text"]'), "   ");
    submit(ui.q<HTMLFormElement>('[data-role="entry-editor"]'));
    await settle();
    expect(ui.api.callsTo("sea_entry_update")).toHaveLength(0);
    expect(text(ui.q('[data-role="entry-error"]'))).toContain("不能是空的");
    expect(ui.alerted()).toContain("不能是空的");
  });

  it("没有改成：原文不动，写明原因，文本框里的内容还在", async () => {
    const api = new FakeApi();
    const ui = await mount({ api, hash: "#/user" });
    await select(ui, "fact-1");
    press(ui.q('[data-entry="fact-1"] [data-action="edit"]'));
    type(ui.q<HTMLTextAreaElement>('[data-role="entry-edit-text"]'), "做软件工程，也写 Go。");
    api.failNext("sea_entry_update", "STORAGE_ERROR", "脊柱暂时写不进去。");
    submit(ui.q<HTMLFormElement>('[data-role="entry-editor"]'));
    await settle();

    expect(text(ui.q('[data-role="entry-error"]'))).toBe("没有改成：脊柱暂时写不进去。");
    expect(ui.alerted()).toBe("没有改成：脊柱暂时写不进去。");
    expect(ui.q<HTMLTextAreaElement>('[data-role="entry-edit-text"]').value).toBe("做软件工程，也写 Go。");
    expect(text(ui.q('[data-entry="fact-1"] .qz-row-text'))).toBe("做软件工程，主要写 Rust 和 TypeScript。");
    expect(ui.all('[data-role="provenance-recent"]')).toHaveLength(0);
  });

  it("取消：回到三个动作，焦点回到「改」", async () => {
    const ui = await mount({ hash: "#/user" });
    await select(ui, "pref-1");
    press(ui.q('[data-entry="pref-1"] [data-action="edit"]'));
    press(ui.q('[data-action="cancel-edit"]'));
    expect(ui.all('[data-role="entry-editor"]')).toHaveLength(0);
    expect(document.activeElement).toBe(ui.q('[data-entry="pref-1"] [data-action="edit"]'));
  });
});

describe("不主动提：一个开关", () => {
  it("往事 · 设为不主动提：这一条就地带上标记，开关显示为按下", async () => {
    const ui = await mount({ hash: "#/memories" });
    const mute = ui.q<HTMLButtonElement>('[data-role="memory-detail"] [data-action="mute"]');
    expect(mute.getAttribute("aria-pressed")).toBe("false");
    press(mute);
    await settle();

    expect(ui.api.callsTo("sea_entry_mute")).toEqual([
      { method: "sea_entry_mute", params: { id: "mem-1", muted: true } },
    ]);
    // 它还留在眼前的列表里，不会因为换了状态突然消失。
    expect(text(ui.q('[data-entry="mem-1"] [data-mark="muted"]'))).toBe("不主动提");
    const pressed = ui.q<HTMLButtonElement>('[data-role="memory-detail"] [data-action="mute"]');
    expect(pressed.getAttribute("aria-pressed")).toBe("true");
    expect(document.activeElement).toBe(pressed);
    expect(text(ui.q('[data-role="provenance-recent"]'))).toBe("刚刚由你修改");
    expect(ui.said()).toBe("已设为不主动提。");

    press(pressed);
    await settle();
    expect(ui.api.callsTo("sea_entry_mute").at(-1)?.params).toEqual({ id: "mem-1", muted: false });
    expect(ui.all('[data-entry="mem-1"] [data-mark="muted"]')).toHaveLength(0);
    expect(ui.said()).toBe("已恢复主动提。");
  });

  it("没有改成：标记不变，写明原因", async () => {
    const api = new FakeApi();
    const ui = await mount({ api, hash: "#/user" });
    await select(ui, "fact-1");
    api.failNext("sea_entry_mute", "STORAGE_ERROR", "脊柱暂时写不进去。");
    press(ui.q('[data-entry="fact-1"] [data-action="mute"]'));
    await settle();
    expect(ui.all('[data-entry="fact-1"] [data-mark="muted"]')).toHaveLength(0);
    expect(text(ui.q('[data-role="entry-error"]'))).toBe("没有改成：脊柱暂时写不进去。");
    expect(ui.q('[data-entry="fact-1"] [data-action="mute"]').getAttribute("aria-pressed")).toBe("false");
  });
});

describe("抹除：必须二次确认", () => {
  it("确认框说明它会从所有设备上消失且不可恢复；默认焦点在「取消」", async () => {
    const ui = await mount({ hash: "#/memories" });
    press(ui.q('[data-role="memory-detail"] [data-action="erase"]'));
    const box = dialog();
    expect(box.open).toBe(true);
    expect(text(box.querySelector("h2"))).toBe("抹除这一条？");
    expect(text(box.querySelector("blockquote"))).toBe("倾向于先写接口契约，再写实现。");
    expect(text(box)).toContain("它会从所有设备上消失，而且不可恢复。");
    expect(document.activeElement).toBe(inDialog('[data-role="dialog-cancel"]'));
    // 对话框里没有白色主按钮。
    expect(box.querySelectorAll(".qz-btn-white")).toHaveLength(0);
    // 还没有确认：什么都没写。
    expect(ui.api.callsTo("sea_entry_erase")).toHaveLength(0);

    press(inDialog('[data-role="dialog-cancel"]'));
    await settle();
    expect(document.querySelector("dialog")).toBeNull();
    expect(ui.api.callsTo("sea_entry_erase")).toHaveLength(0);
    expect(ui.all('[data-entry="mem-1"]')).toHaveLength(1);
  });

  it("确认之后：这一条从列表里消失，选中移到下一条，出处栏记下「刚刚由你抹除」", async () => {
    const ui = await mount({ hash: "#/memories" });
    press(ui.q('[data-role="memory-detail"] [data-action="erase"]'));
    submit(inDialog<HTMLFormElement>("form"));
    await settle();

    expect(ui.api.callsTo("sea_entry_erase")).toEqual([
      { method: "sea_entry_erase", params: { id: "mem-1" } },
    ]);
    expect(document.querySelector("dialog")).toBeNull();
    expect(ui.all('[data-entry="mem-1"]')).toHaveLength(0);
    expect(ui.all('[data-role="memory-list"] .qz-row')).toHaveLength(2);
    expect(text(ui.q('[data-role="memory-total"]'))).toBe("共 2 件");
    expect(ui.q('[data-entry="mem-2"]').classList.contains("is-current")).toBe(true);
    expect(text(ui.q('[data-role="provenance-recent"]'))).toBe("刚刚由你抹除");
    expect(ui.said()).toBe("已抹除这一条。");
  });

  it("我 · 抹除一条事实：从那一栏消失，出处回到这一页的说明", async () => {
    const ui = await mount({ hash: "#/user" });
    await select(ui, "fact-2");
    press(ui.q('[data-entry="fact-2"] [data-action="erase"]'));
    submit(inDialog<HTMLFormElement>("form"));
    await settle();
    expect(ui.all('[data-entry="fact-2"]')).toHaveLength(0);
    expect(ui.all('[data-column="facts"] .qz-row')).toHaveLength(1);
    expect(text(ui.q('[data-role="provenance-recent"]'))).toBe("刚刚由你抹除");
    expect(ui.aside.dataset["selected"]).toBe("false");
  });

  it("没有抹成：对话框留在原地并写明原因，条目还在", async () => {
    const api = new FakeApi();
    const ui = await mount({ api, hash: "#/memories" });
    press(ui.q('[data-role="memory-detail"] [data-action="erase"]'));
    api.failNext("sea_entry_erase", "STORAGE_ERROR", "脊柱暂时写不进去。");
    submit(inDialog<HTMLFormElement>("form"));
    await settle();
    expect(dialog().open).toBe(true);
    expect(text(inDialog('[data-role="dialog-error"]'))).toBe("没有做成：脊柱暂时写不进去。");
    expect(ui.alerted()).toBe("没有做成：脊柱暂时写不进去。");
    expect(ui.all('[data-entry="mem-1"]')).toHaveLength(1);
  });
});

describe("签署：底线页唯一的白色主按钮", () => {
  it("第一次签署：写下一条，设定口令并签署，状态词从琥珀变成冰蓝", async () => {
    const api = new FakeApi(freshFixture());
    const ui = await mount({ api, hash: "#/baseline" });
    press(ui.q('[data-role="situation-action"]'));
    expect(document.activeElement).toBe(ui.q('[data-role="directive-title"]'));
    type(ui.q<HTMLInputElement>('[data-role="directive-title"]'), "不替我做不可逆的决定");
    type(ui.q<HTMLTextAreaElement>('[data-role="directive-text"]'), "涉及钱和删除数据的事，必须等我确认。");
    submit(ui.q<HTMLFormElement>('[data-role="directive-editor"]'));
    await settle();

    expect(ui.all('[data-role="directives"] .qz-clause')).toHaveLength(1);
    expect(text(ui.q('[data-role="baseline-state"]'))).toBe("待签署");
    expect(ui.all(".qz-btn-white")).toHaveLength(1);
    // 草稿不是写入：这时守护进程还什么都没收到。
    expect(api.callsTo("sea_baseline_sign")).toHaveLength(0);

    // 第一次签署要把口令输两遍；不一样就不签。
    type(ui.q<HTMLInputElement>('[data-role="sign-passphrase"]'), "first-passphrase");
    type(ui.q<HTMLInputElement>('[data-role="sign-passphrase-repeat"]'), "first-passphras");
    submit(ui.q<HTMLFormElement>('[data-role="sign-bar"]'));
    await settle();
    expect(text(ui.q('[data-role="sign-error"]'))).toBe("两遍口令不一样。");
    expect(api.callsTo("sea_baseline_sign")).toHaveLength(0);

    type(ui.q<HTMLInputElement>('[data-role="sign-passphrase-repeat"]'), "first-passphrase");
    submit(ui.q<HTMLFormElement>('[data-role="sign-bar"]'));
    await settle();

    expect(api.callsTo("sea_baseline_sign")).toEqual([
      {
        method: "sea_baseline_sign",
        params: {
          directives: [{ title: "不替我做不可逆的决定", text: "涉及钱和删除数据的事，必须等我确认。" }],
          passphrase: "first-passphrase",
        },
      },
    ]);
    const state = ui.q('[data-role="baseline-state"]');
    expect(state.classList.contains("is-ice")).toBe(true);
    expect(text(state)).toMatch(/^自 \d{4}-\d{2}-\d{2} 起生效$/u);
    expect(text(ui.q('[data-role="provenance-recent"]'))).toBe("刚刚由你签署");
    expect(ui.said()).toBe("已签署，1 条底线自现在起生效。");
    // 导航上「底线」旁的信号点随之消失。
    await vi.waitFor(() =>
      expect(ui.all('nav a[data-nav="baseline"] [data-role="nav-signal"]')).toHaveLength(0),
    );
  });

  it("已签署之后改一条：状态词变成琥珀的「有改动待签署」，重新签署后回到冰蓝", async () => {
    const ui = await mount({ hash: "#/baseline" });
    press(ui.q('[data-entry="dir-2"] [data-action="edit-directive"]'));
    type(ui.q<HTMLTextAreaElement>('[data-role="directive-text"]'), "关于家人、健康和财务的往事，不对外引用。");
    submit(ui.q<HTMLFormElement>('[data-role="directive-editor"]'));
    await settle();

    const state = ui.q('[data-role="baseline-state"]');
    expect(state.classList.contains("is-amber")).toBe(true);
    expect(text(state)).toBe("有改动待签署");
    expect(text(ui.q('[data-entry="dir-2"] .qz-clause-text'))).toBe("关于家人、健康和财务的往事，不对外引用。");
    expect(ui.q<HTMLButtonElement>('[data-action="sign"]').disabled).toBe(false);
    // 已经设过口令：只输一遍。
    expect(ui.all('[data-role="sign-passphrase-repeat"]')).toHaveLength(0);

    type(ui.q<HTMLInputElement>('[data-role="sign-passphrase"]'), PASSPHRASE);
    submit(ui.q<HTMLFormElement>('[data-role="sign-bar"]'));
    await settle();
    expect(ui.api.callsTo("sea_baseline_sign").at(-1)?.params).toMatchObject({
      directives: [
        { title: "不替我做不可逆的决定", text: "涉及钱和删除数据的事，必须等我确认。" },
        { title: "不泄露我的私事", text: "关于家人、健康和财务的往事，不对外引用。" },
      ],
    });
    expect(ui.q('[data-role="baseline-state"]').classList.contains("is-ice")).toBe(true);
  });

  it("口令不对：没有签成，草稿和状态都不变", async () => {
    const ui = await mount({ hash: "#/baseline" });
    press(ui.q('[data-action="add-directive"]'));
    type(ui.q<HTMLInputElement>('[data-role="directive-title"]'), "不为讨好我而说假话");
    type(ui.q<HTMLTextAreaElement>('[data-role="directive-text"]'), "不确定就说不确定。");
    submit(ui.q<HTMLFormElement>('[data-role="directive-editor"]'));
    await settle();
    expect(ui.all('[data-role="directives"] .qz-clause')).toHaveLength(3);

    type(ui.q<HTMLInputElement>('[data-role="sign-passphrase"]'), "wrong");
    submit(ui.q<HTMLFormElement>('[data-role="sign-bar"]'));
    await settle();
    expect(text(ui.q('[data-role="sign-error"]'))).toBe("没有签成：口令不对。");
    expect(ui.alerted()).toBe("没有签成：口令不对。");
    expect(text(ui.q('[data-role="baseline-state"]'))).toBe("有改动待签署");
    expect(ui.all('[data-role="directives"] .qz-clause')).toHaveLength(3);
  });

  it("移除一条是草稿里的改动，签署之后才生效", async () => {
    const ui = await mount({ hash: "#/baseline" });
    press(ui.q('[data-entry="dir-1"] [data-action="remove-directive"]'));
    expect(ui.all('[data-role="directives"] .qz-clause')).toHaveLength(1);
    expect(text(ui.q('[data-role="baseline-state"]'))).toBe("有改动待签署");
    expect(ui.api.callsTo("sea_baseline_sign")).toHaveLength(0);
  });

  it("短题和短句都要写；还在写的时候不能签", async () => {
    const ui = await mount({ hash: "#/baseline" });
    press(ui.q('[data-action="add-directive"]'));
    expect(ui.q<HTMLButtonElement>('[data-action="sign"]').disabled).toBe(true);
    type(ui.q<HTMLInputElement>('[data-role="directive-title"]'), "只有短题");
    submit(ui.q<HTMLFormElement>('[data-role="directive-editor"]'));
    await settle();
    expect(text(ui.q('[data-role="directive-error"]'))).toBe("短题和短句都要写。");
    // 写了一半的内容还在。
    expect(ui.q<HTMLInputElement>('[data-role="directive-title"]').value).toBe("只有短题");
    expect(ui.all('[data-role="directives"] .qz-clause')).toHaveLength(3);
  });
});

describe("调节：全站唯一的滑杆", () => {
  it("拖到新的位置：写入一次，读数、出处与播报都跟上", async () => {
    const ui = await mount({ hash: "#/us" });
    const scale = ui.q<HTMLInputElement>('[data-role="focus-scale"]');
    scale.focus();
    scale.value = "50";
    scale.dispatchEvent(new Event("input", { bubbles: true }));
    // 拖动中读数就地跟着走，还没有写入。
    expect(text(ui.q('[data-role="focus-readout"]'))).toBe("他自己 50·我们 50");
    expect(scale.getAttribute("aria-valuetext")).toBe("他自己 50，我们 50");
    expect(ui.api.callsTo("sea_focus_set")).toHaveLength(0);

    scale.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() => expect(ui.api.callsTo("sea_focus_set")).toHaveLength(1));
    await settle();
    expect(ui.api.callsTo("sea_focus_set")[0]?.params).toEqual({ self_weight: 0.5 });
    const settled = ui.q<HTMLInputElement>('[data-role="focus-scale"]');
    expect(settled.value).toBe("50");
    expect(document.activeElement).toBe(settled);
    expect(text(ui.q('[data-role="provenance-recent"]'))).toBe("刚刚由你调节");
    expect(ui.said()).toBe("已调到：他自己 50，我们 50。");
  });

  it("连续几步只写最后一步", async () => {
    const ui = await mount({ hash: "#/us" });
    const scale = ui.q<HTMLInputElement>('[data-role="focus-scale"]');
    for (const value of ["39", "40", "41"]) {
      scale.value = value;
      scale.dispatchEvent(new Event("change", { bubbles: true }));
    }
    await vi.waitFor(() => expect(ui.api.callsTo("sea_focus_set")).toHaveLength(1));
    expect(ui.api.callsTo("sea_focus_set")[0]?.params).toEqual({ self_weight: 0.59 });
  });

  it("没有调成：刻度回到原来的位置，写明原因", async () => {
    const api = new FakeApi();
    const ui = await mount({ api, hash: "#/us" });
    api.failNext("sea_focus_set", "FLOOR_VIOLATION", "不能低于下限。");
    const scale = ui.q<HTMLInputElement>('[data-role="focus-scale"]');
    scale.value = "70";
    scale.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() => expect(ui.all('[data-role="focus-error"]')).toHaveLength(1));
    expect(text(ui.q('[data-role="focus-error"]'))).toBe("没有调成：不能低于下限。");
    expect(ui.q<HTMLInputElement>('[data-role="focus-scale"]').value).toBe("38");
    expect(ui.alerted()).toBe("没有调成：不能低于下限。");
  });
});

describe("吊销：再次确认，并要口令", () => {
  it("确认框写明后果并要口令；吊销之后这台设备就地消失", async () => {
    const ui = await mount({ hash: "#/devices" });
    press(ui.q('[data-entry="dev-old"] [data-action="revoke"]'));
    const box = dialog();
    expect(text(box.querySelector("h2"))).toBe("吊销「旧笔记本」？");
    expect(text(box)).toContain("吊销之后不能撤回");
    const passphrase = inDialog<HTMLInputElement>('[data-role="dialog-passphrase"]');
    expect(passphrase.type).toBe("password");
    expect(document.activeElement).toBe(passphrase);

    // 没输口令不提交。
    submit(inDialog<HTMLFormElement>("form"));
    await settle();
    expect(ui.api.callsTo("sea_device_revoke")).toHaveLength(0);
    expect(text(inDialog('[data-role="dialog-error"]'))).toBe("先输入口令。");

    type(passphrase, "wrong");
    submit(inDialog<HTMLFormElement>("form"));
    await settle();
    expect(text(inDialog('[data-role="dialog-error"]'))).toBe("没有做成：口令不对。");
    expect(ui.all('[data-entry="dev-old"]')).toHaveLength(1);

    type(passphrase, PASSPHRASE);
    submit(inDialog<HTMLFormElement>("form"));
    await settle();
    expect(ui.api.callsTo("sea_device_revoke").at(-1)?.params).toEqual({
      device_id: "dev-old",
      passphrase: PASSPHRASE,
    });
    expect(document.querySelector("dialog")).toBeNull();
    expect(ui.all('[data-entry="dev-old"]')).toHaveLength(0);
    expect(ui.all('[data-role="other-devices"] .qz-row')).toHaveLength(1);
    expect(text(ui.q('[data-role="provenance-recent"]'))).toBe("刚刚由你吊销");
    expect(ui.said()).toBe("已吊销「旧笔记本」。");
  });
});

describe("写操作之后，导航上的信号点重新读取", () => {
  it("每一次成功的写入之后都重读一次总览", async () => {
    const ui = await mount({ hash: "#/memories" });
    const before = ui.api.callsTo("sea_overview").length;
    press(ui.q('[data-role="memory-detail"] [data-action="mute"]'));
    await settle();
    expect(ui.api.callsTo("sea_overview").length).toBe(before + 1);
  });
});
