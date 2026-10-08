// 灵魂同步的网络：报错照原文给出（不按文字猜是网络还是钥匙）；推送被拒按 --porcelain 判断；GitHub 的 22 端口不通时自动改走 ssh.github.com:443。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { SoulRepo, gitError, pushRejected, isGithubSsh } from "../src/memory/soul-repo.ts";

const CUT = "Connection closed by 20.205.243.166 port 22\r\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.";

test("报错照原文给出，不改写成猜出来的原因；被拒只认 --porcelain 的 ! 行", () => {
  assert.equal(gitError(CUT), CUT.trim());
  assert.equal(gitError("  something else \n"), "something else");
  assert.match(gitError("x".repeat(1000) + "最后一行"), /^….*最后一行$/);
  assert.ok(pushRejected("To ssh://x\n!\tHEAD:refs/heads/main\t[rejected] (fetch first)\nDone\n"));
  assert.ok(!pushRejected("To ssh://x\n=\tHEAD:refs/heads/main\t[up to date]\nDone\n"));
  assert.ok(!pushRejected(""), "连不上时没有 porcelain 输出：不算被拒");
});

test("GitHub 的 SSH 地址识别", () => {
  assert.ok(isGithubSsh("git@github.com:me/a.soul.git"));
  assert.ok(isGithubSsh("ssh://git@github.com/me/a.soul.git"));
  assert.ok(isGithubSsh("ssh://git@github.com:22/me/a.soul.git"));
  assert.ok(!isGithubSsh("git@github-soul:me/a.soul.git"), "~/.ssh/config 的别名由那里决定");
  assert.ok(!isGithubSsh("git@gitee.com:me/a.soul.git"));
  assert.ok(!isGithubSsh("ssh://git@github.com:2222/me/a.soul.git"));
});

test("22 端口被断开时自动改走 443，之后先走 443", { skip: process.platform === "win32" && "用 sh 写的假 ssh；Windows 上 git 用系统自带的 OpenSSH" }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "quetzal-soulnet-"));
  // 假的 ssh：22 端口一律「被断开」；带 Port=443 + HostName=ssh.github.com 时把远端命令放到本地的「GitHub」目录里执行
  const bin = path.join(tmp, "bin"), gh = path.join(tmp, "github"), log = path.join(tmp, "ssh.log");
  fs.mkdirSync(bin); fs.mkdirSync(path.join(gh, "me"), { recursive: true });
  execFileSync("git", ["init", "--bare", "-q", "-b", "main", path.join(gh, "me", "a.soul.git")]);
  fs.writeFileSync(path.join(bin, "ssh"), `#!/bin/sh
echo "$*" >> ${JSON.stringify(log)}
case "$*" in *Port=443*HostName=ssh.github.com*|*HostName=ssh.github.com*Port=443*) ;; *) echo "Connection closed by 20.205.243.166 port 22" >&2; exit 255;; esac
for last; do :; done
cd ${JSON.stringify(gh)} && exec sh -c "$last"
`, { mode: 0o755 });
  const key = path.join(tmp, "key"); fs.writeFileSync(key, "x", { mode: 0o600 });
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  try {
    const logs: string[] = [];
    const repo = new SoulRepo({ dir: path.join(tmp, "soul"), remote: "git@github.com:me/a.soul.git", branch: "main", body: "test", sshKey: key,
      author: () => ({ name: "t", email: "t@x" }), seedIdentity: () => ({ id: "a1", name: "t", displayName: "T" }), log: (m) => logs.push(m) });
    await repo.ensure();
    fs.writeFileSync(path.join(repo.o.dir, "SOUL.md"), "我\n");
    const r = await repo.push("经 443 推送");
    assert.ok(r.ok && r.pushed, JSON.stringify(r));
    assert.match(execFileSync("git", ["-C", path.join(gh, "me", "a.soul.git"), "log", "--oneline", "main"]).toString(), /经 443 推送/);
    assert.ok(logs.some((l) => /改走 ssh\.github\.com:443/.test(l)));
    assert.match(fs.readFileSync(log, "utf8"), /HostKeyAlias=github\.com/);
    // 记住了：下一次直接走 443，不再先试 22
    fs.writeFileSync(log, "");
    fs.writeFileSync(path.join(repo.o.dir, "SOUL.md"), "我们\n");
    assert.ok((await repo.push("第二次")).pushed);
    assert.ok(fs.readFileSync(log, "utf8").split("\n").filter(Boolean).every((l) => /Port=443/.test(l)));
  } finally { process.env.PATH = oldPath; }
});
