// 看图：图片识别与缩小、目录的「能否看图」判断、view_image 让下一次模型调用带上图片并选用能看图的模型。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFileSync } from "node:child_process";

process.env.WINDLER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "windler-img-"));
const { loadConfig } = await import("../src/config.ts");
loadConfig();
const store = await import("../src/store.ts");
store.openStore();
const { imageMime, loadImage } = await import("../src/mind/images.ts");
const { visionOf } = await import("../src/providers/catalog.ts");
const reg = await import("../src/providers/registry.ts");
const { converse } = await import("../src/mind/brain.ts");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "img-"));
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a5f2e2d20000000049454e44ae426082", "hex");

test("按扩展名或文件头识别图片", () => {
  assert.equal(imageMime("a.JPG"), "image/jpeg");
  assert.equal(imageMime("noext", PNG), "image/png");
  assert.equal(imageMime("x", Buffer.from([0xff, 0xd8, 0xff])), "image/jpeg");
  assert.equal(imageMime("x.txt", Buffer.from("hello")), undefined);
});

test("小图原样读取；大图缩小到长边 1600 像素", async (t) => {
  const small = path.join(dir, "s.png"); fs.writeFileSync(small, PNG);
  const r = await loadImage(small);
  assert.equal(r.image.mime, "image/png");
  assert.equal(r.note, "");
  await assert.rejects(loadImage(path.join(dir, "none.png")), /没有这个文件/);
  const txt = path.join(dir, "a.txt"); fs.writeFileSync(txt, "hi");
  await assert.rejects(loadImage(txt), /不是可识别的图片/);
  let hasFfmpeg = true;
  try { execFileSync("ffmpeg", ["-version"]); } catch { hasFfmpeg = false; }
  if (!hasFfmpeg) return t.skip("没有 ffmpeg，跳过缩图测试");
  const big = path.join(dir, "big.png");
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "nullsrc=s=3000x2000,geq=random(1)*255:128:128", "-frames:v", "1", big]); // 随机噪声，压缩不了，确保是大图
  assert.ok(fs.statSync(big).size > 1_500_000);
  const b = await loadImage(big);
  assert.equal(b.image.mime, "image/jpeg");
  assert.match(b.note, /已缩小到长边 1600 像素/);
  assert.ok(Buffer.from(b.image.data, "base64").length < 1_500_000);
  // 每个可用的缩图工具都要能单独工作（此前 ffmpeg 参数带了引号，在不经过 shell 时会失败，被后备工具掩盖）
  const { shrink } = await import("../src/mind/images.ts");
  for (const tool of ["ffmpeg", "magick"] as const) {
    try { execFileSync(tool, ["-version"]); } catch { continue; }
    const out = await shrink(big, tool);
    assert.ok(out && fs.statSync(out).size > 0, `${tool} 缩图失败`);
    fs.rmSync(out!);
  }
});

test("目录里的「能否看图」只看输入模态", () => {
  assert.equal(visionOf({ modalities: { input: ["text", "image"] }, attachment: true }), true);
  assert.equal(visionOf({ modalities: { input: ["text"] }, attachment: true }), false); // 能收文件 ≠ 能看图
  assert.equal(visionOf({ attachment: true }), true); // 没有模态信息时才参考 attachment
});

test("view_image：下一次模型调用带上图片，并只发给能看图的模型", async () => {
  const img = path.join(dir, "photo.png"); fs.writeFileSync(img, PNG);
  const seen: any[] = [];
  const server = http.createServer((req, res) => {
    let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
      const j = JSON.parse(body); seen.push(j);
      const hasImage = j.messages.some((m: any) => Array.isArray(m.content) && m.content.some((c: any) => c.type === "image_url"));
      const msg = seen.length === 1
        ? { content: "", tool_calls: [{ id: "v1", type: "function", function: { name: "view_image", arguments: JSON.stringify({ paths: [img] }) } }] }
        : { content: hasImage ? `看到了（模型 ${j.model}）` : "看不到" };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: msg }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  reg.saveProviders({ providers: [{ id: "p", catalogId: "custom", name: "Mock", baseUrl: base, protocol: "openai-completions" as const, enabled: true,
    keys: [{ id: "k", label: "k", lastFour: "", enabled: true, secret: "sk-mock-000000" }],
    models: [{ id: "a", name: "text-only", enabled: true, context: 8000, maxTokens: 256, sortOrder: 0, vision: false },
             { id: "b", name: "eyes", enabled: true, context: 8000, maxTokens: 256, sortOrder: 1, vision: true }] }] }, reg.configVersion());
  const reply = await converse("你", "看看你刚拍的照片", "控制台", { conv: "img" });
  server.close();
  assert.equal(reply, "看到了（模型 eyes）");
  assert.equal(seen[0].model, "text-only"); // 没有图片时照常按顺序
  const last = seen[1].messages.at(-1);
  assert.match(last.content[0].text, /你用 view_image 请求查看的 1 张图片/);
  assert.equal(last.content[1].type, "image_url");
});

test("没有任何缩图工具时，JPEG 用内置的 jpeg-js 缩小（手机上不必装 ffmpeg）", async () => {
  const { shrink, shrinkJpegJs } = await import("../src/mind/images.ts");
  const jpeg = (await import("jpeg-js")).default;
  // 3000×2000 随机噪声 JPEG：压不小，确保走缩图
  const w = 3000, h = 2000, data = Buffer.alloc(w * h * 4);
  for (let i = 0; i < data.length; i += 4) { data[i] = Math.random() * 255; data[i + 1] = Math.random() * 255; data[i + 2] = Math.random() * 255; data[i + 3] = 255; }
  const big = path.join(dir, "big.jpg");
  fs.writeFileSync(big, jpeg.encode({ data, width: w, height: h }, 95).data);
  assert.ok(fs.statSync(big).size > 1_500_000);
  const out = await shrink(big, "jpeg-js");
  assert.ok(out && fs.existsSync(out));
  const small = jpeg.decode(fs.readFileSync(out!));
  assert.equal(small.width, 1600); assert.equal(small.height, 1067);
  fs.rmSync(out!);
  // 小图不放大
  const tiny = path.join(dir, "tiny.jpg"), tout = path.join(dir, "tiny-out.jpg");
  fs.writeFileSync(tiny, jpeg.encode({ data: Buffer.alloc(8 * 8 * 4, 200), width: 8, height: 8 }, 90).data);
  assert.ok(shrinkJpegJs(tiny, tout));
  assert.equal(jpeg.decode(fs.readFileSync(tout)).width, 8);
  // 不是 JPEG（或损坏）时返回 false，由上层决定是否原图直发
  assert.equal(shrinkJpegJs(path.join(dir, "s.png"), tout), false);
});
