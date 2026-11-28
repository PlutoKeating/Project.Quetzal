import { describe, expect, it, vi } from "vitest";
import { DaemonUnreachable, SeaError } from "../src/api/client.js";
import { Announcer } from "../src/ui/announcer.js";
import { byData, cls, h, onRovingKey, redraw, uniqueId } from "../src/ui/dom.js";
import {
  calendarDaysBetween,
  daysTogether,
  excerpt,
  formatAgo,
  formatClock,
  formatDate,
  formatDateTime,
  formatDayHeading,
  ordinal,
  percent,
  spanDays,
} from "../src/ui/format.js";
import { dot, mutedMark, ownerMark, stateWord } from "../src/ui/marks.js";
import { commandBlock, describeError, situation } from "../src/ui/situation.js";

const at = (year: number, month: number, day: number, hour = 0, minute = 0): number =>
  new Date(year, month - 1, day, hour, minute).getTime();

describe("时间与数字的写法：固定格式，不随区域设置变化", () => {
  const now = at(2026, 11, 28, 9, 30);

  it("日期、时刻与两者合写", () => {
    expect(formatDate(at(2026, 3, 2))).toBe("2026-03-02");
    expect(formatClock(at(2026, 3, 2, 9, 5))).toBe("09:05");
    expect(formatDateTime(at(2026, 3, 2, 23, 59))).toBe("2026-03-02 23:59");
  });

  it("相处第 N 天：认识的当天是第 1 天，按日历日算", () => {
    expect(daysTogether(now, now)).toBe(1);
    expect(daysTogether(at(2026, 11, 27, 23, 59), now)).toBe(2);
    expect(daysTogether(at(2026, 4, 29, 9, 30), now)).toBe(214);
    // 时钟被调回去也不会出现第 0 天。
    expect(daysTogether(now + 86_400_000, now)).toBe(1);
  });

  it("离现在多久", () => {
    expect(formatAgo(now - 20_000, now)).toBe("刚刚");
    expect(formatAgo(now - 5 * 60_000, now)).toBe("5 分钟前");
    expect(formatAgo(now - 2 * 3_600_000, now)).toBe("2 小时前");
    expect(formatAgo(at(2026, 11, 27, 22, 0), now)).toBe("昨天");
    expect(formatAgo(at(2026, 11, 25, 9, 30), now)).toBe("3 天前");
    expect(formatAgo(at(2026, 5, 1), now)).toBe("2026-05-01");
  });

  it("时间线里一天的标题", () => {
    expect(formatDayHeading(now, now)).toBe("11 月 28 日 · 今天");
    expect(formatDayHeading(at(2026, 11, 27), now)).toBe("11 月 27 日 · 昨天");
    expect(formatDayHeading(at(2026, 11, 2), now)).toBe("11 月 2 日");
    expect(formatDayHeading(at(2025, 12, 31), now)).toBe("2025 年 12 月 31 日");
  });

  it("跨多少天、编号、摘要、权重", () => {
    expect(calendarDaysBetween(at(2026, 11, 26, 23), at(2026, 11, 28, 1))).toBe(2);
    expect(spanDays([])).toBe(0);
    expect(spanDays([now])).toBe(1);
    expect(spanDays([at(2026, 11, 14), at(2026, 11, 25), at(2026, 11, 20)])).toBe(12);
    expect(ordinal(0)).toBe("01");
    expect(ordinal(11)).toBe("12");
    expect(excerpt("短句。", 10)).toBe("短句。");
    expect(excerpt("一段  带换行\n的长句子需要截断", 6)).toBe("一段 带换行…");
    expect(percent(0.618)).toBe(62);
    expect(percent(-1)).toBe(0);
    expect(percent(4)).toBe(100);
  });
});

