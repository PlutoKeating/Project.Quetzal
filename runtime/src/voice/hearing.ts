// 听觉：耳朵在控制台 App（常驻麦克风、系统降噪、语音活动检测、按句切段），基座这边做识别与判断。
//   App 把每句话送到网关 /hear：stream=1 时边说边送 PCM（分块传输），这里用官方 SDK 推流识别，中间结果以 hearing 事件推给控制台流式显示；
//   否则一整句 WAV 一次识别（短语音 REST）。流式识别失败时退回 REST（音频已经全部收到）。
//   识别完成 → 挑会话：最近一个有更新的会话在 windowMin 分钟内就并入它，否则新开会话 → 以「环境声音」进入会话：
//   它不是对方发的消息，是她听到的；是不是对她说的、要不要回应，由她自己判断（见 brain.converse 的 ambient）。
//   她判断不是对她说的：这句话在记录里标为 ignored，控制台隐藏（hearing 事件 ignored）；回应了则保留（kept）。
//   她自己说话时：声音由 App 经通话路径播放、采集走回声消除（见 voice/player.ts），麦克风音轨里减掉了她自己的声音；
//   这里只维护「她在说话到何时」的窗口给界面用，并把 App 回报的插嘴（打断了播放的那句话）以「打断」并入。
import fs from "node:fs";
import crypto from "node:crypto";
import { config, saveConfig } from "../config.ts";
import { body, adapter } from "../body/twin.ts";
import { isBargeIn } from "./player.ts";
import { stopped } from "../heart/heart.ts";
import { identity } from "../memory/identity.ts";
import { listSessions, ensureSession, addTimeline } from "../store.ts";
import { recognize, recognizeStream, speechStatus, type StreamRecognizer } from "./azure.ts";
import { converse } from "../mind/brain.ts";
import { bus, type HearingEvent } from "../bus.ts";
import { log } from "../log.ts";

export const CHANNEL = "语音";
let speakingUntil = 0;
let last: { ts: number; text: string; status: string; conv?: string } | undefined;
/** 流式识别器的工厂（测试里换成模拟的）。 */
export let streamFactory: (language: string, onPartial: (t: string) => void) => StreamRecognizer = recognizeStream;
export const setStreamFactory = (f: typeof streamFactory) => { streamFactory = f; };

/** 她要说话了：按文件大小与码率估算时长（App 播放时会准确回报结束），记下窗口、通知界面。返回估计的毫秒数。 */
export function markSpeaking(file: string, _text = ""): number {
  let ms = 3000;
  try {
    const bytes = fs.statSync(file).size;
    const kbps = Number(config.speech.format.match(/(\d+)kbitrate/)?.[1] ?? 48);
    ms = Math.round((bytes * 8) / (kbps * 1000) * 1000);
  } catch {}
  speakingUntil = Math.max(speakingUntil, Date.now() + ms + 800);
  bus.emit("speaking", { until: speakingUntil });
  return ms;
}
export const isSpeaking = () => Date.now() < speakingUntil;

/** 她说完了或被插嘴：说话窗口立即结束；stopAdapter 为真时还让适配器停止播放（声音由适配器放的时候）。 */
export async function stopSpeaking(stopAdapter = true) {
  if (!isSpeaking()) return;
  speakingUntil = Date.now();
  bus.emit("speaking", { until: speakingUntil });
  if (stopAdapter) await adapter.stopAudio?.().catch(() => {});
}

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

export interface HeardResult { ok: boolean; id: string; text: string; conv?: string; dropped?: string }

const emit = (e: HearingEvent) => bus.emit("hearing", e);

/**
 * 多具身体（mesh/channels.ts 设置）：dedupe——几只耳朵同时听到同一句话时只留一只（返回 false 表示交给别的身体处理）；
 * heard——这只耳朵听到的话进了哪个会话（她用 voice_speak 回话时从这具身体说出来）。
 */
/** 一句话在这只耳朵上的起止（运行基座的时钟，毫秒）。 */
export interface Span { start: number; end: number }
let meshHooks: { dedupe: (u: { id: string; text: string } & Span) => Promise<boolean>; heard: (conv: string) => void } | undefined;
export const setHearingMesh = (h: typeof meshHooks) => { meshHooks = h; };
/** 测试用：按多具身体的规则判断一句话这只耳朵要不要留，并登记进了哪个会话。 */
export async function meshHeard(text: string, conv: string, start = Date.now(), end = start + 1500) {
  const keep = await (meshHooks?.dedupe({ id: newId(), text, start, end }) ?? Promise.resolve(true));
  if (keep) meshHooks?.heard(conv);
  return keep;
}
const newId = () => crypto.randomBytes(6).toString("hex");

/**
 * 识别出文字之后：没识别出文字的不打扰她；有文字（一个字也算：「停」「好」都是完整的话）就挑会话、交给她判断，并把她的取舍（kept / ignored）推给控制台。
 * bargeIn：这句话打断了她的播放（App 回报的插嘴），以「打断」并入她当前的工作。
 */
