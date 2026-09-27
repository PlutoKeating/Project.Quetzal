// 灵魂同步：soul/ 是一个 git 仓库，所有身体（本机、运行 Hermes 的设备……）都克隆它。
// 同步由事件触发：每次醒来前拉取，每次醒来/做梦结束后提交并推送。没有定时同步。
// 冲突处理：
//   memories/*.md —— 条目级三方合并：双方新增的条目都保留，任何一方删除的条目删除；
//   SOUL.md       —— 保留本地版本，对方版本另存为 SOUL.incoming.md，由 Amani 在做梦时自己调和；
//   journal/      —— 每具身体各写各的目录，天然无冲突。
import fs from "node:fs";
import path from "node:path";
import { config, paths } from "../config.ts";
import { run } from "../sh.ts";
import { log } from "../log.ts";
import { parseEntries, joinEntries, SEED_SOUL } from "./memory.ts";

const git = (...args: string[]) => {
  const key = path.join(paths.secrets, "soul_ed25519");
  const env = fs.existsSync(key) ? `ssh -i ${key} -o StrictHostKeyChecking=accept-new` : "";
  if (env) process.env.GIT_SSH_COMMAND = env;
  return run("git", ["-C", paths.soul, ...args], 60_000);
};
let status = { lastPull: 0, lastPush: 0, lastError: "", remote: "" };
export const syncStatus = () => ({ ...status, remote: config.soul.remote });

export async function ensureSoul() {
  if (fs.existsSync(path.join(paths.soul, ".git"))) return identity();
  if (config.soul.remote) {
    fs.rmSync(paths.soul, { recursive: true, force: true });
    const r = await run("git", ["clone", "-b", config.soul.branch, config.soul.remote, paths.soul], 120_000);
    if (r.code === 0) return void (await identity());
    log("soul", `克隆失败，改为本地初始化：${r.err}`);
    fs.mkdirSync(paths.soul, { recursive: true });
  }
  await run("git", ["init", "-b", config.soul.branch, paths.soul]);
  await identity();
  if (!fs.existsSync(path.join(paths.soul, "SOUL.md"))) fs.writeFileSync(path.join(paths.soul, "SOUL.md"), SEED_SOUL);
  fs.mkdirSync(path.join(paths.soul, "memories"), { recursive: true });
  for (const f of ["MEMORY.md", "USER.md"]) if (!fs.existsSync(path.join(paths.soul, "memories", f))) fs.writeFileSync(path.join(paths.soul, "memories", f), "");
  await commit("初始化灵魂目录");
}

async function identity() {
  await git("config", "user.name", `Amani (${config.body})`);
  await git("config", "user.email", `amani@${config.body}.local`);
  if (config.soul.remote) { await git("remote", "remove", "origin"); await git("remote", "add", "origin", config.soul.remote); }
}

async function commit(msg: string) {
  await git("add", "-A");
  const r = await git("commit", "-m", `${msg}（${config.body}）`);
  return r.code === 0;
}

/** 条目级三方合并。 */
export function mergeEntries(base: string, ours: string, theirs: string): string {
  const b = new Set(parseEntries(base)), o = parseEntries(ours), t = parseEntries(theirs);
  const oSet = new Set(o), tSet = new Set(t);
  const keep = (e: string) => !(b.has(e) && (!oSet.has(e) || !tSet.has(e))); // 任一方删除 → 删除
  const out: string[] = [];
  for (const e of [...o, ...t]) if (keep(e) && !out.includes(e)) out.push(e);
  return joinEntries(out);
}

export async function pull(): Promise<boolean> {
  if (!config.soul.remote) return false;
  await identity();
  const f = await git("fetch", "origin", config.soul.branch);
  if (f.code !== 0) { status.lastError = f.err.slice(0, 300); return false; }
  const behind = await git("rev-list", "--count", `HEAD..origin/${config.soul.branch}`);
  if (behind.code === 0 && behind.out.trim() === "0") { status.lastPull = Date.now(); return false; }
  await commit("醒来前保存");
  const m = await git("merge", "--no-edit", "--allow-unrelated-histories", `origin/${config.soul.branch}`);
  if (m.code !== 0) {
    const conflicted = (await git("diff", "--name-only", "--diff-filter=U")).out.split("\n").filter(Boolean);
    for (const file of conflicted) {
      const show = async (stage: number) => (await git("show", `:${stage}:${file}`)).out;
      const abs = path.join(paths.soul, file);
      if (file.startsWith("memories/")) fs.writeFileSync(abs, mergeEntries(await show(1), await show(2), await show(3)));
      else if (file === "SOUL.md") {
        const ours = await show(2), theirs = await show(3);
        if (ours.trim() === SEED_SOUL.trim()) fs.writeFileSync(abs, theirs); // 本地还只是种子人格：直接采用对方的
        else { fs.writeFileSync(abs, ours); fs.writeFileSync(path.join(paths.soul, "SOUL.incoming.md"), theirs); }
      }
      else fs.writeFileSync(abs, await show(2)); // 其他文件：保留本地
    }
    await commit("合并来自其他身体的记忆");
  }
  status.lastPull = Date.now();
  log("soul", "已拉取其他身体的记忆");
  return true;
}

export async function push(msg: string) {
  const changed = await commit(msg);
  if (!config.soul.remote) return;
  const r = await git("push", "origin", `HEAD:${config.soul.branch}`);
  if (r.code !== 0) {
    status.lastError = r.err.slice(0, 300);
    if (await pull()) await git("push", "origin", `HEAD:${config.soul.branch}`);
  } else if (changed) status.lastPush = Date.now();
}
