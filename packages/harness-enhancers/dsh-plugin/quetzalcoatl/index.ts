// Quetzalcoatl 接进 DeepSeek Harness（dsh，Cordis 插件）。
//
// 插件里不写逻辑：每个挂点都把 dsh 的事件改写成 `qz hook --host dsh` 认得的样子交给 qz，
// 工具经同一份补丁里登记的 `@deepseek-ai/dsh-mcp-client` → `qz mcp --host dsh`。
// 任何失败都放行；受管运行与子代理里什么都不做。

import { spawn } from "node:child_process";

const QZ_BIN = "{{QZ_BIN_RAW}}";
const HOST = "dsh";
const HOOK_TIMEOUT_MS = 4_000;

type Json = Record<string, unknown>;

interface ContentBlock {
  readonly type: string;
  readonly text?: string;
}

interface UserMessage {
  readonly content: readonly ContentBlock[];
  readonly source?: { readonly kind?: string };
}

interface Agent {
  readonly session?: { readonly id?: string; readonly cwd?: string };
  readonly parentAgent?: unknown;
}

interface PreStep {
  readonly agent: Agent;
  readonly messages: UserMessage[];
}

interface ToolExecution {
  readonly name: string;
  readonly arguments: unknown;
  readonly agent?: Agent;
}

type PreToolDecision = { kind: "allow" } | { kind: "deny"; reason: string } | { kind: string };

interface Disposer {
  (): void;
}

interface Context {
  on(
    event: "agent/pre-step",
    listener: (payload: PreStep, next: () => Promise<unknown>) => Promise<unknown>,
  ): Disposer;
  on(
    event: "tools/pre-execute",
    listener: (exec: ToolExecution, next: () => Promise<PreToolDecision>) => Promise<PreToolDecision>,
  ): Disposer;
  on(event: "agent/turn-stopping", listener: (payload: { readonly agent: Agent }) => Promise<void>): Disposer;
  readonly systemPrompt: {
    section(section: { name: string; order: number; interpolate: boolean; text: () => string }): Disposer;
    context(context: { name: string; order: number; interpolate: boolean; text: () => string }): Disposer;
  };
}

export const name = "quetzalcoatl";
export const inject = ["systemPrompt"];

function managed(): boolean {
  return (process.env["QUETZALCOATL_MANAGED_RUN"] ?? "") !== "";
}

/** 把一个事件交给 `qz hook`，拿回它的答复；超时、出错、没有答复都当作没有。 */
function qzHook(event: Json): Promise<Json | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: Json | null): void => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    try {
      const child = spawn(QZ_BIN, ["hook", "--host", HOST], { stdio: ["pipe", "pipe", "ignore"] });
      const timer = setTimeout(() => {
        child.kill();
        finish(null);
      }, HOOK_TIMEOUT_MS);
      let out = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        out += chunk;
      });
      child.on("error", () => {
        clearTimeout(timer);
        finish(null);
      });
      child.on("close", () => {
        clearTimeout(timer);
        const text = out.trim();
        if (text === "") return finish(null);
        try {
          const parsed: unknown = JSON.parse(text);
          finish(typeof parsed === "object" && parsed !== null ? (parsed as Json) : null);
        } catch {
          finish(null);
        }
      });
      child.stdin.end(JSON.stringify(event));
    } catch {
      finish(null);
    }
  });
}

function additionalContext(reply: Json | null): string {
  const specific = reply?.["hookSpecificOutput"];
  if (typeof specific !== "object" || specific === null) return "";
  const context = (specific as Json)["additionalContext"];
  return typeof context === "string" ? context : "";
}

function denialReason(reply: Json | null): string | null {
  const specific = reply?.["hookSpecificOutput"];
  if (typeof specific !== "object" || specific === null) return null;
  const decision = (specific as Json)["permissionDecision"];
  const reason = (specific as Json)["permissionDecisionReason"];
  return decision === "deny" ? (typeof reason === "string" ? reason : "已拒绝") : null;
}

/** dsh 给 MCP 工具起的名字形如 `mcp__quetzalcoatl__recall`。 */
function ownToolName(tool: string): string | null {
  const prefix = "mcp__quetzalcoatl__";
  return tool.startsWith(prefix) && tool.length > prefix.length ? tool : null;
}

function commandOf(args: unknown): string | null {
  if (typeof args !== "object" || args === null) return null;
  const command = (args as Json)["command"];
  if (typeof command === "string") return command;
  if (Array.isArray(command)) return command.filter((part) => typeof part === "string").join(" ");
  return null;
}

/** 只认用户亲手打的字：来源是 `user` 的消息里的文字块。 */
function typedText(messages: readonly UserMessage[]): string {
  return messages
    .filter((message) => message.source?.kind === "user")
    .flatMap((message) => message.content)
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text ?? "")
    .join("\n")
    .trim();
}

export function apply(ctx: Context): void {
  if (managed()) return;
  let core = "";
  let recall = "";
  const started = new Set<string>();

  ctx.systemPrompt.section({ name: "quetzalcoatl-core", order: 9_000, interpolate: false, text: () => core });
  ctx.systemPrompt.context({ name: "quetzalcoatl-recall", order: 9_000, interpolate: false, text: () => recall });

  ctx.on("agent/pre-step", async (payload, next) => {
    const session = payload.agent.session;
    const sessionId = session?.id;
    const text = typedText(payload.messages);
    if (sessionId === undefined || payload.agent.parentAgent !== undefined || text === "") return next();
    const cwd = session?.cwd ?? process.cwd();
    if (!started.has(sessionId)) {
      started.add(sessionId);
      core = additionalContext(
        await qzHook({ hook_event_name: "SessionStart", session_id: sessionId, cwd, source: "startup" }),
      );
    }
    recall = additionalContext(
      await qzHook({ hook_event_name: "UserPromptSubmit", session_id: sessionId, cwd, prompt: text }),
    );
    return next();
  });

  ctx.on("tools/pre-execute", async (exec, next) => {
    const own = ownToolName(exec.name);
    const command = commandOf(exec.arguments);
    const sessionId = exec.agent?.session?.id;
    if ((own === null && command === null) || sessionId === undefined) return next();
    const reply = await qzHook({
      hook_event_name: "PreToolUse",
      session_id: sessionId,
      tool_name: own ?? exec.name,
      tool_input: exec.arguments ?? {},
    });
    const denied = denialReason(reply);
    return denied === null ? next() : { kind: "deny", reason: denied };
  });

  ctx.on("agent/turn-stopping", async (payload) => {
    const sessionId = payload.agent.session?.id;
    if (sessionId !== undefined && started.has(sessionId)) {
      await qzHook({ hook_event_name: "Stop", session_id: sessionId });
    }
  });
}
