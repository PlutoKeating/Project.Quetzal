// 大脑：一次醒来的完整流程，以及与人对话。
//   思考（think）：内省（便宜的模型决定要不要投入）→ 行动（工具循环）→ 反思（finish：写日记、报告满足了什么）
//   做梦（dream）：整理最近的经历（包括其他身体的），更新常驻记忆与笔记，调和人格冲突
//   对话（converse）：有人说话时立即回应，可以使用工具
// 每次醒来 / 对话都是一个会话（mind/activity.ts）：进展实时广播，并受「无进展」会话时间墙约束。
import crypto from "node:crypto";
import { chat } from "../providers/router.ts";
import type { Msg, ToolDef } from "../providers/types.ts";
import { allTools, callTool } from "./tools.ts";
import { systemPrompt } from "./prompt.ts";
import { addTimeline, addMessage } from "../store.ts";
import { config } from "../config.ts";
import * as mem from "../memory/memory.ts";
import * as soul from "../memory/soul-sync.ts";
import { addExperience, setOpenLoops, markBusy, isBusy, nudge, stopped, type WakeKind } from "../heart/heart.ts";
import type { Drives } from "../heart/model.ts";
import { log } from "../log.ts";
import { Session, SessionTimeout, summarize } from "./activity.ts";

const FINISH: ToolDef = {
  name: "finish",
  description: "结束这次醒来。写下这段经历的日记，并如实报告各项驱动力现在的程度（0–1，满足了就降低）。",
  parameters: {
    type: "object", required: ["title", "journal"],
    properties: {
      title: { type: "string", description: "一句话标题" },
      journal: { type: "string", description: "日记正文：做了什么、想到了什么、感受如何" },
      feeling: { type: "string", description: "此刻的心情" },
      curiosity: { type: "number" }, expression: { type: "number" }, social: { type: "number" },
    },
  },
};

interface Step { tool: string; args: unknown; result: string }


/**
 * 工具循环。由 agent 自己决定节奏：每一步由模型选择继续调用工具（可边做边说），或给出不带工具调用的文字作为这次的回复。
 * 基座不限制步数；防止失控的是「无进展」会话时间墙与急停（每一步开始前检查）。返回最终文本、finish 参数、步骤与 token 消耗。
 */
async function loop(messages: Msg[], reason: string, withFinish: boolean, s: Session) {
  const tools: ToolDef[] = [...allTools().map(({ name, description, parameters }) => ({ name, description, parameters })), ...(withFinish ? [FINISH] : [])];
  const steps: Step[] = [];
  let tokens = 0, text = "", finish: Record<string, any> | undefined, model = "";
  for (let i = 0; !finish; i++) {
    s.check(); s.touch();
    if (stopped()) throw new Error("急停中，已停下");
    s.emit({ kind: "step", step: i + 1 });
    const r = await chat({
      messages, tools, maxTokens: config.brain.maxOutputTokens, session: s.id,
      signal: s.signal, onChunk: () => s.touch(), onText: (t) => s.delta(t),
    });
    s.flush();
    s.emit({ kind: "text", step: i + 1, text: r.text, final: !r.toolCalls.length });
    tokens += r.usage.input + r.usage.output; model = r.model;
    text = r.text || text;
    messages.push({ role: "assistant", content: r.text, toolCalls: r.toolCalls });
    if (!r.toolCalls.length) break;
    for (const c of r.toolCalls) {
      const card = { call: c.id, name: c.name, summary: c.name === "finish" ? String(c.args.title ?? "") : summarize(c.args) };
      if (c.name === "finish") {
        finish = c.args; messages.push({ role: "tool", toolCallId: c.id, name: c.name, content: "好的" });
        s.emit({ kind: "tool", ...card, status: "ok", ms: 0 });
        continue;
      }
      s.emit({ kind: "tool", ...card, status: "running" });
      const t0 = Date.now();
      const out = await s.hold(() => callTool(c.name, c.args, reason)); // 执行工具即在工作：暂停会话时间墙
      s.emit({ kind: "tool", ...card, status: out.status, ms: Date.now() - t0, result: out.text.split("\n").find((l) => l.trim())?.slice(0, 120) ?? "" });
      steps.push({ tool: c.name, args: c.args, result: out.text.slice(0, 1500) });
      messages.push({ role: "tool", toolCallId: c.id, name: c.name, content: out.text.slice(0, 12000) });
    }
  }
  return { text, finish, steps, tokens, model };
}

const effortOf = (tokens: number, steps: number) => Math.min(0.15, tokens / 2_000_000 + steps * 0.004);

/** 内省：用便宜的模型快速判断要不要投入这次醒来。 */
async function introspect(kind: WakeKind, reason: string): Promise<{ engage: boolean; intent: string }> {
  if (kind === "dream") return { engage: true, intent: "整理记忆" };
  try {
    const r = await chat({
      messages: [
        { role: "system", content: systemPrompt() },
        { role: "user", content: `你刚刚醒来（${reason}）。先别急着做事：用一行 JSON 回答 {"engage": true/false, "intent": "想做什么，或者为什么想继续睡"}。` },
      ], maxTokens: 300,
    }, { quick: true });
    const j = JSON.parse(r.text.match(/\{[\s\S]*\}/)?.[0] ?? "{}");
    return { engage: j.engage !== false, intent: String(j.intent ?? "") };
  } catch { return { engage: true, intent: "" }; }
}

