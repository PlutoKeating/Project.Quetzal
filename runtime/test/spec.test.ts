// 灵魂仓库规范（docs/SOUL_REPO_SPEC.md）的可机器检查部分。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { SoulRepo, checkRemote, lintContent, FIXED_FILES } from "../src/memory/soul-repo.ts";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "soul-spec-"));
const repo = (dir: string, remote = "") => new SoulRepo({
  dir, remote, branch: "main", body: "t", sshKey: path.join(dir, "..", "missing_key"),
  author: () => ({ name: "t", email: "t@t.local" }),
  seedIdentity: () => ({ id: "11111111-1111-4111-8111-111111111111", name: "t", displayName: "测试", seed: true }),
  seedSoul: (n) => `# ${n}\n`,
});

test("接入时补齐固定目录树与固定内容", async () => {
  const d = path.join(tmp(), "soul");
  await repo(d).ensure();
  for (const f of [".soul-spec.json", ".gitattributes", ".gitignore", "README.md", "agent.json", "SOUL.md", "memories/MEMORY.md", "memories/USER.md", "journal/.gitkeep", "notes/.gitkeep", "bodies/.gitkeep"])
    assert.ok(fs.existsSync(path.join(d, f)), f);
  for (const [f, text] of Object.entries(FIXED_FILES)) assert.equal(fs.readFileSync(path.join(d, f), "utf8"), text);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(d, ".soul-spec.json"), "utf8")), { spec: "soul-repo", version: 13 });
  assert.match(execFileSync("git", ["-C", d, "log", "--oneline"]).toString(), /补齐灵魂仓库规范结构/);
});

test("远端必须是 SSH 地址", () => {
  assert.equal(checkRemote("git@github.com:alice/kaoru.soul.git"), undefined);
  assert.equal(checkRemote("ssh://git@github.com/alice/kaoru.soul.git"), undefined);
  assert.match(checkRemote("https://github.com/alice/kaoru.soul.git")!, /SSH/);
  assert.match(checkRemote("https://ghp_x@github.com/a/b.git")!, /SSH/);
  const prev = process.env.SOUL_ALLOW_LOCAL_REMOTE;
  delete process.env.SOUL_ALLOW_LOCAL_REMOTE;
  assert.match(checkRemote("/tmp/x.git")!, /SSH/);
  if (prev) process.env.SOUL_ALLOW_LOCAL_REMOTE = prev;
});

test("部署私钥不存在时拒绝访问远端，不回退到其他凭据", async () => {
  const r = repo(path.join(tmp(), "soul"), "git@github.com:alice/kaoru.soul.git");
  const res = await r.pull();
  assert.equal(res.merged, false);
  assert.match(r.status.lastError, /私钥 .* 不存在，拒绝访问远端/);
});

test("内容不做任何检查：密钥、IP、手机号照样提交（私有仓库，规范 §6）", async () => {
  const d = path.join(tmp(), "soul");
  const r = repo(d);
  await r.ensure();
  fs.writeFileSync(path.join(d, "notes", "家里.md"), "# 家里\n路由器在 192.168.1.1，固件 2.0.0.150，对方电话 13812345678\nkey: sk-abcdefghijklmnopqrstu\n");
  assert.equal(await r.commit("写笔记"), true);
  assert.match(execFileSync("git", ["-C", d, "log", "--oneline"]).toString(), /写笔记（t）/);
  assert.ok(!r.status.lastError);
});

test("只对过大或二进制的文件提醒，不拦", () => {
  assert.deepEqual(lintContent("f.md", Buffer.from("-----BEGIN OPENSSH PRIVATE KEY-----\naa:bb:cc:dd:ee:ff 10.0.0.1")), []);
  assert.equal(lintContent("b.bin", Buffer.from([1, 0, 2])).length, 1);
  assert.equal(lintContent("big.md", Buffer.alloc((1 << 20) + 1, 97)).length, 1);
});
