// 复制：同一个 agent 的所有身体共用一份对话、会话与时间线（一个心智）。
//   - 连上一具身体时互相补齐：按版本向量（每个编号段里见过的最大 id）只取自己没有的，分页续传；会话列表整体合并（标题与归档以较新的修改为准）。
//   - 平时本机每写一条（store 发出的 replica 事件），实时广播给连着的身体。
//   - 收到的行幂等写入（applyRemote），不再转发；新的时间线条目照常推给本机的控制台。
//   - 收到的行先检查（store.ts 的 applyRemote）：字段类型与长度、时间、编号段与作者；实时收到的只能是发来的身体自己写的。
//     补齐时不合格的行跳过（版本向量里记下已经看过的位置，不再要）；补齐有总量上限（每次连上每具身体 20 万行 / 512 MB），超了就停下记一笔。
// 新身体入网时就这样从其他身体补齐全部历史；对话不进 git（DISTRIBUTED.md C5）。
import type { Mesh, PeerStatus } from "./mesh.ts";
import { bus } from "../bus.ts";
import { idVector, rowsAfter, allSessions, applyRemote, ID_RANGE, type ReplicaTable } from "../store.ts";
import { log } from "../log.ts";

const PAGE_BYTES = 4 << 20;
const TABLES = ["messages", "timeline"] as const;
const REALTIME = new Set<string>(["messages", "timeline", "sessions", "message.mode"]);
const CATCHUP_ROWS = 200_000, CATCHUP_BYTES = 512 << 20; // 一次补齐的上限（每具身体每次连上）

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

/** 对方发来的版本向量：只留编号段号 → 有限的整数。 */
function cleanVector(v: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!v || typeof v !== "object" || Array.isArray(v)) return out;
  for (const [k, n] of Object.entries(v).slice(0, 10_000)) if (/^\d{1,7}$/.test(k) && Number.isSafeInteger(n)) out[k] = n as number;
  return out;
}

function apply(table: ReplicaTable, rows: unknown, from: string, catchUp = false) {
  if (!Array.isArray(rows) || !rows.length) return 0;
  const { changed, rejected } = applyRemote(table, rows, { from, catchUp });
  if (rejected) log("mesh", `丢弃了 ${from} 发来的 ${rejected} 行不合格的${table}`);
  if (!changed.length) return 0;
  if (table === "timeline") for (const r of changed) { let detail: unknown = null; try { detail = JSON.parse(r.detail); } catch {} bus.emit("timeline", { id: r.id, ts: r.ts, kind: r.kind, title: r.title, detail, body: r.body }); }
  bus.emit("replica.applied", { table, rows: changed, from });
  return changed.length;
}

/** 从一具刚连上的身体补齐。 */
async function catchUp(mesh: Mesh, peer: string) {
  let total = 0, rows = 0, bytes = 0;
  try {
    for (const table of TABLES) {
      const seen: Record<string, number> = {}; // 这次补齐已经看过（包括丢弃了）的位置
      for (let i = 0; i < 10_000; i++) {
        if (rows >= CATCHUP_ROWS || bytes >= CATCHUP_BYTES) { log("mesh", `从 ${peer} 补齐的量到了上限（${rows} 行、${Math.round(bytes / 1048576)} MB），这次先停下，下次连上再继续`); break; }
        const vector = idVector(table);
        for (const [k, v] of Object.entries(seen)) vector[k] = Math.max(vector[k] ?? 0, v);
        const got = await mesh.request<unknown>(peer, "replica.pull", { table, vector }, 60_000);
        if (!Array.isArray(got) || !got.length) break;
        rows += got.length; bytes += JSON.stringify(got).length;
        total += apply(table, got, peer, true);
        let advanced = false;
        for (const r of got) {
          const id = (r as { id?: unknown })?.id;
          if (!Number.isSafeInteger(id)) continue;
          const k = String(Math.floor((id as number) / ID_RANGE));
          if ((id as number) > (vector[k] ?? 0)) { advanced = true; seen[k] = Math.max(seen[k] ?? 0, id as number); }
        }
        if (!advanced) break; // 对方给的都不在我要的范围里：避免死循环
      }
    }
    total += apply("sessions", await mesh.request<unknown>(peer, "replica.sessions", {}, 30_000), peer, true);
    if (total) log("mesh", `从 ${peer} 补齐了 ${total} 条对话、时间线与会话`);
  } catch (e) { log("mesh", `从 ${peer} 补齐失败：${(e as Error).message}`); }
}

/** 给一个 Mesh 装上复制。返回卸载函数。 */
export function installReplica(mesh: Mesh): () => void {
  mesh.handle("replica.pull", (p: { table: string; vector: unknown }) => {
    if (!TABLES.includes(p?.table as any)) throw new Error("不支持的表");
    return page(p.table as "messages" | "timeline", cleanVector(p.vector));
  });
  mesh.handle("replica.sessions", () => allSessions());

  const open = new Set<string>();
  const onPeer = (s: PeerStatus) => {
    if (s.link === "open" && !open.has(s.body)) { open.add(s.body); void catchUp(mesh, s.body); }
    else if (s.link !== "open") open.delete(s.body);
  };
  const onLocal = (e: { table: ReplicaTable; rows: any[] }) => mesh.broadcast("replica", e);
  const onEvent = (e: { from: string; name: string; data: any }) => {
    if (e.name === "replica" && e.data && REALTIME.has(e.data.table)) apply(e.data.table, e.data.rows, e.from);
  };
  mesh.on("peer", onPeer);
  mesh.on("event", onEvent);
  bus.on("replica", onLocal);
  return () => { mesh.off("peer", onPeer); mesh.off("event", onEvent); bus.off("replica", onLocal as any); };
}
