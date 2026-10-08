// 语音：Azure 语音服务（Speech）的文本转语音 REST 接口。合成 → 保存音频 → 交给身体适配器播放。
//   配置在 config.speech（区域或自定义端点、音色、风格、语速、音调、音量、输出格式），密钥在 secrets/azure_speech_key。
//   用户在控制台设置，agent 也可以用 voice_config 工具自己选音色、改配置（端点除外）。端点只接受 Azure 的 HTTPS 域名（config.ts 的 speechEndpointOk）：密钥随每次请求发往它。
import fs from "node:fs";
import { fetchIdle } from "../idle-fetch.ts";
import path from "node:path";
import { config, saveConfig, paths, readSecret, writeSecret, markShared, speechEndpointOk, speechRegionOk } from "../config.ts";
import * as sdk from "microsoft-cognitiveservices-speech-sdk";

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
  if (typeof rest.endpoint === "string" && !speechEndpointOk(rest.endpoint.trim())) throw new Error("端点只能是 Azure 语音服务的 HTTPS 地址（*.microsoft.com、*.azure.com、*.cognitiveservices.azure.com）");
  if (typeof rest.region === "string" && !speechRegionOk(rest.region.trim())) throw new Error("区域只能是字母、数字与连字符，如 eastasia");
  if (key) { writeSecret(KEY, key.trim()); markShared(["speechKey"]); }
  const clean = Object.fromEntries(Object.entries(rest).filter(([k, v]) => k in config.speech && typeof v === "string").map(([k, v]) => [k, (v as string).trim()]));
  saveConfig({ speech: clean });
  return speechStatus();
}

/** Azure 语音服务的公有云区域（国内的世纪互联区域用另一套域名，不在其中）。常用的亚洲区域排在前面。 */
export const SPEECH_REGIONS = ["eastasia", "southeastasia", "japaneast", "japanwest", "koreacentral", "centralindia", "australiaeast", "eastus", "eastus2", "westus", "westus2", "westus3", "centralus", "northcentralus", "southcentralus", "westcentralus", "canadacentral", "brazilsouth", "northeurope", "westeurope", "uksouth", "francecentral", "germanywestcentral", "norwayeast", "swedencentral", "switzerlandnorth", "switzerlandwest", "italynorth", "qatarcentral", "uaenorth", "southafricanorth"];

/**
 * 这把密钥属于哪个区域：同时向各区域的官方令牌接口（*.api.cognitive.microsoft.com/sts/v1.0/issueToken）申请一次令牌，认它的就是。
 * 有好几个都认时优先 prefer（原来的区域）。都不认返回空。只发往微软自己的域名。
 */
export async function detectRegion(key: string, prefer = "", f: typeof fetch = fetch): Promise<string> {
  const hits = await Promise.all(SPEECH_REGIONS.map(async (r) => {
    try {
      const res = await f(`https://${r}.api.cognitive.microsoft.com/sts/v1.0/issueToken`, { method: "POST", headers: { "Ocp-Apim-Subscription-Key": key, "content-length": "0" }, signal: AbortSignal.timeout(10_000) });
      return res.ok ? r : "";
    } catch { return ""; }
  }));
  const ok = hits.filter(Boolean);
  return ok.includes(prefer) ? prefer : ok[0] ?? "";
}

/** 控制台与 voice_config 的修改入口：给了新密钥、又没指定区域也没用自定义端点时，自动找出它的区域（找不到就不保存，说明原因）。 */
export async function setSpeechAuto(patch: Partial<SpeechConfig> & { key?: string }, f: typeof fetch = fetch) {
  const key = typeof patch.key === "string" ? patch.key.trim() : "";
  const endpoint = typeof patch.endpoint === "string" ? patch.endpoint.trim() : config.speech.endpoint;
  if (key && !(typeof patch.region === "string" && patch.region.trim()) && !endpoint) {
    const region = await detectRegion(key, config.speech.region, f);
    if (!region) throw new Error("这把密钥在各个区域都不认：检查是不是复制完整了，或者在「更多」里填写区域");
    patch = { ...patch, region };
  }
  return setSpeech(patch);
}

/** 多具身体之间同步语音密钥（经网状层的加密通道）。 */
export const speechKey = () => readSecret(KEY) ?? "";
export function setSpeechKeyRemote(key: string) { if (key) writeSecret(KEY, key); }

