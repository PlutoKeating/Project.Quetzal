// 一键安装脚本 install.sh 的 macOS 分支：去掉最后一行 main 调用后 source 进 bash，用假的 uname / sw_vers / launchctl / xcode-select / git
// 模拟一台 Mac，单独调用各个函数。这台测试机不是 Mac：不碰真的 launchd。
import { test as base } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const test = (name: string, fn: () => void | Promise<void>) => base(name, { skip: process.platform === "win32" && "只用于 POSIX" }, fn);

const script = join(dirname(fileURLToPath(import.meta.url)), "..", "install.sh");
const dir = mkdtempSync(join(tmpdir(), "quetzal-install-mac-"));
const lib = join(dir, "lib.sh");
writeFileSync(lib, readFileSync(script, "utf8").replace(/\nmain "\$@"\s*$/, "\n"));

/** 一台假 Mac：bin 目录里的假命令按环境变量回应，调用记在 calls 文件里。 */
function fakeMac(o: { version?: string; arch?: string; gui?: boolean; git?: boolean; clt?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "quetzal-fakemac-"));
  const bin = join(root, "bin"), home = join(root, "home"), calls = join(root, "calls");
  mkdirSync(bin); mkdirSync(home);
  const cmd = (name: string, body: string) => { writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*" >> "${calls}"\n${body}\n`); chmodSync(join(bin, name), 0o755); };
  cmd("uname", `case "$1" in -s) echo Darwin;; -m) echo ${o.arch ?? "arm64"};; *) echo Darwin;; esac`);
  cmd("sw_vers", `echo ${o.version ?? "14.5"}`);
  cmd("sysctl", "echo 0");
  cmd("launchctl", `case "$1" in print) case "$2" in gui/*/*) exit 0;; gui/*) exit ${o.gui === false ? 113 : 0};; *) exit 0;; esac;; *) exit 0;; esac`);
  cmd("xcode-select", `case "$1" in -p) exit ${o.clt ? 0 : 2};; *) exit 0;; esac`);
  cmd("git", `exit ${o.git === false ? 1 : 0}`);
  return { root, bin, home, calls };
}
function sh(m: ReturnType<typeof fakeMac>, code: string) {
  const r = spawnSync("bash", ["-c", `source "$LIB"; LOG=/dev/null; setup_term; ${code}`], {
    env: { PATH: `${m.bin}:/usr/bin:/bin`, HOME: m.home, LIB: lib, LANG: "C.UTF-8", QUETZAL_LANG: "zh" }, encoding: "utf8",
  });
  return { code: r.status, out: r.stdout, err: r.stderr, calls: existsSync(m.calls) ? readFileSync(m.calls, "utf8") : "" };
}

test("认出 Mac：系统版本、架构、图形登录会话；文档链接指向 macOS 页；太老的系统直接说明", () => {
  const m = fakeMac();
  const r = sh(m, `pick_lang; detect_os; detect_machine; echo "mac=$IS_MAC os=$OS_NAME arch=$ARCH session=$HAS_SESSION desktop=$HAS_DESKTOP systemd=$HAS_SYSTEMD libc=$LIBC docs=$DOCS"`);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /mac=1 os=macOS 14\.5 arch=arm64 session=1 desktop=1 systemd=0 libc=darwin docs=https:\/\/quetzal\.plutokeating\.beer\/zh\/docs\/advanced\/macos/);
  const ssh = sh(fakeMac({ gui: false, arch: "x86_64" }), `detect_machine; echo "session=$HAS_SESSION arch=$ARCH"`);
  assert.match(ssh.out, /session=0 arch=x86_64/);
  const old = sh(fakeMac({ version: "11.7" }), `pick_lang; detect_machine; echo reached`);
  assert.notEqual(old.code, 0);
  assert.match(old.out, /需要 macOS 12 以上/);
  const odd = sh(fakeMac({ arch: "ppc" }), `pick_lang; detect_machine; echo reached`);
  assert.match(odd.out, /不支持这个处理器架构/);
  assert.match(sh(m, `pick_lang; detect_os; banner`).out, /macOS 安装器/);
});

test("git 来自 Xcode 命令行工具：没有就弹出系统的安装对话框并说明重跑；有就继续", () => {
  const ok = sh(fakeMac(), `pick_lang; IS_MAC=1; ensure_tools; echo rc=$?`);
  assert.match(ok.out, /git、curl、tar 都在[\s\S]*rc=0/);
  const missing = fakeMac({ git: false, clt: false });
  const r = sh(missing, `pick_lang; IS_MAC=1; ensure_tools; echo reached`);
  assert.notEqual(r.code, 0);
  assert.doesNotMatch(r.out, /reached/);
  assert.match(r.out, /Xcode 命令行工具/);
  assert.match(r.calls, /xcode-select --install/);
  const broken = sh(fakeMac({ git: false, clt: true }), `pick_lang; IS_MAC=1; ensure_tools; echo reached`);
  assert.match(broken.out, /xcodebuild -license/);
  assert.doesNotMatch(broken.calls, /--install/);
});

