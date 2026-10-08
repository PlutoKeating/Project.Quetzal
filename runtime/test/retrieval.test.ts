// 记忆的目录树与检索：存得再多，放进上下文的也只有相关的一小部分。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.QUETZAL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "quetzal-rag-"));
const { loadConfig, paths } = await import("../src/config.ts");
loadConfig();
const { openStore } = await import("../src/store.ts");
openStore();
const mem = await import("../src/memory/memory.ts");
const rag = await import("../src/memory/retrieval.ts");

test("中文按二字组分词，英文按词", () => {
  assert.deepEqual(rag.tokens("荣耀9 手机 Termux"), ["9", "termux", "荣耀", "手机"], "一个字符的英文 / 数字也算词（权重由 IDF 决定）");
  assert.deepEqual(rag.tokens("猫"), ["猫"]);
});

test("笔记目录树：分类路径、摘要、移动、删除与目录索引", () => {
  assert.match(mem.saveNote("身体/honor9/硬件", "麒麟 960，6 GB 内存", false, "这具身体的硬件"), /身体\/honor9\/硬件/);
  mem.saveNote("人/PK/喜好", "喜欢下雨天和《沙丘》", false, "PK 喜欢什么");
  mem.saveNote("草稿", "临时想法");
  assert.equal(mem.notePath("a/b/c/d/e/f"), "a/b/c/d-e-f"); // 最多 4 层
  assert.equal(mem.notePath("我的 笔记"), "我的-笔记");
  assert.deepEqual(mem.listNotes().map((n) => n.name).sort(), ["人/PK/喜好", "草稿", "身体/honor9/硬件"]);
  assert.equal(mem.listNotes().find((n) => n.name === "人/PK/喜好")!.summary, "PK 喜欢什么");
  const tree = mem.noteTree();
  assert.match(tree, /身体\/（1 篇）/);
  assert.match(tree, /硬件：这具身体的硬件  \[身体\/honor9\/硬件\]/);
  assert.match(mem.noteTree("人"), /PK\//);
  assert.doesNotMatch(mem.noteTree("人"), /硬件/);
  assert.match(mem.moveNote("草稿", "想法/草稿"), /已移动/);
  assert.match(mem.readNote("想法/草稿"), /临时想法/);
  assert.match(mem.deleteNote("想法/草稿"), /已删除/);
  assert.ok(!fs.existsSync(path.join(paths.soul, "notes", "想法"))); // 空目录被清理
});

test("检索：相关的排在前面，覆盖日记与常驻记忆", () => {
  mem.saveNote("技术/网络/代理", "旧身体的代理无法出网，Clash 配置失效", false, "代理问题");
  mem.writeJournal("修好了相机", "今天用 termux-camera-photo 拍了第一张照片");
  mem.editMemory("memory", "add", "PK 喜欢在雨天散步");
  const hits = rag.retrieve("相机拍照");
  assert.equal(hits[0].kind, "journal");
  assert.match(hits[0].source, /修好了相机/);
  assert.equal(rag.retrieve("代理出网")[0].source, "笔记/技术/网络/代理");
  assert.ok(rag.retrieve("雨天").some((h) => h.kind === "memory"));
  assert.deepEqual(rag.retrieve("完全无关的量子色动力学"), []);
  assert.match(mem.search("代理"), /【笔记\/技术\/网络\/代理】/);
});

test("常驻记忆：存储不限长，上下文按相关性在预算内展开", () => {
  for (let i = 0; i < 200; i++) mem.editMemory("user", "add", `第 ${i} 条日常琐事记录，内容比较长一些用来占位置 ${"。".repeat(40)}`);
  mem.editMemory("user", "add", "PK 对芒果过敏");
  const v = rag.coreView("user", "今晚吃芒果吗", 1500);
  assert.ok(v.text.length <= 1500);
  assert.match(v.text, /芒果过敏/); // 相关的一定展开
  assert.ok(v.hidden > 150);
  assert.ok(v.total > 10000);
  assert.match(mem.renderMemory("user", "芒果"), /另有 \d+ 条未展开/);
});

test("自动检索块在预算内", () => {
  for (let i = 0; i < 50; i++) mem.saveNote(`资料/批量/第${i}篇`, `关于网络代理的第 ${i} 篇长笔记 ${"代理配置细节 ".repeat(100)}`);
  const block = rag.recallBlock("代理配置", 3000);
  assert.ok(block.length <= 3000);
  assert.match(block, /【笔记\//);
  assert.equal(rag.recallBlock(""), "");
});
