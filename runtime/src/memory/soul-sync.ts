// 灵魂同步：soul/ 是一个 git 仓库（推荐 GitHub 私有仓库），同一个 agent 的所有身体都克隆它。
// 设计见 docs/SOUL_SYNC.md。要点：
//   - 事件驱动：醒来前拉取；醒来、做梦、对话、身份修改后提交并推送。没有定时同步。
//   - 身份守卫：agent.json 的 id 不同的仓库拒绝合并，防止两个 agent 的灵魂混在一起。
//   - 冲突：memories/*.md 条目级三方合并；SOUL.md 保留本地、对方另存 SOUL.incoming.md；
//           notes/ 保留本地、对方另存 <名>.incoming-<提交>.md；journal/<身体>/ 与 bodies/<身体>.json 天然无冲突。
//   - 整理租约：做梦（改写常驻记忆）前在 locks/consolidation.json 上取得租约，git push 被拒即表示别人先拿到了（比较并交换）。
import fs from "node:fs";
import path from "node:path";
import { config, paths } from "../config.ts";
import { run } from "../sh.ts";
import { log } from "../log.ts";
import { parseEntries, joinEntries, seedSoul } from "./memory.ts";
import { identity, defaultIdentity } from "./identity.ts";
import { VERSION } from "../version.ts";

const LEASE_MS = 30 * 60_000;
const soulPath = (...a: string[]) => path.join(paths.soul, ...a);
const git = (...args: string[]) => {
  const key = path.join(paths.secrets, "soul_ed25519");
  if (fs.existsSync(key)) process.env.GIT_SSH_COMMAND = `ssh -i ${key} -o StrictHostKeyChecking=accept-new -o IdentitiesOnly=yes`;
  return run("git", ["-C", paths.soul, ...args], 60_000);
};
const status = { lastPull: 0, lastPush: 0, lastError: "" };
export const syncStatus = () => ({ ...status, remote: config.soul.remote, branch: config.soul.branch });
const remoteRef = () => `origin/${config.soul.branch}`;

export async function ensureSoul() {
  if (fs.existsSync(soulPath(".git"))) return identityConfig();
  if (config.soul.remote) {
    fs.rmSync(paths.soul, { recursive: true, force: true });
    const r = await run("git", ["clone", "-b", config.soul.branch, config.soul.remote, paths.soul], 120_000);
    if (r.code === 0) { identity(); return identityConfig(); }
    log("soul", `克隆失败，改为本地初始化：${r.err}`);
    fs.mkdirSync(paths.soul, { recursive: true });
  }
  await run("git", ["init", "-b", config.soul.branch, paths.soul]);
  identity(); // 生成种子身份
  await identityConfig();
  if (!fs.existsSync(soulPath("SOUL.md"))) fs.writeFileSync(soulPath("SOUL.md"), seedSoul(identity().displayName));
  fs.mkdirSync(soulPath("memories"), { recursive: true });
  for (const f of ["MEMORY.md", "USER.md"]) if (!fs.existsSync(soulPath("memories", f))) fs.writeFileSync(soulPath("memories", f), "");
  await commit("初始化灵魂目录");
}

async function identityConfig() {
  await git("config", "user.name", `${identity().displayName} (${config.body})`);
  await git("config", "user.email", `${identity().name}@${config.body}.local`);
  await git("remote", "remove", "origin");
  if (config.soul.remote) await git("remote", "add", "origin", config.soul.remote);
}

/** 记录这具身体的状态（bodies/<身体>.json），让其他身体知道"我"还住在哪些地方。 */
function touchBody() {
  const f = soulPath("bodies", `${config.body}.json`);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ body: config.body, runtime: VERSION, lastSeen: new Date().toISOString() }, null, 2) + "\n");
}

async function commit(msg: string) {
  await git("add", "-A");
  return (await git("commit", "-m", `${msg}（${config.body}）`)).code === 0;
}

/** 条目级三方合并：双方新增的条目都保留，任何一方删除的条目删除。 */
export function mergeEntries(base: string, ours: string, theirs: string): string {
  const b = new Set(parseEntries(base)), o = parseEntries(ours), t = parseEntries(theirs);
  const oSet = new Set(o), tSet = new Set(t);
  const keep = (e: string) => !(b.has(e) && (!oSet.has(e) || !tSet.has(e)));
  const out: string[] = [];
  for (const e of [...o, ...t]) if (keep(e) && !out.includes(e)) out.push(e);
  return joinEntries(out);
}

/** 身份守卫：远端 agent.json 的 id 与本地不同则拒绝（本地仍是未被修改过的种子身份时，采用远端身份）。 */
async function guardIdentity(): Promise<boolean> {
  const r = await git("show", `${remoteRef()}:agent.json`);
  if (r.code !== 0) return true; // 远端还没有身份文件
  let theirs: { id?: string };
  try { theirs = JSON.parse(r.out); } catch { return true; }
  const mine = identity();
  if (!theirs.id || theirs.id === mine.id) return true;
  if (mine.seed) { fs.writeFileSync(soulPath("agent.json"), r.out); await commit("采用灵魂仓库中的身份"); return true; }
  status.lastError = `灵魂仓库属于另一个 agent（${theirs.id.slice(0, 8)}），与本机（${mine.id.slice(0, 8)}）不同，已拒绝同步`;
  log("soul", status.lastError);
  return false;
}

