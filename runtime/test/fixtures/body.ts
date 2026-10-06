// 测试用的一具身体：独立进程（存储是单例），有自己的家目录、身体名与节点密钥，连上测试用的同步服务，装上网状层上的协作模块；
// 测试主进程经 IPC 下指令（call：{id, cmd, args} → {id, result | error}）。
//   环境变量：QUETZAL_HOME、BODY、SYNC（同步服务地址）、KEYS（JSON：身体 → 节点公钥，即「灵魂仓库」里登记的）
process.env.QUETZAL_HOME ??= "";
const cfg = await import("../../src/config.ts"); // 用命名空间读 config：它是会被整体替换的活绑定，解构出来会停在旧值
const { loadConfig, saveConfig, paths } = cfg;
loadConfig();
saveConfig({ body: process.env.BODY, mesh: { priority: Number(process.env.PRIORITY ?? 0) } });
const store = await import("../../src/store.ts");
store.openStore();
const { Mesh } = await import("../../src/mesh/mesh.ts");
const { loadNodeKey } = await import("../../src/mesh/identity.ts");
const { installReplica } = await import("../../src/mesh/replica.ts");
const { installPresence, digest } = await import("../../src/mesh/presence.ts");
const { installCoordinator, coordinator } = await import("../../src/mesh/coordinator.ts");
const heart = await import("../../src/heart/heart.ts");
const { installPlacement } = await import("../../src/mesh/placement.ts");
const { installLimbs } = await import("../../src/mesh/limbs.ts");
const { installShared, decideAnywhere, remoteApprovals, alignStatus } = await import("../../src/mesh/shared.ts");
const guard = await import("../../src/guard/guard.ts");
const { installChannels } = await import("../../src/mesh/channels.ts");
const { meshHeard } = await import("../../src/voice/hearing.ts");
const { earOf } = await import("../../src/mind/bodies.ts");
const fs = await import("node:fs");
const { wake } = await import("../../src/mind/brain.ts");
const { liveTurns } = await import("../../src/mind/activity.ts");
const { converse } = await import("../../src/mind/brain.ts");
const reg = await import("../../src/providers/registry.ts");
const http = await import("node:http");

// 模拟的模型：回复里带上身体名（看得出是哪具身体在回答），可以设置延迟（制造「正在进行的一轮」）
let llmDelay = 0, llmWhere: string[] | undefined;
const llmScript: any[] = []; // 按顺序回放的模型回复（例如工具调用），放完了回到缺省回复
const llm = http.createServer((req, res) => {
  let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
    const j = JSON.parse(body); const last = j.messages.at(-1); const text = typeof last.content === "string" ? last.content : last.content?.find((c: any) => c.type === "text")?.text ?? "";
    const content = /先别急着做事/.test(text) && llmWhere ? JSON.stringify({ engage: true, intent: "测试的意图", where: llmWhere }) : `${process.env.BODY} 的回复`;
    const message = !/先别急着做事/.test(text) && llmScript.length ? llmScript.shift() : { content };
    setTimeout(() => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 1, completion_tokens: 1 } })); }, llmDelay);
  });
});
await new Promise<void>((r) => llm.listen(0, "127.0.0.1", r));
reg.saveProviders({ providers: [{ id: "p", catalogId: "custom", name: "Mock", baseUrl: `http://127.0.0.1:${(llm.address() as any).port}`, protocol: "openai-completions" as const, enabled: true,
  keys: [{ id: "k", label: "k", lastFour: "", enabled: true, secret: "sk-mock-000000" }], models: [{ id: "m", name: "plain", enabled: true, context: 8000, maxTokens: 256, sortOrder: 0 }] }] }, reg.configVersion());
// 每具测试身体的模拟模型在自己的进程里：供应商配置不参与身体之间的同步——各具身体的修改时刻记为同一个值 1，
// 谁也不比谁新（严格更新的才会被采用），启动时的补修订号（mesh/shared.ts backfillRevs）也跳过它
saveConfig({ sharedRev: { providers: 1 } }, { remote: true });
const path = await import("node:path");
const ndc: any = (await import("node-datachannel")).default;

