// Windows 身体的守护开关、退出与升级（控制台「高级 · 运行」与托盘）。
//   守护：安装器注册的计划任务 \Quetzal\Runtime-Boot（开机，不登录也跑）与 \Quetzal\Runtime-Logon（登录时），都执行 windows-supervise.mjs。
//     关 = 写 state\supervise.off（守护进程不再拉起；开机任务照常起来但什么也不做）并试着停用两个任务；开 = 反过来。
//   退出：写 state\quit，运行基座退出后守护进程随之退出（开机自启照旧）。
//   升级：后台重跑 install.ps1（它下载签名核对过的安装包并静默安装），日志与 Linux 同格式（logs\upgrade.log），状态解析复用 linux/upgrade.ts。
//     安装包会关掉正在运行的 Quetzal 进程，所以升级进程要脱离运行基座的进程树：中间的 PowerShell 用 Start-Process 起它之后立即退出。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import type { SupervisionState } from "../../src/body/adapter.ts";
import { parseUpgradeLog, type UpgradeStatus } from "../linux/upgrade.ts";
import { runOnce, powershell, psq } from "./ps.ts";

export const INSTALL_PS1 = "https://quetzal.plutokeating.beer/install.ps1";
const ROOT = () => path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "Quetzal");
const home = () => process.env.QUETZAL_HOME ?? path.join(ROOT(), "home");
const flag = (n: string) => path.join(home(), "state", n);
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;

async function tasks(): Promise<{ name: string; state: string }[]> {
  const r = await runOnce("Get-ScheduledTask -TaskPath '\\Quetzal\\' -ErrorAction SilentlyContinue | ForEach-Object { $_.TaskName + '|' + $_.State }", 30_000);
  return r.out.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.includes("|")).map((l) => { const [name, state] = l.split("|"); return { name, state }; });
}

export async function status(): Promise<SupervisionState> {
  const list = await tasks();
  if (!list.length) return { available: false, kind: "none", enabled: false, detail: "这具身体没有安装器注册的守护任务（手动运行或自定义部署）" };
  const off = fs.existsSync(flag("supervise.off"));
  const boot = list.some((t) => t.name === "Runtime-Boot" && t.state !== "Disabled");
  return { available: true, kind: "task", enabled: !off && list.some((t) => t.state !== "Disabled"),
    detail: `计划任务：${boot ? "开机就启动（不用登录）" : "登录时启动"}，退出 3 秒后自动重启${off ? "（已关闭：不再拉起）" : ""}` };
}

export async function set(enabled: boolean): Promise<void> {
  const off = flag("supervise.off");
  if (enabled) fs.rmSync(off, { force: true });
  else { fs.mkdirSync(path.dirname(off), { recursive: true }); fs.writeFileSync(off, `${new Date().toISOString()}\n`); }
  // 任务由安装器以管理员注册，普通用户不一定改得动它的启用状态：改不动也没关系，标志文件已经让守护进程停手
  await runOnce(`Get-ScheduledTask -TaskPath '\\Quetzal\\' -ErrorAction SilentlyContinue | ${enabled ? "Enable-ScheduledTask" : "Disable-ScheduledTask"} -ErrorAction SilentlyContinue | Out-Null`, 30_000);
}

/** 托盘的「退出」：这一次停掉运行基座（守护进程随之退出），开机自启照旧。 */
export async function quit(exit: () => void = () => process.exit(0)): Promise<void> {
  fs.mkdirSync(path.dirname(flag("quit")), { recursive: true });
  fs.writeFileSync(flag("quit"), `${new Date().toISOString()}\n`);
  setTimeout(exit, 300);
}

export function upgradeStatus(): UpgradeStatus {
  try { const f = path.join(home(), "logs", "upgrade.log"); return parseUpgradeLog(fs.readFileSync(f, "utf8"), Date.now(), fs.statSync(f).mtimeMs); } catch { return { running: false }; }
}

/** 在后台启动升级（脱离当前进程树）。在会话 0 里启动时，安装包需要提权的步骤弹不出 UAC，会如实失败；身体助手在用户桌面里启动则可以。 */
export function startUpgrade(version?: string, id = String(Date.now())): void {
  const v = version && VERSION_RE.test(version) ? version : "";
  const log = path.join(home(), "logs", "upgrade.log");
  // 安装脚本自己写开始、每一步与退出码（同 Linux 的格式）；连脚本都下载不下来时，由这里补上开始与失败，控制台才看得到原因
  const inner = `$env:QUETZAL_VERSION=${psq(v)}; $env:QUETZAL_UPGRADE='1'; $env:QUETZAL_UPGRADE_ID=${psq(id)}
try { $script = Invoke-RestMethod -UseBasicParsing ${psq(INSTALL_PS1)} } catch {
  $u = [System.Text.UTF8Encoding]::new($false); New-Item -ItemType Directory -Force -Path ${psq(path.dirname(log))} | Out-Null
  [IO.File]::AppendAllText(${psq(log)}, ${psq(`== 升级 ${id} 开始 `)} + (Get-Date).ToString('s') + ${psq(v ? `（目标 ${v}）` : "")} + "\`n" + ${psq("✗ 下载安装脚本失败：")} + $_.Exception.Message + "\`n" + ${psq(`== 升级 ${id} 退出码 1`)} + "\`n", $u)
  exit 1 }
Invoke-Expression $script`;
  const enc = Buffer.from(inner, "utf16le").toString("base64");
  const launcher = `Start-Process -FilePath ${psq(powershell())} -WindowStyle Hidden -ArgumentList '-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand','${enc}'`;
  const p = spawn(powershell(), ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", launcher], { stdio: "ignore", windowsHide: true, detached: false, env: { ...process.env, QUETZAL_HOME: home() } });
  p.unref();
}

export async function upgrade(version?: string, viaDesktop?: (id: string, v?: string) => Promise<boolean>): Promise<string> {
  if (version !== undefined && !VERSION_RE.test(version)) throw new Error("版本号不对");
  if (upgradeStatus().running) return "已经在升级了，等它结束";
  const id = String(Date.now());
  if (!(viaDesktop && await viaDesktop(id, version).catch(() => false))) startUpgrade(version, id);
  return `已在后台开始升级${version ? `到 ${version}` : ""}（日志 ${path.join(home(), "logs", "upgrade.log")}）：约一分钟后会重启一次，这期间控制台会短暂断开。`;
}
