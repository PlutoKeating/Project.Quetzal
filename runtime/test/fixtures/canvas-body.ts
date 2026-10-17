// 测试用的一具身体，只装 canvas 的复制（mesh/canvas.ts）：独立进程（存储是单例），有自己的家目录、身体名与节点密钥，连上测试用的同步服务。
//   测试主进程经 IPC 下指令（{id, cmd, args} → {id, result | error}）。环境变量：QUETZAL_HOME、BODY、SYNC（同步服务地址）、KEYS（身体 → 节点公钥）
const cfg = await import("../../src/config.ts");
cfg.loadConfig();
cfg.saveConfig({ body: process.env.BODY });
const store = await import("../../src/store.ts");
store.openStore();
const path = await import("node:path");
const { Mesh } = await import("../../src/mesh/mesh.ts");
const { loadNodeKey } = await import("../../src/mesh/identity.ts");
const { installCanvasReplica } = await import("../../src/mesh/canvas.ts");
const cv = await import("../../src/mind/canvas.ts");
const ndc: any = (await import("node-datachannel")).default;

const keys = JSON.parse(process.env.KEYS ?? "{}") as Record<string, string>;
const key = loadNodeKey(path.join(cfg.paths.secrets, "mesh_ed25519"));
const mesh = new Mesh({
  me: process.env.BODY!, key, ndc, binding: { server: process.env.SYNC!, token: process.env.BODY!, agent: "x", body: process.env.BODY!, account: "t" },
  keyOf: (b) => keys[b], hello: () => ({ version: "t" }), log: () => {},
});
installCanvasReplica(mesh);
mesh.start();

const cmds: Record<string, (a: any) => unknown> = {
  connected: () => mesh.connected(),
  emit: (a) => { mesh.broadcast(a.name, a.data); return true; }, // 模拟出错或被攻破的身体：直接广播任意事件
  create: (a) => cv.createCanvas({ conv: a.conv, title: a.title, kind: a.kind, lang: a.lang, content: a.content, author: a.author ?? "agent" }),
  edit: (a) => cv.editCanvas(a.id, { content: a.content, author: a.author ?? "user" }).view,
  rename: (a) => cv.updateCanvas(a.id, { title: a.title }),
  comment: (a) => cv.addComment({ doc: a.id, text: a.text, quote: a.quote, author: a.author ?? "user" }),
  resolve: (a) => cv.resolveComment(a.id, a.resolved, "user"),
  get: (a) => { try { return cv.getCanvas(a.id); } catch { return null; } },
  versions: (a) => cv.versions(a.id),
  list: (a) => cv.listCanvases(a.conv),
  stop: () => { mesh.stop(); setTimeout(() => { ndc.cleanup(); process.exit(0); }, 200); return true; },
};
process.on("message", async (m: any) => {
  try { process.send!({ id: m.id, result: await cmds[m.cmd](m.args ?? {}) }); }
  catch (e) { process.send!({ id: m.id, error: (e as Error).message }); }
});
process.send!({ ready: true });
