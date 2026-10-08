// 操作层：控制台网关与飞书卡片共用的一套操作。任何控制入口都只调用这里，保证行为一致、都有审计。
import path from "node:path";
import { ensureSshKeyFile } from "./ssh-key.ts";
import fs from "node:fs";
import { config, saveConfig, paths, type Level } from "./config.ts";
import { audit, listTimeline, listAudit, usageToday, recentMessages, listSessions, ensureSession, updateSession, sessionMessages } from "./store.ts";
import { liveTurns } from "./mind/activity.ts";
import * as voice from "./voice/azure.ts";
import crypto from "node:crypto";
import * as heart from "./heart/heart.ts";
import * as guard from "./guard/guard.ts";
import * as mem from "./memory/memory.ts";
import * as soul from "./memory/soul-sync.ts";
import { body, adapter } from "./body/twin.ts";
import { loadProviders, publicView, configVersion, saveProviders } from "./providers/registry.ts";
import { routes, testModel, remoteModels } from "./providers/router.ts";
import { getCatalog, refreshCatalog } from "./providers/catalog.ts";
import { quickSetup } from "./providers/quick.ts";
import { bus } from "./bus.ts";
import type { ProviderConfig } from "./providers/types.ts";
import { VERSION } from "./version.ts";
import { identity, setIdentity, type AgentIdentity } from "./memory/identity.ts";
import { run } from "./sh.ts";
import { checkRemote } from "./memory/soul-repo.ts";
import { listSecrets, deleteSecret, pendingSecrets, endCapture } from "./mind/secrets.ts";
import { listCustomTools, listSkills, readTool, readSkill, deleteTool, setToolEnabled } from "./mind/custom-tools.ts";
import * as hearing from "./voice/hearing.ts";
import * as player from "./voice/player.ts";
import * as meshRt from "./mesh/runtime.ts";
import * as acct from "./mesh/account.ts";
import { remoteApprovals, decideAnywhere } from "./mesh/shared.ts";
import { sandboxStatus, resetSandbox } from "./sandbox.ts";
import { checkKeyPath } from "./memory/soul-repo.ts";
import * as reminders from "./time/reminders.ts";
import { hostModes, enterHost, exitHost } from "./host-mode.ts";

export const status = () => ({
  agent: identity(), version: VERSION, body: config.body, adapter: adapter.name, heart: heart.snapshot(), physical: body,
  stopped: heart.stopped(), paused: config.heart.paused, activity: config.heart.activity,
  usage: usageToday(), budget: config.budget, approvals: [...guard.approvals(), ...remoteApprovals()], soul: soul.syncStatus(),
  models: routes().map((r) => `${r.provider.name}/${r.model.name}`),
  thought: mem.thought(), // 她想分享的一句话（首页展示）
  hearing: hearing.hearingStatus(), // 听觉：App 据 listening 决定要不要开麦克风
  mesh: meshRt.meshStatus(), // 网状层：同步服务、绑定、各身体的连接
  sandbox: sandboxStatus(), // agent 命令的沙箱：kind 为 bwrap / proot / none（none 时控制台应提示安装）
  reminders: reminderView(), // 她答应的提醒（首页显示接下来的几条）
  host: hostModes(), // 此刻处在真实环境里（命令不经沙箱）的会话：控制台据此显示警示条
});

/** 控制台看到的提醒：下一次的说法、是否重复、内容。 */
const reminderView = () => reminders.active().slice(0, 20).map((r) => ({ id: r.id, text: r.text, at: r.at, when: r.span ? reminders.describe({ ...r, cron: undefined }) : reminders.when(r.at, r.tz), repeat: r.cron ? reminders.cronText(r.cron) : "" }));

