// macOS 的守护：launchd 用户代理的 plist 生成（XML 转义、KeepAlive / RunAtLoad、环境变量里的路径）与包装脚本的行为
// （在本机 sh 里实际运行：退出后有 state/quit 或 state/supervise.off 就以 0 退出、否则以 1 退出让 launchd 重启；日志轮转）。
// 这台测试机不一定是 Mac：不调用 launchctl。
import { test as base } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { plistText, WRAPPER, LABEL, xml } from "../src/launchd.ts";
import { defaultBody } from "../src/layout.ts";
import { bundled } from "../src/install.ts";
const test = (name: string, fn: () => void | Promise<void>) => base(name, { skip: process.platform === "win32" && "包装脚本是 POSIX sh" }, fn);

const unxml = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
/** plist 里 <key>k</key> 后面紧跟的那个值（字符串、true/false、整数或 dict 的原文）。 */
function value(plist: string, key: string): string | undefined {
  const m = plist.match(new RegExp(`<key>${key}</key>\\s*(<string>([\\s\\S]*?)</string>|<(true|false)/>|<integer>(\\d+)</integer>|<dict>([\\s\\S]*?)</dict>)`));
  return m ? (m[2] !== undefined ? unxml(m[2]) : m[3] ?? m[4] ?? m[5]) : undefined;
}

test("plist：标签、登录时拉起、非零退出才重启、3 秒节流；路径经环境变量传入并做 XML 转义", () => {
  const home = "/Users/a b/it's <q> & \"x\"/.quetzal";
  const node = "/Users/a b/.nvm/versions/node/v22.13.0/bin/node";
  const p = plistText({ home, node });
  assert.match(p, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<!DOCTYPE plist/);
  assert.equal(value(p, "Label"), LABEL);
  assert.equal(value(p, "RunAtLoad"), "true");
  assert.match(value(p, "KeepAlive")!, /<key>SuccessfulExit<\/key>\s*<false\/>/);
  assert.equal(value(p, "ThrottleInterval"), "3");
  assert.equal(value(p, "QUETZAL_HOME"), home);
  assert.equal(value(p, "QUETZAL_ADAPTER"), `${home}/current/macos.mjs`);
  assert.equal(value(p, "QUETZAL_NODE"), node);
  assert.equal(value(p, "PATH"), "/Users/a b/.nvm/versions/node/v22.13.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin");
  assert.equal(value(p, "WorkingDirectory"), home);
  assert.equal(value(p, "StandardOutPath"), `${home}/logs/launchd.log`);
  const args = [...p.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/)![1].matchAll(/<string>([\s\S]*?)<\/string>/g)].map((m) => unxml(m[1]));
  assert.deepEqual(args, ["/bin/sh", "-c", WRAPPER], "包装脚本原样还原，里面不含任何路径");
  assert.doesNotMatch(WRAPPER, /\/Users|\.quetzal/);
  // 没转义的特殊字符只可能出现在标签里
  assert.doesNotMatch(p.replace(/<\/?[A-Za-z!?][^<>]*>/g, ""), /[<>]/);
  assert.throws(() => plistText({ home: "/a\nb", node }), /换行/);
  assert.throws(() => xml("a\u0001b"), /控制字符/);
});

/** 在临时家目录里跑包装脚本：假的 node 记一行、按 code 退出。 */
function wrapper(setup: (home: string) => void, code = 0) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "quetzal-launchd-"));
  fs.mkdirSync(path.join(home, "current"), { recursive: true });
  fs.writeFileSync(path.join(home, "current", "main.cjs"), "");
  const fakeNode = path.join(home, "node.sh");
  fs.writeFileSync(fakeNode, `#!/bin/sh\necho "run $*" >> "${home}/runs"\nexit ${code}\n`);
  fs.chmodSync(fakeNode, 0o755);
  setup(home);
  const r = spawnSync("/bin/sh", ["-c", WRAPPER], { env: { PATH: process.env.PATH, QUETZAL_HOME: home, QUETZAL_NODE: fakeNode }, encoding: "utf8", timeout: 20_000 });
  return { home, status: r.status, log: fs.existsSync(path.join(home, "logs", "runtime.log")) ? fs.readFileSync(path.join(home, "logs", "runtime.log"), "utf8") : "" };
}

test("包装脚本：运行基座退出后，没有标志就以 1 退出（launchd 重启），带 --enable-source-maps 运行 current/main.cjs", () => {
  const r = wrapper(() => {});
  assert.equal(r.status, 1);
  assert.match(fs.readFileSync(path.join(r.home, "runs"), "utf8"), /^run --enable-source-maps .*\/current\/main\.cjs\n$/);
  assert.match(r.log, /launchd restarts it/);
});

test("包装脚本：守护开关关了（state/supervise.off）以 0 退出，launchd 不再拉起", () => {
  const r = wrapper((h) => { fs.mkdirSync(path.join(h, "state")); fs.writeFileSync(path.join(h, "state", "supervise.off"), ""); }, 3);
  assert.equal(r.status, 0);
});

