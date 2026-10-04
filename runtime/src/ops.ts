// 操作层：控制台网关与飞书卡片共用的一套操作。任何控制入口都只调用这里，保证行为一致、都有审计。
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

export const status = () => ({
  agent: identity(), version: VERSION, body: config.body, adapter: adapter.name, heart: heart.snapshot(), physical: body,
  stopped: heart.stopped(), paused: config.heart.paused, activity: config.heart.activity,
  usage: usageToday(), budget: config.budget, approvals: guard.approvals(), soul: soul.syncStatus(),
  models: routes().map((r) => `${r.provider.name}/${r.model.name}`),
  thought: mem.thought(), // 她想分享的一句话（首页展示）
  hearing: hearing.hearingStatus(), // 听觉：App 据 listening 决定要不要开麦克风
});

export const ops = {
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
  setSpeech: (a: Partial<voice.SpeechConfig> & { key?: string }, actor: string) => { audit(actor, "speech", "", { ...a, key: a.key ? "****" : undefined }, "ok"); return voice.setSpeech(a); },
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
  stop: (a: { reason?: string }, actor: string) => { guard.emergencyStop(actor, a.reason); return true; },
  unstop: (_: unknown, actor: string) => { guard.releaseStop(actor); heart.nudge("解除急停"); return true; },
  personality: (a: { changes: Record<string, number> }, actor: string) => { audit(actor, "personality", "", a, "ok"); return heart.adjustPersonality(a.changes); },

  permissions: () => Object.entries(guard.PERMISSION_LABELS).map(([id, label]) => ({ id, label, level: guard.level(id) })),
  setPermission: (a: { id: string; level: Level }, actor: string) => { guard.setLevel(a.id, a.level, actor); return true; },
  approvals: () => guard.approvals(),
  decide: (a: { id: string; approve: boolean; note?: string }, actor: string) => guard.decide(a.id, a.approve, actor, a.note),
  budget: () => ({ ...config.budget, usage: usageToday() }),
  setBudget: (a: Partial<typeof config.budget>, actor: string) => { saveConfig({ budget: a }); audit(actor, "budget", "", a, "ok"); return config.budget; },

  memory: () => ({ soul: mem.soul(), memory: mem.entries("memory"), user: mem.entries("user"), loops: mem.openLoops() }),
  editMemory: (a: { target: mem.Target; action: "add" | "replace" | "remove"; content?: string; oldText?: string }, actor: string) => {
    const r = mem.editMemory(a.target, a.action, a.content, a.oldText);
    audit(actor, "memory.edit", "外部修改", a, r);
    mem.writeJournal("有人改了我的记忆", `${actor} 对 ${a.target} 做了 ${a.action}：${a.content ?? a.oldText ?? ""}`);
    return r;
  },
  setSoul: (a: { text: string }, actor: string) => { mem.setSoul(a.text); audit(actor, "soul.edit", "外部修改", null, "ok"); mem.writeJournal("有人改了我的人格文件", `${actor} 修改了 SOUL.md`); return true; },
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
    const r = setIdentity(a);
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
  // 守护开关（开机自启 + 退出后自动重启）：由身体适配器实现；没有的身体返回 available=false，控制台不显示
  supervision: async () => adapter.supervision ? adapter.supervision.status() : { available: false, enabled: false, kind: "none", detail: "" },
  setSupervision: async (a: { enabled: boolean }, actor: string) => {
    if (!adapter.supervision) throw new Error("这具身体没有可控制的守护者");
    await adapter.supervision.set(a.enabled !== false);
    audit(actor, "supervision", "", a, "ok");
    return adapter.supervision.status();
  },
};

/** 本机访问灵魂仓库的部署密钥：没有就生成（ed25519，无口令），返回公钥。 */
async function ensureSoulKey(): Promise<string> {
  const key = `${paths.secrets}/soul_ed25519`;
  if (!fs.existsSync(key)) await run("ssh-keygen", ["-t", "ed25519", "-N", "", "-C", `quetzal@${config.body}`, "-f", key]);
  return fs.readFileSync(`${key}.pub`, "utf8").trim();
}

export type OpName = keyof typeof ops;
export async function invoke(name: string, args: any, actor: string) {
  const f = (ops as any)[name];
  if (!f) throw new Error(`未知操作：${name}`);
  const r = await f(args ?? {}, actor);
  bus.emit("state");
  return r;
}
