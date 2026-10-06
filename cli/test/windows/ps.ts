// 能跑 PowerShell 测试的解释器：Windows 上是 powershell.exe（系统自带的 5.1，用户机器上实际执行脚本的就是它），其他系统是 PATH 上的 pwsh；都没有返回空。
import { spawnSync } from "node:child_process";

export function powershell(): string | undefined {
  const cands = process.platform === "win32" ? ["powershell.exe", "pwsh.exe"] : ["pwsh"];
  return cands.find((c) => spawnSync(c, ["-NoProfile", "-Command", "exit 0"], { stdio: "ignore" }).status === 0);
}
