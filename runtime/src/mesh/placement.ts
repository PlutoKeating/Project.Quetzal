// 运行位置（DISTRIBUTED.md C3）：协调者醒来时，向各具在线的身体要一份概况，按规则打分给出推荐；
// 她在内省时看到概况与推荐，自己选在哪一具或哪几具身体上做（几具会同时进行，都是她）。选中的身体执行这次醒来（跳过内省）。
import type { Mesh } from "./mesh.ts";
import { config } from "../config.ts";
import { body as physical } from "../body/twin.ts";
import { adapter } from "../body/twin.ts";
import { listCustomTools } from "../mind/custom-tools.ts";
import { liveTurns } from "../mind/activity.ts";
import { setPlacement, wake, type WakeResult } from "../mind/brain.ts";
import { db } from "../store.ts";
import { bodyUuid } from "../body/uuid.ts";
import { remoteBodies } from "../mind/bodies.ts";
import type { WakeKind } from "../heart/heart.ts";

export interface Overview {
  body: string; describe: string; battery?: number; charging?: boolean; tempC?: number; online: boolean;
  busy: number; tools: string[]; lastUserAt: number; version: string;
}

/** 这具身体的概况（给协调者打分，也写进她的内省）。 */
export function overview(version: string): Overview {
  const b = physical.raw.battery;
  const lastUser = db.prepare("SELECT MAX(ts) t FROM messages WHERE role='user' AND body=?").get(config.body) as { t: number | null };
  return {
    body: config.body, describe: adapter.describe ?? "", battery: b?.level, charging: b ? b.charging : undefined, tempC: b?.tempC, online: physical.online,
    busy: liveTurns().filter((t) => !t.body || t.body === config.body).length,
    tools: [...(adapter.tools ?? []).map((t) => t.name), ...listCustomTools().filter((t) => t.enabled && !t.missing.length).map((t) => t.name)],
    lastUserAt: Number(lastUser?.t ?? 0), version,
  };
}

/**
 * 打分：接着电源（或没有电池）+2，电量高 +1、电量低 −2，发烫 −2，没联网 −3，手头有正在进行的一轮 −1，
 * 对方最近 30 分钟在这具身体上说过话 +1（想念、想表达时 +2），协调者自己 +0.5（少一跳）。做梦更看重电源与温度。
 */
export function score(o: Overview, kind: WakeKind, social: boolean, me: string): number {
  let s = 0;
  if (o.charging || o.battery === undefined) s += 2;
  if (o.battery !== undefined) s += o.battery >= 50 ? 1 : o.battery < 20 ? -2 : 0;
  if ((o.tempC ?? 0) >= 42) s -= kind === "dream" ? 3 : 2;
  if (!o.online) s -= 3;
  if (o.busy) s -= 1;
  if (Date.now() - o.lastUserAt < 30 * 60_000) s += social ? 2 : 1;
  if (o.body === me) s += 0.5;
  return s;
}

/** 概况里每具身体标上 uuid（她在 where 里填 uuid）：这具身体用自己的，别的身体用灵魂仓库登记的。 */
const uuidOf = (body: string) => (body === config.body ? bodyUuid() : remoteBodies().find((b) => b.body === body)?.uuid);
const line = (o: Overview) => `- ${o.body}（body: ${uuidOf(o.body) ?? "还没有登记 uuid"}）：${o.describe || "（没有描述）"}；${o.battery !== undefined ? `电量 ${o.battery}%${o.charging ? "（充电中）" : ""}` : "接着电源"}${o.tempC !== undefined ? `，${o.tempC}°C` : ""}${o.online ? "" : "，没联网"}${o.busy ? `，手头有 ${o.busy} 轮正在进行` : ""}${o.lastUserAt ? `，对方上次在这里说话：${new Date(o.lastUserAt).toLocaleString("zh-CN", { timeZone: config.timezone })}` : ""}${o.tools.length ? `；独有的工具：${o.tools.slice(0, 12).join("、")}` : ""}`;

export function installPlacement(mesh: Mesh, version: string, socialNow: () => boolean): () => void {
  mesh.handle("body.overview", () => overview(version));
  mesh.handle("mind.wake", async (p: { kind: WakeKind; reason: string; intent: string }) => {
    if (p?.kind !== "think" && p?.kind !== "dream") throw new Error("不认识的醒来方式");
    return wake(p.kind, String(p.reason ?? ""), { intent: String(p.intent ?? "") });
  });
  setPlacement({
    async survey(kind) {
      const peers = mesh.connected();
      if (!peers.length) return undefined;
      const all = [overview(version), ...(await Promise.all(peers.map((b) => mesh.request<Overview>(b, "body.overview", {}, 5000).catch(() => undefined)))).filter(Boolean) as Overview[]];
      const ranked = all.map((o) => ({ o, s: score(o, kind, socialNow(), config.body) })).sort((a, b) => b.s - a.s);
      const top = ranked[0].o.body;
      return { text: ranked.map((r) => line(r.o)).join("\n"), bodies: all.map((o) => o.body), recommend: [top], recommendText: `${top}（body: ${uuidOf(top) ?? "还没有登记 uuid"}）` };
    },
    run: (b, kind, reason, intent) => mesh.request<WakeResult>(b, "mind.wake", { kind, reason, intent }, 6 * 3_600_000),
  });
  return () => setPlacement(undefined);
}
