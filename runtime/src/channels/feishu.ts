// 飞书通道：长连接（WebSocket），无需公网地址。
//   打开与机器人的单聊 → 自动推送「此刻」卡片；机器人菜单 → 对应卡片；卡片按钮/表单 → 操作层（ops）并原地刷新卡片
//   普通文字 → 与 agent 对话（处理中加 OnIt 表情；调用工具时回复一张实时更新的「执行过程」卡片，每个工具一行）
//   agent 主动说话 → 私聊；审批 → 带按钮的卡片
// 接入：控制台一键扫码创建机器人（registerApp），自动获得凭据并绑定扫码的人，全程无需命令行。
import crypto from "node:crypto";
import * as lark from "@larksuiteoapi/node-sdk";
import { config, saveConfig, readSecret, writeSecret } from "../config.ts";
import { bus } from "../bus.ts";
import { log } from "../log.ts";
import { invoke } from "../ops.ts";
import { converse } from "../mind/brain.ts";
import { views, approvalCard, md, card } from "./feishu-cards.ts";
import type { Activity } from "../bus.ts";
import { identity } from "../memory/identity.ts";

let channel: lark.LarkChannel | undefined;
const state = { connected: false, error: "", registering: "" };
export const feishuStatus = () => ({ ...state, enabled: config.feishu.enabled, appId: config.feishu.appId, owner: !!config.feishu.ownerOpenId, bindCode: config.feishu.bindCode });

const isOwner = (openId?: string) => !!openId && openId === config.feishu.ownerOpenId;
const send = (to: string, input: lark.SendInput) => channel?.send(to, input).catch((e) => log("feishu", `发送失败：${e.message}`));
const toOwner = (input: lark.SendInput) => config.feishu.ownerOpenId && send(config.feishu.ownerOpenId, input); // ou_ 前缀按 open_id 发送

// 卡片回调去重（覆盖 SDK 内置处理器后需要自己去重）
const seen = new Map<string, number>();
const dedup = (k: string) => { const now = Date.now(); for (const [x, t] of seen) if (now - t > 60_000) seen.delete(x); if (seen.has(k)) return true; seen.set(k, now); return false; };

async function onCardAction(d: any) {
  const openId = d.operator?.open_id;
  if (!isOwner(openId)) return { toast: { type: "error", content: "只有绑定的人可以操作" } };
  if (d.token && dedup(d.token)) return {};
  const v = (d.action?.value ?? {}) as { op?: string; args?: any; view?: string; field?: string; numeric?: boolean; approval?: any };
  const formValue = (d.action?.form_value ?? {}) as Record<string, string>;
  let args = { ...(v.args ?? {}) };
  if (v.field) args[v.field === "content" ? "content" : v.field] = formValue[v.field];
  if (v.op === "poke") args.note = formValue.note ?? "";
  if (v.numeric) for (const [k, x] of Object.entries(formValue)) if (x !== "" && !isNaN(Number(x))) args[k] = Number(x);
  let toast = { type: "success", content: "好的" };
  if (v.op) {
    if (v.field && !args[v.field]) return { toast: { type: "warning", content: "请先填写内容" } };
    try {
      const r: any = await Promise.race([invoke(v.op, args, "飞书"), new Promise((res) => setTimeout(() => res("__slow__"), 2500))]);
      if (v.op === "testModel" && r !== "__slow__") toast = r.ok ? { type: "success", content: `连通 ✓ ${r.latencyMs}ms：${r.message}` } : { type: "error", content: r.message };
      else if (typeof r === "string" && r !== "__slow__") toast = { type: r.startsWith("错误") ? "error" : "success", content: r.slice(0, 80) };
      else if (r === "__slow__") toast = { type: "info", content: "处理中…" };
    } catch (e: any) { toast = { type: "error", content: e.message.slice(0, 80) }; }
  }
  const data = v.op === "decide" ? approvalCard({ ...v.approval, status: v.args.approve ? "approved" : "denied" }) : (views[v.view ?? "home"] ?? views.home)();
  return { toast, card: { type: "raw", data } };
}

