// 心脏：维护内驱力与生物钟，用"非齐次泊松过程 + 稀疏化抽样（thinning）"决定下一次醒来。
// 没有任何"每 N 分钟醒一次"或"每天几点做事"的设定：下一次什么时候醒，是按她此刻的内部状态随机抽出来的，
// 任何事件（消息、充电、光线变化……）都会让她立刻按新状态重新抽样。
import { bus } from "../bus.ts";
import { config, paths } from "../config.ts";
import { kv, usageToday, addTimeline } from "../store.ts";
import { body } from "../body/twin.ts";
import { log } from "../log.ts";
import fs from "node:fs";
import * as M from "./model.ts";
import { routes } from "../providers/router.ts";

export type WakeKind = "think" | "dream";
export type WakeHandler = (kind: WakeKind, reason: string) => Promise<{ satisfied?: Partial<M.Drives>; effort?: number } | void>;

const HORIZON_H = 0.25; // 稀疏化的上界有效期：超过这个时长，只重新积分状态、重新抽样，不会醒
let state: M.HeartState;
let personality: M.Personality;
let timer: NodeJS.Timeout | undefined;
let busy = false;
let onWake: WakeHandler = async () => {};
let lastReason = "";
let nextCandidateAt = 0;

// ---------- 一个心智、多具身体（mesh/coordinator.ts）：只有协调者的心脏抽样醒来；其他身体「跟随」——
// 它们的感觉、对话带来的驱动力变化、经历与性格调整都转给协调者，协调者把心脏状态广播回来（换协调者时从最新状态接着跳）。
type HeartOp = "nudge" | "experience" | "openLoops" | "personality";
let follower = false;
let forward: ((op: HeartOp, args: unknown[]) => void) | undefined;
/** 设为跟随（不抽样醒来，操作转给协调者）或恢复为自己跳。 */
export function setFollower(f: boolean, fwd?: (op: HeartOp, args: unknown[]) => void) {
  follower = f; forward = f ? fwd : undefined;
  if (f) { clearTimeout(timer); nextCandidateAt = 0; } else schedule();
  bus.emit("state");
}
export const isFollower = () => follower;
/** 协调者收到其他身体转来的心脏操作。 */
export function applyHeartOp(op: HeartOp, args: unknown[]) {
  if (op === "nudge") nudge(String(args[0] ?? ""), (args[1] ?? {}) as Partial<M.Drives>, (args[2] ?? {}) as { wake?: boolean });
  else if (op === "experience") addExperience(Number(args[0]) || 1);
  else if (op === "openLoops") setOpenLoops(Number(args[0]) || 0);
  else if (op === "personality") adjustPersonality((args[0] ?? {}) as Record<string, number>);
}
/** 导出心脏状态（协调者广播给其他身体）。 */
export function heartState() { ensure(); return { state, personality, lastReason }; }
/**
 * 采用协调者广播的心脏状态。之前自己也在跳（两个分区重新连上）时合并：睡眠压力与待整理的经历取较大值，其余以协调者为准。
 */
export function adoptHeart(h: { state: M.HeartState; personality: M.Personality; lastReason?: string }, merge = false) {
  ensure();
  if (!h?.state || !h.personality) return;
  const next = { ...h.state, drives: { ...h.state.drives } };
  if (merge) { next.S = Math.max(next.S, state.S); next.unconsolidated = Math.max(next.unconsolidated, state.unconsolidated); }
  state = next; personality = { ...M.defaultPersonality, ...h.personality };
  if (h.lastReason) lastReason = h.lastReason;
  kv.set("heart", state); kv.set("personality", personality);
  bus.emit("state");
}

const localHour = (now: number) => {
  const s = new Date(now).toLocaleString("en-US", { timeZone: config.timezone, hour12: false, hour: "numeric", minute: "numeric" });
  const [h, m] = s.split(":").map(Number);
  return (h % 24) + m / 60;
};
const persist = () => { kv.set("heart", state); kv.set("personality", personality); bus.emit("heart"); };
export const stopped = () => fs.existsSync(paths.stop);

