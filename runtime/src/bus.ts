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
}
export interface TimelineEntry { id: number; ts: number; kind: string; title: string; detail: unknown }
export interface Approval { id: string; action: string; reason: string; args: unknown; status: "pending" | "approved" | "denied" }

class Bus extends EventEmitter {
  emit<K extends keyof Events>(e: K, ...a: Events[K]) { return super.emit(e, ...a); }
  on<K extends keyof Events>(e: K, f: (...a: Events[K]) => void) { return super.on(e, f as any); }
}
export const bus = new Bus();
bus.setMaxListeners(50);
