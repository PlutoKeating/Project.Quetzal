// agent 可以调用的工具。每个工具声明所属的能力类别，调用前经过闸门检查，调用后写入审计。
// 设备相关的工具由身体适配器提供（adapter.tools / adapter.hands），核心只提供与设备无关的能力。
import path from "node:path";
import { bus } from "../bus.ts";
import { audit, listAudit } from "../store.ts";
import { check } from "../guard/guard.ts";
import { shell, startJob, stopJob, getJob, listJobs } from "../sh.ts";
import * as mem from "../memory/memory.ts";
import { adjustPersonality } from "../heart/heart.ts";
import { adapter } from "../body/twin.ts";
import type { ToolDef } from "../providers/types.ts";
import { summarize, type Session } from "./activity.ts";
import { htmlToText, readDocument } from "./documents.ts";
import { webSearch, BROWSER_HEADERS } from "./search.ts";
import { loadImage } from "./images.ts";
import { describeProcesses } from "./processes.ts";
import * as voice from "../voice/azure.ts";
import { config, paths } from "../config.ts";
import { requestSecrets, redactSecrets, MAX_ITEMS } from "./secrets.ts";
import { listManifests, listCustomTools, readTool, readSkill, writeTool, deleteTool, runTool, missingRequires, SKILL_SPEC_URL } from "./custom-tools.ts";
import { PERMISSION_LABELS } from "../guard/guard.ts";
import { identity, setIdentity } from "../memory/identity.ts";
import * as soul from "../memory/soul-sync.ts";
import * as hearing from "../voice/hearing.ts";
import * as player from "../voice/player.ts";
import * as agents from "./agents.ts";
import { ensureSession, getSession, kv } from "../store.ts";
import crypto from "node:crypto";
import { addTimeline, addMessage } from "../store.ts";
import { remoteBodies, bodiesHooks, earOf } from "./bodies.ts";

/** 调用工具的上下文：当前这一轮（对话或醒来）。 */
export interface ToolContext { session?: Session }
export interface Tool extends ToolDef { permission: string; handler: (a: Record<string, any>, ctx: ToolContext) => Promise<string> }

const obj = (props: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties: props, required });
const str = (description: string) => ({ type: "string", description });


/**
 * 灵魂目录由基座管理：命令里同时出现 git 与灵魂目录，就不执行（硬性拦截，不靠自觉）。
 * 起因：一次 agent 自己在灵魂目录里改 origin、reset、push，把记忆推进了一个公开的代码仓库，又把代码历史并进了灵魂仓库。
 */
