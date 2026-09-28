import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

process.env.WINDLER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "windler-test-"));
const { loadConfig } = await import("../src/config.ts");
loadConfig();
const { openStore } = await import("../src/store.ts");
openStore();
const reg = await import("../src/providers/registry.ts");
const router = await import("../src/providers/router.ts");

// 模拟一个 OpenAI 兼容供应商：第一个模型返回 401，第二个正常并调用工具
const server = http.createServer((req, res) => {
  let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
    const j = JSON.parse(body);
    if (j.model === "bad") { res.writeHead(401); return res.end("invalid api key"); }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "OK", tool_calls: [{ id: "c1", type: "function", function: { name: "recall", arguments: "{\"query\":\"x\"}" } }] } }], usage: { prompt_tokens: 10, completion_tokens: 2 } }));
  });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as any).port}`;

test("保存：版本号防覆盖、密钥加密且只返回末四位", () => {
  const v = reg.configVersion();
  const draft = { providers: [{ id: "p1", catalogId: "custom", name: "Mock", baseUrl: base, protocol: "openai-completions" as const, enabled: true,
    keys: [{ id: "k1", label: "prod", lastFour: "", enabled: true, secret: "sk-test-123456" }],
    models: [{ id: "m1", name: "bad", enabled: true, context: 8000, maxTokens: 512, sortOrder: 0 }, { id: "m2", name: "good", enabled: true, context: 8000, maxTokens: 512, sortOrder: 1 }] }] };
  const saved = reg.saveProviders(draft, v);
  assert.equal(saved.providers[0].keys[0].lastFour, "3456");
  assert.equal((saved.providers[0].keys[0] as any).ciphertext, undefined);
  assert.ok(!fs.readFileSync(path.join(process.env.WINDLER_HOME!, "config/providers.json"), "utf8").includes("sk-test-123456"));
  assert.throws(() => reg.saveProviders(draft, v), /已被其他地方修改/);
});

test("故障转移：鉴权失败的模型被跳过，工具调用被解析", async () => {
  const r = await router.chat({ messages: [{ role: "user", content: "hi" }] });
  assert.equal(r.model, "Mock/good");
  assert.equal(r.toolCalls[0].name, "recall");
  assert.deepEqual(r.toolCalls[0].args, { query: "x" });
  server.close();
});
