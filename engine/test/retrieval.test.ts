import test from "node:test";
import assert from "node:assert/strict";
import { tokens, rank, excerptOf, type RetrievalDoc } from "../src/index.ts";

const now = 1_800_000_000_000;
const doc = (source: string, text: string, title = "", mtime = 0): RetrievalDoc => ({ kind: "note", source, text, title, mtime });

test("英文数字保留单字符与大小写归一，中文支持二字组和单字", () => {
  assert.deepEqual(tokens("C R 9 Termux 手机 猫"), ["c", "r", "9", "termux", "手机", "猫"]);
  assert.ok(tokens("上下文管理").includes("上下"));
  assert.equal(tokens("上下文管理").includes("理"), false);
  assert.deepEqual(tokens(""), []);
});

test("完整查询覆盖优先于单词局部命中，无关文档不进入候选", () => {
  const docs = [doc("partial", "alpha alpha alpha"), doc("full", "alpha beta"), doc("none", "gamma")];
  const before = structuredClone(docs);
  const hits = rank("alpha beta", docs, now);
  assert.deepEqual(hits.map((h) => h.source), ["full", "partial"]);
  assert.deepEqual(docs, before);
  assert.deepEqual(rank("", docs, now), []);
  assert.deepEqual(rank("delta", docs, now), []);
});

test("标题命中与新近加分保留，时间显式提供使评分可重复", () => {
  const hits = rank("alpha", [doc("old", "alpha", "", now - 90 * 86_400_000), doc("new", "alpha", "", now)], now);
  assert.deepEqual(hits.map((h) => h.source), ["new", "old"]);
  assert.equal(hits[0].score / hits[1].score, 1.2 / (1 + 0.2 * Math.exp(-3)));
  const titleHits = rank("alpha", [doc("body", "alpha"), doc("title", "alpha", "alpha")], now);
  assert.equal(titleHits[0].source, "title");
  assert.deepEqual(rank("alpha", [doc("same", "alpha")], now), rank("alpha", [doc("same", "alpha")], now + 86_400_000));
});

test("短摘录原样去空白，长摘录围绕关键词截取并标记省略", () => {
  assert.equal(excerptOf("  alpha  ", "alpha"), "alpha");
  const text = "x".repeat(700) + " alpha " + "y".repeat(700);
  const excerpt = excerptOf(text, "alpha");
  assert.ok(excerpt.startsWith("…")); assert.ok(excerpt.endsWith("…"));
  assert.match(excerpt, /alpha/); assert.equal(excerpt.length, 502);
  assert.equal(rank("alpha", [doc("long", text)], now)[0].excerpt, excerpt);
});
