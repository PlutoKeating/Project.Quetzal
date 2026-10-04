// Linux 身体的守护开关：开机自启 + 退出后自动重启，一个开关管两件事。
//   systemd 用户服务（npm 包 / 一键安装脚本注册的 quetzal.service）：开 = enable 且没有 Restart=no 的覆盖片段；
//     关 = disable + 写覆盖片段 ~/.config/systemd/user/quetzal.service.d/quetzal-off.conf（Restart=no），daemon-reload 后对运行中的服务立即生效。
//   守护循环（没有 systemd 的机器，一键安装脚本写的 ~/.quetzal/bin/quetzal-supervise）：开关是标志文件 state/supervise.off——
//     循环看到它就暂停拉起（自己不退出），同时增删 crontab 的 @reboot 行与桌面自启动项。
//   两者都没有（手动部署）：不可用，控制台不显示开关。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SupervisionState } from "../../src/body/adapter.ts";
import { run, have } from "./linux.ts";

const UNIT = "quetzal";
const home = () => process.env.QUETZAL_HOME ?? path.join(os.homedir(), ".quetzal");
const configDir = () => process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
const unitFile = () => path.join(configDir(), "systemd", "user", `${UNIT}.service`);
const dropIn = () => path.join(configDir(), "systemd", "user", `${UNIT}.service.d`, "quetzal-off.conf");
const supervisor = () => path.join(home(), "bin", "quetzal-supervise");
const offFlag = () => path.join(home(), "state", "supervise.off");
const autostart = () => path.join(configDir(), "autostart", "quetzal-runtime.desktop");

export const DROPIN_OFF = "# 由控制台「守护」开关写入：退出后不再自动重启。打开开关或重跑安装命令会删掉这个文件。\n[Service]\nRestart=no\n";
export const autostartText = (sup: string) => `[Desktop Entry]\nType=Application\nName=Quetzal runtime\nComment=Quetzal 运行基座的守护循环（登录桌面时拉起）\nExec="${sup}"\nNoDisplay=true\nX-GNOME-Autostart-enabled=true\n`;

/** crontab 文本里有没有拉起这个守护循环的 @reboot 行。 */
export const hasRebootLine = (crontab: string, sup: string) => crontab.split("\n").some((l) => /^\s*@reboot\s/.test(l) && l.includes(sup));
/** 增删 @reboot 行后的 crontab 文本（其余行原样保留）。 */
export function withRebootLine(crontab: string, sup: string, on: boolean): string {
  const lines = crontab.split("\n").filter((l) => !l.includes(sup));
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  if (on) lines.push(`@reboot ${sup}`);
  return lines.length ? lines.join("\n") + "\n" : "";
}

const sysctl = (...args: string[]) => run("systemctl", ["--user", ...args], 15_000);
const hasDesktop = () => Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY) || ["/usr/share/xsessions", "/usr/share/wayland-sessions"].some((d) => { try { return fs.readdirSync(d).some((f) => f.endsWith(".desktop")); } catch { return false; } });

export async function status(): Promise<SupervisionState> {
  if (fs.existsSync(unitFile()) && have("systemctl")) {
    const enabled = (await sysctl("is-enabled", UNIT)).out.trim() === "enabled";
    const off = fs.existsSync(dropIn());
    return { available: true, kind: "systemd", enabled: enabled && !off, detail: `systemd 用户服务 ${UNIT}：开机自启，退出 3 秒后自动重启${off ? "（已关闭：退出后不再拉起）" : ""}` };
  }
  if (fs.existsSync(supervisor())) {
    const off = fs.existsSync(offFlag());
    return { available: true, kind: "loop", enabled: !off, detail: `守护循环 ${supervisor()}：crontab @reboot / 桌面自启动拉起，退出 3 秒后自动重启${off ? "（已暂停）" : ""}` };
  }
  return { available: false, kind: "none", enabled: false, detail: "这具身体没有可控制的守护者（手动运行或自定义部署）" };
}

export async function set(enabled: boolean): Promise<void> {
  const s = await status();
  if (!s.available) throw new Error("这具身体没有可控制的守护者");
  if (s.kind === "systemd") {
    if (enabled) {
      fs.rmSync(dropIn(), { force: true });
      await sysctl("daemon-reload");
      const r = await sysctl("enable", UNIT);
      if (r.code !== 0) throw new Error(`systemctl --user enable 失败：${r.out.trim().slice(0, 200)}`);
    } else {
      fs.mkdirSync(path.dirname(dropIn()), { recursive: true });
      fs.writeFileSync(dropIn(), DROPIN_OFF);
      await sysctl("daemon-reload");
      await sysctl("disable", UNIT);
    }
    return;
  }
  // 守护循环：标志文件 + 开机项
  const sup = supervisor();
  if (enabled) fs.rmSync(offFlag(), { force: true });
  else { fs.mkdirSync(path.dirname(offFlag()), { recursive: true }); fs.writeFileSync(offFlag(), `${new Date().toISOString()}\n`); }
  if (have("crontab")) {
    const cur = await run("crontab", ["-l"], 10_000);
    const text = cur.code === 0 ? cur.out : "";
    if (hasRebootLine(text, sup) !== enabled) await run("crontab", ["-"], 10_000, withRebootLine(text, sup, enabled));
  }
  if (enabled) { if (hasDesktop()) { fs.mkdirSync(path.dirname(autostart()), { recursive: true }); fs.writeFileSync(autostart(), autostartText(sup)); } }
  else fs.rmSync(autostart(), { force: true });
}
