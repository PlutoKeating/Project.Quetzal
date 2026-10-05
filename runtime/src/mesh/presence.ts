// 在场：同一个 agent 的各具身体知道「她此刻在哪具身体上、和谁在哪个会话里说话」。
//   - 每一轮的进展（activity 事件）转发给其他身体：任何一端的控制台都能实时看到别处正在进行的一轮（带 body）。
//   - 发给一个正在另一具身体上进行的会话的消息，转给那具身体（插话 / 打断 / 排队照常），附件随之传过去。
//   - 新的一轮由收到消息的身体接（DISTRIBUTED.md C6）；她可以用 move_to 换到别的身体上继续。
//   - 转来的话只取白名单里的字段（会话、并入方式、通道），并且就在接收的身体上处理（local），不会再转出去（不会来回转）。
import fs from "node:fs";
import type { Mesh, PeerStatus } from "./mesh.ts";
import { bus, type Activity } from "../bus.ts";
import { config } from "../config.ts";
import { foldRemote, adoptLive, dropBody, localTurns, liveTurns, type LiveTurn } from "../mind/activity.ts";
import { setConverseRouter, converse, type ConverseOptions } from "../mind/brain.ts";
import { saveUpload, resolveUpload, MAX_FILE_BYTES } from "../mind/attachments.ts";
import { listSessions, sessionMessages, type Attachment } from "../store.ts";
import { log } from "../log.ts";
import { clip } from "./mesh.ts";

const FORWARD_FILES_BYTES = 24 << 20; // 随转发的消息一起传过去的附件总量上限

/** 这个会话此刻在哪具别的身体上进行（没有则 undefined）。 */
export function ownerOf(conv: string): string | undefined {
  return liveTurns().find((t) => t.conv === conv && t.origin === "chat" && t.body && t.body !== config.body)?.body;
}

/**
 * 给只读成员（灵魂桥）看的近况：此刻在进行的轮次（各身体）、最近的会话与最近一个会话的最后几句。只取摘要，不给全部历史。
 * 这些文字会进另一个 agent 框架的上下文：一律单行、去掉控制字符、截断；每段文字都标明是谁说的（role、channel），灵魂桥据此标注。
 */
export function digest() {
  const sessions = listSessions({ limit: 8 }).map((s) => {
    const last = sessionMessages(s.id, 1)[0];
    return { id: clip(s.id, 80), title: clip(s.title, 60), channel: clip(s.channel, 20), updated: s.updated, last: clip(s.last ?? "", 80), lastRole: last?.role ?? null, lastBody: last?.body ? clip(last.body, 40) : null };
  });
  const latest = sessions[0];
  return {
    body: config.body, at: Date.now(),
    live: liveTurns().slice(0, 20).map((t) => ({ body: clip(t.body ?? config.body, 40), conv: clip(t.conv, 80), origin: clip(t.origin, 20), channel: clip(t.channel, 20), started: t.started, status: clip(t.status, 20), text: clip(t.text ?? "", 200) })),
    sessions,
    recent: latest ? sessionMessages(latest.id, 10).map((m) => ({ ts: m.ts, role: m.role, channel: clip(m.channel, 20), body: m.body ? clip(m.body, 40) : null, text: clip(m.text ?? "", 500) })) : [],
  };
}

interface Forward { from: string; text: string; channel: string; o: { conv?: string; mode?: string; ambient?: boolean }; files: { name: string; data: string }[] }
const FORWARD_CHANNELS = new Set(["控制台", "飞书", "语音"]); // 转来的话可以带的通道
const MODES = new Set(["steer", "queue", "interrupt"]);

