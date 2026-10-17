// macOS 的命令沙箱：sandbox-runtime 的文件系统配置（与 Linux 的 bwrap 等价）、由它生成的 Seatbelt 配置、探针与前置命令；
// 本机网关的 macOS 子孙进程检查（lsof）与进程表（ps）的解析。纯函数在任何系统上跑；真机部分只在 Mac 上、QUETZAL_TEST_SRT=1 时跑。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawnSync } from "node:child_process";
import { macFilesystem, MAC_USER_READONLY, MAC_HIDDEN } from "../src/sandbox-macos.ts";
import { lsofOwner } from "../src/web.ts";
import { parsePsMac } from "../src/mind/processes.ts";

const base = { home: "/Users/u/.quetzal", data: "/Users/u/.quetzal/data", soul: "/Users/u/.quetzal/soul", secrets: "/Users/u/.quetzal/secrets", userHome: "/Users/u", tmp: ["/private/tmp", "/private/var/folders/x/T"] };

test("文件系统配置：密钥与浏览器配置读不到，QUETZAL_HOME 整体只读，主目录与临时目录可写，启动项只读", () => {
  const f = macFilesystem({ ...base, homeRaw: "/Users/u/.quetzal/", share: ["/Volumes/Work", "/Users/u/.quetzal/data/x", "relative"] });
  assert.equal(f.denyRead[0], base.secrets);
  for (const h of MAC_HIDDEN) assert.ok(f.denyRead.includes(path.join(base.userHome, h)), h);
  assert.deepEqual(f.allowWrite, ["/Users/u", "/private/tmp", "/private/var/folders/x/T", "/Volumes/Work"], "share 里落在 QUETZAL_HOME 里的、相对路径都不要");
  assert.ok(f.denyWrite.includes(base.home) && f.denyWrite.includes("/Users/u/.quetzal/"), "真实路径与原始写法都只读");
  for (const r of ["Library/LaunchAgents", ".zshrc", ".ssh", ".gitconfig", "Library/Keychains"]) assert.ok(MAC_USER_READONLY.includes(r) && f.denyWrite.includes(path.join(base.userHome, r)), r);
});

test("文件系统配置：只列存在的用户路径；QUETZAL_HOME 等于主目录时只开放独立工作区", () => {
  const f = macFilesystem({ ...base, exists: (p) => p.endsWith(".zshrc") });
  assert.deepEqual(f.denyWrite.filter((p) => p.startsWith("/Users/u/") && !p.startsWith(base.home)), ["/Users/u/.zshrc"]);
  assert.deepEqual(f.denyRead, [base.secrets]);
  const special = macFilesystem({ ...base, home: "/Users/u", data: "/Users/u/data", soul: "/Users/u/soul", secrets: "/Users/u/secrets", workspace: "/Users/u/Quetzal", exists: () => false });
  assert.deepEqual(special.allowWrite, ["/Users/u/Quetzal", "/private/tmp", "/private/var/folders/x/T"]);
  assert.ok(!special.allowWrite.includes("/Users/u"), "主目录整体不可写");
  assert.ok(special.denyWrite.includes("/Users/u/data") && special.denyWrite.includes("/Users/u/soul"));
});

