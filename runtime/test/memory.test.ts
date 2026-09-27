import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AMANI_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "amani-test-"));
const { loadConfig } = await import("../src/config.ts");
loadConfig();
const mem = await import("../src/memory/memory.ts");
const { mergeEntries } = await import("../src/memory/soul-sync.ts");

test("记忆条目：add / replace / remove（与 Hermes 语义一致）", () => {
  assert.match(mem.editMemory("memory", "add", "喜欢下雨天"), /已添加/);
  assert.match(mem.editMemory("memory", "add", "在读《沙丘》"), /已添加/);
  assert.match(mem.editMemory("memory", "replace", "在读《沙丘》第二部", "沙丘"), /已更新/);
  assert.deepEqual(mem.entries("memory"), ["喜欢下雨天", "在读《沙丘》第二部"]);
  assert.match(mem.editMemory("memory", "remove", "", "不存在"), /匹配到 0 条/);
  assert.match(mem.editMemory("memory", "remove", "", "下雨"), /已删除/);
  assert.match(mem.editMemory("user", "add", "x".repeat(5000)), /超出上限/);
});

test("条目级三方合并：双方新增都保留，任一方删除即删除", () => {
  const base = mem.joinEntries(["A", "B", "C"]);
  const ours = mem.joinEntries(["A", "C", "D"]); // 删 B，加 D
  const theirs = mem.joinEntries(["A", "B", "C", "E"]); // 加 E
  assert.deepEqual(mem.parseEntries(mergeEntries(base, ours, theirs)), ["A", "C", "D", "E"]);
});

test("日记与检索（规范目录中的 .gitkeep 不影响列举）", () => {
  fs.mkdirSync(path.join(process.env.AMANI_HOME!, "soul", "journal"), { recursive: true });
  fs.writeFileSync(path.join(process.env.AMANI_HOME!, "soul", "journal", ".gitkeep"), "");
  mem.writeJournal("看星星", "今晚猎户座很亮");
  mem.saveNote("天文", "猎户座在冬季最明显");
  assert.match(mem.search("猎户座"), /笔记\/天文/);
});
