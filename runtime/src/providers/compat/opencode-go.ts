// OpenCode Go 兼容层（官方文档：https://opencode.ai/docs/go/ ；经验参考 Project.GoGoGo 的 optimizeProviderModel）。
//   - 端点固定为 https://opencode.ai/zen/go/v1（用户填成 …/chat/completions 等也会被规范化）
//   - 必须携带 x-opencode-session：每次对话一个稳定的会话 ID，用于路由与提示缓存（缺失时返回 400 MissingSessionID）
//   - User-Agent 必须标识客户端本身，不能是通用 SDK 名
//   - 不同模型使用不同的接口格式：见 RESPONSES / MESSAGES，其余为 Chat Completions
//   - 模型名可带 opencode-go/ 前缀，调用时去掉
import type { ProviderCompat } from "./index.ts";
import type { Protocol } from "../types.ts";
import { VERSION } from "../../version.ts";

export const OPENCODE_GO_BASE = "https://opencode.ai/zen/go/v1";

/** 走 OpenAI Responses 的模型（文档表格中 endpoint 为 responses）。 */
const RESPONSES = /^(?:grok-\d|gpt-\d|muse-spark-)/;
/** 走 Anthropic Messages 的模型（文档表格中 endpoint 为 messages）。 */
const MESSAGES = /^(?:minimax-m\d|qwen3\.\d)/;

export function openCodeGoProtocol(model: string): Protocol {
  if (RESPONSES.test(model)) return "openai-responses";
  if (MESSAGES.test(model)) return "anthropic-messages";
  return "openai-completions";
}

export const openCodeGo: ProviderCompat = {
  id: "opencode-go",
  matches(p) {
    if (p.catalogId === "opencode-go") return true;
    try {
      const u = new URL(p.baseUrl);
      return u.hostname === "opencode.ai" && /^\/zen\/go(?:\/|$)/.test(u.pathname);
    } catch { return false; }
  },
  adapt(t, ctx) {
    const model = t.model.replace(/^opencode-go\//, "");
    return {
      ...t,
      baseUrl: OPENCODE_GO_BASE,
      model,
      protocol: openCodeGoProtocol(model),
      headers: { ...t.headers, "user-agent": `agentic-life-runtime/${VERSION}`, "x-opencode-session": ctx.session },
    };
  },
};
