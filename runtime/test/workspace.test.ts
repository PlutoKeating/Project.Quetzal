// 工作区跟着任务走（mind/workspace.ts、mind/repos.ts，#38 第二阶段、#37）：复制来的工作区的检查与合并、从命令自动登记、身体的 git 仓库概况、
// shell 在工作区目录里执行与路由到工作区所在的身体、读文件工具的路径、系统提示。两具身体真连起来的见 workspace-mesh.test.ts。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "quetzal-workspace-"));
process.env.QUETZAL_HOME = path.join(root, "qhome");
process.env.HOME = path.join(root, "home"); // 工作目录（Linux 为用户主目录）放在临时目录里
fs.mkdirSync(process.env.HOME, { recursive: true });
const cfg = await import("../src/config.ts"); // 用命名空间读 config：它是会被整体替换的活绑定
const { loadConfig, saveConfig, paths } = cfg;
loadConfig();
saveConfig({ body: "phone" });
const store = await import("../src/store.ts");
store.openStore();
const uuid = await import("../src/body/uuid.ts");
await uuid.ensureBodyUuid(async () => "phone-machine-id-0001");
const ws = await import("../src/mind/workspace.ts");
const repos = await import("../src/mind/repos.ts");
const { setBodies } = await import("../src/mind/bodies.ts");
const { callTool, allTools } = await import("../src/mind/tools.ts");
const { Session } = await import("../src/mind/activity.ts");
const { systemPrompt } = await import("../src/mind/prompt.ts");
const { workDir } = await import("../src/sandbox.ts");
const home = process.env.HOME!;
const PC = uuid.deviceUuid("pc-machine-id-0001");
after(() => { setBodies(undefined); ws.setWorkspaceMesh(undefined); });

const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
const mkrepo = (dir: string, remote?: string, branch = "main") => {
  fs.mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", branch, dir]);
  if (remote) git(dir, "remote", "add", "origin", remote);
};

test("复制来的工作区：逐字段检查、实时只收发来的身体自己写的、后写胜、时刻钳在现在 + 5 分钟、清除留墓碑", () => {
  const now = Date.now();
  const row = (o: Record<string, unknown> = {}) => ({ key: "c1", body: "pc", uuid: PC, dir: "/home/u/proj", changed: now, source: "auto", author: "pc", ...o });
  // 实时：作者必须是发来的身体
  assert.equal(ws.mergeWorkspaces([row({ author: "laptop" })], { from: "pc" }).rejected, 1);
  assert.equal(ws.mergeWorkspaces([row()], { from: "pc" }).changed.length, 1);
  assert.equal(ws.getWorkspace("c1")?.dir, "/home/u/proj");
  // 不合格的：身体名、相对路径、控制字符、子 agent 的键、uuid 格式、太早的时刻
  const bad = [row({ body: "PC!" }), row({ dir: "proj" }), row({ dir: "/a\nb" }), row({ key: "agent:x" }), row({ uuid: "nope" }), row({ changed: 5 }), row({ key: "" }), null, "x"];
  assert.equal(ws.mergeWorkspaces(bad, { from: "pc", catchUp: true }).rejected, bad.length);
  // 较旧的不覆盖；较新的覆盖；补齐时可以带别的身体写的
  assert.equal(ws.mergeWorkspaces([row({ dir: "/old", changed: now - 1000 })], { from: "pc" }).changed.length, 0);
  assert.equal(ws.mergeWorkspaces([row({ dir: "C:\\work\\proj", changed: now + 1, author: "laptop", body: "laptop" })], { from: "pc", catchUp: true }).changed.length, 1);
  assert.equal(ws.getWorkspace("c1")?.body, "laptop");
  // 远在未来的时刻钳到现在 + 5 分钟：之后本机的修改照样能改动它
  ws.mergeWorkspaces([row({ dir: "/future", changed: now + 365 * 86400_000 })], { from: "pc" });
  assert.ok(ws.getWorkspace("c1")!.changed <= Date.now() + 5 * 60_000 + 10);
  ws.setWorkspace("c1", { body: "phone", dir: "/here", source: "user" });
  assert.equal(ws.getWorkspace("c1")?.dir, "/here");
  // 清除：墓碑也复制（别处较旧的设定不会让它复活）
  const sent: unknown[] = [];
  const off = ws.onWorkspaceChange((rows) => sent.push(...rows));
  assert.ok(ws.clearWorkspace("c1"));
  off();
  assert.equal(ws.getWorkspace("c1"), undefined);
  assert.equal((sent[0] as { dir: string }).dir, "");
  assert.equal(ws.mergeWorkspaces([row({ dir: "/stale", changed: now })], { from: "pc" }).changed.length, 0);
  assert.ok(ws.allWorkspaces().some((w) => w.key === "c1" && w.dir === ""));
  // 子 agent 的工作区只在本机，不复制
  ws.setWorkspace("agent:s1", { body: "phone", dir: "/x", source: "agent" });
  assert.ok(!ws.allWorkspaces().some((w) => w.key.startsWith("agent:")));
});

