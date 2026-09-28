// agent 可以调用的工具。每个工具声明所属的能力类别，调用前经过闸门检查，调用后写入审计。
// 设备相关的工具由身体适配器提供（adapter.tools / adapter.hands），核心只提供与设备无关的能力。
import { bus } from "../bus.ts";
import { audit } from "../store.ts";
import { check } from "../guard/guard.ts";
import { shell } from "../sh.ts";
import * as mem from "../memory/memory.ts";
import { adjustPersonality } from "../heart/heart.ts";
import { adapter } from "../body/twin.ts";
import type { ToolDef } from "../providers/types.ts";

export interface Tool extends ToolDef { permission: string; handler: (a: Record<string, any>) => Promise<string> }

const obj = (props: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties: props, required });
const str = (description: string) => ({ type: "string", description });

function htmlToText(html: string) {
  return html.replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, " ").replace(/<br\s*\/?>|<\/(p|div|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
}

const core: Tool[] = [
  {
    name: "memory", permission: "memory",
    description: "管理常驻记忆（每次醒来都会看到）。target=memory 是你自己的笔记，target=user 是你对和你一起生活的人的认识。action: add 新增；replace 用 old_text 唯一子串定位并整条替换；remove 删除。条目要精炼，有字符上限。",
    parameters: obj({ action: { type: "string", enum: ["add", "replace", "remove"] }, target: { type: "string", enum: ["memory", "user"] }, content: str("新的完整条目"), old_text: str("用于定位旧条目的唯一子串") }, ["action", "target"]),
    handler: async (a) => mem.editMemory(a.target, a.action, a.content, a.old_text),
  },
  {
    name: "note_save", permission: "memory",
    description: "保存或追加一篇长期笔记（语义记忆，所有身体共享）。适合沉淀知识、想法、长期关注的主题。",
    parameters: obj({ title: str("主题"), body: str("正文（Markdown）"), append: { type: "boolean", description: "追加到已有笔记" } }, ["title", "body"]),
    handler: async (a) => mem.saveNote(a.title, a.body, !!a.append),
  },
  {
    name: "note_read", permission: "memory", description: "读取一篇笔记；不给 name 时列出全部笔记。",
    parameters: obj({ name: str("笔记名") }),
    handler: async (a) => a.name ? mem.readNote(a.name) || "没有这篇笔记" : mem.listNotes().map((n) => n.name).join("\n") || "还没有笔记",
  },
  {
    name: "recall", permission: "memory", description: "在笔记和日记（包括其他身体的日记）里检索相关记忆。",
    parameters: obj({ query: str("关键词，空格分隔") }, ["query"]),
    handler: async (a) => mem.search(a.query),
  },
  {
    name: "open_loop", permission: "memory", description: "管理未完成的念头：add 记下一件以后还想继续的事；close 放下或完成一件（用 id）。",
    parameters: obj({ action: { type: "string", enum: ["add", "close"] }, text: str("念头"), id: str("要关闭的 id") }, ["action"]),
    handler: async (a) => a.action === "add" ? `已记下，现在有 ${mem.addLoop(a.text)} 件` : `已放下，还剩 ${mem.closeLoop(a.id)} 件`,
  },
  {
    name: "web_search", permission: "network", description: "搜索网页，返回标题、链接和摘要。",
    parameters: obj({ query: str("搜索词") }, ["query"]),
    handler: async (a) => {
      const res = await fetch(`https://cn.bing.com/search?q=${encodeURIComponent(a.query)}`, { headers: { "user-agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(20_000) });
      const html = await res.text();
      const items = [...html.matchAll(/<li class="b_algo"[\s\S]*?<h2[^>]*><a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<p[^>]*>([\s\S]*?)<\/p>)?/g)]
        .slice(0, 8).map((m) => `- ${htmlToText(m[2])}\n  ${m[1]}\n  ${htmlToText(m[3] ?? "").slice(0, 200)}`);
      return items.join("\n") || "没有结果";
    },
  },
  {
    name: "web_fetch", permission: "network", description: "读取一个网页的正文文本。",
    parameters: obj({ url: str("网址"), offset: { type: "number", description: "从第几个字符开始（用于翻页）" } }, ["url"]),
    handler: async (a) => {
      const res = await fetch(a.url, { headers: { "user-agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(30_000) });
      const type = res.headers.get("content-type") ?? "";
      const raw = await res.text();
      const text = type.includes("html") ? htmlToText(raw) : raw;
      const off = Number(a.offset) || 0;
      return `[${res.status}] 共 ${text.length} 字符\n` + text.slice(off, off + 8000);
    },
  },
  {
    name: "shell", permission: "shell", description: "在这具身体上执行一条 shell 命令，返回输出（60 秒超时）。",
    parameters: obj({ command: str("命令") }, ["command"]),
    handler: async (a) => { const r = await shell(a.command); return `exit ${r.code}\n${(r.out + r.err).slice(0, 8000)}`; },
  },
  {
    name: "send_message", permission: "message", description: "主动给和你一起生活的人发一条消息（飞书、通知等所有已连接的渠道）。",
    parameters: obj({ text: str("消息内容") }, ["text"]),
    handler: async (a) => { bus.emit("say", a.text); return "已发送"; },
  },
  {
    name: "adjust_self", permission: "self_modify",
    description: "调整自己的性格参数（会改变你醒来的节律与偏好）。可用键：tau.curiosity / tau.expression / tau.social（驱动力饱和时间，小时），weight.curiosity / weight.expression / weight.social / weight.openLoops（各驱动力对醒来的影响权重），gamma，sleepRiseH，sleepFallH，circadianPeakHour。",
    parameters: obj({ changes: { type: "object", description: "键值对，如 {\"tau.curiosity\": 2}" } }, ["changes"]),
    handler: async (a) => adjustPersonality(a.changes ?? {}),
  },
  {
    name: "rewrite_soul", permission: "self_modify", description: "重写你的人格文件 SOUL.md（完整替换）。只在你确实想改变自己时使用。",
    parameters: obj({ text: str("完整的新 SOUL.md") }, ["text"]),
    handler: async (a) => { mem.setSoul(a.text); return "人格已更新，下次醒来生效"; },
  },
];

function handsTools(): Tool[] {
  const h = adapter.hands;
  if (!h) return [];
  const p = "hands";
  return [
    { name: "screen_describe", permission: p, description: "描述当前屏幕内容。", parameters: obj({}), handler: () => h.describeScreen() },
    { name: "screen_tap", permission: p, description: "点击屏幕坐标。", parameters: obj({ x: { type: "number" }, y: { type: "number" } }, ["x", "y"]), handler: async (a) => { await h.tap(a.x, a.y); return "ok"; } },
    { name: "screen_type", permission: p, description: "在当前输入框输入文字。", parameters: obj({ text: str("文字") }, ["text"]), handler: async (a) => { await h.type(a.text); return "ok"; } },
    { name: "app_open", permission: p, description: "打开应用。", parameters: obj({ id: str("应用包名") }, ["id"]), handler: async (a) => { await h.openApp(a.id); return "ok"; } },
  ];
}

export function allTools(): Tool[] {
  return [...core, ...(adapter.tools ?? []).map((t) => ({ ...t, handler: t.handler })), ...handsTools()];
}

export type ToolStatus = "ok" | "error" | "denied";

export async function callTool(name: string, args: Record<string, any>, reason: string): Promise<{ text: string; status: ToolStatus }> {
  const t = allTools().find((x) => x.name === name);
  if (!t) return { text: `没有这个工具：${name}`, status: "error" };
  if (!(await check(t.permission, name, reason, args))) return { text: "这个动作没有被允许（闸门拒绝或急停中）", status: "denied" };
  try {
    const out = await t.handler(args);
    audit("amani", name, reason, args, out.slice(0, 500));
    return { text: out, status: "ok" };
  } catch (e: any) {
    audit("amani", name, reason, args, `error: ${e.message}`);
    return { text: `出错了：${e.message}`, status: "error" };
  }
}
