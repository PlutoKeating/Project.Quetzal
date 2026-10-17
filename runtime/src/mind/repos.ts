// 身体的工作区概况（#37）：这具身体的沙箱工作目录（Linux 为用户主目录，Windows 与特殊 HOME 为工作区目录）下，深度不超过 2 的 git 仓库。
// 由基座直接读 .git 里的 HEAD 与 config 算出（不运行 git、不调用模型、不写记忆）：路径、远端地址（去掉凭据）、当前分支。
// 有上限（最多 MAX_REPOS 个仓库、每次最多看 MAX_ENTRIES 个目录项、SCAN_MS 的时限）并缓存 CACHE_MS；
// 本机的放进系统提示「身体」一节，其他身体的经网状层（mesh/workspace.ts 的 body.workspace）取回放进「其他身体」一节。
// 新会话因此知道之前在某具身体上克隆过哪些仓库，不必凭记忆去找。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { paths } from "../config.ts";
import { workDir } from "../sandbox.ts";

export const MAX_REPOS = 30;
const MAX_ENTRIES = 4000, SCAN_MS = 800, CACHE_MS = 60_000;
const SKIP = new Set(["node_modules", "Library", "AppData", "snap", "go", "venv", "__pycache__"]);

export interface Repo { path: string; remote?: string; branch?: string }
export interface Overview { root: string; repos: Repo[]; truncated?: boolean; at: number }

/** 远端地址里的凭据（https://user:token@host/…）去掉；scp 式（git@host:path）的用户名不是秘密，原样保留。 */
export function stripCredentials(url: string): string {
  const u = url.trim();
  const m = /^([a-z][a-z0-9+.-]*:\/\/)([^/@]*@)?(.*)$/i.exec(u);
  return (m ? m[1] + m[3] : u).replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 300);
}

const read = (f: string) => { try { return fs.readFileSync(f, "utf8"); } catch { return ""; } };

/** dir/.git（目录，或指向别处的 gitdir 文件）里的当前分支与 origin（没有 origin 就取第一个远端）的地址。不是仓库返回 undefined。 */
export function repoInfo(dir: string): Repo | undefined {
  const dotgit = path.join(dir, ".git");
  let st: fs.Stats;
  try { st = fs.statSync(dotgit); } catch { return undefined; }
  let gitdir = dotgit;
  if (st.isFile()) { const g = /^gitdir:\s*(.+)$/m.exec(read(dotgit))?.[1]?.trim(); if (!g) return undefined; gitdir = path.resolve(dir, g); }
  const head = read(path.join(gitdir, "HEAD")).trim();
  if (!head) return undefined;
  const common = read(path.join(gitdir, "commondir")).trim(); // 工作树：config 在主仓库的 git 目录里
  const cfg = read(path.join(common ? path.resolve(gitdir, common) : gitdir, "config"));
  const remotes = [...cfg.matchAll(/\[remote "([^"]+)"\]([^[]*)/g)].map((r) => ({ name: r[1], url: /^\s*url\s*=\s*(.+)$/m.exec(r[2])?.[1]?.trim() }));
  const url = (remotes.find((r) => r.name === "origin") ?? remotes[0])?.url;
  const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head)?.[1];
  return { path: dir, ...(url ? { remote: stripCredentials(url) } : {}), branch: ref ? ref.slice(0, 100) : `（分离的 HEAD ${head.slice(0, 8)}）` };
}

/** 不看的目录：隐藏目录、依赖与缓存目录、基座的家目录（灵魂仓库在里面，由基座管理，不是工作区）。 */
const skipped = (full: string, name: string) => name.startsWith(".") || SKIP.has(name) || full === paths.home || full === paths.soul;

/** 扫一遍（深度 ≤ 2）。root 本身是仓库也算。 */
export function scanRepos(root = workDir()): Overview {
  const t0 = Date.now(), repos: Repo[] = [];
  let entries = 0, truncated = false;
  const visit = (dir: string, depth: number) => {
    if (repos.length >= MAX_REPOS || truncated) return;
    const r = repoInfo(dir);
    if (r) { repos.push(r); return; } // 仓库里面不再往下找
    if (depth >= 2) return;
    let list: fs.Dirent[] = [];
    try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const d of list.sort((a, b) => a.name.localeCompare(b.name))) {
      if (++entries > MAX_ENTRIES || Date.now() - t0 > SCAN_MS) { truncated = true; return; }
      if (!d.isDirectory()) continue;
      const full = path.join(dir, d.name);
      if (skipped(full, d.name)) continue;
      visit(full, depth + 1);
      if (repos.length >= MAX_REPOS) { truncated = true; return; }
    }
  };
  visit(root, 0);
  return { root, repos, ...(truncated ? { truncated } : {}), at: Date.now() };
}

let cache: Overview | undefined;
/** 这具身体的概况（缓存 CACHE_MS）。fresh：不用缓存（她刚克隆了仓库、设了工作区时）。 */
export function localOverview(fresh = false): Overview {
  if (!fresh && cache && Date.now() - cache.at < CACHE_MS && cache.root === workDir()) return cache;
  return (cache = scanRepos());
}
export const forgetOverview = () => { cache = undefined; };

/** 别处发来的概况：逐项检查形状，路径与地址截断，最多 MAX_REPOS 个。 */
export function cleanOverview(v: unknown): Overview | undefined {
  const x = v as Partial<Overview> | null;
  if (!x || typeof x !== "object" || typeof x.root !== "string" || !Array.isArray(x.repos)) return undefined;
  const s = (t: unknown, n: number) => (typeof t === "string" ? t.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, n) : undefined);
  const repos = x.repos.slice(0, MAX_REPOS).flatMap((r) => {
    const p = s((r as Repo)?.path, 1000);
    if (!p) return [];
    const remote = s((r as Repo).remote, 300), branch = s((r as Repo).branch, 100);
    return [{ path: p, ...(remote ? { remote: stripCredentials(remote) } : {}), ...(branch ? { branch } : {}) }];
  });
  return { root: s(x.root, 1000) ?? "", repos, ...(x.truncated === true ? { truncated: true } : {}), at: Date.now() };
}

/** 给她看的一段：每个仓库一行。 */
export function describeOverview(o: Overview | undefined, indent = ""): string {
  if (!o) return "";
  const home = os.homedir();
  const short = (p: string) => (o.root === home && p.startsWith(home + path.sep) ? `~${p.slice(home.length)}` : p);
  if (!o.repos.length) return `${indent}工作目录 ${o.root} 下（深度 2 以内）没有 git 仓库。`;
  return `${indent}工作目录 ${o.root} 下的 git 仓库${o.truncated ? `（只列出了前 ${o.repos.length} 个）` : ""}：\n${o.repos.map((r) => `${indent}- ${short(r.path)}${r.branch ? `（${r.branch}）` : ""}${r.remote ? ` ← ${r.remote}` : ""}`).join("\n")}`;
}
