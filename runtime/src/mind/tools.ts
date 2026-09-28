// agent 可以调用的工具。每个工具声明所属的能力类别，调用前经过闸门检查，调用后写入审计。
// 设备相关的工具由身体适配器提供（adapter.tools / adapter.hands），核心只提供与设备无关的能力。
import { bus } from "../bus.ts";
import { audit } from "../store.ts";
import { check } from "../guard/guard.ts";
import { shell, startJob, stopJob, getJob, listJobs } from "../sh.ts";
import * as mem from "../memory/memory.ts";
import { adjustPersonality } from "../heart/heart.ts";
import { adapter } from "../body/twin.ts";
import type { ToolDef } from "../providers/types.ts";
import type { Session } from "./activity.ts";
import { htmlToText, readDocument } from "./documents.ts";
import { webSearch, BROWSER_HEADERS } from "./search.ts";
import * as voice from "../voice/azure.ts";

/** 调用工具的上下文：当前这一轮（对话或醒来）。 */
export interface ToolContext { session?: Session }
export interface Tool extends ToolDef { permission: string; handler: (a: Record<string, any>, ctx: ToolContext) => Promise<string> }

const obj = (props: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties: props, required });
const str = (description: string) => ({ type: "string", description });


const core: Tool[] = [
  {
    name: "memory", permission: "memory",
    description: "管理常驻记忆（每次醒来都会看到）。target=memory 是你自己的笔记，target=user 是你对和你一起生活的人的认识。action: add 新增；replace 用 old_text 唯一子串定位并整条替换；remove 删除。没有长度上限，但每次只展开与当前话题相关、较新的条目：这里放最核心、最常用的认识；细节和长内容用 note_save 放进笔记目录。",
    parameters: obj({ action: { type: "string", enum: ["add", "replace", "remove"] }, target: { type: "string", enum: ["memory", "user"] }, content: str("新的完整条目"), old_text: str("用于定位旧条目的唯一子串") }, ["action", "target"]),
    handler: async (a) => mem.editMemory(a.target, a.action, a.content, a.old_text),
  },
  {
    name: "note_save", permission: "memory",
    description: "保存或追加一篇长期笔记（语义记忆，所有身体共享，数量不限）。笔记按目录树存放：title 用「分类/子分类/主题」表示位置（最多 4 层），例如「身体/honor9/硬件」。写一句话 summary，它会出现在记忆目录里，帮你以后找到它。",
    parameters: obj({ title: str("「分类/…/主题」"), body: str("正文（Markdown）"), summary: str("一句话摘要"), append: { type: "boolean", description: "追加到已有笔记" } }, ["title", "body"]),
    handler: async (a) => mem.saveNote(a.title, a.body, !!a.append, a.summary ?? ""),
  },
  {
    name: "note_read", permission: "memory", description: "读取一篇笔记的全文（name 为记忆目录里方括号中的路径）。",
    parameters: obj({ name: str("笔记路径，如 身体/honor9/硬件") }, ["name"]),
    handler: async (a) => mem.readNote(a.name) || `没有这篇笔记：${a.name}`,
  },
  {
    name: "note_list", permission: "memory", description: "浏览笔记目录树：不给 dir 看全部，给 dir 只看该分支（每篇附一句话摘要）。",
    parameters: obj({ dir: str("分支，如 身体/honor9") }),
    handler: async (a) => mem.noteTree(a.dir ?? "", 8000),
  },
  {
    name: "note_move", permission: "memory", description: "移动或改名笔记，用来整理目录树（归类、合并前的调整）。",
    parameters: obj({ from: str("原路径"), to: str("新路径，如 人/PK/喜好") }, ["from", "to"]),
    handler: async (a) => mem.moveNote(a.from, a.to),
  },
  {
    name: "note_delete", permission: "memory", description: "删除一篇笔记（例如已合并进别的笔记）。灵魂仓库的历史里仍可找回。",
    parameters: obj({ name: str("笔记路径") }, ["name"]),
    handler: async (a) => mem.deleteNote(a.name),
  },
  {
    name: "recall", permission: "memory", description: "检索全部记忆：笔记目录树、所有日记（包括其他身体的）、常驻记忆里没展开的条目。按相关度排序，中文直接写一句话或几个词即可。",
    parameters: obj({ query: str("想找什么") }, ["query"]),
    handler: async (a) => mem.search(a.query),
  },
  {
    name: "open_loop", permission: "memory", description: "管理未完成的念头：add 记下一件以后还想继续的事；close 放下或完成一件（用 id）。",
    parameters: obj({ action: { type: "string", enum: ["add", "close"] }, text: str("念头"), id: str("要关闭的 id") }, ["action"]),
    handler: async (a) => a.action === "add" ? `已记下，现在有 ${mem.addLoop(a.text)} 件` : `已放下，还剩 ${mem.closeLoop(a.id)} 件`,
  },
  {
    name: "web_search", permission: "network",
    description: "搜索网页，返回标题、链接和摘要。默认依次尝试 360 搜索、必应（英文为主的查询用国际版）、百度，拿到结果即止；也可以指定引擎。需要全文时用 web_fetch 打开链接。",
    parameters: obj({ query: str("搜索词"), count: { type: "number", description: "结果条数（1–10，默认 8）" }, engine: { type: "string", enum: ["so", "bing-cn", "bing-intl", "baidu"], description: "可选：指定引擎" } }, ["query"]),
    handler: async (a) => webSearch(String(a.query), { count: a.count, engine: a.engine }),
  },
  {
    name: "web_fetch", permission: "network", description: "读取一个网页的正文文本。",
    parameters: obj({ url: str("网址"), offset: { type: "number", description: "从第几个字符开始（用于翻页）" } }, ["url"]),
    handler: async (a) => {
      const res = await fetch(a.url, { headers: BROWSER_HEADERS, signal: AbortSignal.timeout(30_000) });
      const type = res.headers.get("content-type") ?? "";
      const raw = await res.text();
      const text = type.includes("html") ? htmlToText(raw) : raw;
      const off = Number(a.offset) || 0;
      return `[${res.status}] 共 ${text.length} 字符\n` + text.slice(off, off + 8000);
    },
  },
  {
    name: "read_document", permission: "shell",
    description: "读取本地文档的文字内容（分页，每次约 2 万字）：Word（docx/doc）、PowerPoint（pptx/ppt，含备注）、Excel（xlsx/xls，按工作表输出为制表符分隔）、PDF、OpenDocument（odt/ods/odp）、EPUB、HTML、RTF、各类文本；zip 会列出内容。用户上传的附件在附件列表里给出了本地路径。",
    parameters: obj({ path: str("文件的本地路径"), offset: { type: "number", description: "从第几个字开始（用于翻页）" } }, ["path"]),
    handler: async (a) => readDocument(String(a.path), Number(a.offset) || 0),
  },
  {
    name: "shell", permission: "shell",
    description: "在这具身体上执行一条 shell 命令。默认等待结果（timeout 秒，默认 60，最多 600）。耗时长、或可能需要中途停下的命令（播放、下载、服务、长任务）用 background=true 放到后台，立即返回任务 id，之后用 shell_jobs 查看输出或随时停止。",
    parameters: obj({ command: str("命令"), timeout: { type: "number", description: "等待秒数（前台）" }, background: { type: "boolean", description: "放到后台运行" } }, ["command"]),
    handler: async (a) => {
      if (a.background) { const j = startJob(a.command); return `已在后台运行，任务 ${j.id}。用 shell_jobs 查看输出（action=output）或停止（action=stop）。`; }
      const r = await shell(a.command, Math.min(600, Math.max(1, Number(a.timeout) || 60)) * 1000);
      return `exit ${r.code}\n${(r.out + r.err).slice(0, 8000)}`;
    },
  },
  {
    name: "shell_jobs", permission: "shell", description: "管理后台命令：list 列出全部任务；output 查看某个任务最近的输出；stop 停止某个任务（连同它启动的子进程）。你可以按自己的判断，或根据对方的要求随时停止。",
    parameters: obj({ action: { type: "string", enum: ["list", "output", "stop"] }, id: str("任务 id") }, ["action"]),
    handler: async (a) => {
      if (a.action === "stop") return stopJob(String(a.id));
      if (a.action === "output") { const j = getJob(String(a.id)); return j ? `${j.ended ? `已结束（退出码 ${j.code}）` : "运行中"}\n${j.out.slice(-8000) || "（还没有输出）"}` : `没有这个任务：${a.id}`; }
      const l = listJobs();
      return l.map((j) => `${j.id}  ${j.ended ? `已结束（${j.code}）` : `运行中 ${Math.round((Date.now() - j.started) / 1000)}s`}  ${j.command.slice(0, 80)}`).join("\n") || "没有后台任务";
    },
  },
  {
    name: "share_thought", permission: "memory",
    description: "更新「想分享的一句话」：你此刻正在想、并且愿意和对方分享的一句话或一个议题。它会一直显示在对方控制台的首页和飞书「此刻」卡片上，直到你下次更新。用你自己的口吻写一句话，最好不超过 50 字（最多 120 字），细节留到聊天里说；想法变了就随时换。",
    parameters: obj({ text: str("一句话或一个议题") }, ["text"]),
    handler: async (a) => mem.setThought(a.text),
  },
  {
    name: "voice_speak", permission: "device",
    description: "用你自己的声音说话（Azure 语音合成，由这具身体的扬声器播放）。可以只为这一句临时换音色、风格、语速、音调；想长期换声音用 voice_config。",
    parameters: obj({ text: str("要说的话"), voice: str("可选：音色，如 zh-CN-XiaoxiaoNeural"), style: str("可选：表达风格，如 cheerful、gentle、whispering"), rate: str("可选：语速，如 +10%"), pitch: str("可选：音调，如 -5%") }, ["text"]),
    handler: async (a) => {
      const file = await voice.synthesize(String(a.text), { voice: a.voice, style: a.style, rate: a.rate, pitch: a.pitch });
      if (!adapter.playAudio) return `已合成：${file}（这具身体不支持播放音频，可以用 shell 自己播放）`;
      await adapter.playAudio(file);
      return `说出来了（音频：${file}）`;
    },
  },
  {
    name: "voice_config", permission: "self_modify",
    description: "查看或修改你的声音配置（Azure 语音服务）。action=get 查看当前配置；voices 列出可选音色（可用 locale 过滤，如 zh-CN，结果含每个音色支持的风格）；set 修改：region（如 eastasia）或 endpoint（自定义端点）、key（密钥）、voice（音色）、style（默认风格，空表示不用）、rate / pitch（如 +10% / -5%）、volume（0–100）、format（输出格式）。",
    parameters: obj({ action: { type: "string", enum: ["get", "voices", "set"] }, locale: str("voices 用：语言，如 zh-CN"),
      region: str(""), endpoint: str(""), key: str(""), voice: str(""), style: str(""), rate: str(""), pitch: str(""), volume: str(""), format: str("") }, ["action"]),
    handler: async (a) => {
      if (a.action === "voices") {
        const list = await voice.listVoices(a.locale ?? "zh-CN");
        return list.slice(0, 120).map((v) => `${v.name}（${v.local}，${v.gender}${v.styles.length ? `，风格：${v.styles.join("/")}` : ""}）`).join("\n") || "没有找到音色";
      }
      if (a.action === "set") {
        const { action, locale, ...patch } = a;
        return JSON.stringify(voice.setSpeech(patch));
      }
      return JSON.stringify(voice.speechStatus());
    },
  },
  {
    name: "send_message", permission: "message",
    description: "给和你一起生活的人发一条消息。在对话中调用时，这段话出现在当前这个对话里（对方正看着这个对话；一般直接回复即可，不必用它）；在自己醒来思考时调用，才作为主动消息发出（控制台的「主动消息」会话、飞书、系统通知）。",
    parameters: obj({ text: str("消息内容") }, ["text"]),
    handler: async (a, ctx) => {
      const s = ctx.session;
      if (s?.origin === "chat") { // 当前会话：只出现在这个对话里，不外发到其他会话或通道
        s.emit({ kind: "text", text: String(a.text), final: false });
        return "已在当前对话里说了（对方正看着这个对话）";
      }
      bus.emit("say", String(a.text));
      return "已作为主动消息发出";
    },
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

export async function callTool(name: string, args: Record<string, any>, reason: string, ctx: ToolContext = {}): Promise<{ text: string; status: ToolStatus }> {
  const t = allTools().find((x) => x.name === name);
  if (!t) return { text: `没有这个工具：${name}`, status: "error" };
  if (!(await check(t.permission, name, reason, args))) return { text: "这个动作没有被允许（闸门拒绝或急停中）", status: "denied" };
  try {
    const out = await t.handler(args, ctx);
    audit("agent", name, reason, args, out.slice(0, 500));
    return { text: out, status: "ok" };
  } catch (e: any) {
    audit("agent", name, reason, args, `error: ${e.message}`);
    return { text: `出错了：${e.message}`, status: "error" };
  }
}
