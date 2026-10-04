// 家目录布局：与 Android 安装器完全一致的版本目录约定（releases/<版本>/、current、previous），切换、回滚、清理。
//   QUETZAL_HOME/
//   ├── releases/<版本>/main.cjs、linux.mjs、web/   每个安装过的版本（web/ 为网页控制台的静态文件）
//   ├── current  → releases/<版本>              正在运行的版本
//   ├── previous → releases/<版本>              上一个版本（回滚用）
//   └── config/quetzal.json 等                  运行基座自己的家目录内容
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface Layout { home: string; releases: string; current: string; previous: string; config: string }

export const defaultHome = () => process.env.QUETZAL_HOME ?? path.join(os.homedir(), ".quetzal");
/** 0.6.7 之前 Linux 的家目录是 ~/quetzal：没有显式指定家目录、新目录还不存在、老目录里有装过的痕迹时，整目录搬到 ~/.quetzal。 */
export const legacyHome = () => path.join(os.homedir(), "quetzal");
export function needsMigration(home: string): boolean {
  if (process.env.QUETZAL_HOME || home !== defaultHome()) return false;
  if (fs.existsSync(home)) return false;
  const old = legacyHome();
  return fs.existsSync(path.join(old, "config", "quetzal.json")) || fs.existsSync(path.join(old, "releases"));
}
/** 把老家目录搬到新位置（调用方先停掉服务）。返回老路径。 */
export function migrateHome(home: string): string {
  const old = legacyHome();
  fs.renameSync(old, home);
  return old;
}

export function layout(home: string): Layout {
  return { home, releases: path.join(home, "releases"), current: path.join(home, "current"), previous: path.join(home, "previous"), config: path.join(home, "config", "quetzal.json") };
}

const target = (link: string) => { try { return fs.readlinkSync(link); } catch { return undefined; } };
/** 符号链接指向的版本目录名；没有链接或目录已不存在时为空。 */
export const versionOf = (link: string) => { const t = target(link); return t && fs.existsSync(t) ? path.basename(t) : undefined; };

/** 原子地让 link 指向 dir（先建临时链接再改名）。 */
function point(link: string, dir: string) {
  const tmp = `${link}.${process.pid}.tmp`;
  fs.rmSync(tmp, { force: true });
  fs.symlinkSync(dir, tmp);
  fs.renameSync(tmp, link);
}

/** 把一组文件（与整个子目录）放进 releases/<版本>/（先写 .part 再改名，不会留下半个版本）。返回版本目录。 */
export function putRelease(l: Layout, version: string, files: { name: string; from: string }[], dirs: { name: string; from: string }[] = []): string {
  const dir = path.join(l.releases, version);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of files) {
    const to = path.join(dir, f.name);
    fs.copyFileSync(f.from, `${to}.part`);
    fs.renameSync(`${to}.part`, to);
  }
  for (const d of dirs) {
    const to = path.join(dir, d.name);
    fs.rmSync(`${to}.part`, { recursive: true, force: true });
    fs.cpSync(d.from, `${to}.part`, { recursive: true });
    fs.rmSync(to, { recursive: true, force: true });
    fs.renameSync(`${to}.part`, to);
  }
  return dir;
}

/** 切换到某个版本目录：previous ← current（如果不同），current ← dir。返回切换前的目录。 */
export function switchTo(l: Layout, dir: string): string | undefined {
  const cur = target(l.current);
  if (cur && cur !== dir && fs.existsSync(cur)) point(l.previous, cur);
  point(l.current, dir);
  return cur;
}

/** 回滚：current 与 previous 互换。没有可回滚的版本时返回空。 */
export function rollback(l: Layout): string | undefined {
  const prev = target(l.previous);
  if (!prev || !fs.existsSync(prev)) return undefined;
  switchTo(l, prev);
  return path.basename(prev);
}

/** 只保留最近 keep 个版本（按修改时间），current 与 previous 指向的永远保留。 */
export function prune(l: Layout, keep = 3): string[] {
  const protectedDirs = new Set([target(l.current), target(l.previous)].filter(Boolean));
  let dirs: { name: string; mtime: number }[] = [];
  try { dirs = fs.readdirSync(l.releases).map((name) => ({ name, mtime: fs.statSync(path.join(l.releases, name)).mtimeMs })); } catch { return []; }
  dirs.sort((a, b) => b.mtime - a.mtime);
  const removed: string[] = [];
  for (const d of dirs.slice(keep)) {
    const p = path.join(l.releases, d.name);
    if (protectedDirs.has(p)) continue;
    fs.rmSync(p, { recursive: true, force: true });
    removed.push(d.name);
  }
  return removed;
}

/** 读写运行基座的配置文件（只碰安装需要的几个键，其余由控制台管理）。 */
export function readConfig(l: Layout): Record<string, any> {
  try { return JSON.parse(fs.readFileSync(l.config, "utf8")); } catch { return {}; }
}
export function patchConfig(l: Layout, patch: (c: Record<string, any>) => void) {
  const c = readConfig(l);
  patch(c);
  fs.mkdirSync(path.dirname(l.config), { recursive: true });
  fs.writeFileSync(l.config, JSON.stringify(c, null, 2));
  return c;
}

/** 身体名字的缺省：主机名（小写、只留字母数字与连字符），拿不到就 linux。只在还没有配置时写入。 */
export function defaultBody(hostname = os.hostname()): string {
  return hostname.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "linux";
}
