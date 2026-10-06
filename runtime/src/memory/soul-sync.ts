// 运行基座一侧的灵魂同步：把 SoulRepo 协议绑定到运行时配置。
// 同步由事件触发，没有定时同步：
//   - 触碰即同步：她的每次工具调用之后看一眼灵魂目录（git status），有变化就立即提交，3 秒去抖后推送；一轮结束时立即推送。
//   - 推送失败：网络类静默退避重试，仍失败（或其他原因）就以插话提醒碰过记忆的那一轮（已结束则在原会话开新的一轮）。
//   - 拉取：醒来与对话前；合并时两边都改过的文本文件，落选的一版另存为副本，提醒最近改过它的会话裁决。
import { config, paths } from "../config.ts";
import path from "node:path";
import fs from "node:fs";
import { log } from "../log.ts";
import { seedSoul } from "./memory.ts";
import { identity, defaultIdentity } from "./identity.ts";
import { SoulRepo, type PullResult, type PushResult } from "./soul-repo.ts";
import { addTimeline } from "../store.ts";
import { bus } from "../bus.ts";
import { mergeEntries } from "./entries.ts";
import { VERSION } from "../version.ts";
import { nodeKey } from "../mesh/node-key.ts";
export { mergeEntries };

let repo: SoulRepo | undefined;
let key = "";
/** 按当前配置取得仓库对象（配置变化时重建）。 */
function r(): SoulRepo {
  const k = `${config.soul.remote}|${config.soul.branch}|${config.body}|${config.soul.sshMode}|${config.soul.sshKeyPath}`;
  if (!repo || k !== key) {
    const prev = repo?.status;
    repo = new SoulRepo({
      dir: paths.soul, remote: config.soul.remote, branch: config.soul.branch, body: config.body,
      sshKey: sshKeyFor(config.soul),
      statusFile: path.join(paths.state, "soul-status.json"), // 重启后「上次拉取 / 推送」不归零
      author: () => ({ name: `${identity().displayName} (${config.body})`, email: `${identity().name}@${config.body}.local` }),
      isSeedSoul: (t) => t.trim() === seedSoul(identity().displayName).trim(),
      seedIdentity: () => defaultIdentity(),
      seedSoul,
      bodyInfo: () => ({ kind: "runtime", runtime: VERSION, meshKey: nodeKey().nodeKey }), // meshKey：网状层的节点公钥（规范 v8），其他身体以它为准核对这具身体
      log: (m) => log("soul", m),
    });
    if (prev) repo.status = prev;
    key = k;
  }
  return repo;
}

/** 按配置决定访问远端的私钥：deploy = 本机专属部署私钥；custom = 使用者指定（支持 ~）；system = 不指定，交给 ~/.ssh/config 与 ssh-agent。 */
export function sshKeyFor(s: { sshMode?: string; sshKeyPath?: string }): string | undefined {
  if (s.sshMode === "system") return undefined;
  if (s.sshMode === "custom") { const p = (s.sshKeyPath ?? "").trim(); return p ? (p.startsWith("~/") ? path.join(process.env.HOME ?? "", p.slice(2)) : p) : undefined; }
  return path.join(paths.secrets, "soul_ed25519");
}

export const syncStatus = () => ({ ...r().status, remote: config.soul.remote, branch: config.soul.branch, sshMode: config.soul.sshMode, sshKeyPath: config.soul.sshKeyPath, unpushed: unpushed.length });

/** 接入灵魂仓库：克隆或初始化，并按规范补齐目录结构（见 docs/SOUL_REPO_SPEC.md）。 */
export async function ensureSoul() {
  await r().ensure();
}

// 多个会话、醒来可能同时触发 git 操作：全部排队串行执行，避免索引锁冲突
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(f: () => Promise<T>): Promise<T> { const p = queue.then(f); queue = p.catch(() => {}); return p; }