const ICON = { running: "⏳", ok: "✅", error: "❌", denied: "🚫" } as const;
const code = (s: string) => "`" + s.replace(/`/g, "'") + "`";

/** 执行过程卡片：第一次调用工具时回复一张卡片，之后每秒最多更新一次；每个工具、每段中间叙述各占一行。 */
function progress(chatId: string, replyTo: string, session: string) {
  const lines = new Map<string, string>();
  let running = 0, tools = 0, messageId = "", dirty = false, timer: NodeJS.Timeout | undefined, done = false;
  let q: Promise<unknown> = Promise.resolve();
  const render = () => card(done ? `执行过程 · ${tools} 个工具` : "执行过程", done ? "grey" : "indigo",
    [md([...lines.values(), ...(!done && running ? ["🧰 *正在调用工具…*"] : [])].join("\n") || "…")]);
  const flush = () => {
    timer = undefined;
    if (!dirty || !channel) return q;
    dirty = false;
    q = q.then(async () => {
      if (!messageId) messageId = (await channel!.send(chatId, { card: render() }, { replyTo }))?.messageId ?? "";
      else await channel!.updateCard(messageId, render());
    }).catch((e) => log("feishu", `执行过程卡片更新失败：${e.message}`));
    return q;
  };
  const onActivity = (a: Activity) => {
    if (a.session !== session) return;
    if (a.kind === "tool") {
      if (a.status === "running") { running++; tools++; } else if (lines.has(a.call!)) running--; else tools++;
      const sec = a.ms != null && a.status !== "running" ? ` · ${(a.ms / 1000).toFixed(1)}s` : "";
      lines.set(a.call!, `${ICON[a.status!]} **${a.name}**${a.summary ? ` — ${code(a.summary)}` : ""}${sec}`);
    } else if (a.kind === "text" && !a.final && a.text?.trim()) lines.set(`text-${a.step}`, `💬 ${a.text.trim().replace(/\s+/g, " ").slice(0, 300)}`);
    else return;
    dirty = true;
    timer ??= setTimeout(flush, messageId ? 1000 : 0);
  };
  bus.on("activity", onActivity);
  return {
    async close() {
      bus.off("activity", onActivity);
      clearTimeout(timer);
      done = true;
      if (lines.size) { dirty = true; await flush(); }
    },
  };
}

export async function startFeishu() {
  await channel?.disconnect().catch(() => {});
  channel = undefined; state.connected = false;
  const secret = readSecret("feishu_secret");
  if (!config.feishu.enabled || !config.feishu.appId || !secret) return;
  try {
    const owner = config.feishu.ownerOpenId;
    channel = lark.createLarkChannel({
      appId: config.feishu.appId, appSecret: secret, transport: "websocket", includeRawEvent: true, source: "windler",
      loggerLevel: lark.LoggerLevel.warn, handshakeTimeoutMs: 20_000,
      policy: owner ? { dmMode: "allowlist", dmAllowlist: [owner] } : { dmMode: "open" },
    });
    channel.on("message", async (msg) => {
      if (msg.chatType !== "p2p") return;
      if (!config.feishu.ownerOpenId) { // 手动配置凭据时的绑定：发送控制台上显示的绑定码
        if (msg.content.trim() !== config.feishu.bindCode) { await send(msg.chatId, { text: "请发送控制台「飞书」页上显示的绑定码完成绑定。" }); return; }
        saveConfig({ feishu: { ownerOpenId: msg.senderId } });
        await send(msg.chatId, { card: views.welcome() });
        return void startFeishu(); // 以白名单模式重连
      }
      if (!isOwner(msg.senderId)) return;
      let reaction = "";
      try { reaction = await channel!.addReaction(msg.messageId, "OnIt"); } catch {}
      const sid = crypto.randomUUID();
      const prog = progress(msg.chatId, msg.messageId, sid);
      const reply = await converse("你", msg.content, "飞书", { turn: sid });
      await prog.close();
      if (reaction) channel!.removeReaction(msg.messageId, reaction).catch(() => {});
      await channel!.send(msg.chatId, { markdown: reply }, { replyTo: msg.messageId });
    });
    channel.on("error", (e: any) => { state.error = String(e?.message ?? e); log("feishu", `${e?.code ?? ""} ${state.error}`); });
    await channel.connect();
    // SDK 的 cardAction 事件无法返回值；在底层分发器上重新注册，以便立即返回提示并原地更新卡片（3 秒内）
    const dispatcher = (channel as any).dispatcher;
    dispatcher.register({
      "card.action.trigger": onCardAction,
      "application.bot.menu_v6": async (d: any) => {
        const openId = d.operator?.operator_id?.open_id;
        if (isOwner(openId)) await send(openId, { card: (views[d.event_key] ?? views.home)() });
      },
      "im.chat.access_event.bot_p2p_chat_entered_v1": async (d: any) => {
        if (isOwner(d.operator_id?.open_id)) await send(d.chat_id, { card: views.home() });
      },
    });
    state.connected = true; state.error = "";
    log("feishu", "已连接");
  } catch (e: any) {
    state.error = e.message; log("feishu", `连接失败：${e.message}`);
  }
}

export function wireFeishu() {
  bus.on("say", (text) => void toOwner({ markdown: text }));
  bus.on("notice", (text) => void toOwner({ markdown: `🔔 ${text}` }));
  bus.on("approval", (a) => { if (a.status === "pending") void toOwner({ card: approvalCard(a) }); });
}

/** 手动配置凭据。 */
export async function setFeishu(a: { appId?: string; appSecret?: string; enabled?: boolean; ownerOpenId?: string }) {
  if (a.appSecret) writeSecret("feishu_secret", a.appSecret);
  saveConfig({ feishu: { appId: a.appId ?? config.feishu.appId, enabled: a.enabled ?? config.feishu.enabled, ownerOpenId: a.ownerOpenId ?? config.feishu.ownerOpenId } });
  await startFeishu();
  if (state.connected && config.feishu.ownerOpenId) void toOwner({ card: views.welcome() });
  return feishuStatus();
}

/** 一键扫码创建飞书机器人：返回扫码链接；你在飞书里确认后，自动保存凭据并绑定你本人。 */
export function registerFeishu(onUrl: (url: string) => void): Promise<unknown> {
  state.registering = "waiting";
  return lark.registerApp({
    createOnly: true, source: "windler",
    appPreset: { name: identity().displayName, desc: `${identity().displayName} 的飞书通道` },
    addons: {
      scopes: { tenant: ["im:message", "im:message:send_as_bot", "im:message.p2p_msg:readonly", "im:message.reactions:write_only", "im:resource", "im:chat:readonly", "cardkit:card:write"] },
      events: { items: { tenant: ["im.message.receive_v1", "application.bot.menu_v6", "im.chat.access_event.bot_p2p_chat_entered_v1"] } },
      callbacks: { items: ["card.action.trigger"] }, // 不开启此回调时，长连接能收消息但收不到按钮点击
    },
    onQRCodeReady: (info) => { state.registering = info.url; onUrl(info.url); },
  }).then((r) => {
    state.registering = "";
    return setFeishu({ appId: r.client_id, appSecret: r.client_secret, enabled: true, ownerOpenId: r.user_info?.open_id ?? "" });
  }).catch((e) => { state.registering = ""; state.error = e.description ?? e.message; throw e; });
}

export { md };
