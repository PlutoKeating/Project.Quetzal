// systemd 用户服务：写单元、启停、状态与日志。没有 systemd 用户实例（容器、未开 systemd 的 WSL）时由 install 流程提示改用 `windler run`。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";

export const UNIT = "windler";
export const unitFile = () => path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), "systemd", "user", `${UNIT}.service`);

/** 单元文件内容：node 直接运行 current/main.cjs，适配器为 current/linux.mjs；退出即重启（熔断在运行基座内）。 */
export function unitText(o: { home: string; node: string }): string {
  return `# 由 npx windler 生成；改动会在下次 windler install 时被覆盖
[Unit]
Description=Windler runtime
After=network-online.target
Wants=network-online.target

[Service]
Environment=WINDLER_HOME=${o.home}
Environment=WINDLER_ADAPTER=${o.home}/current/linux.mjs
WorkingDirectory=${o.home}/current
ExecStart=${o.node} --enable-source-maps ${o.home}/current/main.cjs
Restart=always
RestartSec=3
KillMode=mixed
TimeoutStopSec=20

[Install]
WantedBy=default.target
`;
}

export function run(cmd: string, args: string[], timeoutMs = 30_000): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 4 << 20 }, (e: any, out, err) =>
    resolve({ code: e ? (typeof e.code === "number" ? e.code : 1) : 0, out: String(out) + String(err) })));
}
const sysctl = (...args: string[]) => run("systemctl", ["--user", ...args]);

/** 这个用户有没有可用的 systemd 用户实例。 */
export async function available(): Promise<boolean> {
  return (await sysctl("show-environment")).code === 0;
}

export async function install(o: { home: string; node: string }) {
  const f = unitFile();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, unitText(o));
  await sysctl("daemon-reload");
  const r = await sysctl("enable", UNIT);
  if (r.code !== 0) throw new Error(`启用服务失败：${r.out.trim()}`);
}

export const restart = async () => { const r = await sysctl("restart", UNIT); if (r.code !== 0) throw new Error(`启动服务失败：${r.out.trim()}`); };
export const stop = () => sysctl("stop", UNIT);
export const start = () => sysctl("start", UNIT);
export const isActive = async () => (await sysctl("is-active", UNIT)).out.trim() === "active";
export const isInstalled = () => fs.existsSync(unitFile());

export async function uninstall() {
  await sysctl("disable", "--now", UNIT);
  fs.rmSync(unitFile(), { force: true });
  await sysctl("daemon-reload");
}

/** 让用户服务在没有登录会话时也运行（服务器、重启后未登录）。可能需要认证，失败只提示。 */
export async function enableLinger(): Promise<boolean> {
  return (await run("loginctl", ["enable-linger", os.userInfo().username])).code === 0;
}

/** 服务日志（journald）；follow 为真时持续输出直到 Ctrl-C。 */
export function logs(lines = 80, follow = false): Promise<number> {
  const p = spawn("journalctl", ["--user", "-u", UNIT, "-n", String(lines), "--no-pager", "-o", "cat", ...(follow ? ["-f"] : [])], { stdio: "inherit" });
  return new Promise((r) => p.on("exit", (c) => r(c ?? 0)));
}
