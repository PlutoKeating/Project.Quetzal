// 供应商兼容层：只对 OpenCode Go 自动生效，其他供应商不受影响。
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyCompat, compatFor } from "../src/providers/compat/index.ts";
import { openCodeGoProtocol, OPENCODE_GO_BASE } from "../src/providers/compat/opencode-go.ts";
import type { Target } from "../src/providers/adapters.ts";

const t = (baseUrl: string, model: string): Target => ({ protocol: "openai-completions", baseUrl, apiKey: "k", model, maxTokens: 1024 });

test("识别 OpenCode Go：目录 ID 或 opencode.ai/zen/go 地址", () => {
  assert.ok(compatFor({ catalogId: "opencode-go", name: "x", baseUrl: "https://example.com" }));
  assert.ok(compatFor({ catalogId: "custom", name: "我的 Go", baseUrl: "https://opencode.ai/zen/go/v1/chat/completions" }));
  assert.equal(compatFor({ catalogId: "opencode", name: "OpenCode Zen", baseUrl: "https://opencode.ai/zen/v1" }), undefined);
  assert.equal(compatFor({ catalogId: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com" }), undefined);
});

test("按官方文档的表格选择接口格式", () => {
  for (const m of ["grok-4.7", "grok-4.6", "gpt-6-luna", "gpt-5.6-luna", "muse-spark-1.3-contributor", "muse-spark-1.2-contributor"]) assert.equal(openCodeGoProtocol(m), "openai-responses", m);
  for (const m of ["minimax-m3", "minimax-m2.7", "minimax-m2.5", "qwen3.8-max", "qwen3.8-flash", "qwen3.7-max", "qwen3.7-plus", "qwen3.6-plus"]) assert.equal(openCodeGoProtocol(m), "anthropic-messages", m);
  for (const m of ["glm-5.3-flash", "kimi-k3", "kimi-k2.7-code", "longcat-2.0", "deepseek-v4.1-flash", "deepseek-v4-flash-vision-exp", "mimo-v2.5", "mimo-v2.6-pro", "hy4-preview", "hy3", "space-bunny-free", "longcat-2.5-preview-free"]) assert.equal(openCodeGoProtocol(m), "openai-completions", m);
});

test("调整调用目标：规范化端点、去掉模型前缀、携带会话与客户端标识", () => {
  const p = { catalogId: "opencode-go", name: "OpenCode Go", baseUrl: "https://opencode.ai/zen/go/v1/chat/completions" };
  const a = applyCompat(p, t(p.baseUrl, "opencode-go/gpt-6-luna"), { session: "s-1" });
  assert.equal(a.baseUrl, OPENCODE_GO_BASE);
  assert.equal(a.model, "gpt-6-luna");
  assert.equal(a.protocol, "openai-responses");
  assert.equal(a.headers?.["x-opencode-session"], "s-1");
  assert.match(a.headers?.["user-agent"] ?? "", /^agentic-life-runtime\//);
  const b = applyCompat(p, t(p.baseUrl, "mimo-v2.5"), { session: "s-1" });
  assert.equal(b.protocol, "openai-completions");
});

test("其他供应商保持原样", () => {
  const p = { catalogId: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com" };
  const orig = t(p.baseUrl, "deepseek-chat");
  assert.deepEqual(applyCompat(p, orig, { session: "s" }), orig);
});
