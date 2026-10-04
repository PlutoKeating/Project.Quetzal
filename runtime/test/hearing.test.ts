// 听觉：识别请求格式、会话归属窗口、自己说话期间丢弃、环境声音作为第三种消息进入对话、她选择沉默时不留话。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { SpeechConfig } from "../src/voice/azure.ts";

process.env.QUETZAL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "quetzal-hearing-"));
const { loadConfig, config } = await import("../src/config.ts");
loadConfig();
const store = await import("../src/store.ts");
store.openStore();
const reg = await import("../src/providers/registry.ts");
const voice = await import("../src/voice/azure.ts");
const hearing = await import("../src/voice/hearing.ts");
const { systemPrompt } = await import("../src/mind/prompt.ts");

// 模拟 Azure：识别端点按请求体里的标记回不同文字；合成端点回一段假 mp3
let sttHeaders: http.IncomingHttpHeaders = {}, sttUrl = "";
const azure = http.createServer((req, res) => {
  const chunks: Buffer[] = []; req.on("data", (c) => chunks.push(c)); req.on("end", () => {
    const body = Buffer.concat(chunks);
    if (req.url?.includes("/speech/recognition/")) {
      sttHeaders = req.headers; sttUrl = req.url;
      const tag = body.subarray(44).toString("utf8").replace(/\0/g, "").trim();
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(tag === "noise" ? { RecognitionStatus: "NoMatch" } : { RecognitionStatus: "Success", DisplayText: tag || "你好", Offset: 0, Duration: 1 }));
    }
    res.writeHead(200, { "content-type": "audio/mpeg" }); res.end(Buffer.alloc(6000)); // 48 kbps → 1 秒
  });
});
await new Promise<void>((r) => azure.listen(0, "127.0.0.1", r));
const azureBase = `http://127.0.0.1:${(azure.address() as any).port}`;

// 模拟模型：听到「薰」就回应，否则沉默
const seen: any[] = [];
const llm = http.createServer((req, res) => {
  let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
    const j = JSON.parse(body); seen.push(j);
    const u = j.messages.at(-1); const text = typeof u.content === "string" ? u.content : u.content.find((c: any) => c.type === "text").text;
    const heard = text.match(/有人说：\n(.*)/)?.[1] ?? "";
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: /薰/.test(heard) ? `在呢：${heard}` : "沉默" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
  });
});
await new Promise<void>((r) => llm.listen(0, "127.0.0.1", r));
reg.saveProviders({ providers: [{ id: "p", catalogId: "custom", name: "Mock", baseUrl: `http://127.0.0.1:${(llm.address() as any).port}`, protocol: "openai-completions" as const, enabled: true,
  keys: [{ id: "k", label: "k", lastFour: "", enabled: true, secret: "sk-mock-000000" }], models: [{ id: "m", name: "plain", enabled: true, context: 8000, maxTokens: 256, sortOrder: 0 }] }] }, reg.configVersion());

/** 一个只含标记文字的假 WAV（16 kHz 单声道 16 位，1 秒）。 */
const wav = (tag: string) => { const b = Buffer.alloc(44 + 32000); b.write("RIFF", 0); b.write("WAVE", 8); b.write(tag, 44, "utf8"); return b; };

