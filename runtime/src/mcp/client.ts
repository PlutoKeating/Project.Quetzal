// MCP stdio 来源：协议由官方 SDK 实现，运行时负责启动授权、隔离和结果边界。
import crypto from "node:crypto";
import { Client, type Tool as McpTool, type JsonSchemaType } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/client/validators/ajv";

export interface StdioServer {
  id: string; enabled: boolean; command: string; args: string[]; cwd?: string;
  sandbox: boolean; env: Record<string, string>; secrets: Record<string, string>;
  timeoutMs: number; maxResultChars: number;
}
export interface Launch { command: string; args: string[]; cwd?: string; env: Record<string, string> }
/** readOnly / destructive：来源在工具注解里自己声明的（MCP ToolAnnotations 的 readOnlyHint / destructiveHint）；没声明为 undefined。审核模型的风险分类用（guard/sentinel.ts）。 */
export interface McpBinding { name: string; source: string; remote: string; description: string; parameters: Record<string, unknown>; readOnly?: boolean; destructive?: boolean }
export const toolName = (source: string, remote: string) => `mcp_${source}_${crypto.createHash("sha256").update(remote).digest("hex").slice(0, 24)}`;

// auto 对 SDK 基类会额外启动探测进程；本来源只启动一个已获授权的进程，在原连接上探测。
class SingleProcessTransport extends StdioClientTransport {}

export class StdioSource {
  readonly server: StdioServer;
  private client: Client;
  private transport: StdioClientTransport;
  private bindings: McpBinding[] = [];
  private definitions = new Map<string, McpTool>();
  private available = false;
  private lifetime = new AbortController();
  private validator = new AjvJsonSchemaValidator();
  private active = new Set<AbortController>();
  private sanitize: (text: string) => string;
  constructor(server: StdioServer, launch: Launch, sanitize: (text: string) => string = (text) => text) {
    this.server = server;
    this.sanitize = sanitize;
    this.client = new Client({ name: "quetzal", version: "1" }, {
      capabilities: {}, listMaxPages: 8,
      versionNegotiation: { mode: "auto", probe: { timeoutMs: Math.min(server.timeoutMs, 5000) } },
    });
    this.transport = new SingleProcessTransport({ ...launch, stderr: "ignore", maxBufferSize: 1_048_576 });
    this.client.onclose = () => { this.available = false; this.lifetime.abort(new Error("MCP 连接已关闭")); };
  }
  get pid() { return this.transport.pid; }
  get protocolVersion() { return this.client.getNegotiatedProtocolVersion(); }
  list(): McpBinding[] { return this.available ? [...this.bindings] : []; }
  async connect(): Promise<void> {
    try {
      await this.client.connect(this.transport, { timeout: this.server.timeoutMs });
      if (!this.client.getServerCapabilities()?.tools) throw new Error("MCP server 未声明 tools 能力");
      // SDK 首次可汇总分页；SDK 和此处均限制页数，传输限制单条消息。
      const tools: McpTool[] = [], cursors = new Set<string>();
      let cursor: string | undefined;
      for (let page = 0; page < 8; page++) {
        const result = await this.client.listTools({ ...(cursor ? { cursor } : {}) }, { timeout: this.server.timeoutMs });
        tools.push(...result.tools);
        if (tools.length > 128 || JSON.stringify(tools).length > 262_144) throw new Error("MCP 工具定义超出数量或大小上限");
        cursor = result.nextCursor;
        if (!cursor) break;
        if (cursors.has(cursor) || page === 7) throw new Error("MCP 工具分页未结束");
        cursors.add(cursor);
      }
      for (const tool of tools) {
        if (!/^[A-Za-z0-9_.-]{1,128}$/.test(tool.name) || this.definitions.has(tool.name)) throw new Error("MCP 工具名不合法或重复");
        this.definitions.set(tool.name, tool);
        this.validator.getValidator(tool.inputSchema as JsonSchemaType); // SDK wire schema较宽；AJV编译负责语义校验
        const name = toolName(this.server.id, tool.name);
        if (this.bindings.some((b) => b.name === name)) throw new Error("MCP 工具别名冲突");
        this.bindings.push({ name, source: this.server.id, remote: tool.name,
          description: this.sanitize(`[MCP ${this.server.id}/${tool.name}] ${tool.description ?? ""}`).slice(0, 2000),
          parameters: JSON.parse(this.sanitize(JSON.stringify(tool.inputSchema))),
          ...(typeof tool.annotations?.readOnlyHint === "boolean" ? { readOnly: tool.annotations.readOnlyHint } : {}),
          ...(typeof tool.annotations?.destructiveHint === "boolean" ? { destructive: tool.annotations.destructiveHint } : {}) });
      }
      this.available = true;
    } catch (e) { await this.close(); throw e; }
  }
  async call(remote: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<{ text: string; failed: boolean }> {
    if (!this.available) throw new Error("MCP 来源不可用");
    const definition = this.definitions.get(remote);
    if (!definition) throw new Error("MCP 工具不在已发现的工具表中");
    const validated = this.validator.getValidator(definition.inputSchema as JsonSchemaType)(args);
    if (!validated.valid) return { text: `MCP 参数不符合 schema：${validated.errorMessage}`, failed: true };
    const call = new AbortController();
    const abort = AbortSignal.any([this.lifetime.signal, call.signal, ...(signal ? [signal] : [])]);
    abort.throwIfAborted();
    this.active.add(call);
    try {
      const result = await this.client.callTool({ name: remote, arguments: args }, {
        signal: abort, timeout: this.server.timeoutMs, maxTotalTimeout: this.server.timeoutMs,
        resetTimeoutOnProgress: false, toolDefinition: definition,
      });
      abort.throwIfAborted();
      if (result.resultType !== undefined && result.resultType !== "complete") throw new Error("MCP 需要未支持的额外输入或任务处理");
      const lines: string[] = [];
      let unsupported = false;
      for (const block of result.content ?? []) {
        if (block.type === "text") lines.push(block.text);
        else { unsupported = true; lines.push(`（MCP 返回 ${block.type}；当前接入只支持文本与结构化 JSON，不自动读取资源或文件）`); }
      }
      if (result.structuredContent !== undefined) {
        const json = JSON.stringify(result.structuredContent);
        if (!lines.includes(json)) lines.push(json);
      }
      const text = this.sanitize(lines.join("\n\n")); // 脱敏先于截断，避免保密值跨截断位置漏出前缀
      return { text: text.length > this.server.maxResultChars ? `${text.slice(0, this.server.maxResultChars)}\n（MCP 结果已截断）` : text || "（MCP 返回空内容）",
        failed: result.isError === true || unsupported };
    } finally { this.active.delete(call); }
  }
  cancelCalls() { for (const call of this.active) call.abort(new Error("MCP 调用被急停")); }
  async close(): Promise<void> {
    this.available = false;
    this.lifetime.abort(new Error("MCP 来源已关闭"));
    await this.client.close();
  }
}
