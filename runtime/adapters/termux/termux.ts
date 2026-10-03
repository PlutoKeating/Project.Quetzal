// 调用 Termux:API 命令行工具，带超时。
import { execFile } from "node:child_process";

export function run(cmd: string, args: string[] = [], timeoutMs = 20_000): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 8 << 20 }, (e: any, out) =>
    resolve({ code: e ? (typeof e.code === "number" ? e.code : 1) : 0, out: String(out) })));
}

export async function json<T = any>(cmd: string, args: string[] = [], timeoutMs = 15_000): Promise<T | undefined> {
  const r = await run(cmd, args, timeoutMs);
  if (r.code !== 0) return undefined;
  try { return JSON.parse(r.out); } catch { return undefined; }
}

/** 从 `termux-sensor -l` 的列表里挑出光线与加速度传感器（各手机命名不同：light-bh1745、TMD4906 Light、lsm6dso Accelerometer…）。 */
export function pickSensors(list: string[]): { light?: string; accel?: string } {
  const find = (re: RegExp, avoid?: RegExp) => list.find((s) => re.test(s) && !(avoid && avoid.test(s)));
  return {
    light: find(/light|lux|illumin/i, /uncal|wake|flashlight/i),
    accel: find(/accel/i, /uncal|linear|wake/i) ?? find(/accel/i),
  };
}
