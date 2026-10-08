// 执行外部命令（shell 工具、适配器等），带超时与输出上限。agent 的命令（shell、后台任务）一律经 sandbox.ts 包进沙箱。
//   Windows 上她的命令是 PowerShell（sandbox.ts 的 wrapScript）；子进程一律不弹控制台窗口；超时与停止结束整棵进程树。
import { execFile } from "node:child_process";
import { wrapScript, hostScript, SandboxUnavailable } from "./sandbox.ts";
import { killTree, isWindows } from "./platform.ts";

export function run(cmd: string, args: string[] = [], timeoutMs = 20_000, o: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const p = execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 4 << 20, cwd: o.cwd, env: o.env, windowsHide: true, killSignal: "SIGKILL" }, (e: any, out, err) => {
      if (e?.killed && isWindows) killTree(p.pid); // 超时：Windows 上 execFile 只杀直接子进程，孙进程（沙箱里的命令）一起结束
      resolve({ code: e ? (typeof e.code === "number" ? e.code : 1) : 0, out: String(out), err: String(err || e?.message || "") });
    });
  });
}

/** agent 的一条 shell 命令：在沙箱里、以工作目录（Linux 为用户主目录，Windows 为工作区）执行。
 *  host：真实环境模式（host-mode.ts）——不经沙箱，以基座的系统用户在用户主目录里执行；signal 中止时（退出真实环境、急停）结束整棵进程树。 */
export async function shell(script: string, timeoutMs = 60_000, o: { host?: boolean; signal?: AbortSignal } = {}) {
  let w: Awaited<ReturnType<typeof wrapScript>>;
  if (o.host) w = hostScript(script);
  else try { w = await wrapScript(script); }
  catch (e) { if (e instanceof SandboxUnavailable) return { code: 126, out: "", err: e.message }; throw e; } // 没有沙箱：不执行，说明交给她
  const r = o.host ? await runTree(w, timeoutMs, o.signal) : await run(w.cmd, w.args, timeoutMs, { cwd: w.cwd, env: w.env });
  return isWindows ? { ...r, out: r.out.replace(/\r\n/g, "\n"), err: r.err.replace(/\r\n/g, "\n") } : r; // PowerShell 的 CRLF：给她看的统一成 LF
}

/** 真实环境的前台命令：自成进程组（Windows 用 taskkill /T），超时或 signal 中止时整棵结束——沙箱外没有「随基座一起结束」的兜底。 */
function runTree(w: { cmd: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }, timeoutMs: number, signal?: AbortSignal): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve({ code: 130, out: "", err: "没有执行：真实环境已经退出" });
    const p = spawn(w.cmd, w.args, { cwd: w.cwd, env: w.env, detached: !isWindows, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "", note = "";
    const MAX = 4 << 20;
    p.stdout!.on("data", (b: Buffer) => { if (out.length < MAX) out += b.toString(); });
    p.stderr!.on("data", (b: Buffer) => { if (err.length < MAX) err += b.toString(); });
    const kill = (why: string) => { note = why; killTree(p.pid, "SIGKILL"); };
    const t = setTimeout(() => kill(`\n（${Math.round(timeoutMs / 1000)} 秒超时，已结束）`), timeoutMs);
    const onAbort = () => kill("\n（真实环境已退出，命令已结束）");
    signal?.addEventListener("abort", onAbort, { once: true });
    const done = (code: number) => { clearTimeout(t); signal?.removeEventListener("abort", onAbort); resolve({ code, out, err: err + note }); };
    p.on("error", (e) => { err += `启动失败：${e.message}`; done(127); });
    p.on("close", (code, sig) => done(code ?? (sig ? 128 : 1)));
  });
}

// ---------- 后台任务：长时间运行的命令放到后台，agent 可以随时查看输出或停止（整个进程组）
import { spawn, type ChildProcess } from "node:child_process";
export interface Job { id: string; command: string; started: number; ended?: number; code: number | null; out: string; proc: ChildProcess; host?: string } // host：在真实环境里启动的（会话），退出真实环境时一并停止
const jobs = new Map<string, Job>();
const KEEP = 64 * 1024; // 每个任务保留最近 64 KiB 输出

export async function startJob(command: string, o: { host?: string } = {}): Promise<Job> {
  const w = o.host ? hostScript(command) : await wrapScript(command);
  const proc = spawn(w.cmd, w.args, { cwd: w.cwd, env: w.env, detached: !isWindows, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }); // Windows 上 detached 会弹出控制台窗口，进程树另用 taskkill 结束
  const job: Job = { id: Math.random().toString(36).slice(2, 8), command, started: Date.now(), code: null, out: "", proc, host: o.host };
  const add = (b: Buffer) => { job.out = (job.out + b.toString()).slice(-KEEP); };
  proc.stdout!.on("data", add); proc.stderr!.on("data", add);
  proc.on("close", (code, sig) => { job.code = code ?? (sig ? 128 : 1); job.ended = Date.now(); });
  proc.on("error", (e) => { job.out += `\n启动失败：${e.message}`; job.code = 127; job.ended = Date.now(); });
  jobs.set(job.id, job);
  for (const [id, j] of jobs) if (j.ended && Date.now() - j.ended > 3_600_000) jobs.delete(id); // 结束一小时后清理
  return job;
}
export const listJobs = () => [...jobs.values()];
export const getJob = (id: string) => jobs.get(id);
/** 停止任务：先 SIGTERM 整个进程组，2 秒后仍在运行则 SIGKILL（Windows：直接结束整棵进程树）。 */
export function stopJob(id: string): string {
  const j = jobs.get(id);
  if (!j) return `没有这个任务：${id}`;
  if (j.ended) return `任务 ${id} 已经结束（退出码 ${j.code}）`;
  killTree(j.proc.pid, "SIGTERM");
  if (!isWindows) setTimeout(() => { if (!j.ended) killTree(j.proc.pid, "SIGKILL"); }, 2000).unref();
  return `已停止任务 ${id}`;
}
