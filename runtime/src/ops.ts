// 操作层：控制台网关与飞书卡片共用的一套操作。任何控制入口都只调用这里，保证行为一致、都有审计。
import path from "node:path";
import { ensureSshKeyFile } from "./ssh-key.ts";
import fs from "node:fs";
import { config, saveConfig, paths, type Level } from "./config.ts";
import { getToolCall, type ToolCallRow, audit, listTimeline, listAudit, usageToday, recentMessages, listSessions, ensureSession, updateSession, sessionMessages, sessionMessagesFrom, addMessage, getSession, setSessionPinned, setSessionProject, type SessionInfo, type SessionQuery } from "./store.ts";
import * as projects from "./mind/projects.ts";
import { searchSessions } from "./mind/session-search.ts";
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
import { listSecrets, deleteSecret, setSecretSync, pendingSecrets, endCapture } from "./mind/secrets.ts";
import { listCustomTools, listSkills, readTool, readSkill, deleteTool, setToolEnabled } from "./mind/custom-tools.ts";
import * as hearing from "./voice/hearing.ts";
import * as player from "./voice/player.ts";
import * as meshRt from "./mesh/runtime.ts";
import * as acct from "./mesh/account.ts";
import { remoteApprovals, decideAnywhere } from "./mesh/shared.ts";
import { sandboxStatus, resetSandbox } from "./sandbox.ts";
import { checkKeyPath } from "./memory/soul-repo.ts";
import * as reminders from "./time/reminders.ts";
import * as goals from "./mind/goals.ts";
import { hostModes, enterHost, exitHost } from "./host-mode.ts";
import { readStructuredRecords, archiveRecord, rollbackRecord } from './memory/structured.ts';
import { confirmPersonalMemory, evolveMemory, learnEpisode } from './memory/prime.ts';
import type { MemoryEpisode } from '../../engine/src/prime.ts';
import { memoryKey } from '../../engine/src/memory.ts';
import { kv } from './store.ts';
import * as ws from './mind/workspace.ts';
import { sentinelView, setSentinel } from './guard/sentinel.ts';
import { canvasOps } from './mind/canvas-ops.ts';
import { pluginOps } from './plugins/ops.ts';
import { listSources } from './mcp/runtime.ts';
import { pendingRecommendations } from './plugins/index.ts';

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
  goals: goals.view(), // 她进行中的长期目标（首页显示：步骤与进度，可关闭）
  host: hostModes(), // 此刻处在真实环境里（命令不经沙箱）的会话：控制台据此显示警示条
  plugins: pluginSummary(), // 插件：她推荐、等对方安装的个数，要登录或出错的 MCP 来源个数（控制台「插件」菜单上的角标）
});

const pluginSummary = () => {
  const { sources } = listSources();
  return { recommended: pendingRecommendations(), auth: sources.filter((s) => s.state === "auth").length, error: sources.filter((s) => s.state === "error").length, online: sources.filter((s) => s.state === "online").length };
};

/** 控制台看到的提醒：下一次的说法、是否重复、内容。 */
const reminderView = () => reminders.active().slice(0, 20).map((r) => ({ id: r.id, text: r.text, at: r.at, when: r.span ? reminders.describe({ ...r, cron: undefined }) : reminders.when(r.at, r.tz), repeat: r.cron ? reminders.cronText(r.cron) : "" }));

