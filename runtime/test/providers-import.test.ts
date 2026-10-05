// 从另一具身体导入模型供应商（带明文 Key）：逐个校验，不合格的保留本机原来的；任何失败都不会把本机的 Key 清空；API 地址只接受 HTTPS（本机回环除外）。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.QUETZAL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "quetzal-import-"));
const { loadConfig } = await import("../src/config.ts");
loadConfig();
const { openStore } = await import("../src/store.ts");
openStore();
const reg = await import("../src/providers/registry.ts");

const prov = (id: string, baseUrl: string, secret: string | undefined, model = `${id}-m`) => ({
  id, catalogId: "custom", name: id, baseUrl, protocol: "openai-completions" as const, enabled: true,
  keys: [{ id: `${id}-k`, label: "k", lastFour: "", enabled: true, secret }], models: [{ id: model, name: model, enabled: true, context: 8000, maxTokens: 512, sortOrder: 0 }],
});

test("导入：不合格的供应商保留本机原来的，合格的替换；Key 用本机主密钥重新加密", () => {
  reg.saveProviders({ providers: [prov("a", "https://a.example", "sk-local-aaaaaaaa"), prov("b", "https://b.example", "sk-local-bbbbbbbb")] }, reg.configVersion());
  const r = reg.importProviders({ providers: [
    prov("a", "http://evil.example", "sk-remote-aaaaaaaa"),   // 明文地址：拒绝，保留本机的 a
    prov("b", "https://b2.example", "sk-remote-bbbbbbbb"),     // 合格：替换
    prov("c", "https://c.example", "bad key with spaces"),     // Key 不合格：本机没有 c，不要
    prov("d", "http://127.0.0.1:9", "sk-remote-dddddddd"),     // 本机回环：可以
  ], quickModelId: "b-m" }, "pc（同步）");
  assert.equal(r.rejected.length, 2);
  assert.ok(r.rejected.every((x) => !x.includes("sk-")), "被拒的说明里没有密钥");
  const all = reg.exportProviders();
  assert.deepEqual(all.providers.map((p) => [p.id, p.baseUrl, p.keys[0].secret]), [
    ["a", "https://a.example", "sk-local-aaaaaaaa"], ["b", "https://b2.example", "sk-remote-bbbbbbbb"], ["d", "http://127.0.0.1:9", "sk-remote-dddddddd"],
  ]);
  assert.equal(all.quickModelId, "b-m");
});

test("导入整体格式不对：抛错，本机的 Key 一把都不少（内存与文件都不变）", () => {
  const before = JSON.stringify(reg.exportProviders());
  const file = fs.readFileSync(path.join(process.env.QUETZAL_HOME!, "config", "providers.json"), "utf8");
  assert.throws(() => reg.importProviders({ providers: "nope" } as any, "pc"));
  assert.throws(() => reg.importProviders(null as any, "pc"));
  assert.equal(JSON.stringify(reg.exportProviders()), before);
  assert.equal(fs.readFileSync(path.join(process.env.QUETZAL_HOME!, "config", "providers.json"), "utf8"), file);
  // 每一个都不合格：全部保留本机原来的
  reg.importProviders({ providers: [prov("a", "ftp://x", "sk-x-12345678"), { id: "b", name: "b" } as any, prov("d", "https://d.example", undefined)] }, "pc");
  assert.equal(JSON.stringify(reg.exportProviders().providers), JSON.stringify(JSON.parse(before).providers));
});

test("远端地址的判断", () => {
  for (const u of ["https://x.example/v1", "http://127.0.0.1:8080", "http://localhost:1", "http://[::1]:2"]) assert.equal(reg.remoteUrlOk(u), true, u);
  for (const u of ["http://x.example", "ftp://x", "javascript:alert(1)", 5, "not a url"]) assert.equal(reg.remoteUrlOk(u), false, String(u));
});