/** 生成 SSML。voice 形如 zh-CN-XiaoxiaoNeural，语言取自前缀；style 为空时不加表达风格。 */
export function ssml(text: string, c: SpeechConfig) {
  const lang = c.voice.split("-").slice(0, 2).join("-") || "zh-CN";
  const prosody = `<prosody rate="${esc(c.rate || "0%")}" pitch="${esc(c.pitch || "0%")}" volume="${esc(c.volume || "100")}">${esc(text)}</prosody>`;
  const body = c.style ? `<mstts:express-as style="${esc(c.style)}">${prosody}</mstts:express-as>` : prosody;
  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="${lang}"><voice name="${esc(c.voice)}">${body}</voice></speak>`;
}

function need(c: SpeechConfig) {
  const key = readSecret(KEY);
  if (!key) throw new Error("还没有配置 Azure 语音密钥（控制台 → 控制 → 声音，或用 voice_config 设置）");
  // 密钥随请求发往端点：只发给 Azure 的域名（配置加载与保存时已经校验，这里再挡一次）
  if (!speechEndpointOk(c.endpoint) || !speechRegionOk(c.region)) throw new Error("语音端点不是 Azure 的地址，拒绝发送密钥");
  if (!base(c)) throw new Error("还没有配置 Azure 语音的区域（region，如 eastasia）或端点");
  return key;
}

/** 合成一段语音，保存为文件，返回路径。override 只对这一次生效。 */
export async function synthesize(text: string, override: Partial<SpeechConfig> = {}): Promise<string> {
  const c = { ...config.speech, ...Object.fromEntries(Object.entries(override).filter(([, v]) => typeof v === "string" && v)) } as SpeechConfig;
  const key = need(c);
  const { res, body: audio } = await fetchIdle(`${base(c)}/cognitiveservices/v1`, { // 60 秒没有收到任何数据才放弃（长段的音频还在传就不砍）
    method: "POST",
    headers: { "Ocp-Apim-Subscription-Key": key, "Content-Type": "application/ssml+xml", "X-Microsoft-OutputFormat": c.format || "audio-24khz-48kbitrate-mono-mp3", "User-Agent": "quetzal" },
    body: ssml(text, c),
  }, 60_000);
  if (!res.ok) throw new Error(`Azure 语音合成失败：HTTP ${res.status} ${audio.toString("utf8").slice(0, 200)}`);
  const ext = /mp3/.test(c.format) ? "mp3" : /ogg|opus/.test(c.format) ? "ogg" : /webm/.test(c.format) ? "webm" : "wav";
  const dir = path.join(paths.data, "media");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `voice-${Date.now()}.${ext}`);
  fs.writeFileSync(file, audio);
  // 只保留最近 50 段
  const old = fs.readdirSync(dir).filter((f) => f.startsWith("voice-")).sort().slice(0, -50);
  for (const f of old) fs.rmSync(path.join(dir, f), { force: true });
  return file;
}

/** 语音识别端点：区域 → <region>.stt.speech.microsoft.com；自定义端点：Azure 的 tts 域名换成 stt，自定义子域加 /stt 前缀。 */
export function sttUrl(c: SpeechConfig, language: string): string {
  const PATH = "/speech/recognition/conversation/cognitiveservices/v1";
  let b = "";
  if (c.endpoint) {
    const e = c.endpoint.replace(/\/+$/, "").replace(/\/cognitiveservices\/v1$/, "");
    b = /\.tts\.speech\./.test(e) ? e.replace(".tts.speech.", ".stt.speech.") + PATH : /\.stt\.speech\./.test(e) ? e + PATH : e + "/stt" + PATH;
  } else if (c.region) b = `https://${c.region}.stt.speech.microsoft.com${PATH}`;
  if (!b) throw new Error("还没有配置 Azure 语音的区域（region）或端点");
  return `${b}?language=${encodeURIComponent(language)}&format=simple&profanity=raw`;
}

