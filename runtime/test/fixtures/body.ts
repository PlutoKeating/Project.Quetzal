// 测试用的一具身体：独立进程（存储是单例），有自己的家目录、身体名与节点密钥，连上测试用的同步服务，装上网状层上的协作模块；
// 测试主进程经 IPC 下指令（call：{id, cmd, args} → {id, result | error}）。
//   环境变量：QUETZAL_HOME、BODY、SYNC（同步服务地址）、KEYS（JSON：身体 → 节点公钥，即「灵魂仓库」里登记的）
process.env.QUETZAL_HOME ??= "";
const { loadConfig, saveConfig, paths } = await import("../../src/config.ts");
loadConfig();
saveConfig({ body: process.env.BODY });
const store = await import("../../src/store.ts");
store.openStore();
const { Mesh } = await import("../../src/mesh/mesh.ts");
const { loadNodeKey } = await import("../../src/mesh/identity.ts");
const { installReplica } = await import("../../src/mesh/replica.ts");
const path = await import("node:path");
const ndc: any = (await import("node-datachannel")).default;

const keys = JSON.parse(process.env.KEYS ?? "{}") as Record<string, string>;
const key = loadNodeKey(path.join(paths.secrets, "mesh_ed25519"));
const mesh = new Mesh({
  me: process.env.BODY!, key, ndc, binding: { server: process.env.SYNC!, token: process.env.BODY!, agent: "x", body: process.env.BODY!, account: "t" },
  keyOf: (b) => keys[b], hello: () => ({ version: "t" }), log: () => {},
});
installReplica(mesh);
mesh.start();

const cmds: Record<string, (a: any) => unknown> = {
  nodeKey: () => key.nodeKey,
  connected: () => mesh.connected(),
  addMessage: (a) => store.addMessage(a.role, a.channel ?? "控制台", a.text, { session: a.session }),
  setMode: (a) => store.setMessageMode(a.id, a.mode),
  addTimeline: (a) => store.addTimeline(a.kind, a.title, a.detail ?? null).id,
  ensureSession: (a) => store.ensureSession(a.id, a.title),
  updateSession: (a) => store.updateSession(a.id, a.patch),
  messages: (a) => store.sessionMessages(a.session, a.limit ?? 200),
  sessions: () => store.listSessions(),
  timeline: () => store.listTimeline(200),
  idPrefix: () => store.idPrefix(),
  stop: () => { mesh.stop(); setTimeout(() => { ndc.cleanup(); process.exit(0); }, 200); return true; },
};
process.on("message", async (m: any) => {
  try { process.send!({ id: m.id, result: await cmds[m.cmd](m.args ?? {}) }); }
  catch (e) { process.send!({ id: m.id, error: (e as Error).message }); }
});
process.send!({ ready: true });
