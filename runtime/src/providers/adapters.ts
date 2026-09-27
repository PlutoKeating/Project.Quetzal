// 协议适配器：把统一的 ChatRequest 翻译成各家 HTTP 接口，并把响应翻译回来。只做非流式调用，保持代码最小。
import crypto from "node:crypto";
import { ProviderError, type ChatRequest, type ChatResult, type Msg, type Protocol, type ToolCall } from "./types.ts";

export interface Target { protocol: Protocol; baseUrl: string; apiKey: string; model: string; headers?: Record<string, string>; maxTokens: number }

const base = (u: string) => u.replace(/\/+$/, "");
const newId = () => "call_" + crypto.randomBytes(6).toString("hex");
const parseArgs = (s: unknown) => { try { return typeof s === "string" ? JSON.parse(s || "{}") : (s as any) ?? {}; } catch { return {}; } };

async function post(url: string, headers: Record<string, string>, body: unknown, timeoutMs = 120_000) {
  let res: Response;
  try {
    res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  } catch (e: any) { throw new ProviderError(`网络错误：${e.name === "TimeoutError" ? "超时" : e.message}`); }
  const text = await res.text();
  if (!res.ok) {
    const immediate = [400, 401, 403, 404].includes(res.status) || /invalid.*(key|model)|not.?found|unauthori|forbidden|unsupported/i.test(text);
    throw new ProviderError(`HTTP ${res.status}：${text.slice(0, 300)}`, res.status, immediate);
  }
  try { return JSON.parse(text); } catch { throw new ProviderError("响应不是 JSON"); }
}

// ---------- OpenAI Chat Completions（兼容绝大多数供应商：DeepSeek、OpenRouter、Kimi、GLM、Ollama……）
async function openaiCompletions(t: Target, r: ChatRequest): Promise<ChatResult> {
  const messages = r.messages.map((m) =>
    m.role === "assistant" ? { role: "assistant", content: m.content || null, ...(m.toolCalls?.length ? { tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } })) } : {}) }
    : m.role === "tool" ? { role: "tool", tool_call_id: m.toolCallId, content: m.content }
    : { role: m.role, content: m.content });
  const j = await post(`${base(t.baseUrl)}/chat/completions`, { authorization: `Bearer ${t.apiKey}`, ...t.headers }, {
    model: t.model, messages, max_tokens: r.maxTokens ?? t.maxTokens, temperature: r.temperature,
    ...(r.tools?.length ? { tools: r.tools.map((f) => ({ type: "function", function: f })) } : {}),
  });
  const msg = j.choices?.[0]?.message ?? {};
  return {
    text: msg.content ?? "", model: t.model,
    toolCalls: (msg.tool_calls ?? []).map((c: any) => ({ id: c.id || newId(), name: c.function.name, args: parseArgs(c.function.arguments) })),
    usage: { input: j.usage?.prompt_tokens ?? 0, output: j.usage?.completion_tokens ?? 0 },
  };
}

// ---------- OpenAI Responses
async function openaiResponses(t: Target, r: ChatRequest): Promise<ChatResult> {
  const input: unknown[] = [];
  let instructions = "";
  for (const m of r.messages) {
    if (m.role === "system") instructions += m.content + "\n";
    else if (m.role === "tool") input.push({ type: "function_call_output", call_id: m.toolCallId, output: m.content });
    else {
      if (m.content) input.push({ role: m.role, content: m.content });
      if (m.role === "assistant") for (const c of m.toolCalls ?? []) input.push({ type: "function_call", call_id: c.id, name: c.name, arguments: JSON.stringify(c.args) });
    }
  }
  const j = await post(`${base(t.baseUrl)}/responses`, { authorization: `Bearer ${t.apiKey}`, ...t.headers }, {
    model: t.model, input, instructions: instructions || undefined, max_output_tokens: r.maxTokens ?? t.maxTokens, store: false,
    ...(r.tools?.length ? { tools: r.tools.map((f) => ({ type: "function", ...f })) } : {}),
  });
  let text = ""; const toolCalls: ToolCall[] = [];
  for (const o of j.output ?? []) {
    if (o.type === "message") for (const c of o.content ?? []) if (c.type === "output_text") text += c.text;
    if (o.type === "function_call") toolCalls.push({ id: o.call_id, name: o.name, args: parseArgs(o.arguments) });
  }
  return { text, toolCalls, model: t.model, usage: { input: j.usage?.input_tokens ?? 0, output: j.usage?.output_tokens ?? 0 } };
}

