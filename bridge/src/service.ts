// 守护与服务：watch 框架文件变化（事件驱动）+ 可选的远端拉取间隔；安装为 systemd 用户服务或 launchd 代理。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { frameworks } from "./frameworks/index.ts";
import { syncOnce } from "./bridge.ts";
import type { BridgeConfig } from "./types.ts";

const sh = (cmd: string, args: string[]) => new Promise<boolean>((r) => execFile(cmd, args, (e) => r(!e)));

export async function runDaemon(c: BridgeConfig) {
  const log = (m: string) => console.log(`[${new Date().toISOString()}] ${m}`);
  let timer: NodeJS.Timeout | undefined, quietUntil = 0;
  const go = async (why: string) => {
    try {
      const r = await syncOnce(c);
      quietUntil = Date.now() + 3000; // 忽略自己写回文件触发的事件
      if (r.changedNative.length || r.changedSoul.length) log(`${why}：框架 ${r.changedNative.length} 处、灵魂 ${r.changedSoul.length} 处${r.conflicts.length ? `、自动解决冲突 ${r.conflicts.length} 处` : ""}`);
    } catch (e: any) { log(`同步失败：${e.message}`); }
  };
  const schedule = (why: string) => { if (Date.now() < quietUntil) return; clearTimeout(timer); timer = setTimeout(() => go(why), 3000); };
  // 监视框架的原生文件所在目录
  const dirs = new Set<string>();
  for (const m of frameworks[c.framework].mappings(c.home, c.body)) {
    const d = "native" in m ? path.dirname(m.native) : "nativeDir" in m ? m.nativeDir : undefined;
    if (d) { fs.mkdirSync(d, { recursive: true }); dirs.add(d); }
  }
  for (const d of dirs) fs.watch(d, { persistent: true }, () => schedule(`本地变化（${path.basename(d)}）`));
  if (c.poll > 0) setInterval(() => go("拉取远端"), c.poll * 1000); // 传输层拉取，与 agent 的醒来无关
  log(`soul-bridge 守护中：${c.agent} ↔ ${frameworks[c.framework].label}（${c.home}）${c.poll ? `，每 ${c.poll} 秒拉取远端` : ""}`);
  await go("启动");
}

const unitName = (agent: string) => `soul-bridge-${agent}`;

export async function installService(c: BridgeConfig, cli: string): Promise<string> {
  if (process.env.SOUL_BRIDGE_NO_SERVICE) return "（已跳过后台服务安装）";
  const node = process.execPath;
  if (process.platform === "darwin") {
    const f = path.join(os.homedir(), "Library/LaunchAgents", `dev.soulbridge.${c.agent}.plist`);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>dev.soulbridge.${c.agent}</string>
<key>ProgramArguments</key><array><string>${node}</string><string>${cli}</string><string>run</string><string>--agent</string><string>${c.agent}</string></array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>${path.join(os.homedir(), ".agent-soul", c.agent, "bridge.log")}</string>
<key>StandardErrorPath</key><string>${path.join(os.homedir(), ".agent-soul", c.agent, "bridge.log")}</string>
</dict></plist>
`);
    await sh("launchctl", ["unload", f]);
    return (await sh("launchctl", ["load", f])) ? `已安装 launchd 代理 ${f}` : `已写入 ${f}，但 launchctl 加载失败`;
  }
  const f = path.join(os.homedir(), ".config/systemd/user", `${unitName(c.agent)}.service`);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, `[Unit]
Description=soul-bridge：${c.agent} ↔ ${frameworks[c.framework].label}
After=network-online.target

[Service]
ExecStart=${node} ${cli} run --agent ${c.agent}
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
`);
  await sh("systemctl", ["--user", "daemon-reload"]);
  const ok = await sh("systemctl", ["--user", "enable", "--now", unitName(c.agent)]);
  if (ok) {
    await sh("loginctl", ["enable-linger", os.userInfo().username]); // 未登录时也保持运行（失败无妨）
    return `已安装并启动 systemd 用户服务 ${unitName(c.agent)}`;
  }
  fs.rmSync(f, { force: true });
  return fallbackService(c, cli);
}

/** 没有 systemd / launchd 时（容器、精简系统）：crontab @reboot 开机自启 + 立即在后台启动一个守护进程。 */
async function fallbackService(c: BridgeConfig, cli: string): Promise<string> {
  const log = path.join(os.homedir(), ".agent-soul", c.agent, "bridge.log");
  const line = `@reboot ${process.execPath} ${cli} run --agent ${c.agent} >> ${log} 2>&1 # soul-bridge:${c.agent}`;
  const cur = await new Promise<string>((r) => execFile("crontab", ["-l"], (_e, out) => r(String(out ?? ""))));
  const cron = cur.split("\n").filter((l) => l && !l.includes(`# soul-bridge:${c.agent}`)).concat(line).join("\n") + "\n";
  const cronOk = await new Promise<boolean>((r) => { const p = execFile("crontab", ["-"], (e) => r(!e)); p.stdin?.end(cron); });
  const { spawn } = await import("node:child_process");
  const out = fs.openSync(log, "a");
  spawn(process.execPath, [cli, "run", "--agent", c.agent], { detached: true, stdio: ["ignore", out, out] }).unref();
  fs.writeFileSync(path.join(os.homedir(), ".agent-soul", c.agent, "fallback"), "1");
  return `未检测到 systemd / launchd：已在后台启动守护进程${cronOk ? "，并用 crontab @reboot 设置开机自启" : "（crontab 不可用，重启后需要再次执行 attach）"}`;
}

export async function removeService(agent: string) {
  if (process.env.SOUL_BRIDGE_NO_SERVICE) return;
  if (process.platform === "darwin") {
    const f = path.join(os.homedir(), "Library/LaunchAgents", `dev.soulbridge.${agent}.plist`);
    await sh("launchctl", ["unload", f]); fs.rmSync(f, { force: true }); return;
  }
  if (fs.existsSync(path.join(os.homedir(), ".agent-soul", agent, "fallback"))) {
    const cur = await new Promise<string>((r) => execFile("crontab", ["-l"], (_e, out) => r(String(out ?? ""))));
    await new Promise<void>((r) => { const p = execFile("crontab", ["-"], () => r()); p.stdin?.end(cur.split("\n").filter((l) => l && !l.includes(`# soul-bridge:${agent}`)).join("\n") + "\n"); });
    await sh("pkill", ["-f", `run --agent ${agent}`]);
  }
  await sh("systemctl", ["--user", "disable", "--now", unitName(agent)]);
  fs.rmSync(path.join(os.homedir(), ".config/systemd/user", `${unitName(agent)}.service`), { force: true });
  await sh("systemctl", ["--user", "daemon-reload"]);
}
