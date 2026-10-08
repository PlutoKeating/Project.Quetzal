// 肢体：另一具身体的工具，她可以在这里直接用（body_call）；也可以换到另一具身体继续这一轮（move_to）。DISTRIBUTED.md C4、C6 补充。
//   - tool.list：这具身体可以被调用的工具（设备工具、hands、自造工具，以及属于这具身体的几个内置工具），刚连上时互相取回。
//   - tool.call：在这具身体上执行，闸门按这具身体的权限判断（需要批准时在这边请求），审计在这边记一笔（调用方也记）。
//   - file.read：另一具身体上的她要用这里的一个文件（view_image、read_document、shell 带 body）：分段交出普通文件（大小有上限、密钥目录与保密库不给），
//     闸门与审计在这边（mind/body-files.ts 的 lendFile）。只读成员（灵魂桥）不能调用。
//   - chat.continue / mind.wake：接手换过来的一轮。
import type { Mesh, PeerStatus } from "./mesh.ts";
import { config, paths } from "../config.ts";
import { adapter } from "../body/twin.ts";
import { limbTools, callTool } from "../mind/tools.ts";
import { lendFile } from "../mind/body-files.ts";
import { bodyUuid, BODY_UUID } from "../body/uuid.ts";
import fs from "node:fs";
import path from "node:path";
import { setBodies, REMOTE_CORE_TOOLS, type RemoteBody } from "../mind/bodies.ts";
import { converse, type WakeResult } from "../mind/brain.ts";
import { log } from "../log.ts";

const paramsOf = (p: unknown) => Object.keys(((p as { properties?: object })?.properties ?? {}) as object);

/** 这具身体可以被其他身体调用的工具清单，带上自己的 uuid（对方拿它和灵魂仓库的登记核对）。 */
export const limbList = (): RemoteBody => ({
  body: config.body, uuid: bodyUuid(), describe: adapter.describe ?? "",
  tools: limbTools(REMOTE_CORE_TOOLS).map((t) => ({ name: t.name, description: t.description, params: paramsOf(t.parameters) })),
});

/** 灵魂仓库的身体登记里登记了 uuid 的身体（规范 v14 §3.10）。灵魂仓库是信任根；格式不对的忽略。 */
export function soulRegistry(): { body: string; uuid: string }[] {
  const dir = path.join(paths.soul, "bodies"), out: { body: string; uuid: string }[] = [];
  let names: string[] = [];
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).slice(0, 500); } catch { return out; }
  for (const f of names) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      const uuid = typeof j?.uuid === "string" ? j.uuid.toLowerCase() : "";
      if (j?.body === f.slice(0, -5) && j.kind === "runtime" && BODY_UUID.test(uuid)) out.push({ body: j.body, uuid });
    } catch {}
  }
  return out;
}

export function installLimbs(mesh: Mesh, registry: () => { body: string; uuid: string }[] = soulRegistry): () => void {
  const known = new Map<string, RemoteBody>();
  mesh.handle("tool.list", () => limbList());
  mesh.handle("tool.call", async (p: { tool: string; args: Record<string, unknown>; reason: string }, from: string) => {
    const tool = String(p?.tool ?? "");
    if (!limbTools(REMOTE_CORE_TOOLS).some((t) => t.name === tool)) return { text: `${config.body} 上没有可以跨身体调用的工具 ${tool}`, status: "error" };
    log("mesh", `${from} 上的她调用这里的 ${tool}`);
    const { body: _body, ...args } = (p.args && typeof p.args === "object" ? p.args : {}) as Record<string, unknown>; // 别处调来的工具不再带 body 转到第三具身体
    return callTool(tool, args, `来自 ${from}：${String(p.reason ?? "").slice(0, 200)}`);
  });
  mesh.handle("file.read", async (p: unknown, from: string) => {
    if (p && typeof p === "object" && typeof (p as { path?: unknown }).path === "string") log("mesh", `${from} 上的她要取这里的一个文件`);
    return lendFile(p, from);
  });
  mesh.handle("chat.continue", async (p: { conv: string; channel: string; note: string }, from: string) => {
    if (typeof p?.conv !== "string" || !p.conv) throw new Error("没有会话");
    const note = `（从 ${from} 换过来）${p.note || "接着刚才的对话继续。"}`;
    return converse("交接", note, "换身体", { conv: p.conv, ambient: true, local: true });
  });

  const refresh = (body: string) => mesh.request<RemoteBody>(body, "tool.list", {}, 15_000).then((b) => { if (b && Array.isArray(b.tools)) known.set(body, { ...b, body }); }, () => {});
  const onPeer = (s: PeerStatus) => { if (s.link === "open") { if (!known.has(s.body)) void refresh(s.body); } else known.delete(s.body); };
  // 自造工具会变：别的身体新造了工具，过一会儿重新取一次
  const timer = setInterval(() => { for (const b of mesh.connected()) void refresh(b); }, 5 * 60_000);
  timer.unref?.();
  mesh.on("peer", onPeer);

  setBodies({
    // uuid 以灵魂仓库的登记为准；对方自报的（tool.list 里的）另放在 claimed，解析 body 时两者一致才认
    list: () => { const reg = registry(); return mesh.connected().flatMap((b) => { const r = known.get(b); return r ? [{ ...r, body: b, uuid: reg.find((x) => x.body === b)?.uuid, claimed: typeof r.uuid === "string" ? r.uuid.toLowerCase().slice(0, 36) : undefined }] : []; }); },
    registry,
    call: (body, tool, args, reason) => mesh.request(body, "tool.call", { tool, args, reason }, 30 * 60_000),
    file: (body, params, ms) => mesh.request(body, "file.read", params, ms),
    move: async (body, ctx) => {
      if (ctx.origin === "chat") return mesh.request<string>(body, "chat.continue", { conv: ctx.conv, channel: ctx.channel, note: ctx.note }, 60 * 60_000);
      const r = await mesh.request<WakeResult>(body, "mind.wake", { kind: ctx.origin === "dream" ? "dream" : "think", reason: `从 ${config.body} 换过来继续`, intent: ctx.note || "接着刚才的事继续" }, 6 * 3_600_000);
      return JSON.stringify(r ?? {});
    },
  });
  return () => { clearInterval(timer); mesh.off("peer", onPeer); setBodies(undefined); };
}
