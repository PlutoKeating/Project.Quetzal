// 肢体：另一具身体的工具，她可以在这里直接用（body_call）；也可以换到另一具身体继续这一轮（move_to）。DISTRIBUTED.md C4、C6 补充。
//   - tool.list：这具身体可以被调用的工具（设备工具、hands、自造工具，以及属于这具身体的几个内置工具），刚连上时互相取回。
//   - tool.call：在这具身体上执行，闸门按这具身体的权限判断（需要批准时在这边请求），审计在这边记一笔（调用方也记）。
//   - chat.continue / mind.wake：接手换过来的一轮。
import type { Mesh, PeerStatus } from "./mesh.ts";
import { config } from "../config.ts";
import { adapter } from "../body/twin.ts";
import { limbTools, callTool } from "../mind/tools.ts";
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
    move: async (body, ctx) => {
      if (ctx.origin === "chat") return mesh.request<string>(body, "chat.continue", { conv: ctx.conv, channel: ctx.channel, note: ctx.note }, 60 * 60_000);
      const r = await mesh.request<WakeResult>(body, "mind.wake", { kind: ctx.origin === "dream" ? "dream" : "think", reason: `从 ${config.body} 换过来继续`, intent: ctx.note || "接着刚才的事继续" }, 6 * 3_600_000);
      return JSON.stringify(r ?? {});
    },
  });
  return () => { clearInterval(timer); mesh.off("peer", onPeer); setBodies(undefined); };
}
