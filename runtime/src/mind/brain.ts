// 大脑：一次醒来的完整流程，以及与人对话。
//   思考（think）：内省（便宜的模型决定要不要投入）→ 行动（工具循环）→ 反思（finish：写日记、报告满足了什么）
//   做梦（dream）：整理最近的经历（包括其他身体的），更新常驻记忆与笔记，调和人格冲突
//   对话（converse）：有人说话时立即回应，可以使用工具
// 每次醒来 / 对话都是一个会话（mind/activity.ts）：进展实时广播，并受「无进展」会话时间墙约束。
import { resolveBody } from "./body-files.ts";
import crypto from "node:crypto";
import { chat } from "../providers/router.ts";
import type { Msg, ToolDef } from "../providers/types.ts";
import { allTools, callTool } from "./tools.ts";
import { systemPrompt } from "./prompt.ts";
import { addTimeline, addMessage, ensureSession, getSession, updateSession, sessionMessages, setMessageMode, saveToolCall, type Attachment } from "../store.ts";
import { userMessage } from "./attachments.ts";
import { config } from "../config.ts";
import * as mem from "../memory/memory.ts";
import * as soul from "../memory/soul-sync.ts";
import { addExperience, setOpenLoops, markBusy, isBusy, nudge, stopped, type WakeKind } from "../heart/heart.ts";
import type { Drives } from "../heart/model.ts";
import { log } from "../log.ts";
import { Session, SessionTimeout, Interrupted, Stopped, summarize } from "./activity.ts";
import { intake, redactArgs } from "./secrets.ts";
import { noteSilence } from "../voice/hearing.ts";
import * as agents from "./agents.ts";
import { bus } from "../bus.ts";
import { remoteBodies } from "./bodies.ts";

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

interface Step { tool: string; args: unknown; result: string; status: string } // status：ok / error / denied（与过程记录里的工具卡片一致）


/** 把对方在她工作时发来的消息并入上下文（插话 / 打断），以及她用 view_image 请求查看的图片。 */
async function drain(messages: Msg[], s: Session): Promise<boolean> {
  if (s.images.length) {
    const got = s.images.splice(0);
    messages.push({ role: "user", content: `（以下是你用 view_image 请求查看的 ${got.length} 张图片：${got.map((g) => g.label).join("；")}）`, images: got.map((g) => g.image) });
  }
  if (!s.inbox.length) return false;
  for (const m of s.inbox.splice(0)) {
    if (m.notice) { messages.push({ role: "user", content: `${NOTICE[m.notice] ?? `提醒（${m.notice}）`}：\n${m.text}` }); continue; }
    messages.push(await userMessage(`对方在你工作时${m.mode === "interrupt" ? "打断了你" : "补充了新消息"}${m.via ? `（经 ${m.via} 这具身体）` : ""}：\n${m.text}`, m.attachments as Attachment[],
      m.mode === "interrupt" ? "请优先回应这条消息，再决定之前的工作是否继续。" : "请注意这条新消息，据此调整：之前的工作可以继续，也可以按新消息改变计划。", s.seen));
  }
  return true;
}

/**
 * 工具循环。由 agent 自己决定节奏：每一步由模型选择继续调用工具（可边做边说），或给出不带工具调用的文字作为这次的回复。
 * 基座不限制步数；防止失控的是「无进展」会话时间墙与急停（每一步开始前检查）。返回最终文本（结束这一轮的那一步的文字，可能为空）、finish 参数、步骤与 token 消耗。
 * 对方在她工作时发来的消息：每次调用模型前并入；「打断」会中止正在进行的模型输出（保留已输出的部分），但不会打断正在执行的工具。
 */
/** 模型某一步什么也没输出时的提醒（基座的话，不是对方说的）。 */
const BLANK = "（基座提醒，不是对方说的话：你上一步什么也没有输出——没有调用工具，也没有文字。还要做事就接着调用工具；做完了就用文字回复对方：做了什么、发现了什么、结论或下一步。）";
const BLANK_TRUNCATED = "（基座提醒，不是对方说的话：你上一步的输出到了长度上限，没有留下任何给对方的文字。不要再长篇思考，直接用文字回复对方：做了什么、发现了什么、结论或下一步。）";

/** 等工具做完；对方停止了这一轮就不再等（shell 的命令随之结束；等批准、等保密输入这类工具留在后台自行超时）。 */
function untilStopped<T>(p: Promise<T>, s: Session): Promise<T> {
  if (s.signal.aborted) return Promise.reject(s.signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => { if (s.signal.reason instanceof Stopped) reject(s.signal.reason); };
    s.signal.addEventListener("abort", onAbort, { once: true });
    p.then((v) => { s.signal.removeEventListener("abort", onAbort); resolve(v); }, (e) => { s.signal.removeEventListener("abort", onAbort); reject(e); });
  });
}

