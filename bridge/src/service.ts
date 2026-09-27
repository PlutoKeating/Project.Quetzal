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
  await sh("loginctl", ["enable-linger", os.userInfo().username]); // 未登录时也保持运行（失败无妨）
  return ok ? `已安装并启动 systemd 用户服务 ${unitName(c.agent)}` : `已写入 ${f}，但 systemctl 启动失败（可能不是 systemd 系统），可以改用 run 命令常驻`;
}

export async function removeService(agent: string) {
  if (process.env.SOUL_BRIDGE_NO_SERVICE) return;
  if (process.platform === "darwin") {
    const f = path.join(os.homedir(), "Library/LaunchAgents", `dev.soulbridge.${agent}.plist`);
    await sh("launchctl", ["unload", f]); fs.rmSync(f, { force: true }); return;
  }
  await sh("systemctl", ["--user", "disable", "--now", unitName(agent)]);
  fs.rmSync(path.join(os.homedir(), ".config/systemd/user", `${unitName(agent)}.service`), { force: true });
  await sh("systemctl", ["--user", "daemon-reload"]);
}
