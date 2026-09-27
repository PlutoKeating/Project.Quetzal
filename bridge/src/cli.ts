#!/usr/bin/env node
// soul-bridge：把 Hermes Agent / OpenClaw 接入 agent 的灵魂仓库，随时插拔。
// 这些命令由框架里的 agent 按技能说明代为执行（skills/soul-bridge/SKILL.md），用户不需要使用命令行。
//
//   init   [--framework hermes|openclaw] [--repo <owner/name | git 地址>] [--agent <短名>] [--name <显示名>]
//          [--home <目录>] [--body <身体名>] [--poll <秒>]
//          一条命令完成：识别框架 → 生成部署密钥 → （有 gh 或 GITHUB_TOKEN 时）创建私有仓库并添加可写部署密钥
//          → 克隆 → 导入现有人格与记忆 → 安装钩子（Hermes 预先批准）→ 安装后台服务 → 首次同步
//   doctor [--agent]            逐项自检，输出 JSON（ok 与每项的 fix 建议）
//   sync   [--agent] [--quiet]  立即同步一次（钩子调用）
//   run    [--agent]            前台守护（服务调用）
//   attach [--agent]            重新安装钩子与后台服务
//   status [--agent]            配置、最近一次同步、公钥
//   detach [--agent] [--purge]  拔出：移除钩子与服务，框架文件保持原样；--purge 同时删除本地副本
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile, execFileSync } from "node:child_process";
import { frameworks, detect } from "./frameworks/index.ts";
import { loadConfig, saveConfig, keyPath, repoDir, dirOf, listAgents } from "./config.ts";
import { repoOf, syncOnce, VERSION } from "./bridge.ts";
import { checkRemote } from "../../runtime/src/memory/soul-repo.ts";
import { runDaemon, installService, removeService } from "./service.ts";
import { parseGithub, sshUrl, whoami, ensurePrivateRepo, addDeployKey } from "./github.ts";
import type { BridgeConfig } from "./types.ts";

const CLI = fileURLToPath(import.meta.url);
const args = process.argv.slice(2);
const cmd = args[0] ?? "status";
const opt = (k: string) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : undefined; };
const say = (s: string) => console.log(s);
const slug = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
const sh = (c: string, a: string[]) => new Promise<{ ok: boolean; out: string }>((r) => execFile(c, a, { timeout: 60_000 }, (e, o, er) => r({ ok: !e, out: String(o || er) })));

async function attach(agent: string) {
  const c = loadConfig(agent);
  const fw = frameworks[c.framework];
  say(await fw.installHooks(c.home, [process.execPath, CLI, "sync", "--agent", c.agent, "--quiet"]));
  say(await installService(c, CLI));
}

