#!/usr/bin/env node
// soul-bridge：把 Hermes Agent / OpenClaw 接入 agent 的灵魂仓库，随时插拔。
// 这些命令由框架里的 agent 按技能说明代为执行（见 skills/soul-bridge/SKILL.md），用户不需要使用命令行。
//
//   init --framework hermes|openclaw --repo <git 地址> [--agent <名>] [--home <目录>] [--body <身体名>] [--name <显示名>] [--poll <秒>]
//   attach [--agent <名>]      安装钩子与后台服务（init 之后自动执行）
//   sync   [--agent <名>]      立即同步一次（钩子调用）
//   run    [--agent <名>]      前台守护（服务调用）
//   status [--agent <名>]      查看状态
//   detach [--agent <名>] [--purge]  卸载钩子与服务；框架里的文件保持原样；--purge 同时删除本地仓库副本
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { frameworks, detect } from "./frameworks/index.ts";
import { loadConfig, saveConfig, keyPath, repoDir, dirOf, listAgents } from "./config.ts";
import { repoOf, ensureIdentity, syncOnce, VERSION } from "./bridge.ts";
import { runDaemon, installService, removeService } from "./service.ts";

const CLI = fileURLToPath(import.meta.url);
const args = process.argv.slice(2);
const cmd = args[0] ?? "status";
const opt = (k: string) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : undefined; };
const say = (s: string) => console.log(s);

async function attach(agent: string) {
  const c = loadConfig(agent);
  const fw = frameworks[c.framework];
  say(await fw.installHooks(c.home, [process.execPath, CLI, "sync", "--agent", c.agent, "--quiet"]));
  say(await installService(c, CLI));
}

async function main() {
  if (cmd === "init") {
    const framework = opt("framework") ?? detect()[0];
    if (!framework || !frameworks[framework]) throw new Error(`请用 --framework 指定：${Object.keys(frameworks).join(" / ")}`);
    const remote = opt("repo");
    if (!remote) throw new Error("请用 --repo 指定灵魂仓库地址（推荐 GitHub 私有仓库的 SSH 地址）");
    const fw = frameworks[framework];
    const agent = opt("agent") ?? path.basename(remote).replace(/\.git$/, "").replace(/\.soul$/i, "").toLowerCase();
    const c = { agent, framework, home: opt("home") ?? fw.defaultHome(), remote, branch: opt("branch") ?? "main", body: opt("body") ?? `${framework}-${os.hostname()}`.toLowerCase(), poll: Number(opt("poll") ?? 300) };
    saveConfig(c);
    if (!fs.existsSync(keyPath(agent))) execFileSync("ssh-keygen", ["-t", "ed25519", "-N", "", "-C", `soul-bridge@${c.body}`, "-f", keyPath(agent)], { stdio: "ignore" });
    const repo = repoOf(c);
    const how = await repo.ensure();
    if (how === "initialized" && remote) {
      say(`无法访问灵魂仓库。请把下面这把公钥添加到仓库的 Deploy keys（勾选 Allow write access），然后重新运行 init：\n${fs.readFileSync(keyPath(agent) + ".pub", "utf8").trim()}`);
      fs.rmSync(repoDir(agent), { recursive: true, force: true });
      process.exitCode = 2; return;
    }
    await repo.pull();
    ensureIdentity(c, opt("name"));
    const r = await syncOnce(c);
    say(`已接入：${agent} ↔ ${fw.label}（${c.home}），身体名 ${c.body}。首次同步：框架 ${r.changedNative.length} 处、灵魂 ${r.changedSoul.length} 处。`);
    await attach(agent);
    return;
  }
  const c = loadConfig(opt("agent"));
  if (cmd === "attach") return attach(c.agent);
  if (cmd === "sync") { const r = await syncOnce(c); if (!args.includes("--quiet")) say(JSON.stringify(r, null, 2)); return; }
  if (cmd === "run") return runDaemon(c);
  if (cmd === "detach") {
    await frameworks[c.framework].removeHooks(c.home);
    await removeService(c.agent);
    if (args.includes("--purge")) fs.rmSync(dirOf(c.agent), { recursive: true, force: true });
    say(`已拔出 ${c.agent}：钩子与服务已移除，${frameworks[c.framework].label} 中的文件保持原样。${args.includes("--purge") ? "本地仓库副本已删除。" : ""}`);
    return;
  }
  if (cmd === "status") {
    let last = {};
    try { last = JSON.parse(fs.readFileSync(path.join(dirOf(c.agent), "last-sync.json"), "utf8")); } catch {}
    say(JSON.stringify({ version: VERSION, agents: listAgents(), config: c, lastSync: last, publicKey: fs.existsSync(keyPath(c.agent) + ".pub") ? fs.readFileSync(keyPath(c.agent) + ".pub", "utf8").trim() : null }, null, 2));
    return;
  }
  throw new Error(`未知命令：${cmd}`);
}

main().catch((e) => { console.error(`soul-bridge：${e.message}`); process.exit(1); });
