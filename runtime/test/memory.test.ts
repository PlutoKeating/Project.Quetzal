import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.QUETZAL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "quetzal-test-"));
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
  assert.match(mem.editMemory("user", "add", "x".repeat(50_000)), /已添加/); // 没有长度上限
  assert.equal(mem.entries("user")[0].length, 50_000);
  assert.match(mem.renderMemory("user"), /另有 1 条未展开，全部共 50003 字/); // 存储不限长，上下文有预算
});

test("条目级三方合并：双方新增都保留，任一方删除即删除", () => {
  const base = mem.joinEntries(["A", "B", "C"]);
  const ours = mem.joinEntries(["A", "C", "D"]); // 删 B，加 D
  const theirs = mem.joinEntries(["A", "B", "C", "E"]); // 加 E
  assert.deepEqual(mem.parseEntries(mergeEntries(base, ours, theirs)), ["A", "C", "D", "E"]);
});

test("日记与检索（规范目录中的 .gitkeep 不影响列举）", () => {
  fs.mkdirSync(path.join(process.env.QUETZAL_HOME!, "soul", "journal"), { recursive: true });
  fs.writeFileSync(path.join(process.env.QUETZAL_HOME!, "soul", "journal", ".gitkeep"), "");
  mem.writeJournal("看星星", "今晚猎户座很亮");
  mem.saveNote("天文", "猎户座在冬季最明显");
  assert.match(mem.search("猎户座"), /笔记\/天文/);
});

test("想分享的一句话：写入、规范化空白、空内容不覆盖", async () => {
  (await import("../src/store.ts")).openStore();
  assert.equal(mem.thought(), null);
  assert.match(mem.setThought("  最近在想：\n记忆 是不是 一种 地图？ "), /已更新/);
  assert.equal(mem.thought()!.text, "最近在想： 记忆 是不是 一种 地图？");
  assert.match(mem.setThought("   "), /内容为空/);
  assert.equal(mem.thought()!.text, "最近在想： 记忆 是不是 一种 地图？");
});

test("想分享的一句话：别处来的按写下的时刻后写胜，不合格的不收；本机更新时通知网状层", async () => {
  const { bus } = await import("../src/bus.ts");
  const sent: string[][] = [];
  const on = (s: string[]) => sent.push(s);
  bus.on("shared", on);
  mem.setThought("本机的一句");
  bus.off("shared", on);
  assert.deepEqual(sent, [["thought"]]);
  const mine = mem.thought()!;
  assert.equal(mem.mergeThought({ text: "更旧的", ts: mine.ts - 1000 }), false);
  assert.equal(mem.thought()!.text, "本机的一句");
  assert.equal(mem.mergeThought({ text: "别处的\u0000  新一句", ts: mine.ts + 1000 }), true);
  assert.deepEqual(mem.thought(), { text: "别处的 新一句", ts: mine.ts + 1000 });
  assert.equal(mem.mergeThought({ text: "别处的 新一句", ts: mine.ts + 1000 }), false); // 同一句不算变化
  // 相同时刻按文字比较：两边各自采用后收敛到同一句
  assert.equal(mem.mergeThought({ text: "别处的 新一句A", ts: mine.ts + 1000 }), true);
  assert.equal(mem.mergeThought({ text: "别处的", ts: mine.ts + 1000 }), false);
  // 不合格：时刻在未来、不是数字、文字为空或不是文字
  assert.equal(mem.mergeThought({ text: "未来的", ts: Date.now() + 3_600_000 }), false);
  assert.equal(mem.mergeThought({ text: "没有时刻" }), false);
  assert.equal(mem.mergeThought({ text: "   ", ts: Date.now() }), false);
  assert.equal(mem.mergeThought({ text: 42, ts: Date.now() }), false);
  assert.equal(mem.mergeThought(null), false);
  assert.equal(mem.mergeThought({ text: "x".repeat(500), ts: Date.now() + 60_000 }), true);
  assert.equal(mem.thought()!.text.length, 120);
});
