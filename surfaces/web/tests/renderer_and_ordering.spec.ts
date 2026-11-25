import { describe, expect, it } from "vitest";
import { compareCodeUnits } from "../src/model/state.js";
import { h } from "../src/render/dom.js";

describe("确定性码元序（替代 localeCompare）", () => {
  it("按 UTF-16 码元而非宿主区域设置排序", () => {
    const values = ["ä", "z", "A", "a", "Z"];
    expect([...values].sort(compareCodeUnits)).toEqual(["A", "Z", "a", "z", "ä"]);
    expect(compareCodeUnits("A", "a")).toBeLessThan(0);
    expect(compareCodeUnits("a", "a")).toBe(0);
    expect(compareCodeUnits("z", "A")).toBeGreaterThan(0);
  });
});

describe("原生渲染器布尔属性", () => {
  it("aria-* 的 false 必须写出字符串 false，而不是被丢弃", () => {
    const button = h("button", {
      type: "button",
      "aria-pressed": false,
      "aria-hidden": false,
      hidden: false,
      disabled: false,
    });
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(button.getAttribute("aria-hidden")).toBe("false");
    expect(button.hasAttribute("hidden")).toBe(false);
    expect(button.hasAttribute("disabled")).toBe(false);
  });

  it("构造函数必须能表达 aria-label 等字符串属性", () => {
    const button = h("button", { "aria-label": "发送", "aria-live": "polite" }, "发送");
    expect(button.getAttribute("aria-label")).toBe("发送");
    expect(button.getAttribute("aria-live")).toBe("polite");
    expect(button.textContent).toBe("发送");
  });
});
