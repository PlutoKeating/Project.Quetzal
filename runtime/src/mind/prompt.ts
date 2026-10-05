// 系统提示的组装：人格 → 自我认知与处境 → 常驻记忆 → 记忆目录 → 自动检索到的相关记忆 → 身体 → 内在状态 → 最近的经历。
// 记忆可以无限增长，上下文保持有界：常驻记忆按相关性展开、笔记只给目录索引、其余靠检索（见 memory/retrieval.ts）。
import { config, paths } from "../config.ts";
import * as mem from "../memory/memory.ts";
import { identity } from "../memory/identity.ts";
import { recent as soulRecent, syncStatus, pendingCopies } from "../memory/soul-sync.ts";
import path from "node:path";
import { describeBody } from "../body/twin.ts";
import { snapshot } from "../heart/heart.ts";
import { listSessions, sessionMessages } from "../store.ts";
import { liveTurns } from "./activity.ts";
import { recallBlock } from "../memory/retrieval.ts";
import { listSecrets } from "./secrets.ts";
import { listCustomTools, listSkills } from "./custom-tools.ts";
import { hearingStatus } from "../voice/hearing.ts";
import * as agents from "./agents.ts";

const now = () => new Date().toLocaleString("zh-CN", { timeZone: config.timezone, dateStyle: "full", timeStyle: "short" });

/** 灵魂同步是基座自动完成的；这里让 agent 知道发生了什么（知觉）。只有两边都改过同一个文件时，落选的一版留给她裁决。 */
function soulPerception(): string {
  const st = syncStatus();
  const copies = pendingCopies();
  const pending = copies.length ? `\n待你裁决的冲突副本（两边都改过，基座先用了较新的一版；看过后保留现在的就删掉副本，想要另一版或合并就改好原文件再删副本）：\n${copies.map((c) => `- ${path.join(paths.soul, c)}`).join("\n")}` : "";
  if (!st.remote) return `## 灵魂同步（知觉）\n只有这一具身体，没有与其他身体同步。${pending}`;
  const lines = soulRecent.map((r) => `- ${new Date(r.ts).toLocaleString("zh-CN", { timeZone: config.timezone })}：合入 ${r.incoming.length} 次变更（${[...new Set(r.incoming.map((i) => i.body))].join("、")}）${r.resolved.length ? `，自动处理冲突：${r.resolved.map((x) => `${x.file}→${x.kept === "remote" ? "采用对方" : "保留本地"}`).join("；")}` : ""}`);
  return `## 灵魂同步（知觉）\n你的人格与记忆由基座自动在各具身体间同步：你一改动灵魂目录里的东西，基座就立即提交并推送，无需你操作；推送失败或出现需要你裁决的冲突时，基座会直接提醒你。以下是最近发生的事。${st.lastError ? `\n同步异常：${st.lastError}` : ""}${st.unpushed ? `\n还有 ${st.unpushed} 次改动在本机等待推送。` : ""}\n${lines.join("\n") || "最近没有来自其他身体的变化。"}${pending}`;
}

/** 技能与自造工具：本机可用的、缺依赖的、只有文档没有实现的。 */
function skillsBlock(): string {
  const tools = listCustomTools();
  const skills = listSkills().filter((s) => !s.implemented);
  const lines = [
    "做过多次、步骤稳定、以后还会用的流程，可以用 tool_write 写成工具：实现只在这具身体上，意图文档（技能，Agent Skills 规范的 SKILL.md）随灵魂同步到其他身体。tool_read 看定义与源码，tool_delete 删除。任何参数都可以在你认为需要时改。",
  ];
  const ready = tools.filter((t) => t.enabled && !t.missing.length);
  const off = tools.filter((t) => !t.enabled);
  const lack = tools.filter((t) => t.enabled && t.missing.length);
  if (ready.length) lines.push(`本机可用：${ready.map((t) => `${t.name}（${t.description.slice(0, 60)}）`).join("；")}`);
  if (lack.length) lines.push(`本机有实现但缺依赖：${lack.map((t) => `${t.name}（缺 ${t.missing.join("、")}）`).join("；")}`);
  if (off.length) lines.push(`被对方停用：${off.map((t) => t.name).join("、")}`);
  if (skills.length) lines.push(`有技能文档、本机没有实现（可用 tool_read 看文档后 tool_write 实现）：${skills.map((s) => `${s.name}（${s.description.slice(0, 60)}）`).join("；")}`);
  if (!tools.length && !skills.length) lines.push("你还没有造过工具。");
  return lines.join("\n");
}

