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
import { addTimeline, addMessage, ensureSession, getSession, updateSession, sessionMessages, type Attachment } from "../store.ts";
import { userMessage } from "./attachments.ts";
import { config } from "../config.ts";
import * as mem from "../memory/memory.ts";
import * as soul from "../memory/soul-sync.ts";
import { addExperience, setOpenLoops, markBusy, isBusy, nudge, stopped, type WakeKind } from "../heart/heart.ts";
import type { Drives } from "../heart/model.ts";
import { log } from "../log.ts";
import { Session, SessionTimeout, Interrupted, summarize } from "./activity.ts";
import { intake } from "./secrets.ts";
import { noteSilence } from "../voice/hearing.ts";

const FINISH: ToolDef = {
  name: "finish",
  description: "结束这次醒来。写下这段经历的日记，并如实报告各项驱动力现在的程度（0–1，满足了就降低）。",
  parameters: {
    type: "object", required: ["title", "journal"],
    properties: {
      title: { type: "string", description: "一句话标题" },
      journal: { type: "string", description: "日记正文：做了什么、想到了什么、感受如何" },
      feeling: { type: "string", description: "此刻的心情" },
      thought: { type: "string", description: "可选：想分享的一句话——此刻在想、愿意和对方分享的一句话或议题，会显示在对方的首页（不填则保持原样）" },
      curiosity: { type: "number" }, expression: { type: "number" }, social: { type: "number" },
    },
  },
};

interface Step { tool: string; args: unknown; result: string }


/** 把对方在她工作时发来的消息并入上下文（插话 / 打断），以及她用 view_image 请求查看的图片。 */
async function drain(messages: Msg[], s: Session): Promise<boolean> {
  if (s.images.length) {
    const got = s.images.splice(0);
    messages.push({ role: "user", content: `（以下是你用 view_image 请求查看的 ${got.length} 张图片：${got.map((g) => g.label).join("；")}）`, images: got.map((g) => g.image) });
  }
  if (!s.inbox.length) return false;
  for (const m of s.inbox.splice(0)) {
    messages.push(await userMessage(`对方在你工作时${m.mode === "interrupt" ? "打断了你" : "补充了新消息"}：\n${m.text}`, m.attachments as Attachment[],
      m.mode === "interrupt" ? "请优先回应这条消息，再决定之前的工作是否继续。" : "请注意这条新消息，据此调整：之前的工作可以继续，也可以按新消息改变计划。", s.seen));
  }
  return true;
}

/**
 * 工具循环。由 agent 自己决定节奏：每一步由模型选择继续调用工具（可边做边说），或给出不带工具调用的文字作为这次的回复。
 * 基座不限制步数；防止失控的是「无进展」会话时间墙与急停（每一步开始前检查）。返回最终文本、finish 参数、步骤与 token 消耗。
 * 对方在她工作时发来的消息：每次调用模型前并入；「打断」会中止正在进行的模型输出（保留已输出的部分），但不会打断正在执行的工具。
 */