test("识别端点：区域、tts 端点换 stt、自定义子域加 /stt；language 必填", () => {
  const c = (o: Partial<SpeechConfig>) => ({ ...config.speech, ...o }) as SpeechConfig;
  assert.equal(voice.sttUrl(c({ region: "eastasia", endpoint: "" }), "zh-CN"), "https://eastasia.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=zh-CN&format=simple&profanity=raw");
  assert.match(voice.sttUrl(c({ endpoint: "https://eastasia.tts.speech.microsoft.com/cognitiveservices/v1" }), "en-US"), /^https:\/\/eastasia\.stt\.speech\.microsoft\.com\/speech\/recognition\/.*language=en-US/);
  assert.match(voice.sttUrl(c({ endpoint: "https://myres.cognitiveservices.azure.com/" }), "zh-CN"), /^https:\/\/myres\.cognitiveservices\.azure\.com\/stt\/speech\/recognition\//);
  assert.throws(() => voice.sttUrl(c({ region: "", endpoint: "" }), "zh-CN"), /区域/);
});

test("没开听觉或未配置语音时不听；配置后 listening 为真", async () => {
  assert.equal(hearing.hearingStatus().listening, false);
  assert.deepEqual(hearing.hearingStatus().reasons, ["未开启", "Azure 语音未配置"]);
  const d = await hearing.hear(wav("你好"), Date.now());
  assert.deepEqual([d.ok, d.text, d.dropped], [false, "", "未开启、Azure 语音未配置"]);
  voice.setSpeech({ endpoint: azureBase, key: "k-123456" } as any);
  const st = hearing.setHearing({ enabled: true, windowMin: 10, sensitivity: 9, minChars: 2 });
  assert.equal(st.listening, true);
  assert.equal(st.sensitivity, 3); // 有界
  assert.equal(st.language, "zh-CN"); // 取她的偏好语言
  assert.match(systemPrompt(), /## 听觉\n你的耳朵开着/);
});

test("识别：WAV 直接 POST，没听清与太短的不打扰她", async () => {
  const r = await hearing.hear(wav("noise"), Date.now());
  assert.equal(r.text, "");
  assert.match(r.dropped!, /没听清（NoMatch）/);
  assert.equal(sttHeaders["content-type"], "audio/wav; codecs=audio/pcm; samplerate=16000");
  assert.equal(sttHeaders["ocp-apim-subscription-key"], "k-123456");
  assert.match(sttUrl, /language=zh-CN&format=simple/);
  assert.match((await hearing.hear(wav("嗯"), Date.now())).dropped!, /太短/);
  assert.match((await hearing.hear(Buffer.alloc(100), Date.now())).dropped!, /太短/);
  assert.equal(store.listSessions().length, 0, "没听清的不建会话");
});

test("她说话：有 App 播放器时经 speak 事件交给 App 播放并等回报，没有时交给适配器；插嘴由 App 回报并以打断并入", async () => {
  const player = await import("../src/voice/player.ts");
  const { bus } = await import("../src/bus.ts");
  const { adapter } = await import("../src/body/twin.ts");
  const speaking: number[] = [], speaks: any[] = [];
  bus.on("speaking", (e) => speaking.push(e.until)); bus.on("speak", (e) => speaks.push(e));
  const f = await voice.synthesize("我说一句");
  // 没有播放器：适配器播放
  let played = 0; (adapter as any).playAudio = async () => { played++; };
  assert.deepEqual(await player.play(f, "我说一句"), { interrupted: false, by: "adapter" });
  assert.equal(played, 1);
  assert.ok(speaking[0] > Date.now() + 1500 && speaking[0] < Date.now() + 2500, "6000 字节 @48kbps ≈ 1 秒 + 0.8 秒余量");
  // 有播放器：推送 speak，App 回报 done 后才返回；窗口随之结束
  player.setPlayer(true);
  const p = player.play(f, "我说一句");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(speaks.length, 1);
  assert.equal(speaks[0].url, `/media/${encodeURIComponent(speaks[0].id)}`);
  assert.ok(hearing.isSpeaking());
  assert.ok(player.done(speaks[0].id, true, "u-1")); // 对方插嘴打断了播放，打断的那句话 id 为 u-1
  assert.deepEqual(await p, { interrupted: true, by: "app" });
  assert.ok(!hearing.isSpeaking());
  assert.equal(played, 1, "有播放器时不经适配器");
  assert.ok(player.mediaFile(speaks[0].id)!.endsWith(speaks[0].id));
  assert.equal(player.mediaFile("../secrets/x.mp3"), undefined);
  // 那句话送到时以「打断」并入（会话里仍是环境声音）
  hearing.setStreamFactory(() => ({ push: () => {}, end: async () => ({ text: "薰你好，等一下", status: "Success" }) }));
  async function* pcm() { yield Buffer.alloc(32000); }
  const r = await hearing.hearStream(pcm(), Date.now(), "u-1", true);
  assert.equal(r.text, "薰你好，等一下");
  assert.equal(store.sessionMessages(r.conv!).find((m) => m.text === "薰你好，等一下")!.role, "ambient");
  player.setPlayer(false);
  delete (adapter as any).playAudio;
  hearing.setHearing({ windowMin: 0 }); // 下一句新开会话，供后面的测试使用
  assert.equal((await hearing.hear(wav("薰你好"), Date.now() + 5000, true)).text, "薰你好");
  hearing.setHearing({ windowMin: 10 });
});

test("环境声音：以第三种消息类型进入会话，叫到她就回应，没叫到就沉默且不留她的话", async () => {
  const conv = store.listSessions()[0];
  assert.equal(conv.channel, "语音");
  assert.equal(conv.title, "薰你好");
  let msgs = store.sessionMessages(conv.id);
  assert.deepEqual(msgs.map((m) => [m.role, m.text]), [["ambient", "薰你好"], ["agent", "在呢：薰你好"]]);
  const prompt = seen.at(-1);
  assert.match(prompt.messages.at(-1).content, /环境声音/);
  assert.match(prompt.messages.at(-1).content, /voice_speak/);
  // 没叫到她：沉默
  seen.length = 0;
  const r = await hearing.hear(wav("今天天气不错"), Date.now() + 5000, true); // 上一个测试标记了她在说话 1.8 秒，这里用之后的时刻
  assert.equal(r.conv, conv.id, "10 分钟窗口内并入最近的会话");
  msgs = store.sessionMessages(conv.id);
  assert.deepEqual(msgs.map((m) => m.role), ["ambient", "agent", "ambient"]); // 她的「沉默」没有入库
  assert.ok(store.listTimeline(5).some((e) => e.kind === "hear" && /没有回应/.test(e.title)));
  // 历史里环境声音有标注
  await hearing.hear(wav("薰在吗"), Date.now() + 5000, true);
  const hist = seen.at(-1).messages.map((m: any) => (typeof m.content === "string" ? m.content : m.content[0].text));
  assert.ok(hist.some((t: string) => /环境声音.*今天天气不错/.test(t)));
});

test("会话窗口：超过 windowMin 新开会话，窗口为 0 时每句都新开", async () => {
  const before = store.listSessions().length, prev = store.listSessions()[0].id;
  hearing.setHearing({ windowMin: 0 });
  const fresh = hearing.pickSession("新的一句");
  assert.notEqual(fresh, prev);
  assert.equal(store.getSession(fresh)!.title, "新的一句");
  assert.equal(store.listSessions().length, before + 1);
  hearing.setHearing({ windowMin: 10 });
  const latest = store.listSessions()[0].id;
  assert.equal(hearing.pickSession("再说一句"), latest);
});

// ---------- 流式识别（模拟的流式识别器）与她的取舍事件
test("流式：中间结果随到随推，最终进入会话；她沉默时这句话标为 ignored 且控制台收到 ignored", async () => {
  const { bus } = await import("../src/bus.ts");
  const events: any[] = [];
  bus.on("hearing", (e) => events.push(e));
  hearing.setStreamFactory((_lang, onPartial) => {
    let got = 0;
    return { push: (b) => { got += b.length; if (got === 32000) onPartial("今天"); if (got === 64000) onPartial("今天天气"); }, end: async () => ({ text: "今天天气不错吧", status: "Success" }) };
  });
  async function* pcm() { for (let i = 0; i < 4; i++) yield Buffer.alloc(32000); }
  const r = await hearing.hearStream(pcm(), Date.now() + 5000, "s1", true);
  assert.equal(r.text, "今天天气不错吧");
  assert.deepEqual(events.filter((e) => e.id === "s1").map((e) => [e.status, e.text]), [["partial", "今天"], ["partial", "今天天气"], ["final", "今天天气不错吧"], ["ignored", "今天天气不错吧"]]);
  const m = store.sessionMessages(r.conv!).find((x) => x.text === "今天天气不错吧")!;
  assert.equal(m.role, "ambient");
  assert.equal(m.mode, "ignored"); // 她判断不是对她说的：标记后控制台隐藏
  // 叫到她：kept
  hearing.setStreamFactory((_lang) => ({ push: () => {}, end: async () => ({ text: "薰，几点了", status: "Success" }) }));
  await hearing.hearStream(pcm(), Date.now() + 5000, "s2", true);
  assert.deepEqual(events.filter((e) => e.id === "s2").map((e) => e.status), ["final", "kept"]);
  assert.equal(store.sessionMessages(r.conv!).find((x) => x.text === "薰，几点了")!.mode, null);
});

test("流式识别失败或没结果时，用已收到的音频走一次 REST 识别兜底", async () => {
  hearing.setStreamFactory(() => ({ push: () => {}, end: async () => { throw new Error("socket closed"); } }));
  async function* pcm() { yield Buffer.concat([Buffer.alloc(32000), Buffer.from("薰在吗兜底")]); }
  const r = await hearing.hearStream(pcm(), Date.now() + 5000, "s3", true);
  assert.equal(r.text, "薰在吗兜底"); // 模拟 REST 把 44 字节头之后的文字标记当作识别结果
  assert.equal(sttHeaders["content-type"], "audio/wav; codecs=audio/pcm; samplerate=16000");
  hearing.setStreamFactory(() => { throw new Error("SDK 不可用"); }); // 连识别器都建不出来：同样兜底
  assert.equal((await hearing.hearStream(pcm(), Date.now() + 5000, "s4", true)).text, "薰在吗兜底");
  async function* short() { yield Buffer.alloc(1000); }
  assert.match((await hearing.hearStream(short(), Date.now() + 5000, "s5")).dropped!, /太短/);
});

test("收尾", () => { azure.close(); llm.close(); });