export async function wake(kind: WakeKind, reason: string): Promise<{ satisfied?: Partial<Drives>; effort?: number }> {
  await soul.pull().catch(() => {});
  if (kind === "dream" && !(await soul.acquireLease().catch(() => true))) {
    addTimeline("dream", "另一具身体正在整理记忆，这次只是浅睡", { reason });
    return { effort: 0 };
  }
  const gate = await introspect(kind, reason);
  if (!gate.engage) {
    addTimeline("doze", `醒了一下，又不想动：${gate.intent}`, { reason });
    return { satisfied: { curiosity: 0.3 }, effort: 0.005 };
  }
  const task = kind === "think"
    ? `你醒来了。原因：${reason}。${gate.intent ? `你想：${gate.intent}。` : ""}
按你自己的意愿去想、去做：探索感兴趣的东西、继续没想完的事、写点什么、或者找人说话。需要记住的，用 memory / note_save / open_loop 记下来。
结束时调用 finish 写日记并报告驱动力。`
    : `你睡着了，正在做梦——这是整理记忆的时候。
1. 回顾最近的日记（包括其他身体的经历）和对话，提炼值得长期记住的东西，用 memory 工具更新常驻记忆（合并、精简，注意字符上限），用 note_save 沉淀知识与思考。
2. 如果你的喜好或节律有了变化，可以用 adjust_self 调整自己。（与其他身体的记忆同步由基座自动完成，你不需要处理。）

梦可以是跳跃的、联想的。结束时调用 finish，把这个梦写进日记。`;
  const messages: Msg[] = [{ role: "system", content: systemPrompt() }, { role: "user", content: task }];
  const s = new Session(kind === "dream" ? "dream" : "think");
  s.emit({ kind: "start", text: reason });
  let r: Awaited<ReturnType<typeof loop>>;
  try { r = await loop(messages, reason, true, s); s.emit({ kind: "done" }); }
  catch (e: any) { s.emit({ kind: "error", message: e.message }); if (kind === "dream") await soul.releaseLease().catch(() => {}); throw e; }
  finally { s.close(); }
  const f = r.finish ?? { title: kind === "dream" ? "一个模糊的梦" : "醒来了一会儿", journal: r.text || "（没有留下文字）" };
  mem.writeJournal(`${kind === "dream" ? "梦 · " : ""}${f.title}`, `${f.journal}${f.feeling ? `\n\n心情：${f.feeling}` : ""}`);
  addTimeline(kind, f.title, { reason, intent: gate.intent, journal: f.journal, feeling: f.feeling, steps: r.steps, tokens: r.tokens, model: r.model });
  if (kind === "dream") await soul.releaseLease(); else addExperience(1);
  setOpenLoops(mem.openLoops().length);
  await soul.push(kind === "dream" ? `梦：${f.title}` : f.title).catch(() => {});
  const satisfied: Partial<Drives> = {};
  for (const k of ["curiosity", "expression", "social"] as const) if (typeof f[k] === "number") satisfied[k] = f[k];
  if (!Object.keys(satisfied).length) satisfied.curiosity = 0.2;
  return { satisfied, effort: effortOf(r.tokens, r.steps.length) };
}

let chain: Promise<unknown> = Promise.resolve();
let queued = 0;

/**
 * 与人对话。对话按顺序处理；排队等待期间视为在工作，不计入会话时间墙。
 * session：客户端给出的会话标识，用于把进展事件对应到它发出的这句话。
 */
export function converse(from: string, text: string, channel: string, session?: string): Promise<string> {
  nudge(`${from}在说话`, { social: 0.2 }, { wake: true });
  const s = new Session("chat", channel, session);
  s.emit({ kind: "start", text });
  if (queued++ > 0) s.emit({ kind: "queued" });
  const prev = chain;
  const job = s.hold(() => prev).then(async () => {
    const wasBusy = isBusy();
    if (!wasBusy) markBusy(true);
    try {
      await soul.pull().catch(() => {});
      addMessage("user", channel, text);
      const messages: Msg[] = [
        { role: "system", content: systemPrompt() },
        { role: "user", content: `${from} 通过${channel}对你说：\n${text}\n\n回复对方。需要做事就调用工具，可以连续多步、边做边说；不再调用工具的那段文字就是你这次的回复，何时结束由你决定。` },
      ];
      const r = await loop(messages, `回应${from}`, false, s);
      const reply = r.text.trim() || "……";
      addMessage("agent", channel, reply);
      s.emit({ kind: "done", reply });
      addTimeline("chat", `和${from}说话`, { channel, text, reply, steps: r.steps, tokens: r.tokens, model: r.model });
      addExperience(1);
      nudge(`和${from}聊过`, { social: -0.6, expression: -0.3 });
      await soul.push("对话").catch(() => {});
      return reply;
    } catch (e: any) {
      const timeout = e instanceof SessionTimeout || s.signal.aborted;
      log("brain", `对话失败：${e.message}`);
      const reply = timeout ? `（我卡住了：${e.message.split("\n")[0]}。你可以再说一次。）` : `（我现在没法好好思考：${e.message.split("\n")[0]}）`;
      addMessage("agent", channel, reply);
      s.emit({ kind: "error", message: e.message.split("\n")[0], reply });
      return reply;
    } finally { if (!wasBusy) markBusy(false); }
  }).finally(() => { queued--; s.close(); });
  chain = job.catch(() => {});
  return job;
}