describe("DOM 构造器", () => {
  it("aria-* 的布尔值写成 true / false，其余布尔属性按有无", () => {
    const button = h("button", {
      type: "button",
      "aria-pressed": false,
      "aria-expanded": true,
      hidden: false,
      disabled: true,
    });
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(button.hasAttribute("hidden")).toBe(false);
    expect(button.getAttribute("disabled")).toBe("");
  });

  it("文本一律作为文本节点，标记不会被解析", () => {
    const paragraph = h("p", null, "<img src=x onerror=alert(1)>", 42, null, false);
    expect(paragraph.children).toHaveLength(0);
    expect(paragraph.textContent).toBe("<img src=x onerror=alert(1)>42");
  });

  it("事件监听按 on* 名字挂上，不写成属性", () => {
    const onClick = vi.fn();
    const button = h("button", { onclick: onClick }, "按");
    expect(button.hasAttribute("onclick")).toBe(false);
    button.click();
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("重绘之后，焦点回到带同一个 data-focus-key 的新节点", () => {
    const container = h("div");
    document.body.append(container);
    redraw(container, [
      h("button", { "data-focus-key": "a" }, "甲"),
      h("button", { "data-focus-key": "b:1/2" }, "乙"),
    ]);
    byData(container, "focus-key", "b:1/2")?.focus();
    const before = document.activeElement;
    redraw(container, [
      h("button", { "data-focus-key": "b:1/2" }, "乙（新的）"),
      h("button", { "data-focus-key": "a" }, "甲"),
    ]);
    expect(document.activeElement).not.toBe(before);
    expect(document.activeElement?.textContent).toBe("乙（新的）");
    container.remove();
  });

  it("按 data 的值找元素时逐个比较，不把值拼进选择器", () => {
    const tricky = 'id"] , body, [x="';
    const container = h("div", null, h("span", { "data-entry": tricky }), h("span", { "data-entry": "plain" }));
    expect(byData(container, "entry", tricky)).toBe(container.firstElementChild);
    expect(byData(container, "entry", "missing")).toBeNull();
    expect(cls("a", false, null, undefined, "", "b")).toBe("a b");
  });
});

describe("一组条目只占一个 Tab 停靠点", () => {
  function group(current: number | null): { container: HTMLElement; picks: HTMLElement[] } {
    const container = h("div");
    document.body.append(container);
    container.addEventListener("keydown", onRovingKey);
    redraw(container, [
      h(
        "ul",
        { "data-roving": true },
        ...[0, 1, 2].map((index) =>
          h(
            "li",
            null,
            h(
              "button",
              { class: "qz-pick", "aria-current": index === current ? "true" : null, "data-focus-key": `row:${index}` },
              `第 ${index + 1} 条`,
            ),
          ),
        ),
      ),
    ]);
    return { container, picks: Array.from(container.querySelectorAll<HTMLElement>(".qz-pick")) };
  }

  it("停在选中的那一条上；没有选中就是第一条", () => {
    const none = group(null);
    expect(none.picks.map((pick) => pick.tabIndex)).toEqual([0, -1, -1]);
    none.container.remove();
    const second = group(1);
    expect(second.picks.map((pick) => pick.tabIndex)).toEqual([-1, 0, -1]);
    second.container.remove();
  });

  it("组内用方向键走，Home / End 到两头，到头不绕回", () => {
    const { container, picks } = group(null);
    const key = (name: string): void => {
      document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }));
    };
    picks[0]?.focus();
    key("ArrowDown");
    expect(document.activeElement).toBe(picks[1]);
    expect(picks.map((pick) => pick.tabIndex)).toEqual([-1, 0, -1]);
    key("End");
    expect(document.activeElement).toBe(picks[2]);
    key("ArrowDown");
    expect(document.activeElement).toBe(picks[2]);
    key("Home");
    expect(document.activeElement).toBe(picks[0]);
    key("ArrowUp");
    expect(document.activeElement).toBe(picks[0]);
    container.remove();
  });

  it("元素 id 逐个生成，互不相同", () => {
    const first = uniqueId("field");
    const second = uniqueId("field");
    expect(first).toMatch(/^sea-field-\d+$/u);
    expect(second).not.toBe(first);
  });
});

describe("信号：颜色从不单独承担含义", () => {
  it("状态词总带文字；冰蓝与琥珀之外是安静的中性", () => {
    const ice = stateWord("ice", "已同步");
    expect(ice.className).toBe("qz-state is-ice");
    expect(ice.textContent).toBe("已同步");
    expect(ice.querySelector("i")?.getAttribute("aria-hidden")).toBe("true");
    expect(stateWord("amber", "待签署").className).toBe("qz-state is-amber");
    expect(stateWord("neutral", "仅本机").className).toBe("qz-state is-quiet");
  });

  it("圆点只是装饰，含义在它旁边的文字里", () => {
    expect(dot("ice").className).toBe("qz-dot is-ice");
    expect(dot("amber").className).toBe("qz-dot is-amber");
    expect(dot("neutral").className).toBe("qz-ring");
    for (const tone of ["ice", "amber", "neutral"] as const) {
      expect(dot(tone).getAttribute("aria-hidden")).toBe("true");
    }
  });

  it("「你说的」是琥珀；「不主动提」是中性", () => {
    expect(ownerMark().classList.contains("is-amber")).toBe(true);
    expect(ownerMark().textContent).toBe("你说的");
    expect(mutedMark().classList.contains("is-amber")).toBe(false);
    expect(mutedMark().textContent).toBe("不主动提");
  });
});

