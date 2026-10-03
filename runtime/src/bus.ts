// 进程内事件总线：模块之间只通过事件和少量函数调用耦合。
import { EventEmitter } from "node:events";

export interface Events {
  sense: [kind: string, detail: Record<string, unknown>]; // 身体/环境事件
  message: [from: string, text: string, channel: string]; // 有人对 agent 说话
  poke: [note: string];
  timeline: [entry: TimelineEntry];
  state: [];
  approval: [a: Approval];
  say: [text: string]; // agent 主动说话，由各通道投递
  notice: [text: string]; // 系统通知（非 agent 本人说话），如配对码
  activity: [a: Activity]; // 会话进展：步骤、流式文字、工具执行、心跳、结束
  secret: [e: SecretEvent]; // 保密输入（pass_secret）的开始、进展与结束，由各通道提醒对方
}
export interface TimelineEntry { id: number; ts: number; kind: string; title: string; detail: unknown }
/** 会话进展事件（见 mind/activity.ts）。 */
export interface Activity {
  session: string; conv: string; origin: "chat" | "think" | "dream"; channel: string; ts: number; // session：这一轮的标识；conv：所属会话（醒来为空）
  kind: "start" | "queued" | "step" | "delta" | "text" | "tool" | "steer" | "alive" | "done" | "error";
  step?: number; text?: string; final?: boolean; // step：第几步；delta / text：流式片段 / 该步完整文字（final：是否为最终回复）
  call?: string; name?: string; summary?: string; status?: "running" | "ok" | "error" | "denied"; ms?: number; result?: string; // 工具
  reply?: string; message?: string; // done / error
  msg?: number; // start / steer：这句话在对话记录里的 id
  mode?: "steer" | "interrupt"; // steer：对方在她工作时发来的消息如何并入
  ambient?: boolean; // start / steer：这一轮由环境声音（麦克风听到的话）触发，不是对方发的消息
}
/**
 * 保密输入的状态（见 mind/secrets.ts）。open：刚开始，通道据此提醒对方；progress：收到了一项；done / cancelled / expired：结束。
 * 只含名字、说明与数量，永远不含值。
 */
export interface SecretEvent {
  id: string; conv: string; channel: string; status: "open" | "progress" | "done" | "cancelled" | "expired";
  purpose: string; items: { name: string; hint: string }[]; got: number; // got：已收到（done 时为已保存）的项数，按 items 的顺序
  spell: string; expires: number; // spell：结束口令；expires：没有动静时自动放弃的时刻
}
export interface Approval { id: string; action: string; reason: string; args: unknown; status: "pending" | "approved" | "denied" }

class Bus extends EventEmitter {
  emit<K extends keyof Events>(e: K, ...a: Events[K]) { return super.emit(e, ...a); }
  on<K extends keyof Events>(e: K, f: (...a: Events[K]) => void) { return super.on(e, f as any); }
}
export const bus = new Bus();
bus.setMaxListeners(50);
