// 协调者：每个连通的部分里选出一具身体持有「心」——只有它的心脏抽样醒来（DISTRIBUTED.md C1、C2）。
//   - 选法确定：各身体广播自己的条件（优先级、是否接着电源、进程启动时刻），每具身体在自己连得上的范围里按同一顺序选出第一名；
//     优先级大的优先，其次接着电源的，其次启动早的（更稳定），最后按名字。断网时每个分区各自选出一个，各自活着。
//   - 其他身体跟随：心脏的操作（感觉、对话带来的驱动力变化、经历、性格调整）转给协调者；协调者把心脏状态广播回来。
//   - 两个分区重新连上：落选的那位以「合并」的方式采用新协调者的状态（睡眠压力与待整理的经历取较大值）。
import type { Mesh, PeerStatus } from "./mesh.ts";
import { bus } from "../bus.ts";
import { config } from "../config.ts";
import { body } from "../body/twin.ts";
import { setFollower, applyHeartOp, heartState, adoptHeart } from "../heart/heart.ts";
import { addTimeline } from "../store.ts";
import { log } from "../log.ts";

export interface Candidacy { priority: number; powered: boolean; started: number }

const STARTED = Date.now();
const ANNOUNCE_MS = 30_000;
const STATE_MIN_INTERVAL_MS = 2000;

export const myCandidacy = (): Candidacy => ({
  priority: Number(config.mesh.priority) || 0,
  powered: !body.raw.battery || !!body.raw.battery.charging, // 没有电池（台式机、服务器）也算接着电源
  started: STARTED,
});

/** 选出协调者：优先级大 → 接着电源 → 启动早 → 名字小。 */
export function pickLeader(members: [string, Candidacy][]): string {
  return [...members].sort(([a, x], [b, y]) => (y.priority - x.priority) || (Number(y.powered) - Number(x.powered)) || (x.started - y.started) || (a < b ? -1 : a > b ? 1 : 0))[0][0];
}

let current = config.body;
/** 此刻的协调者（没有连上任何身体时就是自己）。 */
export const coordinator = () => current;
export const isCoordinator = () => current === config.body;

export function installCoordinator(mesh: Mesh): () => void {
  const known = new Map<string, Candidacy>();
  const open = new Set<string>();
  let wasLeader = true, mergeNext = false, lastSent = 0, pending: NodeJS.Timeout | undefined;

  const recompute = () => {
    const members: [string, Candidacy][] = [[config.body, myCandidacy()], ...[...known].filter(([b]) => open.has(b))];
    const next = pickLeader(members);
    if (next === current && (next === config.body) === wasLeader) return;
    const prev = current;
    current = next;
    const leading = next === config.body;
    if (leading) {
      setFollower(false);
      if (!wasLeader) { log("mesh", `由这具身体接过心跳（之前是 ${prev}）`); addTimeline("mesh", `心跳交到了这具身体上（之前在 ${prev}）`, { from: prev }); }
      sendState(true);
    } else {
      mergeNext = wasLeader && members.length > 1; // 两个分区重新连上：第一次采用时合并
      setFollower(true, (op, args) => { if (!mesh.emitTo(current, "heart.op", { op, args })) log("mesh", `心脏操作没能转给 ${current}`); });
      log("mesh", `心跳在 ${next} 上，这具身体跟随`);
    }
    wasLeader = leading;
    bus.emit("state"); // 状态里的 mesh.coordinator 变了
  };

  /** 协调者把心脏状态发给其他身体（限流：最快 2 秒一次）。 */
  const sendState = (now = false) => {
    if (!isCoordinator()) return;
    clearTimeout(pending);
    const wait = now ? 0 : Math.max(0, lastSent + STATE_MIN_INTERVAL_MS - Date.now());
    pending = setTimeout(() => { lastSent = Date.now(); mesh.broadcast("heart.state", heartState()); }, wait);
    pending.unref?.();
  };

  const announce = () => mesh.broadcast("candidacy", myCandidacy());
  const timer = setInterval(() => { announce(); recompute(); }, ANNOUNCE_MS);
  timer.unref?.();

  const onPeer = (s: PeerStatus) => {
    if (s.link === "open" && !open.has(s.body)) {
      open.add(s.body);
      mesh.emitTo(s.body, "candidacy", myCandidacy());
      if (isCoordinator()) mesh.emitTo(s.body, "heart.state", heartState());
    } else if (s.link !== "open" && open.has(s.body)) { open.delete(s.body); known.delete(s.body); recompute(); }
  };
  const onEvent = (e: { from: string; name: string; data: any }) => {
    if (e.name === "candidacy" && e.data) {
      known.set(e.from, { priority: Number(e.data.priority) || 0, powered: !!e.data.powered, started: Number(e.data.started) || Date.now() });
      recompute();
    } else if (e.name === "heart.state" && e.from === current && !isCoordinator()) {
      adoptHeart(e.data, mergeNext); mergeNext = false;
    } else if (e.name === "heart.op" && isCoordinator() && e.data && typeof e.data.op === "string") {
      applyHeartOp(e.data.op, Array.isArray(e.data.args) ? e.data.args : []);
    }
  };
  const onHeart = () => sendState();

  mesh.on("peer", onPeer);
  mesh.on("event", onEvent);
  bus.on("heart", onHeart);
  recompute();
  return () => {
    clearInterval(timer); clearTimeout(pending);
    mesh.off("peer", onPeer); mesh.off("event", onEvent); bus.off("heart", onHeart as any);
    current = config.body; wasLeader = true; setFollower(false);
  };
}