test("sandbox-runtime 据此生成的 Seatbelt 配置：缺省拒绝、密钥目录拒读、QUETZAL_HOME 拒写、网络只能连代理、不能发 Apple 事件", async () => {
  // 直接调用 sandbox-runtime 的 macOS 生成函数（SandboxManager 只在 Mac 上初始化），输入与 SandboxManager 传给它的形状一致
  const m: any = await import("@anthropic-ai/sandbox-runtime/dist/sandbox/macos-sandbox-utils.js");
  const f = macFilesystem({ ...base, exists: () => true });
  const s: string = m.wrapCommandWithSandboxMacOS({
    command: "echo hi", needsNetworkRestriction: true, httpProxyPort: 60001, socksProxyPort: 60002,
    readConfig: { denyOnly: f.denyRead, allowWithinDeny: [] }, writeConfig: { allowOnly: f.allowWrite, denyWithinAllow: f.denyWrite }, binShell: "sh",
  });
  assert.match(s, /\/usr\/bin\/sandbox-exec -p /);
  assert.match(s, /\(deny default/);
  assert.match(s, /\(deny file-read\*\s+\(subpath "\/Users\/u\/\.quetzal\/secrets"\)/);
  assert.match(s, /\(allow file-write\*\s+\(subpath "\/Users\/u"\)/);
  assert.match(s, /\(deny file-write\*\s+\(subpath "\/Users\/u\/\.quetzal"\)/);
  assert.match(s, /\(subpath "\/Users\/u\/Library\/LaunchAgents"\)/);
  assert.match(s, /\(allow network-outbound \(remote ip "localhost:60001"\)\)/);
  assert.doesNotMatch(s, /\(allow network\*\)/, "网络受限：只能连代理");
  assert.doesNotMatch(s, /appleevent-send/, "osascript 发不出 Apple 事件，控制不了别的应用");
  assert.match(s, /HTTPS_PROXY=http:\/\/localhost:60001/);
});

test("探针与前置命令：引号安全；TMPDIR 改回自己的临时目录，去掉绕过代理的 NO_PROXY", async () => {
  const { macProbeScript, macPrelude, shq } = await import("../src/sandbox.ts");
  assert.equal(shq("it's"), `'it'\\''s'`);
  const probe = macProbeScript("/a b/secrets", ".sandbox-canary", "/a b/state/.p");
  assert.match(probe, /cat '\/a b\/secrets\/\.sandbox-canary' .*exit 3/);
  assert.match(probe, /\( : > '\/a b\/state\/\.p' \) 2>\/dev\/null && exit 4; exit 0$/);
  // 在本机 sh 里实际跑一遍探针：密钥可读时 3，可写时 4，都不行时 0
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "quetzal-mac-probe-"));
  fs.mkdirSync(path.join(d, "secrets")); fs.mkdirSync(path.join(d, "state"));
  const runProbe = () => spawnSync("sh", ["-c", macProbeScript(path.join(d, "secrets"), ".c", path.join(d, "state", ".p"))]).status;
  fs.writeFileSync(path.join(d, "secrets", ".c"), "x");
  assert.equal(runProbe(), 3);
  fs.rmSync(path.join(d, "secrets", ".c"));
  assert.equal(runProbe(), 4, "写得进 state/");
  const pre = macPrelude("/private/var/folders/x/T");
  assert.equal(pre, "export TMPDIR='/private/var/folders/x/T'; unset NO_PROXY no_proxy; ");
  const env = spawnSync("sh", ["-c", `${pre}echo "$TMPDIR|\${NO_PROXY-unset}"`], { env: { ...process.env, NO_PROXY: "10.0.0.0/8" }, encoding: "utf8" }).stdout.trim();
  assert.equal(env, "/private/var/folders/x/T|unset");
});

test("本机网关的子孙进程检查（macOS）：lsof 找出连接的所属进程（客户端一侧），不认网关自己那一侧", () => {
  const out = "p100\nn127.0.0.1:7788->127.0.0.1:54321\np200\nn127.0.0.1:54321->127.0.0.1:7788\np300\nn[::1]:60000->[::1]:7788\n";
  assert.equal(lsofOwner(out, 54321, 7788), 200);
  assert.equal(lsofOwner(out, 60000, 7788), 300);
  assert.equal(lsofOwner(out, 11111, 7788), undefined);
});

test("进程表（macOS 的 ps）：pid、父进程、状态、已运行时长、命令行", () => {
  const now = 1_000_000_000_000;
  const list = parsePsMac("  101     1 Ss   2-03:04:05 /sbin/launchd\n  555   101 R       01:02 node --enable-source-maps /Users/u/.quetzal/current/main.cjs\n  556   555 S    1:00:00 /bin/zsh -c echo hi\nbad line\n", now);
  assert.deepEqual(list.map((p) => [p.pid, p.ppid, p.state]), [[101, 1, "S"], [555, 101, "R"], [556, 555, "S"]]);
  assert.equal(list[0].startedMs, now - (2 * 86400 + 3 * 3600 + 4 * 60 + 5) * 1000);
  assert.equal(list[1].startedMs, now - 62_000);
  assert.equal(list[2].cmd, "/bin/zsh -c echo hi");
});

// ---------------------------------------------------------------- 真机（Mac 上、QUETZAL_TEST_SRT=1）
const RUN = process.platform === "darwin" && process.env.QUETZAL_TEST_SRT === "1";
const skip = !RUN && "只在 Mac 上跑（QUETZAL_TEST_SRT=1）";

test("Mac 真机：沙箱就绪，密钥读不到、QUETZAL_HOME 写不进、连不到本机端口", { skip }, async () => {
  process.env.QUETZAL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "quetzal-srt-mac-"));
  const config = await import("../src/config.ts");
  config.loadConfig();
  (await import("../src/store.ts")).openStore();
  config.writeSecret("gateway.token", "gw_secret_value_123456789");
  const sandbox = await import("../src/sandbox.ts");
  const sh = await import("../src/sh.ts");
  await sandbox.prepareSandbox();
  assert.equal(sandbox.sandboxStatus().kind, "srt", sandbox.sandboxStatus().note);
  const out = async (cmd: string) => (await sh.shell(cmd, 30_000)).out;
  const secret = await out(`cat '${path.join(config.paths.secrets, "gateway.token")}' 2>&1; echo rc=$?`);
  assert.doesNotMatch(secret, /gw_secret_value/);
  const write = await out(`touch '${path.join(config.paths.home, "x")}' 2>&1; echo rc=$?`);
  assert.match(write, /rc=1/);
  const server = http.createServer((_q, r) => r.end("hello")).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const port = (server.address() as { port: number }).port;
  const local = await out(`curl -s -m 5 http://127.0.0.1:${port}/ ; echo rc=$?`);
  server.close();
  assert.doesNotMatch(local, /hello/);
});