async function deliver(id: string, r: { text: string; status: string }, wait: boolean, bargeIn: boolean, span: Span): Promise<HeardResult> {
  last = { ts: Date.now(), text: r.text, status: r.status };
  if (!r.text.trim()) {
    const dropped = `没听清（${r.status}）`;
    emit({ id, status: "dropped", text: r.text, reason: dropped });
    return { ok: true, id, text: r.text, dropped };
  }
  bargeIn = bargeIn || isBargeIn(id);
  if (meshHooks && !bargeIn && !(await meshHooks.dedupe({ id, text: r.text, ...span }).catch(() => true))) {
    emit({ id, status: "dropped", text: r.text, reason: "另一具身体也听到了这句话，由那边交给她" });
    return { ok: true, id, text: r.text, dropped: "另一具身体也听到了" };
  }
  if (bargeIn) await stopSpeaking();
  const conv = pickSession(r.text);
  meshHooks?.heard(conv);
  last.conv = conv;
  log("hearing", `听到（${conv.slice(0, 8)}）${bargeIn ? "，对方插嘴" : ""}：${r.text}`);
  emit({ id, status: "final", text: r.text, conv });
  const p = converse("有人", r.text, CHANNEL, { conv, ambient: true, mode: bargeIn ? "interrupt" : undefined })
    .then((reply) => emit({ id, status: reply === "" ? "ignored" : "kept", text: r.text, conv })) // 返回空串 = 她选择沉默；插话并入（她正在工作）也算回应了
    .catch((e) => { log("hearing", `处理失败：${e.message}`); emit({ id, status: "kept", text: r.text, conv, reason: e.message }); });
  if (wait) await p;
  return { ok: true, id, text: r.text, conv };
}

function gate(id: string): HeardResult | undefined {
  const st = hearingStatus();
  if (!st.listening) { emit({ id, status: "dropped", text: "", reason: st.reasons.join("、") }); return { ok: false, id, text: "", dropped: st.reasons.join("、") }; }
  return undefined;
}

/** 一整句 WAV 一次识别。wait：等她处理完再返回（测试用）。 */
export async function hear(wav: Buffer, _startedAt: number, wait = false): Promise<HeardResult> {
  const id = newId();
  const g = gate(id);
  if (g) return g;
  if (wav.length <= 44) { emit({ id, status: "dropped", text: "", reason: "没有声音" }); return { ok: true, id, text: "", dropped: "没有声音" }; } // 只有 WAV 头，没有一个采样（多短都交给识别：有没有话由识别结果说了算）
  const end = Date.now(), start = end - Math.round((wav.length - 44) / 32); // 16 kHz、16 位单声道：每毫秒 32 字节
  return deliver(id, await recognize(wav, hearingStatus().language), wait, false, { start, end });
}

const WAV_HEADER = (pcmBytes: number) => {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + pcmBytes, 4); h.write("WAVE", 8); h.write("fmt ", 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(16000, 24); h.writeUInt32LE(32000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(pcmBytes, 40);
  return h;
};

/** 一次识别的兜底：短语音 REST 最长 60 秒，更长的按 50 秒分段识别后拼起来。 */
async function recognizeLong(pcm: Buffer, language: string): Promise<{ text: string; status: string }> {
  const SEG = 16000 * 2 * 50;
  const parts: string[] = []; let status = "NoMatch";
  for (let i = 0; i < pcm.length; i += SEG) {
    const seg = pcm.subarray(i, Math.min(pcm.length, i + SEG));
    const r = await recognize(Buffer.concat([WAV_HEADER(seg.length), seg]), language);
    if (r.text) { parts.push(r.text); status = "Success"; } else if (status !== "Success") status = r.status;
  }
  return { text: parts.join(""), status };
}

/**
 * 边说边识别：chunks 为分块到达的 PCM（16 kHz 单声道 16 位，无 WAV 头）。中间结果随到随推（hearing: partial），
 * 收完后给最终结果；流式识别失败或没结果时，用已收到的全部音频走一次 REST 识别兜底。
 */
export async function hearStream(chunks: AsyncIterable<Buffer>, _startedAt: number, id = newId(), wait = false, bargeIn = false): Promise<HeardResult> {
  const g = gate(id);
  if (g) return g;
  const language = hearingStatus().language;
  const all: Buffer[] = [];
  let rec: StreamRecognizer | undefined, partial = "";
  const onPartial = (t: string) => { if (t === partial) return; partial = t; emit({ id, status: "partial", text: t }); };
  try { rec = streamFactory(language, onPartial); }
  catch (e: any) { log("hearing", `流式识别不可用，改用一次识别：${e.message}`); }
  for await (const c of chunks) { all.push(c); try { rec?.push(c); } catch {} }
  const pcm = Buffer.concat(all), end = Date.now(), start = end - Math.round(pcm.length / 32); // 最后一段到达时这句话结束；按采样数往前推出开始
  if (!pcm.length) { emit({ id, status: "dropped", text: "", reason: "没有声音" }); return { ok: true, id, text: "", dropped: "没有声音" }; }
  let r: { text: string; status: string } | undefined;
  if (rec) { try { r = await rec.end(); } catch (e: any) { log("hearing", `流式识别失败，改用一次识别：${e.message}`); } }
  if (!r || (!r.text && r.status !== "NoMatch")) r = await recognizeLong(pcm, language);
  return deliver(id, r, wait, bargeIn, { start, end });
}

/** 她听到了但没有回应：留一条时间线，让心流里看得到。 */
export function noteSilence(conv: string, text: string) {
  addTimeline("hear", `听到有人说话，没有回应：${text.slice(0, 40)}`, { conv, text });
}
