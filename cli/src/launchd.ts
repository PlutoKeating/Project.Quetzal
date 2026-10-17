// macOS 的守护：launchd 用户代理 ~/Library/LaunchAgents/xyz.quetzal.runtime.plist（与 Linux 的 service.ts 同一组函数）。
//   代理运行一段 /bin/sh 包装脚本（路径经环境变量传入，plist 里只需 XML 转义）：日志超过 10 MB 轮转一份，前台运行 node current/main.cjs，
//   运行基座退出后——state/quit（托盘的「退出」）或 state/supervise.off（控制台关了守护开关）在就以 0 退出，launchd 不再拉起；
//   否则以 1 退出，KeepAlive {SuccessfulExit: false} 让 launchd 3 秒后（ThrottleInterval）重新拉起。RunAtLoad：登录时拉起。
//   launchd 的用户代理在这个用户登录图形界面后运行（没人登录的 Mac 上不跑；只有 ssh 会话时退到 user/<uid> 域，注销即停）。
//   日志写 <家目录>/logs/runtime.log（launchd 不管日志），quetzal logs 读它。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { run } from "./service.ts";

export const LABEL = "xyz.quetzal.runtime";
export const NAME = `launchd 用户代理 ${LABEL}`;
export const plistFile = () => path.join(os.homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const uid = () => process.getuid?.() ?? 0;

/** 包装脚本（/bin/sh -c 的参数）。只用环境变量里的路径，不含任何拼进来的路径。 */
export const WRAPPER = [
  'H="$QUETZAL_HOME"; L="$H/logs/runtime.log"',
  'mkdir -p "$H/logs" "$H/state"; rm -f "$H/state/quit"',
  'if [ -f "$L" ] && [ "$(wc -c <"$L")" -gt 10485760 ]; then mv -f "$L" "$L.1"; fi',
  'cd "$H/current" || { echo "no current version" >>"$L"; exit 1; }',
  '"$QUETZAL_NODE" --enable-source-maps "$H/current/main.cjs" >>"$L" 2>&1 &',
  'child=$!',
  "trap 'kill -TERM \"$child\" 2>/dev/null' TERM INT",
  'wait "$child"; code=$?',
  'while kill -0 "$child" 2>/dev/null; do wait "$child"; code=$?; done',
  'if [ -e "$H/state/quit" ]; then rm -f "$H/state/quit"; exit 0; fi',
  'if [ -e "$H/state/supervise.off" ]; then exit 0; fi',
  'echo "runtime exited ($code), launchd restarts it" >>"$L"; exit 1',
].join("\n");

/** XML 文本转义（plist 的 <string>）。 */
export const xml = (s: string) => {
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(s)) throw new Error(`路径里有控制字符：${JSON.stringify(s)}`);
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
};

/** plist 内容：node 与家目录的路径都在 EnvironmentVariables 里；PATH 带上 node 所在目录、Homebrew 与系统目录（cliclick、ffmpeg、git 在这些地方）。 */
export function plistText(o: { home: string; node: string }): string {
  if (/[\n\r]/.test(o.home + o.node)) throw new Error("路径里不能有换行");
  const env: Record<string, string> = {
    QUETZAL_HOME: o.home,
    QUETZAL_ADAPTER: `${o.home}/current/macos.mjs`,
    QUETZAL_NODE: o.node,
    PATH: [path.dirname(o.node), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].filter((d, i, a) => a.indexOf(d) === i).join(":"),
    LANG: "en_US.UTF-8",
  };
  const kv = (k: string, v: string) => `\t\t<key>${xml(k)}</key>\n\t\t<string>${xml(v)}</string>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- 由 npx @plutokeating/quetzal 生成；改动会在下次 quetzal install 时被覆盖 -->
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${LABEL}</string>
	<key>ProgramArguments</key>
	<array>
		<string>/bin/sh</string>
		<string>-c</string>
		<string>${xml(WRAPPER)}</string>
	</array>
	<key>EnvironmentVariables</key>
	<dict>
${Object.entries(env).map(([k, v]) => kv(k, v)).join("\n")}
	</dict>
	<key>WorkingDirectory</key>
	<string>${xml(o.home)}</string>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<dict>
		<key>SuccessfulExit</key>
		<false/>
	</dict>
	<key>ThrottleInterval</key>
	<integer>3</integer>
	<key>ExitTimeOut</key>
	<integer>20</integer>
	<key>StandardOutPath</key>
	<string>${xml(`${o.home}/logs/launchd.log`)}</string>
	<key>StandardErrorPath</key>
	<string>${xml(`${o.home}/logs/launchd.log`)}</string>
</dict>
</plist>
`;
}

