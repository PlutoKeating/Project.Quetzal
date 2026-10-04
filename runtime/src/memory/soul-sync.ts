// 运行基座一侧的灵魂同步：把 SoulRepo 协议绑定到运行时配置。
// 同步由事件触发：醒来前拉取；醒来、做梦、对话、身份修改后提交并推送。没有定时同步。
import { config, paths } from "../config.ts";
import path from "node:path";
import { log } from "../log.ts";
import { seedSoul } from "./memory.ts";
import { identity, defaultIdentity } from "./identity.ts";
import { SoulRepo, type PullResult } from "./soul-repo.ts";
import { addTimeline } from "../store.ts";
import { bus } from "../bus.ts";
import { mergeEntries } from "./entries.ts";
import { VERSION } from "../version.ts";
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
      bodyInfo: () => ({ kind: "runtime", runtime: VERSION }),
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

export const syncStatus = () => ({ ...r().status, remote: config.soul.remote, branch: config.soul.branch, sshMode: config.soul.sshMode, sshKeyPath: config.soul.sshKeyPath });

/** 接入灵魂仓库：克隆或初始化，并按规范补齐目录结构（见 docs/SOUL_REPO_SPEC.md）。 */
export async function ensureSoul() {
  await r().ensure();
}

// 多个会话、醒来可能同时触发 git 操作：全部排队串行执行，避免索引锁冲突
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(f: () => Promise<T>): Promise<T> { const p = queue.then(f); queue = p.catch(() => {}); return p; }

/** 拉取；有新内容时作为「灵魂同步」知觉告知 agent（写入时间线与感官事件），无需 agent 做任何事。 */
export const pull = () => serial(async () => {
  const res = await r().pull();
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
export const push = (msg: string) => serial(() => r().push(msg));
export const acquireLease = () => serial(() => r().acquireLease());
export const releaseLease = () => serial(() => r().releaseLease());
export const history = (limit = 50) => r().history(limit);
export const show = (hash: string) => r().show(hash);
export const revert = (hash: string) => serial(() => r().revert(hash));
