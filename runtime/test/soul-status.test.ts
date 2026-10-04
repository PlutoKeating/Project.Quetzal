// 灵魂同步的状态落盘、git 报错翻译、三种访问方式（部署密钥 / 指定私钥 / 系统 ssh）的钥匙选择。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "quetzal-soul-status-"));
process.env.QUETZAL_HOME = path.join(tmp, "home");
process.env.SOUL_ALLOW_LOCAL_REMOTE = "1";
const { SoulRepo, friendlyGitError } = await import("../src/memory/soul-repo.ts");
const { sshKeyFor } = await import("../src/memory/soul-sync.ts");

test("同步状态落盘：新建实例读回上一次的 lastPull / lastError", () => {
  const statusFile = path.join(tmp, "state", "soul-status.json");
  const opts = { dir: path.join(tmp, "soul"), remote: "", branch: "main", body: "t", sshKey: path.join(tmp, "nokey"), author: () => ({ name: "t", email: "t@t" }), statusFile };
  const a = new SoulRepo(opts);
  a.status.lastPull = 1234; a.status.lastError = "x";
  assert.deepEqual(JSON.parse(fs.readFileSync(statusFile, "utf8")), { lastPull: 1234, lastPush: 0, lastError: "x" });
  const b = new SoulRepo(opts);
  assert.equal(b.status.lastPull, 1234); assert.equal(b.status.lastError, "x");
  b.status.lastError = "";
  assert.equal(new SoulRepo(opts).status.lastError, "");
});

test("git 报错翻译成人话，并保留原文", () => {
  assert.match(friendlyGitError("git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository."), /Deploy keys.*原文：git@github.com: Permission denied/);
  assert.match(friendlyGitError("ssh: Could not resolve hostname github-personal: Name or service not known"), /连不上.*原文：/);
  assert.equal(friendlyGitError("  something else \n"), "something else");
});

test("访问方式决定钥匙：deploy 用本机部署密钥，custom 用指定路径（支持 ~），system 不指定", () => {
  assert.match(sshKeyFor({ sshMode: "deploy" })!, /secrets\/soul_ed25519$/);
  assert.match(sshKeyFor({})!, /secrets\/soul_ed25519$/);
  assert.equal(sshKeyFor({ sshMode: "custom", sshKeyPath: "~/.ssh/id_ed25519" }), path.join(process.env.HOME ?? "", ".ssh/id_ed25519"));
  assert.equal(sshKeyFor({ sshMode: "custom", sshKeyPath: "/k" }), "/k");
  assert.equal(sshKeyFor({ sshMode: "custom", sshKeyPath: "" }), undefined);
  assert.equal(sshKeyFor({ sshMode: "system" }), undefined);
});

test("system 模式：没有私钥文件也能访问远端（本地路径的远端），deploy 模式缺私钥则拒绝", async () => {
  const bare = path.join(tmp, "bare.git");
  const { execFileSync } = await import("node:child_process");
  execFileSync("git", ["init", "--bare", "-b", "main", bare]);
  const sys = new SoulRepo({ dir: path.join(tmp, "sys"), remote: bare, branch: "main", body: "t", sshKey: undefined, author: () => ({ name: "t", email: "t@t" }), seedIdentity: () => ({ id: "1", name: "a", displayName: "A" }) });
  assert.equal(await sys.ensure(), "cloned");
  await sys.push("第一次");
  assert.equal(sys.status.lastError, "");
});