test("命令沙箱：系统自带的 sandbox-exec 能用就是 srt，用不了只提示（运行基座 fail-closed）；不去找 Landlock / proot", () => {
  const m = fakeMac();
  const good = join(m.bin, "sandbox-exec"); writeFileSync(good, "#!/bin/sh\nexit 0\n"); chmodSync(good, 0o755);
  assert.match(sh(m, `pick_lang; IS_MAC=1; SANDBOX_EXEC="${good}"; ensure_sandbox; ensure_landlock; echo "sandbox=$SANDBOX"`).out, /命令沙箱可用（系统自带的 sandbox-exec[\s\S]*sandbox=srt/);
  const bad = join(m.bin, "sandbox-bad"); writeFileSync(bad, "#!/bin/sh\nexit 1\n"); chmodSync(bad, 0o755);
  const r = sh(m, `pick_lang; IS_MAC=1; SANDBOX_EXEC="${bad}"; ensure_sandbox; ensure_landlock; echo "sandbox=[$SANDBOX]"`);
  assert.match(r.out, /用不了：运行基座会拒绝执行她的命令[\s\S]*sandbox=\[\]$/m);
  assert.doesNotMatch(r.out, /landrun|proot/);
});

test("PATH：macOS 的缺省 shell 是 zsh——没有 .zshrc 也要建；已有的 .bash_profile 一并加上，不碰没有的 .bashrc", () => {
  const m = fakeMac();
  writeFileSync(join(m.home, ".bash_profile"), "# mine\n");
  const r = sh(m, `pick_lang; IS_MAC=1; HOME_DIR="$HOME/.quetzal"; NODE=/n/node; QCLI=/q/quetzal.mjs; PATH="/usr/bin:/bin"; write_shim; echo done`);
  assert.equal(r.code, 0, r.err);
  assert.match(readFileSync(join(m.home, ".zshrc"), "utf8"), /export PATH="\$HOME\/\.local\/bin:\$PATH"  # Quetzal/);
  assert.match(readFileSync(join(m.home, ".bash_profile"), "utf8"), /# Quetzal/);
  assert.equal(existsSync(join(m.home, ".bashrc")), false);
  assert.match(readFileSync(join(m.home, ".local", "bin", "quetzal"), "utf8"), /exec '\/n\/node' '\/q\/quetzal\.mjs' "\$@"/);
});

test("守护：确认 launchd 用户代理已注册、运行基座在响应；控制台用网页版，并说明计算机使用要给 node 哪两项权限", () => {
  const m = fakeMac();
  const r = sh(m, `pick_lang; IS_MAC=1; HAS_SESSION=1; HAS_DESKTOP=1; DESKTOP=1; HOME_DIR="$HOME/.quetzal"; NODE=/n/node; wait_healthy() { return 0; }; ensure_service; install_desktop; echo "desc=$SERVICE_DESC"`);
  assert.equal(r.code, 0, r.err);
  assert.match(r.calls, /launchctl print gui\/\d+\/xyz\.quetzal\.runtime/);
  assert.match(r.out, /launchd 用户代理 xyz\.quetzal\.runtime：登录时拉起/);
  assert.match(r.out, /辅助功能 与 屏幕与系统录音[\s\S]*\/n\/node/);
  assert.match(r.out, /desc=launchd 用户代理/);
  assert.doesNotMatch(r.out, /原生控制台|applications/);
});

test("卸载：卸下 launchd 用户代理（两个域都试）并删掉 plist、垫片与 npm 前缀，家目录默认保留", () => {
  const m = fakeMac();
  const agents = join(m.home, "Library", "LaunchAgents"); mkdirSync(agents, { recursive: true });
  writeFileSync(join(agents, "xyz.quetzal.runtime.plist"), "<plist/>");
  mkdirSync(join(m.home, ".quetzal", "npm"), { recursive: true }); mkdirSync(join(m.home, ".local", "bin"), { recursive: true });
  writeFileSync(join(m.home, ".local", "bin", "quetzal"), "x");
  const r = sh(m, `pick_lang; HOME_DIR="$HOME/.quetzal"; MODE=uninstall; detect_machine; uninstall`);
  assert.equal(r.code, 0, r.err);
  assert.match(r.calls, /launchctl bootout gui\/\d+\/xyz\.quetzal\.runtime[\s\S]*launchctl bootout user\/\d+\/xyz\.quetzal\.runtime/);
  assert.equal(existsSync(join(agents, "xyz.quetzal.runtime.plist")), false);
  assert.equal(existsSync(join(m.home, ".local", "bin", "quetzal")), false);
  assert.equal(existsSync(join(m.home, ".quetzal", "npm")), false);
  assert.equal(existsSync(join(m.home, ".quetzal")), true);
  assert.match(r.out, /launchd 用户代理已移除/);
});
