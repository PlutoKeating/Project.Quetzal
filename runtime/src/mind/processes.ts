// 进程列表：直接读 /proc，不依赖 ps 命令。
//   有的沙箱里 ps 缺失、报错或看不到进程，而命令里的 2>/dev/null 会把报错吞掉，输出为空看起来就像"没有进程"，
//   她据此断言"没有后台进程"——可她自己就跑在 node 进程里。这里给她一个不会撒谎的来源，并标出哪个是她自己。
import fs from "node:fs";
import { listJobs } from "../sh.ts";

export interface Proc { pid: number; ppid: number; state: string; startedMs: number; cmd: string }

const CLK = 100; // Linux 的 CLK_TCK 几乎总是 100
let bootMs: number | undefined;
/**
 * 开机时刻。不读 /proc/stat 与 /proc/uptime——Android 上普通应用读它们会被拒绝（EACCES）；
 * 改用自己的 /proc/self/stat 里的启动 tick 与 process.uptime() 反推，读不到就返回 NaN（时长显示为 ?）。
 */
function bootTime(): number {
  if (bootMs === undefined) {
    try {
      const stat = fs.readFileSync("/proc/self/stat", "utf8");
      const start = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]);
      bootMs = Date.now() - process.uptime() * 1000 - start / CLK * 1000;
    } catch { bootMs = NaN; }
  }
  return bootMs;
}

/** 当前用户能看到的全部进程（Android 的 /proc 带 hidepid，只看得到自己这个用户的）。没有 /proc（非 Linux）时抛错。 */
export function listProcesses(): Proc[] {
  const boot = bootTime();
  const out: Proc[] = [];
  for (const d of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const stat = fs.readFileSync(`/proc/${d}/stat`, "utf8");
      const close = stat.lastIndexOf(")");
      const comm = stat.slice(stat.indexOf("(") + 1, close);
      const f = stat.slice(close + 2).split(" "); // state ppid pgrp session tty tpgid flags minflt cminflt majflt cmajflt utime stime cutime cstime priority nice threads itrealvalue starttime
      const cmdline = fs.readFileSync(`/proc/${d}/cmdline`).toString().split("\0").filter(Boolean).join(" ");
      out.push({ pid: Number(d), ppid: Number(f[1]), state: f[0], startedMs: boot + Number(f[19]) / CLK * 1000, cmd: cmdline || `[${comm}]` });
    } catch { /* 进程已退出或不可读 */ }
  }
  return out.sort((a, b) => a.pid - b.pid);
}

const ago = (ms: number) => { if (!Number.isFinite(ms)) return "?"; const s = Math.max(0, Math.round((Date.now() - ms) / 1000)); return s < 60 ? `${s}秒` : s < 3600 ? `${Math.round(s / 60)}分` : `${(s / 3600).toFixed(1)}时`; };

/** 给她看的进程表：可按命令行子串过滤；标出她自己、她的父进程与她启动的后台任务。 */
export function describeProcesses(filter = "", limit = 80): string {
  let list: Proc[];
  try { list = listProcesses(); } catch (e: any) { return `这具身体上读不到进程列表（${e.message}）`; }
  const jobs = new Map(listJobs().filter((j) => !j.ended && j.proc.pid).map((j) => [j.proc.pid!, j.id]));
  const q = filter.trim().toLowerCase();
  const hit = q ? list.filter((p) => p.cmd.toLowerCase().includes(q) || String(p.pid) === q) : list;
  const tag = (p: Proc) => p.pid === process.pid ? " ←我自己（运行基座）" : p.pid === process.ppid ? " ←我的父进程（守护者）" : jobs.has(p.pid) ? ` ←我的后台任务 ${jobs.get(p.pid)}` : "";
  hit.sort((a, b) => Number(!!tag(b)) - Number(!!tag(a)) || a.pid - b.pid); // 与她有关的排最前，截断也不会丢
  const rows = hit.slice(0, limit).map((p) => `${p.pid}\t${p.ppid}\t${p.state}\t${ago(p.startedMs)}\t${p.cmd.slice(0, 120)}${tag(p)}`);
  const head = `本用户可见的进程 ${list.length} 个${q ? `，匹配「${filter.trim()}」${hit.length} 个` : ""}${hit.length > limit ? `（只列前 ${limit} 个）` : ""}。我自己是 pid ${process.pid}。\npid\tppid\t状态\t已运行\t命令`;
  return hit.length ? `${head}\n${rows.join("\n")}` : `${head}\n（没有匹配的进程；但我自己 pid ${process.pid} 确实在运行，只是不匹配这个过滤词）`;
}
