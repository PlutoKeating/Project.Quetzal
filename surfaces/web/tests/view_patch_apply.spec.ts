import { describe, expect, it } from "vitest";
import {
  PatchSequenceError,
  ViewStateModel,
  isLayerVisible,
  type ViewPatch,
} from "../src/model/state.js";

const row = (key: string, summary: string, rev = 1) => ({
  key,
  kind: "message",
  summary,
  detail: `detail:${summary}`,
  raw_json: `{"summary":"${summary}"}`,
  updated_rev: rev,
});

const patch = (
  from: number,
  to: number,
  ops: ViewPatch["ops"],
  density: ViewPatch["density"] = "workbench",
): ViewPatch => ({ from_rev: from, to_rev: to, density, ops });

describe("ViewStateModel：补丁幂等重放", () => {
  it("同一补丁重发不改变状态且报告 duplicate", () => {
    const model = new ViewStateModel();
    const p1 = patch(0, 1, [{ op: "upsert", row: row("m1", "你好") }]);
    expect(model.apply(p1)).toBe("applied");
    const afterFirst = model.snapshot();
    expect(model.apply(p1)).toBe("duplicate");
    expect(model.snapshot()).toEqual(afterFirst);
    expect(model.visibleRows()).toHaveLength(1);
  });

  it("乱序补丁显式抛错而不是部分合并", () => {
    const model = new ViewStateModel();
    model.apply(patch(0, 3, [{ op: "upsert", row: row("a", "A") }]));
    const stale = patch(1, 2, [{ op: "upsert", row: row("b", "B") }]);
    let caught: unknown;
    try {
      model.apply(stale);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PatchSequenceError);
    expect((caught as PatchSequenceError).code).toBe("OUT_OF_SEQUENCE");
    expect(model.rows().has("b")).toBe(false);
    expect(model.rev).toBe(3);
  });

  it("快照重建与补丁重放得到逐字节一致的行集合", () => {
    const rebuilt = new ViewStateModel();
    rebuilt.replace({
      rev: 7,
      density: "workbench",
      rows: { m1: row("m1", "你好", 5), m2: row("m2", "世界", 7) },
    });
    const replayed = new ViewStateModel();
    replayed.replace({ rev: 0, density: "workbench", rows: {} });
    replayed.apply(patch(0, 5, [{ op: "upsert", row: row("m1", "你好", 5) }]));
    replayed.apply(
      patch(5, 7, [
        { op: "upsert", row: row("m2", "世界", 7) },
        { op: "upsert", row: row("tmp", "临时", 7) },
        { op: "remove", key: "tmp" },
      ]),
    );
    expect(replayed.snapshot()).toEqual(rebuilt.snapshot());
  });

  it("非法修订区间被拒绝", () => {
    const model = new ViewStateModel();
    expect(() => model.apply(patch(5, 4, []))).toThrow(PatchSequenceError);
  });
});

describe("ViewStateModel：三档披露层级严格嵌套", () => {
  it("companion 只披露摘要，workbench 追加 detail，inspector 追加 raw", () => {
    const model = new ViewStateModel();
    model.replace({
      rev: 1,
      density: "companion",
      rows: { a: row("a", "摘要", 1) },
    });
    const companion = model.visibleRows();
    expect(companion[0]?.detail).toBeUndefined();
    expect(companion[0]?.raw_json).toBeUndefined();

    model.setDensity("workbench");
    expect(model.visibleRows()[0]?.detail).toBe("detail:摘要");
    expect(model.visibleRows()[0]?.raw_json).toBeUndefined();

    model.setDensity("inspector");
    expect(model.visibleRows()[0]?.raw_json).toContain("摘要");
  });

  it("层级可见性函数与状态机一致", () => {
    expect(isLayerVisible("companion", "summary")).toBe(true);
    expect(isLayerVisible("companion", "detail")).toBe(false);
    expect(isLayerVisible("workbench", "detail")).toBe(true);
    expect(isLayerVisible("workbench", "raw")).toBe(false);
    expect(isLayerVisible("inspector", "raw")).toBe(true);
  });
});