const keys = JSON.parse(process.env.KEYS ?? "{}") as Record<string, string>;
const key = loadNodeKey(path.join(paths.secrets, "mesh_ed25519"));
const mesh = new Mesh({
  me: process.env.BODY!, key, ndc, binding: { server: process.env.SYNC!, token: process.env.BODY!, agent: "x", body: process.env.BODY!, account: "t" },
  keyOf: (b) => keys[b], hello: () => ({ version: "t" }), log: () => {},
});
installReplica(mesh);
installPresence(mesh);
installCoordinator(mesh);
installPlacement(mesh, "t", () => false);
installLimbs(mesh);
installShared(mesh);
installChannels(mesh);
mesh.start();

const cmds: Record<string, (a: any) => unknown> = {
  nodeKey: () => key.nodeKey,
  connected: () => mesh.connected(),
  emit: (a) => { mesh.broadcast(a.name, a.data); return true; }, // 测试用：直接广播任意事件（模拟出错或被攻破的身体）
  addMessage: (a) => store.addMessage(a.role, a.channel ?? "控制台", a.text, { session: a.session }),
  setMode: (a) => store.setMessageMode(a.id, a.mode),
  addTimeline: (a) => store.addTimeline(a.kind, a.title, a.detail ?? null).id,
  ensureSession: (a) => store.ensureSession(a.id, a.title),
  updateSession: (a) => store.updateSession(a.id, a.patch),
  messages: (a) => store.sessionMessages(a.session, a.limit ?? 200),
  sessions: () => store.listSessions(),
  timeline: () => store.listTimeline(200),
  idPrefix: () => store.idPrefix(),
  coordinator: () => coordinator(),
  heart: () => { const h = heart.snapshot(); return { follower: h.follower, drives: h.drives, S: h.S, unconsolidated: h.unconsolidated }; },
  nudge: (a) => heart.nudge(a.reason ?? "测试", a.drives ?? {}),
  experience: (a) => heart.addExperience(a.n ?? 1),
  saveConfig: (a) => { saveConfig(a.patch); return true; },
  config: (a) => (cfg.config as any)[a.section],
  addProviderKey: (a) => {
    const c = reg.publicView();
    c.providers.push({ id: a.id, catalogId: "custom", name: a.id, baseUrl: "https://llm.example", protocol: "openai-completions", enabled: false, keys: [{ id: `${a.id}-k`, label: "k", lastFour: "", enabled: true, secret: a.secret } as any], models: [] });
    reg.saveProviders(c, reg.configVersion()); return true;
  },
  aligned: (a) => alignStatus(a.body) ?? null,
  providerSecret: (a) => reg.exportProviders().providers.find((p) => p.id === a.id)?.keys[0]?.secret ?? null,
  providerCipher: (a) => (JSON.parse(fs.readFileSync(path.join(paths.config, "providers.json"), "utf8")).providers.find((p: any) => p.id === a.id)?.keys[0]?.ciphertext ?? null),
  stopNow: (a) => { guard.emergencyStop("测试", "测试急停", { scope: a.scope }); return true; },
  unstop: () => { guard.releaseStop("测试"); return true; },
  stopped: () => fs.existsSync(paths.stop),
  check: (a) => guard.check(a.permission, a.action ?? "测试动作", "测试", {}),
  approvals: () => [...guard.approvals(), ...remoteApprovals()],
  decide: (a) => decideAnywhere(a.id, a.approve, "测试控制台"),
  addUsage: (a) => { store.addUsage(a.model ?? "m", a.input ?? 0, a.output ?? 0, a.cost ?? 0); return true; },
  usageToday: () => store.usageToday(),
  heard: (a) => meshHeard(a.text, a.conv, a.at),
  earOf: (a) => earOf(a.conv) ?? null,
  llmScript: (a) => { llmScript.push(...a.messages); return true; },
  audit: () => store.listAudit(20),
  llmWhere: (a) => { llmWhere = a.where; return true; },
  wake: (a) => wake(a.kind ?? "think", a.reason ?? "测试"),
  llmDelay: (a) => { llmDelay = a.ms; return true; },
  converse: (a) => converse(a.from ?? "你", a.text, a.channel ?? "控制台", { conv: a.conv, mode: a.mode }),
  digest: () => digest(),
  live: () => liveTurns().map((t) => ({ conv: t.conv, body: t.body, origin: t.origin, status: t.status })),
  stop: () => { mesh.stop(); setTimeout(() => { ndc.cleanup(); process.exit(0); }, 200); return true; },
};
process.on("message", async (m: any) => {
  try { process.send!({ id: m.id, result: await cmds[m.cmd](m.args ?? {}) }); }
  catch (e) { process.send!({ id: m.id, error: (e as Error).message }); }
});
process.send!({ ready: true });
