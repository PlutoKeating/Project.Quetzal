#!/usr/bin/env node
// soul-bridge：把 Hermes Agent / OpenClaw 接入 agent 的灵魂仓库，随时插拔。
// 这些命令由框架里的 agent 按技能说明代为执行（skills/soul-bridge/SKILL.md），用户不需要使用命令行。
//
//   connect [--framework hermes|openclaw] [--home <目录>] [--name <显示名>] [--agent <短名>] [--body <身体名>] [--server <https://…>]
//          推荐的接入方式（一个链接）：生成本机部署密钥 → 向同步服务申请绑定（带上部署公钥）→ 立即输出给人的链接与核对词后退出；
//          后台等人批准：同步服务经 GitHub 把部署密钥加到灵魂仓库、告诉这里仓库地址 → 克隆、导入、钩子、后台服务、首次同步、自检全自动。
//          人不需要打开 GitHub、不需要令牌、不需要复制公钥。已经接入的再运行一次 = 换成本机专属的部署密钥与规范的仓库地址。
//   connect --wait   等后台接入完成（最长 20 分钟），输出结果
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
//   self-update                 把程序目录切到最新的、发布签名核对过的正式版标签（安装后、更新时都用它，不跟 main）
//   mesh install|bind --server <https://…>|unbind|status|now [--agent]
//          多具身体（只读成员）：装组件；绑定到同步服务（给人一个链接与绑定码去批准）；解绑；状态；看其他身体此刻的近况
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile, execFileSync, spawn } from "node:child_process";
import { frameworks, detect } from "./frameworks/index.ts";
import { loadConfig, saveConfig, keyPath, repoDir, dirOf, listAgents, ROOT } from "./config.ts";
import { repoOf, syncOnce, VERSION } from "./bridge.ts";
import { checkRemote } from "../../runtime/src/memory/soul-repo.ts";
import { runDaemon, installService, removeService } from "./service.ts";
import { installModules, bind as bindMesh, unbindMesh, meshStatus, nowPath, nodeKey } from "./mesh.ts";
import { fingerprint } from "../../runtime/src/mesh/identity.ts";
import { selfUpdate } from "./release.ts";
import { shJoin } from "./quote.ts";
import { parseGithub, sshUrl, whoami, ensurePrivateRepo, addDeployKey } from "./github.ts";
import { startBinding, pollBinding, serverOrigin } from "../../runtime/src/mesh/binding.ts";

const OFFICIAL_SYNC = "https://sync.quetzal.plutokeating.beer";
const connectState = () => path.join(ROOT, "connect.json");
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

/** 识别框架、家目录与显示名（init 与 connect 共用）。 */
function setup() {
  const found = detect();
  const framework = opt("framework") ?? (found.length === 1 ? found[0] : undefined);
  if (!framework || !frameworks[framework]) throw new Error(found.length > 1 ? `本机同时有 ${found.join("、")}，请用 --framework 指定` : `没有检测到 Hermes 或 OpenClaw，请用 --framework 与 --home 指定`);
  const fw = frameworks[framework];
  const home = opt("home") ?? fw.defaultHome();
  return { framework, fw, home, displayName: opt("name") ?? fw.guessName?.(home) };
}

/** 一个链接接入：申请绑定（带部署公钥），输出链接与核对词，后台等待。 */
async function connect() {
  if (args.includes("--wait")) return connectWait();
  const { framework, fw, home, displayName } = setup();
  const existing = listAgents().map((a) => loadConfig(a)).find((x) => x.framework === framework && x.home === home);
  const agent = opt("agent") ?? existing?.agent ?? (slug(displayName ?? "") || "agent");
  const prev = existing ?? (listAgents().includes(agent) ? loadConfig(agent) : undefined);
  const body = opt("body") ?? prev?.body ?? slug(`${framework}-${os.hostname()}`);
  const c: BridgeConfig = { agent, framework, home, remote: prev?.remote ?? "", branch: prev?.branch ?? opt("branch") ?? "main", body, poll: prev?.poll ?? Number(opt("poll") ?? 300), ...(prev?.agentId ? { agentId: prev.agentId } : {}) };
  saveConfig(c);
  if (!fs.existsSync(keyPath(agent))) execFileSync("ssh-keygen", ["-t", "ed25519", "-N", "", "-C", `soul-bridge@${body}`, "-f", keyPath(agent)], { stdio: "ignore" });
  let id: { id?: string; displayName?: string } = {};
  try { id = JSON.parse(fs.readFileSync(path.join(repoDir(agent), "agent.json"), "utf8")); } catch {}
  const server = serverOrigin(opt("server") ?? OFFICIAL_SYNC);
  const start = await startBinding(server, {
    agent: { ...(id.id ? { id: id.id } : {}), name: id.displayName ?? displayName ?? agent }, // 读不到灵魂仓库时不报 agent id：批准的人选
    body, kind: "bridge", nodeKey: nodeKey(agent).nodeKey, version: VERSION, soulKey: fs.readFileSync(keyPath(agent) + ".pub", "utf8").trim(),
  });
  // 设备码只交给后台进程（文件 0600），不出现在命令行参数与输出里
  const secret = path.join(dirOf(agent), "connect-device.json");
  fs.writeFileSync(secret, JSON.stringify({ server, start }), { mode: 0o600 });
  fs.writeFileSync(connectState(), JSON.stringify({ status: "waiting", agent, link: start.verification_uri_complete, check: start.check ?? "", expires: Date.now() + start.expires_in * 1000 }, null, 2));
  const child = spawn(process.execPath, [CLI, "connect-finish", "--agent", agent], { detached: true, stdio: "ignore" });
  child.unref();
  say(JSON.stringify({
    needHuman: true,
    say: `点这个链接批准我接入（${fw.label}）：${start.verification_uri_complete}\n核对词：${start.check ?? ""}（打开的页面上应当显示同样的 3 个表情）`,
    link: start.verification_uri_complete, check: start.check ?? "",
    next: `把 say 原样发给对方，然后运行：${shJoin([process.execPath, CLI, "connect", "--wait"])}`,
    expiresInSeconds: start.expires_in,
  }, null, 2));
}

