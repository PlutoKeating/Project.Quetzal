// 灵魂仓库的历史：接入时没克隆成（网络拦了）、先在本地建了仓库的身体，联网后不能把它那段独立的历史推上去；
// 已经被推上去的（1.1.8 之前）、内容都是灵魂仓库的那段历史，其他身体接受；混进来的代码仓库历史照样拦下。
import { test } from "node:test";
process.env.SOUL_ALLOW_LOCAL_REMOTE = "1";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { SoulRepo } from "../src/memory/soul-repo.ts";

const g = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, stdio: "pipe" }).toString();
const roots = (dir: string, rev: string) => g(dir, "rev-list", "--max-parents=0", rev).trim().split("\n").filter(Boolean).sort();
const mk = (tmp: string, name: string, remote: string) => new SoulRepo({ dir: path.join(tmp, name), remote, branch: "main", body: name,
  author: () => ({ name: `T (${name})`, email: `t@${name}` }), seedIdentity: () => ({ id: "agent-1", name: "t", displayName: "T" }) });

test("接入时没克隆成、先在本地建的仓库：联网后只把内容接在远端历史后面，不带上本地那段独立的历史", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "quetzal-roots-"));
  const remote = path.join(tmp, "soul.git");
  // 手机接入时远端还连不上（这里是地址还不存在）：本地初始化
  const phone = mk(tmp, "phone", remote);
  assert.equal(await phone.ensure(), "initialized");
  fs.writeFileSync(path.join(phone.o.dir, "notes", "phone.md"), "手机接入前记下的\n");
  await phone.commit("接入前");
  // 这时远端其实已经有电脑推上去的历史（网络恢复后才看得到）
  execFileSync("git", ["init", "--bare", "-q", "-b", "main", remote]);
  const pc = mk(tmp, "pc", remote);
  await pc.ensure();
  fs.writeFileSync(path.join(pc.o.dir, "SOUL.md"), "电脑上的人格\n");
  assert.ok((await pc.push("电脑")).pushed);
  const pcRoots = roots(pc.o.dir, "HEAD");
  // 手机联网后同步
  const r = await phone.push("联网后");
  assert.ok(r.ok && r.pushed, JSON.stringify(r));
  assert.deepEqual(roots(phone.o.dir, "HEAD"), pcRoots, "推上去的历史只有远端原来的根");
  assert.deepEqual(roots(remote, "main"), pcRoots);
  assert.equal(g(remote, "show", "main:notes/phone.md"), "手机接入前记下的\n", "接入前的内容还在");
  // 电脑照常拉取，不会因为陌生的根提交停下
  const pulled = await pc.pull();
  assert.ok(pulled.merged, pc.status.lastError);
  assert.equal(pc.status.lastError, "");
  assert.ok(fs.existsSync(path.join(pc.o.dir, "notes", "phone.md")));
});

test("已经被并进远端的、内容都是灵魂仓库的独立历史：接受；混进来的代码仓库历史：照样拦下", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "quetzal-roots2-"));
  const remote = path.join(tmp, "soul.git");
  execFileSync("git", ["init", "--bare", "-q", "-b", "main", remote]);
  const pc = mk(tmp, "pc", remote);
  await pc.ensure();
  fs.writeFileSync(path.join(pc.o.dir, "SOUL.md"), "人格\n");
  assert.ok((await pc.push("电脑")).pushed);
  await pc.pull(); // 记下已知的根
  // 1.1.8 之前的身体：本地建的仓库（只有灵魂仓库的内容）被直接并进了远端
  const old = path.join(tmp, "old");
  g(tmp, "clone", "-q", remote, old); g(old, "config", "user.email", "o@x"); g(old, "config", "user.name", "o (old)");
  const side = path.join(tmp, "side"); fs.mkdirSync(side); g(side, "init", "-q", "-b", "main"); g(side, "config", "user.email", "o@x"); g(side, "config", "user.name", "o (old)");
  fs.mkdirSync(path.join(side, "journal", "old"), { recursive: true }); fs.writeFileSync(path.join(side, "journal", "old", "d.md"), "x\n"); fs.writeFileSync(path.join(side, "agent.json"), "{}\n");
  g(side, "add", "-A"); g(side, "commit", "-qm", "补齐灵魂仓库规范结构（old）");
  g(old, "fetch", "-q", side, "main"); g(old, "merge", "-q", "--no-edit", "--allow-unrelated-histories", "-X", "ours", "FETCH_HEAD"); g(old, "push", "-q", "origin", "main");
  const r = await pc.pull();
  assert.equal(pc.status.lastError, "", "灵魂仓库形状的独立历史被接受");
  assert.ok(r.merged);
  // 混进一个代码仓库的历史：拦下
  const code = path.join(tmp, "code"); fs.mkdirSync(code); g(code, "init", "-q", "-b", "main"); g(code, "config", "user.email", "c@x"); g(code, "config", "user.name", "c");
  fs.mkdirSync(path.join(code, "src")); fs.writeFileSync(path.join(code, "src", "main.ts"), "x\n"); fs.writeFileSync(path.join(code, "package.json"), "{}\n");
  g(code, "add", "-A"); g(code, "commit", "-qm", "code");
  g(old, "pull", "-q", "--no-rebase", "origin", "main");
  g(old, "fetch", "-q", code, "main"); g(old, "merge", "-q", "--no-edit", "--allow-unrelated-histories", "FETCH_HEAD"); g(old, "push", "-q", "origin", "main");
  await pc.pull();
  assert.match(pc.status.lastError, /混进了别的仓库/);
});
