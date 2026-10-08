// 肢体：另一具身体的工具，她可以在这里直接用（body_call）；也可以换到另一具身体继续这一轮（move_to）。DISTRIBUTED.md C4、C6 补充。
//   - tool.list：这具身体可以被调用的工具（设备工具、hands、自造工具，以及属于这具身体的几个内置工具），刚连上时互相取回。
//   - tool.call：在这具身体上执行，闸门按这具身体的权限判断（需要批准时在这边请求），审计在这边记一笔（调用方也记）。
//   - image.read：另一具身体上的她要看这里的一张图（view_image 带 body）：只交出图片（类型按文件头、大小有上限、密钥目录与保密库不给），闸门与审计在这边。
//   - chat.continue / mind.wake：接手换过来的一轮。
import type { Mesh, PeerStatus } from "./mesh.ts";
import { config } from "../config.ts";
import { adapter } from "../body/twin.ts";
import { limbTools, callTool, lendImage } from "../mind/tools.ts";
import { setBodies, REMOTE_CORE_TOOLS, type RemoteBody } from "../mind/bodies.ts";
import { converse, type WakeResult } from "../mind/brain.ts";
import { log } from "../log.ts";

const paramsOf = (p: unknown) => Object.keys(((p as { properties?: object })?.properties ?? {}) as object);

/** 这具身体可以被其他身体调用的工具清单。 */
export const limbList = (): RemoteBody => ({
  body: config.body, describe: adapter.describe ?? "",
  tools: limbTools(REMOTE_CORE_TOOLS).map((t) => ({ name: t.name, description: t.description, params: paramsOf(t.parameters) })),
});

export function installLimbs(mesh: Mesh): () => void {
  const known = new Map<string, RemoteBody>();
  mesh.handle("tool.list", () => limbList());
  mesh.handle("tool.call", async (p: { tool: string; args: Record<string, unknown>; reason: string }, from: string) => {
    const tool = String(p?.tool ?? "");
    if (!limbTools(REMOTE_CORE_TOOLS).some((t) => t.name === tool)) return { text: `${config.body} 上没有可以跨身体调用的工具 ${tool}`, status: "error" };
    log("mesh", `${from} 上的她调用这里的 ${tool}`);
    return callTool(tool, p.args && typeof p.args === "object" ? p.args : {}, `来自 ${from}：${String(p.reason ?? "").slice(0, 200)}`);
  });
  mesh.handle("image.read", async (p: { path: string; reason: string }, from: string) => {
    log("mesh", `${from} 上的她要看这里的一张图`);
    return lendImage(p?.path, from, typeof p?.reason === "string" ? p.reason : "");
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
    list: () => mesh.connected().map((b) => known.get(b)).filter((b): b is RemoteBody => !!b),
    call: (body, tool, args, reason) => mesh.request(body, "tool.call", { tool, args, reason }, 30 * 60_000),
    image: async (body, file, reason) => {
      const r = await mesh.request<{ mime: string; data: string; note: string; path: string }>(body, "image.read", { path: file, reason }, 31 * 60_000); // 那边的闸门可能要等批准（最多 30 分钟）
      // 那边交回的也要核对：类型只收图片、数据是 base64、大小不超过网状层单条上限
      if (!r || typeof r.data !== "string" || typeof r.mime !== "string" || !/^image\/(jpeg|png|gif|webp|bmp)$/.test(r.mime) || r.data.length > 32 << 20 || !/^[A-Za-z0-9+/]*={0,2}$/.test(r.data)) throw new Error(`${body} 交回的不是图片`);
      return { mime: r.mime, data: r.data, note: typeof r.note === "string" ? r.note.slice(0, 200) : "", path: typeof r.path === "string" ? r.path.slice(0, 4096) : file };
    },
    move: async (body, ctx) => {
      if (ctx.origin === "chat") return mesh.request<string>(body, "chat.continue", { conv: ctx.conv, channel: ctx.channel, note: ctx.note }, 60 * 60_000);
      const r = await mesh.request<WakeResult>(body, "mind.wake", { kind: ctx.origin === "dream" ? "dream" : "think", reason: `从 ${config.body} 换过来继续`, intent: ctx.note || "接着刚才的事继续" }, 6 * 3_600_000);
      return JSON.stringify(r ?? {});
    },
  });
  return () => { clearInterval(timer); mesh.off("peer", onPeer); setBodies(undefined); };
}