export async function pull(): Promise<boolean> {
  if (!config.soul.remote) return false;
  await identityConfig();
  const f = await git("fetch", "origin", config.soul.branch);
  if (f.code !== 0) { status.lastError = f.err.slice(0, 300); return false; }
  const behind = await git("rev-list", "--count", `HEAD..${remoteRef()}`);
  if (behind.code === 0 && behind.out.trim() === "0") { status.lastPull = Date.now(); status.lastError = ""; return false; }
  await commit("拉取前保存");
  if (!(await guardIdentity())) return false;
  const m = await git("merge", "--no-edit", "--allow-unrelated-histories", remoteRef());
  if (m.code !== 0) {
    const short = (await git("rev-parse", "--short", remoteRef())).out.trim();
    const conflicted = (await git("diff", "--name-only", "--diff-filter=U")).out.split("\n").filter(Boolean);
    for (const file of conflicted) {
      const show = async (stage: number) => (await git("show", `:${stage}:${file}`)).out;
      const abs = soulPath(file);
      const ours = await show(2), theirs = await show(3);
      if (file.startsWith("memories/")) fs.writeFileSync(abs, mergeEntries(await show(1), ours, theirs));
      else if (file === "SOUL.md") {
        const seed = seedSoul(identity().displayName).trim();
        if (!ours.trim() || ours.trim() === seed) fs.writeFileSync(abs, theirs); // 本地还只是种子人格：直接采用对方的
        else { fs.writeFileSync(abs, ours); fs.writeFileSync(soulPath("SOUL.incoming.md"), theirs); }
      } else if (file === "agent.json") {
        fs.writeFileSync(abs, JSON.stringify({ ...JSON.parse(theirs || "{}"), ...JSON.parse(ours || "{}") }, null, 2) + "\n");
      } else if (file.startsWith("notes/")) {
        fs.writeFileSync(abs, ours || theirs);
        if (ours && theirs) fs.writeFileSync(abs.replace(/\.md$/, `.incoming-${short}.md`), theirs);
      } else fs.writeFileSync(abs, ours || theirs); // 其他文件：保留本地
    }
    await commit("合并来自其他身体的记忆");
  }
  status.lastPull = Date.now(); status.lastError = "";
  log("soul", "已拉取其他身体的记忆");
  return true;
}

export async function push(msg: string) {
  touchBody();
  const changed = await commit(msg);
  if (!config.soul.remote) return;
  let r = await git("push", "origin", `HEAD:${config.soul.branch}`);
  if (r.code !== 0 && (await pull())) r = await git("push", "origin", `HEAD:${config.soul.branch}`);
  if (r.code !== 0) status.lastError = r.err.slice(0, 300);
  else if (changed) { status.lastPush = Date.now(); status.lastError = ""; }
}

// ---------- 整理租约
const leaseFile = () => soulPath("locks", "consolidation.json");
const readLease = (): { body: string; until: number } | undefined => { try { return JSON.parse(fs.readFileSync(leaseFile(), "utf8")); } catch { return undefined; } };

/** 取得整理记忆的租约。返回 false 表示另一具身体正在整理。 */
export async function acquireLease(): Promise<boolean> {
  if (!config.soul.remote) return true;
  for (let i = 0; i < 2; i++) {
    await pull();
    const cur = readLease();
    if (cur && cur.body !== config.body && cur.until > Date.now()) return false;
    fs.mkdirSync(path.dirname(leaseFile()), { recursive: true });
    fs.writeFileSync(leaseFile(), JSON.stringify({ body: config.body, until: Date.now() + LEASE_MS }) + "\n");
    await commit("取得整理记忆的租约");
    const r = await git("push", "origin", `HEAD:${config.soul.branch}`);
    if (r.code === 0) return true; // 推送成功即取得（远端在此期间没有别人写入）
  }
  return false;
}

export async function releaseLease() {
  const cur = readLease();
  if (cur?.body === config.body) fs.rmSync(leaseFile(), { force: true });
}

// ---------- 历史
export async function history(limit = 50) {
  const r = await git("log", `-${limit}`, "--pretty=format:%H%x1f%h%x1f%an%x1f%at%x1f%s", "--shortstat");
  const out: { hash: string; short: string; author: string; ts: number; subject: string; stat: string }[] = [];
  for (const block of r.out.split(/\n(?=[0-9a-f]{40}\x1f)/)) {
    const [head, stat = ""] = block.split("\n").filter(Boolean);
    if (!head) continue;
    const [hash, short, author, at, subject] = head.split("\x1f");
    out.push({ hash, short, author, ts: Number(at) * 1000, subject, stat: stat.trim() });
  }
  return out;
}

export async function show(hash: string) {
  if (!/^[0-9a-f]{7,40}$/.test(hash)) throw new Error("提交号无效");
  return (await git("show", "--stat", "--patch", "--no-color", hash)).out.slice(0, 20000);
}

/** 撤销一次提交（生成反向提交，历史保留），然后推送。 */
export async function revert(hash: string) {
  if (!/^[0-9a-f]{7,40}$/.test(hash)) throw new Error("提交号无效");
  const r = await git("revert", "--no-edit", hash);
  if (r.code !== 0) { await git("revert", "--abort"); throw new Error(`无法自动撤销：${r.err.slice(0, 200)}`); }
  await push(`撤销 ${hash.slice(0, 7)}`);
}

export { defaultIdentity };
