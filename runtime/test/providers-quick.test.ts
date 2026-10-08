import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.QUETZAL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "quetzal-test-"));
const { loadConfig, paths } = await import("../src/config.ts");
loadConfig();
const { openStore } = await import("../src/store.ts");
openStore();
const reg = await import("../src/providers/registry.ts");
const { quickSetup, rankCandidates } = await import("../src/providers/quick.ts");

const m = (id: string, released: string, output = 1, toolCall = true, extra: Record<string, unknown> = {}) => ({ id, name: id, context: 64000, output: 8192, toolCall, released, cost: { input: 0.1, output }, text: true, ...extra });
fs.mkdirSync(paths.data, { recursive: true });
fs.writeFileSync(path.join(paths.data, "catalog.json"), JSON.stringify({ fetchedAt: Date.now(), providers: [
  { id: "acme", name: "Acme", api: "https://api.acme.example/v1", protocol: "openai-completions", models: [
    m("acme-old", "2024-01-01", 2), m("acme-new", "2026-05-01", 4), m("acme-new-mini", "2026-05-01", 1), m("acme-next-preview", "2026-09-01", 9, true, { status: "beta" }),
    m("acme-embed-3", "2026-06-01", 0, true, { text: false }), m("acme-notools", "2026-07-01", 3, false),
  ] },
] }));

test("候选：按目录标的状态（不按名字猜预览版）、新的在前、同一天的贵的在前；不能调工具的、输出没有文字的不选；供应商列出的才选", () => {
  const ids = (r: { id: string }[]) => r.map((x) => x.id);
  const all = JSON.parse(fs.readFileSync(path.join(paths.data, "catalog.json"), "utf8")).providers[0].models;
  assert.deepEqual(ids(rankCandidates(all, [])), ["acme-new", "acme-new-mini", "acme-old", "acme-next-preview"]);
  assert.deepEqual(ids(rankCandidates(all, ["acme-old", "acme-new-mini"])), ["acme-new-mini", "acme-old"]);
});

test("一个 Key 接好：不通的跳过、留下两个试通的，比主力便宜的那个当内省模型；Key 加密保存", async () => {
  const tried: string[] = [];
  const r = await quickSetup({ catalogId: "acme", key: "sk-acme-123456" }, "test", {
    remote: async () => [],
    test: async (_p, model) => { tried.push(model); return model === "acme-new" ? { ok: true, latencyMs: 1, message: "OK" } : model === "acme-new-mini" ? { ok: false, latencyMs: 1, message: "限流或额度不足：x" } : { ok: true, latencyMs: 1, message: "OK" }; },
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.models, ["acme-new", "acme-old"]);
  assert.deepEqual(tried, ["acme-new", "acme-new-mini", "acme-old"]);
  const c = reg.loadProviders();
  assert.equal(c.providers.length, 1);
  assert.deepEqual(c.providers[0].models.map((x) => x.name).sort(), ["acme-new", "acme-old"]);
  assert.equal(c.quickModelId, c.providers[0].models.find((x) => x.name === "acme-old")!.id); // 比主力 acme-new 便宜
  assert.equal(c.providers[0].keys[0].lastFour, "3456");
  assert.ok(!fs.readFileSync(path.join(paths.config, "providers.json"), "utf8").includes("sk-acme-123456"));
});

test("Key 不对：试一次就停，原来能用的 Key 与模型原样保留", async () => {
  const before = JSON.stringify(reg.publicView());
  let n = 0;
  const r = await quickSetup({ catalogId: "acme", key: "sk-wrong-000000" }, "test", { remote: async () => [], test: async () => { n++; return { ok: false, latencyMs: 1, message: "鉴权失败：Key 无效：401", status: 401 }; } });
  assert.equal(r.ok, false);
  assert.match(r.message, /鉴权失败/);
  assert.equal(n, 1);
  assert.equal(JSON.stringify(reg.publicView()), before);
});

test("同一个供应商换一把新 Key：已配着的模型只试不重复加，通了就换掉旧 Key", async () => {
  const r = await quickSetup({ catalogId: "acme", key: "sk-fresh-777777" }, "test", { remote: async () => [], test: async () => ({ ok: true, latencyMs: 1, message: "OK" }) });
  assert.equal(r.ok, true);
  const p = reg.loadProviders().providers;
  assert.equal(p.length, 1);
  assert.deepEqual(p[0].keys.map((k) => k.lastFour), ["7777"]);
  assert.equal(new Set(p[0].models.map((m) => m.name)).size, p[0].models.length);
});

test("粘错的 Key 与不存在的供应商当场拒绝", async () => {
  await assert.rejects(quickSetup({ catalogId: "acme", key: "你好 世界" }, "test"), /Key/);
  await assert.rejects(quickSetup({ catalogId: "nope", key: "sk-acme-123456" }, "test"), /没有这个供应商/);
});