async function loop(messages: Msg[], reason: string, withFinish: boolean, s: Session, exclude?: Set<string>) {
  const tools: ToolDef[] = [...allTools().filter((t) => !exclude?.has(t.name)).map(({ name, description, parameters }) => ({ name, description, parameters })), ...(withFinish ? [FINISH] : [])];
  const steps: Step[] = [];
  let tokens = 0, text = "", finish: Record<string, any> | undefined, model = "", blanks = 0;
  const failures = new Map<string, number>(); // 这一轮里每个（工具, 参数）失败了几次
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
      const partial = stripStamp(s.stepText).trim();
      if (partial) messages.push({ role: "assistant", content: `${partial}\n（输出被对方打断）` });
      s.emit({ kind: "text", step: i + 1, text: partial ? `${partial}（被打断）` : "（被打断）", final: false });
      continue;
    } finally { s.endLLM(); }
    s.flush();
    r.text = stripStamp(r.text);
    tokens += r.usage.input + r.usage.output; model = r.model;
    // 一步什么也没给（没有工具调用、也没有文字）：多半是输出长度用完在思考上，或供应商回了空。对话里这不能算结束——
    // 不把空的一步放进上下文，提醒她一句再来，最多两次；仍然是空的才结束（converse 会说明这一轮没有回复）
    if (!withFinish && !r.toolCalls.length && !r.text.trim() && !s.inbox.length && blanks < 2) {
      blanks++;
      log("brain", `第 ${i + 1} 步模型没有输出${r.truncated ? "（到了输出长度上限）" : ""}，提醒后重试（${blanks}/2）`);
      messages.push({ role: "user", content: r.truncated ? BLANK_TRUNCATED : BLANK });
      continue;
    }
    s.emit({ kind: "text", step: i + 1, text: r.text, final: !r.toolCalls.length });
    messages.push({ role: "assistant", content: r.text, toolCalls: r.toolCalls });
    if (!r.toolCalls.length) {
      // 回复只取结束这一轮的那一步：之前各步的文字已作为中途的话进了过程记录，拿来顶替空的最后一步，同一段话就会在过程与回复里各出现一次
      if (!s.inbox.length && !s.images.length) { text = r.text; break; }
      // 本想结束，但对方刚补充了消息：这段话留作过程中的叙述，接着处理新消息
      if (r.text.trim()) s.emit({ kind: "text", step: i + 1, text: r.text, final: false });
      continue;
    }
    for (const c of r.toolCalls) {
      const card = { call: c.id, name: c.name, summary: c.name === "finish" ? String(c.args.title ?? "") : summarize(redactArgs(c.args)) }; // 参数里的保密值不进进展事件与过程记录
      if (c.name === "finish") {
        finish = c.args; messages.push({ role: "tool", toolCallId: c.id, name: c.name, content: "好的" });
        s.emit({ kind: "tool", ...card, status: "ok", ms: 0 });
        continue;
      }
      s.emit({ kind: "tool", ...card, status: "running" });
      const t0 = Date.now();
      const out = await s.hold(() => untilStopped(callTool(c.name, c.args, reason, { session: s }), s)); // 执行工具即在工作：暂停会话时间墙；对方停止时不等工具做完
      s.emit({ kind: "tool", ...card, status: out.status, ms: Date.now() - t0, result: out.text.split("\n").find((l) => l.trim())?.slice(0, 120) ?? "" });
      steps.push({ tool: c.name, args: redactArgs(c.args), result: out.text.slice(0, 1500), status: out.status });
      try { saveToolCall({ call: c.id, session: s.id, ts: Date.now(), tool: c.name, args: redactArgs(c.args), result: out.text, status: out.status, ms: Date.now() - t0 }); } catch (e) { log("brain", `没能存下工具调用的完整记录：${(e as Error).message}`); }
      // 失败（含被拒绝）写在结果的最前面：只给原文时，「exit 1」之类的结果她容易当成做成了
      let content = out.text.slice(0, 12000);
      if (out.status !== "ok") {
        const same = JSON.stringify([c.name, c.args]);
        const n = (failures.get(same) ?? 0) + 1;
        failures.set(same, n);
        content = `【这次调用${out.status === "denied" ? "没有被允许" : "失败了"}】\n${content}${n > 1 ? `\n（基座提醒，不是对方说的话：同样的调用、同样的参数，这一轮已经失败了 ${n} 次。原样重试不会有不同的结果：先看清失败的原因，换个做法，或者告诉对方卡在哪里。）` : ""}`;
      }
      messages.push({ role: "tool", toolCallId: c.id, name: c.name, content, ...(out.status !== "ok" ? { error: true } : {}) });
    }
    if (s.movedTo) { // move_to：换到另一具身体继续，这一轮在这里结束
      if (withFinish && !finish) finish = { title: `换到 ${s.movedTo} 上继续`, journal: `这次醒来换到 ${s.movedTo} 上接着做。` };
      break;
    }
  }
  return { text, finish, steps, tokens, model };
}

