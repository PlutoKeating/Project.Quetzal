// macOS 身体的「从控制台升级」：在后台重跑一键安装脚本（curl -fsSL https://quetzal.plutokeating.beer/install | bash），
// 它把运行基座与网页控制台升到指定的版本，并经 launchctl kickstart 重启 launchd 用户代理。
//   必须脱离运行基座的进程组：launchd 在代理的进程退出时会结束它进程组里剩下的进程，安装脚本若留在组里，重启那一步就会把自己杀掉。
//   macOS 没有 setsid 命令，用 Node 的 detached（新会话、新进程组）起 bash 即可。日志与状态格式与 Linux 相同（复用 linux/upgrade.ts 的纯函数）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { INSTALL_URL, upgradeShell, parseUpgradeLog, type UpgradeStatus } from "../linux/upgrade.ts";
import { have } from "./mac.ts";

const home = () => process.env.QUETZAL_HOME ?? path.join(os.homedir(), ".quetzal");
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;

export function upgradeStatus(): UpgradeStatus {
  try { const f = path.join(home(), "logs", "upgrade.log"); return parseUpgradeLog(fs.readFileSync(f, "utf8"), Date.now(), fs.statSync(f).mtimeMs); } catch { return { running: false }; }
}

/** 启动脱离的升级进程（测试可换掉 spawn）。 */
export function detachUpgrade(shell: string, sp: typeof spawn = spawn) {
  const p = sp("/bin/bash", ["-c", shell], { detached: true, stdio: "ignore", env: { ...process.env, QUETZAL_HOME: home(), PATH: `${process.env.PATH ?? "/usr/bin:/bin"}:/usr/local/bin:/opt/homebrew/bin` } });
  p.unref();
  return p;
}

export async function upgrade(version?: string): Promise<string> {
  if (version !== undefined && !VERSION_RE.test(version)) throw new Error("版本号不对");
  if (upgradeStatus().running) return "已经在升级了，等它结束"; // 同一时间只跑一个
  if (!have("curl")) throw new Error("需要 curl 才能下载安装脚本");
  const log = path.join(home(), "logs", "upgrade.log");
  fs.mkdirSync(path.dirname(log), { recursive: true });
  detachUpgrade(upgradeShell(log, INSTALL_URL, version, String(Date.now())));
  return `已在后台开始升级${version ? `到 ${version}` : ""}（日志 ${log}）：约一分钟后服务会重启一次，这期间控制台会短暂断开。`;
}
