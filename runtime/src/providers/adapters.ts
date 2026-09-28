// 协议适配器：把统一的 ChatRequest 翻译成各家 HTTP 接口（流式 SSE），并把响应翻译回来。
// 模型调用时间墙按「无数据」计时：每收到一个数据块就重置，LLM_IDLE_MS 内没有任何数据才中止；
// 另有 LLM_MAX_MS 绝对上限防止只发心跳不出内容的死流。供应商不支持流式、直接返回 JSON 时按非流式解析。
import crypto from "node:crypto";
import { ProviderError, type ChatRequest, type ChatResult, type Msg, type Protocol, type ToolCall } from "./types.ts";

export const LLM_IDLE_MS = 90_000;
export const LLM_MAX_MS = 15 * 60_000;

export interface Target { protocol: Protocol; baseUrl: string; apiKey: string; model: string; headers?: Record<string, string>; maxTokens: number }

const base = (u: string) => u.replace(/\/+$/, "");
const newId = () => "call_" + crypto.randomBytes(6).toString("hex");
const parseArgs = (s: unknown) => { try { return typeof s === "string" ? JSON.parse(s || "{}") : (s as any) ?? {}; } catch { return {}; } };

/**
 * 发起流式请求，逐个回调 SSE 事件（data 已解析为 JSON）。
 * 返回 undefined 表示流正常结束；若供应商返回的是普通 JSON，则返回该 JSON 由调用方按非流式解析。
 */
async function sse(url: string, headers: Record<string, string>, body: unknown, r: ChatRequest, onEvent: (data: any, event: string) => void): Promise<any> {
  const ac = new AbortController();
  let why = "";
  const kill = (w: string) => { if (!why) { why = w; ac.abort(); } };
  let idle = setTimeout(() => kill("idle"), LLM_IDLE_MS);
  const hard = setTimeout(() => kill("max"), LLM_MAX_MS);
  const touch = () => { clearTimeout(idle); idle = setTimeout(() => kill("idle"), LLM_IDLE_MS); r.onChunk?.(); };
  const outer = () => kill("session");
  if (r.signal?.aborted) kill("session"); else r.signal?.addEventListener("abort", outer, { once: true });
  const fail = (e: any): never => {
    if (e instanceof ProviderError) throw e;
    if (why === "session") throw new ProviderError("会话已中止", 0, true);
    if (why === "idle") throw new ProviderError(`网络错误：超时（${LLM_IDLE_MS / 1000} 秒没有收到任何数据）`);
    if (why === "max") throw new ProviderError(`网络错误：超时（单次调用超过 ${LLM_MAX_MS / 60_000} 分钟）`);
    throw new ProviderError(`网络错误：${e?.message ?? e}`);
  };
  try {
    let res: Response;
    try {
      res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "text/event-stream", ...headers }, body: JSON.stringify(body), signal: ac.signal });
    } catch (e) { return fail(e); }
    touch();
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const immediate = [400, 401, 403, 404].includes(res.status) || /invalid.*(key|model)|not.?found|unauthori|forbidden|unsupported/i.test(text);
      throw new ProviderError(`HTTP ${res.status}：${text.slice(0, 300)}`, res.status, immediate);
    }
    if (!(res.headers.get("content-type") ?? "").includes("text/event-stream")) {
      const text = await res.text().catch(fail);
      try { return JSON.parse(text); } catch { throw new ProviderError("响应不是 JSON"); }
    }
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "", event = "", data: string[] = [];
    const dispatch = () => {
      if (data.length) {
        const s = data.join("\n");
        if (s !== "[DONE]") { let j: any; try { j = JSON.parse(s); } catch { j = undefined; } if (j !== undefined) onEvent(j, event); }
      }
      event = ""; data = [];
    };
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try { chunk = await reader.read(); } catch (e) { return fail(e); }
      if (chunk.done) break;
      touch();
      buf += dec.decode(chunk.value, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, ""); buf = buf.slice(i + 1);
        if (line === "") dispatch();
        else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
        else if (line.startsWith("event:")) event = line.slice(6).trim();
      }
    }
    if (buf.startsWith("data:")) data.push(buf.slice(5).replace(/^ /, ""));
    dispatch();
    return undefined;
  } finally {
    clearTimeout(idle); clearTimeout(hard);
    r.signal?.removeEventListener("abort", outer);
  }
}

const streamError = (e: unknown) => new ProviderError(`流错误：${(typeof e === "string" ? e : JSON.stringify(e)).slice(0, 300)}`);

