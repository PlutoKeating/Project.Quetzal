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
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(d, ".soul-spec.json"), "utf8")), { spec: "soul-repo", version: 3 });
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

test("缺少部署私钥时拒绝访问远端，不回退到其他凭据", async () => {
  const r = repo(path.join(tmp(), "soul"), "git@github.com:alice/kaoru.soul.git");
  const res = await r.pull();
  assert.equal(res.merged, false);
  assert.match(r.status.lastError, /缺少部署私钥/);
});

test("提交前拦截禁止内容，工作区保持不变", async () => {
  const d = path.join(tmp(), "soul");
  const r = repo(d);
  await r.ensure();
  fs.writeFileSync(path.join(d, "notes", "泄露.md"), "# 泄露\n我的 key 是 sk-abcdefghijklmnopqrstu\n");
  assert.equal(await r.commit("写笔记"), false);
  assert.match(r.status.lastError, /API Key/);
  assert.ok(fs.existsSync(path.join(d, "notes", "泄露.md")));
  assert.doesNotMatch(execFileSync("git", ["-C", d, "log", "--oneline"]).toString(), /写笔记/);
});

test("禁止内容识别（不误伤时间戳、版本号与日期）", () => {
  const bad = (s: string) => lintContent("f.md", Buffer.from(s));
  assert.ok(bad("-----BEGIN OPENSSH PRIVATE KEY-----").length);
  assert.ok(bad("ghp_abcdefghijklmnopqrstuvwxyz0123").length);
  assert.ok(bad("手机在 192.168.1.23").length);
  assert.ok(bad("aa:bb:cc:dd:ee:ff").length);
  assert.ok(bad("电话 13812345678").length);
  assert.ok(lintContent("b.bin", Buffer.from([1, 0, 2])).length);
  assert.deepEqual(bad('{"until": 1790530000000, "runtime": "0.1.0", "day": "2026-09-28", "ip": "127.0.0.1"}'), []);
  // IP 只拦能定位设备或个人的：版本号、回环 / 保留段、公共 DNS 都放行；报告带行号但不回显内容
  assert.deepEqual(bad("Make=HUAWEI / 固件版本 2.0.0.150，没有曝光参数"), []);
  assert.deepEqual(bad("| 固件 | 2.0.0.150 |\nfirmware: 4.4.2.1\nv1.2.3.4 build 10.0.19041.1"), []);
  assert.deepEqual(bad("DNS 换成 1.1.1.1 / 223.5.5.5 / 114.114.114.114 都能解析；监听 0.0.0.0，组播 224.0.0.251"), []);
  assert.deepEqual(bad("第一行\n路由器在 10.0.0.1"), ["f.md:2：包含 IP 地址"]);
  assert.deepEqual(bad("公网出口 2.0.0.150"), ["f.md:1：包含 IP 地址"]); // 没有版本字样的四段数字仍按 IP 处理
  assert.deepEqual(bad("x\n\n电话 13812345678"), ["f.md:3：包含疑似手机号"]);
});
