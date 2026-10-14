// 模型调用层的统一类型。四种协议覆盖几乎所有供应商：OpenAI 兼容、OpenAI Responses、Anthropic、Google。
export type Protocol = "openai-completions" | "openai-responses" | "anthropic-messages" | "google-generative-ai";
export const PROTOCOLS: Protocol[] = ["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"];

export interface ProviderKey { id: string; label: string; lastFour: string; enabled: boolean; ciphertext?: string; secret?: string }
export interface ProviderModel {
  // context 是窗口元数据，不驱动自动裁剪 / 压缩；maxTokens 是输出默认值，请求显式给 maxTokens 时覆盖它。
  id: string; name: string; enabled: boolean; context: number; maxTokens: number; sortOrder: number;
  cost?: { input: number; output: number }; // 美元 / 百万 token
  vision?: boolean; // 能否看图；未设置时按公共目录里的输入模态，查不到就当不能（见 router.ts 的 canSee）
}
export interface Provider {
  id: string; catalogId: string; name: string; baseUrl: string; protocol: Protocol; enabled: boolean;
  headers?: Record<string, string>;
  keys: ProviderKey[]; models: ProviderModel[];
}
export interface ProviderConfig { providers: Provider[]; quickModelId?: string } // quick：内省等轻量调用优先使用

// 保持现有供应商调用方的导入路径；协议由独立引擎维护。
export type { ToolCall, ImagePart, Msg, ToolDef, ChatRequest, ChatResult } from "../../../engine/src/types.ts";

export class ProviderError extends Error {
  status: number; immediate: boolean;
  constructor(message: string, status = 0, immediate = false) { super(message); this.status = status; this.immediate = immediate; }
}
