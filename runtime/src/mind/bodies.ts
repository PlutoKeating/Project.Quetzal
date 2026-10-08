// 其他身体（多具身体时由 mesh/ 填入）：她此刻还有哪些在线的身体、各有什么工具；以及跨身体调用工具与「换到另一具身体继续」的入口。
// 单独成模块：工具表与系统提示要用它，又不该依赖网状层（避免循环依赖）。没有其他身体时一切为空。
export interface RemoteTool { name: string; description: string; params: string[] }
export interface RemoteBody { body: string; describe: string; tools: RemoteTool[] }
export interface BodiesHooks {
  list: () => RemoteBody[];
  call: (body: string, tool: string, args: Record<string, unknown>, reason: string) => Promise<{ text: string; status: "ok" | "error" | "denied" }>;
  /** 换到另一具身体继续：对话 → 那具身体在同一个会话里接着做（返回它的回复）；醒来 → 那具身体按交接继续这次醒来。 */
  move: (body: string, ctx: { origin: string; conv: string; channel: string; note: string; reason: string }) => Promise<string>;
  /** 向另一具身体要一张图（view_image 带 body）：那边只交出图片（mind/tools.ts 的 lendImage），返回缩过的图片数据与那边的绝对路径。 */
  image?: (body: string, file: string, reason: string) => Promise<{ mime: string; data: string; note: string; path: string }>;
}
let hooks: BodiesHooks | undefined;
export const setBodies = (h: BodiesHooks | undefined) => { hooks = h; };
export const remoteBodies = (): RemoteBody[] => hooks?.list() ?? [];
export const bodiesHooks = () => hooks;

/** 可以在另一具身体上调用的工具：属于那具身体的（设备、命令、进程、文档、她自己造的工具、说话）。心智层面的（记忆、会话、子 agent、保密输入、身份）不跨身体。 */
export const REMOTE_CORE_TOOLS = new Set(["shell", "shell_jobs", "processes", "read_document", "voice_speak", "tool_write", "tool_read", "tool_delete", "web_fetch"]);

/** 每个会话最近是哪只耳朵（哪具身体）听到对方说话的：她用 voice_speak 回话时从那具身体说出来。 */
const ears = new Map<string, { body: string; at: number }>();
export const setEar = (conv: string, body: string) => { ears.set(conv, { body, at: Date.now() }); if (ears.size > 200) ears.delete(ears.keys().next().value!); };
export const earOf = (conv: string, withinMs = 3 * 60_000) => { const e = ears.get(conv); return e && Date.now() - e.at < withinMs ? e.body : undefined; };