test("从命令看出工作的地方：git clone / init 出来的目录、cd 进去的目录（在仓库里取仓库的根）；工作目录本身、基座家目录、临时目录不算", () => {
  const proj = path.join(home, "src", "proj");
  mkrepo(proj);
  fs.mkdirSync(path.join(proj, "lib", "deep"), { recursive: true });
  assert.equal(ws.workdirHint("cd src/proj/lib/deep && ls", home), proj);
  assert.equal(ws.workdirHint("cd ~/src/proj; make", "/"), proj);
  // git clone：目标目录，或从地址推出的名字（命令执行后真实存在才算）
  fs.mkdirSync(path.join(home, "app"), { recursive: true });
  assert.equal(ws.workdirHint("git clone --depth 1 -b dev https://example.com/u/app.git", home), path.join(home, "app"));
  fs.mkdirSync(path.join(home, "mine"), { recursive: true });
  assert.equal(ws.workdirHint("cd ~ && git clone git@example.com:u/app.git mine", "/"), path.join(home, "mine"));
  assert.equal(ws.workdirHint("git clone https://example.com/u/missing.git", home), undefined);
  assert.equal(ws.workdirHint("cd ~ && ls", "/"), undefined, "工作目录本身不是工作区");
  assert.equal(ws.workdirHint(`cd ${paths.home}`, home), undefined, "基座的家目录（含灵魂仓库）不是工作区");
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ws-scratch-"));
  assert.equal(ws.workdirHint(`cd ${scratch}`, home), undefined, "工作目录之外的临时目录不算");
  assert.equal(ws.workdirHint("cd $SOMEWHERE", home), undefined, "变量展开不了的不猜");
  assert.equal(ws.workdirHint("echo hi", home), undefined);
});

test("自动登记：cd 进工作区里面不改；明确设定过的只有新的 git clone / init 才改", () => {
  const s = { origin: "chat", conv: "c2", id: "t" };
  const proj = path.join(home, "src", "proj");
  ws.noteWorkdir(s, "phone", proj, "cd src/proj");
  assert.equal(ws.getWorkspace("c2")?.dir, proj);
  assert.equal(ws.noteWorkdir(s, "phone", path.join(proj, "lib"), "cd lib"), undefined);
  ws.setWorkspace("c2", { body: "phone", dir: proj, source: "agent" });
  assert.equal(ws.noteWorkdir(s, "phone", path.join(home, "app"), "cd ../app"), undefined, "她明确设定过：cd 不改");
  assert.equal(ws.noteWorkdir(s, "pc", "/home/u/new", "git clone x new")?.body, "pc", "新的 git clone 改");
  // 醒来、做梦没有工作区；子 agent 的键是 agent:<会话 id>
  assert.equal(ws.noteWorkdir({ origin: "think", conv: "", id: "w" }, "phone", proj), undefined);
  assert.equal(ws.keyOf({ origin: "agent", conv: "c2", id: "s9" }), "agent:s9");
});

