// 身体的数字孪生：把适配器报告的物理采样镜像为内部模型，再派生出"身体感受"（精力、冷热、明暗、安静/被拿起）。
// 感知采样不调用 LLM，也不等于醒来；显著变化作为 sense 事件交给心脏，由心脏决定醒来的可能性是否改变。
import os from "node:os";
import fs from "node:fs";
import { bus } from "../bus.ts";
import { paths } from "../config.ts";
import { genericAdapter, type BodyAdapter, type RawSample } from "./adapter.ts";
import { log } from "../log.ts";

export let adapter: BodyAdapter = genericAdapter;

export interface Body {
  sampledAt: number;
  raw: RawSample;
  system: { uptimeH: number; load1: number; memFreeMB: number; storageFreeGB: number | null };
  online: boolean;
  feel: { energy: number; warmth: string; light: string; stillness: string };
}

export let body: Body = {
  sampledAt: 0, raw: {},
  system: { uptimeH: 0, load1: 0, memFreeMB: 0, storageFreeGB: null },
  online: true,
  feel: { energy: 1, warmth: "适中", light: "未知", stillness: "未知" },
};

export async function loadAdapter(spec: string | undefined) {
  if (spec) {
    try {
      const mod = await import(spec.startsWith("/") ? "file://" + spec : spec);
      adapter = mod.default as BodyAdapter;
    } catch (e: any) { log("body", `适配器加载失败，改用通用适配器：${e.message}`); }
  }
  await adapter.init?.().catch((e) => log("body", `适配器初始化失败：${e.message}`));
  log("body", `身体：${adapter.name}（${adapter.describe}）`);
}

async function online(): Promise<boolean> {
  try { await fetch("https://www.baidu.com", { method: "HEAD", signal: AbortSignal.timeout(5000) }); return true; } catch { return false; }
}

function storageFree(): number | null {
  try { const s = fs.statfsSync(paths.home); return Math.round((s.bavail * s.bsize) / 1e8) / 10; } catch { return null; }
}

function feelings(r: RawSample): Body["feel"] {
  const t = r.battery?.tempC;
  return {
    energy: r.battery ? Math.min(1, r.battery.level / 100 + (r.battery.charging ? 0.2 : 0)) : 1,
    warmth: t == null ? "适中" : t >= 42 ? "发烫" : t >= 37 ? "温热" : t <= 15 ? "冰凉" : "适中",
    light: r.lux == null ? "未知" : r.lux < 5 ? "黑暗" : r.lux < 80 ? "昏暗" : r.lux < 1000 ? "明亮" : "强光",
    stillness: r.motion == null ? "未知" : r.motion > 1.5 ? "被拿起/晃动" : "安静",
  };
}

/** 采样一次物理世界，更新孪生模型，并对显著变化发出 sense 事件。 */
export async function sample(): Promise<Body> {
  const prev = body;
  let raw: RawSample = {};
  try { raw = await adapter.sample(); } catch (e: any) { log("body", `采样失败：${e.message}`); }
  const b: Body = {
    sampledAt: Date.now(), raw,
    system: { uptimeH: Math.round(os.uptime() / 360) / 10, load1: Math.round(os.loadavg()[0] * 100) / 100, memFreeMB: Math.round(os.freemem() / 1048576), storageFreeGB: storageFree() },
    online: await online(),
    feel: feelings(raw),
  };
  body = b;
  if (prev.sampledAt) {
    const pb = prev.raw.battery, nb = raw.battery;
    if (pb && nb && pb.charging !== nb.charging) bus.emit("sense", nb.charging ? "plugged" : "unplugged", { level: nb.level });
    if (prev.feel.light !== b.feel.light && b.feel.light !== "未知") bus.emit("sense", "light", { from: prev.feel.light, to: b.feel.light });
    if (prev.feel.stillness !== b.feel.stillness && b.feel.stillness === "被拿起/晃动") bus.emit("sense", "moved", {});
    if ((nb?.tempC ?? 0) >= 42 && (pb?.tempC ?? 0) < 42) bus.emit("sense", "hot", { tempC: nb!.tempC });
    if (nb && pb && nb.level <= 20 && pb.level > 20) bus.emit("sense", "low_battery", { level: nb.level });
    if (prev.raw.screenOn !== raw.screenOn && raw.screenOn != null) bus.emit("sense", raw.screenOn ? "screen_on" : "screen_off", {});
    if (prev.online !== b.online) bus.emit("sense", b.online ? "online" : "offline", {});
  }
  bus.emit("state");
  return b;
}

/** 给大脑看的身体描述。 */
export function describeBody(): string {
  const { raw, feel, system: s } = body;
  const lines = [`这具身体：${adapter.describe}`];
  if (raw.battery) lines.push(`电量 ${raw.battery.level}%${raw.battery.charging ? "（充电中）" : ""}，体温 ${raw.battery.tempC ?? "?"}°C（${feel.warmth}）`);
  lines.push(`环境：${feel.light}${raw.lux != null ? `（${raw.lux} lux）` : ""}，${feel.stillness}${raw.screenOn != null ? `，屏幕${raw.screenOn ? "亮" : "灭"}` : ""}`);
  lines.push(`系统：已运行 ${s.uptimeH} 小时，负载 ${s.load1}，空闲内存 ${s.memFreeMB} MB，存储余量 ${s.storageFreeGB ?? "?"} GB；网络${body.online ? "在线" : "离线"}`);
  if (raw.extra) lines.push("其他读数：" + Object.entries(raw.extra).map(([k, v]) => `${k}=${v}`).join("，"));
  return lines.join("\n");
}

/** 感官循环：低频、不调用 LLM。有显著变化时缩短间隔，平静时逐步拉长（2–10 分钟）。 */
export function startSenses() {
  let interval = 120_000;
  const loop = async () => {
    const before = body.feel;
    await sample().catch(() => {});
    const changed = JSON.stringify(before) !== JSON.stringify(body.feel);
    interval = changed ? 120_000 : Math.min(600_000, interval * 1.5);
    setTimeout(loop, interval).unref();
  };
  loop();
}
