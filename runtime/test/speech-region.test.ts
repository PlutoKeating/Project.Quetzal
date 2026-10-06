import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.QUETZAL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "quetzal-test-"));
const cfg = await import("../src/config.ts"); // 用命名空间读 config：saveConfig 会换掉整个对象
cfg.loadConfig();
const voice = await import("../src/voice/azure.ts");

/** 假的令牌接口：只有 owns 里的区域认这把密钥；记下问过哪些地址。 */
const fake = (owns: string[], seen: string[] = []) => (async (url: string | URL | Request, init?: RequestInit) => {
  const u = String(url); seen.push(u);
  const r = /^https:\/\/([a-z0-9]+)\.api\.cognitive\.microsoft\.com\/sts\/v1\.0\/issueToken$/.exec(u)?.[1] ?? "";
  const ok = owns.includes(r) && (init?.headers as Record<string, string>)["Ocp-Apim-Subscription-Key"] === "k-123456";
  return new Response(ok ? "token" : "", { status: ok ? 200 : 401 });
}) as typeof fetch;

test("只给密钥：自动找出区域并保存；只问微软自己的域名", async () => {
  const seen: string[] = [];
  const r = await voice.setSpeechAuto({ key: "k-123456" }, fake(["japaneast"], seen));
  assert.equal(r.region, "japaneast");
  assert.equal(cfg.config.speech.region, "japaneast");
  assert.equal(r.configured, true);
  assert.ok(seen.every((u) => /^https:\/\/[a-z0-9]+\.api\.cognitive\.microsoft\.com\//.test(u)));
});

test("几个区域都认时保留原来的区域；都不认时不保存并说明", async () => {
  assert.equal(await voice.detectRegion("k-123456", "eastus", fake(["japaneast", "eastus"])), "eastus");
  await assert.rejects(voice.setSpeechAuto({ key: "k-bad-0000" }, fake(["japaneast"])), /各个区域都不认/);
  assert.equal(cfg.config.speech.region, "japaneast");
});

test("指定了区域或用自定义端点时不探测", async () => {
  let asked = 0;
  const count = (async () => { asked++; return new Response("", { status: 401 }); }) as typeof fetch;
  await voice.setSpeechAuto({ key: "k-123456", region: "westeurope" }, count);
  assert.equal(cfg.config.speech.region, "westeurope");
  assert.equal(asked, 0);
});
