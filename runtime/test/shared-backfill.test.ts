// 补修订号：同步功能之前（或升级前）配好的模型、Key、设置没有修改时刻（修订号 0），两具身体都是 0 时谁也不拉谁。
// 启动时给本机有内容的分区补上（取数据文件的修改时刻）；空的、与缺省相同的不补，好让它从别处拉。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.QUETZAL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "quetzal-backfill-"));
const cfg = await import("../src/config.ts");
cfg.loadConfig();
const store = await import("../src/store.ts");
store.openStore();
const reg = await import("../src/providers/registry.ts");
const { backfillRevs } = await import("../src/mesh/shared.ts");

test("有内容、没有修订号的分区补上修订号；空的与缺省的不补；已有修订号的不动", () => {
  reg.saveProviders({ providers: [{ id: "p", catalogId: "custom", name: "P", baseUrl: "https://api.example.com/v1", protocol: "openai-completions" as const, enabled: true,
    keys: [{ id: "k", label: "k", lastFour: "", enabled: true, secret: "sk-test-000000000000" }], models: [{ id: "m", name: "m", enabled: true, context: 8000, maxTokens: 256, sortOrder: 0 }] }] }, reg.configVersion());
  cfg.saveConfig({ budget: { ...cfg.config.budget, dailyCostUsd: 7 } });
  // 模拟有同步功能之前配好的：修订号都还是 0
  cfg.config.sharedRev = {};
  fs.writeFileSync(path.join(cfg.paths.config, "quetzal.json"), JSON.stringify(cfg.config, null, 2));
  const t = fs.statSync(path.join(cfg.paths.config, "providers.json")).mtimeMs;
  const names = backfillRevs();
  assert.ok(names.includes("providers"));
  assert.ok(names.includes("budget"));
  assert.ok(!names.includes("speechKey"), "没有语音密钥");
  assert.ok(!names.includes("permissions"), "与缺省相同");
  assert.equal(cfg.config.sharedRev.providers, Math.floor(t), "取数据文件的修改时刻");
  // 再跑一次不变
  const before = { ...cfg.config.sharedRev };
  assert.deepEqual(backfillRevs(), []);
  assert.deepEqual(cfg.config.sharedRev, before);
});