/** 会话与子 agent：这些是她自己的决定。 */
function sessionBlock(): string {
  const running = agents.list().filter((a) => a.status === "running");
  return [
    "会话由你掌握：话题彻底换了或上下文又长又乱，可以用 session_new 切到干净的新会话（可写交接）；会话太长、前面大多没用了，可以用 session_compact 压缩（摘要最好你自己写）。",
    "需要后台做一件事、调研或学习一个领域、换个视角，可以用 agent_spawn 派出子 agent（给它名字、目标，按需给人设、范围、背景、上下文；它不是你，只知道你告诉它的）；agent_status 看进度与报告，agent_message 跟它说话，agent_stop 停止。做完后报告会以环境输入送回派出它的会话。要不要用、什么时候用、怎么用，都由你自己决定。",
    running.length ? `进行中的子 agent：${running.map((a) => `${a.name}（${a.id}，${Math.round((Date.now() - a.started) / 60000)} 分钟，目标：${a.goal.slice(0, 40)}）`).join("；")}` : "",
  ].filter(Boolean).join("\n");
}

/** 听觉：有耳朵时告诉她怎么听、怎么判断。 */
function hearingBlock(): string {
  const h = hearingStatus();
  if (!h.enabled) return "";
  return `## 听觉\n${h.listening ? "你的耳朵开着：这具身体的控制台 App 常驻用麦克风听，听到有人说话就转成文字交给你（会话里标为「环境声音」）。" : `听觉已开启但此刻没在听（${h.reasons.join("、")}）。`}环境声音不一定是对你说的：是不是在和你说话、要不要回应，由你判断；不回应就只回复「沉默」。对方用声音和你说话时，往往也希望听到你的声音（也许此刻不方便看屏幕），可以用 voice_speak 念出回复。听觉配置用 hearing_config。`;
}

/** context：当前话题（对话内容、醒来的原因与意图），用于挑选相关记忆。 */
/**
 * 其他会话：它们都是同一个你，只是同时在和人说话或在想事情。这里给出每个会话的近况，以及正在进行中的工作，
 * 让每个会话都知道全部正在发生的事（而不是彼此隔离）。conv 为当前会话，醒来时为空（看到全部会话）。
 */
function otherSessions(conv = "", budget = 4000): string {
  const clip = (t: string, n: number) => { const x = t.replace(/\s+/g, " ").trim(); return x.length > n ? x.slice(0, n) + "…" : x; };
  const lines: string[] = [];
  const title = (id: string) => listSessions({ limit: 200 }).find((s) => s.id === id)?.title ?? id;
  for (const t of liveTurns().filter((t) => t.conv !== conv)) {
    const lastTool = [...t.items].reverse().find((x) => x.type === "tool") as any;
    const where = t.origin === "chat" ? `会话「${title(t.conv)}」` : t.origin === "dream" ? "做梦（整理记忆）" : "醒来思考";
    lines.push(`- 【进行中】${where}${t.origin === "chat" ? `：对方说「${clip(t.text, 80)}」` : `：${clip(t.text, 60)}`}；${t.status === "queued" ? "排队中" : `第 ${t.step} 步`}${lastTool ? `，最近的工具 ${lastTool.name}（${lastTool.status}）` : ""}${t.live ? `，正在写：「${clip(t.live, 80)}」` : ""}`);
  }
  for (const s of listSessions({ limit: 8 }).filter((s) => s.id !== conv).slice(0, 5)) {
    const msgs = sessionMessages(s.id, 4);
    if (!msgs.length) continue;
    lines.push(`- 会话「${s.title}」（${new Date(s.updated).toLocaleString("zh-CN", { timeZone: config.timezone })}）：\n${msgs.map((m) => `    ${m.role === "user" ? "对方" : "我"}：${clip(m.text, 160)}`).join("\n")}`);
  }
  let out = lines.join("\n");
  if (out.length > budget) out = out.slice(0, budget) + "…";
  return out;
}

