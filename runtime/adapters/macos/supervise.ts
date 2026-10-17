// macOS 身体的守护开关：launchd 用户代理 ~/Library/LaunchAgents/xyz.quetzal.runtime.plist（npm 包 / 一键安装脚本写的，见 cli/src/launchd.ts）。
//   代理以 /bin/sh 包一层运行 node：RunAtLoad（登录时拉起）+ KeepAlive {SuccessfulExit: false}（包装脚本非零退出就由 launchd 重启）。
//   包装脚本在运行基座退出后看两个标志：state/quit（托盘的「退出」：这一次不再拉起，删掉标志）与 state/supervise.off（守护开关关闭：不再拉起）——
//   有其一就以 0 退出，launchd 不再重启；否则以 1 退出，3 秒后被重新拉起。
//   开关：关 = 写 state/supervise.off + launchctl disable（下次登录不再加载）；开 = 删标志 + launchctl enable（没在运行就 bootstrap 拉起）。
//   没有 plist（手动运行、自定义部署）：不可用，控制台不显示开关。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SupervisionState } from "../../src/body/adapter.ts";
import { run } from "./mac.ts";

export const LABEL = "xyz.quetzal.runtime";
const home = () => process.env.QUETZAL_HOME ?? path.join(os.homedir(), ".quetzal");
export const plistFile = () => path.join(os.homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const offFlag = () => path.join(home(), "state", "supervise.off");
const uid = () => process.getuid?.() ?? 0;
/** launchd 的域：有图形登录会话用 gui/<uid>，否则（只有 ssh 会话）user/<uid>。 */
export async function domain(): Promise<string> {
  return (await run("launchctl", ["print", `gui/${uid()}`], 10_000)).code === 0 ? `gui/${uid()}` : `user/${uid()}`;
}

/** `launchctl print-disabled <域>` 的输出里这个代理是不是被停用了（新系统写 => disabled，旧系统写 => true）。 */
export function isDisabled(printDisabled: string, label = LABEL): boolean {
  const m = printDisabled.match(new RegExp(`"${label.replace(/\./g, "\\.")}"\\s*=>\\s*(\\w+)`));
  return Boolean(m && /^(disabled|true)$/i.test(m[1]));
}
/** `launchctl print <域>/<标签>` 的输出：state = running 与 pid。 */
export function parsePrint(out: string): { running: boolean; pid?: number } {
  const pid = out.match(/^\s*pid\s*=\s*(\d+)/m)?.[1];
  return { running: /^\s*state\s*=\s*running/m.test(out), pid: pid ? Number(pid) : undefined };
}

export async function status(): Promise<SupervisionState> {
  if (!fs.existsSync(plistFile())) return { available: false, kind: "none", enabled: false, detail: "这具身体没有可控制的守护者（手动运行或自定义部署）" };
  const d = await domain();
  const disabled = isDisabled((await run("launchctl", ["print-disabled", d], 10_000)).out);
  const off = fs.existsSync(offFlag());
  return { available: true, kind: "launchd", enabled: !disabled && !off, detail: `launchd 用户代理 ${LABEL}：登录时拉起，退出 3 秒后自动重启${off || disabled ? "（已关闭：退出后不再拉起，下次登录不再自启）" : ""}` };
}

export async function set(enabled: boolean): Promise<void> {
  const s = await status();
  if (!s.available) throw new Error("这具身体没有可控制的守护者");
  const d = await domain();
  if (enabled) {
    fs.rmSync(offFlag(), { force: true });
    await run("launchctl", ["enable", `${d}/${LABEL}`], 10_000);
    if ((await run("launchctl", ["print", `${d}/${LABEL}`], 10_000)).code !== 0) await run("launchctl", ["bootstrap", d, plistFile()], 20_000);
  } else {
    fs.mkdirSync(path.dirname(offFlag()), { recursive: true });
    fs.writeFileSync(offFlag(), `${new Date().toISOString()}\n`);
    await run("launchctl", ["disable", `${d}/${LABEL}`], 10_000);
  }
}

/** 退出（托盘的「退出」）：放 state/quit，进程退出后包装脚本看到它就以 0 退出，launchd 这一次不再拉起；下次登录照常。300 毫秒后自己退出。 */
export async function quit(exit: () => void = () => process.exit(0)): Promise<void> {
  fs.mkdirSync(path.join(home(), "state"), { recursive: true });
  fs.writeFileSync(path.join(home(), "state", "quit"), `${new Date().toISOString()}\n`);
  setTimeout(exit, 300);
}
