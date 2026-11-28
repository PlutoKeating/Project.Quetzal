// Quetzalcoatl 接进 OpenCode（v2 插件）。
//
// 插件里不写逻辑：每个挂点都把 OpenCode 的事件改写成 `qz hook --host opencode` 认得的样子交给 qz，
// 工具一律经 `qz mcp`。任何失败都放行——我们坏了，OpenCode 照常能用。
// 受管运行（守护进程自己拉起的宿主）与子代理会话里什么都不做。

import { spawn } from "node:child_process";

const QZ_BIN = "{{QZ_BIN_RAW}}";
const HOST = "opencode";
const HOOK_TIMEOUT_MS = 4_000;

type Json = Record<string, unknown>;

interface Registration {
  readonly dispose: () => Promise<void>;
}

interface SystemPart {
  type: "text";
  text: string;
}

interface PromptEvent {
  readonly sessionID: string;
  prompt: { text?: string };
}

interface ContextEvent {
  readonly sessionID: string;
  system: SystemPart[];
}

interface IdleEvent {
  readonly sessionID: string;
}

interface ToolBeforeEvent {
  tool: string;
  readonly sessionID: string;
  input: unknown;
}

interface McpEditor {
  set(name: string, config: { type: "local"; command: string[] }): void;
}

interface PluginContext {
  readonly location?: { readonly directory?: string };
  readonly session: {
    hook(name: "prompt", callback: (event: PromptEvent) => Promise<void>): Promise<Registration>;
    hook(name: "context", callback: (event: ContextEvent) => Promise<void>): Promise<Registration>;
    hook(name: "experimental.idle", callback: (event: IdleEvent) => Promise<void>): Promise<Registration>;
    get(input: { sessionID: string }): Promise<{ parentID?: string | null }>;
  };
  readonly tool: {
    hook(name: "execute.before", callback: (event: ToolBeforeEvent) => Promise<void>): Promise<Registration>;
  };
  readonly mcp: {
    transform(callback: (editor: McpEditor) => void): Promise<Registration>;
  };
}

/** 一个会话里要送进去的东西：开场的核心，和这一轮带进去的往事。 */
interface SessionState {
  core: string;
  recall: string;
}

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

/** OpenCode 给 MCP 工具起的名字形如 `quetzalcoatl_recall`：改写成 qz 认得的 `mcp__quetzalcoatl__recall`。 */
function ownToolName(tool: string): string | null {
  for (const prefix of ["quetzalcoatl_", "mcp__quetzalcoatl__"]) {
    if (tool.startsWith(prefix) && tool.length > prefix.length) {
      return `mcp__quetzalcoatl__${tool.slice(prefix.length)}`;
    }
  }
  return null;
}

function commandOf(input: unknown): string | null {
  if (typeof input !== "object" || input === null) return null;
  const command = (input as Json)["command"];
  if (typeof command === "string") return command;
  if (Array.isArray(command)) return command.filter((part) => typeof part === "string").join(" ");
  return null;
}

export default {
  id: "quetzalcoatl",
  async setup(ctx: PluginContext): Promise<void> {
    if (managed()) return;
    const cwd = ctx.location?.directory ?? process.cwd();
    const sessions = new Map<string, SessionState>();

    const isChild = async (sessionID: string): Promise<boolean> => {
      try {
        const session = await ctx.session.get({ sessionID });
        return Boolean(session.parentID);
      } catch {
        return false;
      }
    };

    try {
      await ctx.mcp.transform((editor) => {
        editor.set("quetzalcoatl", { type: "local", command: [QZ_BIN, "mcp", "--host", HOST] });
      });
    } catch {
      // 工具接不上不影响其余挂点。
    }

    await ctx.session.hook("prompt", async (event) => {
      if (await isChild(event.sessionID)) return;
      let state = sessions.get(event.sessionID);
      if (state === undefined) {
        const start = await qzHook({
          hook_event_name: "SessionStart",
          session_id: event.sessionID,
          cwd,
          source: "startup",
        });
        state = { core: additionalContext(start), recall: "" };
        sessions.set(event.sessionID, state);
      }
      const text = event.prompt.text ?? "";
      if (text.trim() === "") return;
      const submitted = await qzHook({
        hook_event_name: "UserPromptSubmit",
        session_id: event.sessionID,
        cwd,
        prompt: text,
      });
      state.recall = additionalContext(submitted);
    });

    // 每一次向模型发请求（含压缩）都带上：核心放在 system 里，压缩丢不了。
    await ctx.session.hook("context", async (event) => {
      const state = sessions.get(event.sessionID);
      if (state === undefined) return;
      const text = [state.core, state.recall].filter((part) => part.trim() !== "").join("\n\n");
      if (text !== "") event.system.push({ type: "text", text });
    });

    await ctx.tool.hook("execute.before", async (event) => {
      const own = ownToolName(event.tool);
      const command = commandOf(event.input);
      if (own === null && command === null) return;
      const reply = await qzHook({
        hook_event_name: "PreToolUse",
        session_id: event.sessionID,
        cwd,
        tool_name: own ?? event.tool,
        tool_input: event.input ?? {},
      });
      const denied = denialReason(reply);
      if (denied !== null) throw new Error(denied);
    });

    await ctx.session.hook("experimental.idle", async (event) => {
      if (!sessions.has(event.sessionID)) return;
      await qzHook({ hook_event_name: "Stop", session_id: event.sessionID, cwd });
    });
  },
};