describe("状态版面：现状和下一步", () => {
  it("一个状态词、一句标题、一段说明，再加步骤与动作", () => {
    const run = vi.fn();
    const view = situation({
      kind: "example",
      tone: "amber",
      word: "待处理",
      title: "标题",
      body: "说明。",
      steps: [
        { title: "第一步", text: "做这个。" },
        { title: "第二步", text: "再做那个。" },
      ],
      action: { label: "重试", run },
    });
    expect(view.dataset["situation"]).toBe("example");
    expect(view.querySelector(".qz-state.is-amber")?.textContent).toBe("待处理");
    expect(view.querySelector("h2")?.textContent).toBe("标题");
    const steps = view.querySelectorAll('[data-role="situation-steps"] .qz-cell');
    expect(steps).toHaveLength(2);
    expect(steps[1]?.querySelector(".qz-cell-num")?.textContent).toBe("02");
    view.querySelector<HTMLButtonElement>('[data-role="situation-action"]')?.click();
    expect(run).toHaveBeenCalledOnce();
  });

  it("紧凑版用三级标题，嵌在页面的一部分里", () => {
    const view = situation({
      kind: "part",
      tone: "neutral",
      word: "还没有",
      title: "这一部分是空的",
      body: "说明。",
      compact: true,
      headingLevel: 3,
    });
    expect(view.classList.contains("is-compact")).toBe(true);
    expect(view.querySelector("h3")?.textContent).toBe("这一部分是空的");
    expect(view.querySelector("h2")).toBeNull();
  });

  it("命令块可以复制，复制之后短暂显示「已复制」", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const block = commandBlock("在终端启动它：", "qz up");
    expect(block.querySelector(".qz-cmd-text")?.textContent).toBe("qz up");
    expect(block.querySelector(".qz-cmd-text")?.getAttribute("dir")).toBe("ltr");
    const button = block.querySelector<HTMLButtonElement>(".qz-btn-copy");
    button?.click();
    await vi.waitFor(() => expect(button?.textContent).toBe("已复制"));
    expect(writeText).toHaveBeenCalledWith("qz up");
    expect(button?.classList.contains("is-copied")).toBe(true);
  });

  it("把失败写成一句给人看的话", () => {
    expect(describeError(new DaemonUnreachable("x"))).toBe("联系不上本机的守护进程。");
    expect(describeError(new SeaError("sea_self", "STORAGE_ERROR", "脊柱读不出来。", 200))).toBe(
      "脊柱读不出来。",
    );
    expect(describeError(new SeaError("sea_self", "STORAGE_ERROR", "", 200))).toContain("STORAGE_ERROR");
    expect(describeError(new SeaError("sea_self", "MALFORMED_RESPONSE", "data.x 应为 数字", 200))).toContain(
      "读不懂",
    );
  });
});

describe("读屏播报", () => {
  it("成功走礼貌通道，失败走断言通道，互不串台", () => {
    const announcer = new Announcer();
    expect(announcer.polite.getAttribute("aria-live")).toBe("polite");
    expect(announcer.polite.getAttribute("role")).toBe("status");
    expect(announcer.assertive.getAttribute("aria-live")).toBe("assertive");
    expect(announcer.assertive.getAttribute("role")).toBe("alert");
    announcer.say("已改好这一条。");
    expect(announcer.polite.textContent).toBe("已改好这一条。");
    expect(announcer.assertive.textContent).toBe("");
    announcer.alert("没有改成：口令不对。");
    expect(announcer.assertive.textContent).toBe("没有改成：口令不对。");
    expect(announcer.polite.textContent).toBe("已改好这一条。");
  });

  it("连续两次相同的内容各换一个新的文本节点，读屏会再读一遍", () => {
    const announcer = new Announcer();
    announcer.say("已改好这一条。");
    const first = announcer.polite.firstChild;
    announcer.say("已改好这一条。");
    expect(announcer.polite.firstChild).not.toBe(first);
    expect(announcer.polite.childNodes).toHaveLength(1);
  });
});
