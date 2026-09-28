// 路由与故障转移：按全局模型顺序依次尝试；每个模型内轮换其供应商的已启用 Key。
// 鉴权/参数/模型不存在类错误立即换下一个模型；限流、超时、5xx 先换 Key 再换模型。
import { adapters, listRemoteModels, type Target } from "./adapters.ts";
import { loadProviders, keySecret } from "./registry.ts";
import { ProviderError, type ChatRequest, type ChatResult, type Provider, type ProviderModel } from "./types.ts";
import { addUsage } from "../store.ts";
import { applyCompat, compatFor } from "./compat/index.ts";
import crypto from "node:crypto";
import { log } from "../log.ts";

interface Route { provider: Provider; model: ProviderModel }
const cursor = new Map<string, number>(); // provider id → 下一次使用的 key 下标（轮换）

export function routes(): Route[] {
  return loadProviders().providers
    .filter((p) => p.enabled && p.keys.some((k) => k.enabled))
    .flatMap((provider) => provider.models.filter((m) => m.enabled).map((model) => ({ provider, model })))
    .sort((a, b) => a.model.sortOrder - b.model.sortOrder);
}

function target(r: Route, keyId: string, session: string): Target {
  const t: Target = { protocol: r.provider.protocol, baseUrl: r.provider.baseUrl, apiKey: keySecret(r.provider, keyId), model: r.model.name, headers: r.provider.headers, maxTokens: r.model.maxTokens };
  return applyCompat(r.provider, t, { session }); // 仅对需要的供应商生效（如 OpenCode Go）
}

export async function chat(req: ChatRequest, opts: { quick?: boolean } = {}): Promise<ChatResult> {
  let list = routes();
  const quickId = loadProviders().quickModelId;
  if (opts.quick && quickId) list = [...list.filter((r) => r.model.id === quickId), ...list.filter((r) => r.model.id !== quickId)];
  if (!list.length) throw new ProviderError("尚未配置可用的模型：请在控制台「模型」页添加供应商、Key 和模型", 0, true);
  const errors: string[] = [];
  const session = req.session ?? crypto.randomUUID();
  for (const r of list) {
    const keys = r.provider.keys.filter((k) => k.enabled);
    const start = cursor.get(r.provider.id) ?? 0;
    for (let i = 0; i < Math.min(keys.length, 2); i++) {
      const key = keys[(start + i) % keys.length];
      cursor.set(r.provider.id, (start + i + 1) % keys.length);
      try {
        const t = target(r, key.id, session);
        const res = await adapters[t.protocol](t, req);
        const c = r.model.cost;
        addUsage(`${r.provider.name}/${r.model.name}`, res.usage.input, res.usage.output,
          c ? (res.usage.input * c.input + res.usage.output * c.output) / 1e6 : 0);
        res.model = `${r.provider.name}/${r.model.name}`;
        return res;
      } catch (e: any) {
        errors.push(`${r.provider.name}/${r.model.name}: ${e.message}`);
        log("router", `失败 ${r.provider.name}/${r.model.name}（key ${key.label}）：${e.message}`);
        if (e instanceof ProviderError && e.immediate) break; // 直接换模型
      }
    }
  }
  throw new ProviderError("所有模型都调用失败：\n" + errors.join("\n"));
}

/** 连通性测试：用指定供应商的第一个启用 Key 让模型回复 OK。 */
export async function testModel(providerId: string, modelName: string) {
  const p = loadProviders().providers.find((x) => x.id === providerId);
  const key = p?.keys.find((k) => k.enabled);
  if (!p || !key) return { ok: false, latencyMs: 0, message: "请先保存供应商并启用至少一个 Key" };
  const t0 = Date.now();
  try {
    const t = applyCompat(p, { protocol: p.protocol, baseUrl: p.baseUrl, apiKey: keySecret(p, key.id), model: modelName, headers: p.headers, maxTokens: 512 }, { session: crypto.randomUUID() });
    // 预算留足：推理模型会先用掉一部分 token 思考，32 个 token 往往只够思考、没有输出
    const r = await adapters[t.protocol](t, { messages: [{ role: "user", content: "Reply with OK." }], maxTokens: 512 });
    return { ok: true, latencyMs: Date.now() - t0, message: r.text.slice(0, 80) || "(空回复)" };
  } catch (e: any) {
    return { ok: false, latencyMs: Date.now() - t0, message: friendly(e) };
  }
}

/** 给用户看的失败原因：分类说明 + 供应商返回的简短原文（便于判断是配置问题还是套餐限制）。 */
function friendly(e: any): string {
  const s = e.status;
  const cause = s === 401 ? "鉴权失败：Key 无效" : s === 403 ? "无权访问该模型" : s === 404 ? "模型或接口地址不存在"
    : s === 429 ? "限流或额度不足" : s >= 500 ? `供应商服务错误（${s}）` : "";
  const detail = String(e.message ?? "").replace(/^HTTP \d+：/, "").slice(0, 160);
  return cause ? `${cause}：${detail}` : detail || "未知错误";
}

export async function remoteModels(providerId: string) {
  const p = loadProviders().providers.find((x) => x.id === providerId);
  const key = p?.keys.find((k) => k.enabled);
  if (!p || !key) throw new ProviderError("请先保存供应商并启用至少一个 Key");
  // 有兼容层的供应商（如 OpenCode Go）按其规范化后的地址，用 OpenAI 风格的 GET /models 列举
  const t = applyCompat(p, { protocol: p.protocol, baseUrl: p.baseUrl, apiKey: "", model: "", maxTokens: 0 }, { session: crypto.randomUUID() });
  return listRemoteModels(compatFor(p) ? "openai-completions" : p.protocol, t.baseUrl, keySecret(p, key.id));
}