/** 拉取；有新内容时作为「灵魂同步」知觉告知 agent（写入时间线与感官事件）。两边都改过的文件另存了副本时，提醒最近改过它的会话。 */
let alertedForeign = "";
export const pull = () => serial(async () => {
  const res = await r().pull();
  // 灵魂仓库混进了别的历史：同步已停止，告诉她（只提醒一次），也写进心流
  const err = r().status.lastError;
  if (/混进了别的仓库|不是灵魂仓库/.test(err) && err !== alertedForeign) {
    alertedForeign = err;
    addTimeline("soul", "灵魂同步已停止：仓库里混进了别的历史", { error: err });
    bus.emit("soul.alert", { text: `${err}\n这不是你能自己修的事：不要在灵魂目录里运行 git。请告诉对方，由对方处理。`, targets: [] } satisfies SoulAlert);
  }
  const copies = res.resolved.filter((x) => x.incoming);
  if (copies.length) conflictAlert(copies, res.incoming.map((i) => i.body).filter((b) => b !== config.body));
  if (res.merged) {
    const bodies = [...new Set(res.incoming.map((i) => i.body).filter((b) => b !== config.body))];
    const text = `${bodies.length ? `来自 ${bodies.join("、")} 的 ${res.incoming.length} 次变更` : "合入了远端变更"}${res.resolved.length ? `；自动处理冲突 ${res.resolved.length} 处` : ""}`;
    log("soul", text);
    addTimeline("soul", `灵魂同步：${text}`, res);
    recent.unshift({ ts: Date.now(), ...res }); recent.splice(5);
    bus.emit("sense", "soul_synced", { bodies, count: res.incoming.length });
  }
  return res.merged;
});
/** 最近几次同步的摘要（进入系统提示的「知觉」段落）。 */
export const recent: ({ ts: number } & PullResult)[] = [];

// ---------- 触碰即同步

/** 碰了灵魂目录的那一次工具调用。session 是那一轮的会话对象（结构上只依赖这几个字段，避免记忆模块反向依赖大脑）。 */
export interface Toucher {
  tool: string;
  session?: { id: string; conv: string; origin: string; switchTo?: string; closed?: boolean };
}
interface Touch extends Toucher { files: string[]; ts: number }
/** 提醒：由大脑订阅 soul.alert 事件后插话或开新的一轮。 */
export interface SoulAlert { text: string; targets: Toucher["session"][] }

const PUSH_DEBOUNCE_MS = 3000;
const RETRY_MS = [5_000, 15_000, 30_000, 60_000, 120_000]; // 网络类失败的静默重试（约 4 分钟）
let unpushed: Touch[] = [];      // 已提交、还没推送成功的触碰
const lastTouch = new Map<string, Touch>(); // 文件 → 最近一次碰它的触碰（冲突时找该提醒谁）
let pushTimer: NodeJS.Timeout | undefined;
let attempt = 0;

