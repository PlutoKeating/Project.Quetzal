import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LiveRegions } from "../src/a11y/live_regions.js";

describe("礼貌通道按标点/空闲刷写，避免逐 token 朗读", () => {
  let doc: Document;
  let regions: LiveRegions;

  beforeEach(() => {
    vi.useFakeTimers();
    doc = document.implementation.createHTMLDocument("flush");
    regions = new LiveRegions(doc);
    doc.body.append(regions.polite, regions.assertive);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("无标点时进入缓冲，空闲 250ms 后一次性刷出", () => {
    expect(regions.appendToken("m1", 1, "你")).toBe(true);
    expect(regions.appendToken("m1", 2, "好")).toBe(true);
    expect(regions.polite.textContent).toBe("");
    vi.advanceTimersByTime(249);
    expect(regions.polite.textContent).toBe("");
    vi.advanceTimersByTime(2);
    expect(regions.polite.textContent).toBe("你好");
  });

  it("句读标点立即刷出整句", () => {
    regions.appendToken("m1", 1, "你");
    regions.appendToken("m1", 2, "好");
    regions.appendToken("m1", 3, "。");
    expect(regions.polite.textContent).toBe("你好。");
    vi.advanceTimersByTime(1000);
    expect(regions.polite.textContent).toBe("你好。");
  });

  it("新消息 resetStream 会丢弃未刷出的缓冲", () => {
    regions.appendToken("m1", 1, "半句");
    regions.resetStream();
    vi.advanceTimersByTime(1000);
    expect(regions.polite.textContent).toBe("");
    regions.appendToken("m2", 1, "新句。");
    expect(regions.polite.textContent).toBe("新句。");
  });

  it("状态播报共享 240 字符窗口，不会无限增长", () => {
    for (let index = 0; index < 40; index += 1) {
      regions.announceStatus(`第${index}条状态提醒`);
    }
    const text = regions.polite.textContent ?? "";
    expect(text.length).toBeGreaterThan(0);
    expect(text.length).toBeLessThanOrEqual(240);
    expect(text).toContain("第39条状态提醒");
  });

  it("重复 seq 不会进入缓冲，也不会二次刷出", () => {
    regions.appendToken("m1", 1, "重");
    expect(regions.appendToken("m1", 1, "重")).toBe(false);
    regions.appendToken("m1", 2, "。");
    expect(regions.polite.textContent).toBe("重。");
  });
});
