// 执行外部命令（shell 工具、适配器等），带超时与输出上限。
import { execFile } from "node:child_process";

export function run(cmd: string, args: string[] = [], timeoutMs = 20_000): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 4 << 20 }, (e: any, out, err) =>
      resolve({ code: e ? (typeof e.code === "number" ? e.code : 1) : 0, out: String(out), err: String(err || e?.message || "") }));
  });
}

export function shell(script: string, timeoutMs = 60_000) {
  return run(process.env.SHELL || "sh", ["-c", script], timeoutMs);
}