const LABEL: [RegExp, (m: RegExpMatchArray) => string][] = [
  [/^memories\/MEMORY\.md$/, () => "常驻记忆"],
  [/^memories\/USER\.md$/, () => "关于对方的记忆"],
  [/^SOUL\.md$/, () => "人格"],
  [/^agent\.json$/, () => "身份"],
  [/^notes\/(.+)\.md$/, (m) => `笔记 ${m[1]}`],
  [/^skills\/([^/]+)\//, (m) => `技能 ${m[1]}`],
  [/^journal\//, () => "日记"],
  [/^bodies\//, () => "身体登记"],
];
export const describeFiles = (files: string[]) => {
  const names = [...new Set(files.map((f) => { for (const [re, fn] of LABEL) { const m = f.match(re); if (m) return fn(m); } return f; }))];
  return names.length > 3 ? `${names.slice(0, 3).join("、")} 等 ${names.length} 项` : names.join("、");
};

/** 每次工具调用之后调用：灵魂目录有变化就立即提交，并安排推送。返回变化的文件。 */
export const touched = (t: Toucher) => serial(async () => {
  const files = await r().changes().catch(() => [] as string[]);
  if (!files.length) return files;
  const touch: Touch = { ...t, files, ts: Date.now() };
  for (const f of files) lastTouch.set(f, touch); // 记下碰过它的会话：冲突副本的提醒发给那一轮
  await r().commit(`${t.tool}：${describeFiles(files)}`);
  if (lastTouch.size > 500) lastTouch.delete(lastTouch.keys().next().value!);
  unpushed.push(touch);
  schedulePush(PUSH_DEBOUNCE_MS);
  return files;
});

function schedulePush(ms: number) {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => { void push("同步").catch(() => {}); }, ms);
  pushTimer.unref?.();
}

/** 立即提交剩余变更并推送（一轮结束、身份修改、控制台操作时调用）。失败按类别静默重试或提醒。 */
export const push = (msg: string) => serial(async (): Promise<PushResult> => {
  clearTimeout(pushTimer); pushTimer = undefined;
  const res = await r().push(msg).catch((e: Error) => ({ ok: false, pushed: false, kind: "other", error: e.message }) as PushResult);
  if (res.ok) {
    attempt = 0;
    if (unpushed.length && res.pushed) bus.emit("soul.pushed", { files: unpushed.flatMap((t) => t.files) });
    unpushed = [];
    return res;
  }
  if (!unpushed.length) return res; // 没有她碰过的东西在等：控制台操作等自己显示 lastError
  if (res.kind === "network" && attempt < RETRY_MS.length) { schedulePush(RETRY_MS[attempt++]); return res; }
  const failed = unpushed; unpushed = []; attempt = 0; // 提醒过的不再重复提醒；变更仍在本地提交里，下一次推送会带上
  pushAlert(failed, res);
  return res;
});

const ADVICE: Record<string, string> = {
  network: `基座已经静默重试了 ${RETRY_MS.length} 次。网络恢复后，下一次推送会自动带上这些提交，你不需要重做。`,
  auth: "远端拒绝了这具身体的访问密钥：需要有人在灵魂仓库的 Deploy keys 里添加本机公钥（控制台「高级 · 同步」页可以看到），请告诉对方。",
  hostkey: "服务器的主机密钥与之前记录的不一致，基座拒绝了连接。这可能是服务器换了密钥，也可能是中间人攻击，请告诉对方核实。",
  notfound: "远端没有这个仓库，或者本机的密钥没有它的访问权。请告诉对方检查灵魂仓库地址与部署密钥。",
  identity: "远端的灵魂仓库属于另一个 agent，基座拒绝合并。请告诉对方检查灵魂仓库地址。",
  config: "灵魂仓库的配置有问题（地址或私钥）。请告诉对方到控制台「高级 · 同步」页检查。",
  rejected: "远端在推送期间又有了新的提交，合并后仍被拒绝。基座会在下一次改动时再试。",
  other: "基座会在下一次改动时再试。",
};

function pushAlert(touches: Touch[], res: PushResult) {
  const files = describeFiles(touches.flatMap((t) => t.files));
  const text = `灵魂仓库推送失败：${res.error || "原因不明"}\n你刚才改动的 ${files} 已经提交在这具身体上，但还没到达远端，其他身体暂时看不到。${ADVICE[res.kind ?? "other"]}`;
  log("soul", `推送失败（${res.kind}），提醒 ${touches.length} 次触碰所在的会话`);
  addTimeline("soul", `灵魂同步：推送失败（${files}）`, { kind: res.kind, error: res.error });
  bus.emit("soul.alert", { text, targets: [...new Map(touches.map((t) => [t.session?.id ?? "", t.session])).values()] } satisfies SoulAlert);
}

function conflictAlert(copies: PullResult["resolved"], bodies: string[]) {
  const from = [...new Set(bodies)].join("、") || "其他身体";
  const groups = new Map<string, PullResult["resolved"]>();
  for (const c of copies) { const s = lastTouch.get(c.file)?.session; const k = s?.id ?? ""; groups.set(k, [...(groups.get(k) ?? []), c]); }
  for (const [, list] of groups) {
    const session = lastTouch.get(list[0].file)?.session;
    const lines = list.map((c) => `- ${path.join(paths.soul, c.file)}：现在用的是${c.kept === "remote" ? `${from}的版本` : "你这边的版本"}；另一版在 ${path.join(paths.soul, c.incoming!)}`);
    const text = `灵魂同步时，下面的文件在你这里和${from}那边都被改过。基座先采用了提交时间较新的一版（仓库不会卡住），另一版另存为副本（副本不会同步到其他身体）：\n${lines.join("\n")}\n请看看两版：保留现在的，就删掉副本；想用另一版或把两者合并，就改好原文件再删掉副本。不处理也不影响同步，副本会一直留在系统提示里提醒你。`;
    addTimeline("soul", `灵魂同步：${list.length} 个文件两边都改过，另一版留待裁决`, { files: list.map((c) => c.file) });
    bus.emit("soul.alert", { text, targets: [session] } satisfies SoulAlert);
  }
}

/** 灵魂目录里还没裁决的冲突副本（相对路径），进入系统提示。 */
export function pendingCopies(): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(path.join(paths.soul, rel), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === ".git") continue;
      const r2 = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(r2); else if (/\.incoming[^/]*\.md$/.test(e.name)) out.push(r2);
    }
  };
  walk("");
  return out;
}

/** 测试用：等串行队列里的 git 操作全部完成。 */
export const idle = () => serial(async () => {});
export const acquireLease = () => serial(() => r().acquireLease());
export const releaseLease = () => serial(() => r().releaseLease());
export const history = (limit = 50) => r().history(limit);
export const show = (hash: string) => r().show(hash);
export const revert = (hash: string) => serial(() => r().revert(hash));