// ---------- 会话列表（#30）
type SessionsArgs = { archived?: boolean; channel?: string; live?: boolean; pinned?: boolean; project?: string; from?: number; to?: number; sort?: string; limit?: number };
/** 控制台给的筛选：只收认得的键与类型。 */
function sessionQuery(a: SessionsArgs): SessionQuery {
  const q: SessionQuery = { archived: a.archived === true };
  if (typeof a.channel === "string" && a.channel.trim()) q.channel = a.channel.trim().slice(0, 100);
  if (a.pinned === true) q.pinned = true;
  if (typeof a.project === "string" && a.project) { q.project = a.project === "none" ? "none" : a.project; q.projects = projects.liveIds(); }
  if (a.live === true) q.only = [...new Set(liveTurns().map((t) => t.conv).filter(Boolean))];
  if (Number.isFinite(a.from)) q.from = Number(a.from);
  if (Number.isFinite(a.to)) q.to = Number(a.to);
  if (a.sort === "created" || a.sort === "title" || a.sort === "updated") q.sort = a.sort;
  if (Number.isFinite(a.limit)) q.limit = Number(a.limit);
  return q;
}
/** 归属已删除（或还没同步到）的项目的会话，对外一律当作不属于项目。 */
const liveProject = (s: SessionInfo): SessionInfo => {
  const { pin_changed: _p, project_changed: _c, ...rest } = s;
  return { ...rest, project: s.project && projects.get(s.project) ? s.project : null };
};
function projectOf(ref: string) {
  const p = projects.find(String(ref));
  if (!p) throw new Error("没有这个项目");
  return p;
}
const pick = <T extends object>(o: T, keys: string[]) => Object.fromEntries(Object.entries(o).filter(([k]) => keys.includes(k))) as Partial<T>;

