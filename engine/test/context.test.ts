import test from "node:test";
import assert from "node:assert/strict";
import { selectCoreEntries, formatRecallBlock } from "../src/index.ts";

test("常驻预算使用 UTF-16 和每条分隔成本，空列表及整列表保持原格式", () => {
  assert.deepEqual(selectCoreEntries([], "", 0), { text: "", hidden: 0, total: 0 });
  assert.deepEqual(selectCoreEntries(["😀", "猫"], "", 9), { text: "😀\n§\n猫", hidden: 0, total: 9 });
  assert.deepEqual(selectCoreEntries(["😀"], "", 4), { text: "", hidden: 1, total: 5 });
});

test("相关条目先选，其余从末尾补足，最后仍按原顺序输出", () => {
  const entries = ["alpha", "older", "newer"];
  assert.deepEqual(selectCoreEntries(entries, "alpha", 16), { text: "alpha\n§\nnewer", hidden: 1, total: 24 });
  assert.deepEqual(selectCoreEntries(entries, "", 16), { text: "older\n§\nnewer", hidden: 1, total: 24 });
  assert.deepEqual(entries, ["alpha", "older", "newer"]);
});

test("整条过长跳过而不切片，较短的新近条目仍可补入", () => {
  assert.deepEqual(selectCoreEntries(["alpha".repeat(10), "cat"], "alpha", 8), { text: "cat", hidden: 1, total: 59 });
});

test("召回片段计入来源标签，跳过过大候选，连接空行保持原有额外成本", () => {
  const hits = [{ source: "a", excerpt: "x".repeat(50) }, { source: "b", excerpt: "ok" }, { source: "c", excerpt: "hi" }];
  assert.equal(formatRecallBlock(hits, 12), "【b】\nok\n\n【c】\nhi");
  assert.equal(formatRecallBlock(hits, 6), "【b】\nok");
  assert.equal(formatRecallBlock(hits, 0), "");
});
