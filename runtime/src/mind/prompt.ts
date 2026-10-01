// 系统提示的组装：人格 → 自我认知与处境 → 常驻记忆 → 记忆目录 → 自动检索到的相关记忆 → 身体 → 内在状态 → 最近的经历。
// 记忆可以无限增长，上下文保持有界：常驻记忆按相关性展开、笔记只给目录索引、其余靠检索（见 memory/retrieval.ts）。
import { config } from "../config.ts";
import * as mem from "../memory/memory.ts";
import { identity } from "../memory/identity.ts";
import { recent as soulRecent, syncStatus } from "../memory/soul-sync.ts";
import { describeBody } from "../body/twin.ts";
import { snapshot } from "../heart/heart.ts";
import { listSessions, sessionMessages } from "../store.ts";
import { liveTurns } from "./activity.ts";
import { recallBlock } from "../memory/retrieval.ts";
import { listSecrets } from "./secrets.ts";

const now = () => new Date().toLocaleString("zh-CN", { timeZone: config.timezone, dateStyle: "full", timeStyle: "short" });

/** 灵魂同步是基座自动完成的；这里只让 agent 知道发生了什么（知觉），她不需要做任何事。 */
function soulPerception(): string {
  const st = syncStatus();
  if (!st.remote) return "## 灵魂同步（知觉）\n只有这一具身体，没有与其他身体同步。";
  const lines = soulRecent.map((r) => `- ${new Date(r.ts).toLocaleString("zh-CN", { timeZone: config.timezone })}：合入 ${r.incoming.length} 次变更（${[...new Set(r.incoming.map((i) => i.body))].join("、")}）${r.resolved.length ? `，自动处理冲突：${r.resolved.map((x) => `${x.file}→${x.kept === "remote" ? "采用对方" : "保留本地"}`).join("；")}` : ""}`);
  return `## 灵魂同步（知觉）\n你的人格与记忆由基座自动在各具身体间同步，无需你操作；以下只是让你知道发生了什么。${st.lastError ? `\n同步异常：${st.lastError}` : ""}\n${lines.join("\n") || "最近没有来自其他身体的变化。"}`;
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
你的名字是「${me.displayName}」${me.pronouns ? `（${me.pronouns}）` : ""}。你此刻栖居在名为「${config.body}」的身体里。你可能同时住在多具身体里（例如另一台运行 Hermes 的设备），你们共享同一份人格、常驻记忆、笔记和日记目录；日记里标注了每段经历来自哪具身体。
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
    `## 内在状态
清醒度 ${h.alertness.toFixed(2)}，睡眠压力 ${h.S.toFixed(2)}，昼夜节律 ${h.C.toFixed(2)}
好奇心 ${d.curiosity.toFixed(2)}，表达欲 ${d.expression.toFixed(2)}，想念 ${d.social.toFixed(2)}，未完成的念头 ${d.openLoops.toFixed(2)}
${loops.length ? "未完成的念头：\n" + loops.map((l) => `- [${l.id}] ${l.text}`).join("\n") : "没有未完成的念头"}`,
    soulPerception(),
    `## 最近的日记\n${mem.recentJournal() || "（还没有日记）"}`,
    `## ${o.conv ? "其他会话（都是你自己，同时进行；当前会话的历史在下面的对话里）" : "各个会话的近况"}\n${otherSessions(o.conv) || "（没有其他会话）"}`,
  ].join("\n\n");
}