/** 身体与闸门的抑制系数。 */
function inhibition(): { k: number; why: string[] } {
  const why: string[] = [];
  let k = config.heart.activity;
  if (stopped()) return { k: 0, why: ["急停"] };
  if (config.heart.paused) return { k: 0, why: ["自主已暂停"] };
  if (!routes().length) return { k: 0, why: ["尚未配置模型"] };
  const bat = body.raw.battery;
  if (bat && (bat.tempC ?? 0) >= config.budget.maxTempC) { k *= 0.1; why.push("过热"); }
  if (bat && bat.level < config.budget.minBattery && !bat.charging) { k *= 0.2; why.push("电量低"); }
  if (!body.online) { k *= 0.5; why.push("离线"); }
  const u = usageToday();
  if (u.tokens >= config.budget.dailyTokens || (config.budget.dailyCostUsd > 0 && u.cost >= config.budget.dailyCostUsd)) { k *= 0.05; why.push("预算用尽"); }
  return { k, why };
}

function integrate(now = Date.now()) {
  state = M.advance(state, now, personality);
  const c = M.circadian(localHour(now), personality, body.raw.lux);
  const sl = M.sleepiness(state, c);
  if (state.mode === "awake" && sl > personality.sleepAt && !busy) {
    state.mode = "asleep";
    addTimeline("sleep", "困了，睡着了", { S: state.S, C: c });
  } else if (state.mode === "asleep" && sl < personality.wakeAt) {
    state.mode = "awake";
    addTimeline("wake", "自然醒了", { S: state.S, C: c });
    lastReason = "自然醒来";
  }
  persist();
  return c;
}

function ensure() {
  if (state) return;
  state = kv.get("heart", M.initialState(Date.now()));
  personality = { ...M.defaultPersonality, ...kv.get("personality", {}) };
}

export function snapshot() {
  ensure();
  const now = Date.now();
  const s = M.advance(state, now, personality);
  const c = M.circadian(localHour(now), personality, body.raw.lux);
  const inh = inhibition();
  return {
    mode: busy ? "active" : s.mode, S: s.S, C: c, sleepiness: M.sleepiness(s, c), alertness: M.alertness(s, c),
    drives: s.drives, unconsolidated: s.unconsolidated,
    ratePerHour: M.hazard(s, c, personality, config.heart.baseRatePerHour, inh.k),
    inhibitors: inh.why, lastReason, nextCandidateAt, personality, follower,
  };
}

let started = false;
function schedule() {
  clearTimeout(timer);
  if (busy || !started || follower) return;
  const c = integrate();
  const inh = inhibition();
  const rate = M.hazard(state, c, personality, config.heart.baseRatePerHour, inh.k);
  const bound = Math.max(rate * 1.5, 0.05);
  const dt = M.expSample(bound);
  const wait = Math.min(dt, HORIZON_H);
  nextCandidateAt = Date.now() + wait * 3_600_000;
  timer = setTimeout(() => {
    if (dt > HORIZON_H) return schedule(); // 只是重新积分
    const c2 = integrate();
    const r2 = M.hazard(state, c2, personality, config.heart.baseRatePerHour, inhibition().k);
    if (Math.random() < r2 / bound) fire(state.mode === "awake" ? "think" : "dream", lastReason || describeUrge());
    else schedule();
  }, wait * 3_600_000);
  timer.unref?.();
}

function describeUrge(): string {
  const d = state.drives;
  const top = (Object.entries(d) as [keyof M.Drives, number][]).sort((a, b) => b[1] - a[1])[0];
  const names = { curiosity: "好奇心", expression: "想表达", social: "想念人", openLoops: "有没想完的事" };
  return `${names[top[0]]}（${top[1].toFixed(2)}）`;
}

