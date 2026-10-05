// 在场：同一个 agent 的各具身体知道「她此刻在哪具身体上、和谁在哪个会话里说话」。
//   - 每一轮的进展（activity 事件）转发给其他身体：任何一端的控制台都能实时看到别处正在进行的一轮（带 body）。
//   - 发给一个正在另一具身体上进行的会话的消息，转给那具身体（插话 / 打断 / 排队照常），附件随之传过去。
//   - 新的一轮由收到消息的身体接（DISTRIBUTED.md C6）；她可以用 move_to 换到别的身体上继续。
import fs from "node:fs";
import type { Mesh, PeerStatus } from "./mesh.ts";
import { bus, type Activity } from "../bus.ts";
import { config } from "../config.ts";
import { foldRemote, adoptLive, dropBody, localTurns, liveTurns, type LiveTurn } from "../mind/activity.ts";
import { setConverseRouter, converse, type ConverseOptions } from "../mind/brain.ts";
import { saveUpload, resolveUpload, MAX_FILE_BYTES } from "../mind/attachments.ts";
import type { Attachment } from "../store.ts";
import { log } from "../log.ts";

const FORWARD_FILES_BYTES = 24 << 20; // 随转发的消息一起传过去的附件总量上限

/** 这个会话此刻在哪具别的身体上进行（没有则 undefined）。 */
export function ownerOf(conv: string): string | undefined {
  return liveTurns().find((t) => t.conv === conv && t.origin === "chat" && t.body && t.body !== config.body)?.body;
}

interface Forward { from: string; text: string; channel: string; o: ConverseOptions; files: { name: string; data: string }[] }

export function installPresence(mesh: Mesh): () => void {
  const open = new Set<string>();
  const onActivity = (a: Activity) => { if (!a.body || a.body === config.body) mesh.broadcast("activity", a); };
  const onEvent = (e: { from: string; name: string; data: any }) => {
    if (e.name === "activity" && e.data && typeof e.data.session === "string") foldRemote({ ...e.data, body: e.from });
  };
  const onPeer = (s: PeerStatus) => {
    if (s.link === "open" && !open.has(s.body)) {
      open.add(s.body);
      mesh.request<LiveTurn[]>(s.body, "presence.live", {}, 15_000).then((t) => adoptLive(Array.isArray(t) ? t : [], s.body), () => {});
    } else if (s.link !== "open" && open.has(s.body)) { open.delete(s.body); dropBody(s.body); }
  };
  mesh.handle("presence.live", () => localTurns(config.body));
  mesh.handle("chat.forward", async (p: Forward, from: string) => {
    const attachments: Attachment[] = [];
    for (const f of (p.files ?? []).slice(0, 20)) {
      const data = Buffer.from(String(f.data ?? ""), "base64");
      if (data.length && data.length <= MAX_FILE_BYTES) attachments.push(saveUpload(String(f.name ?? "file"), data));
    }
    log("mesh", `${from} 转来一句话（会话 ${p.o?.conv}）`);
    return converse(String(p.from ?? "你"), String(p.text ?? ""), String(p.channel ?? "控制台"), { ...(p.o ?? {}), attachments: attachments.length ? attachments : undefined });
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
