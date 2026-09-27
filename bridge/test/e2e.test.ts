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
  env: { ...process.env, SOUL_BRIDGE_HOME: path.join(tmp, home, ".agent-soul"), HOME: path.join(tmp, home), SOUL_BRIDGE_NO_SERVICE: "1" }, // 测试中不安装系统服务
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

test("拔出：钩子移除，框架文件保持原样", () => {
  fs.writeFileSync(path.join(hermesHome, "config.yaml"), fs.existsSync(path.join(hermesHome, "config.yaml")) ? fs.readFileSync(path.join(hermesHome, "config.yaml"), "utf8") : "");
  assert.match(fs.readFileSync(path.join(hermesHome, "config.yaml"), "utf8"), /soul-bridge/);
  run("m1", "detach", "--agent", "kaoru", "--purge");
  assert.doesNotMatch(fs.readFileSync(path.join(hermesHome, "config.yaml"), "utf8"), /soul-bridge/);
  assert.ok(fs.existsSync(path.join(hermesHome, "memories", "MEMORY.md")));
});
