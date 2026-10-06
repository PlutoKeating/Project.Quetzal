// Linux 身体的「从控制台升级」：在后台重跑一键安装脚本（curl -fsSL https://quetzal.plutokeating.beer/install | bash），
// 它会把运行基座、网页控制台与原生控制台升到最新发布，并重启服务。
//   必须脱离 quetzal 服务的 cgroup 运行：systemd 用户服务 KillMode=mixed，重启时会杀掉服务里剩下的所有进程，
//   安装脚本若是服务的子进程就会在重启服务的那一步把自己杀掉。所以有 systemd 就用 systemd-run 起一个临时单元；
//   没有（守护循环模式）就 setsid + nohup 脱离即可。输出进 ~/.quetzal/logs/upgrade.log。
// 控制台指定要升到的版本（它看到的最新发布）：安装脚本按这个版本装，不用 npm 的 latest 标签——npm 的标签可能晚于发布，
// 装完版本号不变，控制台就一直等。每次升级有一个编号，开始与结束（含退出码）都写进日志；upgradeStatus 读日志得知进行中、成功还是失败，
// 以及最后一步在做什么。同一时间只跑一个升级（重复点不会叠起好几个安装脚本互相干扰）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { have, run } from "./linux.ts";

export const INSTALL_URL = "https://quetzal.plutokeating.beer/install";
const home = () => process.env.QUETZAL_HOME ?? path.join(os.homedir(), ".quetzal");

const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;
const STALL_MS = 15 * 60_000; // 超过这么久还没结束：当作卡住（不再挡着下一次升级）

/** 要执行的 shell 命令：下载脚本并以 --no-open（和指定的版本）运行，日志追加到 logs/upgrade.log，开始与结束带上这次升级的编号。 */
export function upgradeShell(logFile: string, url = INSTALL_URL, version?: string, id = String(Date.now())): string {
  const fetch = `(command -v curl >/dev/null 2>&1 && curl -fsSL ${url} || wget -qO- ${url})`;
  const v = version && VERSION_RE.test(version) ? ` --version ${version}` : "";
  return `mkdir -p "$(dirname '${logFile}')" && { echo "== 升级 ${id} 开始 $(date)${v ? `（目标 ${version}）` : ""}"; set -o pipefail; ${fetch} | bash -s -- --no-open${v}; echo "== 升级 ${id} 退出码 $?"; } >>'${logFile}' 2>&1`;
}

export interface UpgradeStatus { running: boolean; id?: string; startedAt?: number; target?: string; exitCode?: number; step?: string; stalled?: boolean }

/** 从日志读最近一次升级的状态：有开始没结束为进行中（超过 15 分钟算卡住）；结束的带退出码；step 为它最后一步在做什么。 */
export function parseUpgradeLog(text: string, now = Date.now()): UpgradeStatus {
  const starts = [...text.matchAll(/^== 升级 (\d+) 开始[^\n]*?(?:（目标 ([^）]+)）)?$/gm)];
  const last = starts.at(-1);
  if (!last) return { running: false };
  const id = last[1], startedAt = Number(id), target = last[2];
  const body = text.slice((last.index ?? 0) + last[0].length);
  const end = body.match(new RegExp(`^== 升级 ${id} 退出码 (\\d+)`, "m"));
  // 最后一个看得懂的步骤（安装脚本每步以 ▸ ✓ ! ✗ 开头；curl 之类的报错也算）
  const lines = body.slice(0, end?.index ?? body.length).split("\n").map((l) => l.replace(/\x1b\[[0-9;]*m/g, "").trim()).filter(Boolean);
  const step = [...lines].reverse().find((l) => /^[▸✓!✗·]|error|failed|curl:|npm ERR|E[A-Z]+:/i.test(l))?.replace(/^[▸✓!✗·]\s*/, "").slice(0, 200);
  if (end) return { running: false, id, startedAt, target, exitCode: Number(end[1]), step };
  const stalled = now - startedAt > STALL_MS;
  return { running: !stalled, id, startedAt, target, step, ...(stalled ? { stalled: true } : {}) };
}

export function upgradeStatus(): UpgradeStatus {
  try { return parseUpgradeLog(fs.readFileSync(path.join(home(), "logs", "upgrade.log"), "utf8")); } catch { return { running: false }; }
}

/** 怎么脱离当前进程运行：有 systemd 用户实例用 systemd-run（临时单元，不在 quetzal 服务的 cgroup 里），否则 setsid + nohup。 */
export function detachCommand(shell: string, systemd: boolean, unit = `quetzal-upgrade-${Date.now()}`): { cmd: string; args: string[] } {
  if (systemd) return { cmd: "systemd-run", args: ["--user", "--collect", "--quiet", `--unit=${unit}`, "--setenv=HOME=" + os.homedir(), "bash", "-c", shell] };
  return { cmd: "setsid", args: ["-f", "bash", "-c", `nohup bash -c ${JSON.stringify(shell)} >/dev/null 2>&1 &`] };
}

export async function upgrade(version?: string): Promise<string> {
  if (version !== undefined && !VERSION_RE.test(version)) throw new Error("版本号不对");
  if (upgradeStatus().running) return "已经在升级了，等它结束"; // 同一时间只跑一个
  if (!have("bash")) throw new Error("这台机器没有 bash，无法运行安装脚本");
  if (!have("curl") && !have("wget")) throw new Error("需要 curl 或 wget 才能下载安装脚本");
  const log = path.join(home(), "logs", "upgrade.log");
  fs.mkdirSync(path.dirname(log), { recursive: true });
  const id = String(Date.now());
  const shell = upgradeShell(log, INSTALL_URL, version, id);
  const systemd = have("systemd-run") && (await run("systemctl", ["--user", "show-environment"], 10_000)).code === 0;
  const d = detachCommand(shell, systemd, `quetzal-upgrade-${id}`);
  if (!systemd && !have("setsid")) { const p = spawn("bash", ["-c", shell], { detached: true, stdio: "ignore", env: { ...process.env, QUETZAL_HOME: home() } }); p.unref(); }
  else {
    const r = systemd ? await run(d.cmd, d.args, 20_000) : await run(d.cmd, d.args, 20_000);
    if (r.code !== 0) throw new Error(`没能启动升级：${r.out.trim().slice(0, 200)}`);
  }
  return `已在后台开始升级${version ? `到 ${version}` : ""}（日志 ${log}）：约一分钟后服务会重启一次，这期间控制台会短暂断开。`;
}