export const ops = {
  // 提醒：控制台只看与取消；设提醒是对她说（reminder 工具）
  reminders: () => reminderView(),
  "reminders.cancel": (a: { id: string }, actor: string) => { const r = reminders.cancel(String(a?.id ?? "")); audit(actor, "reminders.cancel", "", { id: r.id }, "ok"); return reminderView(); },
  // 网状层（多具身体连成一个心智）：同步服务地址、设备码绑定、解绑
  mesh: () => meshRt.meshStatus(),
  "mesh.setServer": async (a: { server: string }, actor: string) => { const r = await meshRt.setServer(String(a.server ?? "")); audit(actor, "mesh.setServer", "", { server: r.server }, "ok"); return r; },
  "mesh.bind": async (_: unknown, actor: string) => { const r = await meshRt.bind(); audit(actor, "mesh.bind", "", { server: r.server }, "started"); return r; },
  "mesh.cancelBind": () => meshRt.cancelBind(),
  "mesh.setPriority": (a: { priority: number }, actor: string) => { const p = Math.max(0, Math.min(100, Math.round(Number(a.priority) || 0))); saveConfig({ mesh: { priority: p } }); audit(actor, "mesh.setPriority", "", { priority: p }, "ok"); return meshRt.meshStatus(); },
  "mesh.acceptPin": (a: { body: string }, actor: string) => { const r = meshRt.acceptPin(String(a.body ?? "")); audit(actor, "mesh.acceptPin", "", { body: a.body }, "ok"); return r; },
  "mesh.unbind": async (_: unknown, actor: string) => { const r = await meshRt.unbindMesh(); audit(actor, "mesh.unbind", "", {}, "ok"); return r; },
  // 账户（控制台登录后管理同步服务上的整个账户；与官网账户页同一套接口）
  account: () => acct.accountStatus(),
  "account.signIn": async (_: unknown, actor: string) => { const r = await acct.signIn(); audit(actor, "account.signIn", "", {}, "started"); return r; },
  "account.cancel": () => acct.cancelSignIn(),
  "account.signOut": async (_: unknown, actor: string) => { const r = await acct.account.signOut(); audit(actor, "account.signOut", "", {}, "ok"); return r; },
  "account.get": () => acct.account.get(),
  "account.lookup": (a: { code: string }) => acct.account.lookup(a.code),
  "account.decide": async (a: { code: string; approve: boolean; agent?: string }, actor: string) => { const r = await acct.account.decide(a.code, a.approve, a.agent); audit(actor, "account.decide", "", { approve: !!a.approve }, "ok"); return r; },
  "account.removeBody": async (a: { agent: string; body: string }, actor: string) => { const r = await acct.account.removeBody(a.agent, a.body); audit(actor, "account.removeBody", "", { body: a.body }, "ok"); return r; },
  "account.removeAgent": async (a: { agent: string }, actor: string) => { const r = await acct.account.removeAgent(a.agent); audit(actor, "account.removeAgent", "", { agent: a.agent }, "ok"); return r; },
  "account.revokeConsole": async (a: { id: string }, actor: string) => { const r = await acct.account.revokeConsole(a.id); audit(actor, "account.revokeConsole", "", {}, "ok"); return r; },
  "account.delete": async (_: unknown, actor: string) => { const r = await acct.account.deleteAccount(); audit(actor, "account.delete", "", {}, "ok"); return r; },
  status,
  timeline: (a: { limit?: number; before?: number; kind?: string }) => listTimeline(a.limit ?? 50, a.before, a.kind),
  messages: (a: { limit?: number }) => recentMessages(a.limit ?? 50),
  audit: (a: { limit?: number }) => listAudit(a.limit ?? 100),

  // 会话：多个会话可同时进行；归档的会话可以找回；进行中的轮次可随时取回快照（断线、切到后台后恢复界面）
  sessions: (a: { archived?: boolean }) => listSessions({ archived: !!a.archived }),
  "sessions.create": (a: { title?: string }) => ensureSession(crypto.randomUUID(), a.title?.trim() || "新的对话"),
  "sessions.rename": (a: { id: string; title: string }) => updateSession(a.id, { title: a.title }),
  "sessions.archive": (a: { id: string; archived: boolean }) => updateSession(a.id, { archived: a.archived !== false }),
  "sessions.messages": (a: { id: string; limit?: number; before?: number }) => sessionMessages(a.id, a.limit ?? 60, a.before),
  "sessions.live": () => liveTurns(),

  // 语音（Azure）：密钥只返回末四位
  speech: () => voice.speechStatus(),
  setSpeech: async (a: Partial<voice.SpeechConfig> & { key?: string }, actor: string) => { const r = await voice.setSpeechAuto(a); audit(actor, "speech", "", { ...a, key: a.key ? "****" : undefined, region: r.region }, "ok"); return r; },
  speechVoices: (a: { locale?: string }) => voice.listVoices(a.locale ?? ""),
  speechTest: async (a: { text?: string }) => { const f = await voice.synthesize(a.text || "你好，这是我的声音。"); const r = await player.play(f, a.text || "你好，这是我的声音。"); return { ok: true, file: f, played: r.by !== "none", by: r.by }; },
  // 控制台 App 的耳朵开着时登记为她的播放器（回声消除需要声音从 App 的通话路径放出来）；播完或被插嘴后回报
  "player.set": (a: { enabled: boolean }) => { player.setPlayer(a.enabled !== false); return player.hasPlayer(); },
  "player.done": (a: { id: string; interrupted?: boolean; utterance?: string }) => player.done(String(a.id), !!a.interrupted, a.utterance ? String(a.utterance).slice(0, 64) : undefined),

  // 保密库（pass_secret）：只有名字、说明与大小，任何接口都不返回值。secrets.end 与对方发回结束口令等价（按钮用）
  secrets: () => listSecrets(),
  "secrets.delete": (a: { name: string }, actor: string) => { const ok = deleteSecret(String(a.name)); audit(actor, "secrets.delete", "", a, ok ? "ok" : "没有这一项"); return ok; },
  "secrets.pending": () => pendingSecrets(),
  "secrets.end": (a: { id: string; cancel?: boolean }) => endCapture(String(a.id), a.cancel ? "cancelled" : "done") ?? null,

  // 听觉（耳朵在控制台 App）
  hearing: () => hearing.hearingStatus(),
  setHearing: (a: Partial<hearing.HearingConfig>, actor: string) => { audit(actor, "hearing", "", a, "ok"); return hearing.setHearing(a); },

  // 她自己造的工具：只看、启停与删除；编辑由她自己（tool_write）完成
  tools: () => ({ tools: listCustomTools(), skills: listSkills() }),
  "tools.read": (a: { name: string }) => readTool(String(a.name)) ?? (readSkill(String(a.name)) ? { manifest: null, source: "", skill: readSkill(String(a.name)) } : null), // 只有技能文档（其他身体写的）时 manifest 为空
  "tools.toggle": (a: { name: string; enabled: boolean }, actor: string) => { const ok = setToolEnabled(String(a.name), a.enabled !== false); audit(actor, "tools.toggle", "", a, ok ? "ok" : "没有这个工具"); if (ok) mem.writeJournal(a.enabled !== false ? "有人启用了我的一个工具" : "有人停用了我的一个工具", `${actor}：${a.name}`); return ok; },
  "tools.delete": async (a: { name: string; skill?: boolean }, actor: string) => { const r = deleteTool(String(a.name), !!a.skill); audit(actor, "tools.delete", "", a, r); mem.writeJournal("有人删了我的一个工具", `${actor}：${a.name}`); if (a.skill) await soul.push(`删除技能：${a.name}`).catch(() => {}); return r; },

  poke: (a: { note?: string }, actor: string) => { heart.nudge(`${actor}戳了一下${a.note ? "：" + a.note : ""}`, { social: 0.3, curiosity: 0.1 }, { wake: true }); audit(actor, "poke", a.note ?? "", null, "ok"); return true; },
  pause: (a: { paused: boolean }, actor: string) => { saveConfig({ heart: { paused: a.paused } }); audit(actor, a.paused ? "pause" : "resume", "", null, "ok"); heart.nudge(a.paused ? "暂停自主" : "恢复自主"); return true; },
  activity: (a: { value: number }, actor: string) => { saveConfig({ heart: { activity: Math.max(0, Math.min(4, a.value)) } }); audit(actor, "activity", "", a, "ok"); heart.nudge("活跃度调整"); return config.heart.activity; },
  stop: (a: { reason?: string; scope?: "all" | "body" }, actor: string) => { guard.emergencyStop(actor, a.reason, { scope: a.scope === "body" ? "body" : "all" }); return true; },
  unstop: (_: unknown, actor: string) => { guard.releaseStop(actor); heart.nudge("解除急停"); return true; },
  personality: (a: { changes: Record<string, number> }, actor: string) => { audit(actor, "personality", "", a, "ok"); return heart.adjustPersonality(a.changes); },

  permissions: () => Object.entries(guard.PERMISSION_LABELS).map(([id, label]) => ({ id, label, level: guard.level(id) })),
  setPermission: (a: { id: string; level: Level }, actor: string) => { guard.setLevel(a.id, a.level, actor); return true; },
  // 没有可用沙箱时是否允许她的命令不隔离运行（不安全；缺省不允许）。只有持网关令牌的控制台能改：没有沙箱时她的命令本来就不执行，碰不到网关
  "sandbox.allowUnsandboxed": (a: { allow: boolean }, actor: string) => {
    saveConfig({ sandbox: { allowUnsandboxed: a.allow === true } }); resetSandbox();
    audit(actor, "sandbox.allowUnsandboxed", a.allow === true ? "允许不隔离运行" : "恢复缺省：没有沙箱就不执行", { allow: a.allow === true }, "ok");
    return sandboxStatus();
  },
  // 真实环境（host-mode.ts）：对方在某个会话里自己打开或随时退出；她的请求走审批（decide）
  host: () => hostModes(),
  "host.enter": (a: { conv: string }, actor: string) => enterHost(String(a?.conv ?? ""), "user", "对方自己打开", actor),
  "host.exit": (a: { conv: string }, actor: string) => exitHost(String(a?.conv ?? ""), actor, "对方退出"),
  approvals: () => [...guard.approvals(), ...remoteApprovals()], // 含其他身体上等待批准的（带 body）
  decide: (a: { id: string; approve: boolean; note?: string; body?: string }, actor: string) => decideAnywhere(a.id, a.approve, actor, a.note, typeof a.body === "string" && a.body ? a.body : undefined), // 其他身体上的审批转过去；body 指明是哪具身体上的（审批号可能重复）
  budget: () => ({ ...config.budget, usage: usageToday() }),
  setBudget: (a: Partial<typeof config.budget>, actor: string) => { saveConfig({ budget: a }); audit(actor, "budget", "", a, "ok"); return config.budget; },

  memory: () => ({ soul: mem.soul(), memory: mem.entries("memory"), user: mem.entries("user"), loops: mem.openLoops() }),
  editMemory: async (a: { target: mem.Target; action: "add" | "replace" | "remove"; content?: string; oldText?: string }, actor: string) => {
    const r = await mem.exclusive(() => mem.editMemory(a.target, a.action, a.content, a.oldText));
    audit(actor, "memory.edit", "外部修改", a, r);
    mem.writeJournal("有人改了我的记忆", `${actor} 对 ${a.target} 做了 ${a.action}：${a.content ?? a.oldText ?? ""}`);
    return r;
  },
  setSoul: async (a: { text: string }, actor: string) => { await mem.exclusive(() => mem.setSoul(a.text)); audit(actor, "soul.edit", "外部修改", null, "ok"); mem.writeJournal("有人改了我的人格文件", `${actor} 修改了 SOUL.md`); return true; },
  journalList: () => mem.listJournal(),
  journal: (a: { body: string; day: string }) => mem.readJournal(a.body, a.day),
  notes: () => mem.listNotes(),
  note: (a: { name: string }) => mem.readNote(a.name),
  search: (a: { query: string }) => mem.search(a.query),
  syncSoul: async (_: unknown, actor: string) => { await soul.pull(); await soul.push(`${actor} 触发同步`); return soul.syncStatus(); },
  // 访问方式 sshMode：deploy（本机专属部署密钥，默认）/ custom（sshKeyPath 指定的私钥）/ system（~/.ssh/config 与 ssh-agent）
  soulConfig: () => ({ remote: config.soul.remote, branch: config.soul.branch, sshMode: config.soul.sshMode, sshKeyPath: config.soul.sshKeyPath, body: config.body, status: soul.syncStatus() }),
  setSoulConfig: async (a: { remote?: string; branch?: string; sshMode?: "deploy" | "custom" | "system"; sshKeyPath?: string }, actor: string) => {
    const bad = a.remote ? checkRemote(a.remote) : undefined; // 规范 §7：只允许 SSH 地址
    if (bad) throw new Error(bad);
    if (a.sshMode && !["deploy", "custom", "system"].includes(a.sshMode)) throw new Error("sshMode 只能是 deploy、custom 或 system");
    if (a.sshMode === "custom" && !(a.sshKeyPath ?? config.soul.sshKeyPath).trim()) throw new Error("指定私钥时要填私钥路径");
    if (a.sshKeyPath) { const bad = checkKeyPath(soul.sshKeyFor({ sshMode: "custom", sshKeyPath: a.sshKeyPath })!); if (bad) throw new Error(bad); }
    saveConfig({ soul: a }); audit(actor, "soul.config", "", { ...a }, "ok");
    if (config.soul.sshMode === "deploy") await ensureSoulKey(); // 先点「接入」后点「显示公钥」也行：部署密钥不在就先生成
    await soul.ensureSoul(); await soul.pull(); await soul.push("接入灵魂仓库");
    return soul.syncStatus();
  },
  /** 生成（或读取）本机访问灵魂仓库用的 SSH 部署密钥，返回公钥，贴到 Git 托管平台的 Deploy keys（勾选写权限）即可。 */
  soulKey: () => ensureSoulKey(),

  providers: () => ({ config: publicView(), version: configVersion() }),
  saveProviders: (a: { config: ProviderConfig; expected: string }, actor: string) => ({ config: saveProviders(a.config, a.expected, actor), version: configVersion() }),
  catalog: () => getCatalog(),
  refreshCatalog: async () => ({ fetchedAt: Date.now(), providers: await refreshCatalog() }),
  testModel: (a: { providerId: string; model: string }) => testModel(a.providerId, a.model),
  remoteModels: (a: { providerId: string }) => remoteModels(a.providerId),
  "providers.quick": async (a: { catalogId: string; key: string }, actor: string) => { const r = await quickSetup(a, actor); audit(actor, "providers.quick", "", { catalogId: a.catalogId }, r.ok ? `ok ${r.models.join(",")}` : r.message); return r; },
  /** 飞书卡片用的快捷操作：在全局顺序中移动一个模型 / 启停一个模型 */
  moveModel: (a: { modelId: string; delta: number }, actor: string) => {
    const c = structuredClone(loadProviders());
    const all = c.providers.flatMap((p) => p.models).sort((x, y) => x.sortOrder - y.sortOrder);
    const i = all.findIndex((m) => m.id === a.modelId), j = i + a.delta;
    if (i < 0 || j < 0 || j >= all.length) return false;
    [all[i].sortOrder, all[j].sortOrder] = [all[j].sortOrder, all[i].sortOrder];
    saveProviders(c, configVersion(), actor); return true;
  },
  toggleModel: (a: { modelId: string }, actor: string) => {
    const c = structuredClone(loadProviders());
    const m = c.providers.flatMap((p) => p.models).find((x) => x.id === a.modelId);
    if (!m) return false;
    m.enabled = !m.enabled; saveProviders(c, configVersion(), actor); return m.enabled;
  },

  agent: () => identity(),
  setAgent: async (a: Partial<AgentIdentity>, actor: string) => {
    const r = await mem.exclusive(() => setIdentity(a));
    audit(actor, "agent.edit", "外部修改", a, "ok");
    mem.writeJournal("我的身份资料被修改了", `${actor} 修改了：${Object.keys(a).join("、")}`);
    await soul.push("修改身份资料");
    return r;
  },
  bodies: () => {
    const dir = `${paths.soul}/bodies`;
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => { try { return JSON.parse(fs.readFileSync(`${dir}/${f}`, "utf8")); } catch { return { body: f.slice(0, -5) }; } });
  },
  soulHistory: (a: { limit?: number }) => soul.history(a.limit ?? 50),
  soulShow: (a: { hash: string }) => soul.show(a.hash),
  soulRevert: async (a: { hash: string }, actor: string) => {
    await soul.revert(a.hash);
    audit(actor, "soul.revert", "", a, "ok");
    mem.writeJournal("有人撤销了一段记忆变更", `${actor} 撤销了提交 ${a.hash.slice(0, 7)}`);
    return true;
  },

  config: () => ({ body: config.body, timezone: config.timezone, heart: config.heart, brain: config.brain, feishu: { ...config.feishu, hasSecret: fs.existsSync(`${paths.secrets}/feishu_secret`) } }),
  setConfig: (a: { timezone?: string; brain?: Partial<typeof config.brain>; heart?: Partial<typeof config.heart> }, actor: string) => { saveConfig(a); audit(actor, "config", "", a, "ok"); return true; },
  restart: (_: unknown, actor: string) => { audit(actor, "restart", "", null, "ok"); setTimeout(() => process.exit(0), 300); return true; }, // 由进程守护者（runit/systemd）重新拉起
  // 退出：停掉后台服务、不再拉起（这一次；开机自启照旧）。由适配器实现（Linux：systemd stop / 守护循环的 quit 标记）；没有的直接结束进程
  quit: (_: unknown, actor: string) => { audit(actor, "quit", "", null, "ok"); setTimeout(() => { if (adapter.quit) adapter.quit().catch(() => process.exit(0)); else process.exit(0); }, 300); return true; },
  // 守护开关（开机自启 + 退出后自动重启）：由身体适配器实现；没有的身体返回 available=false，控制台不显示
  supervision: async () => adapter.supervision ? adapter.supervision.status() : { available: false, enabled: false, kind: "none", detail: "" },
  // 从控制台升级这具身体上的运行基座与控制台：由适配器在后台重跑安装（Linux）；安卓由 App 自己升级，这里不提供
  // version：要升到的版本（控制台看到的最新发布）；不给时装 npm 上的 latest
  selfUpdate: async (a: { version?: string } | undefined, actor: string) => {
    if (!adapter.upgrade) throw new Error("这具身体不支持从控制台升级：安卓请在 App 里更新；其他机器在装它的机器上重跑安装命令");
    const version = typeof a?.version === "string" && a.version ? a.version : undefined;
    const message = await adapter.upgrade(version);
    audit(actor, "selfUpdate", "", { version: version ?? "latest" }, "ok");
    return { started: true, message, status: adapter.upgradeStatus?.() ?? null };
  },
  selfUpdateStatus: () => adapter.upgradeStatus?.() ?? { running: false },
  setSupervision: async (a: { enabled: boolean }, actor: string) => {
    if (!adapter.supervision) throw new Error("这具身体没有可控制的守护者");
    await adapter.supervision.set(a.enabled !== false);
    audit(actor, "supervision", "", a, "ok");
    return adapter.supervision.status();
  },
};

/** 本机访问灵魂仓库的部署密钥：没有就生成（ed25519，无口令），返回公钥。 */
async function ensureSoulKey(): Promise<string> {
  return ensureSshKeyFile(path.join(paths.secrets, "soul_ed25519"), `quetzal@${config.body}`); // Node 内置 crypto 生成，不依赖 ssh-keygen
}

/** 一个链接接入：绑定时带上部署公钥；批准时同步服务经 GitHub 链接好灵魂仓库后，这里采用它（与人在「高级 · 同步」页里接入相同）。
 *  由 main.ts 在启动时登记（ops 与 mesh 互相引用，模块求值时登记会碰到未初始化的变量）。 */
export const soulLink = {
  key: () => ensureSoulKey(),
  adopt: async (remote: string) => { await ops.setSoulConfig({ remote, sshMode: "deploy" }, "mesh"); },
};

export type OpName = keyof typeof ops;
export async function invoke(name: string, args: any, actor: string) {
  const f = (ops as any)[name];
  if (!f) throw new Error(`未知操作：${name}`);
  const r = await f(args ?? {}, actor);
  bus.emit("state");
  return r;
}
