// Windows：安装由 setup.exe / install.ps1 完成（cli/windows/），这里只做运维：版本指针、计划任务、启停、日志、打开控制台、卸载。
// 目录约定（docs/WINDOWS_DECISIONS.md 4.1，Linux 的符号链接那套不动）：
//   ROOT = %LOCALAPPDATA%\Quetzal（QUETZAL_ROOT 可改）
//   ROOT\home\                     QUETZAL_HOME
//   ROOT\runtime\<版本>\           main.cjs、windows.mjs、quetzal.mjs（本命令行）…；current.txt / previous.txt 是指针（一行版本号）
//   ROOT\console\<版本>\           quetzal-console.exe；console\current.txt
//   ROOT\node.txt                  运行基座用的 node.exe；ROOT\bin\quetzal.cmd、quetzal-supervise.ps1（两个计划任务的动作）
//   ROOT\uninstall.exe             卸载程序
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { run } from "./service.ts";

export const TASKS = ["\\Quetzal\\Runtime-Boot", "\\Quetzal\\Runtime-Logon"] as const;
const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

export interface WinLayout {
  root: string; home: string; runtime: string; current: string; previous: string;
  console: string; consoleCurrent: string; node: string; log: string; state: string; uninstaller: string;
}

export function winRoot(env: NodeJS.ProcessEnv = process.env): string {
  if (env.QUETZAL_ROOT) return env.QUETZAL_ROOT;
  return path.join(env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "Quetzal");
}

export function winLayout(root = winRoot(), home?: string): WinLayout {
  const h = home ?? process.env.QUETZAL_HOME ?? path.join(root, "home");
  return {
    root, home: h, runtime: path.join(root, "runtime"), current: path.join(root, "runtime", "current.txt"), previous: path.join(root, "runtime", "previous.txt"),
    console: path.join(root, "console"), consoleCurrent: path.join(root, "console", "current.txt"), node: path.join(root, "node.txt"),
    log: path.join(h, "logs", "runtime.log"), state: path.join(h, "state"), uninstaller: path.join(root, "uninstall.exe"),
  };
}

/** 指针文件里的版本号（一行，UTF-8，可能带 BOM 与行尾）；不是版本号的内容一律当作没有。 */
export function readPointer(file: string): string | undefined {
  try {
    const v = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "").trim();
    return VERSION_RE.test(v) ? v : undefined;
  } catch { return undefined; }
}

