// 端到端：真实 git 裸仓库 + 假的 Hermes 家目录 + 假的 OpenClaw 工作区，通过 CLI 接入，互相看到对方的记忆。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { parseEntries, joinEntries } from "../../runtime/src/memory/entries.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-e2e-"));
const remote = path.join(tmp, "agent.soul.git");
execFileSync("git", ["init", "--bare", "-b", "main", remote]);
const cli = path.resolve("src/cli.ts");
const run = (home: string, ...a: string[]) => execFileSync(process.execPath, [cli, ...a], {
  env: { ...process.env, SOUL_BRIDGE_HOME: path.join(tmp, home, ".agent-soul"), HOME: path.join(tmp, home), SOUL_BRIDGE_NO_SERVICE: "1", SOUL_ALLOW_LOCAL_REMOTE: "1" }, // 测试中不安装系统服务、允许本地裸仓库作为远端
}).toString();

const hermesHome = path.join(tmp, "m1", ".hermes");
const clawHome = path.join(tmp, "m2", ".openclaw", "workspace");
fs.mkdirSync(path.join(hermesHome, "memories"), { recursive: true });
fs.writeFileSync(path.join(hermesHome, "SOUL.md"), "# 小满\n\n我是小满。\n");
fs.writeFileSync(path.join(hermesHome, "memories", "MEMORY.md"), joinEntries(["喜欢猫"]));
fs.mkdirSync(clawHome, { recursive: true });

test("Hermes 接入：导入人格与记忆，创建身份", () => {
  const out = run("m1", "init", "--framework", "hermes", "--repo", remote, "--home", hermesHome, "--body", "hermes-pc", "--agent", "kaoru", "--poll", "0");
  assert.match(out, /已接入/);
  const agent = JSON.parse(execFileSync("git", ["--git-dir", remote, "show", "main:agent.json"]).toString());
  assert.equal(agent.displayName, "小满");
  assert.equal(fs.readFileSync(path.join(hermesHome, "SOUL.md"), "utf8"), "# 小满\n\n我是小满。\n", "框架原有人格不得被种子覆盖");
  assert.match(execFileSync("git", ["--git-dir", remote, "show", "main:SOUL.md"]).toString(), /我是小满/);
  const tree = execFileSync("git", ["--git-dir", remote, "ls-tree", "-r", "--name-only", "main"]).toString();
  for (const f of [".soul-spec.json", ".gitattributes", ".gitignore", "README.md", "memories/USER.md", "notes/.gitkeep", "bodies/hermes-pc.json"]) assert.match(tree, new RegExp(f.replace(/\./g, "\\.")), f);
});

test("OpenClaw 接入同一个 agent：拿到人格与记忆；它新写的记忆回流到 Hermes", () => {
  run("m2", "init", "--framework", "openclaw", "--repo", remote, "--home", clawHome, "--body", "claw-box", "--agent", "kaoru", "--poll", "0");
  assert.match(fs.readFileSync(path.join(clawHome, "SOUL.md"), "utf8"), /我是小满/);
  assert.deepEqual(parseEntries(fs.readFileSync(path.join(clawHome, "MEMORY.md"), "utf8").replace(/^[\s\S]*?-->\n\n/, "").replace(/^- /gm, "")), ["喜欢猫"]);
  fs.appendFileSync(path.join(clawHome, "MEMORY.md"), "\n用户最近在学吉他。\n");
  run("m2", "sync", "--agent", "kaoru", "--quiet");
  run("m1", "sync", "--agent", "kaoru", "--quiet");
  assert.deepEqual(parseEntries(fs.readFileSync(path.join(hermesHome, "memories", "MEMORY.md"), "utf8")), ["喜欢猫", "用户最近在学吉他。"]);
  const bodies = execFileSync("git", ["--git-dir", remote, "ls-tree", "--name-only", "main", "bodies/"]).toString();
  assert.match(bodies, /hermes-pc\.json/); assert.match(bodies, /claw-box\.json/);
});

test("Hermes 钩子已预先批准：allowlist 中的命令与 config.yaml 中的完全一致；doctor 可自检", () => {
  const cfg = fs.readFileSync(path.join(hermesHome, "config.yaml"), "utf8");
  const cmd = cfg.match(/command: "(.+)"/)![1];
  const allow = JSON.parse(fs.readFileSync(path.join(hermesHome, "shell-hooks-allowlist.json"), "utf8"));
  for (const ev of ["post_tool_call", "on_session_finalize"]) assert.ok(allow.approvals.some((e: any) => e.event === ev && e.command === cmd), ev);
  let out = "";
  try { out = run("m1", "doctor", "--agent", "kaoru"); } catch (e: any) { out = e.stdout.toString(); } // 测试环境没有后台服务，doctor 会报告该项
  const d = JSON.parse(out);
  assert.equal(d.agent, "小满");
  assert.ok(d.checks.find((x: any) => x.name === "仓库访问").ok);
  assert.ok(d.checks.find((x: any) => x.name === "Hermes 钩子").ok);
});

test("拔出：钩子移除，框架文件保持原样", () => {
  fs.writeFileSync(path.join(hermesHome, "config.yaml"), fs.existsSync(path.join(hermesHome, "config.yaml")) ? fs.readFileSync(path.join(hermesHome, "config.yaml"), "utf8") : "");
  assert.match(fs.readFileSync(path.join(hermesHome, "config.yaml"), "utf8"), /soul-bridge/);
  run("m1", "detach", "--agent", "kaoru", "--purge");
  assert.doesNotMatch(fs.readFileSync(path.join(hermesHome, "config.yaml"), "utf8"), /soul-bridge/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(hermesHome, "shell-hooks-allowlist.json"), "utf8")).approvals.length, 0);
  assert.ok(fs.existsSync(path.join(hermesHome, "memories", "MEMORY.md")));
});

test("在一台新装的 Hermes 上重生：仓库里的人格与记忆胜过框架的默认人格", () => {
  const fresh = path.join(tmp, "m3", ".hermes");
  fs.mkdirSync(path.join(fresh, "memories"), { recursive: true });
  fs.writeFileSync(path.join(fresh, "SOUL.md"), "# Hermes\n\nYou are Hermes, a helpful assistant.\n"); // 新装 Hermes 的默认人格
  run("m3", "init", "--framework", "hermes", "--repo", remote, "--home", fresh, "--body", "hermes-new", "--agent", "kaoru", "--poll", "0");
  assert.match(fs.readFileSync(path.join(fresh, "SOUL.md"), "utf8"), /我是小满/);
  assert.ok(parseEntries(fs.readFileSync(path.join(fresh, "memories", "MEMORY.md"), "utf8")).includes("喜欢猫"));
  const log = execFileSync("git", ["--git-dir", remote, "log", "--all", "--full-history", "-p", "--", "SOUL.md"]).toString();
  assert.match(log, /You are Hermes/); // 默认人格作为落选版本留在历史里
});
