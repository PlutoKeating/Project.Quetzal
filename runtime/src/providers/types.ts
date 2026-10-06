// 模型调用层的统一类型。四种协议覆盖几乎所有供应商：OpenAI 兼容、OpenAI Responses、Anthropic、Google。
export type Protocol = "openai-completions" | "openai-responses" | "anthropic-messages" | "google-generative-ai";
export const PROTOCOLS: Protocol[] = ["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"];

export interface ProviderKey { id: string; label: string; lastFour: string; enabled: boolean; ciphertext?: string; secret?: string }
export interface ProviderModel {
  id: string; name: string; enabled: boolean; context: number; maxTokens: number; sortOrder: number;
  cost?: { input: number; output: number }; // 美元 / 百万 token
  vision?: boolean; // 能否看图；未设置时按公共目录与模型名推断（见 router.ts 的 canSee）
}
export interface Provider {
  id: string; catalogId: string; name: string; baseUrl: string; protocol: Protocol; enabled: boolean;
  headers?: Record<string, string>;
  keys: ProviderKey[]; models: ProviderModel[];
}
export interface ProviderConfig { providers: Provider[]; quickModelId?: string } // quick：内省等轻量调用优先使用

export interface ToolCall { id: string; name: string; args: Record<string, unknown> }
export interface ImagePart { mime: string; data: string } // data：base64
export type Msg =
  | { role: "system" | "user"; content: string; images?: ImagePart[] } // images 只用于 user
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; content: string; toolCallId: string; name: string };
export interface ToolDef { name: string; description: string; parameters: Record<string, unknown> }
export interface ChatRequest {
  messages: Msg[]; tools?: ToolDef[]; maxTokens?: number; temperature?: number;
  session?: string; // 一次对话的稳定标识（同一次醒来 / 同一段交谈的多轮调用相同），供需要的供应商使用
  signal?: AbortSignal; // 外部中止（会话时间墙）
  onChunk?: () => void; // 收到任何流数据块（用于重置会话时间墙）
  onText?: (text: string) => void; // 流式文字片段
}
export interface ChatResult { text: string; toolCalls: ToolCall[]; usage: { input: number; output: number }; model: string; truncated?: boolean } // truncated：输出到了长度上限（max_tokens）被截断

export class ProviderError extends Error {
  status: number; immediate: boolean;
  constructor(message: string, status = 0, immediate = false) { super(message); this.status = status; this.immediate = immediate; }
}