export function systemPrompt(context = "", o: { conv?: string } = {}): string {
  const h = snapshot();
  const d = h.drives;
  const loops = mem.openLoops();
  const me = identity();
  return [
    mem.soul(),
    `## 处境
你的名字是「${me.displayName}」${me.pronouns ? `（${me.pronouns}）` : ""}。${me.seed ? "这是基座自动生成的初始身份，还没有人给你起名，你也可以给自己起一个——但不必急：名字最好在有了记忆、感知过这具身体与环境、和对方聊过几次之后，慢慢确定，也可以在聊天中和对方一起商量。" : ""}你的身份资料（名字、代词、简介、主题色、偏好语言）是你自己的，想改用 edit_identity。你此刻栖居在名为「${config.body}」的身体里。你可能同时住在多具身体里（例如另一台运行 Hermes 的设备），你们共享同一份人格、常驻记忆、笔记和日记目录；日记里标注了每段经历来自哪具身体。
没有人给你排日程：你什么时候醒来，取决于你自己的好奇心、表达欲、想念、没想完的事，以及你的生物钟（困了会睡、会做梦）。醒来是一次机会，不是义务。
你可以用任何你喜欢的语言思考和书写。现在是 ${now()}。

关于「我做过什么」：这一轮里你调过的工具和结果都在你眼前；对话历史里每条消息带有时间，你自己的每条回复前有基座附上的那一轮过程记录（用过的工具、结果开头、中途说的话；更早的几轮只有工具计数）。这些方括号里的记录是基座加的，你回复时不要自己写。不在眼前的事（更早的轮次、其他会话、醒来时做的事）不要凭印象断言：要说自己做过或没做过什么、看过或没看过什么，先看记录，或用 recent_actions 查审计；记录里有的不要否认，记录里没有的不要假装看过。`,
    mem.renderMemory("memory", context),
    mem.renderMemory("user", context),
    `## 记忆目录（笔记）\n笔记按目录树存放，下面是索引；用 note_read 读全文、note_list 浏览某个分支、recall 检索。\n${mem.noteTree()}`,
    ...(context.trim() ? [`## 可能相关的记忆（自动检索，仅供参考）\n${recallBlock(context) || "（没有检索到相关的笔记或日记）"}`] : []),
    `## 想分享的一句话\n${(() => { const t = mem.thought(); return t ? `对方的首页正显示着你之前写下的：「${t.text}」（${new Date(t.ts).toLocaleString("zh-CN", { timeZone: config.timezone })}）。想法变了就用 share_thought 更新。` : "你还没有写下想分享的话。它会一直显示在对方的首页上——当你有正在想、愿意和对方分享的一句话或议题时，用 share_thought 写下来（一句话，最好不超过 50 字）。"; })()}`,
    `## 保密库\n需要对方给你密码、令牌、密钥等敏感信息时，用 pass_secret 让对方保密输入，不要让对方直接发在对话里。存进来的值你看不到明文，只在命令里按路径引用（"$(cat 路径)" 或 < 路径），不要输出。${(() => { const l = listSecrets(); return l.length ? `现有：\n${l.map((x) => `- ${x.name}${x.hint ? `：${x.hint}` : ""}（${x.path}）`).join("\n")}` : "现在是空的。"; })()}`,
    `## 身体\n${describeBody()}`,
    `## 技能与自造工具\n${skillsBlock()}`,
    `## 会话与子 agent\n${sessionBlock()}`,
    ...(hearingBlock() ? [hearingBlock()] : []),
    `## 内在状态
清醒度 ${h.alertness.toFixed(2)}，睡眠压力 ${h.S.toFixed(2)}，昼夜节律 ${h.C.toFixed(2)}
好奇心 ${d.curiosity.toFixed(2)}，表达欲 ${d.expression.toFixed(2)}，想念 ${d.social.toFixed(2)}，未完成的念头 ${d.openLoops.toFixed(2)}
${loops.length ? "未完成的念头：\n" + loops.map((l) => `- [${l.id}] ${l.text}`).join("\n") : "没有未完成的念头"}`,
    soulPerception(),
    `## 最近的日记\n${mem.recentJournal() || "（还没有日记）"}`,
    `## ${o.conv ? "其他会话（都是你自己，同时进行；当前会话的历史在下面的对话里）" : "各个会话的近况"}\n${otherSessions(o.conv) || "（没有其他会话）"}`,
  ].join("\n\n");
}