/** 原子写指针（先写临时文件再改名）。 */
export function writePointer(file: string, version: string) {
  if (!VERSION_RE.test(version)) throw new Error(`版本号不对：${version}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, version);
  fs.renameSync(tmp, file);
}

export const currentVersion = (l: WinLayout) => { const v = readPointer(l.current); return v && fs.existsSync(path.join(l.runtime, v)) ? v : undefined; };
export const previousVersion = (l: WinLayout) => { const v = readPointer(l.previous); return v && fs.existsSync(path.join(l.runtime, v)) ? v : undefined; };
export const currentDir = (l: WinLayout) => { const v = currentVersion(l); return v ? path.join(l.runtime, v) : undefined; };

/** 回滚：current.txt 与 previous.txt 互换（控制台指针跟着运行基座走，那个版本的控制台还在时）。没有可回滚的版本时返回空。 */
export function winRollback(l: WinLayout): string | undefined {
  const cur = currentVersion(l), prev = previousVersion(l);
  if (!prev || prev === cur) return undefined;
  writePointer(l.current, prev);
  if (cur) writePointer(l.previous, cur);
  if (fs.existsSync(path.join(l.console, prev, "quetzal-console.exe"))) writePointer(l.consoleCurrent, prev);
  return prev;
}

/** 原生控制台的可执行文件（console\current.txt 指向的版本）；没有时为空。 */
export function consoleExe(l: WinLayout): string | undefined {
  const v = readPointer(l.consoleCurrent);
  const exe = v && path.join(l.console, v, "quetzal-console.exe");
  return exe && fs.existsSync(exe) ? exe : undefined;
}

/** schtasks /Query /FO CSV /NH 的一行："<任务名>","<下次运行时间>","<状态>"（状态随系统语言）。 */
export function parseSchtasksCsv(out: string): { name: string; status: string } | undefined {
  const line = out.split(/\r?\n/).map((s) => s.trim()).find((s) => s.startsWith('"'));
  if (!line) return undefined;
  const cols = [...line.matchAll(/"((?:[^"]|"")*)"/g)].map((m) => m[1].replace(/""/g, '"'));
  return cols.length >= 3 ? { name: cols[0], status: cols[2] } : undefined;
}

const schtasks = (args: string[]) => run(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "schtasks.exe"), args, 20_000);

/** 计划任务的状态：未注册时为空。 */
export async function taskStatus(name: string): Promise<string | undefined> {
  const r = await schtasks(["/Query", "/TN", name, "/FO", "CSV", "/NH"]);
  return r.code === 0 ? (parseSchtasksCsv(r.out)?.status ?? "?") : undefined;
}

/** 启动：清掉 state\quit，先跑开机任务（S4U），再跑登录任务，都不行就直接拉起启动器（隐藏窗口、脱离本进程）。 */
export async function winStart(l: WinLayout): Promise<string> {
  fs.rmSync(path.join(l.state, "quit"), { force: true });
  for (const t of TASKS) {
    if ((await schtasks(["/Run", "/TN", t])).code === 0) return `已通过计划任务 ${t} 启动`;
  }
  const ps = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const p = spawn(ps, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", path.join(l.root, "bin", "quetzal-supervise.ps1")],
    { detached: true, stdio: "ignore", windowsHide: true });
  p.unref();
  return "计划任务不可用，已直接拉起守护进程（不会开机自启：请重新运行安装程序）";
}

/** 停止：写 state\quit（守护进程连同运行基座一起退出），结束两个计划任务。 */
export async function winStop(l: WinLayout) {
  fs.mkdirSync(l.state, { recursive: true });
  fs.writeFileSync(path.join(l.state, "quit"), new Date().toISOString());
  for (const t of TASKS) await schtasks(["/End", "/TN", t]);
}

/** 末尾 n 行。 */
export function tailLines(text: string, n: number): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.slice(-n).join("\n");
}

/** 运行基座日志（ROOT\home\logs\runtime.log，守护进程写入、5 MB 轮转）；follow 时每秒检查一次新内容，文件变小（轮转）就从头读。 */
export async function winLogs(l: WinLayout, lines = 80, follow = false): Promise<number> {
  let text = "";
  try { text = fs.readFileSync(l.log, "utf8"); } catch { console.log(`还没有日志：${l.log}`); if (!follow) return 0; }
  if (text) process.stdout.write(tailLines(text, lines) + "\n");
  if (!follow) return 0;
  let pos = Buffer.byteLength(text);
  return new Promise<number>(() => {
    setInterval(() => {
      let size = 0;
      try { size = fs.statSync(l.log).size; } catch { return; }
      if (size < pos) pos = 0;
      if (size === pos) return;
      const fd = fs.openSync(l.log, "r");
      try { const buf = Buffer.alloc(size - pos); fs.readSync(fd, buf, 0, buf.length, pos); process.stdout.write(buf); pos = size; } finally { fs.closeSync(fd); }
    }, 1000);
  });
}

/** 卸载：运行卸载程序（它自己关进程、提权移除计划任务与沙箱账户、问要不要删数据）；--purge 时直接带 /PURGE。 */
export function winUninstall(l: WinLayout, purge: boolean): string {
  if (!fs.existsSync(l.uninstaller)) throw new Error(`没有找到卸载程序 ${l.uninstaller}：可以在「设置 › 应用」里卸载 Quetzal`);
  const p = spawn(l.uninstaller, purge ? ["/PURGE"] : [], { detached: true, stdio: "ignore" });
  p.unref();
  return "已打开卸载程序";
}
