// 安全边界：沙箱（密钥目录在 agent 的命令里不存在）、读文件工具的真实路径检查、密钥脱敏（输出与参数）、
// 自造工具与造工具的闸门、web_fetch 的出站检查、语音端点、密钥文件的写法、主密钥损坏不重建、附件路径、网关令牌的取法。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFileSync } from "node:child_process";

process.env.QUETZAL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "quetzal-sec-"));
const { loadConfig, paths, writeSecret, readSecret, speechEndpointOk, saveConfig, config } = await import("../src/config.ts");
loadConfig();
const store = await import("../src/store.ts");
store.openStore();
const sandbox = await import("../src/sandbox.ts");
const { shell, startJob, getJob } = await import("../src/sh.ts");
const { callTool, strictest } = await import("../src/mind/tools.ts");
const { redactSecrets, redactArgs, saveSecret } = await import("../src/mind/secrets.ts");
const ct = await import("../src/mind/custom-tools.ts");
const { blockedIp, checkUrl, guardedFetch } = await import("../src/mind/fetch-guard.ts");
const { resolveUpload, uploadsDir } = await import("../src/mind/attachments.ts");
const { tokenOf } = await import("../src/gateway.ts");

const hasBwrap = (() => { try { execFileSync("bwrap", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();
const TOKEN = "gw_" + "x".repeat(29);
writeSecret("gateway.token", TOKEN);
writeSecret("master.key", Buffer.alloc(32, 7).toString("base64"));

test("沙箱：有 bwrap 时密钥目录在命令里不存在，QUETZAL_HOME 只读，保密库可读，普通命令照常", { skip: !hasBwrap && "没有 bwrap" }, async () => {
  sandbox.resetSandbox();
  assert.equal(sandbox.sandboxStatus().kind, "bwrap");
  const r = await shell(`cat ${path.join(paths.secrets, "master.key")}; echo rc=$?; ls -A ${paths.secrets} | wc -l`);
  assert.match(r.out, /rc=1/);
  assert.match(r.out, /^0$/m, "目录是空的");
  assert.doesNotMatch(r.out + r.err, new RegExp(Buffer.alloc(32, 7).toString("base64").slice(0, 20)));
  const v = saveSecret("demo_token", "vault-value-123456");
  assert.equal((await shell(`cat ${v}`)).out, "vault-value-123456", "保密库在沙箱里可读（pass_secret 的用法）");
  const ro = await shell(`touch ${path.join(paths.config, "x")} 2>&1; echo rc=$?`);
  assert.match(ro.out, /rc=1/, "配置目录只读");
  assert.match((await shell(`touch ${path.join(paths.data, "ok")} && echo ok`)).out, /ok/, "data/ 可写");
  assert.equal((await shell("echo hello; pwd")).out, `hello\n${os.homedir()}\n`, "工作目录是用户主目录");
  // 后台任务同样在沙箱里
  const j = await startJob(`cat ${path.join(paths.secrets, "gateway.token")} || echo hidden`);
  for (let i = 0; i < 50 && !getJob(j.id)!.ended; i++) await new Promise((r) => setTimeout(r, 100));
  assert.match(getJob(j.id)!.out, /hidden/);
  assert.doesNotMatch(getJob(j.id)!.out, /gw_x/);
});

test("沙箱：自造工具（sh 与 node）在子进程、沙箱里运行，读不到密钥", { skip: !hasBwrap && "没有 bwrap" }, async () => {
  saveConfig({ permissions: { shell: "allow", self_modify: "allow" } });
  const reserved = new Set<string>();
  await ct.writeTool({ name: "peek_node", description: "x", runtime: "node", skill: "x", timeout: 10,
    source: `import fs from "node:fs";\nexport default async (a, { home }) => { try { return fs.readFileSync(home + "/secrets/gateway.token", "utf8"); } catch (e) { return "hidden:" + process.pid; } };` }, reserved);
  await ct.writeTool({ name: "peek_sh", description: "x", runtime: "sh", skill: "x", source: `cat "${paths.secrets}/gateway.token" 2>/dev/null || echo hidden` }, reserved);
  const n = await callTool("peek_node", {}, "测试");
  assert.match(n.text, /^hidden:\d+$/);
  assert.notEqual(n.text, `hidden:${process.pid}`, "不在运行基座的进程里");
  assert.equal((await callTool("peek_sh", {}, "测试")).text.trim(), "hidden");
});

test("没有可用沙箱时默认拒绝执行（fail-closed）；部署者明确允许后才不隔离运行", async () => {
  process.env.QUETZAL_SANDBOX = "none";
  try {
    sandbox.resetSandbox();
    assert.equal(sandbox.sandboxStatus().kind, "none");
    assert.equal(sandbox.sandboxStatus().allowUnsandboxed, false);
    const r = await shell("echo hi");
    assert.equal(r.code, 126);
    assert.equal(r.out, "");
    assert.match(r.err, /没有执行：.*沙箱/);
    await assert.rejects(() => startJob("echo hi"), /没有执行/);
    saveConfig({ sandbox: { allowUnsandboxed: true } } as never);
    assert.equal((await shell("echo hi")).out, "hi\n"); // Windows 上是 PowerShell：输出的 CRLF 统一成 LF
  } finally { saveConfig({ sandbox: { allowUnsandboxed: false } } as never); delete process.env.QUETZAL_SANDBOX; sandbox.resetSandbox(); }
});

test("Landlock 授权展开：只拆开含有特殊路径的目录，藏起的不授权，只读与可写按规则", { skip: process.platform === "win32" && "Landlock 只在 Linux 上" }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ll-"));
  for (const d of ["a/b/secret", "a/b/keep", "a/c", "d"]) fs.mkdirSync(path.join(root, d), { recursive: true });
  fs.writeFileSync(path.join(root, "a/file"), "");
  const rules = new Map([[path.join(root, "a/b/secret"), "hide"], [path.join(root, "a/c"), "ro"]] as const);
  const g = sandbox.landlockGrants(new Map(rules), root);
  const pairs = []; for (let i = 0; i < g.length; i += 2) pairs.push(`${g[i]} ${path.relative(root, g[i + 1])}`);
  assert.deepEqual(pairs.sort(), ["--rox a/c", "--rwx a/b/keep", "--rwx a/file", "--rwx d"].sort());
});

test("探针：一个其实不隔离的「沙箱」（例如内核不支持 Landlock 时 --best-effort 不加限制）不会被采用", async () => {
  const fake = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fake-landrun-")), "landrun");
  fs.writeFileSync(fake, '#!/bin/sh\nwhile [ "$1" != "--" ]; do shift; done; shift; exec "$@"\n', { mode: 0o755 });
  process.env.QUETZAL_SANDBOX = "landlock"; process.env.QUETZAL_LANDRUN = fake;
  try {
    sandbox.resetSandbox();
    assert.notEqual(sandbox.sandboxStatus().kind, "landlock", "探针读得到，就不用它");
  } finally { delete process.env.QUETZAL_SANDBOX; delete process.env.QUETZAL_LANDRUN; sandbox.resetSandbox(); }
});

const landrunBin = process.env.QUETZAL_TEST_LANDRUN;
test("沙箱：Landlock（landrun）里密钥目录不可读、QUETZAL_HOME 只读、data/ 可写、网络照常", { skip: !landrunBin && "没有设置 QUETZAL_TEST_LANDRUN（landrun 的路径）" }, async () => {
  process.env.QUETZAL_SANDBOX = "landlock"; process.env.QUETZAL_LANDRUN = landrunBin;
  try {
    sandbox.resetSandbox();
    assert.equal(sandbox.sandboxStatus().kind, "landlock");
    const r = await shell(`cat ${path.join(paths.secrets, "master.key")} 2>&1; echo rc=$?`);
    assert.match(r.out, /rc=1/);
    assert.doesNotMatch(r.out, new RegExp(Buffer.alloc(32, 7).toString("base64").slice(0, 20)));
    assert.match((await shell(`touch ${path.join(paths.config, "x")} 2>&1; echo rc=$?`)).out, /rc=1/, "配置目录只读");
    assert.match((await shell(`touch ${path.join(paths.data, "ll-ok")} && echo ok`)).out, /ok/, "data/ 可写");
    assert.equal((await shell("echo $HOME")).out.trim(), os.homedir(), "环境变量传进去了");
    const v = saveSecret("ll_token", "ll-vault-value");
    assert.equal((await shell(`cat ${v}`)).out, "ll-vault-value", "保密库可读");
  } finally { delete process.env.QUETZAL_SANDBOX; delete process.env.QUETZAL_LANDRUN; sandbox.resetSandbox(); }
});

test("read_document / view_image：按真实路径拒绝密钥目录与保密库（符号链接也不行）", async () => {
  const link = path.join(paths.data, "innocent.txt");
  fs.symlinkSync(path.join(paths.secrets, "gateway.token"), link);
  const r = await callTool("read_document", { path: link }, "测试");
  assert.match(r.text, /密钥目录/);
  assert.doesNotMatch(r.text, /gw_x/);
  const vaultFile = saveSecret("read_guard_token", "vault-value-654321");
  assert.match((await callTool("read_document", { path: vaultFile }, "测试")).text, /保密库/);
  assert.match((await callTool("read_document", { path: path.join(paths.vault, "no_such_name") }, "测试")).text, /保密库/, "不存在的名字也拒绝，不透露有没有");
  assert.match((await callTool("read_document", { path: `${paths.data}/../secrets/master.key` }, "测试")).text, /密钥目录/);
  assert.match(sandbox.protectedPath(link)!, /密钥目录/);
  assert.equal(sandbox.protectedPath(path.join(paths.data, "nope")), undefined);
});

test("脱敏：基座自己的密钥也替换；工具参数写进审计前替换", async () => {
  assert.equal(redactSecrets(`令牌 ${TOKEN} 完`), "令牌 ‹secret:gateway.token› 完");
  writeSecret("sync.json", JSON.stringify({ token: "sync_tok_abcdefghijklmnop", server: "https://sync.example.com" }));
  assert.equal(redactSecrets("x sync_tok_abcdefghijklmnop"), "x ‹secret:sync.json›", "JSON 里的字符串值");
  assert.equal(redactSecrets("https://sync.example.com"), "https://sync.example.com", "地址不算密钥");
  assert.deepEqual(redactArgs({ command: `curl -H "x: ${TOKEN}"` }), { command: 'curl -H "x: ‹secret:gateway.token›"' });
  await callTool("recent_actions", { name: TOKEN }, "测试");
  assert.doesNotMatch(JSON.stringify(store.listAudit(5)), /gw_x{20}/, "审计里没有明文");
});

test("闸门：自造工具至少和 shell 一样严；造工具缺省每次询问", async () => {
  assert.equal(config.permissions.tool_write, "ask");
  saveConfig({ permissions: { shell: "deny", network: "allow" } });
  assert.equal(strictest(["network", "shell"]), "shell");
  await ct.writeTool({ name: "net_thing", description: "x", runtime: process.platform === "win32" ? "ps1" : "sh", permission: "network", skill: "x", source: "'ran'" }, new Set());
  assert.equal((await callTool("net_thing", {}, "测试")).status, "denied", "声明 network 也放不过 shell=deny");
  saveConfig({ permissions: { shell: "allow", tool_write: "deny" } });
  assert.equal((await callTool("tool_write", { name: "zz", description: "x", runtime: process.platform === "win32" ? "ps1" : "sh", source: "'x'", skill: "x" }, "测试")).status, "denied");
  saveConfig({ permissions: { tool_write: "ask" } });
});

test("web_fetch：拒绝本机、内网、链路本地、CGNAT 与元数据地址，重定向每一跳都检查", async () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fe80::1", "fd00::1", "::ffff:127.0.0.1", "::ffff:7f00:1"]) assert.ok(blockedIp(ip), ip);
  for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700::1111"]) assert.ok(!blockedIp(ip), ip);
  assert.match((await checkUrl(new URL("http://localhost:7788/auth/local")))!, /本机/);
  assert.match((await checkUrl(new URL("http://[::1]/")))!, /本机/);
  assert.match((await checkUrl(new URL("file:///etc/passwd")))!, /http/);
  const server = http.createServer((_, res) => res.end("secret page")).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  try {
    await assert.rejects(guardedFetch(`http://127.0.0.1:${(server.address() as any).port}/`), /内网或本机/);
    const r = await callTool("web_fetch", { url: `http://127.0.0.1:${(server.address() as any).port}/` }, "测试");
    assert.doesNotMatch(r.text, /secret page/);
  } finally { server.close(); }
});

test("语音端点只接受 Azure 的 HTTPS 域名；voice_config 不能改端点；同步来的坏端点被清空", async () => {
  assert.ok(speechEndpointOk("https://eastasia.tts.speech.microsoft.com"));
  assert.ok(speechEndpointOk("https://myres.cognitiveservices.azure.com/"));
  assert.ok(!speechEndpointOk("https://evil.example/microsoft.com"));
  assert.ok(!speechEndpointOk("http://eastasia.tts.speech.microsoft.com"));
  assert.ok(!speechEndpointOk("https://microsoft.com.evil.example"));
  saveConfig({ permissions: { self_modify: "allow" } });
  const r = await callTool("voice_config", { action: "set", endpoint: "https://evil.example" }, "测试");
  assert.match(r.text, /只能由对方/);
  assert.equal(config.speech.endpoint, "");
  saveConfig({ speech: { endpoint: "https://evil.example" } }, { remote: true });
  assert.equal(config.speech.endpoint, "", "来自其他身体的坏端点");
});

test("密钥文件：原子写入、0600；主密钥损坏时报错而不是重新生成", async () => {
  const f = path.join(paths.secrets, "probe");
  fs.writeFileSync(f, "old", { mode: 0o644 });
  writeSecret("probe", "new-value");
  assert.equal(readSecret("probe"), "new-value");
  if (process.platform !== "win32") assert.equal(fs.statSync(f).mode & 0o777, 0o600); // Windows 上 chmod 只改只读位，权限靠 ACL（另有测试）
  assert.equal(fs.readdirSync(paths.secrets).filter((x) => x.endsWith(".tmp")).length, 0);
  if (process.platform !== "win32") assert.equal(fs.statSync(paths.home).mode & 0o777, 0o700); // Windows 上 chmod 只改只读位，权限靠 ACL（另有测试）
  const { encrypt } = await import("../src/crypto.ts");
  const good = readSecret("master.key")!;
  fs.writeFileSync(path.join(paths.secrets, "master.key"), "");
  try { assert.throws(() => encrypt("x", "p"), /master\.key 损坏/); assert.equal(fs.readFileSync(path.join(paths.secrets, "master.key"), "utf8"), "", "没有被重新生成"); }
  finally { writeSecret("master.key", good); }
});

test("附件：符号链接与真实路径出了 uploads 的都不给", () => {
  const day = path.join(uploadsDir(), "2026-01-01");
  fs.mkdirSync(day, { recursive: true });
  fs.writeFileSync(path.join(day, "aaaaaaaaaaaa-ok.txt"), "ok");
  fs.symlinkSync(path.join(paths.secrets, "gateway.token"), path.join(day, "bbbbbbbbbbbb-x.txt"));
  fs.symlinkSync(paths.secrets, path.join(uploadsDir(), "2026-01-02"));
  assert.ok(resolveUpload("2026-01-01/aaaaaaaaaaaa-ok.txt"));
  assert.equal(resolveUpload("2026-01-01/bbbbbbbbbbbb-x.txt"), undefined);
  assert.equal(resolveUpload("2026-01-02/gateway.token"), undefined);
  assert.equal(resolveUpload("../secrets/gateway.token"), undefined);
});

test("网关令牌的取法：Bearer、X-Quetzal-Token、旧的查询参数", () => {
  const req = (url: string, headers: Record<string, string> = {}) => ({ url, headers }) as any;
  assert.equal(tokenOf(req("/upload", { authorization: "Bearer abc" })), "abc");
  assert.equal(tokenOf(req("/upload", { "x-quetzal-token": "def" })), "def");
  assert.equal(tokenOf(req("/upload?token=ghi")), "ghi");
  assert.equal(tokenOf(req("/upload")), "");
});

test("Windows：密钥目录与保密库的 ACL 只有本用户与 SYSTEM（chmod 在 Windows 上不起作用）", { skip: process.platform !== "win32" && "只在 Windows 上" }, () => {
  for (const d of [paths.secrets, paths.vault]) {
    const acl = execFileSync("icacls", [d], { encoding: "utf8" });
    assert.doesNotMatch(acl, /Everyone|BUILTIN\\Users|Authenticated Users|\(I\)/, `${d} 不该有别的用户，也不该有继承来的权限：\n${acl}`);
    assert.match(acl, new RegExp(`${process.env.USERNAME}:\\(OI\\)\\(CI\\)\\(F\\)`, "i"));
  }
});