export const ops = {
  ...canvasOps, // Canvas：对话旁边的编辑区（文档 / 代码、版本、运行、评论），见 mind/canvas-ops.ts
  ...pluginOps, // 插件与 MCP 来源（plugins/ops.ts）
  // 提醒：控制台只看与取消；设提醒是对她说（reminder 工具）
  reminders: () => reminderView(),
  "reminders.cancel": (a: { id: string }, actor: string) => { const r = reminders.cancel(String(a?.id ?? "")); audit(actor, "reminders.cancel", "", { id: r.id }, "ok"); return reminderView(); },
  // 长期目标：控制台看（closed 为真时连同 30 天内关闭的）与关闭（替她放下或标为完成）；新建与推进是她的事（goal 工具）
  goals: (a: { closed?: boolean }) => goals.view(a?.closed === true),
  "goals.close": (a: { id: string; outcome?: string; note?: string }, actor: string) => {
    const g = goals.close({ id: String(a?.id ?? ""), outcome: a?.outcome === "dropped" ? "dropped" : "done", note: typeof a?.note === "string" ? a.note : `${actor}关闭的` });
    audit(actor, "goals.close", "", { id: g.id, outcome: g.status }, "ok");
    return goals.view();
  },
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
  audit: (a: { limit?: number; action?: string }) => listAudit(a?.limit ?? 100, typeof a?.action === "string" && a.action ? { action: a.action } : {}), // action：只看某个动作，例如 sentinel.review（审核结论）

  // 会话：多个会话可同时进行；归档的会话可以找回；进行中的轮次可随时取回快照（断线、切到后台后恢复界面）
  // 列表的筛选与排序（#30）：置顶的总在最前；channel / live / pinned / project / from / to / sort 都可不给（旧控制台只给 archived）
  sessions: (a: SessionsArgs) => listSessions(sessionQuery(a ?? {})).map(liveProject),
  "sessions.create": (a: { title?: string; project?: string }, actor: string) => {
    const project = a?.project ? projectOf(a.project) : undefined;
    const s = ensureSession(crypto.randomUUID(), a?.title?.trim() || "新的对话");
    if (project) { setSessionProject(s.id, project.id); audit(actor, "sessions.move", "", { id: s.id, project: project.id }, "ok"); }
    return liveProject(getSession(s.id)!);
  },
  "sessions.rename": (a: { id: string; title: string }) => updateSession(a.id, { title: a.title }),
  "sessions.archive": (a: { id: string; archived: boolean }) => updateSession(a.id, { archived: a.archived !== false }),
  "sessions.pin": (a: { id: string; pinned?: boolean }, actor: string) => {
    const s = setSessionPinned(String(a?.id ?? ""), a?.pinned !== false);
    if (!s) throw new Error("没有这个会话");
    audit(actor, "sessions.pin", "", { id: s.id, pinned: s.pinned > 0 }, "ok");
    return liveProject(s);
  },
  "sessions.move": (a: { id: string; project?: string | null }, actor: string) => {
    const project = a?.project ? projectOf(a.project) : undefined;
    const s = setSessionProject(String(a?.id ?? ""), project?.id ?? null);
    if (!s) throw new Error("没有这个会话");
    audit(actor, "sessions.move", "", { id: s.id, project: project?.id ?? null }, "ok");
    return liveProject(s);
  },
  // 按标题与内容搜索（内容用记忆检索的全文索引），每个会话一条最好的命中，带片段与高亮位置
  "sessions.search": (a: { query: string; limit?: number }) => searchSessions(String(a?.query ?? ""), { limit: Number(a?.limit) || undefined }).map((h) => ({ ...h, session: liveProject(h.session) })),
  // from：从这条消息起（前面带几条）到最新，搜索结果点开时定位用
  "sessions.messages": (a: { id: string; limit?: number; before?: number; from?: number }) => Number.isSafeInteger(a.from) ? sessionMessagesFrom(a.id, a.from!) : sessionMessages(a.id, a.limit ?? 60, a.before),
  // 项目（#30）：项目级说明注入这个项目下所有会话的系统提示；删除不删会话，只解除归属
  projects: (a: { archived?: boolean }) => projects.list(a?.archived === undefined ? {} : { archived: a.archived === true }),
  "projects.create": (a: projects.ProjectPatch & { name: string }, actor: string) => { const p = projects.create(a ?? { name: "" }); audit(actor, "projects.create", "", { id: p.id, name: p.name }, "ok"); return p; },
  "projects.update": (a: projects.ProjectPatch & { id: string }, actor: string) => {
    const { id, ...patch } = a ?? { id: "" };
    const p = projects.update(String(id), pick(patch, ["name", "description", "instructions", "color", "icon", "archived"]));
    audit(actor, "projects.update", "", { id: p.id, fields: Object.keys(patch) }, "ok");
    return p;
  },
  "projects.delete": (a: { id: string }, actor: string) => { const n = projects.remove(String(a?.id ?? "")); audit(actor, "projects.delete", "", { id: a.id }, `解除了 ${n} 个会话的归属`); return { sessions: n }; },
  "sessions.live": () => liveTurns(),
  // 工作区：会话在哪具身体的哪个目录里做（mind/workspace.ts）；她通常由基座自动登记，对方也可以在控制台设定或清除
  workspace: (a: { conv: string }) => ws.workspaceView(String(a?.conv ?? "")),
  "workspace.set": async (a: { conv: string; body?: string; dir: string }, actor: string) => { const w = await ws.setByUser(String(a?.conv ?? ""), a?.body ? String(a.body) : undefined, String(a?.dir ?? "")); audit(actor, "workspace.set", "", { conv: a.conv, body: w.body, dir: w.dir }, "ok"); return ws.workspaceView(w.key); },
  "workspace.clear": (a: { conv: string }, actor: string) => { const ok = ws.clearWorkspace(String(a?.conv ?? "")); audit(actor, "workspace.clear", "", { conv: a?.conv }, ok ? "ok" : "none"); return ws.workspaceView(String(a?.conv ?? "")); },

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
  "secrets.sync": (a: { name: string; sync: boolean }, actor: string) => { const ok = setSecretSync(String(a.name), a.sync === true); audit(actor, "secrets.sync", "", a, ok ? "ok" : "没有这一项"); return ok; },
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
  // 独立审核模型（guard/sentinel.ts）：开关、模型、送审类别、失败策略、真实环境的请求交给谁；全网共用
  sentinel: () => sentinelView(),
  setSentinel: (a: Record<string, unknown>, actor: string) => setSentinel(a as never, actor),
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
  // 一张工具卡片的完整记录（完整参数与完整结果）：只存在做那一轮的身体上。本机没有，就问连着的其他身体（谁做的谁有）
  "tool.detail": async (a: { call: string }) => {
    const call = String(a?.call ?? "");
    if (!call || call.length > 200) return null;
    const here = getToolCall(call);
    if (here) return { ...here, body: config.body };
    const m = meshRt.mesh;
    for (const b of m?.connected() ?? []) {
      const r = await m!.request<ToolCallRow | null>(b, "tool.detail", { call }, 15_000).catch(() => null);
      if (r && typeof r === "object") return { ...r, body: b };
    }
    return null;
  },
  approvals: () => [...guard.approvals(), ...remoteApprovals()], // 含其他身体上等待批准的（带 body）
  decide: (a: { id: string; approve: boolean; note?: string; body?: string }, actor: string) => decideAnywhere(a.id, a.approve, actor, a.note, typeof a.body === "string" && a.body ? a.body : undefined), // 其他身体上的审批转过去；body 指明是哪具身体上的（审批号可能重复）
  budget: () => ({ ...config.budget, usage: usageToday() }),
  setBudget: (a: Partial<typeof config.budget>, actor: string) => { saveConfig({ budget: a }); audit(actor, "budget", "", a, "ok"); return config.budget; },

  memory: () => ({ soul: mem.soul(), memory: mem.entries("memory"), user: mem.entries("user"), loops: mem.openLoops() }),
  'memory.records': (a: { state?: string; kind?: string }) => readStructuredRecords().filter((r) => r.scope.agentId === identity().id && (!a.state || r.state === a.state) && (!a.kind || r.kind === a.kind)),
  'memory.confirm': async (a: { key: string }, actor: string) => {
    if (!actor?.trim()) throw new Error('管理者身份不能为空');
    const record = await confirmPersonalMemory(a.key, { actor });
    audit(actor, 'memory.confirm', '确认个人语义', { key: a.key }, memoryKey(record)); return record;
  },
  'memory.feedback': async (a: { episodeId: string; status: 'success' | 'failure'; session?: string }, actor: string) => {
    if (!actor?.trim()) throw new Error('管理者身份不能为空');
    if (!a || !['success', 'failure'].includes(a.status) || typeof a.episodeId !== 'string') throw new Error('反馈必须指定已完成轨迹及整体任务成功或失败');
    if (fs.existsSync(paths.stop)) throw new Error('急停中，不启动记忆评价');
    const episode = kv.get<MemoryEpisode[]>('prime.episodes', []).find((e) => e.id === a.episodeId && e.scope.agentId === identity().id);
    const origin = kv.get<Record<string, { session: string; ref?: string }>>('prime.origins', {})[a.episodeId];
    if (!episode || !origin?.session || (a.session !== undefined && a.session !== origin.session)) throw new Error('轨迹不存在、不属于当前Agent或会话来源无法核对');
    if (Date.now() < episode.endedAt) throw new Error('轨迹尚未完成，不能确认整体结果');
    const text = `管理者明确确认已完成轨迹 ${episode.id} 的整个任务${a.status === 'success' ? '成功' : '失败'}（不是仅确认单次工具调用）。`;
    const message = addMessage('user', actor, text, { session: origin.session });
    const result = await learnEpisode({ episodeId: episode.id, session: origin.session, scope: episode.scope,
      userInput: '', reply: '', feedback: { text, sourceRef: `message:${message}`, verified: true, status: a.status } },
      { maxTokens: config.brain.memoryLearningTokens, timeoutMs: config.brain.memoryLearningTimeoutMs });
    audit(actor, 'memory.feedback', '确认整体任务结果', { episodeId: episode.id, status: a.status, message }, result.status);
    return result;
  },
  'memory.archive': async (a: { key: string }, actor: string) => {
    if (!readStructuredRecords().some((r) => memoryKey(r) === a.key && r.scope.agentId === identity().id)) throw new Error('记忆不属于当前Agent');
    await archiveRecord(a.key); audit(actor, 'memory.archive', '', { key: a.key }, 'ok'); return true;
  },
  'memory.rollback': async (a: { key: string }, actor: string) => {
    if (!readStructuredRecords().some((r) => memoryKey(r) === a.key && r.scope.agentId === identity().id)) throw new Error('记忆不属于当前Agent');
    await rollbackRecord(a.key); audit(actor, 'memory.rollback', '', { key: a.key }, 'ok'); return true;
  },
  'memory.evolve': async (a: { operation: 'rewrite' | 'generalize' | 'combine'; keys: string[] }, actor: string) => {
    if (!Array.isArray(a.keys) || !a.keys.length || a.keys.length > 4 || a.keys.some((key) => !readStructuredRecords().some((r) => memoryKey(r) === key && r.scope.agentId === identity().id))) throw new Error('经验键不合法或不属于当前Agent');
    const result = await evolveMemory(a); audit(actor, 'memory.evolve', '', { operation: a.operation, keys: a.keys }, result.status); return result;
  },
  'context.status': (a: { conv: string }) => kv.get(`context.plan.${a.conv}`, null),
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
