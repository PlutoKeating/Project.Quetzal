// MCP 来源：协议由官方 SDK 实现（stdio、Streamable HTTP、旧版 HTTP+SSE），运行时负责启动授权、隔离和结果边界。
import crypto from "node:crypto";
import { Client, SSEClientTransport, StreamableHTTPClientTransport, type Tool as McpTool, type JsonSchemaType, type Transport, type OAuthClientProvider, type FetchLike } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/client/validators/ajv";

interface ServerBase {
  id: string; enabled: boolean; timeoutMs: number; maxResultChars: number;
  sync?: boolean; updated?: number; title?: string; plugin?: string; // 多端同步（远程缺省是，stdio 缺省否）、最近修改时刻、显示名、来自哪个插件
}
export interface StdioServer extends ServerBase {
  transport?: "stdio"; command: string; args: string[]; cwd?: string;
  sandbox: boolean; env: Record<string, string>; secrets: Record<string, string>;
}
/** 远程来源：Streamable HTTP（http）或旧版 HTTP+SSE（sse）。headers 是公开的请求头，headerSecrets 是请求头到 secrets/ 文件名的映射；oauth 为 MCP 授权规范的 OAuth 2.1。 */
export interface RemoteServer extends ServerBase {
  transport: "http" | "sse"; url: string; headers: Record<string, string>; headerSecrets: Record<string, string>;
  oauth: false | { clientId?: string; scope?: string };
}
export type McpServer = StdioServer | RemoteServer;
export const isRemote = (s: McpServer): s is RemoteServer => s.transport === "http" || s.transport === "sse";
export interface Launch { command: string; args: string[]; cwd?: string; env: Record<string, string> }
export interface RemoteOptions { headers: Record<string, string>; fetch: FetchLike; authProvider?: OAuthClientProvider }
/** kind：tool 为服务端的工具；其余是基座替每个来源加的几个工具（列出 / 读取资源，列出 / 取用提示词）。 */
export type BindingKind = "tool" | "resource_list" | "resource_read" | "prompt_list" | "prompt_get";
/** readOnly / destructive：kind 为 tool 时是来源在工具注解里自己声明的（MCP ToolAnnotations 的 readOnlyHint / destructiveHint），没声明为 undefined；基座加的资源 / 提示词工具只读，readOnly 为 true。审核模型的风险分类用（guard/sentinel.ts）。 */
export interface McpBinding { name: string; source: string; remote: string; kind: BindingKind; description: string; parameters: Record<string, unknown>; readOnly?: boolean; destructive?: boolean }
export interface McpInventory { tools: { name: string; description: string }[]; resources: { uri: string; name: string; description: string; mimeType?: string }[]; templates: { uriTemplate: string; name: string; description: string }[]; prompts: { name: string; description: string; arguments: { name: string; required: boolean; description: string }[] }[] }
export const toolName = (source: string, remote: string) => `mcp_${source}_${crypto.createHash("sha256").update(remote).digest("hex").slice(0, 24)}`;
/** 基座替来源加的几个工具（列出 / 读取资源等）：原名前加 \0，服务端的工具名不允许这个字符，所以不会撞名。 */
export const metaName = (source: string, remote: string) => toolName(source, `\0${remote}`);

// auto 对 SDK 基类会额外启动探测进程；本来源只启动一个已获授权的进程，在原连接上探测。
class SingleProcessTransport extends StdioClientTransport {}

const MAX_ITEMS = 128, MAX_BYTES = 262_144, MAX_PAGES = 8;

export class McpSource {
  readonly server: McpServer;
  protected client: Client;
  protected transport: Transport;
  private bindings: McpBinding[] = [];
  private definitions = new Map<string, McpTool>();
  private inventory: McpInventory = { tools: [], resources: [], templates: [], prompts: [] };
  private available = false;
  private lifetime = new AbortController();
  private validator = new AjvJsonSchemaValidator();
  private active = new Set<AbortController>();
  private sanitize: (text: string) => string;
  constructor(server: McpServer, transport: Transport, sanitize: (text: string) => string = (text) => text) {
    this.server = server;
    this.sanitize = sanitize;
    this.client = new Client({ name: "quetzal", version: "1" }, {
      capabilities: {}, listMaxPages: MAX_PAGES,
      versionNegotiation: { mode: "auto", probe: { timeoutMs: Math.min(server.timeoutMs, 5000) } },
    });
    this.transport = transport;
    this.client.onclose = () => { this.available = false; this.lifetime.abort(new Error("MCP 连接已关闭")); this.onclose?.(); };
  }
  onclose?: () => void;
  get pid(): number | undefined { return undefined; }
  get protocolVersion() { return this.client.getNegotiatedProtocolVersion(); }
  get connected() { return this.available; }
  list(): McpBinding[] { return this.available ? [...this.bindings] : []; }
  /** 控制台看到的：工具、资源、资源模板、提示词（名字与说明已脱敏）。 */
  contents(): McpInventory { return this.available ? structuredClone(this.inventory) : { tools: [], resources: [], templates: [], prompts: [] }; }