test("身体的 git 仓库概况：深度 2 以内、读 .git 得到分支与远端（去掉凭据）、隐藏目录与基座家目录不看、有上限", () => {
  mkrepo(path.join(home, "code", "alpha"), "https://user:ghp_secret@example.com/u/alpha.git", "dev");
  mkrepo(path.join(home, "beta"), "git@example.com:u/beta.git");
  mkrepo(path.join(home, "a", "b", "too-deep"));
  mkrepo(path.join(home, ".hidden", "x"));
  const o = repos.scanRepos(home);
  const by = (p: string) => o.repos.find((r) => r.path === p);
  assert.deepEqual(by(path.join(home, "code", "alpha")), { path: path.join(home, "code", "alpha"), remote: "https://example.com/u/alpha.git", branch: "dev" });
  assert.equal(by(path.join(home, "beta"))?.remote, "git@example.com:u/beta.git");
  assert.ok(!o.repos.some((r) => r.path.includes("too-deep") || r.path.includes(".hidden")));
  assert.ok(!JSON.stringify(o).includes("ghp_secret"));
  assert.equal(repos.stripCredentials("https://x-access-token:abc@example.com/r"), "https://example.com/r");
  for (let i = 0; i < 40; i++) mkrepo(path.join(home, "many", `r${String(i).padStart(2, "0")}`));
  const capped = repos.scanRepos(home);
  assert.equal(capped.repos.length, repos.MAX_REPOS);
  assert.ok(capped.truncated);
  assert.match(repos.describeOverview(capped), /只列出了前 30 个/);
  // 别处发来的概况逐项检查
  assert.equal(repos.cleanOverview({ root: "/h", repos: [{ path: "/h/x", remote: "https://a:b@h/x" }, { path: 3 }] })?.repos.length, 1);
  assert.equal(repos.cleanOverview({ root: "/h", repos: [{ path: "/h/x", remote: "https://a:b@h/x" }] })?.repos[0].remote, "https://h/x");
  assert.equal(repos.cleanOverview("x"), undefined);
});

