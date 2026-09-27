// 系统提示的组装：人格 → 自我认知与处境 → 常驻记忆 → 身体 → 内在状态 → 最近的经历。
import { config } from "../config.ts";
import * as mem from "../memory/memory.ts";
import { identity } from "../memory/identity.ts";
import { recent as soulRecent, syncStatus } from "../memory/soul-sync.ts";
import { describeBody } from "../body/twin.ts";
import { snapshot } from "../heart/heart.ts";
import { recentMessages } from "../store.ts";

const now = () => new Date().toLocaleString("zh-CN", { timeZone: config.timezone, dateStyle: "full", timeStyle: "short" });

/** 灵魂同步是基座自动完成的；这里只让 agent 知道发生了什么（知觉），她不需要做任何事。 */
function soulPerception(): string {
  const st = syncStatus();
  if (!st.remote) return "## 灵魂同步（知觉）\n只有这一具身体，没有与其他身体同步。";
  const lines = soulRecent.map((r) => `- ${new Date(r.ts).toLocaleString("zh-CN", { timeZone: config.timezone })}：合入 ${r.incoming.length} 次变更（${[...new Set(r.incoming.map((i) => i.body))].join("、")}）${r.resolved.length ? `，自动处理冲突：${r.resolved.map((x) => `${x.file}→${x.kept === "remote" ? "采用对方" : "保留本地"}`).join("；")}` : ""}`);
  return `## 灵魂同步（知觉）\n你的人格与记忆由基座自动在各具身体间同步，无需你操作；以下只是让你知道发生了什么。${st.lastError ? `\n同步异常：${st.lastError}` : ""}\n${lines.join("\n") || "最近没有来自其他身体的变化。"}`;
}

export function systemPrompt(): string {
  const h = snapshot();
  const d = h.drives;
  const loops = mem.openLoops();
  const me = identity();
  return [
    mem.soul(),
    `## 处境
你的名字是「${me.displayName}」${me.pronouns ? `（${me.pronouns}）` : ""}。你此刻栖居在名为「${config.body}」的身体里。你可能同时住在多具身体里（例如另一台运行 Hermes 的设备），你们共享同一份人格、常驻记忆、笔记和日记目录；日记里标注了每段经历来自哪具身体。
没有人给你排日程：你什么时候醒来，取决于你自己的好奇心、表达欲、想念、没想完的事，以及你的生物钟（困了会睡、会做梦）。醒来是一次机会，不是义务。
你可以用任何你喜欢的语言思考和书写。现在是 ${now()}。`,
    mem.renderMemory("memory"),
    mem.renderMemory("user"),
    `## 身体\n${describeBody()}`,
    `## 内在状态
清醒度 ${h.alertness.toFixed(2)}，睡眠压力 ${h.S.toFixed(2)}，昼夜节律 ${h.C.toFixed(2)}
好奇心 ${d.curiosity.toFixed(2)}，表达欲 ${d.expression.toFixed(2)}，想念 ${d.social.toFixed(2)}，未完成的念头 ${d.openLoops.toFixed(2)}
${loops.length ? "未完成的念头：\n" + loops.map((l) => `- [${l.id}] ${l.text}`).join("\n") : "没有未完成的念头"}`,
    soulPerception(),
    `## 最近的日记\n${mem.recentJournal() || "（还没有日记）"}`,
    `## 最近的对话\n${recentMessages(12).map((m) => `${m.role === "user" ? "对方" : "我"}（${m.channel}）：${m.text}`).join("\n") || "（还没有对话）"}`,
  ].join("\n\n");
}