const effortOf = (tokens: number, steps: number) => Math.min(0.15, tokens / 2_000_000 + steps * 0.004);

/**
 * 多具身体时的运行位置（mesh/placement.ts 设置）：醒来时她看到各具身体的概况与基座的推荐，自己选在哪一具或哪几具上做；
 * run 让另一具身体执行这次醒来（它跳过内省，直接按选好的意图做）。
 */
export interface Placement {
  survey(kind: WakeKind): Promise<Survey | undefined>;
  run(body: string, kind: WakeKind, reason: string, intent: string): Promise<WakeResult>;
}
export type WakeResult = { satisfied?: Partial<Drives>; effort?: number };
/** 醒来时各具身体的概况：text 给她看（每具身体标着 uuid），bodies / recommend 是身体名（基座内部用），recommendText 是给她看的推荐。 */
export interface Survey { text: string; bodies: string[]; recommend: string[]; recommendText?: string }
let placement: Placement | undefined;
export function setPlacement(p: Placement | undefined) { placement = p; }

/** 内省：用便宜的模型快速判断要不要投入这次醒来；有多具身体时顺便选在哪里做。 */
async function introspect(kind: WakeKind, reason: string, where?: Survey): Promise<{ engage: boolean; intent: string; where: string[] }> {
  if (kind === "dream" && !where) return { engage: true, intent: "整理记忆", where: [] };
  try {
    const ask = where
      ? `你刚刚${kind === "dream" ? "进入梦境（整理记忆）" : `醒来（${reason}）`}。你此刻有几具身体在线：\n${where.text}\n基座推荐：${where.recommendText ?? where.recommend.join("、")}。\n先别急着做事：用一行 JSON 回答 {"engage": true/false, "intent": "想做什么，或者为什么想继续睡", "where": ["在哪具身体上做：填身体的 uuid，可以选一具或几具（几具会同时进行，都是你）"]}。${kind === "dream" ? "做梦只选一具。" : ""}`
      : `你刚刚醒来（${reason}）。先别急着做事：用一行 JSON 回答 {"engage": true/false, "intent": "想做什么，或者为什么想继续睡"}。`;
    const r = await chat({ messages: [{ role: "system", content: systemPrompt(reason) }, { role: "user", content: ask }], maxTokens: 300 }, { quick: true });
    const j = JSON.parse(r.text.match(/\{[\s\S]*\}/)?.[0] ?? "{}");
    // where 填的是 uuid：和身体参数一样经 resolveBody 解析成身体名（登记、认证过的连接、自报一致）；解析不了的不算
    const picked = (Array.isArray(j.where) ? j.where : typeof j.where === "string" ? [j.where] : []).slice(0, 10).map((u: unknown) => { if (typeof u !== "string" || !u.trim()) return ""; const t = resolveBody(u); return "local" in t ? config.body : "remote" in t ? t.remote.body : ""; }).filter((b: string) => b && where?.bodies.includes(b));
    return { engage: kind === "dream" || j.engage !== false, intent: String(j.intent ?? (kind === "dream" ? "整理记忆" : "")), where: picked.length ? [...new Set(picked)] as string[] : where?.recommend ?? [] };
  } catch { return { engage: true, intent: kind === "dream" ? "整理记忆" : "", where: where?.recommend ?? [] }; }
}

/** 多具身体各自的结果合起来交给心脏：满足程度取最满足的（最低值），劳累取最大的。 */
function combine(results: WakeResult[]): WakeResult {
  const satisfied: Partial<Drives> = {};
  for (const r of results) for (const [k, v] of Object.entries(r.satisfied ?? {})) if (typeof v === "number") (satisfied as any)[k] = Math.min((satisfied as any)[k] ?? 1, v);
  return { satisfied, effort: Math.max(0, ...results.map((r) => r.effort ?? 0)) };
}

/**
 * 醒来。opts.intent：另一具身体（协调者）已经替她选好了意图与位置，这里直接做（跳过内省与位置选择）。
 */