// ---------- OpenAI Chat Completions（兼容绝大多数供应商：DeepSeek、OpenRouter、Kimi、GLM、Ollama……）
async function openaiCompletions(t: Target, r: ChatRequest): Promise<ChatResult> {
  const messages = r.messages.map((m) =>
    m.role === "assistant" ? { role: "assistant", content: m.content || null, ...(m.toolCalls?.length ? { tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } })) } : {}) }
    : m.role === "tool" ? { role: "tool", tool_call_id: m.toolCallId, content: m.content }
    : m.role === "user" && m.images?.length ? { role: "user", content: [{ type: "text", text: m.content }, ...m.images.map((i) => ({ type: "image_url", image_url: { url: `data:${i.mime};base64,${i.data}` } }))] }
    : { role: m.role, content: m.content });
  let text = ""; const usage = { input: 0, output: 0 };
  const calls: { id: string; name: string; args: string }[] = [];
  const j = await sse(`${base(t.baseUrl)}/chat/completions`, { authorization: `Bearer ${t.apiKey}`, ...t.headers }, {
    model: t.model, messages, max_tokens: r.maxTokens ?? t.maxTokens, temperature: r.temperature,
    stream: true, stream_options: { include_usage: true },
    ...(r.tools?.length ? { tools: r.tools.map((f) => ({ type: "function", function: f })) } : {}),
  }, r, (c) => {
    if (c.error) throw streamError(c.error);
    if (c.usage) { usage.input = c.usage.prompt_tokens ?? 0; usage.output = c.usage.completion_tokens ?? 0; }
    const d = c.choices?.[0]?.delta;
    if (!d) return;
    if (d.content) { text += d.content; r.onText?.(d.content); }
    for (const tc of d.tool_calls ?? []) {
      const x = (calls[tc.index ?? calls.length] ??= { id: "", name: "", args: "" });
      if (tc.id) x.id = tc.id;
      if (tc.function?.name) x.name ||= tc.function.name;
      if (tc.function?.arguments) x.args += tc.function.arguments;
    }
  });
  if (j) {
    const msg = j.choices?.[0]?.message ?? {};
    return {
      text: msg.content ?? "", model: t.model,
      toolCalls: (msg.tool_calls ?? []).map((c: any) => ({ id: c.id || newId(), name: c.function.name, args: parseArgs(c.function.arguments) })),
      usage: { input: j.usage?.prompt_tokens ?? 0, output: j.usage?.completion_tokens ?? 0 },
    };
  }
  return { text, model: t.model, usage, toolCalls: calls.filter((c) => c?.name).map((c) => ({ id: c.id || newId(), name: c.name, args: parseArgs(c.args) })) };
}

