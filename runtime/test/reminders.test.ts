import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.QUETZAL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "quetzal-test-"));
const cfg = await import("../src/config.ts");
cfg.loadConfig();
cfg.saveConfig({ timezone: "Asia/Shanghai" });
const { openStore } = await import("../src/store.ts");
openStore();
const R = await import("../src/time/reminders.ts");
const { epoch } = await import("../src/time/zone.ts");

const SH = "Asia/Shanghai";
const at = (y: number, m: number, d: number, h = 0, mi = 0, tz = SH) => epoch(y, m, d, h, mi, tz);

test("下一次（croner）：每天、工作日、每周几、每月 31 号跳过小月；截止之后没有下一次", () => {
  const now = at(2026, 10, 7, 9, 0); // 周三 09:00
  const n = (cron: string, after = now, until?: number) => R.nextOf({ cron, tz: SH, until }, after);
  assert.equal(n("0 8 * * *"), at(2026, 10, 8, 8, 0));
  assert.equal(n("30 21 * * *"), at(2026, 10, 7, 21, 30));
  assert.equal(n("0 8 * * 1-5", at(2026, 10, 9, 9, 0)), at(2026, 10, 12, 8, 0)); // 周五之后是下周一
  assert.equal(n("0 9 * * 1,5"), at(2026, 10, 9, 9, 0));
  assert.equal(n("0 10 31 * *", at(2026, 11, 1, 0, 0)), at(2026, 12, 31, 10, 0));
  assert.equal(n("0 8 * * *", now, at(2026, 10, 7, 23, 0)), undefined);
  assert.deepEqual(R.upcoming({ at: at(2026, 10, 12, 9, 0), cron: "0 9 * * 1", tz: SH }).map((t) => R.when(t, SH)), ["10月12日（周一）09:00", "10月19日（周一）09:00", "10月26日（周一）09:00"]);
});

test("夏令时：按当地钟点排", () => {
  const ny = "America/New_York";
  const t = R.nextOf({ cron: "0 9 * * *", tz: ny }, epoch(2026, 3, 7, 12, 0, ny))!;
  assert.equal(new Date(t).toISOString(), "2026-03-08T13:00:00.000Z"); // 夏令时第一天的 9 点是 UTC 13 点
});

test("常见规则换成人话，认不出的原样给出", () => {
  assert.equal(R.cronText("0 9 * * 1"), "每周一 09:00");
  assert.equal(R.cronText("30 7 * * 1-5"), "每个工作日 07:30");
  assert.equal(R.cronText("0 20 * * *"), "每天 20:00");
  assert.equal(R.cronText("0 10 1 * *"), "每月 1 号 10:00");
  assert.equal(R.cronText("0 0 14 2 *"), "每年 2 月 14 日 00:00");
  assert.equal(R.cronText("*/15 * * * *"), "按规则「*/15 * * * *」");
});

test("新建、描述、取消；时间已过去的一次性提醒不收", () => {
  const now = at(2026, 10, 7, 9, 0);
  const r = R.add({ text: "吃药", at: at(2026, 10, 8, 8, 0), by: "agent" }, now);
  assert.equal(R.describe(r), "10月8日（周四）08:00");
  const w = R.add({ text: "开周会", cron: "0 9 * * 1", by: "agent" }, now);
  assert.equal(R.describe(w), "每周一 09:00（下一次 10月12日（周一）09:00）");
  assert.throws(() => R.add({ text: "过去", at: now - 3_600_000, by: "agent" }, now), /已经过去/);
  assert.throws(() => R.add({ text: "坏规则", cron: "0 25 * * *", by: "agent" }, now), /不对/);
  assert.throws(() => R.add({ text: "坏规则", cron: "每天八点", by: "agent" }, now), /5 段 cron/);
  R.cancel(r.id.slice(0, 4), now + 1);
  assert.deepEqual(R.active().map((x) => x.text), ["开周会"]);
});

test("到点：交给处理函数；一次性的标为完成，重复的排到下一次；错过 12 小时以上的不提醒", async () => {
  for (const r of R.active()) R.cancel(r.id);
  const now = Date.now();
  const once = R.add({ text: "喝水", at: now + 100, by: "agent" }, now);
  const daily = R.add({ text: "散步", cron: "0 0 * * *", by: "agent" }, now);
  const fired: string[] = [];
  R.startReminders(async (r) => { fired.push(r.text); }, () => true);
  await R._tick(now + 200);
  assert.deepEqual(fired, ["喝水"]);
  assert.equal(R.all().find((x) => x.id === once.id)!.done, true);
  await R._tick(R.all().find((x) => x.id === daily.id)!.at + 13 * 3_600_000);
  assert.deepEqual(fired, ["喝水"], "错过太久的不提醒");
  assert.ok(R.all().find((x) => x.id === daily.id)!.at > Date.now(), "重复的排到了下一次");
});

test("不是持心跳的身体不触发", async () => {
  const now = Date.now();
  R.add({ text: "别处提醒", at: now + 50, by: "agent" }, now);
  const fired: string[] = [];
  R.startReminders(async (r) => { fired.push(r.text); }, () => false);
  await R._tick(now + 100);
  assert.deepEqual(fired, []);
});

test("多具身体：按条目合并，较新的修改为准，墓碑也同步；格式不对的不收", () => {
  const now = Date.now();
  const mine = R.add({ text: "本机的", at: now + 3_600_000, by: "agent" }, now);
  const theirs = { id: "abcdef01", text: "别处的", at: now + 7_200_000, tz: SH, created: now, updated: now, by: "agent" };
  assert.equal(R.merge([theirs, { id: "bad", text: "x" }]), true);
  assert.ok(R.active().some((r) => r.text === "别处的"));
  assert.equal(R.merge([{ ...R.all().find((r) => r.id === mine.id), text: "旧的改动", updated: now - 10 }]), false, "旧的修改不覆盖");
  assert.equal(R.merge([{ ...theirs, deleted: true, updated: now + 1000 }]), true);
  assert.ok(!R.active().some((r) => r.text === "别处的"), "别处删了，这里也删");
});