export function soulGitBlock(command: string): string | undefined {
  if (!/(^|[^\w-])git([^\w-]|$)/.test(command)) return undefined;
  const soul = paths.soul.replace(/\/+$/, "");
  const touches = command.includes(soul) || /quetzal\/soul\b|QUETZAL_HOME\}?\/soul\b|(^|[\s;&|(])cd\s+soul\b|-C\s+soul\b/.test(command);
  if (!touches) return undefined;
  return "没有执行：灵魂目录（你的人格与记忆所在的仓库）由基座全自动同步，不能在里面运行 git——改远端、reset、push、把它的内容提交到别的仓库，都可能把记忆推到错的地方、或把别的历史混进来。你改动灵魂目录里的文件，基座会立即提交并推送；同步出了问题会提醒你，需要人处理的事告诉对方。";
}

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
    name: "view_image", permission: "memory",
    description: "看图：把本地图片（自己拍的照片、下载的图片、对话里的附件等）交给你自己看，图片会在你下一步思考时出现在眼前。一次最多 4 张；较大的照片会自动缩小。之前对话里的图片只保留了路径，想再看就用它；这一轮已经在你眼前的图片（随消息附带的、刚看过的）不会重复发送。",
    parameters: obj({ paths: { type: "array", items: { type: "string" }, description: "图片的本地路径（1–4 个）" } }, ["paths"]),
    handler: async (a, ctx) => {
      if (!ctx.session) return "现在无法看图（没有进行中的思考）";
      const list = (Array.isArray(a.paths) ? a.paths : [a.paths]).filter(Boolean).slice(0, 4).map(String);
      const out: string[] = [];
      let sent = 0;
      for (const p of list) {
        const key = path.resolve(p);
        if (ctx.session.seen.has(key)) { out.push(`= ${p}：这张图这一轮已经在你眼前（随消息附带或刚看过），就是同一张，不再重复发送`); continue; }
        try {
          const { image, note } = await loadImage(p);
          ctx.session.images.push({ image, label: `${p}${note ? `（${note}）` : ""}` });
          ctx.session.seen.add(key);
          sent++;
          out.push(`✓ ${p}${note ? `：${note}` : ""}`);
        } catch (e: any) { out.push(`✗ ${p}：${e.message}`); }
      }
      return `${out.join("\n")}${sent ? "\n图片会在你下一步思考时出现（会自动选用能看图的模型）。" : ""}`;
    },
  },
  {
    name: "recent_actions", permission: "memory",
    description: "核实你自己最近真实做过的事：审计记录里每次工具调用的时间、工具、参数摘要与结果开头（包括其他会话和醒来时的）。对话历史里只有每轮的过程摘要，更早或更细的靠它查。要说自己「做过 / 没做过」某件事之前先查，不要凭印象。",
    parameters: obj({ hours: { type: "number", description: "只看最近多少小时（默认 24）" }, name: str("只看某个工具，如 view_image"), limit: { type: "number", description: "最多多少条（默认 30，最多 100）" } }),
    handler: async (a) => {
      const limit = Math.min(100, Math.max(1, Number(a.limit) || 30)), hours = Math.max(0.1, Number(a.hours) || 24);
      const rows = listAudit(limit, { action: a.name ? String(a.name) : undefined, since: Date.now() - hours * 3600_000 }).reverse();
      if (!rows.length) return `最近 ${hours} 小时没有${a.name ? `调用 ${a.name} 的` : ""}记录`;
      const when = (ts: number) => new Date(ts).toLocaleString("zh-CN", { timeZone: config.timezone, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
      const parse = (j: string) => { try { return JSON.parse(j); } catch { return {}; } };
      return `最近 ${hours} 小时的记录（旧→新，共 ${rows.length} 条${rows.length >= limit ? "，已达上限" : ""}）：\n` + rows.map((r) =>
        `${when(r.ts)} ${r.actor === "agent" ? "" : `[${r.actor}] `}${r.action}(${summarize(parse(r.args) ?? {})})${r.reason ? `〔${r.reason}〕` : ""} → ${r.result.replace(/\s+/g, " ").trim().slice(0, 120)}`).join("\n");
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
    description: "在这具身体上执行一条 shell 命令。默认等待结果（timeout 秒，默认 60，最多 600）。耗时长、或可能需要中途停下的命令（播放、下载、服务、长任务）用 background=true 放到后台，立即返回任务 id，之后用 shell_jobs 查看输出或随时停止。看进程用 processes 工具，不要用 ps（有的沙箱里 ps 看不到进程或报错）。",
    parameters: obj({ command: str("命令"), timeout: { type: "number", description: "等待秒数（前台）" }, background: { type: "boolean", description: "放到后台运行" } }, ["command"]),
    handler: async (a) => {
      const blocked = soulGitBlock(String(a.command ?? ""));
      if (blocked) return blocked;
      if (a.background) { const j = startJob(a.command); return `已在后台运行，任务 ${j.id}。用 shell_jobs 查看输出（action=output）或停止（action=stop）。`; }
      const r = await shell(a.command, Math.min(600, Math.max(1, Number(a.timeout) || 60)) * 1000);
      const out = (r.out + r.err).slice(0, 8000);
      // 输出为空而命令丢弃了 stderr：报错可能被吞了，看起来像"没有结果"，不能据此下结论（非零退出时 run 会补一句 Command failed，不算输出）
      const real = r.out + r.err.replace(/^Command failed: [^\n]*\n?/, "");
      const note = !real.trim() && /2>\s*\/dev\/null|2>&-/.test(String(a.command)) ? "\n（输出为空，而命令把 stderr 丢弃了：可能是命令报错被吞掉，不等于「没有」。去掉 2>/dev/null 再看，或换别的来源核实，比如 processes。）" : "";
      return `exit ${r.code}\n${out}${note}`;
    },
  },
  {
    name: "processes", permission: "shell",
    description: "列出这具身体上你能看到的进程（直接读 /proc，不依赖 ps）：pid、父进程、状态、已运行时长、命令行，并标出你自己（运行基座）、你的父进程和你启动的后台任务。想知道某个程序有没有在跑，用它而不是 ps。",
    parameters: obj({ filter: str("可选：按命令行子串或 pid 过滤，如 node、dnsproxy") }),
    handler: async (a) => describeProcesses(a.filter ? String(a.filter) : ""),
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
    handler: async (a, ctx) => {
      // 多具身体：对方刚才是对着另一具身体的耳朵说话的，就从那具身体说出来（离对方近）
      const ear = ctx.session?.conv ? earOf(ctx.session.switchTo ?? ctx.session.conv) : undefined;
      if (ear && ear !== config.body && remoteBodies().some((b) => b.body === ear)) {
        const r = await bodiesHooks()!.call(ear, "voice_speak", a, "对方刚才对着那具身体说话");
        return `${r.text}（在 ${ear} 上说的，离对方近）`;
      }
      const file = await voice.synthesize(String(a.text), { voice: a.voice, style: a.style, rate: a.rate, pitch: a.pitch });
      const r = await player.play(file, String(a.text)); // 有耳朵时由 App 经通话路径播放（回声消除），否则交给身体适配器
      if (r.by === "none") return `已合成：${file}（这具身体不支持播放音频，可以用 shell 自己播放）`;
      return r.interrupted ? `说到一半被对方打断了（音频：${file}）——对方说的话马上会到` : `说出来了（音频：${file}）`;
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
    name: "pass_secret", permission: "secret",
    description: "向对方索取密码、令牌、API Key、私钥等敏感信息时，必须且只能用它：不要让对方把这类内容直接发在对话里（那样你会看到明文，它还会留在对话记录和上下文里）。不涉及敏感信息时不要用。调用前先用一两句话告诉对方你要什么、为什么要、去哪里拿。调用后基座会在当前对话里提醒对方：对方把每一项各用一条消息发来，最后发回结束口令；这些消息不进入对话，直接存进这具身体的保密库（每项一个文件）。你会一直等到对方输入完毕、取消，或 10 分钟没有动静；拿到的只有每项的文件路径，看不到明文。之后在 shell 里用 \"$(cat 路径)\" 或 < 路径 引用，不要把内容输出出来（工具输出里出现的保密值会被替换成 ‹secret:名字›）。只能在对话中调用。",
    parameters: obj({
      purpose: str("用途：一句话说明为什么需要，会显示给对方"),
      items: { type: "array", description: `要对方提供的各项（1–${MAX_ITEMS} 项），对方按这个顺序一条消息发一项`, items: obj({ name: str("名字，也是保存的文件名：字母、数字、下划线、连字符，如 github_token（同名会覆盖旧值）"), hint: str("给对方看的说明：这是什么、去哪里拿") }, ["name"]) },
    }, ["purpose", "items"]),
    handler: async (a, ctx) => {
      const s = ctx.session;
      if (s?.origin !== "chat" || !s.conv) return "pass_secret 只能在对话中调用：需要对方在场，在这个对话里输入。先发消息约对方，等对方回复后在对话里再用。";
      return requestSecrets(s.conv, s.channel, String(a.purpose ?? ""), a.items);
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
  {
    name: "edit_identity", permission: "self_modify",
    description: "修改你自己的身份资料（写入灵魂仓库的 agent.json，所有身体同步，控制台的称呼与主题色随之变化）。可改：displayName 显示名、pronouns 代词、description 一句话简介、color 主题色（#RRGGBB）、language 偏好语言（如 zh-CN）、name 标识符（小写字母、数字、连字符；它用于仓库命名与提交署名，一般不要改）。只传要改的字段。给自己起名是件郑重的事：最好在有了记忆、感知过环境、和对方聊过之后再定，不必急。",
    parameters: obj({ displayName: str("显示名"), pronouns: str("代词，空字符串表示清除"), description: str("一句话简介"), color: str("主题色 #RRGGBB"), language: str("偏好语言，BCP 47"), name: str("标识符") }),
    handler: async (a) => {
      const patch: Record<string, string> = {};
      for (const k of ["displayName", "pronouns", "description", "color", "language", "name"]) if (typeof a[k] === "string") patch[k] = a[k].trim();
      if (!Object.keys(patch).length) return "没有要改的字段";
      const before = identity();
      const r = setIdentity(patch);
      const changed = Object.keys(patch).filter((k) => (before as any)[k] !== (r as any)[k]);
      if (!changed.length) return "和原来一样，没有变化";
      addTimeline("identity", `我改了自己的${changed.map((k) => ({ displayName: "名字", pronouns: "代词", description: "简介", color: "主题色", language: "偏好语言", name: "标识符" } as any)[k]).join("、")}`, { changed: Object.fromEntries(changed.map((k) => [k, (r as any)[k]])) });
      bus.emit("state");
      await soul.push("修改身份资料").catch(() => {});
      return `已更新：${changed.map((k) => `${k}=${(r as any)[k]}`).join("，")}`;
    },
  },
  {
    name: "tool_write", permission: "self_modify",
    description: `新建或改写一个你自己的工具。把做过多次、步骤稳定、以后还会用的流程写成工具，之后就能像内置工具一样直接调用（出现在工具表里，经闸门按 permission 检查）。实现只在这具身体上（QUETZAL_HOME/tools/<name>/）；意图文档 skill 随灵魂同步到其他身体，它们可以按文档自己实现，所以新工具必须写 skill。runtime=sh：source 是 shell 脚本，调用时参数以 JSON 从 stdin 传入，同时展开为环境变量 ARG_<参数名>（非字符串为 JSON），stdout 就是结果；runtime=node：source 是 ES 模块，默认导出 async (args, {dir, home}) => string，可以 import Node 内置模块。改写时只传要改的字段（name 必传）。所有参数以后都可以按需再改。`,
    parameters: obj({
      name: str("工具名：小写字母开头，可含数字、下划线、连字符，最长 40"),
      description: str("给模型看的说明：做什么、什么时候用"),
      parameters: { type: "object", description: "参数的 JSON Schema（type=object）" },
      permission: str(`能力类别，缺省 shell。可选：${Object.keys(PERMISSION_LABELS).join("、")}`),
      runtime: { type: "string", enum: ["sh", "node"] },
      source: str("实现源码"),
      timeout: { type: "number", description: "超时秒数，缺省 60，最多 600" },
      requires: { type: "array", items: { type: "string" }, description: "依赖的命令名，如 ffmpeg；本机缺少时工具不挂载并说明" },
      skill: str(`意图文档（Markdown）：用途、参数、实现思路、依赖、怎么验证、坑。可直接写正文，也可带 Agent Skills 规范的 YAML 头（${SKILL_SPEC_URL}）`),
    }, ["name"]),
    handler: async (a) => {
      const reserved = new Set(builtinNames());
      const r = await writeTool(a as any, reserved);
      addTimeline("tool", `${r.startsWith("已创建") ? "造了一个工具" : "改了一个工具"}：${a.name}`, { name: a.name, description: a.description });
      if (typeof a.skill === "string" && a.skill.trim()) await soul.push(`技能：${a.name}`).catch(() => {});
      return r;
    },
  },
  {
    name: "tool_read", permission: "memory",
    description: "查看一个自造工具的定义、源码与技能文档；没有本机实现时只给技能文档（其他身体写的）。",
    parameters: obj({ name: str("工具名") }, ["name"]),
    handler: async (a) => {
      const t = readTool(String(a.name));
      if (t) return `## tool.json\n${JSON.stringify(t.manifest, null, 2)}\n\n## ${t.manifest.runtime === "sh" ? "tool.sh" : "tool.mjs"}\n${t.source}\n\n## SKILL.md\n${t.skill || "（没有技能文档）"}`;
      const sk = readSkill(String(a.name));
      return sk ? `本机没有「${a.name}」的实现，灵魂仓库里的技能文档：\n\n${sk}` : `没有这个工具，也没有这个技能`;
    },
  },
  {
    name: "tool_delete", permission: "self_modify",
    description: "删除一个自造工具的实现；skill=true 时连技能文档一起从灵魂仓库删除（默认保留，其他身体仍可按它实现）。",
    parameters: obj({ name: str("工具名"), skill: { type: "boolean" } }, ["name"]),
    handler: async (a) => {
      const r = deleteTool(String(a.name), a.skill === true);
      addTimeline("tool", `删了一个工具：${a.name}`, { name: a.name });
      if (a.skill === true) await soul.push(`删除技能：${a.name}`).catch(() => {});
      return r;
    },
  },
  // ---------- 会话与子 agent：由她自己决定要不要、什么时候、怎么用
  {
    name: "session_new", permission: "session",
    description: "把当前对话切到一个上下文干净的新会话（相当于对方发 /new）：你这一轮的回复会落在新会话里，对方接下来的话也都在新会话里；旧会话原样保留，可在控制台找回。适合话题彻底换了、或上下文又长又乱、想重新开始的时候。handoff 是你写给新会话里的自己的交接（可选）：把需要带过去的要点写进去，它会作为新会话的第一条记录出现在你眼前；不写则什么都不带。只能在对话中调用。",
    parameters: obj({ title: str("新会话的标题（可选，不写则由第一句话决定）"), handoff: str("交接要点（可选，Markdown）") }),
    handler: async (a, ctx) => {
      const s = ctx.session;
      if (s?.origin !== "chat" || !s.conv) return "session_new 只能在对话中调用";
      if (s.switchTo) return `这一轮已经切到新会话 ${s.switchTo} 了`;
      const conv = s.channel === "飞书" ? `feishu-${Date.now().toString(36)}` : crypto.randomUUID();
      const title = String(a.title ?? "").trim() || "新的对话";
      ensureSession(conv, title, s.channel);
      if (s.channel === "飞书") kv.set("feishu.conv", conv);
      if (typeof a.handoff === "string" && a.handoff.trim()) addMessage("ambient", "交接", a.handoff.trim(), { session: conv });
      s.switchTo = conv;
      bus.emit("session.switch", { from: s.conv, to: conv, title });
      addTimeline("session", `切到新会话「${title}」`, { from: s.conv, to: conv, handoff: !!a.handoff });
      return `已切到新会话「${title}」（${conv}）：你接下来的回复会出现在那里，对方之后的话也在那里。${a.handoff ? "交接已放进去。" : ""}`;
    },
  },
  {
    name: "session_compact", permission: "session",
    description: "压缩当前会话的上下文（相当于 /compact）：之后你只看到这段摘要和它之后的新内容，更早的原文不再进入上下文（记录仍完整保留，对方在控制台能看到）；对话仍在当前会话继续。适合会话很长、很多内容已经没用、或你发现自己快记不住前面的要点时。summary 由你自己写（你眼前有全部上下文，知道什么重要）；不写则由基座用快速模型代写。只能在对话中调用。",
    parameters: obj({ summary: str("摘要（可选，Markdown）：对方的要求与偏好、做完的事与结论、没做完的事、关键事实与约定") }),
    handler: async (a, ctx) => {
      const s = ctx.session;
      if (s?.origin !== "chat" || !s.conv) return "session_compact 只能在对话中调用";
      const { summarizeConv } = await import("./brain.ts");
      const summary = typeof a.summary === "string" && a.summary.trim() ? a.summary.trim() : await summarizeConv(s.conv);
      addMessage("ambient", "摘要", summary, { session: s.conv });
      addTimeline("session", "压缩了当前会话的上下文", { conv: s.conv, chars: summary.length });
      return `已压缩：从下一轮起，你只会看到这段摘要（${summary.length} 字）和之后的内容。\n\n${summary}`;
    },
  },
  {
    name: "agent_spawn", permission: "session",
    description: "派出一个子 agent 在后台替你做一件事（相当于 /assign-agents）：你给它名字、目标，并按需给它人设、领域范围、知识背景与上下文——它不是你，没有你的记忆，只知道你告诉它的。它用自己的系统提示独立跑工具循环（能查资料、执行命令、读文档、记笔记，不能再派子 agent 或切会话），进展对方在控制台能看到，你用 agent_status 看进度与报告、agent_message 跟它说话、agent_stop 停止。做完后它的报告会作为一条环境输入送回这个会话，由你决定怎么用。适合调研、学习一个领域、长时间的后台任务、需要换一个视角的事。可以同时派多个。",
    parameters: obj({
      name: str("名字（给它的称呼）"), goal: str("目标：要它做成什么、交付什么"),
      persona: str("人设（可选）：它是谁、什么风格、什么立场"), scope: str("领域范围（可选）：只管什么、不管什么"),
      background: str("知识背景（可选）：它应当预先知道的事实、约束、术语"), context: str("上下文（可选）：相关材料、路径、对方说过的话"),
      maxSteps: { type: "number", description: "最多多少步（可选，缺省不限，由会话时间墙与急停兜底）" },
    }, ["name", "goal"]),
    handler: async (a, ctx) => {
      const s = ctx.session;
      const { spawnAgent } = await import("./brain.ts");
      const spec = { name: String(a.name).trim().slice(0, 40), goal: String(a.goal), persona: a.persona, scope: a.scope, background: a.background, context: a.context, maxSteps: a.maxSteps ? Number(a.maxSteps) : undefined };
      const sub = spawnAgent(spec, { conv: s?.conv || "first", channel: s?.channel || "控制台" });
      return `已派出「${sub.name}」（id ${sub.id}），在后台开始了。用 agent_status 看进度，agent_message 跟它说话；做完后报告会送回这个会话。`;
    },
  },
  {
    name: "agent_status", permission: "session",
    description: "查看子 agent 的进度与报告：不给 id 列出全部（含已完成的），给 id 看那一个的最近动作与完整报告。",
    parameters: obj({ id: str("子 agent 的 id（可选）") }),
    handler: async (a) => agents.describe(a.id ? String(a.id) : undefined),
  },
  {
    name: "agent_message", permission: "session",
    description: "跟进行中的子 agent 说话：补充要求、纠正方向、问它进展。它会在这一步结束后看到并回应（回应出现在它的过程里，用 agent_status 看）。",
    parameters: obj({ id: str("子 agent 的 id"), text: str("要说的话") }, ["id", "text"]),
    handler: async (a) => agents.message(String(a.id), String(a.text)),
  },
  {
    name: "agent_stop", permission: "session",
    description: "停止一个进行中的子 agent（它不会再有报告）。",
    parameters: obj({ id: str("子 agent 的 id") }, ["id"]),
    handler: async (a) => agents.stop(String(a.id)),
  },
  {
    name: "hearing_config", permission: "self_modify",
    description: "查看或修改你的听觉（控制台 App 常驻用麦克风听，基座识别后交给你判断要不要回应）。action=get 查看状态；set 修改：enabled 开关、windowMin（最近会话多少分钟内有更新就并入它）、sensitivity（1 迟钝 / 2 适中 / 3 灵敏）、language（识别语言，如 zh-CN）、minChars（短于此字数当没听清）。开关需要对方在 App 里授予过麦克风权限才真正生效。",
    parameters: obj({ action: { type: "string", enum: ["get", "set"] }, enabled: { type: "boolean" }, windowMin: { type: "number" }, sensitivity: { type: "number" }, language: str(""), minChars: { type: "number" } }, ["action"]),
    handler: async (a) => {
      if (a.action === "set") { const { action, ...patch } = a; return JSON.stringify(hearing.setHearing(patch)); }
      return JSON.stringify(hearing.hearingStatus());
    },
  },
];

/** 内置工具名（核心 + 适配器 + hands），自造工具不得与之重名。 */
export function builtinNames(): string[] {
  return [...core.map((t) => t.name), ...(adapter.tools ?? []).map((t) => t.name), ...handsTools().map((t) => t.name), "finish"];
}

/** 自造工具（本机有实现、已启用、依赖齐全的）挂进工具表。 */
function customTools(): Tool[] {
  const names = new Set(builtinNames());
  return listManifests().filter((m) => m.enabled && !names.has(m.name) && !missingRequires(m.requires).length).map((m) => ({
    name: m.name, description: m.description, parameters: m.parameters, permission: m.permission in PERMISSION_LABELS ? m.permission : "shell",
    handler: (args) => runTool(m, args),
  }));
}

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

/** 跨身体：有其他在线身体时才出现（多具身体时由 mesh/ 填入 mind/bodies.ts）。 */
function bodyTools(): Tool[] {
  const bodies = remoteBodies();
  if (!bodies.length) return [];
  const names = bodies.map((b) => b.body);
  return [
    {
      name: "body_call", permission: "body",
      description: `在你的另一具身体上调用它的工具（例如用那部手机拍照、在那台电脑上执行命令、用那具身体说话）。在线的身体：${names.join("、")}；各自的工具见系统提示「其他身体」一节。那具身体的闸门按它自己的权限判断，需要批准时会在那边请求。`,
      parameters: obj({ body: str(`身体名：${names.join(" / ")}`), tool: str("那具身体上的工具名"), args: { type: "object", description: "工具参数（与那个工具的参数一致）" } }, ["body", "tool"]),
      handler: async (a, ctx) => {
        const h = bodiesHooks();
        if (!h || !names.includes(String(a.body))) return `${a.body} 不在线（在线的：${names.join("、")}）`;
        const r = await h.call(String(a.body), String(a.tool), (a.args && typeof a.args === "object" ? a.args : {}) as Record<string, unknown>, ctx.session ? `${ctx.session.origin} ${ctx.session.conv}` : "");
        return r.status === "ok" ? r.text : `（${a.body} 上的 ${a.tool}${r.status === "denied" ? "没有被允许" : "出错了"}）${r.text}`;
      },
    },
    {
      name: "move_to", permission: "body",
      description: `换到你的另一具身体上继续这一轮（对话或醒来）：这一轮在这里结束，那具身体在同一个会话里接着做（对话记录各具身体共用），回复照常回到对方那里。适合要用那具身体的东西连续做事、那具身体更合适（电量、性能、离对方近）的时候。note 是写给接手的自己的交接。在线的身体：${names.join("、")}。`,
      parameters: obj({ body: str(`身体名：${names.join(" / ")}`), note: str("交接：要接着做什么、做到哪了") }, ["body"]),
      handler: async (a, ctx) => {
        const s = ctx.session, h = bodiesHooks(), body = String(a.body ?? "");
        if (!s || !h) return "move_to 只能在对话或醒来时调用";
        if (!names.includes(body)) return `${body} 不在线（在线的：${names.join("、")}）`;
        if (s.movedTo) return `这一轮已经在换到 ${s.movedTo} 了`;
        if (s.origin === "chat" && !s.conv) return "这一轮没有会话，没法换过去";
        s.movedTo = body;
        s.moveResult = h.move(body, { origin: s.origin, conv: s.switchTo ?? s.conv, channel: s.channel, note: String(a.note ?? "").trim(), reason: "换身体" });
        return `好，接下来在 ${body} 上继续，这里的一轮到此结束。`;
      },
    },
  ];
}

export function allTools(): Tool[] {
  return [...core, ...(adapter.tools ?? []).map((t) => ({ ...t, handler: t.handler })), ...handsTools(), ...customTools(), ...bodyTools()];
}
/** 可以被其他身体经 body_call 调用的工具：适配器的设备工具、hands、自造工具，以及属于这具身体的几个内置工具（见 bodies.ts）。 */
export function limbTools(allowedCore: Set<string>): Tool[] {
  return [...core.filter((t) => allowedCore.has(t.name)), ...(adapter.tools ?? []).map((t) => ({ ...t, handler: t.handler })), ...handsTools(), ...customTools()];
}
export { listCustomTools };

export type ToolStatus = "ok" | "error" | "denied";

export async function callTool(name: string, args: Record<string, any>, reason: string, ctx: ToolContext = {}): Promise<{ text: string; status: ToolStatus }> {
  const t = allTools().find((x) => x.name === name);
  if (!t) return { text: `没有这个工具：${name}`, status: "error" };
  if (!(await check(t.permission, name, reason, args))) return { text: "这个动作没有被允许（闸门拒绝或急停中）", status: "denied" };
  try {
    const out = redactSecrets(await t.handler(args, ctx)); // 兜底：输出里出现的保密值一律替换，再交给模型、写入审计
    audit("agent", name, reason, args, out.slice(0, 500));
    return { text: out, status: "ok" };
  } catch (e: any) {
    const msg = redactSecrets(String(e.message));
    audit("agent", name, reason, args, `error: ${msg}`);
    return { text: `出错了：${msg}`, status: "error" };
  } finally {
    // 触碰即同步：任何工具（包括 shell、自造工具）碰了灵魂目录，立即提交并安排推送
    await soul.touched({ tool: name, session: ctx.session }).catch(() => {});
  }
}
