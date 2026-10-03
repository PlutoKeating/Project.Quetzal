// 听觉：耳朵在控制台 App（常驻麦克风、系统降噪、语音活动检测、按句切段），基座这边做识别与判断。
//   App 把每句话（16 kHz 单声道 WAV）POST 到网关 /hear → Azure 识别 → 作为「环境声音」进入会话：
//   最近一个有更新的会话在 windowMin 分钟内就并入它，否则新开会话。环境声音不是对方发的消息，是她听到的；
//   是不是对她说的、要不要回应，由她自己判断（见 brain.converse 的 ambient）。
//   她自己说话（voice_speak 播放）期间听到的是自己的声音：按音频时长估一个窗口，窗口内开始的声音直接丢弃。
import fs from "node:fs";
import crypto from "node:crypto";
import { config, saveConfig } from "../config.ts";
import { body } from "../body/twin.ts";
import { stopped } from "../heart/heart.ts";
import { identity } from "../memory/identity.ts";
import { listSessions, ensureSession, addTimeline } from "../store.ts";
import { recognize, speechStatus } from "./azure.ts";
import { converse } from "../mind/brain.ts";
import { log } from "../log.ts";

export const CHANNEL = "语音";
let speakingUntil = 0;
let last: { ts: number; text: string; status: string; conv?: string } | undefined;

/** 她正在说话：播放一个合成的音频文件，按码率估算时长（没法从播放器拿到结束事件）。 */
export function markSpeaking(file: string) {
  let ms = 3000;
  try {
    const bytes = fs.statSync(file).size;
    const kbps = Number(config.speech.format.match(/(\d+)kbitrate/)?.[1] ?? 48);
    ms = Math.round((bytes * 8) / (kbps * 1000) * 1000);
  } catch {}
  speakingUntil = Math.max(speakingUntil, Date.now() + ms + 800);
}
export const isSpeaking = () => Date.now() < speakingUntil;

export type HearingConfig = typeof config.hearing;

/** 现在该不该听：开关、急停、电量与温度（预算里的身体限制）、识别是否已配置。listening 为假时 App 不启动麦克风。 */
export function hearingStatus() {
  const h = config.hearing;
  const bat = body.raw.battery;
  const reasons: string[] = [];
  if (!h.enabled) reasons.push("未开启");
  if (stopped()) reasons.push("急停中");
  if (!speechStatus().configured) reasons.push("Azure 语音未配置");
  if (bat && !bat.charging && bat.level < config.budget.minBattery) reasons.push(`电量低于 ${config.budget.minBattery}%`);
  if (bat?.tempC != null && bat.tempC >= config.budget.maxTempC) reasons.push(`温度超过 ${config.budget.maxTempC}°C`);
  return { ...h, language: h.language || identity().language || "zh-CN", listening: !reasons.length, reasons, speaking: isSpeaking(), last };
}

export function setHearing(patch: Partial<HearingConfig>) {
  const clean: Partial<HearingConfig> = {};
  if (typeof patch.enabled === "boolean") clean.enabled = patch.enabled;
  if (patch.windowMin != null && Number.isFinite(Number(patch.windowMin))) clean.windowMin = Math.max(0, Math.min(1440, Number(patch.windowMin)));
  if (patch.sensitivity != null && Number.isFinite(Number(patch.sensitivity))) clean.sensitivity = Math.max(1, Math.min(3, Math.round(Number(patch.sensitivity))));
  if (typeof patch.language === "string") clean.language = patch.language.trim();
  if (patch.minChars != null && Number.isFinite(Number(patch.minChars))) clean.minChars = Math.max(0, Math.min(50, Math.round(Number(patch.minChars))));
  saveConfig({ hearing: clean });
  return hearingStatus();
}

/** 这句话该进哪个会话：最近更新的会话在窗口内就并入，否则新开。 */
export function pickSession(text: string, now = Date.now()): string {
  const recent = listSessions({ limit: 1 })[0];
  if (recent && config.hearing.windowMin > 0 && now - recent.updated <= config.hearing.windowMin * 60_000) return recent.id; // 窗口为 0：每句话都新开会话
  const id = crypto.randomUUID();
  ensureSession(id, text.replace(/\s+/g, " ").trim().slice(0, 20) || "听到的话", CHANNEL);
  return id;
}

export interface HeardResult { ok: boolean; text: string; conv?: string; dropped?: string }

/** 处理 App 送来的一句话。startedAt：这句话开始的时刻（毫秒），用于判断是不是她自己在说。wait：等她处理完再返回（测试用）。 */
export async function hear(wav: Buffer, startedAt: number, wait = false): Promise<HeardResult> {
  const st = hearingStatus();
  if (!st.listening) return { ok: false, text: "", dropped: st.reasons.join("、") };
  if (startedAt && startedAt < speakingUntil) return { ok: true, text: "", dropped: "我自己在说话" };
  if (wav.length < 44 + 16000 * 2 * 0.3) return { ok: true, text: "", dropped: "太短" }; // 不到 0.3 秒
  const r = await recognize(wav, st.language);
  last = { ts: Date.now(), text: r.text, status: r.status };
  if (!r.text || r.text.length < config.hearing.minChars) return { ok: true, text: r.text, dropped: r.text ? "太短" : `没听清（${r.status}）` };
  const conv = pickSession(r.text);
  last.conv = conv;
  log("hearing", `听到（${conv.slice(0, 8)}）：${r.text}`);
  const p = converse("有人", r.text, CHANNEL, { conv, ambient: true }).catch((e) => log("hearing", `处理失败：${e.message}`));
  if (wait) await p;
  return { ok: true, text: r.text, conv };
}

/** 她听到了但没有回应：留一条时间线，让心流里看得到。 */
export function noteSilence(conv: string, text: string) {
  addTimeline("hear", `听到有人说话，没有回应：${text.slice(0, 40)}`, { conv, text });
}