const lc = (...args: string[]) => run("launchctl", args);
/** launchd 的域：有图形登录会话用 gui/<uid>，否则 user/<uid>。 */
export async function domain(): Promise<string> { return (await lc("print", `gui/${uid()}`)).code === 0 ? `gui/${uid()}` : `user/${uid()}`; }
const loaded = async (d: string) => (await lc("print", `${d}/${LABEL}`)).code === 0;

/** 这台 Mac 上能不能注册 launchd 用户代理。 */
export async function available(): Promise<boolean> {
  return process.platform === "darwin" && fs.existsSync("/bin/launchctl");
}

export async function install(o: { home: string; node: string }) {
  const f = plistFile();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.mkdirSync(path.join(o.home, "logs"), { recursive: true });
  fs.writeFileSync(f, plistText(o), { mode: 0o644 });
  const d = await domain();
  if (await loaded(d)) await lc("bootout", `${d}/${LABEL}`); // 换成新写的 plist（bootout 会停掉正在运行的版本，下面马上拉起）
  await lc("enable", `${d}/${LABEL}`);
  const r = await lc("bootstrap", d, f);
  if (r.code !== 0 && !(await loaded(d))) throw new Error(`注册 launchd 用户代理失败：${r.out.trim()}`);
}

export async function restart() {
  const d = await domain();
  const r = (await loaded(d)) ? await lc("kickstart", "-k", `${d}/${LABEL}`) : await lc("bootstrap", d, plistFile());
  if (r.code !== 0) throw new Error(`启动服务失败：${r.out.trim()}`);
}
/** 停止：卸下代理（plist 留着，下次登录照常拉起；quetzal start 再拉起）。 */
export async function stop() { const d = await domain(); return lc("bootout", `${d}/${LABEL}`); }
export async function start() { const d = await domain(); return (await loaded(d)) ? lc("kickstart", `${d}/${LABEL}`) : lc("bootstrap", d, plistFile()); }
export async function isActive() { const d = await domain(); return /^\s*state\s*=\s*running/m.test((await lc("print", `${d}/${LABEL}`)).out); }
export const isInstalled = () => fs.existsSync(plistFile());

export async function uninstall() {
  const d = await domain();
  await lc("bootout", `${d}/${LABEL}`);
  fs.rmSync(plistFile(), { force: true });
}

/** launchd 没有 linger 的概念：用户代理在登录后运行，什么也不做。 */
export async function enableLinger(): Promise<boolean> { return true; }

/** 服务日志：<家目录>/logs/runtime.log；follow 为真时持续输出直到 Ctrl-C。 */
export function logs(lines = 80, follow = false, home = process.env.QUETZAL_HOME ?? path.join(os.homedir(), ".quetzal")): Promise<number> {
  const f = path.join(home, "logs", "runtime.log");
  if (!fs.existsSync(f)) { console.log(`还没有日志（${f}）`); return Promise.resolve(0); }
  const p = spawn("tail", ["-n", String(lines), ...(follow ? ["-F"] : []), f], { stdio: "inherit" });
  return new Promise((r) => p.on("exit", (c) => r(c ?? 0)));
}