/** 后台：等人批准 → 采用链接好的灵魂仓库 → 完成接入。结果写进 connect.json。 */
async function connectFinish() {
  const agent = opt("agent")!;
  const secret = path.join(dirOf(agent), "connect-device.json");
  const write = (o: object) => fs.writeFileSync(connectState(), JSON.stringify({ agent, ...o }, null, 2));
  try {
    const { server, start } = JSON.parse(fs.readFileSync(secret, "utf8"));
    const b = await pollBinding(server, start, AbortSignal.timeout(Math.max(60, start.expires_in + 900) * 1000));
    fs.rmSync(secret, { force: true });
    const { soul, ...binding } = b;
    fs.writeFileSync(path.join(dirOf(agent), "sync.json"), JSON.stringify(binding, null, 2), { mode: 0o600 });
    const c = loadConfig(agent);
    if (soul && "remote" in soul) { c.remote = soul.remote; } // 规范的地址与本机专属的部署密钥（不再借用个人 SSH 密钥的别名）
    else if (!c.remote) throw new Error(soul && "error" in soul ? `没能链接灵魂仓库：${soul.error}` : "同步服务没有给出灵魂仓库（它还没有配置 GitHub App）");
    c.agentId = b.agent || c.agentId;
    saveConfig(c);
    const repo = repoOf(c);
    const how = await repo.ensure();
    if (how === "initialized") throw new Error("仓库还是访问不了（部署密钥没有生效）");
    await repo.pull();
    const r = await syncOnce(c);
    await attach(agent);
    await installModules(() => {}).catch(() => false); // 多具身体的近况：组件装不上也不影响灵魂同步
    write({ status: "done", account: b.account, repo: soul && "repo" in soul ? soul.repo : c.remote, body: c.body, changed: { native: r.changedNative.length, soul: r.changedSoul.length } });
  } catch (e) {
    fs.rmSync(secret, { force: true });
    write({ status: "failed", error: (e as Error).message });
  }
}

/** 等后台接入完成。 */
async function connectWait() {
  const deadline = Date.now() + 20 * 60_000;
  for (;;) {
    let st: any = {};
    try { st = JSON.parse(fs.readFileSync(connectState(), "utf8")); } catch {}
    if (st.status === "done") {
      say(`已接入：${st.agent}，身体名 ${st.body}，灵魂仓库 ${st.repo}（账户 ${st.account}）。首次同步：框架 ${st.changed?.native ?? 0} 处、灵魂 ${st.changed?.soul ?? 0} 处。`);
      return doctor(loadConfig(st.agent), true);
    }
    if (st.status === "failed") { say(JSON.stringify({ ok: false, error: st.error, retry: shJoin([process.execPath, CLI, "connect"]) }, null, 2)); process.exitCode = 1; return; }
    if (!st.status) { say("没有进行中的接入：先运行 connect"); process.exitCode = 1; return; }
    if (Date.now() > deadline || (st.expires && Date.now() > st.expires + 16 * 60_000)) { say(JSON.stringify({ ok: false, error: "等了太久没有人批准（链接已过期）", retry: shJoin([process.execPath, CLI, "connect"]) }, null, 2)); process.exitCode = 1; return; }
    await new Promise((r) => setTimeout(r, 3000));
  }
}

