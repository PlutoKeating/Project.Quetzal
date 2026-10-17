// 工作区在网状层上（#38 第二阶段、#37）：见 mind/workspace.ts。
//   - 复制：会话的工作区随会话在身体之间复制。连上时互相取一次全部（workspace.pull，按补齐的规则），平时本机一改就广播（workspace 事件，按实时的规则：
//     只收发来的那具身体自己写的）；合并规则见 mind/workspace.ts 的 mergeWorkspaces。
//   - body.workspace：这具身体的工作区概况（工作目录下的 git 仓库，mind/repos.ts）；带 dir 时核对这个目录在这里能不能用作工作区（workspace 工具设到别的身体上时用）。
//     连上时取回、每 5 分钟刷新，放进系统提示「其他身体」一节。
//   - agent.run / agent.status / agent.message / agent.stop：子 agent 在工作区所在的身体上执行。那边按自己的闸门（「会话」类别）派出、跑完整的工具循环，
//     进展经在场（mesh/presence.ts）转回来，报告以通道「子agent」的提醒送回派出它的会话（经那边的对话路由，会话正在别处进行就转过去）。
//   - 对话的路由（工作区在另一具在线的身体上，就把这一轮放过去）在 mesh/presence.ts 里，和「这个会话正在别处进行」的路由走同一条 chat.forward。
//   只读成员（灵魂桥）调用不到这里的任何方法。
import path from "node:path";
import type { Mesh, PeerStatus } from "./mesh.ts";
import { config } from "../config.ts";
import { workDir } from "../sandbox.ts";
import { check } from "../guard/guard.ts";
import { log } from "../log.ts";
import * as agents from "../mind/agents.ts";
import { localOverview, cleanOverview, type Overview } from "../mind/repos.ts";
import { allWorkspaces, mergeWorkspaces, onWorkspaceChange, setWorkspaceMesh, usableDir, bindAgent, agentWorkspaceText } from "../mind/workspace.ts";
import { clip } from "./mesh.ts";

const CHANNELS = new Set(["控制台", "飞书", "语音", "主动", "子agent"]);
const str = (v: unknown, n: number) => (typeof v === "string" && v.length <= n ? v : undefined);

/** 别处请这里派的子 agent：只取白名单里的字段，长度有上限。 */
function agentSpec(p: Record<string, unknown>) {
  const name = clip(str(p.name, 200) ?? "", 40), goal = str(p.goal, 50_000);
  if (!name || !goal) throw new Error("子 agent 要有名字和目标");
  const opt = (k: string) => str(p[k], 50_000);
  const steps = typeof p.maxSteps === "number" && Number.isFinite(p.maxSteps) && p.maxSteps > 0 ? Math.min(Math.floor(p.maxSteps), 10_000) : undefined;
  return { name, goal, persona: opt("persona"), scope: opt("scope"), background: opt("background"), context: opt("context"), maxSteps: steps };
}