/** 别处转来的一轮的选项：只取会话、并入方式（白名单）；就在这里处理，不再转出。环境声音只认听觉通道的。 */
export function forwardOptions(o: unknown, channel: string): ConverseOptions {
  const x = (o && typeof o === "object" ? o : {}) as Record<string, unknown>;
  return {
    local: true,
    ...(typeof x.conv === "string" && x.conv && x.conv.length <= 200 ? { conv: x.conv } : {}),
    ...(typeof x.mode === "string" && MODES.has(x.mode) ? { mode: x.mode as ConverseOptions["mode"] } : {}),
    ...(x.ambient === true && channel === "语音" ? { ambient: true } : {}),
  };
}

export function installPresence(mesh: Mesh): () => void {
  const open = new Set<string>();
  const onActivity = (a: Activity) => { if (!a.body || a.body === config.body) mesh.broadcast("activity", a); };
  const onEvent = (e: { from: string; name: string; data: any }) => {
    if (e.name === "activity" && e.data && typeof e.data.session === "string" && e.data.session.length <= 200 && typeof e.data.kind === "string" && typeof e.data.conv === "string") foldRemote({ ...e.data, body: e.from });
  };
  const onPeer = (s: PeerStatus) => {
    if (s.link === "open" && !open.has(s.body)) {
      open.add(s.body);
      mesh.request<LiveTurn[]>(s.body, "presence.live", {}, 15_000).then((t) => adoptLive(Array.isArray(t) ? t.slice(0, 100).filter((x) => x && typeof x === "object" && typeof x.conv === "string") : [], s.body), () => {});
    } else if (s.link !== "open" && open.has(s.body)) { open.delete(s.body); dropBody(s.body); }
  };
  mesh.handle("presence.live", () => localTurns(config.body));
  mesh.handle("presence.digest", () => digest(), true); // 只读成员（灵魂桥）唯一能调用的方法
  mesh.handle("chat.forward", async (p: Forward, from: string) => {
    const attachments: Attachment[] = [];
    let bytes = 0;
    for (const f of (Array.isArray(p?.files) ? p.files : []).slice(0, 20)) {
      const data = Buffer.from(typeof f?.data === "string" ? f.data : "", "base64");
      if (!data.length || data.length > MAX_FILE_BYTES || bytes + data.length > FORWARD_FILES_BYTES) continue;
      bytes += data.length;
      attachments.push(saveUpload(clip(f.name, 200) || "file", data));
    }
    const channel = typeof p?.channel === "string" && FORWARD_CHANNELS.has(p.channel) ? p.channel : "控制台";
    const o = forwardOptions(p?.o, channel);
    log("mesh", `${from} 转来一句话（会话 ${clip(o.conv ?? "", 40)}）`);
    return converse(clip(p?.from, 40) || "你", typeof p?.text === "string" ? p.text.slice(0, 100_000) : "", channel, { ...o, attachments: attachments.length ? attachments : undefined });
  });

  setConverseRouter((conv, from, text, channel, o) => {
    const owner = ownerOf(conv);
    if (!owner || !mesh.connected().includes(owner)) return undefined;
    const files: Forward["files"] = [];
    let bytes = 0;
    for (const a of o.attachments ?? []) {
      const file = resolveUpload(a.rel);
      if (!file) continue;
      const size = fs.statSync(file).size;
      if (bytes + size > FORWARD_FILES_BYTES) break;
      bytes += size;
      files.push({ name: a.name, data: fs.readFileSync(file).toString("base64") });
    }
    const { attachments: _drop, ...rest } = o;
    return mesh.request<string>(owner, "chat.forward", { from, text, channel, o: rest, files } satisfies Forward, 30 * 60_000)
      .catch((e: Error) => `（这句话没能转到 ${owner}：${e.message}。请再说一次。）`);
  });

  bus.on("activity", onActivity);
  mesh.on("event", onEvent);
  mesh.on("peer", onPeer);
  return () => {
    setConverseRouter(undefined);
    bus.off("activity", onActivity as any); mesh.off("event", onEvent); mesh.off("peer", onPeer);
    for (const b of open) dropBody(b);
  };
}