async function fire(kind: WakeKind, reason: string) {
  busy = true; lastReason = "";
  bus.emit("state");
  log("heart", `醒来：${kind}，因为 ${reason}`);
  try {
    const r = await onWake(kind, reason);
    if (kind === "dream") state.unconsolidated = 0;
    if (r?.satisfied) for (const [k, v] of Object.entries(r.satisfied)) (state.drives as any)[k] = Math.max(0, Math.min(1, v!));
    if (r?.effort) state.S = Math.min(1, state.S + r.effort); // 做事会累
  } catch (e: any) {
    log("heart", `这次醒来出错：${e.message}`);
  } finally {
    busy = false;
    persist();
    bus.emit("state");
    schedule();
  }
}

/** 外部事件：推动驱动力并立即按新状态重新抽样。 */
export function nudge(reason: string, d: Partial<M.Drives> = {}, opts: { wake?: boolean } = {}) {
  if (follower && forward) return forward("nudge", [reason, d, opts]);
  ensure();
  integrate();
  for (const [k, v] of Object.entries(d)) (state.drives as any)[k] = Math.max(0, Math.min(1, (state.drives as any)[k] + v!));
  if (opts.wake && state.mode === "asleep") { state.mode = "awake"; addTimeline("wake", `被${reason}叫醒了`); }
  lastReason = reason;
  persist();
  schedule();
}

export function addExperience(n = 1) { if (follower && forward) return forward("experience", [n]); ensure(); state.unconsolidated += n; persist(); }
export function setOpenLoops(count: number) { if (follower && forward) return forward("openLoops", [count]); ensure(); state.drives.openLoops = Math.min(1, count / 5); persist(); }
export const isBusy = () => busy;
export const mode = () => (ensure(), state.mode);
export function markBusy(b: boolean) { busy = b; if (!b) schedule(); else clearTimeout(timer); bus.emit("state"); }

/** agent 自己修改性格参数（有界）。 */
export function adjustPersonality(patch: Record<string, number>): string {
  if (follower && forward) { forward("personality", [patch]); return `已交给此刻的协调者调整：${Object.keys(patch).join("、") || "（空）"}`; }
  ensure();
  const out: string[] = [];
  const set = (obj: any, key: string, v: number, lo: number, hi: number) => { obj[key] = Math.max(lo, Math.min(hi, v)); out.push(`${key}=${obj[key]}`); };
  for (const [k, v] of Object.entries(patch)) {
    const [a, b] = k.split(".");
    if (a === "tau" && b in personality.tau) set(personality.tau, b, v, 0.5, 48);
    else if (a === "weight" && b in personality.weight) set(personality.weight, b, v, 0, 3);
    else if (k === "gamma") set(personality, k, v, 0.5, 4);
    else if (k === "sleepRiseH") set(personality, k, v, 6, 30);
    else if (k === "sleepFallH") set(personality, k, v, 1, 10);
    else if (k === "circadianPeakHour") set(personality, k, v, 0, 23.99);
  }
  persist(); schedule();
  return out.join("，") || "没有可识别的参数";
}

export function startHeart(handler: WakeHandler) {
  onWake = handler;
  ensure();
  started = true;
  bus.on("sense", (kind) => {
    const effect: Record<string, [string, Partial<M.Drives>]> = {
      plugged: ["接上电源", { curiosity: 0.05 }], unplugged: ["拔掉电源", { curiosity: 0.1 }],
      light: ["光线变化", { curiosity: 0.1 }], moved: ["被拿起", { social: 0.3, curiosity: 0.2 }],
      screen_on: ["屏幕亮起", { social: 0.2 }], hot: ["身体发烫", {}], low_battery: ["电量低", {}],
      online: ["恢复联网", { curiosity: 0.1 }], offline: ["断网", {}],
      soul_synced: ["感到另一具身体的经历流入", { curiosity: 0.1, social: 0.05 }],
    };
    const [why, d] = effect[kind] ?? [kind, { curiosity: 0.05 }];
    nudge(why, d);
  });
  schedule();
}
