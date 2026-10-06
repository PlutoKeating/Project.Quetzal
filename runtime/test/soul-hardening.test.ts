// 灵魂仓库的 git 安全边界（规范 §5.2）：.git/config 的改写不生效、钩子不执行、不收符号链接、私钥路径加引号；内容不做检查（v11 §6）。
import { test } from "node:test";
process.env.SOUL_ALLOW_LOCAL_REMOTE = "1"; // 测试使用本地裸仓库作为远端
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { SoulRepo, checkKeyPath, shellQuote } from "../src/memory/soul-repo.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "quetzal-soulsec-"));
const g = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, stdio: "pipe" }).toString();
const bare = (name: string) => { const r = path.join(tmp, name); execFileSync("git", ["init", "--bare", "-b", "main", r]); return r; };
const remote = bare("soul.git"), evil = bare("evil.git");
const SECRET = "tok_0123456789abcdefABCDEF";
const repo = new SoulRepo({
  dir: path.join(tmp, "soul"), remote, branch: "main", body: "test",
  author: () => ({ name: "t", email: "t@x" }), seedIdentity: () => ({ id: "a1", name: "t", displayName: "T" }),
});

test("推送直接用配置里的地址：.git/config 里的 url.insteadOf 与改过的 origin 都不生效，且会被删掉", async () => {
  await repo.ensure();
  const dir = repo.o.dir;
  g(dir, "config", `url.${evil}.insteadOf`, remote);
  g(dir, "config", `url.${evil}.pushInsteadOf`, remote);
  g(dir, "remote", "set-url", "origin", evil);
  g(dir, "config", "core.sshCommand", "touch /tmp/should-not-run");
  fs.writeFileSync(path.join(dir, "SOUL.md"), "我\n");
  const r = await repo.push("测试");
  assert.ok(r.ok && r.pushed, JSON.stringify(r));
  assert.match(g(remote, "log", "--oneline", "main"), /测试/);
  assert.throws(() => g(evil, "rev-parse", "main"), "没有推到别处");
  const cfg = fs.readFileSync(path.join(dir, ".git", "config"), "utf8");
  assert.doesNotMatch(cfg, /insteadOf|sshCommand/i);
});

test("钩子不执行（core.hooksPath=/dev/null）", async () => {
  const marker = path.join(tmp, "hook-ran");
  const hook = path.join(repo.o.dir, ".git", "hooks", "pre-commit");
  fs.writeFileSync(hook, `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(repo.o.dir, "notes-a.md"), "a\n");
  assert.ok(await repo.commit("钩子"));
  assert.ok(!fs.existsSync(marker));
});

test("内容不做检查：写进了像令牌的值也照常提交（v11 §6）", async () => {
  fs.mkdirSync(path.join(repo.o.dir, "notes"), { recursive: true });
  fs.writeFileSync(path.join(repo.o.dir, "notes", "x.md"), `令牌是 ${SECRET}\n`);
  assert.ok(await repo.commit("照常"));
  assert.match(g(repo.o.dir, "show", "HEAD:notes/x.md"), new RegExp(SECRET));
});

test("不提交符号链接；远端有符号链接时拒绝合并", async () => {
  fs.symlinkSync("/etc/passwd", path.join(repo.o.dir, "notes", "link.md"));
  await repo.commit("链接");
  assert.doesNotMatch(g(repo.o.dir, "ls-files", "-s"), /^120000/m);
  fs.rmSync(path.join(repo.o.dir, "notes", "link.md"));
  await repo.push("推");
  // 另一个克隆往远端推了一个符号链接
  const other = path.join(tmp, "other");
  g(tmp, "clone", "-q", remote, other);
  g(other, "config", "user.email", "o@x"); g(other, "config", "user.name", "o");
  fs.symlinkSync("../../secrets/master.key", path.join(other, "notes", "evil.md"));
  g(other, "add", "-A"); g(other, "commit", "-qm", "evil"); g(other, "push", "-q", "origin", "main");
  const r = await repo.pull();
  assert.equal(r.merged, false);
  assert.match(repo.status.lastError, /符号链接/);
  assert.ok(!fs.existsSync(path.join(repo.o.dir, "notes", "evil.md")));
});

test("私钥路径：必须是绝对路径、没有控制字符，进入 GIT_SSH_COMMAND 时加引号", () => {
  assert.equal(checkKeyPath("/home/a b/key"), undefined);
  assert.match(checkKeyPath("key")!, /绝对路径/);
  assert.match(checkKeyPath("/a\nb")!, /控制字符/);
  assert.equal(shellQuote("/x/it's key"), `'/x/it'\\''s key'`);
  assert.equal(execFileSync("sh", ["-c", `printf %s ${shellQuote("/x/it's $(id) key")}`]).toString(), "/x/it's $(id) key");
});