export async function wake(kind: WakeKind, reason: string, opts: { intent?: string } = {}): Promise<WakeResult> {
  await soul.pull().catch(() => {});
  let gate: { engage: boolean; intent: string; where: string[] };
  if (opts.intent !== undefined) gate = { engage: true, intent: opts.intent, where: [] };
  else {
    const survey = await placement?.survey(kind).catch(() => undefined);
    gate = await introspect(kind, reason, survey && survey.bodies.length > 1 ? survey : undefined);
    if (gate.engage && gate.where.length) {
      const where = kind === "dream" ? gate.where.slice(0, 1) : gate.where; // 做梦会改写常驻记忆：同一时间只在一具身体上整理
      const others = where.filter((b) => b !== config.body);
      if (others.length) {
        addTimeline("place", `${kind === "dream" ? "做梦" : "醒来"}：选在 ${where.join("、")} 上${gate.intent ? `——${gate.intent}` : ""}`, { kind, reason, intent: gate.intent, where });
        const runs = others.map((b) => placement!.run(b, kind, reason, gate.intent).catch((e: Error) => { addTimeline(kind, `在 ${b} 上的这次${kind === "dream" ? "梦" : "醒来"}中断了：${e.message}`, { reason, intent: gate.intent, error: e.message, body: b }); return {} as WakeResult; }));
        if (!where.includes(config.body)) return combine(await Promise.all(runs));
        const local = wake(kind, reason, { intent: gate.intent });
        return combine(await Promise.all([local, ...runs]));
      }
    }
  }
  if (kind === "dream" && !(await soul.acquireLease().catch(() => true))) {
    addTimeline("dream", "另一具身体正在整理记忆，这次只是浅睡", { reason });
    return { effort: 0 };
  }
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
2. 如果你的喜好或节律有了变化，可以用 adjust_self 调整自己。（与其他身体的记忆同步由基座自动完成；只有两边都改过同一个文件时，基座会把另一版留给你裁决，见「灵魂同步」一节。）
3. 回顾最近的工具调用（recent_actions）：反复出现、步骤稳定的 shell 流程，可以用 tool_write 沉淀成工具，并写好技能文档；灵魂仓库里有技能文档而本机没有实现的，也可以按文档实现。

梦可以是跳跃的、联想的。结束时调用 finish，把这个梦写进日记。`;
  const messages: Msg[] = [{ role: "system", content: systemPrompt(`${reason} ${gate.intent}`) }, { role: "user", content: task }];
  const s = new Session(kind === "dream" ? "dream" : "think");
  s.emit({ kind: "start", text: reason });
  let r: Awaited<ReturnType<typeof loop>>;
  // 执行过程（工具卡片与中途叙述）在 done / error 之后就从快照里移除，所以先取出来，随时间线条目保存：控制台据此只读回放这次醒来
  let process: Record<string, unknown>[] = [];
  // 做梦期间续租：这一轮还在进行（会话的时间墙按无进展计时，停滞两分钟就会中止），就每 10 分钟把整理租约往后续，不让它在 30 分钟时过期
  const renew = kind === "dream" ? setInterval(() => { void soul.renewLease().catch(() => {}); }, 10 * 60_000) : undefined;
  renew?.unref?.();
  try { r = await loop(messages, reason, true, s); process = s.process(); s.emit({ kind: "done" }); }
  catch (e: any) {
    process = s.process();
    s.emit({ kind: "error", message: e.message });
    addTimeline(kind, `醒来中断了：${e.message.split("\n")[0]}`, { reason, intent: gate.intent, error: e.message.split("\n")[0], process, model: "" });
    if (kind === "dream") await soul.releaseLease().catch(() => {});
    throw e;
  }
  finally { s.close(); clearInterval(renew); }
  const f = r.finish ?? { title: kind === "dream" ? "一个模糊的梦" : "醒来了一会儿", journal: r.text || "（没有留下文字）" };
  if (typeof f.thought === "string" && f.thought.trim()) mem.setThought(f.thought);
  mem.writeJournal(`${kind === "dream" ? "梦 · " : ""}${f.title}`, `${f.journal}${f.feeling ? `\n\n心情：${f.feeling}` : ""}`);
  addTimeline(kind, f.title, { reason, intent: gate.intent, journal: f.journal, feeling: f.feeling, thought: f.thought, process, steps: r.steps, tokens: r.tokens, model: r.model });
  if (kind === "dream") await soul.releaseLease(); else addExperience(1);
  if (s.movedTo) await (s.moveResult ?? Promise.resolve("")).catch(() => ""); // 等换过去的那具身体做完，心脏才算这次醒来结束
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

/**
 * 模型偶尔会照着历史里的格式，在回复开头自己写一段「[10/05 05:22｜…]」或「[基座附注…]」——那是基座加在历史里的附注（见 history），
 * 不是她的话；过程本身控制台已经渲染成工具卡片。系统提示里说了不要写，弱一些的模型仍会写，所以这里兜底剥掉（附注是单行的，到行尾最后一个 ] 为止）。
 */
export function stripStamp(text: string): string {
  return text.replace(/^\s*\[(?:\d{1,2}\/\d{1,2} \d{1,2}:\d{2}(?:[｜|][^\n]*)?|基座附注[^\n]*)\]\s*/u, "");
}
/**
 * 多具身体时，对方的话（与耳朵听到的话）从哪具身体进来：控制台连的网关、飞书长连接的持有者、听到的耳朵。
 * 只有一具身体时不标（没有别的可能，徒增噪声）；有别的身体在线、或这句话本来就是从别的身体进来的，才标出来。
 * 旧消息没有记（via 为空）就不标：处理它的身体（body）不一定是它进来的身体。
 * 她自己的回复按同样的规则标出是在哪具身体上做的（body）。
 */
export function entryBody(via: string | null | undefined): string | undefined {
  return via && (via !== config.body || remoteBodies().length > 0) ? via : undefined;
}
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
    : x.type === "steer" ? `（此时${x.ambient ? "听到有人说" : x.mode === "interrupt" ? "对方打断" : "对方插话"}：「${clip(String(x.text ?? ""), 60)}」）`
    : `说：「${clip(String(x.text ?? ""), 100)}」`);
  let out = lines.join("；");
  if (out.length > budget) out = out.slice(0, budget) + `…（共 ${lines.length} 步）`;
  return out;
}

/**
 * 会话自己的历史，作为真正的多轮上下文（从新到旧，在预算内）。不含这句话本身，也不含之后还在排队的话。
 * 每条都带时间；她自己的回复前附上那一轮的过程记录（最近 FULL_PROCESS 轮给出每一步，更早的只给工具计数），
 * 否则下一轮她只看得到回复的文字，不知道自己做过什么、看过什么。
 * 时间与过程记录放在回复之前一条单独的「基座附注」里（user 一侧），她自己的回复只留原文：附注若写在她的回复里，
 * 模型会照着格式在新回复开头自己编一段过程记录，越写越长（2026-10-06 出现过上千字的假记录）。
 * 不是她说的话（对方的话、摘要、交接、子 agent 报告、环境声音）都在 user 一侧。
 */
const FULL_PROCESS = 3;
export function history(conv: string, self: number, budget = 16000): Msg[] {
  const out: Msg[] = [];
  let used = 0, replies = 0;
  const listed = sessionMessages(conv, 80), at = listed.findIndex((m) => m.id === self); // 按时间排序（多具身体的编号段之间没有先后）
  const all = listed.filter((m, i) => at < 0 || i < at || m.role === "agent");
  const cut = all.map((m, i) => (m.role === "ambient" && m.channel === "摘要" ? i : -1)).filter((i) => i >= 0).at(-1) ?? -1; // session_compact：摘要之前的历史不再进入上下文
  for (const m of all.slice(Math.max(0, cut)).reverse()) {
    let text: string;
    if (m.role === "ambient" && m.channel === "摘要") {
      text = `[${stamp(m.ts)}｜你用 session_compact 压缩了这个会话，以下是之前对话的摘要，更早的原文不再在上下文里] ${m.text}`;
    } else if (m.role === "ambient" && m.channel === "交接") {
      text = `[${stamp(m.ts)}｜这是你从上一个会话切过来时写的交接] ${m.text}`;
    } else if (m.role === "ambient" && m.channel === "子agent") {
      text = `[${stamp(m.ts)}｜你派出的子 agent 送回的报告] ${m.text}`;
    } else if (m.role === "ambient") {
      const ear = entryBody(m.via);
      text = `[${stamp(m.ts)}｜环境声音：${ear ? `${ear} 这具身体的` : ""}麦克风听到并识别的话${m.mode === "ignored" ? "；你当时判断不是对你说的，没有回应" : "，不一定是对你说的"}] ${m.text}`;
    } else if (m.role === "user") {
      const files = m.attachments?.length ? `\n[${stamp(m.ts)} 随这条消息发来的附件：${m.attachments.map((f) => `${f.name}（${f.path}）`).join("、")}${m.attachments.some((f) => f.kind === "image") ? "；图片当时已附在消息里，现在只剩路径，想再看用 view_image" : ""}]` : "";
      const via = entryBody(m.via);
      text = `[${stamp(m.ts)}${m.mode === "interrupt" ? "，打断" : m.mode === "steer" ? "，插话" : ""}${via ? `｜经 ${via} 发来` : ""}] ${m.text}${files}`;
    } else {
      const proc = describeProcess(m.process, replies++ < FULL_PROCESS);
      const where = entryBody(m.body); // 多具身体时：这一轮在哪具身体上做的（那一轮拍的照片、写的文件在那具身体上）
      const on = where ? `在 ${where} 上` : "";
      const note = m.channel === "主动" // 醒来时主动发来的（或基座替她发的提醒），不是对上一句的回复
        ? `[基座附注，不是对方的话｜${stamp(m.ts)} 你${on}自己醒来时主动发了下一条消息]`
        : `[基座附注，不是对方的话｜${stamp(m.ts)} 你${on}回复了下一条${proc ? `；这一轮的过程记录：${proc}` : ""}]`;
      if (used + note.length + m.text.length > budget) break;
      used += note.length + m.text.length;
      out.unshift({ role: "user", content: note }, { role: "assistant", content: m.text });
      continue;
    }
    if (used + text.length > budget) break;
    used += text.length;
    out.unshift({ role: "user", content: text });
  }
  return out;
}

/** 她不回应环境输入时的回复标记（只回这两个字，不入库、不显示）。 */
const SILENCE = /^[\s\[【（(]*沉默[\s\]】）)]*$/;
/** 不是对方说的话、而是提醒的通道：她工作时到达就按提醒的口吻并入，不当成对方的插话。 */
const NOTICE: Record<string, string> = { "灵魂同步": "基座提醒（灵魂同步）", "子agent": "你派出的子 agent 送回了报告", "换身体": "你从另一具身体换过来继续这个会话，这是你写的交接" };
const MOVE_PROMPT = "你刚才在另一具身体上决定换到这具身体继续这个会话（对话记录都在上面）。接着做：需要做事就调用工具，最后的文字就是给对方的回复。";
const SOUL_NOTICE_PROMPT = "这是运行基座发来的提醒，不是对方说的话。你自己决定要不要处理、怎么处理（可以用工具）；需要对方帮忙的事可以告诉对方。不需要回应时只回复两个字：沉默（不会被记录成你的话）。";
const AMBIENT_PROMPT = "这是麦克风听到的环境声音（已转成文字，可能有错字、断句不准，也可能不是对你说的，比如旁人的交谈、电视）。请自己判断：是不是在对你说话、要不要回应。不需要回应时只回复两个字：沉默（不会被记录成你的话）。要回应就像平常一样回复，可以用工具。对方是用声音在和你说话，可能此刻不方便看屏幕——你可以用 voice_speak 把回复念出来，是否念由你决定。";
const AGENT_REPORT_PROMPT = "这是你派出的子 agent 送回的报告（它已经结束）。你自己决定怎么用：据此继续手头的事、把结论告诉对方、再派一个、或者什么都不做。不需要回应时只回复两个字：沉默（不会被记录成你的话）。";

/** 用便宜的模型把会话到目前为止压成一段摘要（session_compact 没给 summary 时）。 */
export async function summarizeConv(conv: string): Promise<string> {
  const msgs = history(conv, Number.MAX_SAFE_INTEGER, 24000);
  if (!msgs.length) return "（这个会话还没有内容）";
  const r = await chat({
    messages: [
      { role: "system", content: "你在替一个 agent 压缩她自己的一段对话上下文。用第二人称「你」指代她，「对方」指代和她说话的人。" },
      { role: "user", content: `把下面的对话压成一段摘要（中文，不超过 800 字）：保留对方的要求与偏好、已经做完的事与结论、还没做完的事、重要的事实与数字、双方的约定。不要寒暄，不要逐句复述。\n\n${msgs.filter((m) => !(typeof m.content === "string" && m.content.startsWith("[基座附注"))).map((m) => `${m.role === "user" ? "对方" : "你"}：${typeof m.content === "string" ? m.content : ""}`).join("\n\n")}` },
    ], maxTokens: 1200,
  }, { quick: true });
  return r.text.trim();
}

/** 子 agent 跑的工具循环：自己的系统提示、不能再派子 agent 或切会话；报告送回派出它的会话（环境输入，通道「子agent」）。 */
export function spawnAgent(spec: agents.AgentSpec, parent: { conv: string; channel: string }) {
  return agents.spawn(spec, parent, (a, s, messages) => loop(messages, `子 agent ${a.name}`, true, s, agents.AGENT_TOOLS),
    (a, report) => converse("子agent", report, "子agent", { conv: a.parentConv, ambient: true }));
}

/**
 * 与人对话。conv：会话（缺省时飞书用「飞书」会话，其余用「最初的对话」）；turn：客户端给这一轮的标识；attachments：已上传的附件。
 * ambient：这句话是麦克风听到的环境声音（听觉），以第三种消息类型入库，由她判断是否回应。
 * 排队等待期间视为在工作，不计入会话时间墙。
 */
export type ConverseOptions = { conv?: string; turn?: string; attachments?: Attachment[]; mode?: "steer" | "queue" | "interrupt"; ambient?: boolean; local?: boolean; via?: string }; // local：就在这具身体上处理，不经路由（move_to 接手的一轮）；via：这句话从哪具身体进来（别处转来时由网状层填发来的身体，缺省为这具身体）
/** 多具身体时的路由（mesh/presence.ts 设置）：这个会话正在另一具身体上进行，就把这句话转过去（作为那一轮的插话 / 打断），返回那边的回执或回复。 */
let router: ((conv: string, from: string, text: string, channel: string, o: ConverseOptions) => Promise<string> | undefined) | undefined;
export function setConverseRouter(r: typeof router) { router = r; }

export function converse(from: string, text: string, channel: string, o: ConverseOptions = {}): Promise<string> {
  const conv = o.conv || (channel === "飞书" ? "feishu" : "first");
  // 路由在保密输入的截取之前：这一轮在哪具身体上，保密值就只在那具身体上被截走
  const routed = o.local ? undefined : router?.(conv, from, text, channel, { ...o, conv });
  if (routed) return routed;
  // 保密输入进行中（pass_secret）：这条消息是一项保密值或口令，在入库、进入上下文之前截走，只回一条不含内容的回执。所有通道都经过这里
  const ack = intake(conv, text);
  if (ack !== undefined) return Promise.resolve(ack);
  ensureSession(conv, conv === "feishu" ? "飞书" : "新的对话", channel);
  const role = o.ambient ? "ambient" : "user";
  // 对方的话（与耳朵听到的话）记下从哪具身体进来；基座、子 agent、交接这些不是从某个入口进来的，不记
  const via = !o.ambient || !NOTICE[channel] ? o.via ?? config.body : undefined, shown = via ? entryBody(via) : undefined;
  // 她正在这个会话里工作时：默认「插话」（这次模型调用结束后并入）；「打断」立即中止当前模型输出（不打断工具）；「排队」作为下一轮
  const cur = running.get(conv), mode = o.mode ?? "steer";
  if (cur && mode !== "queue") {
    const id = addMessage(role, channel, text, { session: conv, attachments: o.attachments, mode, via });
    const notice = o.ambient && NOTICE[channel] ? channel : undefined;
    cur.inbox.push({ id, text: notice || !o.ambient ? text : `（环境声音，${shown ? `${shown} 这具身体的` : ""}麦克风听到的，不一定是对你说的）${text}`, mode, attachments: o.attachments ?? [], notice, via: !o.ambient ? shown : undefined });
    cur.emit({ kind: "steer", text, msg: id, mode, ambient: o.ambient });
    cur.touch();
    const cut = mode === "interrupt" && cur.interrupt();
    return Promise.resolve(cut ? "（已打断，她会马上看到这条消息）" : "（已送达，她会在这一步结束后看到）");
  }
  nudge(`${from}在说话`, { social: 0.2 }, { wake: true });
  const s = new Session("chat", channel, o.turn, conv);
  // 收到就入库：记录的顺序即发送顺序，客户端随时从后端取回都一致；start 带上消息 id，进行中的卡片挂在它下面
  const id = addMessage(role, channel, text, { session: conv, attachments: o.attachments, via });
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
        o.ambient && channel === "子agent"
          ? await userMessage(text, [], AGENT_REPORT_PROMPT, s.seen)
          : o.ambient && channel === "灵魂同步"
          ? await userMessage(`${NOTICE[channel]}：\n${text}`, [], SOUL_NOTICE_PROMPT, s.seen)
          : o.ambient && channel === "换身体"
          ? await userMessage(`${NOTICE[channel]}：\n${text}`, [], MOVE_PROMPT, s.seen)
          : o.ambient
          ? await userMessage(`你听到附近有人说${shown ? `（${shown} 这具身体的耳朵听到的）` : ""}：\n${text}`, [], AMBIENT_PROMPT, s.seen)
          : await userMessage(`${from} 通过${channel}对你说${shown ? `（经 ${shown} 这具身体）` : ""}：\n${text}`, o.attachments ?? [],
            "回复对方。需要做事就调用工具，可以连续多步、边做边说；不再调用工具的那段文字就是你这次的回复，何时结束由你决定。之前回复里说过的段落对方都看得到，除非对方要你再说一遍，不要原样再贴。", s.seen),
      ];
      let r = await loop(messages, `回应${from}`, false, s);
      while (s.inbox.length) { // 最后一步刚结束时又来了消息：继续处理
        const more = await loop(messages, `回应${from}`, false, s);
        r = { ...more, text: more.text || r.text, steps: [...r.steps, ...more.steps], tokens: r.tokens + more.tokens };
      }
      running.delete(conv);
      const process = s.process();
      if (s.movedTo) { // 换到另一具身体继续：那边在同一个会话里接着做，它的回复（经复制）就是这一轮的回复，这里不再另存
        s.emit({ kind: "done", reply: "" }); // 这里的一轮立即结束：之后发到这个会话的话会路由到接手的那具身体
        const reply = await (s.moveResult ?? Promise.resolve("")).catch((e: Error) => { const t = `（没能换到 ${s.movedTo}：${e.message}）`; addMessage("agent", channel, t, { session: conv }); return t; });
        addTimeline("chat", `和${from}说话，换到 ${s.movedTo} 上继续`, { channel, conv, text, reply, process, steps: r.steps, tokens: r.tokens, model: r.model, movedTo: s.movedTo });
        return reply;
      }
      if (o.ambient && (SILENCE.test(r.text) || (!r.text.trim() && !process.length))) { // 她判断不必回应：不留她的话，这句话标为 ignored（控制台隐藏），心流里记一笔
        setMessageMode(id, "ignored");
        s.emit({ kind: "done", reply: "" });
        if (!NOTICE[channel]) noteSilence(conv, text);
        addExperience(1);
        return "";
      }
      // 提醒过仍没有一句话：说明这一轮没有回复，而不是留一个看不懂的空回复
      const reply = r.text.trim() || (r.steps.length ? `（我做了 ${r.steps.length} 步，但最后没能把结果说出来。你可以问我一句「结果呢」。）` : "（模型连着几次什么也没输出，我没能回复。你可以再说一次。）");
      const home = s.switchTo ?? conv; // session_new：回复放进新会话
      addMessage("agent", channel, reply, { session: home, process });
      s.emit({ kind: "done", reply });
      if (s.switchTo) bus.emit("session.switch", { from: conv, to: s.switchTo, title: getSession(s.switchTo)?.title ?? "", done: true });
      addTimeline("chat", o.ambient ? (channel === "子agent" ? "收到子 agent 的报告，接着做了" : channel === "灵魂同步" ? "处理了基座关于灵魂同步的提醒" : "听到有人说话，回应了") : `和${from}说话`, { channel, conv: home, text, reply, process, steps: r.steps, tokens: r.tokens, model: r.model });
      addExperience(1);
      nudge(`和${from}聊过`, { social: -0.6, expression: -0.3 });
      await soul.push("对话").catch(() => {});
      return reply;
    } catch (e: any) {
      if (s.signal.reason instanceof Stopped) { // 对方停止了：这一轮就此结束，留一句说明（下一轮她看得到自己被停在了哪里）
        const reply = "（这一轮被对方停止了）", process = s.process();
        addMessage("agent", channel, reply, { session: conv, process });
        s.emit({ kind: "done", reply });
        addTimeline("chat", `和${from}说话，被对方停止`, { channel, conv, text, reply, process });
        return reply;
      }
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

/** 多具身体时：这个会话正在另一具身体上进行，就请那具身体停止（mesh/presence.ts 设置）。 */
let stopRouter: ((conv: string) => Promise<boolean> | undefined) | undefined;
export function setStopRouter(r: typeof stopRouter) { stopRouter = r; }

/**
 * 停止这个会话里正在进行的一轮（对方按了停止）：中止模型输出与正在执行的命令（shell 的命令随之结束），这一轮以一句说明结束；
 * 排在它后面的话照常处理。这一轮在另一具身体上就转过去停（local 为真时只停这具身体上的，网状层转来的请求用）。返回是否有一轮被停下。
 */
export async function stopTurn(conv: string, o: { local?: boolean } = {}): Promise<boolean> {
  const s = running.get(conv);
  if (s) { s.abort(new Stopped()); log("brain", `对方停止了会话 ${conv} 里正在进行的一轮`); return true; }
  return o.local ? false : (await stopRouter?.(conv)) ?? false;
}

/**
 * 灵魂同步的提醒（推送失败、冲突副本待裁决）：碰过记忆的那一轮还在进行就插话（醒来、子 agent 直接放进收件箱；对话经 converse 插话）；
 * 已经结束就在原会话里开新的一轮；醒来与子 agent 的那一轮已结束（或不知道是谁碰的）时，放进「主动消息」会话。
 */
bus.on("soul.alert", ({ text, targets }) => {
  const opened = new Set<string>();
  for (const t of targets.length ? targets : [undefined]) {
    const s = t instanceof Session ? t : undefined;
    if (s && !s.closed && s.origin !== "chat") { s.inbox.push({ id: 0, text, mode: "steer", attachments: [], notice: "灵魂同步" }); s.touch(); continue; }
    const conv = s?.origin === "chat" ? (s.switchTo ?? s.conv) : "inbox";
    if (opened.has(conv)) continue;
    opened.add(conv);
    if (conv === "inbox") ensureSession("inbox", "主动消息", "主动");
    void converse("基座", text, "灵魂同步", { conv, ambient: true }).catch((e) => log("brain", `灵魂同步的提醒没送到：${e.message}`));
  }
});