test("包装脚本：启动时清掉上次留下的 state/quit；这次运行期间放的 quit 让它以 0 退出并删掉标志", () => {
  const stale = wrapper((h) => { fs.mkdirSync(path.join(h, "state")); fs.writeFileSync(path.join(h, "state", "quit"), ""); });
  assert.equal(stale.status, 1, "上次的 quit 不影响这次");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "quetzal-launchd-q-"));
  fs.mkdirSync(path.join(home, "current"), { recursive: true });
  const fakeNode = path.join(home, "node.sh");
  fs.writeFileSync(fakeNode, `#!/bin/sh\n: > "${home}/state/quit"\nexit 0\n`); // 运行期间托盘点了「退出」
  fs.chmodSync(fakeNode, 0o755);
  const r = spawnSync("/bin/sh", ["-c", WRAPPER], { env: { PATH: process.env.PATH, QUETZAL_HOME: home, QUETZAL_NODE: fakeNode }, timeout: 20_000 });
  assert.equal(r.status, 0);
  assert.equal(fs.existsSync(path.join(home, "state", "quit")), false);
});

test("包装脚本：日志超过 10 MB 轮转一份；没有 current 时记一行并以 1 退出", () => {
  const r = wrapper((h) => { fs.mkdirSync(path.join(h, "logs")); fs.writeFileSync(path.join(h, "logs", "runtime.log"), Buffer.alloc(10 * 1024 * 1024 + 1, 0x61)); });
  assert.equal(fs.statSync(path.join(r.home, "logs", "runtime.log.1")).size, 10 * 1024 * 1024 + 1);
  assert.ok(fs.statSync(path.join(r.home, "logs", "runtime.log")).size < 1000);
  const none = wrapper((h) => fs.rmSync(path.join(h, "current"), { recursive: true }));
  assert.equal(none.status, 1);
  assert.match(none.log, /no current version/);
});

test("包装脚本：launchd 停代理时发给它的 SIGTERM 转给运行基座，不留下孤儿进程", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "quetzal-launchd-t-"));
  fs.mkdirSync(path.join(home, "current"), { recursive: true });
  const fakeNode = path.join(home, "node.sh");
  fs.writeFileSync(fakeNode, `#!/bin/sh\necho $$ > "${home}/child.pid"\ntrap 'echo got-term >> "${home}/runs"; exit 0' TERM\nwhile :; do sleep 0.1; done\n`);
  fs.chmodSync(fakeNode, 0o755);
  const { spawn } = await import("node:child_process");
  const p = spawn("/bin/sh", ["-c", WRAPPER], { env: { PATH: process.env.PATH, QUETZAL_HOME: home, QUETZAL_NODE: fakeNode }, stdio: "ignore" });
  for (let i = 0; i < 100 && !fs.existsSync(path.join(home, "child.pid")); i++) await new Promise((r) => setTimeout(r, 50));
  p.kill("SIGTERM");
  const code = await new Promise<number | null>((r) => p.once("exit", (c) => r(c)));
  assert.equal(code, 1, "不是用户主动退出：以 1 退出（代理已被卸下时 launchd 不会再拉起）");
  assert.match(fs.readFileSync(path.join(home, "runs"), "utf8"), /got-term/);
  const pid = Number(fs.readFileSync(path.join(home, "child.pid"), "utf8"));
  assert.throws(() => process.kill(pid, 0), "运行基座已经结束");
});

test("身体名字的缺省：去掉 .local 后缀；拿不到时 macOS 叫 mac", () => {
  assert.equal(defaultBody("Someones-Laptop.local", "darwin"), "someones-laptop");
  assert.equal(defaultBody("box.local", "linux"), "box-local", "Linux 上照旧");
  assert.equal(defaultBody("...", "darwin"), "mac");
  assert.equal(defaultBody("", "linux"), "linux");
});

test("包里内置的文件：macOS 的适配器与命令沙箱库有就一起放进版本目录", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "quetzal-bundle-"));
  for (const f of ["main.cjs", "linux.mjs", "mermaid.mjs"]) fs.writeFileSync(path.join(dir, f), "");
  fs.writeFileSync(path.join(dir, "VERSION"), "9.9.9");
  assert.deepEqual(bundled(dir).files.map((f) => f.name), ["main.cjs", "linux.mjs", "mermaid.mjs"]);
  fs.writeFileSync(path.join(dir, "macos.mjs"), ""); fs.writeFileSync(path.join(dir, "srt.mjs"), "");
  assert.deepEqual(bundled(dir).files.map((f) => f.name), ["main.cjs", "linux.mjs", "mermaid.mjs", "macos.mjs", "srt.mjs"]);
  assert.equal(bundled(dir).version, "9.9.9");
});
