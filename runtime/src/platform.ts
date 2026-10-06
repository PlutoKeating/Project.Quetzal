// 平台差异集中在这里：命令查找（Windows 按 PATHEXT）、结束整棵进程树、只给本用户的目录权限、遇到文件被占用时重试的改名。
//   Windows 上 chmod 只改只读位，0600 / 0700 不起作用；目录权限用 icacls 去掉继承、只留本用户与 SYSTEM。
//   Windows 上被杀毒软件、索引服务或编辑器短暂打开的文件，改名覆盖会报 EPERM / EBUSY / EACCES：有限次数重试（参考 DeepSeek Harness 的做法）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

export const isWindows = process.platform === "win32";

/** Windows 上运行基座的根目录 %LOCALAPPDATA%\Quetzal（家目录在 home\，版本在 runtime\，见 docs/WINDOWS_DECISIONS.md §4.1）。 */
export function windowsRoot(): string {
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  return path.join(local, "Quetzal");
}

/** 在 PATH 里找一个命令；Windows 上依次试 PATHEXT 里的扩展名（.exe、.cmd …），也接受已经带扩展名的写法。找不到返回 undefined。 */
export function which(cmd: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (path.isAbsolute(cmd)) return usable(cmd) ? cmd : undefined;
  const exts = isWindows ? ["", ...(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean).map((e) => e.toLowerCase())] : [""];
  for (const d of (env.PATH ?? env.Path ?? "").split(path.delimiter)) {
    if (!d) continue;
    for (const e of exts) {
      const f = path.join(d.replace(/^"|"$/g, ""), cmd + e);
      if (usable(f)) return f;
    }
  }
  return undefined;
}
function usable(f: string): boolean {
  try {
    if (isWindows) { const s = fs.statSync(f); return s.isFile(); } // Windows 没有可执行位；Store 版应用的别名是 0 字节的重解析点，stat 能取到
    fs.accessSync(f, fs.constants.X_OK); return fs.statSync(f).isFile();
  } catch {
    if (!isWindows) return false;
    try { return fs.lstatSync(f).isSymbolicLink(); } catch { return false; } // 应用执行别名（WindowsApps）stat 会 EACCES，lstat 能认出来
  }
}

/** 结束一个进程及它的全部子孙：POSIX 发给整个进程组（启动时要 detached），Windows 用 taskkill /T /F。 */
export function killTree(pid: number | undefined, sig: NodeJS.Signals = "SIGTERM"): void {
  if (!pid) return;
  if (isWindows) {
    try { spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true, timeout: 10_000 }); } catch { /* 已退出 */ }
    return;
  }
  try { process.kill(-pid, sig); } catch { try { process.kill(pid, sig); } catch { /* 已退出 */ } }
}

/** 目录（或文件）只给本用户：POSIX chmod；Windows 去掉继承，只授予当前用户与 SYSTEM 完全控制（子项继承）。失败不抛出（不是自己的目录就不动）。 */
export function restrictToOwner(p: string, mode: number): void {
  if (!isWindows) { try { fs.chmodSync(p, mode); } catch { /* 不是自己的 */ } return; }
  const user = windowsUser();
  if (!user) return;
  const dir = (() => { try { return fs.statSync(p).isDirectory(); } catch { return false; } })();
  const inherit = dir ? "(OI)(CI)" : "";
  try {
    execFileSync("icacls", [p, "/inheritance:r", "/grant:r", `${user}:${inherit}F`, "/grant:r", `*S-1-5-18:${inherit}F`, "/Q"], { stdio: "ignore", windowsHide: true, timeout: 20_000 });
  } catch { /* icacls 不可用或没有权限：留着继承来的权限 */ }
}

let cachedUser: string | undefined | null = null;
/** 当前 Windows 用户的「域\用户名」（icacls 用）。 */
export function windowsUser(): string | undefined {
  if (cachedUser !== null) return cachedUser;
  const u = process.env.USERNAME, d = process.env.USERDOMAIN;
  cachedUser = u ? (d ? `${d}\\${u}` : u) : (() => { try { return os.userInfo().username; } catch { return undefined; } })();
  return cachedUser;
}

const BUSY = new Set(["EPERM", "EBUSY", "EACCES"]);
/** 改名（覆盖已有的目标）。Windows 上目标被别的进程短暂占用时重试几次（共约 1.5 秒），仍不行再抛出。 */
export function renameRetry(from: string, to: string): void {
  for (let i = 0; ; i++) {
    try { fs.renameSync(from, to); return; }
    catch (e) {
      if (!isWindows || i >= 7 || !BUSY.has((e as NodeJS.ErrnoException).code ?? "")) throw e;
      sleepSync(25 * 2 ** Math.min(i, 5));
    }
  }
}

function sleepSync(ms: number) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

/** spawn / execFile 的公共选项：Windows 上不弹控制台窗口。 */
export const hidden = { windowsHide: true } as const;
