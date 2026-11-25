import { beforeEach, describe, expect, it } from "vitest";
import { LiveRegions } from "../src/a11y/live_regions.js";

describe("双通道 aria-live：礼貌通道只播报流式正文，断言通道只播报工具/审批/错误", () => {
  let doc: Document;
  let regions: LiveRegions;

  beforeEach(() => {
    doc = document.implementation.createHTMLDocument("live");
    regions = new LiveRegions(doc);
    doc.body.append(regions.polite, regions.assertive);
  });

  it("两个活动区域的语义属性符合 WAI-ARIA", () => {
    expect(regions.polite.getAttribute("aria-live")).toBe("polite");
    expect(regions.polite.getAttribute("role")).toBe("status");
    expect(regions.assertive.getAttribute("aria-live")).toBe("assertive");
    expect(regions.assertive.getAttribute("role")).toBe("alert");
    expect(regions.polite.id).not.toBe(regions.assertive.id);
  });

  it("流式 token 只进入礼貌通道且每个 token 恰好一次", () => {
    expect(regions.appendToken("m1", 1, "你")).toBe(true);
    expect(regions.appendToken("m1", 2, "好")).toBe(true);
    expect(regions.appendToken("m1", 3, "！")).toBe(true);
    // 网络抖动重发同一 seq：必须忽略，绝不二次播报。
    expect(regions.appendToken("m1", 1, "你")).toBe(false);
    expect(regions.appendToken("m1", 2, "好")).toBe(false);
    expect(regions.polite.textContent).toBe("你好！");
    expect(regions.assertive.textContent).toBe("");
  });

  it("工具、审批、错误事件只进入断言通道", () => {
    regions.announceEvent("tool", { id: "t1", title: "读取群组产物" });
    regions.announceEvent("approval", { id: "a1", title: "是否允许外发？" });
    regions.announceEvent("error", { id: "e1", title: "守护进程暂时离线" });
    const assertive = regions.assertive.textContent ?? "";
    expect(assertive).toContain("读取群组产物");
    expect(assertive).toContain("是否允许外发？");
    expect(assertive).toContain("守护进程暂时离线");
    expect(regions.polite.textContent).toBe("");
  });

  it("同一 token 文本绝不会同时出现在两个通道", () => {
    const tokens = ["羽", "蛇", "神"];
    tokens.forEach((token, index) => regions.appendToken("m2", index + 1, token));
    regions.announceEvent("tool", { id: "t2", title: "工具卡片" });
    const polite = regions.polite.textContent ?? "";
    const assertive = regions.assertive.textContent ?? "";
    for (const token of tokens) {
      const inPolite = polite.includes(token);
      const inAssertive = assertive.includes(token);
      expect(inPolite !== inAssertive).toBe(true);
      expect(inPolite).toBe(true);
    }
  });

  it("开始新消息时重置礼貌流缓冲，避免跨消息粘连", () => {
    regions.appendToken("m1", 1, "旧");
    regions.resetStream();
    expect(regions.appendToken("m2", 1, "新")).toBe(true);
    expect(regions.polite.textContent).toBe("新");
  });

  it("事件去重：同一事件 id 不会被重复播报", () => {
    regions.announceEvent("tool", { id: "t9", title: "只播一次" });
    regions.announceEvent("tool", { id: "t9", title: "只播一次" });
    expect((regions.assertive.textContent ?? "").match(/只播一次/g)).toHaveLength(1);
  });

  it("礼貌转录缓冲有上界，长流不会无限增长", () => {
    for (let index = 0; index < 200; index += 1) {
      regions.appendToken("m3", index, "字");
    }
    const text = regions.polite.textContent ?? "";
    expect(text.length).toBeLessThanOrEqual(240);
    expect(text.length).toBeGreaterThan(0);
  });
});
