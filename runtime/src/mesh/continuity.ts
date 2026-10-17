// 协调层的续做（#11）：像磁盘阵列——底层是几具不同的身体，从这一层往上，所有身体维护同一份进行中的工作；只要还有一具在线，事情就接着做。
//   - work.take：谁来续做一件事（子 agent、进行中的一轮），由协调者决定（mind/continuity.ts 的 decideTake）：记录所在的身体还连着就不给别人；
//     给了就把记录改到请求的身体上并广播。跟随者经 setTakeRouter 转过来；协调者自己直接决定（「活着」= 它自己或连着它的身体）。
//   - 离线交接：每具身体记下别的身体从什么时候起连不上；协调者每 sweepMs 巡查一次，某具身体离线超过 graceMs（缺省 90 秒：一次网络抖动、
//     换 Wi-Fi 不至于让两边各做一份），它手上没做完的子 agent 与轮次就交给协调者自己接着做（对话在原会话里以「续做」的交接续上，
//     醒来按原来的起因接着做，子 agent 带着检查点接着跑）。那具身体回来时看到记录被接手（epoch 更大），立即停下它手上的那一份。
//   - agent.message / agent.stop：她对在别的身体上跑的子 agent 说话、停止它，转给那具身体。
import type { Mesh, PeerStatus } from "./mesh.ts";
import { config } from "../config.ts";
import { coordinator, isCoordinator } from "./coordinator.ts";
import * as agents from "../mind/agents.ts";
import { decideTake, setTakeRouter, pendingOf, continueWork, turns, timing, type TakeResult, type WorkKind } from "../mind/continuity.ts";
import { log } from "../log.ts";
import { clip } from "./mesh.ts";

const ID = /^[\w-]{1,80}$/;

export function installContinuity(mesh: Mesh): () => void {
  const absent = new Map<string, number>(); // 身体 → 从什么时候起连不上（这具身体看到的）
  const installed = Date.now();
  const alive = (b: string) => b === config.body || mesh.connected().includes(b);

  mesh.handle("work.take", (p: { kind?: unknown; id?: unknown; record?: unknown }, from: string): TakeResult => {
    const kind = p?.kind === "agent" || p?.kind === "turn" ? p.kind : undefined;
    if (!kind || typeof p.id !== "string" || !ID.test(p.id)) throw new Error("参数不对");
    const r = decideTake(kind, p.id, from, alive, p.record);
    log("mesh", `${from} 请求续做 ${kind} ${clip(p.id, 20)}：${r.ok ? "给了" : "没给"}`);
    return r;
  });
  mesh.handle("agent.message", (p: { id?: unknown; text?: unknown }) => {
    if (typeof p?.id !== "string" || !agents.runningHere(p.id)) return `那个子 agent 不在 ${config.body} 上跑`;
    return agents.message(p.id, typeof p.text === "string" ? p.text.slice(0, 20_000) : "");
  });
  mesh.handle("agent.stop", (p: { id?: unknown }) => {
    if (typeof p?.id !== "string" || !agents.runningHere(p.id)) return `那个子 agent 不在 ${config.body} 上跑`;
    return agents.stop(p.id);
  });

  setTakeRouter((kind, id, record) => {
    if (isCoordinator()) return Promise.resolve(decideTake(kind, id, config.body, alive)); // 协调者自己决定：连着它的身体都算活着
    if (!mesh.connected().includes(coordinator())) return undefined; // 连不上协调者：本机决定
    return mesh.request<TakeResult>(coordinator(), "work.take", { kind, id, record }, 15_000);
  });
  agents.setAgentRemote((op, a, text) => (mesh.connected().includes(a.body) ? mesh.request<string>(a.body, op === "message" ? "agent.message" : "agent.stop", { id: a.id, text }, 15_000) : undefined));

  const onPeer = (s: PeerStatus) => { if (s.link === "open") absent.delete(s.body); else if (!absent.has(s.body)) absent.set(s.body, Date.now()); };

  /** 协调者巡查：离线够久的身体手上没做完的事，交给这具身体接着做。 */
  let sweeping = false;
  const sweep = async () => {
    if (sweeping || !isCoordinator()) return;
    sweeping = true;
    try {
      const now = Date.now();
      const owners = new Set([...agents.list().filter((a) => a.status === "running").map((a) => a.body), ...turns().filter((t) => t.status === "running").map((t) => t.body)]);
      for (const b of owners) {
        if (alive(b)) continue;
        const since = absent.get(b) ?? installed; // 这具身体启动以来一直没见过它
        if (now - since < timing.graceMs) continue;
        const work = pendingOf(b);
        const why = `之前在 ${b} 上做，那具身体离线了，由 ${config.body} 接着做`;
        for (const a of work.agents) await continueWork("agent", a.id, why).catch((e) => log("mesh", `接手子 agent ${a.name} 失败：${e.message}`));
        for (const t of work.turns) await continueWork("turn", t.id, why).catch((e) => log("mesh", `接手一轮失败：${e.message}`));
      }
    } finally { sweeping = false; }
  };
  const timer = setInterval(() => { void sweep(); }, timing.sweepMs);
  timer.unref?.();
  mesh.on("peer", onPeer);
  return () => { clearInterval(timer); mesh.off("peer", onPeer); setTakeRouter(undefined); agents.setAgentRemote(undefined); };
}

export type { WorkKind };