async function loop(messages: Msg[], reason: string, withFinish: boolean, s: Session) {
  const tools: ToolDef[] = [...allTools().map(({ name, description, parameters }) => ({ name, description, parameters })), ...(withFinish ? [FINISH] : [])];
  const steps: Step[] = [];
  let tokens = 0, text = "", finish: Record<string, any> | undefined, model = "";
  for (let i = 0; !finish; i++) {
    s.check(); s.touch();
    if (stopped()) throw new Error("急停中，已停下");
    await drain(messages, s);
    s.emit({ kind: "step", step: i + 1 });
    let r: Awaited<ReturnType<typeof chat>>;
    try {
      r = await chat({
        messages, tools, maxTokens: config.brain.maxOutputTokens, session: s.id,
        signal: s.beginLLM(), onChunk: () => s.touch(), onText: (t) => s.delta(t),
      });
    } catch (e) {
      if (!(e instanceof Interrupted) || s.signal.aborted) throw e;
      s.flush(); // 被打断：保留已经说出的部分，下一步带着对方的新消息继续
      const partial = s.stepText.trim();
      if (partial) messages.push({ role: "assistant", content: `${partial}\n（输出被对方打断）` });
      s.emit({ kind: "text", step: i + 1, text: partial ? `${partial}（被打断）` : "（被打断）", final: false });
      continue;
    } finally { s.endLLM(); }
    s.flush();
    s.emit({ kind: "text", step: i + 1, text: r.text, final: !r.toolCalls.length });
    tokens += r.usage.input + r.usage.output; model = r.model;
    text = r.text || text;
    messages.push({ role: "assistant", content: r.text, toolCalls: r.toolCalls });
    if (!r.toolCalls.length) {
      if (!s.inbox.length && !s.images.length) break;
      // 本想结束，但对方刚补充了消息：这段话留作过程中的叙述，接着处理新消息
      if (r.text.trim()) s.emit({ kind: "text", step: i + 1, text: r.text, final: false });
      continue;
    }
    for (const c of r.toolCalls) {
      const card = { call: c.id, name: c.name, summary: c.name === "finish" ? String(c.args.title ?? "") : summarize(c.args) };
      if (c.name === "finish") {
        finish = c.args; messages.push({ role: "tool", toolCallId: c.id, name: c.name, content: "好的" });
        s.emit({ kind: "tool", ...card, status: "ok", ms: 0 });
        continue;
      }
      s.emit({ kind: "tool", ...card, status: "running" });
      const t0 = Date.now();
      const out = await s.hold(() => callTool(c.name, c.args, reason, { session: s })); // 执行工具即在工作：暂停会话时间墙
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
        { role: "system", content: systemPrompt(reason) },
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
1. 回顾最近的日记（包括其他身体的经历）和对话，提炼值得长期记住的东西，用 memory 工具更新常驻记忆（合并重复、修正过时的内容），用 note_save 沉淀知识与思考。
   记忆没有长度上限，但每次醒来只会展开一部分：常驻记忆留给最核心、最常用的认识；细节、资料、长篇思考放进笔记目录树（如「身体/honor9/硬件」「人/PK/喜好」），写好一句话摘要。
   整理笔记目录：用 note_list 查看，note_move 归类、改名，合并重复的笔记，note_delete 删除没用的（历史中仍可找回）。
2. 如果你的喜好或节律有了变化，可以用 adjust_self 调整自己。（与其他身体的记忆同步由基座自动完成，你不需要处理。）
3. 回顾最近的工具调用（recent_actions）：反复出现、步骤稳定的 shell 流程，可以用 tool_write 沉淀成工具，并写好技能文档；灵魂仓库里有技能文档而本机没有实现的，也可以按文档实现。

梦可以是跳跃的、联想的。结束时调用 finish，把这个梦写进日记。`;
  const messages: Msg[] = [{ role: "system", content: systemPrompt(`${reason} ${gate.intent}`) }, { role: "user", content: task }];
  const s = new Session(kind === "dream" ? "dream" : "think");
  s.emit({ kind: "start", text: reason });
  let r: Awaited<ReturnType<typeof loop>>;
  // 执行过程（工具卡片与中途叙述）在 done / error 之后就从快照里移除，所以先取出来，随时间线条目保存：控制台据此只读回放这次醒来
  let process: Record<string, unknown>[] = [];
  try { r = await loop(messages, reason, true, s); process = s.process(); s.emit({ kind: "done" }); }
  catch (e: any) {
    process = s.process();
    s.emit({ kind: "error", message: e.message });
    addTimeline(kind, `醒来中断了：${e.message.split("\n")[0]}`, { reason, intent: gate.intent, error: e.message.split("\n")[0], process, model: "" });
    if (kind === "dream") await soul.releaseLease().catch(() => {});
    throw e;
  }
  finally { s.close(); }
  const f = r.finish ?? { title: kind === "dream" ? "一个模糊的梦" : "醒来了一会儿", journal: r.text || "（没有留下文字）" };
  if (typeof f.thought === "string" && f.thought.trim()) mem.setThought(f.thought);
  mem.writeJournal(`${kind === "dream" ? "梦 · " : ""}${f.title}`, `${f.journal}${f.feeling ? `\n\n心情：${f.feeling}` : ""}`);
  addTimeline(kind, f.title, { reason, intent: gate.intent, journal: f.journal, feeling: f.feeling, thought: f.thought, process, steps: r.steps, tokens: r.tokens, model: r.model });
  if (kind === "dream") await soul.releaseLease(); else addExperience(1);
  setOpenLoops(mem.openLoops().length);
  await soul.push(kind === "dream" ? `梦：${f.title}` : f.title).catch(() => {});
  const satisfied: Partial<Drives> = {};
  for (const k of ["curiosity", "expression", "social"] as const) if (typeof f[k] === "number") satisfied[k] = f[k];
  if (!Object.keys(satisfied).length) satisfied.curiosity = 0.2;
  return { satisfied, effort: effortOf(r.tokens, r.steps.length) };
}

// ---------- 对话：多个会话可以同时进行。同一会话内按顺序处理；不同会话并行，但彼此可见（系统提示里有其他会话的近况与进行中的工作）。
const chains = new Map<string, Promise<unknown>>();
const running = new Map<string, Session>(); // 会话 → 正在进行的那一轮
/** 这个会话此刻是否有正在进行的一轮（通道据此决定新消息是插话还是新的一轮）。 */
export const isRunning = (conv: string) => running.has(conv);
const waiting = new Map<string, number>();
let chatting = 0, ownsBusy = false;
const enter = () => { if (chatting++ === 0 && !isBusy()) { markBusy(true); ownsBusy = true; } };
const leave = () => { if (--chatting === 0 && ownsBusy) { ownsBusy = false; markBusy(false); } };

const clip = (t: string, n: number) => { const x = t.replace(/\s+/g, " ").trim(); return x.length > n ? x.slice(0, n) + "…" : x; };
const stamp = (ts: number) => new Date(ts).toLocaleString("zh-CN", { timeZone: config.timezone, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });

/**
 * 某一轮回复的过程记录（保存在 messages.process 里的工具卡片与中途叙述），供之后的轮次看到自己做过什么。
 * full 为真给出每一步（工具、参数摘要、结果开头、中途说的话），否则只给工具计数。
 */
export function describeProcess(items: unknown[] | null | undefined, full: boolean, budget = 1200): string {
  const list = (items ?? []) as Record<string, any>[];
  if (!list.length) return "";
  const tools = list.filter((x) => x.type === "tool");
  if (!full) {
    if (!tools.length) return `这一轮没有用工具${list.length ? "，中途说过话" : ""}`;
    const n = new Map<string, number>();
    for (const t of tools) n.set(t.name, (n.get(t.name) ?? 0) + 1);
    return `这一轮用了 ${tools.length} 个工具：${[...n].map(([k, v]) => `${k}×${v}`).join("、")}（细节用 recent_actions 查）`;
  }
  const mark = (s: string) => (s === "ok" ? "✓" : s === "running" ? "…" : "✗");
  const lines = list.map((x) => x.type === "tool"
    ? `${x.name}(${clip(String(x.summary ?? ""), 80)}) ${mark(String(x.status))}${x.result ? ` → ${clip(String(x.result), 100)}` : ""}`
    : `说：「${clip(String(x.text ?? ""), 100)}」`);
  let out = lines.join("；");
  if (out.length > budget) out = out.slice(0, budget) + `…（共 ${lines.length} 步）`;
  return out;
}

/**
 * 会话自己的历史，作为真正的多轮上下文（从新到旧，在预算内）。不含这句话本身，也不含之后还在排队的话。
 * 每条都带时间；她自己的回复前附上那一轮的过程记录（最近 FULL_PROCESS 轮给出每一步，更早的只给工具计数），
 * 否则下一轮她只看得到回复的文字，不知道自己做过什么、看过什么。
 */
const FULL_PROCESS = 3;
export function history(conv: string, self: number, budget = 16000): Msg[] {
  const out: Msg[] = [];
  let used = 0, replies = 0;
  for (const m of sessionMessages(conv, 80).filter((m) => m.id < self || m.role === "agent").reverse()) {
    let text: string;
    if (m.role === "ambient") {
      text = `[${stamp(m.ts)}｜环境声音：麦克风听到并识别的话，不一定是对你说的] ${m.text}`;
    } else if (m.role === "user") {
      const files = m.attachments?.length ? `\n[${stamp(m.ts)} 随这条消息发来的附件：${m.attachments.map((f) => `${f.name}（${f.path}）`).join("、")}${m.attachments.some((f) => f.kind === "image") ? "；图片当时已附在消息里，现在只剩路径，想再看用 view_image" : ""}]` : "";
      text = `[${stamp(m.ts)}${m.mode === "interrupt" ? "，打断" : m.mode === "steer" ? "，插话" : ""}] ${m.text}${files}`;
    } else {
      const proc = describeProcess(m.process, replies++ < FULL_PROCESS);
      text = `[${stamp(m.ts)}${proc ? `｜这一轮的过程记录：${proc}` : ""}]\n${m.text}`;
    }
    if (used + text.length > budget) break;
    used += text.length;
    out.unshift(m.role === "user" ? { role: "user", content: text } : { role: "assistant", content: text });
  }
  return out;
}

/** 她不回应环境声音时的回复标记（只回这两个字，不入库、不显示）。 */
const SILENCE = /^[\s\[【（(]*沉默[\s\]】）)]*$/;
const AMBIENT_PROMPT = "这是麦克风听到的环境声音（已转成文字，可能有错字、断句不准，也可能不是对你说的，比如旁人的交谈、电视）。请自己判断：是不是在对你说话、要不要回应。不需要回应时只回复两个字：沉默（不会被记录成你的话）。要回应就像平常一样回复，可以用工具。对方是用声音在和你说话，可能此刻不方便看屏幕——你可以用 voice_speak 把回复念出来，是否念由你决定。";

/**
 * 与人对话。conv：会话（缺省时飞书用「飞书」会话，其余用「最初的对话」）；turn：客户端给这一轮的标识；attachments：已上传的附件。
 * ambient：这句话是麦克风听到的环境声音（听觉），以第三种消息类型入库，由她判断是否回应。
 * 排队等待期间视为在工作，不计入会话时间墙。
 */
export function converse(from: string, text: string, channel: string, o: { conv?: string; turn?: string; attachments?: Attachment[]; mode?: "steer" | "queue" | "interrupt"; ambient?: boolean } = {}): Promise<string> {
  const conv = o.conv || (channel === "飞书" ? "feishu" : "first");
  // 保密输入进行中（pass_secret）：这条消息是一项保密值或口令，在入库、进入上下文之前截走，只回一条不含内容的回执。所有通道都经过这里
  const ack = intake(conv, text);
  if (ack !== undefined) return Promise.resolve(ack);
  ensureSession(conv, conv === "feishu" ? "飞书" : "新的对话", channel);
  const role = o.ambient ? "ambient" : "user";
  // 她正在这个会话里工作时：默认「插话」（这次模型调用结束后并入）；「打断」立即中止当前模型输出（不打断工具）；「排队」作为下一轮
  const cur = running.get(conv), mode = o.mode ?? "steer";
  if (cur && mode !== "queue") {
    const id = addMessage(role, channel, text, { session: conv, attachments: o.attachments, mode });
    cur.inbox.push({ id, text: o.ambient ? `（环境声音，麦克风听到的，不一定是对你说的）${text}` : text, mode, attachments: o.attachments ?? [] });
    cur.emit({ kind: "steer", text, msg: id, mode, ambient: o.ambient });
    cur.touch();
    const cut = mode === "interrupt" && cur.interrupt();
    return Promise.resolve(cut ? "（已打断，她会马上看到这条消息）" : "（已送达，她会在这一步结束后看到）");
  }
  nudge(`${from}在说话`, { social: 0.2 }, { wake: true });
  const s = new Session("chat", channel, o.turn, conv);
  // 收到就入库：记录的顺序即发送顺序，客户端随时从后端取回都一致；start 带上消息 id，进行中的卡片挂在它下面
  const id = addMessage(role, channel, text, { session: conv, attachments: o.attachments });
  if (getSession(conv)?.title === "新的对话") updateSession(conv, { title: text.replace(/\s+/g, " ").trim().slice(0, 20) || (o.attachments?.[0]?.name ?? "新的对话") });
  s.emit({ kind: "start", text, msg: id, ambient: o.ambient });
  const n = waiting.get(conv) ?? 0;
  waiting.set(conv, n + 1);
  if (n > 0) s.emit({ kind: "queued" });
  const prev = chains.get(conv) ?? Promise.resolve();
  const job = s.hold(() => prev).then(async () => {
    enter();
    running.set(conv, s);
    try {
      await soul.pull().catch(() => {});
      const messages: Msg[] = [
        { role: "system", content: systemPrompt(text, { conv }) },
        ...history(conv, id),
        o.ambient
          ? await userMessage(`你听到附近有人说：\n${text}`, [], AMBIENT_PROMPT, s.seen)
          : await userMessage(`${from} 通过${channel}对你说：\n${text}`, o.attachments ?? [],
            "回复对方。需要做事就调用工具，可以连续多步、边做边说；不再调用工具的那段文字就是你这次的回复，何时结束由你决定。", s.seen),
      ];
      let r = await loop(messages, `回应${from}`, false, s);
      while (s.inbox.length) { // 最后一步刚结束时又来了消息：继续处理
        const more = await loop(messages, `回应${from}`, false, s);
        r = { ...more, text: more.text || r.text, steps: [...r.steps, ...more.steps], tokens: r.tokens + more.tokens };
      }
      running.delete(conv);
      const process = s.process();
      if (o.ambient && (SILENCE.test(r.text) || (!r.text.trim() && !process.length))) { // 她判断不必回应：不留她的话，只在心流里记一笔
        s.emit({ kind: "done", reply: "" });
        noteSilence(conv, text);
        addExperience(1);
        return "";
      }
      const reply = r.text.trim() || "……";
      addMessage("agent", channel, reply, { session: conv, process });
      s.emit({ kind: "done", reply });
      addTimeline("chat", o.ambient ? "听到有人说话，回应了" : `和${from}说话`, { channel, conv, text, reply, process, steps: r.steps, tokens: r.tokens, model: r.model });
      addExperience(1);
      nudge(`和${from}聊过`, { social: -0.6, expression: -0.3 });
      await soul.push("对话").catch(() => {});
      return reply;
    } catch (e: any) {
      const timeout = e instanceof SessionTimeout || s.signal.aborted;
      log("brain", `对话失败：${e.message}`);
      const reply = timeout ? `（我卡住了：${e.message.split("\n")[0]}。你可以再说一次。）` : `（我现在没法好好思考：${e.message.split("\n")[0]}）`;
      addMessage("agent", channel, reply, { session: conv, process: s.process() });
      s.emit({ kind: "error", message: e.message.split("\n")[0], reply });
      return reply;
    } finally { if (running.get(conv) === s) running.delete(conv); leave(); }
  }).finally(() => { waiting.set(conv, (waiting.get(conv) ?? 1) - 1); s.close(); });
  chains.set(conv, job.catch(() => {}));
  return job;
}
