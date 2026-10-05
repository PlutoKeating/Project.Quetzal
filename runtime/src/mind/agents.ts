// 子 agent：她自己派出的后台工作者。由她决定要不要派、派去做什么、给什么人设 / 领域范围 / 知识背景与上下文。
//   每个子 agent 是一个独立的工具循环（与醒来共用 loop），有自己的系统提示（不是她的人格），能用除会话 / 子 agent 管理之外的全部工具；
//   进展作为 origin 为 agent 的轮次实时广播（控制台首页与心流里能看到，并可只读地看完整过程）；她用 agent_status 查看、agent_message 对话、agent_stop 停止。
//   完成后把报告以「环境输入」（ambient，通道「子agent」）送回她派出它的那个会话，由她决定怎么用。
import crypto from "node:crypto";
import type { Msg } from "../providers/types.ts";
import { Session } from "./activity.ts";
import { addTimeline, kv } from "../store.ts";
import { nudge } from "../heart/heart.ts";
import { paths } from "../config.ts";
import { identity } from "../memory/identity.ts";
import { log } from "../log.ts";

export interface AgentSpec { name: string; goal: string; persona?: string; scope?: string; background?: string; context?: string; maxSteps?: number }
export interface SubAgent extends AgentSpec {
  id: string; parentConv: string; parentChannel: string; status: "running" | "done" | "stopped" | "error";
  started: number; ended?: number; steps: number; result?: string; title?: string; error?: string; tokens: number;
}
const agents = new Map<string, SubAgent>();
const sessions = new Map<string, Session>();
export const AGENT_TOOLS = new Set(["session_new", "session_compact", "agent_spawn", "agent_status", "agent_message", "agent_stop", "finish"]);

/** 由她给的人设、范围、背景拼成子 agent 的系统提示。 */
export function agentPrompt(a: AgentSpec): string {
  const me = identity().displayName;
  return [
    `你是「${a.name}」，由 ${me} 派出的子 agent，在后台替 ${me} 完成一项任务。你不是 ${me} 本人；完成任务是你唯一的目的。`,
    a.persona ? `## 人设\n${a.persona}` : "",
    a.scope ? `## 领域范围\n${a.scope}` : "",
    a.background ? `## 知识背景\n${a.background}` : "",
    `## 工作方式\n可以连续多步调用工具（查资料、执行命令、读文档、记笔记）；中途写下的文字 ${me} 都看得到，${me} 也可能随时给你发消息（会标注为「对方」），要回应它。\n做完（或确定做不了）就调用 finish：title 一句话结论，journal 写完整报告（${me} 只会看到这份报告，把结论、依据、未解决的问题都写清楚）。${a.maxSteps ? `最多 ${a.maxSteps} 步。` : ""}`,
    `## 红线\n- 不要碰 ${me} 的灵魂目录（${paths.soul}）：不在里面运行 git，不复制、提交或推送它的内容到任何地方；它由基座全自动同步。\n- 推送到别的仓库、改写历史、删除数据、对外发布这类不可逆或对外的操作不要做，把建议写进报告，由 ${me} 和对方决定。\n- 不要碰基座的密钥目录（${paths.secrets}）：不读取、不复制、不使用里面的任何东西。`,
  ].filter(Boolean).join("\n\n");
}