// ---------- Anthropic Messages
async function anthropicMessages(t: Target, r: ChatRequest): Promise<ChatResult> {
  const system = r.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
  const messages: { role: string; content: any[] }[] = [];
  const push = (role: string, block: any) => {
    const last = messages.at(-1);
    if (last?.role === role) last.content.push(block); else messages.push({ role, content: [block] });
  };
  for (const m of r.messages) {
    if (m.role === "system") continue;
    if (m.role === "tool") push("user", { type: "tool_result", tool_use_id: m.toolCallId, content: m.content });
    else if (m.role === "assistant") {
      if (m.content) push("assistant", { type: "text", text: m.content });
      for (const c of m.toolCalls ?? []) push("assistant", { type: "tool_use", id: c.id, name: c.name, input: c.args });
    } else push("user", { type: "text", text: m.content });
  }
  const j = await post(`${base(t.baseUrl)}/messages`, { "x-api-key": t.apiKey, "anthropic-version": "2023-06-01", ...t.headers }, {
    model: t.model, system: system || undefined, messages, max_tokens: r.maxTokens ?? t.maxTokens, temperature: r.temperature,
    ...(r.tools?.length ? { tools: r.tools.map((f) => ({ name: f.name, description: f.description, input_schema: f.parameters })) } : {}),
  });
  let text = ""; const toolCalls: ToolCall[] = [];
  for (const b of j.content ?? []) {
    if (b.type === "text") text += b.text;
    if (b.type === "tool_use") toolCalls.push({ id: b.id, name: b.name, args: b.input ?? {} });
  }
  return { text, toolCalls, model: t.model, usage: { input: j.usage?.input_tokens ?? 0, output: j.usage?.output_tokens ?? 0 } };
}

// ---------- Google Generative AI（Gemini）
const geminiSchema = (s: any): any => {
  if (Array.isArray(s)) return s.map(geminiSchema);
  if (typeof s !== "object" || s === null) return s;
  const { additionalProperties, $schema, ...rest } = s;
  return Object.fromEntries(Object.entries(rest).map(([k, v]) => [k, geminiSchema(v)]));
};
async function google(t: Target, r: ChatRequest): Promise<ChatResult> {
  const system = r.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
  const contents: { role: string; parts: any[] }[] = [];
  const push = (role: string, part: any) => {
    const last = contents.at(-1);
    if (last?.role === role) last.parts.push(part); else contents.push({ role, parts: [part] });
  };
  for (const m of r.messages as Msg[]) {
    if (m.role === "system") continue;
    if (m.role === "tool") push("user", { functionResponse: { name: m.name, response: { content: m.content } } });
    else if (m.role === "assistant") {
      if (m.content) push("model", { text: m.content });
      for (const c of m.toolCalls ?? []) push("model", { functionCall: { name: c.name, args: c.args } });
    } else push("user", { text: m.content });
  }
  const j = await post(`${base(t.baseUrl)}/models/${t.model}:generateContent`, { "x-goog-api-key": t.apiKey, ...t.headers }, {
    contents, systemInstruction: system ? { parts: [{ text: system }] } : undefined,
    generationConfig: { maxOutputTokens: r.maxTokens ?? t.maxTokens, temperature: r.temperature },
    ...(r.tools?.length ? { tools: [{ functionDeclarations: r.tools.map((f) => ({ ...f, parameters: geminiSchema(f.parameters) })) }] } : {}),
  });
  let text = ""; const toolCalls: ToolCall[] = [];
  for (const p of j.candidates?.[0]?.content?.parts ?? []) {
    if (p.text) text += p.text;
    if (p.functionCall) toolCalls.push({ id: newId(), name: p.functionCall.name, args: p.functionCall.args ?? {} });
  }
  return { text, toolCalls, model: t.model, usage: { input: j.usageMetadata?.promptTokenCount ?? 0, output: j.usageMetadata?.candidatesTokenCount ?? 0 } };
}

export const adapters: Record<Protocol, (t: Target, r: ChatRequest) => Promise<ChatResult>> = {
  "openai-completions": openaiCompletions,
  "openai-responses": openaiResponses,
  "anthropic-messages": anthropicMessages,
  "google-generative-ai": google,
};

// 从供应商拉取模型列表（OpenAI 兼容 / Anthropic / Google 均提供 GET models）
export async function listRemoteModels(protocol: Protocol, baseUrl: string, apiKey: string): Promise<string[]> {
  const b = base(baseUrl);
  const [url, headers]: [string, Record<string, string>] =
    protocol === "anthropic-messages" ? [`${b}/models?limit=1000`, { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }]
    : protocol === "google-generative-ai" ? [`${b}/models?pageSize=1000`, { "x-goog-api-key": apiKey }]
    : [`${b}/models`, { authorization: `Bearer ${apiKey}` }];
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new ProviderError(`HTTP ${res.status}`, res.status);
  const j: any = await res.json();
  return (j.data ?? j.models ?? []).map((m: any) => String(m.id ?? m.name).replace(/^models\//, ""));
}
