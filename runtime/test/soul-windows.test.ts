// 规范 v13 §3.13：别的身体写进灵魂仓库、Windows 上放不下的路径（保留名、只差大小写），Windows 身体照常克隆、拉取与推送，
// 只是不把它们写进工作区，并且推送时原样保留在仓库里。在 Linux 上跑同一套流程（不排除任何东西），在 Windows 的 CI 上验证排除。
import { test } from "node:test";
process.env.SOUL_ALLOW_LOCAL_REMOTE = "1";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { SoulRepo } from "../src/memory/soul-repo.ts";

const WIN = process.platform === "win32";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "quetzal-soulwin-"));
const g = (cwd: string, input: string | undefined, ...a: string[]) => execFileSync("git", ["-c", "core.protectNTFS=false", ...a], { cwd, input, stdio: ["pipe", "pipe", "pipe"] }).toString().trim();

// 远端：用底层命令造一个含 notes/con.md 与只差大小写的路径的提交（这些文件在 Windows 上建不出来）
const remote = path.join(tmp, "soul.git");
execFileSync("git", ["init", "--bare", "-b", "main", remote]);
const work = path.join(tmp, "maker");
execFileSync("git", ["init", "-b", "main", work]);
const add = (p: string, text: string) => { const sha = g(work, text, "hash-object", "-w", "--stdin"); g(work, undefined, "update-index", "--add", "--cacheinfo", `100644,${sha},${p}`); };
add("agent.json", JSON.stringify({ id: "a1", name: "t", displayName: "T" }) + "\n");
add("notes/ok.md", "放得下\n");
add("notes/con.md", "保留名\n");
add("skills/X/SKILL.md", "大写\n");
add("skills/x/SKILL.md", "小写\n");
const tree = g(work, undefined, "write-tree");
const commit = g(work, undefined, "-c", "user.name=t", "-c", "user.email=t@x", "commit-tree", tree, "-m", "linux 身体写的");
g(work, undefined, "push", remote, `${commit}:refs/heads/main`);

const repo = new SoulRepo({ dir: path.join(tmp, "soul"), remote, branch: "main", body: "pc", author: () => ({ name: "t", email: "t@x" }), seedIdentity: () => ({ id: "a1", name: "t", displayName: "T" }) });

test("克隆：放得下的都在；Windows 上放不下的被跳过并记下原因", async () => {
  assert.equal(await repo.ensure(), "cloned");
  assert.ok(fs.existsSync(path.join(repo.o.dir, "notes", "ok.md")));
  if (WIN) {
    const skipped = (repo.status.skipped ?? []).map((s) => s.path).sort();
    assert.deepEqual(skipped, ["notes/con.md", "skills/x/SKILL.md"]);
  } else assert.equal(repo.status.skipped, undefined);
});

test("推送后远端仍保留这些文件（只是没写到 Windows 的磁盘上）", async () => {
  fs.writeFileSync(path.join(repo.o.dir, "notes", "new.md"), "Windows 上写的\n");
  const r = await repo.push("写一篇");
  assert.ok(r.ok, JSON.stringify(r));
  const files = g(remote, undefined, "ls-tree", "-r", "--name-only", "main").split("\n");
  for (const f of ["notes/con.md", "skills/X/SKILL.md", "skills/x/SKILL.md", "notes/new.md"]) assert.ok(files.includes(f), f);
});

test("拉取别的身体新写的放不下的文件：照常合并", async () => {
  g(work, undefined, "fetch", remote, "main");
  g(work, undefined, "reset", "-q", "FETCH_HEAD");
  add("notes/aux.md", "又一个\n");
  const t2 = g(work, undefined, "write-tree");
  const c2 = g(work, undefined, "-c", "user.name=t", "-c", "user.email=t@x", "commit-tree", t2, "-p", "FETCH_HEAD", "-m", "再写一个");
  g(work, undefined, "push", remote, `${c2}:refs/heads/main`);
  const res = await repo.pull();
  assert.ok(res.merged, JSON.stringify(repo.status));
  if (WIN) assert.ok(res.skipped?.some((s) => s.path === "notes/aux.md"));
  else assert.ok(fs.existsSync(path.join(repo.o.dir, "notes", "aux.md")));
});
