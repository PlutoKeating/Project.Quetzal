// 安卓身体的守护开关：Termux:Boot 开机脚本（~/.termux/boot/quetzal）+ runit 服务（$PREFIX/var/service/quetzal）。
//   开 = 开机脚本在且服务目录里没有 down 文件（runit 开机即拉起、退出即重启）；
//   关 = 删开机脚本、放 down 文件、sv once（正在运行的进程不动，但退出后不再拉起）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SupervisionState } from "../../src/body/adapter.ts";
import { run } from "./termux.ts";

const PREFIX = process.env.PREFIX ?? "/data/data/com.termux/files/usr";
const SV = path.join(PREFIX, "var", "service", "quetzal");
const BOOT = path.join(os.homedir(), ".termux", "boot", "quetzal");
export const BOOT_SCRIPT = "#!/data/data/com.termux/files/usr/bin/sh\n# Termux:Boot 开机脚本：保持 CPU 唤醒，启动 runit（quetzal 由其守护）\ntermux-wake-lock\n. $PREFIX/etc/profile.d/start-services.sh\n";

export async function status(): Promise<SupervisionState> {
  if (!fs.existsSync(path.join(SV, "run"))) return { available: false, kind: "none", enabled: false, detail: "没有找到 runit 服务 quetzal" };
  const boot = fs.existsSync(BOOT), down = fs.existsSync(path.join(SV, "down"));
  return { available: true, kind: "runit", enabled: boot && !down, detail: `runit 服务 quetzal（退出即重启）+ Termux:Boot 开机脚本${!boot ? "（开机脚本已移除）" : ""}${down ? "（服务已标记 down）" : ""}` };
}

export async function set(enabled: boolean): Promise<void> {
  if (!fs.existsSync(path.join(SV, "run"))) throw new Error("没有找到 runit 服务 quetzal");
  if (enabled) {
    fs.mkdirSync(path.dirname(BOOT), { recursive: true });
    fs.writeFileSync(BOOT, BOOT_SCRIPT, { mode: 0o700 });
    fs.rmSync(path.join(SV, "down"), { force: true });
    await run("sv", ["up", "quetzal"], 10_000);
  } else {
    fs.rmSync(BOOT, { force: true });
    fs.writeFileSync(path.join(SV, "down"), "");
    await run("sv", ["once", "quetzal"], 10_000); // 正在跑的继续跑，退出后不再拉起
  }
}
