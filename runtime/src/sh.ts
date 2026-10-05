// 执行外部命令（shell 工具、适配器等），带超时与输出上限。agent 的命令（shell、后台任务）一律经 sandbox.ts 包进沙箱。
import { execFile } from "node:child_process";
import { wrap, SandboxUnavailable } from "./sandbox.ts";

export function run(cmd: string, args: string[] = [], timeoutMs = 20_000, o: { cwd?: string } = {}): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 4 << 20, cwd: o.cwd }, (e: any, out, err) =>
      resolve({ code: e ? (typeof e.code === "number" ? e.code : 1) : 0, out: String(out), err: String(err || e?.message || "") }));
  });
}

const agentShell = () => process.env.SHELL || "sh";

/** agent 的一条 shell 命令：在沙箱里、以用户主目录为工作目录执行。 */
export function shell(script: string, timeoutMs = 60_000) {
  let w: ReturnType<typeof wrap>;
  try { w = wrap(agentShell(), ["-c", script]); }
  catch (e) { if (e instanceof SandboxUnavailable) return Promise.resolve({ code: 126, out: "", err: e.message }); throw e; } // 没有沙箱：不执行，说明交给她
  return run(w.cmd, w.args, timeoutMs, { cwd: w.cwd });
}

// ---------- 后台任务：长时间运行的命令放到后台，agent 可以随时查看输出或停止（整个进程组）
import { spawn, type ChildProcess } from "node:child_process";
export interface Job { id: string; command: string; started: number; ended?: number; code: number | null; out: string; proc: ChildProcess }
const jobs = new Map<string, Job>();
const KEEP = 64 * 1024; // 每个任务保留最近 64 KiB 输出

export function startJob(command: string): Job {
  const w = wrap(agentShell(), ["-c", command]);
  const proc = spawn(w.cmd, w.args, { cwd: w.cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  const job: Job = { id: Math.random().toString(36).slice(2, 8), command, started: Date.now(), code: null, out: "", proc };
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
/** 停止任务：先 SIGTERM 整个进程组，2 秒后仍在运行则 SIGKILL。 */
export function stopJob(id: string): string {
  const j = jobs.get(id);
  if (!j) return `没有这个任务：${id}`;
  if (j.ended) return `任务 ${id} 已经结束（退出码 ${j.code}）`;
  const kill = (sig: NodeJS.Signals) => { try { process.kill(-j.proc.pid!, sig); } catch { try { j.proc.kill(sig); } catch { /* 已退出 */ } } };
  kill("SIGTERM");
  setTimeout(() => { if (!j.ended) kill("SIGKILL"); }, 2000).unref();
  return `已停止任务 ${id}`;
}