// ---------- OpenAI Responses
function parseResponses(j: any, t: Target): ChatResult {
  let text = ""; const toolCalls: ToolCall[] = [];
  for (const o of j.output ?? []) {
    if (o.type === "message") for (const c of o.content ?? []) if (c.type === "output_text") text += c.text;
    if (o.type === "function_call") toolCalls.push({ id: o.call_id, name: o.name, args: parseArgs(o.arguments) });
  }
  return { text, toolCalls, model: t.model, usage: { input: j.usage?.input_tokens ?? 0, output: j.usage?.output_tokens ?? 0 } };
}
async function openaiResponses(t: Target, r: ChatRequest): Promise<ChatResult> {
  const input: unknown[] = [];
  let instructions = "";
  for (const m of r.messages) {
    if (m.role === "system") instructions += m.content + "\n";
    else if (m.role === "tool") input.push({ type: "function_call_output", call_id: m.toolCallId, output: m.content });
    else {
      if (m.role === "user" && m.images?.length) input.push({ role: "user", content: [{ type: "input_text", text: m.content }, ...m.images.map((i) => ({ type: "input_image", image_url: `data:${i.mime};base64,${i.data}` }))] });
      else if (m.content) input.push({ role: m.role, content: m.content });
      if (m.role === "assistant") for (const c of m.toolCalls ?? []) input.push({ type: "function_call", call_id: c.id, name: c.name, arguments: JSON.stringify(c.args) });
    }
  }
  let final: any;
  const j = await sse(`${base(t.baseUrl)}/responses`, { authorization: `Bearer ${t.apiKey}`, ...t.headers }, {
    model: t.model, input, instructions: instructions || undefined, max_output_tokens: r.maxTokens ?? t.maxTokens, store: false, stream: true,
    ...(r.tools?.length ? { tools: r.tools.map((f) => ({ type: "function", ...f })) } : {}),
  }, r, (c, ev) => {
    const type = c.type ?? ev;
    if (type === "response.output_text.delta" && c.delta) r.onText?.(c.delta);
    else if (type === "response.completed" || type === "response.incomplete") final = c.response;
    else if (type === "response.failed") throw streamError(c.response?.error ?? c);
    else if (type === "error") throw streamError(c.error ?? c);
  });
  if (j) return parseResponses(j, t);
  if (!final) throw new ProviderError("流意外结束");
  return parseResponses(final, t);
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
    } else {
      push("user", { type: "text", text: m.content });
      if (m.role === "user") for (const i of m.images ?? []) push("user", { type: "image", source: { type: "base64", media_type: i.mime, data: i.data } });
    }
  }
  const blocks: any[] = []; const usage = { input: 0, output: 0 };
  const j = await sse(`${base(t.baseUrl)}/messages`, { "x-api-key": t.apiKey, "anthropic-version": "2023-06-01", ...t.headers }, {
    model: t.model, system: system || undefined, messages, max_tokens: r.maxTokens ?? t.maxTokens, temperature: r.temperature, stream: true,
    ...(r.tools?.length ? { tools: r.tools.map((f) => ({ name: f.name, description: f.description, input_schema: f.parameters })) } : {}),
  }, r, (c, ev) => {
    const type = c.type ?? ev;
    if (type === "message_start") usage.input = c.message?.usage?.input_tokens ?? 0;
    else if (type === "content_block_start") blocks[c.index] = { ...c.content_block, json: "" };
    else if (type === "content_block_delta") {
      const b = (blocks[c.index] ??= { type: c.delta?.type === "input_json_delta" ? "tool_use" : "text", text: "", json: "" });
      if (c.delta?.type === "text_delta") { b.text = (b.text ?? "") + c.delta.text; r.onText?.(c.delta.text); }
      else if (c.delta?.type === "input_json_delta") b.json += c.delta.partial_json ?? "";
    } else if (type === "message_delta") usage.output = c.usage?.output_tokens ?? usage.output;
    else if (type === "error") throw streamError(c.error ?? c);
  });
  const content = j ? j.content ?? [] : blocks.filter(Boolean).map((b) => b.type === "tool_use" ? { ...b, input: b.json ? parseArgs(b.json) : b.input ?? {} } : b);
  let text = ""; const toolCalls: ToolCall[] = [];
  for (const b of content) {
    if (b.type === "text") text += b.text ?? "";
    if (b.type === "tool_use") toolCalls.push({ id: b.id, name: b.name, args: b.input ?? {} });
  }
  return { text, toolCalls, model: t.model, usage: j ? { input: j.usage?.input_tokens ?? 0, output: j.usage?.output_tokens ?? 0 } : usage };
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
    } else {
      push("user", { text: m.content });
      if (m.role === "user") for (const i of m.images ?? []) push("user", { inlineData: { mimeType: i.mime, data: i.data } });
    }
  }
  let text = ""; const toolCalls: ToolCall[] = []; const usage = { input: 0, output: 0 };
  const onChunk = (c: any, live: boolean) => {
    if (c.error) throw streamError(c.error);
    for (const p of c.candidates?.[0]?.content?.parts ?? []) {
      if (p.text && !p.thought) { text += p.text; if (live) r.onText?.(p.text); }
      if (p.functionCall) toolCalls.push({ id: newId(), name: p.functionCall.name, args: p.functionCall.args ?? {} });
    }
    if (c.usageMetadata) { usage.input = c.usageMetadata.promptTokenCount ?? 0; usage.output = c.usageMetadata.candidatesTokenCount ?? 0; }
  };
  const j = await sse(`${base(t.baseUrl)}/models/${t.model}:streamGenerateContent?alt=sse`, { "x-goog-api-key": t.apiKey, ...t.headers }, {
    contents, systemInstruction: system ? { parts: [{ text: system }] } : undefined,
    generationConfig: { maxOutputTokens: r.maxTokens ?? t.maxTokens, temperature: r.temperature },
    ...(r.tools?.length ? { tools: [{ functionDeclarations: r.tools.map((f) => ({ ...f, parameters: geminiSchema(f.parameters) })) }] } : {}),
  }, r, (c) => onChunk(c, true));
  if (j) for (const c of Array.isArray(j) ? j : [j]) onChunk(c, false);
  return { text, toolCalls, model: t.model, usage };
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
