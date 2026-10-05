// 复制：同一个 agent 的所有身体共用一份对话、会话与时间线（一个心智）。
//   - 连上一具身体时互相补齐：按版本向量（每个编号段里见过的最大 id）只取自己没有的，分页续传；会话列表整体合并（标题与归档以较新的修改为准）。
//   - 平时本机每写一条（store 发出的 replica 事件），实时广播给连着的身体。
//   - 收到的行幂等写入（applyRemote），不再转发；新的时间线条目照常推给本机的控制台。
// 新身体入网时就这样从其他身体补齐全部历史；对话不进 git（DISTRIBUTED.md C5）。
import type { Mesh, PeerStatus } from "./mesh.ts";
import { bus } from "../bus.ts";
import { idVector, rowsAfter, allSessions, applyRemote, type ReplicaTable } from "../store.ts";
import { log } from "../log.ts";

const PAGE_BYTES = 4 << 20;
const TABLES = ["messages", "timeline"] as const;

/** 取对方缺的行，按字节数截断（单条消息不会超过 32 MB 的传输上限）。 */
function page(table: "messages" | "timeline", vector: Record<string, number>) {
  const rows = rowsAfter(table, vector, 500);
  const out: any[] = [];
  let bytes = 0;
  for (const r of rows) {
    const n = JSON.stringify(r).length;
    if (out.length && bytes + n > PAGE_BYTES) break;
    out.push(r); bytes += n;
  }
  return out;
}

function apply(table: ReplicaTable, rows: any[], from: string) {
  if (!Array.isArray(rows) || !rows.length) return 0;
  const changed = applyRemote(table, rows);
  if (!changed.length) return 0;
  if (table === "timeline") for (const r of changed) { let detail: unknown = null; try { detail = JSON.parse(r.detail); } catch {} bus.emit("timeline", { id: r.id, ts: r.ts, kind: r.kind, title: r.title, detail, body: r.body }); }
  bus.emit("replica.applied", { table, rows: changed, from });
  return changed.length;
}

/** 从一具刚连上的身体补齐。 */
async function catchUp(mesh: Mesh, peer: string) {
  let total = 0;
  try {
    for (const table of TABLES) {
      for (let i = 0; i < 10_000; i++) {
        const rows = await mesh.request<any[]>(peer, "replica.pull", { table, vector: idVector(table) }, 60_000);
        if (!rows?.length) break;
        const n = apply(table, rows, peer);
        total += n;
        if (!n) break; // 对方给的都已经有了（不应该发生）：避免死循环
      }
    }
    total += apply("sessions", await mesh.request<any[]>(peer, "replica.sessions", {}, 30_000), peer);
    if (total) log("mesh", `从 ${peer} 补齐了 ${total} 条对话、时间线与会话`);
  } catch (e) { log("mesh", `从 ${peer} 补齐失败：${(e as Error).message}`); }
}

/** 给一个 Mesh 装上复制。返回卸载函数。 */
export function installReplica(mesh: Mesh): () => void {
  mesh.handle("replica.pull", (p: { table: string; vector: Record<string, number> }) => {
    if (!TABLES.includes(p?.table as any)) throw new Error("不支持的表");
    return page(p.table as "messages" | "timeline", p.vector && typeof p.vector === "object" ? p.vector : {});
  });
  mesh.handle("replica.sessions", () => allSessions());

  const open = new Set<string>();
  const onPeer = (s: PeerStatus) => {
    if (s.link === "open" && !open.has(s.body)) { open.add(s.body); void catchUp(mesh, s.body); }
    else if (s.link !== "open") open.delete(s.body);
  };
  const onLocal = (e: { table: ReplicaTable; rows: any[] }) => mesh.broadcast("replica", e);
  const onEvent = (e: { from: string; name: string; data: any }) => {
    if (e.name === "replica" && e.data && typeof e.data.table === "string") apply(e.data.table, e.data.rows, e.from);
  };
  mesh.on("peer", onPeer);
  mesh.on("event", onEvent);
  bus.on("replica", onLocal);
  return () => { mesh.off("peer", onPeer); mesh.off("event", onEvent); bus.off("replica", onLocal as any); };
}
