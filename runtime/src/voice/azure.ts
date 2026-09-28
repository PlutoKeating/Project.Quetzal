// 语音：Azure 语音服务（Speech）的文本转语音 REST 接口。合成 → 保存音频 → 交给身体适配器播放。
//   配置在 config.speech（区域或自定义端点、音色、风格、语速、音调、音量、输出格式），密钥在 secrets/azure_speech_key。
//   用户在控制台设置，agent 也可以用 voice_config 工具自己选音色、改配置。
import fs from "node:fs";
import path from "node:path";
import { config, saveConfig, paths, readSecret, writeSecret } from "../config.ts";

export type SpeechConfig = typeof config.speech;
const KEY = "azure_speech_key";

const base = (c: SpeechConfig) => (c.endpoint ? c.endpoint.replace(/\/+$/, "").replace(/\/cognitiveservices\/v1$/, "") : c.region ? `https://${c.region}.tts.speech.microsoft.com` : "");
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

/** 当前配置（密钥只给末四位）。 */
export function speechStatus() {
  const key = readSecret(KEY) ?? "";
  return { ...config.speech, keyLastFour: key.slice(-4), configured: !!(key && base(config.speech) && config.speech.voice) };
}

/** 修改配置；key 为空字符串时保留原密钥。 */
export function setSpeech(patch: Partial<SpeechConfig> & { key?: string }) {
  const { key, ...rest } = patch;
  if (key) writeSecret(KEY, key.trim());
  const clean = Object.fromEntries(Object.entries(rest).filter(([k, v]) => k in config.speech && typeof v === "string").map(([k, v]) => [k, (v as string).trim()]));
  saveConfig({ speech: clean });
  return speechStatus();
}

/** 生成 SSML。voice 形如 zh-CN-XiaoxiaoNeural，语言取自前缀；style 为空时不加表达风格。 */
export function ssml(text: string, c: SpeechConfig) {
  const lang = c.voice.split("-").slice(0, 2).join("-") || "zh-CN";
  const prosody = `<prosody rate="${esc(c.rate || "0%")}" pitch="${esc(c.pitch || "0%")}" volume="${esc(c.volume || "100")}">${esc(text)}</prosody>`;
  const body = c.style ? `<mstts:express-as style="${esc(c.style)}">${prosody}</mstts:express-as>` : prosody;
  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="${lang}"><voice name="${esc(c.voice)}">${body}</voice></speak>`;
}

function need(c: SpeechConfig) {
  const key = readSecret(KEY);
  if (!key) throw new Error("还没有配置 Azure 语音密钥（控制台 → 控制 → 语音，或用 voice_config 设置）");
  if (!base(c)) throw new Error("还没有配置 Azure 语音的区域（region，如 eastasia）或端点");
  return key;
}

/** 合成一段语音，保存为文件，返回路径。override 只对这一次生效。 */
export async function synthesize(text: string, override: Partial<SpeechConfig> = {}): Promise<string> {
  const c = { ...config.speech, ...Object.fromEntries(Object.entries(override).filter(([, v]) => typeof v === "string" && v)) } as SpeechConfig;
  const key = need(c);
  const res = await fetch(`${base(c)}/cognitiveservices/v1`, {
    method: "POST",
    headers: { "Ocp-Apim-Subscription-Key": key, "Content-Type": "application/ssml+xml", "X-Microsoft-OutputFormat": c.format || "audio-24khz-48kbitrate-mono-mp3", "User-Agent": "windler" },
    body: ssml(text, c), signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`Azure 语音合成失败：HTTP ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`);
  const ext = /mp3/.test(c.format) ? "mp3" : /ogg|opus/.test(c.format) ? "ogg" : /webm/.test(c.format) ? "webm" : "wav";
  const dir = path.join(paths.data, "media");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `voice-${Date.now()}.${ext}`);
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  // 只保留最近 50 段
  const old = fs.readdirSync(dir).filter((f) => f.startsWith("voice-")).sort().slice(0, -50);
  for (const f of old) fs.rmSync(path.join(dir, f), { force: true });
  return file;
}

/** 列出可用音色（可按语言过滤，如 zh-CN）。 */
export async function listVoices(locale = ""): Promise<{ name: string; locale: string; gender: string; local: string; styles: string[] }[]> {
  const c = config.speech, key = need(c);
  const res = await fetch(`${base(c)}/cognitiveservices/voices/list`, { headers: { "Ocp-Apim-Subscription-Key": key }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`获取音色列表失败：HTTP ${res.status}`);
  const list: any[] = await res.json();
  return list.filter((v) => !locale || String(v.Locale).toLowerCase().startsWith(locale.toLowerCase()))
    .map((v) => ({ name: v.ShortName, locale: v.Locale, gender: v.Gender, local: v.LocalName, styles: v.StyleList ?? [] }));
}