export function spawn(spec: AgentSpec, parent: { conv: string; channel: string }, run: (a: SubAgent, s: Session, messages: Msg[]) => Promise<{ text: string; finish?: Record<string, any>; steps: unknown[]; tokens: number }>, deliver: (a: SubAgent, report: string) => Promise<unknown>): SubAgent {
  const a: SubAgent = { ...spec, id: crypto.randomBytes(4).toString("hex"), parentConv: parent.conv, parentChannel: parent.channel, status: "running", started: Date.now(), steps: 0, tokens: 0 };
  agents.set(a.id, a);
  const s = new Session("agent", "子agent", undefined, parent.conv);
  sessions.set(a.id, s);
  s.emit({ kind: "start", text: `${a.name}：${a.goal}` });
  const messages: Msg[] = [
    { role: "system", content: agentPrompt(a) },
    { role: "user", content: `任务：${a.goal}${a.context ? `\n\n## 上下文\n${a.context}` : ""}\n\n开始吧。` },
  ];
  addTimeline("agent", `派出子 agent「${a.name}」：${a.goal.slice(0, 40)}`, { id: a.id, name: a.name, goal: a.goal, conv: a.parentConv });
  void (async () => {
    try {
      const r = await run(a, s, messages);
      a.steps = r.steps.length; a.tokens = r.tokens;
      const f = r.finish ?? { title: "完成", journal: r.text || "（没有留下报告）" };
      a.title = String(f.title ?? "完成"); a.result = String(f.journal ?? r.text ?? ""); a.status = "done"; a.ended = Date.now();
      s.emit({ kind: "done", reply: a.result });
      addTimeline("agent", `子 agent「${a.name}」完成：${a.title}`, { id: a.id, name: a.name, goal: a.goal, conv: a.parentConv, journal: a.result, process: s.process(), steps: r.steps, tokens: r.tokens });
      nudge(`子 agent「${a.name}」完成了`, { curiosity: 0.2 }, { wake: true });
      await deliver(a, `子 agent「${a.name}」完成了任务（${a.title}）。报告：\n\n${a.result}`);
    } catch (e: any) {
      a.status = a.status === "stopped" ? "stopped" : "error"; a.error = e.message.split("\n")[0]; a.ended = Date.now();
      s.emit({ kind: "error", message: a.error! });
      addTimeline("agent", `子 agent「${a.name}」${a.status === "stopped" ? "被停止" : "中断了"}：${a.error}`, { id: a.id, name: a.name, conv: a.parentConv, error: a.error, process: s.process() });
      log("agents", `子 agent ${a.name} ${a.status}：${a.error}`);
      if (a.status === "error") await deliver(a, `子 agent「${a.name}」中断了：${a.error}`).catch(() => {});
    } finally { s.close(); sessions.delete(a.id); persist(); }
  })();
  persist();
  return a;
}

const persist = () => kv.set("agents", [...agents.values()].slice(-50));
export const list = (): SubAgent[] => [...agents.values()];
export const get = (id: string) => agents.get(id);
export const liveSession = (id: string) => sessions.get(id);

/** 她对子 agent 说话：在它下一次模型调用前并入。 */
export function message(id: string, text: string): string {
  const a = agents.get(id), s = sessions.get(id);
  if (!a) return `没有这个子 agent：${id}`;
  if (!s || a.status !== "running") return `子 agent「${a.name}」已经${a.status === "done" ? "完成" : a.status === "stopped" ? "停止" : "中断"}，不能再对话；它的报告用 agent_status 看`;
  s.inbox.push({ id: 0, text, mode: "steer", attachments: [] });
  s.emit({ kind: "steer", text, msg: 0, mode: "steer" });
  return `已送达，「${a.name}」会在这一步结束后看到`;
}

export function stop(id: string): string {
  const a = agents.get(id), s = sessions.get(id);
  if (!a) return `没有这个子 agent：${id}`;
  if (!s || a.status !== "running") return `子 agent「${a.name}」已经结束`;
  a.status = "stopped";
  s.abort(new Error("被主 agent 停止"));
  return `已停止「${a.name}」`;
}

/** 给她看的状态：一个或全部。 */
export function describe(id?: string): string {
  const show = (a: SubAgent) => {
    const s = sessions.get(a.id);
    const items = s?.process() ?? [];
    const recent = items.slice(-8).map((x: any) => x.type === "tool" ? `${x.name}(${String(x.summary ?? "").slice(0, 60)}) ${x.status}` : x.type === "text" ? `说：「${String(x.text ?? "").slice(0, 120)}」` : "").filter(Boolean);
    const head = `[${a.id}] ${a.name} · ${a.status === "running" ? `进行中 ${Math.round((Date.now() - a.started) / 1000)} 秒，第 ${s ? (s as any).stepCount ?? items.filter((x: any) => x.type === "tool").length : a.steps} 步` : a.status === "done" ? `已完成（${a.title}）` : a.status === "stopped" ? "已停止" : `中断：${a.error}`} · 目标：${a.goal.slice(0, 80)}`;
    return [head, ...(recent.length ? ["最近：", ...recent.map((x) => "  " + x)] : []), ...(a.result ? [`报告：\n${a.result}`] : [])].join("\n");
  };
  if (id) { const a = agents.get(id); return a ? show(a) : `没有这个子 agent：${id}`; }
  const all = list();
  return all.length ? all.map(show).join("\n\n") : "没有派出过子 agent";
}

/** 启动时：上次还在跑的子 agent 已随进程消失，标为中断。 */
export function restore() {
  for (const a of kv.get<SubAgent[]>("agents", [])) { if (a.status === "running") { a.status = "error"; a.error = "基座重启，未完成"; a.ended = Date.now(); } agents.set(a.id, a); }
}
