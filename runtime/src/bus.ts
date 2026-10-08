// 进程内事件总线：模块之间只通过事件和少量函数调用耦合。
import { EventEmitter } from "node:events";

export interface Events {
  sense: [kind: string, detail: Record<string, unknown>]; // 身体/环境事件
  message: [from: string, text: string, channel: string]; // 有人对 agent 说话
  poke: [note: string];
  "reminders.changed": []; // 提醒有改动（本机）：网状层同步给其他身体
  "claims.changed": []; // 认领有改动（本机）：网状层同步给其他身体（mind/claims.ts）
  "reminders.missed": [r: { id: string; text: string; at: number }, lateMs: number]; // 错过太久、没有发出的提醒
  timeline: [entry: TimelineEntry];
  state: [];
  approval: [a: Approval];
  say: [text: string, to?: { conv: string; title: string }]; // agent 主动说话，由各通道投递；to：放进哪个会话（醒来时的 send_message 选的或新开的），缺省为「主动消息」会话（提醒、安全模式等基座发的）
  notice: [text: string]; // 系统通知（非 agent 本人说话），如配对码
  activity: [a: Activity]; // 会话进展：步骤、流式文字、工具执行、心跳、结束
  secret: [e: SecretEvent]; // 保密输入（pass_secret）的开始、进展与结束，由各通道提醒对方
  hearing: [e: HearingEvent]; // 听觉：一句话的中间结果、最终结果与她的取舍（控制台据此流式显示、保留或隐藏）
  speaking: [e: { until: number }]; // 她在说话（播放合成语音）到 until 为止，给界面用；说完或被插嘴时 until 提前到现在
  speak: [e: { id: string; url: string; text: string; ms: number }];
  "soul.alert": [e: { text: string; targets: ({ id: string; conv: string; origin: string; switchTo?: string; closed?: boolean } | undefined)[] }]; // 灵魂同步要她知道的事（推送失败、冲突副本待裁决）：大脑插话进对应的会话，已结束则开新的一轮
  "soul.pushed": [e: { files: string[] }];
  mesh: [s: unknown];
  account: [s: unknown]; // 控制台登录的状态变了（申请码、批准、退出、令牌失效），控制台据此刷新账户页
  "body.uuid": [uuid: string]; // 身体 uuid 从随机的暂用值换成了设备派生的值（灵魂同步据此推送身体登记）
  heart: []; // 心脏状态变了（协调者据此把状态广播给其他身体）
  shared: [sections: string[]]; // 本机改了全网共用的分区（设置分区，以及 memory.ts 的想分享的一句话 thought；网状层据此同步给其他身体）
  "shared.applied": [sections: string[]]; // 采用了其他身体较新的设置分区（相关模块据此生效，例如飞书持有者变了要重连）
  usage: [row: { day: string; model: string; body: string; input: number; output: number; cost: number }]; // 本机的用量变了（各身体合计每日预算）
  "replica.applied": [e: { table: string; rows: any[]; from: string }]; // 从其他身体复制来的行已写入本机（控制台据此刷新会话与对话）
  replica: [e: { table: "messages" | "timeline" | "sessions" | "message.mode"; rows: any[] }]; // 本机新写入的对话、时间线、会话（网状层据此实时复制给其他身体） // 网状层状态变化（绑定进展、同步服务连接、各身体的连接与路径），控制台据此刷新
  "mesh.event": [e: { from: string; name: string; data: unknown }]; // 其他身体经网状层发来的事件 // 她碰过的变更已推送到远端（网状层据此通知其他身体立即拉取）
  "session.switch": [e: { from: string; to: string; title: string; done?: boolean }]; // 她用 session_new 把对话切到新会话：控制台跟着切；done 为真表示回复已放进新会话 // 让控制台 App 播放一段合成语音（走通话路径，耳朵有回声消除）；App 播完或被插嘴后回报 player.done
}
/**
 * 听觉事件（见 voice/hearing.ts）。partial：识别中的文字；final：这句话识别完成并进入会话（conv）；dropped：没进会话（太短、没听清、没在听……）；
 * kept：她判断是对她说的（回应了）；ignored：她判断不是对她说的（这句话在记录里标为 ignored，控制台隐藏）。
 */
export interface HearingEvent { id: string; status: "partial" | "final" | "dropped" | "kept" | "ignored"; text: string; conv?: string; reason?: string }
export interface TimelineEntry { id: number; ts: number; kind: string; title: string; detail: unknown; body?: string | null } // body：发生在哪具身体上
/** 会话进展事件（见 mind/activity.ts）。 */
export interface Activity {
  session: string; conv: string; origin: "chat" | "think" | "dream" | "agent"; channel: string; ts: number; // session：这一轮的标识；conv：所属会话（醒来为空；子 agent 为派出它的会话）
  kind: "start" | "queued" | "step" | "delta" | "text" | "tool" | "steer" | "alive" | "done" | "error";
  step?: number; text?: string; final?: boolean; // step：第几步；delta / text：流式片段 / 该步完整文字（final：是否为最终回复）
  call?: string; name?: string; summary?: string; status?: "running" | "ok" | "error" | "denied"; ms?: number; result?: string; // 工具
  reply?: string; message?: string; // done / error
  msg?: number; // start / steer：这句话在对话记录里的 id
  mode?: "steer" | "interrupt"; // steer：对方在她工作时发来的消息如何并入
  ambient?: boolean; // start / steer：这一轮由环境声音（麦克风听到的话）触发，不是对方发的消息
  body?: string; // 这一轮在哪具身体上进行（多具身体时，其他身体转来的进展也经同一个事件推给控制台）
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
export interface Approval { id: string; action: string; reason: string; args: unknown; status: "pending" | "approved" | "denied"; body?: string; kind?: "host" } // body：在哪具身体上请求的（多具身体时）；kind：host 为进入真实环境的请求（控制台据此放在对话顶部）

class Bus extends EventEmitter {
  emit<K extends keyof Events>(e: K, ...a: Events[K]) { return super.emit(e, ...a); }
  on<K extends keyof Events>(e: K, f: (...a: Events[K]) => void) { return super.on(e, f as any); }
}
export const bus = new Bus();
bus.setMaxListeners(50);