test("shell：工作区在这具身体上就在工作区目录里执行，git init 出的目录自动登记；系统提示写明工作区与这具身体上的仓库", async () => {
  const s = new Session("chat", "控制台", undefined, "c3");
  try {
    const proj = path.join(home, "src", "proj");
    ws.setWorkspace("c3", { body: "phone", dir: proj, source: "user" });
    const r = await callTool("shell", { command: "pwd" }, "测试", { session: s });
    if (/沙箱/.test(r.text) && r.status === "error") return; // 这台机器没有沙箱：命令不执行
    assert.equal(r.status, "ok", r.text);
    assert.ok(r.text.includes(proj), r.text);
    await callTool("shell", { command: "git init -q fresh" }, "测试", { session: s });
    assert.equal(ws.getWorkspace("c3")?.dir, path.join(proj, "fresh"), "git init 出的目录：明确设定过也改");
    const p = systemPrompt("", { conv: "c3", dynamic: true });
    assert.match(p, /## 工作区\n这个会话的工作区在 phone/);
    assert.ok(p.includes(`${path.join(proj, "fresh")}，你此刻就在这具身体上`));
    assert.match(p, /## 身体[\s\S]*工作目录 .* 下的 git 仓库/);
    assert.match(systemPrompt("", { conv: "none", dynamic: true }), /这个会话还没有绑定工作区/);
  } finally { s.close(); }
});

test("工作区在另一具身体上：shell / shell_jobs 经 body_call 的通道放到那边、带上工作区目录，那边登记的目录交回来；那边不在线时在这里执行并说明", async () => {
  const calls: { body: string; tool: string; args: Record<string, unknown>; cwd?: string }[] = [];
  let up = true;
  setBodies({
    list: () => (up ? [{ body: "pc", uuid: PC, claimed: PC, describe: "", tools: [] }] : []),
    registry: () => [{ body: "pc", uuid: PC }],
    call: async (body, tool, args, _reason, _signal, o) => { calls.push({ body, tool, args, cwd: o?.cwd }); return { text: `pc 上执行了 ${tool}`, status: "ok", workdir: tool === "shell" ? "/home/u/proj/sub" : undefined }; },
    move: async () => "",
    file: async () => ({}),
  });
  ws.setWorkspaceMesh({ online: (b) => up && b === "pc", overview: () => ({ root: "/home/u", repos: [{ path: "/home/u/proj", branch: "main" }], at: Date.now() }), probe: async (_b, d) => ({ dir: d, exists: true }), runAgent: async () => ({ id: "ab", name: "x" }) });
  const s = new Session("chat", "控制台", undefined, "c4");
  try {
    ws.setWorkspace("c4", { body: "pc", dir: "/home/u/proj", source: "user" });
    const r = await callTool("shell", { command: "git status" }, "测试", { session: s });
    assert.equal(r.status, "ok");
    assert.match(r.text, /在工作区所在的 pc 上、\/home\/u\/proj 里执行/);
    assert.deepEqual(calls.at(-1), { body: "pc", tool: "shell", args: { command: "git status" }, cwd: "/home/u/proj" });
    assert.equal(ws.getWorkspace("c4")?.dir, "/home/u/proj", "cd 进工作区里面不改");
    await callTool("shell_jobs", { action: "list" }, "测试", { session: s });
    assert.equal(calls.at(-1)?.tool, "shell_jobs");
    // 她明确带了 body（这具身体的 uuid）：就在这里执行，不路由
    const n = calls.length;
    await callTool("shell", { command: "true", body: uuid.bodyUuid() }, "测试", { session: s });
    assert.equal(calls.length, n);
    // read_document 的相对路径：指 pc 上工作区里的文件（自动带上 pc 的 body，经 file.read 去取）
    const fetched: unknown[] = [];
    setBodies({ list: () => [{ body: "pc", uuid: PC, claimed: PC, describe: "", tools: [] }], registry: () => [{ body: "pc", uuid: PC }], call: async () => ({ text: "", status: "ok" }), move: async () => "", file: async (_b, p) => { fetched.push(p); throw new Error("测试：不真的取"); } });
    await callTool("read_document", { path: "README.md" }, "测试", { session: s });
    assert.equal((fetched[0] as { path: string }).path, "/home/u/proj/README.md");
    // 系统提示：工作区在 pc、这一轮在这里，shell 由基座放过去；「其他身体」里有 pc 上的仓库
    const p = systemPrompt("", { conv: "c4", dynamic: true });
    assert.match(p, /shell、shell_jobs 由基座放到 pc 上/);
    assert.match(p, /## 其他身体[\s\S]*\/home\/u\/proj（main）/);
    // pc 离线：在这里执行，结果里说明；系统提示如实写明
    up = false;
    const r2 = await callTool("shell", { command: "true" }, "测试", { session: s });
    assert.match(r2.text, /工作区在 pc 上，它此刻不在线：这条命令在 phone 上执行/);
    assert.match(systemPrompt("", { conv: "c4", dynamic: true }), /但 pc 此刻不在线/);
  } finally { s.close(); setBodies(undefined); ws.setWorkspaceMesh(undefined); }
});

test("workspace 工具与 memory 的描述", async () => {
  const s = new Session("chat", "控制台", undefined, "c5");
  try {
    const proj = path.join(home, "src", "proj");
    const set = await callTool("workspace", { action: "set", dir: "src/proj" }, "测试", { session: s });
    assert.equal(set.status, "ok", set.text);
    assert.equal(ws.getWorkspace("c5")?.dir, proj);
    assert.equal(ws.getWorkspace("c5")?.source, "agent");
    assert.match((await callTool("workspace", { action: "show" }, "测试", { session: s })).text, /这个会话的工作区：phone/);
    assert.equal((await callTool("workspace", { action: "set", dir: "no/such" }, "测试", { session: s })).status, "error");
    assert.equal((await callTool("workspace", { action: "set", dir: paths.soul }, "测试", { session: s })).status, "error", "灵魂目录不能当工作区");
    assert.equal((await callTool("workspace", { action: "clear" }, "测试", { session: s })).status, "ok");
    assert.equal(ws.getWorkspace("c5"), undefined);
    assert.equal(workDir(), home);
  } finally { s.close(); }
  const memory = allTools().find((t) => t.name === "memory")!;
  assert.ok(!memory.description.includes("每次醒来都会看到"), "动态上下文模式下主记忆不再固定出现");
  assert.equal(cfg.config.body, "phone");
});