async function init() {
  const { framework, fw, home, displayName } = setup();
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
    say(JSON.stringify({ needHuman: true, reason: "无法访问灵魂仓库", ask: `请在仓库 ${gh ? `https://github.com/${gh.owner}/${gh.name}/settings/keys` : remote} 添加下面的 Deploy key，并勾选 Allow write access；完成后告诉我`, publicKey: fs.readFileSync(keyPath(agent) + ".pub", "utf8").trim(), retry: shJoin([process.execPath, CLI, ...args]) }, null, 2));
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
  add("仓库访问", ls.code === 0, c.remote, "部署密钥未生效：重新运行 connect，把新的链接发给人类");
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
  const m = meshStatus(c);
  if (m.bound) {
    let fresh = false;
    try { fresh = Date.now() - fs.statSync(nowPath(c.agent)).mtimeMs < 5 * 60_000; } catch {}
    add("网状层", m.modules && fresh, m.server, m.modules ? "守护进程没有在更新近况：运行 attach 重启服务，再看服务日志" : "运行 mesh install");
  }
  let identity: any = {};
  try { identity = JSON.parse(fs.readFileSync(path.join(repoDir(c.agent), "agent.json"), "utf8")); } catch {}
  const result = { ok: checks.every((x) => x.ok), agent: identity.displayName ?? c.agent, body: c.body, framework: c.framework, checks };
  say(brief ? `自检：${result.ok ? "全部通过" : "有问题 → " + checks.filter((x) => !x.ok).map((x) => `${x.name}（${x.fix}）`).join("；")}` : JSON.stringify(result, null, 2));
  if (!result.ok && !brief) process.exitCode = 1;
}

async function mesh(c: BridgeConfig) {
  const sub = args[1];
  if (sub === "install") { if (!(await installModules(say))) process.exitCode = 1; else say("网状层组件已就绪"); return; }
  if (sub === "bind") {
    const server = opt("server");
    if (!server) throw new Error("用 --server 指定同步服务地址（https://…），向人要");
    if (!(await installModules(say))) { process.exitCode = 1; return; }
    const { start, done } = await bindMesh(c, server, VERSION);
    say(JSON.stringify({ needHuman: true, reason: "绑定到同步服务需要人批准", ask: `请在浏览器打开 ${start.verification_uri_complete}（或打开 ${start.verification_uri} 输入绑定码 ${start.user_code}），登录，核对网页上的公钥指纹是 ${fingerprint(nodeKey(c.agent).nodeKey)}，然后点「批准」。要和其他身体绑定在同一个账号下。`, code: start.user_code, uri: start.verification_uri_complete, expiresInSeconds: start.expires_in }, null, 2));
    const b = await done;
    await syncOnce(c); // 把节点公钥写进灵魂仓库的身体登记：其他身体以它为准核对这具身体
    say(`已绑定（账户 ${b.account}）。守护进程半分钟内连上其他身体；之后 ${nowPath(c.agent)} 里是它们此刻的近况。`);
    return;
  }
  if (sub === "unbind") { await unbindMesh(c.agent); say("已从同步服务解绑。节点密钥保留在本机，灵魂仓库里的登记不变。"); return; }
  if (sub === "now") { const s = meshStatus(c); say(s.now || (s.bound ? "还没有取到近况（守护进程是否在运行？）" : "还没有绑定同步服务")); return; }
  if (!sub || sub === "status") { const { now: _now, ...s } = meshStatus(c); say(JSON.stringify(s, null, 2)); return; }
  throw new Error(`未知的 mesh 子命令：${sub}`);
}

async function main() {
  if (cmd === "init") return init();
  if (cmd === "connect") return connect();
  if (cmd === "connect-finish") return connectFinish();
  if (cmd === "version") return say(VERSION);
  if (cmd === "self-update") {
    const r = await selfUpdate();
    say(JSON.stringify({ ok: true, ...r, note: r.changed ? "已切到新版本：接着运行 attach 与 doctor（已接入时）" : "已是最新的正式版" }, null, 2));
    return;
  }
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
  if (cmd === "mesh") return mesh(c);
  if (cmd === "status") {
    let last = {};
    try { last = JSON.parse(fs.readFileSync(path.join(dirOf(c.agent), "last-sync.json"), "utf8")); } catch {}
    say(JSON.stringify({ version: VERSION, agents: listAgents(), config: c, lastSync: last, publicKey: fs.existsSync(keyPath(c.agent) + ".pub") ? fs.readFileSync(keyPath(c.agent) + ".pub", "utf8").trim() : null }, null, 2));
    return;
  }
  throw new Error(`未知命令：${cmd}`);
}

main().catch((e) => { console.error(`soul-bridge：${e.message}`); process.exit(1); });