async function init() {
  const found = detect();
  const framework = opt("framework") ?? (found.length === 1 ? found[0] : undefined);
  if (!framework || !frameworks[framework]) throw new Error(found.length > 1 ? `本机同时有 ${found.join("、")}，请用 --framework 指定` : `没有检测到 Hermes 或 OpenClaw，请用 --framework 与 --home 指定`);
  const fw = frameworks[framework];
  const home = opt("home") ?? fw.defaultHome();
  const displayName = opt("name") ?? fw.guessName?.(home);
  let repoArg = opt("repo");
  const agent = opt("agent") ?? (repoArg ? slug(path.basename(repoArg).replace(/\.git$/, "").replace(/\.soul$/i, "")) : slug(displayName ?? "") || "agent");

  // 仓库：未指定时，用已登录的 GitHub 账号自动创建 <用户>/<agent>.soul（私有）
  if (!repoArg) {
    const me = await whoami();
    if (!me) throw new Error("没有指定 --repo，本机也没有已登录的 gh 或 GITHUB_TOKEN，无法自动创建仓库。请向用户要一个私有仓库地址");
    repoArg = `${me}/${agent}.soul`;
  }
  const gh = parseGithub(repoArg);
  const remote = gh ? sshUrl(gh) : repoArg;
  const bad = checkRemote(remote); // 规范 §7：只允许 SSH 地址
  if (bad) throw new Error(bad);
  const c: BridgeConfig = { agent, framework, home, remote, branch: opt("branch") ?? "main", body: opt("body") ?? slug(`${framework}-${os.hostname()}`), poll: Number(opt("poll") ?? 300) };
  saveConfig(c);
  if (!fs.existsSync(keyPath(agent))) execFileSync("ssh-keygen", ["-t", "ed25519", "-N", "", "-C", `soul-bridge@${c.body}`, "-f", keyPath(agent)], { stdio: "ignore" });

  if (gh) {
    const repo = await ensurePrivateRepo(gh.owner, gh.name);
    if (repo) say(repo === "created" ? `已创建私有仓库 ${gh.owner}/${gh.name}` : `使用已有私有仓库 ${gh.owner}/${gh.name}`);
    const key = await addDeployKey(gh.owner, gh.name, keyPath(agent) + ".pub", `soul-bridge@${c.body}`);
    if (key === true) say("已添加可写部署密钥");
    else if (key === false) say("自动添加部署密钥失败（可能没有该仓库的管理权限），将尝试直接访问");
  }

  const repo = repoOf(c, displayName);
  const how = await repo.ensure();
  if (how === "initialized") {
    fs.rmSync(repoDir(agent), { recursive: true, force: true });
    say(JSON.stringify({ needHuman: true, reason: "无法访问灵魂仓库", ask: `请在仓库 ${gh ? `https://github.com/${gh.owner}/${gh.name}/settings/keys` : remote} 添加下面的 Deploy key，并勾选 Allow write access；完成后告诉我`, publicKey: fs.readFileSync(keyPath(agent) + ".pub", "utf8").trim(), retry: `node ${CLI} ${args.join(" ")}` }, null, 2));
    process.exitCode = 2; return;
  }
  await repo.pull();
  const r = await syncOnce(c);
  say(`已接入：${agent} ↔ ${fw.label}（${home}），身体名 ${c.body}。首次同步：框架 ${r.changedNative.length} 处、灵魂 ${r.changedSoul.length} 处。`);
  await attach(agent);
  await doctor(c, true);
}

/** 逐项自检。每项给出 ok 与修复建议，供 agent 自我修复。 */
async function doctor(c: BridgeConfig, brief = false) {
  const checks: { name: string; ok: boolean; detail?: string; fix?: string }[] = [];
  const add = (name: string, ok: boolean, detail?: string, fix?: string) => checks.push({ name, ok, detail, fix: ok ? undefined : fix });
  const [maj, min] = process.versions.node.split(".").map(Number);
  add("node", maj > 22 || (maj === 22 && min >= 18), process.versions.node, "升级 Node.js 到 22.18 以上");
  add("git", (await sh("git", ["--version"])).ok, undefined, "安装 git");
  add("框架目录", fs.existsSync(c.home), c.home, "用 attach 前确认 --home 指向正确的 Hermes 家目录或 OpenClaw 工作区");
  const ls = await repoOf(c).git("ls-remote", "origin", "HEAD");
  add("仓库访问", ls.code === 0, c.remote, "部署密钥未生效：重新运行 init，或请用户在仓库 Settings → Deploy keys 添加 status 输出的公钥（勾选写权限）");
  let last: any = {};
  try { last = JSON.parse(fs.readFileSync(path.join(dirOf(c.agent), "last-sync.json"), "utf8")); } catch {}
  add("最近同步", !!last.at && !last.error, last.at ? `${last.at}${last.error ? `：${last.error}` : ""}` : "从未", "运行 sync 查看错误");
  if (c.framework === "hermes") {
    const cfg = fs.existsSync(path.join(c.home, "config.yaml")) ? fs.readFileSync(path.join(c.home, "config.yaml"), "utf8") : "";
    add("Hermes 钩子", cfg.includes("soul-bridge"), undefined, "运行 attach");
  } else {
    add("OpenClaw 钩子", fs.existsSync(path.join(process.env.OPENCLAW_STATE_DIR ?? path.join(os.homedir(), ".openclaw"), "hooks", "soul-bridge", "handler.js")), undefined, "运行 attach，并确认 OpenClaw 配置中启用了 hooks.internal.entries[\"soul-bridge\"]");
  }
  const svc = process.platform === "darwin"
    ? (await sh("launchctl", ["list", `dev.soulbridge.${c.agent}`])).ok
    : (await sh("systemctl", ["--user", "is-active", `soul-bridge-${c.agent}`])).ok || (await sh("pgrep", ["-f", `run --agent ${c.agent}`])).ok;
  add("后台守护", svc, undefined, "运行 attach");
  let identity: any = {};
  try { identity = JSON.parse(fs.readFileSync(path.join(repoDir(c.agent), "agent.json"), "utf8")); } catch {}
  const result = { ok: checks.every((x) => x.ok), agent: identity.displayName ?? c.agent, body: c.body, framework: c.framework, checks };
  say(brief ? `自检：${result.ok ? "全部通过" : "有问题 → " + checks.filter((x) => !x.ok).map((x) => `${x.name}（${x.fix}）`).join("；")}` : JSON.stringify(result, null, 2));
  if (!result.ok && !brief) process.exitCode = 1;
}

async function main() {
  if (cmd === "init") return init();
  if (cmd === "version") return say(VERSION);
  const c = loadConfig(opt("agent"));
  if (cmd === "attach") return attach(c.agent);
  if (cmd === "doctor") return doctor(c);
  if (cmd === "sync") { const r = await syncOnce(c); if (!args.includes("--quiet")) say(JSON.stringify(r, null, 2)); return; }
  if (cmd === "run") return runDaemon(c);
  if (cmd === "detach") {
    await frameworks[c.framework].removeHooks(c.home);
    await removeService(c.agent);
    if (args.includes("--purge")) fs.rmSync(dirOf(c.agent), { recursive: true, force: true });
    say(`已拔出 ${c.agent}：钩子与服务已移除，${frameworks[c.framework].label} 中的文件保持原样。${args.includes("--purge") ? "本地仓库副本已删除。" : "（仓库里本机的部署密钥可在仓库 Settings → Deploy keys 中删除以彻底吊销）"}`);
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