/** 识别一段 16 kHz 单声道 16 位 WAV（最长 60 秒）。返回识别出的文字；没有听清返回空串。 */
export async function recognize(wav: Buffer, language: string): Promise<{ text: string; status: string }> {
  const c = config.speech, key = need(c);
  const res = await fetch(sttUrl(c, language), {
    method: "POST",
    headers: { "Ocp-Apim-Subscription-Key": key, "Content-Type": "audio/wav; codecs=audio/pcm; samplerate=16000", Accept: "application/json", "User-Agent": "quetzal" },
    body: new Uint8Array(wav), signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Azure 语音识别失败：HTTP ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`);
  const j: any = await res.json().catch(() => ({}));
  const status = String(j.RecognitionStatus ?? "Error");
  return { text: status === "Success" ? String(j.DisplayText ?? "").trim() : "", status };
}

export interface StreamRecognizer { push(pcm: Buffer): void; end(): Promise<{ text: string; status: string }> }

/** SDK 的 SpeechConfig：区域优先；Azure 的 tts / stt 域名里带区域；其余当作自定义资源端点。 */
function sdkConfig(c: SpeechConfig, key: string, language: string): sdk.SpeechConfig {
  const region = c.region || c.endpoint.match(/^https?:\/\/([a-z0-9-]+)\.(?:tts|stt)\.speech\.microsoft\.com/i)?.[1];
  const sc = region ? sdk.SpeechConfig.fromSubscription(key, region) : sdk.SpeechConfig.fromEndpoint(new URL(c.endpoint.replace(/\/+$/, "")), key);
  sc.speechRecognitionLanguage = language;
  sc.setProperty(sdk.PropertyId.SpeechServiceConnection_InitialSilenceTimeoutMs, "8000");
  sc.setProperty(sdk.PropertyId.SpeechServiceConnection_EndSilenceTimeoutMs, "1200");
  sc.setProfanity(sdk.ProfanityOption.Raw);
  return sc;
}

/**
 * 流式识别一段话（官方 SDK，WebSocket 推流，连续识别）：边 push 16 kHz 单声道 16 位 PCM 边拿到中间结果（onPartial，带上前面已定稿的各段），
 * end 后等服务把剩余音频识别完（EndOfStream），把各段拼成最终结果。用连续识别而不是单句识别：一段话里有停顿、说得长也不会被截断。
 */
export function recognizeStream(language: string, onPartial: (text: string) => void): StreamRecognizer {
  const c = config.speech, key = need(c);
  if (!c.region && !c.endpoint) throw new Error("还没有配置 Azure 语音的区域（region）或端点");
  const push = sdk.AudioInputStream.createPushStream(sdk.AudioStreamFormat.getWaveFormatPCM(16000, 16, 1));
  const rec = new sdk.SpeechRecognizer(sdkConfig(c, key, language), sdk.AudioConfig.fromStreamInput(push));
  const finals: string[] = [];
  let error: string | undefined, settled = false;
  let resolve!: (v: { text: string; status: string }) => void, reject!: (e: Error) => void;
  const done = new Promise<{ text: string; status: string }>((res, rej) => { resolve = res; reject = rej; });
  const finish = () => {
    if (settled) return; settled = true;
    rec.stopContinuousRecognitionAsync(() => rec.close(), () => rec.close());
    const text = finals.join("").trim();
    if (text) resolve({ text, status: "Success" });
    else if (error) reject(new Error(`Azure 流式识别失败：${error}`));
    else resolve({ text: "", status: "NoMatch" });
  };
  // 送完音频以后：服务还在送中间结果或定稿就重新计时，15 秒没有任何结果才用已有的收尾
  let ended = false, tail: NodeJS.Timeout | undefined;
  const wait = () => { if (!ended) return; clearTimeout(tail); tail = setTimeout(finish, 15_000); tail.unref?.(); };
  rec.recognizing = (_, e) => { wait(); if (e.result.text) onPartial(finals.join("") + e.result.text); };
  rec.recognized = (_, e) => { wait(); if (e.result.reason === sdk.ResultReason.RecognizedSpeech && e.result.text) finals.push(e.result.text.trim()); };
  rec.canceled = (_, e) => { if (e.reason === sdk.CancellationReason.Error) { error = e.errorDetails || String(e.errorCode); finish(); } }; // EndOfStream 不在这里收尾：最后一段的定稿可能还在后面
  rec.sessionStopped = () => finish(); // 服务把送完的音频全部识别完、最后一段也定稿之后才到这里
  rec.startContinuousRecognitionAsync(undefined, (err) => { error = String(err); finish(); });
  return {
    push: (pcm) => push.write(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength) as ArrayBuffer),
    end: () => { push.close(); ended = true; wait(); return done; }, // 15 秒没有新的结果、服务也没说结束，就用已有的结果
  };
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
