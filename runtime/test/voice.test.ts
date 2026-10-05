// 语音：Azure 文本转语音的请求格式、配置与密钥保护（用本地模拟端点）。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

process.env.SPEECH_ALLOW_LOCAL_ENDPOINT = "1"; // 语音端点只接受 Azure 的域名；测试用本地模拟服务
process.env.QUETZAL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "quetzal-voice-"));
const { loadConfig } = await import("../src/config.ts");
loadConfig();
const voice = await import("../src/voice/azure.ts");

let last: { url: string; headers: http.IncomingHttpHeaders; body: string } | undefined;
const server = http.createServer((req, res) => {
  let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
    last = { url: req.url!, headers: req.headers, body };
    if (req.headers["ocp-apim-subscription-key"] !== "k-123456") { res.writeHead(401); return res.end("bad key"); }
    if (req.url === "/cognitiveservices/voices/list") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify([{ ShortName: "zh-CN-XiaoxiaoNeural", Locale: "zh-CN", Gender: "Female", LocalName: "晓晓", StyleList: ["cheerful", "gentle"] }, { ShortName: "en-US-AvaNeural", Locale: "en-US", Gender: "Female", LocalName: "Ava" }]));
    }
    res.writeHead(200, { "content-type": "audio/mpeg" }); res.end(Buffer.from("ID3fake-mp3"));
  });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));

test("未配置时给出明确提示", async () => {
  assert.equal(voice.speechStatus().configured, false);
  await assert.rejects(voice.synthesize("你好"), /还没有配置 Azure 语音密钥/);
});

test("配置：密钥只保存不返回", () => {
  const s = voice.setSpeech({ endpoint: `http://127.0.0.1:${(server.address() as any).port}`, key: "k-123456", voice: "zh-CN-XiaoxiaoNeural", style: "gentle", rate: "+10%" } as any);
  assert.equal(s.keyLastFour, "3456");
  assert.equal(s.configured, true);
  assert.ok(!JSON.stringify(s).includes("k-123456"));
  assert.equal(voice.setSpeech({ key: "" } as any).keyLastFour, "3456"); // 空密钥保留原值
});

test("SSML：语言取自音色、风格与韵律、转义", () => {
  const x = voice.ssml("a<b & 'c'", { voice: "en-US-AvaNeural", style: "", rate: "0%", pitch: "-5%", volume: "80" } as any);
  assert.match(x, /xml:lang="en-US"/);
  assert.match(x, /<voice name="en-US-AvaNeural"><prosody rate="0%" pitch="-5%" volume="80">a&lt;b &amp; &apos;c&apos;<\/prosody><\/voice>/);
  assert.match(voice.ssml("嗨", { voice: "zh-CN-XiaoxiaoNeural", style: "cheerful", rate: "0%", pitch: "0%", volume: "100" } as any), /<mstts:express-as style="cheerful">/);
});

test("合成：请求格式正确，音频保存到 data/media", async () => {
  const f = await voice.synthesize("你好", { style: "cheerful" });
  assert.equal(last!.url, "/cognitiveservices/v1");
  assert.equal(last!.headers["content-type"], "application/ssml+xml");
  assert.equal(last!.headers["x-microsoft-outputformat"], "audio-24khz-48kbitrate-mono-mp3");
  assert.match(last!.body, /style="cheerful"/); // 临时覆盖只影响这一次
  assert.match(last!.body, /rate="\+10%"/);
  assert.ok(f.endsWith(".mp3") && fs.readFileSync(f, "utf8") === "ID3fake-mp3");
});

test("音色列表按语言过滤", async () => {
  const v = await voice.listVoices("zh-CN");
  assert.deepEqual(v, [{ name: "zh-CN-XiaoxiaoNeural", locale: "zh-CN", gender: "Female", local: "晓晓", styles: ["cheerful", "gentle"] }]);
  server.close();
});