export function installWorkspace(mesh: Mesh): () => void {
  const overviews = new Map<string, Overview>();
  const open = new Set<string>();

  mesh.handle("workspace.pull", () => allWorkspaces());
  mesh.handle("body.workspace", (p: { dir?: unknown }) => {
    if (p && typeof p === "object" && typeof p.dir === "string") {
      const dir = path.resolve(workDir(), p.dir.slice(0, 1000));
      return { dir, exists: !!usableDir(dir) };
    }
    return localOverview();
  });
  mesh.handle("agent.run", async (p: Record<string, unknown>, from: string) => {
    const spec = agentSpec(p ?? {});
    const parent = (p?.parent ?? {}) as Record<string, unknown>;
    const conv = str(parent.conv, 200);
    if (!conv) throw new Error("没有派出它的会话");
    const channel = str(parent.channel, 40) && CHANNELS.has(parent.channel as string) ? parent.channel as string : "控制台";
    const dir = typeof p.dir === "string" && p.dir ? usableDir(path.resolve(workDir(), p.dir.slice(0, 1000))) : undefined;
    if (typeof p.dir === "string" && p.dir && !dir) throw new Error(`${config.body} 上没有可以用作工作区的目录 ${clip(p.dir, 200)}`);
    if (!(await check("session", "agent_spawn", `来自 ${from}：派出子 agent「${spec.name}」`, { name: spec.name, goal: clip(spec.goal, 200), dir: dir ?? null }))) throw new Error("这个动作没有被允许（闸门拒绝或急停中）");
    const { spawnAgent } = await import("../mind/brain.ts");
    log("mesh", `${from} 上的她请这里派出子 agent「${spec.name}」`);
    const sub = spawnAgent({ ...spec, workspace: agentWorkspaceText(config.body, dir) }, { conv, channel });
    bindAgent(agents.liveSession(sub.id), dir);
    return { id: sub.id, name: sub.name, ...(dir ? { dir } : {}) };
  });
  const idOf = (p: { id?: unknown }) => { const id = str(p?.id, 40); if (!id) throw new Error("没有子 agent 的 id"); return id; };
  mesh.handle("agent.status", (p: { id?: unknown }) => agents.describe(idOf(p)));
  mesh.handle("agent.message", (p: { id?: unknown; text?: unknown }) => agents.message(idOf(p), str(p?.text, 50_000) ?? ""));
  mesh.handle("agent.stop", (p: { id?: unknown }) => agents.stop(idOf(p)));

  const pull = (body: string) => {
    mesh.request<unknown>(body, "workspace.pull", {}, 30_000).then((rows) => {
      const { changed, rejected } = mergeWorkspaces(rows, { from: body, catchUp: true });
      if (rejected) log("mesh", `丢弃了 ${body} 发来的 ${rejected} 条不合格的工作区`);
      if (changed.length) log("mesh", `从 ${body} 补齐了 ${changed.length} 个会话的工作区`);
    }, () => {});
  };
  const refresh = (body: string) => mesh.request<unknown>(body, "body.workspace", {}, 15_000).then((o) => { const c = cleanOverview(o); if (c) overviews.set(body, c); }, () => {});
  const onPeer = (s: PeerStatus) => {
    if (s.link === "open" && !open.has(s.body)) { open.add(s.body); pull(s.body); void refresh(s.body); }
    else if (s.link !== "open" && open.has(s.body)) { open.delete(s.body); overviews.delete(s.body); }
  };
  const onEvent = (e: { from: string; name: string; data: unknown }) => {
    if (e.name !== "workspace") return;
    const { rejected } = mergeWorkspaces(e.data, { from: e.from });
    if (rejected) log("mesh", `丢弃了 ${e.from} 发来的 ${rejected} 条不合格的工作区`);
  };
  const off = onWorkspaceChange((rows) => mesh.broadcast("workspace", rows));
  const timer = setInterval(() => { for (const b of mesh.connected()) void refresh(b); }, 5 * 60_000);
  timer.unref?.();
  mesh.on("peer", onPeer);
  mesh.on("event", onEvent);

  setWorkspaceMesh({
    online: (body) => mesh.connected().includes(body),
    overview: (body) => overviews.get(body),
    probe: async (body, dir) => {
      const r = await mesh.request<{ dir?: unknown; exists?: unknown }>(body, "body.workspace", { dir }, 15_000);
      return { dir: typeof r?.dir === "string" ? clip(r.dir, 1000) : dir, exists: r?.exists === true };
    },
    runAgent: async (body, p) => {
      const r = await mesh.request<{ id?: unknown; name?: unknown; dir?: unknown }>(body, "agent.run", p, 31 * 60_000); // 那边的闸门可能要等批准
      if (typeof r?.id !== "string" || !/^[0-9a-f]{1,40}$/.test(r.id)) throw new Error(`${body} 没有派出子 agent`);
      return { id: r.id, name: typeof r.name === "string" ? clip(r.name, 40) : "子 agent", ...(typeof r.dir === "string" ? { dir: clip(r.dir, 1000) } : {}) };
    },
    agent: async (body, op, p) => { const r = await mesh.request<unknown>(body, `agent.${op}`, p, 30_000); return typeof r === "string" ? r.slice(0, 20_000) : ""; },
  });
  return () => { clearInterval(timer); off(); mesh.off("peer", onPeer); mesh.off("event", onEvent); setWorkspaceMesh(undefined); };
}
