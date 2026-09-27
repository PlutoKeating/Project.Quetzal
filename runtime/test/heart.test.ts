import { test } from "node:test";
import assert from "node:assert/strict";
import * as M from "../src/heart/model.ts";

const p = M.defaultPersonality;
const H = 3_600_000;

test("醒着时睡眠压力上升，睡着时回落", () => {
  const s0 = { ...M.initialState(0), S: 0.2 };
  const awake = M.advance(s0, 8 * H, p);
  assert.ok(awake.S > 0.4);
  const asleep = M.advance({ ...awake, mode: "asleep" }, 16 * H, p);
  assert.ok(asleep.S < awake.S / 2);
});

test("昼夜节律：下午最清醒，凌晨最困", () => {
  assert.ok(M.circadian(16, p) > 0.99);
  assert.ok(M.circadian(4, p) < 0.01);
  assert.ok(M.circadian(2, p, 500) > M.circadian(2, p)); // 夜里强光更精神
});

test("一天的自然节律：白天醒着、夜里入睡、清晨自然醒（无任何定时）", () => {
  let s: M.HeartState = { ...M.initialState(0), S: 0.1 };
  const log: string[] = [];
  for (let m = 7 * 60; m < 7 * 60 + 48 * 60; m += 10) {
    const t = m * 60_000;
    s = M.advance(s, t, p);
    const sl = M.sleepiness(s, M.circadian((m / 60) % 24, p));
    if (s.mode === "awake" && sl > p.sleepAt) { s.mode = "asleep"; log.push(`sleep@${((m / 60) % 24).toFixed(1)}`); }
    else if (s.mode === "asleep" && sl < p.wakeAt) { s.mode = "awake"; log.push(`wake@${((m / 60) % 24).toFixed(1)}`); }
  }
  const sleeps = log.filter((x) => x.startsWith("sleep")).map((x) => Number(x.split("@")[1]));
  const wakes = log.filter((x) => x.startsWith("wake")).map((x) => Number(x.split("@")[1]));
  assert.ok(sleeps.length >= 1 && wakes.length >= 1, log.join(" "));
  assert.ok(sleeps.every((h) => h >= 20 || h < 3), `入睡时刻 ${sleeps}`);
  assert.ok(wakes.every((h) => h >= 4 && h < 12), `醒来时刻 ${wakes}`);
});

test("驱动力越强、越清醒，醒来率越高；抑制为 0 时不会醒", () => {
  const low = { ...M.initialState(0), drives: { curiosity: 0.1, expression: 0.1, social: 0.1, openLoops: 0 } };
  const high = { ...low, drives: { curiosity: 0.9, expression: 0.8, social: 0.7, openLoops: 0.5 } };
  assert.ok(M.hazard(high, 0.8, p, 4, 1) > 5 * M.hazard(low, 0.8, p, 4, 1));
  assert.equal(M.hazard(high, 0.8, p, 4, 0), 0);
});

test("醒来间隔没有固定周期", () => {
  const xs = Array.from({ length: 200 }, () => M.expSample(2));
  const mean = xs.reduce((a, b) => a + b) / xs.length;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
  assert.ok(sd / mean > 0.6); // 指数分布的变异系数约为 1
});
