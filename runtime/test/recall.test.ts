import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.QUETZAL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "quetzal-test-"));
const cfg = await import("../src/config.ts");
cfg.loadConfig();
cfg.saveConfig({ timezone: "Asia/Shanghai" });
const store = await import("../src/store.ts");
store.openStore();
const mem = await import("../src/memory/memory.ts");
const idx = await import("../src/memory/index.ts");
const { epoch } = await import("../src/time/zone.ts");

const SH = "Asia/Shanghai";
/** 直接写一条带指定时刻的对话（addMessage 只用当前时刻）。 */
let seq = 1;
function say(session: string, role: "user" | "agent", text: string, ts: number) {
  store.ensureSession(session, session === "s1" ? "周末出行" : "日常", "控制台");
  store.db.prepare("INSERT INTO messages(id,ts,role,channel,text,session,body) VALUES(?,?,?,?,?,?,?)").run(seq++, ts, role, "控制台", text, session, "test");
}

say("s1", "user", "上周去上海出差，吃了一家很好吃的小笼包", epoch(2026, 9, 30, 20, 0, SH));
say("s1", "agent", "听起来不错！是哪一家？", epoch(2026, 9, 30, 20, 1, SH));
say("s1", "user", "在城隍庙旁边，下次带你去", epoch(2026, 9, 30, 20, 2, SH));
say("s2", "user", "提醒我饭后吃药", epoch(2026, 10, 6, 12, 0, SH));
say("s2", "user", "I booked the dentist for next Friday", epoch(2026, 10, 6, 13, 0, SH));
say("s2", "agent", "好", epoch(2026, 10, 6, 13, 1, SH));

test("FTS5 可用（Node 22.16+ / 24 自带）", () => assert.equal(idx.ensureIndex(), true));

test("对话能检索到：ICU 整词、两个字的词、英文；带会话名、时刻与前后各一句", () => {
  const r = mem.search("小笼包");
  assert.match(r, /会话「周末出行」/);
  assert.match(r, /2026\/09\/30/);
  assert.match(r, /→ 对方：上周去上海出差/);
  assert.match(r, /我：听起来不错/, "带后一句");
  assert.match(mem.search("吃药"), /饭后吃药/);
  assert.match(mem.search("dentist"), /booked the dentist/);
});

test("时间段：只看那段时间；只给时间不给词时按时间列出", () => {
  const lastWeek = { from: epoch(2026, 9, 28, 0, 0, SH), to: epoch(2026, 10, 5, 0, 0, SH) };
  assert.match(mem.search("小笼包", lastWeek), /小笼包/);
  assert.equal(mem.search("吃药", lastWeek), "没有找到相关记忆");
  const listed = mem.search("", { from: epoch(2026, 10, 6, 0, 0, SH), to: epoch(2026, 10, 7, 0, 0, SH) });
  assert.match(listed, /dentist/);
  assert.match(listed, /饭后吃药/);
  assert.doesNotMatch(listed, /小笼包/);
});

test("新的对话不用重建索引：检索前自动补进去（本机写入与别处复制来的都算）", () => {
  store.addMessage("user", "控制台", "我养了一只叫团子的猫", { session: "s2" });
  assert.match(mem.search("团子"), /叫团子的猫/);
  store.applyRemote("messages", [{ id: store.idPrefixOf("phone") * store.ID_RANGE + 7, ts: Date.now(), role: "user", channel: "飞书", text: "别处说的：喜欢吃榴莲", session: "s2", body: "phone" }], { from: "phone" });
  assert.match(mem.search("榴莲"), /喜欢吃榴莲/);
});

test("笔记与日记也在同一个索引里，日记按那一段的时刻过滤", () => {
  mem.saveNote("人/对方/口味", "# 口味\n\n喜欢辣，不吃香菜。");
  assert.match(mem.search("香菜"), /笔记\/人\/对方\/口味/);
  mem.writeJournal("在想猫", "今天想到团子会不会冷。", epoch(2026, 10, 1, 9, 30, SH));
  assert.match(mem.search("团子", { from: epoch(2026, 10, 1, 0, 0, SH), to: epoch(2026, 10, 2, 0, 0, SH), kinds: ["journal"] }), /团子会不会冷/);
  assert.equal(mem.search("团子", { from: epoch(2026, 10, 2, 0, 0, SH), to: epoch(2026, 10, 3, 0, 0, SH), kinds: ["journal"] }), "没有找到相关记忆");
});