  /** 分页读取一种列表：SDK 与这里都限制页数，另限条数与总大小。 */
  private async pages<T>(what: string, fetch: (cursor?: string) => Promise<{ items: T[]; nextCursor?: string }>): Promise<T[]> {
    const out: T[] = [], cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const r = await fetch(cursor);
      out.push(...r.items);
      if (out.length > MAX_ITEMS || JSON.stringify(out).length > MAX_BYTES) throw new Error(`MCP ${what}超出数量或大小上限`);
      cursor = r.nextCursor;
      if (!cursor) break;
      if (cursors.has(cursor) || page === MAX_PAGES - 1) throw new Error(`MCP ${what}分页未结束`);
      cursors.add(cursor);
    }
    return out;
  }

  async connect(): Promise<void> {
    try {
      await this.client.connect(this.transport, { timeout: this.server.timeoutMs });
      const caps = this.client.getServerCapabilities() ?? {};
      if (!caps.tools && !caps.resources && !caps.prompts) throw new Error("MCP server 没有声明 tools / resources / prompts 能力");
      const t = { timeout: this.server.timeoutMs };
      const tools = caps.tools ? await this.pages("工具定义", async (cursor) => { const r = await this.client.listTools(cursor ? { cursor } : {}, t); return { items: r.tools, nextCursor: r.nextCursor }; }) : [];
      for (const tool of tools) {
        if (!/^[A-Za-z0-9_.-]{1,128}$/.test(tool.name) || this.definitions.has(tool.name)) throw new Error("MCP 工具名不合法或重复");
        this.definitions.set(tool.name, tool);
        this.validator.getValidator(tool.inputSchema as JsonSchemaType); // SDK wire schema较宽；AJV编译负责语义校验
        this.bind("tool", tool.name, `[MCP ${this.server.id}/${tool.name}] ${tool.description ?? ""}`, JSON.parse(this.sanitize(JSON.stringify(tool.inputSchema))), {
          ...(typeof tool.annotations?.readOnlyHint === "boolean" ? { readOnly: tool.annotations.readOnlyHint } : {}),
          ...(typeof tool.annotations?.destructiveHint === "boolean" ? { destructive: tool.annotations.destructiveHint } : {}) });
        this.inventory.tools.push({ name: tool.name, description: this.sanitize(tool.description ?? "").slice(0, 500) });
      }
      if (caps.resources) {
        const resources = await this.pages("资源列表", async (cursor) => { const r = await this.client.listResources(cursor ? { cursor } : {}, t); return { items: r.resources, nextCursor: r.nextCursor }; });
        // 资源模板是可选的：旧服务没有这个方法时不当成失败
        const templates = await this.pages("资源模板", async (cursor) => { const r = await this.client.listResourceTemplates(cursor ? { cursor } : {}, t); return { items: r.resourceTemplates, nextCursor: r.nextCursor }; }).catch(() => []);
        this.inventory.resources = resources.map((r) => ({ uri: this.sanitize(r.uri).slice(0, 500), name: this.sanitize(r.name ?? "").slice(0, 200), description: this.sanitize(r.description ?? "").slice(0, 300), ...(r.mimeType ? { mimeType: r.mimeType } : {}) }));
        this.inventory.templates = templates.map((r) => ({ uriTemplate: this.sanitize(r.uriTemplate).slice(0, 500), name: this.sanitize(r.name ?? "").slice(0, 200), description: this.sanitize(r.description ?? "").slice(0, 300) }));
        this.bind("resource_list", "resources/list", `[MCP ${this.server.id}] 列出这个来源提供的资源（文件、文档、记录等，以 URI 标识）与资源模板。读取用 ${metaName(this.server.id, "resources/read")}。`, { type: "object", properties: {} });
        this.bind("resource_read", "resources/read", `[MCP ${this.server.id}] 读取这个来源的一个资源：uri 取自资源列表，或按资源模板填好的 URI。`, { type: "object", properties: { uri: { type: "string", description: "资源 URI" } }, required: ["uri"] });
      }
      if (caps.prompts) {
        const prompts = await this.pages("提示词列表", async (cursor) => { const r = await this.client.listPrompts(cursor ? { cursor } : {}, t); return { items: r.prompts, nextCursor: r.nextCursor }; });
        this.inventory.prompts = prompts.map((p) => ({ name: this.sanitize(p.name).slice(0, 128), description: this.sanitize(p.description ?? "").slice(0, 300), arguments: (p.arguments ?? []).slice(0, 32).map((a) => ({ name: a.name, required: a.required === true, description: this.sanitize(a.description ?? "").slice(0, 200) })) }));
        this.bind("prompt_list", "prompts/list", `[MCP ${this.server.id}] 列出这个来源提供的提示词模板（名字、用途、参数）。取用用 ${metaName(this.server.id, "prompts/get")}。`, { type: "object", properties: {} });
        this.bind("prompt_get", "prompts/get", `[MCP ${this.server.id}] 取用这个来源的一个提示词模板：name 为模板名，arguments 为参数（字符串键值）。返回的是写给你的说明，按你的判断使用。`, { type: "object", properties: { name: { type: "string" }, arguments: { type: "object", additionalProperties: { type: "string" } } }, required: ["name"] });
      }
      this.available = true;
    } catch (e) { await this.close(); throw e; }
  }
  private bind(kind: BindingKind, remote: string, description: string, parameters: Record<string, unknown>, hints: { readOnly?: boolean; destructive?: boolean } = kind === "tool" ? {} : { readOnly: true }) {
    const name = kind === "tool" ? toolName(this.server.id, remote) : metaName(this.server.id, remote);
    if (this.bindings.some((b) => b.name === name)) throw new Error("MCP 工具别名冲突");
    this.bindings.push({ name, source: this.server.id, remote, kind, description: this.sanitize(description).slice(0, 2000), parameters, ...hints });
  }

  /** 一次调用的取消与超时：这一轮的停止、急停、来源关闭都会中止。 */
  private async guarded<T>(signal: AbortSignal | undefined, f: (abort: AbortSignal) => Promise<T>): Promise<T> {
    if (!this.available) throw new Error("MCP 来源不可用");
    const call = new AbortController();
    const abort = AbortSignal.any([this.lifetime.signal, call.signal, ...(signal ? [signal] : [])]);
    abort.throwIfAborted();
    this.active.add(call);
    try { const r = await f(abort); abort.throwIfAborted(); return r; } finally { this.active.delete(call); }
  }
  private finish(lines: string[], failed: boolean) {
    const text = this.sanitize(lines.join("\n\n")); // 脱敏先于截断，避免保密值跨截断位置漏出前缀
    const max = this.server.maxResultChars;
    return { text: text.length > max ? `${text.slice(0, max)}\n（MCP 结果已截断）` : text || "（MCP 返回空内容）", failed };
  }
  private opts(abort: AbortSignal) { return { signal: abort, timeout: this.server.timeoutMs, maxTotalTimeout: this.server.timeoutMs, resetTimeoutOnProgress: false }; }

  async call(remote: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<{ text: string; failed: boolean }> {
    if (!this.available) throw new Error("MCP 来源不可用");
    const definition = this.definitions.get(remote);
    if (!definition) throw new Error("MCP 工具不在已发现的工具表中");
    const validated = this.validator.getValidator(definition.inputSchema as JsonSchemaType)(args);
    if (!validated.valid) return { text: `MCP 参数不符合 schema：${validated.errorMessage}`, failed: true };
    return this.guarded(signal, async (abort) => {
      const result = await this.client.callTool({ name: remote, arguments: args }, { ...this.opts(abort), toolDefinition: definition });
      abort.throwIfAborted();
      if (result.resultType !== undefined && result.resultType !== "complete") throw new Error("MCP 需要未支持的额外输入或任务处理");
      const lines: string[] = [];
      let unsupported = false;
      for (const block of result.content ?? []) {
        if (block.type === "text") lines.push(block.text);
        else if (block.type === "resource" && "text" in block.resource && typeof block.resource.text === "string") lines.push(`（资源 ${block.resource.uri}）\n${block.resource.text}`);
        else if (block.type === "resource_link") lines.push(`（资源链接 ${block.uri}${block.name ? `：${block.name}` : ""}；可用资源读取工具读取）`);
        else { unsupported = true; lines.push(`（MCP 返回 ${block.type}；当前接入只支持文本、文本资源与结构化 JSON，不自动下载或读取二进制内容）`); }
      }
      if (result.structuredContent !== undefined) {
        const json = JSON.stringify(result.structuredContent);
        if (!lines.includes(json)) lines.push(json);
      }
      return this.finish(lines, result.isError === true || unsupported);
    });
  }

  /** 基座加的几个工具：列出 / 读取资源，列出 / 取用提示词。 */
  async meta(kind: BindingKind, args: Record<string, unknown>, signal?: AbortSignal): Promise<{ text: string; failed: boolean }> {
    if (kind === "resource_list" || kind === "prompt_list") {
      const inv = this.contents();
      if (kind === "prompt_list") return this.finish(inv.prompts.length ? inv.prompts.map((p) => `- ${p.name}：${p.description}${p.arguments.length ? `（参数：${p.arguments.map((a) => `${a.name}${a.required ? "，必填" : ""}${a.description ? `：${a.description}` : ""}`).join("；")}）` : ""}`) : ["（没有提示词）"], false);
      return this.finish([
        ...(inv.resources.length ? inv.resources.map((r) => `- ${r.uri}${r.name ? `（${r.name}）` : ""}${r.mimeType ? ` [${r.mimeType}]` : ""}${r.description ? `：${r.description}` : ""}`) : ["（没有列出的资源）"]),
        ...(inv.templates.length ? ["资源模板（把 {参数} 换成具体值后读取）：", ...inv.templates.map((r) => `- ${r.uriTemplate}${r.name ? `（${r.name}）` : ""}${r.description ? `：${r.description}` : ""}`)] : []),
      ], false);
    }
    if (kind === "resource_read") {
      const uri = typeof args.uri === "string" ? args.uri.trim() : "";
      if (!uri || uri.length > 2048) return { text: "需要 uri（资源列表里的 URI）", failed: true };
      return this.guarded(signal, async (abort) => {
        const r = await this.client.readResource({ uri }, this.opts(abort));
        const lines: string[] = [];
        let unsupported = false;
        for (const c of r.contents ?? []) {
          if ("text" in c && typeof c.text === "string") lines.push(r.contents.length > 1 ? `（${c.uri}）\n${c.text}` : c.text);
          else { unsupported = true; lines.push(`（${c.uri} 是二进制内容${c.mimeType ? `（${c.mimeType}）` : ""}，约 ${Math.floor(String((c as { blob?: string }).blob ?? "").length * 3 / 4)} 字节；当前接入不展开二进制资源）`); }
        }
        return this.finish(lines, unsupported && lines.length === 1);
      });
    }
    if (kind === "prompt_get") {
      const name = typeof args.name === "string" ? args.name : "";
      if (!this.inventory.prompts.some((p) => p.name === name)) return { text: `没有这个提示词：${name}`, failed: true };
      const raw = args.arguments && typeof args.arguments === "object" && !Array.isArray(args.arguments) ? args.arguments as Record<string, unknown> : {};
      const a: Record<string, string> = {};
      for (const [k, v] of Object.entries(raw).slice(0, 32)) a[k] = String(v).slice(0, 8192);
      return this.guarded(signal, async (abort) => {
        const r = await this.client.getPrompt({ name, arguments: a }, this.opts(abort));
        const lines = [...(r.description ? [`（${r.description}）`] : []), ...r.messages.map((m) => `[${m.role}] ${m.content.type === "text" ? m.content.text : m.content.type === "resource" && "text" in m.content.resource ? String(m.content.resource.text) : `（${m.content.type} 内容，未展开）`}`)];
        return this.finish(lines, false);
      });
    }
    return { text: "未知的 MCP 操作", failed: true };
  }
  cancelCalls() { for (const call of this.active) call.abort(new Error("MCP 调用被急停")); }
  async close(): Promise<void> {
    this.available = false;
    this.lifetime.abort(new Error("MCP 来源已关闭"));
    await this.client.close();
  }
}

export class StdioSource extends McpSource {
  constructor(server: StdioServer, launch: Launch, sanitize?: (text: string) => string) {
    super(server, new SingleProcessTransport({ ...launch, stderr: "ignore", maxBufferSize: 1_048_576 }), sanitize);
  }
  override get pid() { return (this.transport as StdioClientTransport).pid ?? undefined; }
}

/** 远程来源：Streamable HTTP 或旧版 HTTP+SSE。所有请求（含 OAuth 的发现、注册与换令牌）都经 opts.fetch 的出站检查。 */
export class RemoteSource extends McpSource {
  constructor(server: RemoteServer, opts: RemoteOptions, sanitize?: (text: string) => string) {
    const common = { fetch: opts.fetch, requestInit: { headers: opts.headers }, ...(opts.authProvider ? { authProvider: opts.authProvider } : {}) };
    super(server, server.transport === "sse" ? new SSEClientTransport(new URL(server.url), common) : new StreamableHTTPClientTransport(new URL(server.url), { ...common, reconnectionOptions: { maxReconnectionDelay: 30_000, initialReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1.5, maxRetries: 2 } }), sanitize);
  }
}
