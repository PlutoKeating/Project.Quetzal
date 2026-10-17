// Canvas 的复制：同一个 agent 的所有身体共用一份 canvas（文档 / 代码、全部版本、评论、运行结果；见 mind/canvas.ts）。
//   - 连上一具身体时补齐：先要对方的摘要（canvas.digest：每份 canvas 与每条评论的修改时刻、每个版本与运行的 id），
//     再按 id 分批要自己没有的或对方较新的行（canvas.rows，每批最多 200 个 id、4 MB）。
//   - 平时本机每写一行（canvas.replica 事件）就实时广播（事件 canvas）。
//   - 收到的行一律经 mind/canvas.ts 的 applyCanvasRemote 逐字段检查后才写入：实时收到的只能是发来的那具身体写的；版本与运行不可变，
//     canvas 的标题 / 语言 / 删除与评论的解决状态按较新的修改为准。运行生成的图片文件不复制（留在运行的那具身体上），只复制清单。
//   - 1.10.0 及以前的身体没有这两个方法：补齐失败只记一笔，不影响别的复制。
import type { Mesh, PeerStatus } from "./mesh.ts";
import { bus } from "../bus.ts";
import { applyCanvasRemote, canvasDigest, canvasRows, CANVAS_ID, type CanvasRows } from "../mind/canvas.ts";
import { log } from "../log.ts";

const BATCH = 200;

function apply(rows: unknown, from: string, catchUp: boolean): number {
  if (!rows || typeof rows !== "object") return 0;
  const { changed, rejected } = applyCanvasRemote(rows as CanvasRows, { from, catchUp });
  if (rejected) log("mesh", `丢弃了 ${from} 发来的 ${rejected} 行不合格的 canvas`);
  return changed;
}

/** 对方摘要里比本机新的部分：要哪些 id。 */
export function wanted(theirs: unknown): { docs: string[]; versions: string[]; comments: string[]; runs: string[] } {
  const t = (theirs && typeof theirs === "object" ? theirs : {}) as Record<string, unknown>;
  const mine = canvasDigest();
  const newer = (m: unknown, have: Record<string, number>, re: RegExp) => Object.entries(m && typeof m === "object" && !Array.isArray(m) ? m : {})
    .filter(([id, ts]) => re.test(id) && Number.isFinite(ts) && (have[id] === undefined || (ts as number) > have[id])).map(([id]) => id);
  const missing = (l: unknown, have: string[], re: RegExp) => { const h = new Set(have); return (Array.isArray(l) ? l : []).filter((id): id is string => typeof id === "string" && re.test(id) && !h.has(id)); };
  return {
    docs: newer(t.docs, mine.docs, CANVAS_ID.doc).slice(0, 20_000),
    versions: missing(t.versions, mine.versions, CANVAS_ID.version).slice(0, 200_000),
    comments: newer(t.comments, mine.comments, CANVAS_ID.comment).slice(0, 100_000),
    runs: missing(t.runs, mine.runs, CANVAS_ID.run).slice(0, 50_000),
  };
}

/** 从一具刚连上的身体补齐 canvas。 */
async function catchUp(mesh: Mesh, peer: string) {
  try {
    const want = wanted(await mesh.request<unknown>(peer, "canvas.digest", {}, 60_000));
    let total = 0;
    for (const key of ["docs", "versions", "comments", "runs"] as const) { // 先要 canvas 本身，再要版本与评论（控制台刷新时能找到所属的会话）
      let left = [...want[key]];
      while (left.length) {
        const ask = left.slice(0, BATCH);
        const got = await mesh.request<CanvasRows>(peer, "canvas.rows", { [key]: ask }, 60_000);
        const rows = (got && Array.isArray((got as any)[key]) ? (got as any)[key] : []) as any[];
        total += apply({ [key]: rows }, peer, true);
        const ids = new Set(rows.map((r) => r?.id));
        // 这一批里对方因为大小上限没给的留到下一批；一行也没给（已不存在）就跳过这一批，避免死循环
        left = [...(rows.length ? ask.filter((id) => !ids.has(id)) : []), ...left.slice(ask.length)];
      }
    }
    if (total) log("mesh", `从 ${peer} 补齐了 ${total} 行 canvas`);
  } catch (e) { log("mesh", `从 ${peer} 补齐 canvas 失败：${(e as Error).message}`); }
}

/** 给一个 Mesh 装上 canvas 的复制。返回卸载函数。 */
export function installCanvasReplica(mesh: Mesh): () => void {
  mesh.handle("canvas.digest", () => canvasDigest());
  mesh.handle("canvas.rows", (p: unknown) => canvasRows((p ?? {}) as any));
  const open = new Set<string>();
  const onPeer = (s: PeerStatus) => {
    if (s.link === "open" && !open.has(s.body)) { open.add(s.body); void catchUp(mesh, s.body); }
    else if (s.link !== "open") open.delete(s.body);
  };
  const onLocal = (e: { docs: unknown[]; versions: unknown[]; comments: unknown[]; runs: unknown[] }) => mesh.broadcast("canvas", e);
  const onEvent = (e: { from: string; name: string; data: unknown }) => { if (e.name === "canvas") apply(e.data, e.from, false); };
  mesh.on("peer", onPeer);
  mesh.on("event", onEvent);
  bus.on("canvas.replica", onLocal);
  return () => { mesh.off("peer", onPeer); mesh.off("event", onEvent); bus.off("canvas.replica", onLocal as any); };
}
