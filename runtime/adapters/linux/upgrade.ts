// Linux 身体的「从控制台升级」：在后台重跑一键安装脚本（curl -fsSL https://quetzal.plutokeating.beer/install | bash），
// 它会把运行基座、网页控制台与原生控制台升到最新发布，并重启服务。
//   必须脱离 quetzal 服务的 cgroup 运行：systemd 用户服务 KillMode=mixed，重启时会杀掉服务里剩下的所有进程，
//   安装脚本若是服务的子进程就会在重启服务的那一步把自己杀掉。所以有 systemd 就用 systemd-run 起一个临时单元；
//   没有（守护循环模式）就 setsid + nohup 脱离即可。输出进 ~/quetzal/logs/upgrade.log。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { have, run } from "./linux.ts";

export const INSTALL_URL = "https://quetzal.plutokeating.beer/install";
const home = () => process.env.QUETZAL_HOME ?? path.join(os.homedir(), "quetzal");

/** 要执行的 shell 命令：下载脚本并以 --no-open 运行，日志追加到 logs/upgrade.log。 */
export function upgradeShell(logFile: string, url = INSTALL_URL): string {
  const fetch = `(command -v curl >/dev/null 2>&1 && curl -fsSL ${url} || wget -qO- ${url})`;
  return `mkdir -p "$(dirname '${logFile}')" && { echo "== $(date) 从控制台发起升级"; ${fetch} | bash -s -- --no-open; echo "== 退出码 $?"; } >>'${logFile}' 2>&1`;
}

/** 怎么脱离当前进程运行：有 systemd 用户实例用 systemd-run（临时单元，不在 quetzal 服务的 cgroup 里），否则 setsid + nohup。 */
export function detachCommand(shell: string, systemd: boolean, unit = `quetzal-upgrade-${Date.now()}`): { cmd: string; args: string[] } {
  if (systemd) return { cmd: "systemd-run", args: ["--user", "--collect", "--quiet", `--unit=${unit}`, "--setenv=HOME=" + os.homedir(), "bash", "-c", shell] };
  return { cmd: "setsid", args: ["-f", "bash", "-c", `nohup bash -c ${JSON.stringify(shell)} >/dev/null 2>&1 &`] };
}

export async function upgrade(): Promise<string> {
  if (!have("bash")) throw new Error("这台机器没有 bash，无法运行安装脚本");
  if (!have("curl") && !have("wget")) throw new Error("需要 curl 或 wget 才能下载安装脚本");
  const log = path.join(home(), "logs", "upgrade.log");
  fs.mkdirSync(path.dirname(log), { recursive: true });
  const shell = upgradeShell(log);
  const systemd = have("systemd-run") && (await run("systemctl", ["--user", "show-environment"], 10_000)).code === 0;
  const d = detachCommand(shell, systemd);
  if (!systemd && !have("setsid")) { const p = spawn("bash", ["-c", shell], { detached: true, stdio: "ignore", env: { ...process.env, QUETZAL_HOME: home() } }); p.unref(); }
  else {
    const r = systemd ? await run(d.cmd, d.args, 20_000) : await run(d.cmd, d.args, 20_000);
    if (r.code !== 0) throw new Error(`没能启动升级：${r.out.trim().slice(0, 200)}`);
  }
  return `已在后台开始升级（日志 ${log}）：下载最新的运行基座与控制台，约一分钟后服务会重启一次；这期间控制台会短暂断开，重连后版本号会变。`;
}
