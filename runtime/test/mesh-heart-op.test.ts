// 网状层的心脏操作入口（mesh/heart-op.ts）：别处转来的心脏操作（heart.op）先校验形状再落到心脏。
// 对方是可信的身体，但一条出错或被攻破的身体转来的数据不能写坏这里的心脏：不认识的 op、写错的参数类型、
// 未知的驱动力键、非有限数、参数过多都丢弃；合格的照常应用（nudge / experience / openLoops / personality）。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.QUETZAL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "quetzal-heart-op-"));
const cfg = await import("../src/config.ts");
cfg.loadConfig();
cfg.saveConfig({ body: "handset" });
const store = await import("../src/store.ts");
store.openStore();
const heart = await import("../src/heart/heart.ts");
const { HEART_OPS, heartOpOk, applyHeartOpRemote } = await import("../src/mesh/heart-op.ts");

const social = () => heart.snapshot().drives.social;
const unconsolidated = () => heart.snapshot().unconsolidated;

test("白名单：只认跟随者会转来的四种心脏操作", () => {
  assert.deepEqual([...HEART_OPS].sort(), ["experience", "nudge", "openLoops", "personality"]);
  assert.ok(heartOpOk("nudge", ["被拿起", {}]));
  for (const op of ["", "sleep", "wake", "heartState", "adoptHeart", null, 42, {}]) assert.ok(!heartOpOk(op as unknown, []), String(op));
});

test("nudge：合格的落到心脏；drives 里未知的键、非有限数、写错的类型都丢弃", () => {
  const before = social();
  assert.equal(applyHeartOpRemote("nudge", ["被拿起", { social: 0.3 }]), true);
  assert.ok(social() > before + 0.2, `应用后想念应当升高，实际 ${social()}`);
  const after = social();
  // 丢弃的：都不改变心脏，也不抛错
  assert.equal(applyHeartOpRemote("nudge", ["坏", { social: 0.3, 未知: 1 }]), false);      // 未知的驱动力键
  assert.equal(applyHeartOpRemote("nudge", ["坏", { social: "0.3" }]), false);              // 值不是数
  assert.equal(applyHeartOpRemote("nudge", ["坏", { social: NaN }]), false);                // 非有限数
  assert.equal(applyHeartOpRemote("nudge", ["坏", []]), false);                             // drives 是数组
  assert.equal(applyHeartOpRemote("nudge", [42, { social: 0.3 }]), false);                  // reason 不是文字
  assert.equal(applyHeartOpRemote("nudge", ["坏", { social: 0.3 }, []]), false);            // opts 是数组
  assert.equal(applyHeartOpRemote("nudge", ["坏", { social: 0.3 }, {}, 1, 2, 3]), false);    // 参数过多
  assert.ok(Math.abs(social() - after) < 1e-3, `不合格的操作不改动心脏（${after} → ${social()}）`);
  // 只有 reason、没有 drives / opts 也合格（感觉事件就是这么发的）
  assert.equal(applyHeartOpRemote("nudge", ["光线变化"]), true);
});

test("experience / openLoops：有限的非负数；负数、NaN、文字丢弃", () => {
  const n = unconsolidated();
  assert.equal(applyHeartOpRemote("experience", [2]), true);
  assert.equal(unconsolidated(), n + 2);
  assert.equal(applyHeartOpRemote("experience", [-1]), false);
  assert.equal(applyHeartOpRemote("experience", [Infinity]), false);
  assert.equal(applyHeartOpRemote("experience", ["2"]), false);
  assert.equal(unconsolidated(), n + 2, "丢弃的不计数");
  assert.equal(applyHeartOpRemote("openLoops", [3]), true);
  assert.equal(applyHeartOpRemote("openLoops", [-3]), false);
});

test("personality：对象才收（键与范围由心脏再收窄）；数组、文字丢弃", () => {
  assert.equal(applyHeartOpRemote("personality", [{ gamma: 3 }]), true);
  assert.equal(heart.snapshot().personality.gamma, 3);
  assert.equal(applyHeartOpRemote("personality", [[]]), false);
  assert.equal(applyHeartOpRemote("personality", ["gamma=9"]), false);
  assert.equal(heart.snapshot().personality.gamma, 3, "丢弃的不改动性格");
  // 越界的值由心脏收窄（不是丢弃）：gamma 上限 4
  assert.equal(applyHeartOpRemote("personality", [{ gamma: 99 }]), true);
  assert.equal(heart.snapshot().personality.gamma, 4);
});

test("参数不是数组时按空参数处理，不当成崩溃", () => {
  assert.equal(applyHeartOpRemote("experience", undefined as unknown as unknown[]), true);
  assert.equal(applyHeartOpRemote("nudge", undefined as unknown as unknown[]), false); // nudge 缺 reason：丢弃
  assert.equal(applyHeartOpRemote("heart.op", []), false);
});
