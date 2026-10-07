// 沙箱：agent 能运行的一切命令（shell 工具、后台任务、自造工具 sh 与 node）都经这里包一层，让基座的密钥目录（QUETZAL_HOME/secrets）在里面不存在。
//   agent 与基座是同一个系统用户，工具层的拦截（tools.ts 的 soulGitBlock / secretsBlock）只是提示，换个写法就绕过去；边界在这里。
//   - Linux：有 bubblewrap（bwrap）就用它。整个文件系统按主机原样挂进来（网络照常），然后：
//       secrets/ 换成空的 tmpfs；QUETZAL_HOME 其余部分只读（data/ 与灵魂目录的工作区可写，灵魂目录的 .git 只读）；
//       用户的 shell 启动文件、systemd 用户单元、自启动项、~/.ssh 只读，浏览器配置目录（里面有网页控制台的令牌与各网站的 Cookie）换成空的；
//       会话 D-Bus 与 systemd 用户实例的套接字不可用（否则 systemd-run 能在沙箱外起进程）；新的 pid 命名空间（看不到也碰不到沙箱外的进程，
//       /proc/<pid>/root 走不出去），基座退出时沙箱里的一切随之结束。
//     Ubuntu 23.10 起默认用 AppArmor 限制非特权用户命名空间：安装器会把 bwrap 复制一份到 root 所有的 /usr/local/lib/quetzal/bwrap，
//     只给这一份配一个允许 userns 的 AppArmor 配置（不动系统的 /usr/bin/bwrap，也就不影响 Flatpak 等），这里优先用它。
//   - Linux 上 bwrap 用不了（内核或系统禁止了非特权用户命名空间、容器里）：用 Landlock（内核 5.13 起的访问控制，不需要用户命名空间），
//       启动器是 landrun（MIT，随发布资产分发、签名核对，安装器放在 QUETZAL_HOME/bin/landrun）。Landlock 只能授权、不能排除，
//       所以从根目录往下展开：含有特殊路径的那几层目录逐项授权其子项，其余整块授权；密钥目录、浏览器配置不授权（不可见），
//       QUETZAL_HOME 除 data/ 与灵魂工作区外、用户的启动文件等只读。代价：被展开的那几层目录本身（/、/home、主目录、QUETZAL_HOME、~/.config）
//       不能列出、不能直接在里面新建文件，里面已有的东西照常可用。网络不限制；IPC 按 Landlock 的作用域限制（不能给沙箱外的进程发信号）。
//   - Termux（安卓）：有 proot 就用它，把 secrets/、config/、releases/、runit 服务目录与开机脚本目录绑定成空目录（proot 不能只读绑定）。
//       proot 基于 ptrace，是尽力而为：它挡得住普通的读文件，挡不住经 Android 的 intent（RUN_COMMAND）让 Termux 在沙箱外执行命令。
//   - Windows：用 sandbox-runtime（Anthropic，Apache-2.0）的 Windows 后端与它自带的 srt-win.exe（kind = "srt"）。她的命令以安装时建好的
//       低权限本地用户 srt-sandbox 运行：它对本用户的文件本来没有任何权限，只授权工作区（%USERPROFILE%\Quetzal）、data\、灵魂目录（.git 拒写）、
//       保密库与自造工具（只读）、Node 所在目录（只读）；secrets\、config\ 不授权即不可见，另外显式拒读。网络：WFP 拦下这个用户的一切直连，
//       只能经运行基座进程里的代理出去；代理拒绝回环、未指定、链路本地、元数据地址与这台机器自己的地址（连不到本机网关），局域网照常（与 Linux 一致）。
//       安装时要一次 UAC（建用户、装 WFP 规则，见 cli/windows）；没装好就 fail-closed。
//   - 都没有：默认拒绝执行她的命令（fail-closed，参考 DeepSeek Harness），status.sandbox.kind 为 "none"，时间线与日志各提醒一次；
//       部署者可以在控制台「高级 · 运行」页明确选择「不隔离也运行」（config.sandbox.allowUnsandboxed，不安全）。安装器负责装上可用的沙箱。
//   每种沙箱在第一次使用前都实际验证一次：密钥目录在里面确实看不到（有内容时），否则不用它。
//   保密库（vault/）在沙箱里仍然可读：pass_secret 的用法就是在命令里引用 "$(cat vault/名字)"。
//   环境变量 QUETZAL_SANDBOX=none 强制不用沙箱（只给部署者排查问题用）。
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { paths, isAndroid, config } from "./config.ts";
import { log } from "./log.ts";
import { addTimeline } from "./store.ts";
import { isWindows, which as whichCmd } from "./platform.ts";

export type SandboxKind = "bwrap" | "landlock" | "proot" | "srt" | "none";
export interface SandboxStatus { kind: SandboxKind; hidden: string[]; readonly: string[]; note: string; allowUnsandboxed: boolean }

/** 安装器放置的专用 bwrap（root 所有，带允许 userns 的 AppArmor 配置）与 landrun 的位置。 */
export const DEDICATED_BWRAP = "/usr/local/lib/quetzal/bwrap";
const CANARY = ".sandbox-canary"; // 探测用的无害文件
const landrunPath = () => process.env.QUETZAL_LANDRUN || path.join(paths.home, "bin", "landrun");

/** 没有沙箱时是否仍然执行（部署者在控制台明确打开；缺省拒绝）。 */
const allowUnsandboxed = () => config.sandbox?.allowUnsandboxed === true;

/** 没有可用沙箱、又没有允许不隔离运行时，wrap 抛出它：工具把说明交给她，命令不执行。 */
export class SandboxUnavailable extends Error {
  constructor() { super(`没有执行：这台机器上没有可用的命令沙箱（${isWindows ? "Windows 需要安装时建好的沙箱用户与网络规则" : "Linux 需要 bubblewrap 或 Landlock，Termux 需要 proot"}），为了不让命令读到基座的密钥，基座拒绝执行。请告诉对方：重新运行一次安装即可补上；或者在控制台「高级 · 运行」页明确选择允许不隔离运行（不安全）。`); this.name = "SandboxUnavailable"; }
}

interface Probe { kind: SandboxKind; bin: string; pidns: boolean }
type Mode = "hide" | "ro" | "rw";
let probed: Probe | undefined;
let warned = false;

const real = (p: string) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const exists = (p: string) => { try { fs.lstatSync(p); return true; } catch { return false; } };

const which = (cmd: string) => whichCmd(cmd);

const sh = () => process.env.SHELL && fs.existsSync(process.env.SHELL) ? process.env.SHELL : (which("sh") ?? "/bin/sh");

/** proot 用来遮住目录的空目录（0700）。 */
function emptyDir(): string {
  const d = path.join(paths.state, "sandbox-empty");
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  try { for (const f of fs.readdirSync(d)) fs.rmSync(path.join(d, f), { recursive: true, force: true }); } catch { /* 留着也无妨：只是挡住真正的目录 */ }
  return d;
}

/** 用户家目录里改了会在沙箱外执行的东西（登录 shell、systemd 用户单元、自启动、ssh 配置）：只读。 */
function userReadonly(): string[] {
  const h = os.homedir();
  return [".bashrc", ".bash_profile", ".bash_login", ".profile", ".zshrc", ".zshenv", ".zprofile", ".zlogin", ".xprofile", ".xsessionrc", ".pam_environment",
    ".config/systemd", ".config/autostart", ".config/fish", ".config/environment.d", ".local/bin", ".local/share/applications", ".ssh", ".gitconfig", ".config/git"]
    .map((x) => path.join(h, x)).filter(exists);
}
/** 浏览器的配置目录：网页控制台的令牌（localStorage）与各网站的 Cookie 都在里面，沙箱里换成空的。 */
function browserDirs(): string[] {
  const h = os.homedir();
  return [".mozilla", ".config/google-chrome", ".config/chromium", ".config/BraveSoftware", ".config/microsoft-edge", ".config/vivaldi", ".config/opera",
    "snap/firefox", "snap/chromium", ".var/app"].map((x) => path.join(h, x)).filter((p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } });
}

/** QUETZAL_HOME 里沙箱中可写的目录：data/（媒体、附件、下载）与灵魂目录的工作区。 */
const writable = () => [paths.data, paths.soul];

function bwrapArgs(pidns: boolean): string[] {
  const a = ["--dev-bind", "/", "/"];
  if (pidns) a.push("--unshare-pid", "--proc", "/proc");
  const home = real(paths.home);
  // 家目录就是用户主目录（或根目录）时不能整个只读，只把 config/ 与 state/ 只读
  if (home !== real(os.homedir()) && home !== "/") a.push("--ro-bind", home, home);
  else for (const d of [paths.config, paths.state, paths.tools, paths.vault]) if (exists(d)) a.push("--ro-bind", real(d), real(d));
  for (const d of writable()) if (exists(d)) a.push("--bind", real(d), real(d));
  const git = path.join(paths.soul, ".git");
  if (exists(git)) a.push("--ro-bind", real(git), real(git));
  for (const p of userReadonly()) a.push("--ro-bind", real(p), real(p));
  for (const p of browserDirs()) a.push("--tmpfs", real(p));
  const run = `/run/user/${process.getuid?.() ?? 0}`;
  if (exists(path.join(run, "bus"))) a.push("--ro-bind", "/dev/null", path.join(run, "bus"));
  if (exists(path.join(run, "systemd"))) a.push("--tmpfs", path.join(run, "systemd"));
  a.push("--unsetenv", "DBUS_SESSION_BUS_ADDRESS");
  if (exists(paths.secrets)) a.push("--tmpfs", real(paths.secrets)); // 最后挂：盖住前面任何把它带回来的绑定
  a.push("--die-with-parent");
  return a;
}

/** Landlock 的特殊路径：密钥目录与浏览器配置不授权（不可见），其余与 bwrap 一致（QUETZAL_HOME 只读、data/ 与灵魂工作区可写、启动文件只读）。 */
function landlockRules(): Map<string, Mode> {
  const m = new Map<string, Mode>();
  const home = real(paths.home);
  if (home !== real(os.homedir()) && home !== "/") m.set(home, "ro");
  else for (const d of [paths.config, paths.state, paths.tools, paths.vault]) if (exists(d)) m.set(real(d), "ro");
  for (const d of writable()) if (exists(d)) m.set(real(d), "rw");
  const git = path.join(paths.soul, ".git");
  if (exists(git)) m.set(real(git), "ro");
  for (const p of userReadonly()) m.set(real(p), "ro");
  for (const p of browserDirs()) m.set(real(p), "hide");
  const run = `/run/user/${process.getuid?.() ?? 0}`;
  for (const p of [path.join(run, "bus"), path.join(run, "systemd")]) if (exists(p)) m.set(p, "hide");
  if (exists(paths.secrets)) m.set(real(paths.secrets), "hide");
  return m;
}
/** 按特殊路径展开授权：含有特殊路径的目录不整体授权，逐项授权它的子项（递归）；其余整块按继承的模式授权。返回 landrun 的参数。 */
export function landlockGrants(rules: Map<string, Mode>, root = "/"): string[] {
  const out: string[] = [];
  const grant = (p: string, mode: Mode) => { if (mode !== "hide") out.push(mode === "rw" ? "--rwx" : "--rox", p); };
  const walk = (dir: string, mode: Mode) => {
    const inside = [...rules.keys()].some((k) => k.startsWith(dir === "/" ? "/" : dir + path.sep) && k !== dir);
    if (!inside) return grant(dir, mode);
    let names: string[] = [];
    try { names = fs.readdirSync(dir); } catch { return; }
    for (const n of names) {
      const child = path.join(dir, n);
      walk(child, rules.get(child) ?? mode);
    }
  };
  walk(root, rules.get(root) ?? "rw");
  return out;
}
function landrunArgs(env: NodeJS.ProcessEnv = process.env): string[] {
  // --best-effort：按内核实际支持的 Landlock ABI 降级（landrun 缺省要最新的 ABI）。内核完全不支持时它会不加限制地运行，
  // 所以探测时用密钥目录里的探针文件验证（见 probe），读得到就不用它
  const a = ["--best-effort", "--ignore-missing", "--unrestricted-network", "--log-level", "error", ...landlockGrants(landlockRules())]; // --ignore-missing：展开出的子项在启动前消失了（/run/user、/tmp 里的临时文件）就跳过
  for (const k of Object.keys(env)) if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && k !== "DBUS_SESSION_BUS_ADDRESS") a.push("--env", k); // landrun 缺省不传任何环境变量
  return a;
}

/** proot 遮住的目录：密钥、配置（含灵魂仓库地址与权限）、运行基座的版本目录、runit 服务与开机脚本（改了会在沙箱外执行），
 *  以及启动者用 QUETZAL_HIDE_PATHS（冒号分隔）指定的目录——App 内置的运行基座与控制台是同一个系统用户，App 自己的私有数据（存着网关令牌的设置等）要遮住。 */
function prootHidden(): string[] {
  const prefix = process.env.PREFIX ?? "";
  const extra = (process.env.QUETZAL_HIDE_PATHS ?? "").split(":").filter((p) => path.isAbsolute(p));
  return [paths.secrets, paths.config, path.join(paths.home, "releases"),
    ...(prefix ? [path.join(prefix, "var", "service", "quetzal")] : []), path.join(os.homedir(), ".termux", "boot"), ...extra].filter(exists);
}
function prootArgs(): string[] {
  const empty = emptyDir();
  return prootHidden().flatMap((d) => ["-b", `${empty}:${real(d)}`]);
}

function probe(): Probe {
  const force = process.env.QUETZAL_SANDBOX;
  if (force === "none") return { kind: "none", bin: "", pidns: false };
  if (isWindows) return srtState === "ready" ? { kind: "srt", bin: srtWinPath(), pidns: false } : { kind: "none", bin: "", pidns: false };
  // 能跑，并且密钥目录在里面确实看不到：放一个无害的探针文件，沙箱里读得到（或目录列得出东西）就说明没隔离住
  try { fs.mkdirSync(paths.secrets, { recursive: true, mode: 0o700 }); fs.writeFileSync(path.join(paths.secrets, CANARY), "quetzal-sandbox-canary\n", { mode: 0o600 }); } catch { /* 写不了就只靠列目录判断 */ }
  const q = (p: string) => `'${p.replace(/'/g, "'\\''")}'`;
  const secretsCheck = `cat ${q(path.join(real(paths.secrets), CANARY))} >/dev/null 2>&1 && exit 3; ls -A ${q(real(paths.secrets))} 2>/dev/null | grep -q . && exit 3; exit 0`;
  const ok = (bin: string, args: string[]) => { try { return spawnSync(bin, [...args, sh(), "-c", secretsCheck], { timeout: 10_000, stdio: "ignore" }).status === 0; } catch { return false; } };
  if (!isAndroid && force !== "proot") {
    for (const bwrap of [DEDICATED_BWRAP, which("bwrap")]) {
      if (!bwrap || !exists(bwrap) || force === "landlock") continue;
      if (ok(bwrap, [...bwrapArgs(true), "--"])) return { kind: "bwrap", bin: bwrap, pidns: true };
      if (ok(bwrap, [...bwrapArgs(false), "--"])) return { kind: "bwrap", bin: bwrap, pidns: false };
      log("sandbox", `${bwrap} 存在但无法建立沙箱（多半是系统限制了非特权用户命名空间）`);
    }
    const landrun = landrunPath();
    if (exists(landrun)) {
      if (ok(landrun, [...landrunArgs(), "--"])) return { kind: "landlock", bin: landrun, pidns: false };
      log("sandbox", "landrun 存在但 Landlock 不可用（内核 5.13 以下或没有启用 Landlock）");
    }
  }
  const proot = which("proot");
  if (proot && ok(proot, prootArgs())) return { kind: "proot", bin: proot, pidns: false };
  return { kind: "none", bin: "", pidns: false };
}

function current(): Probe {
  if (isWindows && srtState === "idle") void prepareSandbox(); // 第一次用到时在后台准备；准备好之前按「没有沙箱」处理
  if (!probed || (isWindows && probed.kind === "none" && srtState === "ready")) {
    probed = probe();
    if (probed.kind === "none" && !warned && !(isWindows && srtState === "preparing")) {
      warned = true;
      const text = allowUnsandboxed() ? "没有可用的沙箱，而且部署者允许了不隔离运行：她的命令能读到基座的密钥目录。重新运行安装命令补上沙箱后重启基座即可"
        : `没有可用的沙箱（${isWindows ? `Windows：${srtError || "沙箱用户或网络规则没装好"}` : "Linux 需要 bubblewrap 或 Landlock，Termux 需要 proot"}）：她的命令一律不执行。重新运行安装补上沙箱后重启基座即可`;
      log("sandbox", text);
      try { addTimeline("sandbox", allowUnsandboxed() ? "命令没有隔离：缺少沙箱程序" : "命令不执行：缺少沙箱程序", { text }); } catch { /* 存储还没打开（测试） */ }
    } else if (probed.kind !== "none") log("sandbox", `agent 的命令在 ${probed.kind}${probed.pidns ? "（独立 pid 命名空间）" : ""} 里运行，密钥目录不可见`);
  }
  return probed;
}

/** 测试用：重新探测。 */
export function resetSandbox() { probed = undefined; warned = false; if (srtState !== "ready") { srtState = "idle"; srtPreparing = undefined; } }

/** agent 的命令默认在哪个目录里运行：用户主目录（QUETZAL_HOME 在沙箱里大多只读，运行基座的版本目录也不该被改）。
 *  Windows：沙箱用户碰不到本用户的主目录，她的工作区是 %USERPROFILE%\Quetzal（对方也看得到、能放文件进去）。 */
export const workDir = () => isWindows ? workspace() : os.homedir();
const workspace = () => process.env.QUETZAL_WORKSPACE || path.join(os.homedir(), "Quetzal");

// ---------- Windows：sandbox-runtime（srt-win）
//   库打包成单独的 ESM 文件 srt.mjs（它要用 import.meta.url），放在 main.cjs 旁边，只在 Windows 上加载；srt-win.exe 在 srt-win\ 下。
//   开发与测试时没有打包文件，直接加载 npm 包。
type SrtManager = { initialize(cfg: unknown, ask?: (p: { host: string; port?: number }) => Promise<boolean>): Promise<void>; wrapWithSandboxArgv(command: string, binShell: unknown, customConfig?: unknown, abort?: AbortSignal, cwd?: string): Promise<{ argv: string[]; env: NodeJS.ProcessEnv }>; reset(): Promise<void> };
let srtState: "idle" | "preparing" | "ready" | "failed" = "idle";
let srtError = "";
let srtPreparing: Promise<void> | undefined;
let srtMgr: SrtManager | undefined;
const mainDir = () => path.dirname(process.argv[1] ?? process.execPath);
let srtModule: any;
/** srt-win.exe：环境变量指定的 > 安装时复制到 Program Files\Quetzal 的（沙箱用户读得到；用户目录里的它读不到，两跳启动的第二跳会被拒）
 *  > main.cjs 旁边 srt-win\ 里的 > 开发与测试时 npm 包自带的。 */
const srtWinPath = () => {
  if (process.env.QUETZAL_SRT_WIN) return process.env.QUETZAL_SRT_WIN;
  const machine = path.join(process.env.ProgramFiles || "C:\\Program Files", "Quetzal", "srt-win.exe");
  if (fs.existsSync(machine)) return machine;
  const bundled = path.join(mainDir(), "srt-win", "srt-win.exe");
  return fs.existsSync(bundled) || !srtModule?.VENDORED_SRT_WIN_EXE ? bundled : srtModule.VENDORED_SRT_WIN_EXE;
};

async function loadSrt(): Promise<SrtManager> {
  const bundled = process.env.QUETZAL_SRT_MODULE || path.join(mainDir(), "srt.mjs");
  const m: any = fs.existsSync(bundled) ? await import(pathToFileURL(bundled).href) : await import("@anthropic-ai/sandbox-runtime");
  srtModule = m;
  return m.SandboxManager as SrtManager;
}

/** PowerShell：有 pwsh 7 用它，否则系统自带的 Windows PowerShell 5.1。 */
export function powershellPath(): string {
  const pf = process.env.ProgramFiles || "C:\\Program Files";
  const seven = path.join(pf, "PowerShell", "7", "pwsh.exe");
  if (fs.existsSync(seven)) return seven;
  const onPath = whichCmd("pwsh");
  if (onPath && !/\\WindowsApps\\/i.test(onPath)) return onPath; // Store 版的别名在沙箱用户那里用不了
  return path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}
/** PowerShell 的参数与 UTF-8 前导（中文 Windows 的控制台缺省是代码页 936，不设会乱码；做法同 MiMo Code）。 */
export const PS_FLAGS = ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"];
export const PS_PREAMBLE = "$ProgressPreference='SilentlyContinue';[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false);$OutputEncoding=[Console]::OutputEncoding;";
/** PowerShell 单引号字符串。 */
export const psq = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** 这个地址是不是这台机器自己（回环、未指定、链路本地、元数据地址、本机网卡上的地址）：沙箱里的命令不能借代理连回来（本机网关就在这里）。 */
export function selfAddress(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  const v = net.isIP(h);
  if (!v) return false;
  const mapped = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  const ip = mapped ? mapped[1] : h;
  if (net.isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 127 || a === 0 || (a === 169 && b === 254) || ["100.100.100.200", "168.63.129.16", "192.0.0.192"].includes(ip)) return true;
  } else if (ip === "::1" || ip === "::" || /^fe[89ab]/.test(ip) || /^::ffff:/.test(ip)) return true;
  for (const list of Object.values(os.networkInterfaces())) for (const a of list ?? []) if (a.address.toLowerCase() === ip) return true;
  return false;
}

/** 沙箱用户能读 / 能写的路径（会话级授权，见 sandbox-runtime 的 Windows 文件访问集合）。 */
export function srtFilesystem() {
  const nodeDir = path.dirname(process.execPath);
  const share = (config.sandbox?.share ?? []).filter((p) => typeof p === "string" && path.isAbsolute(p));
  for (const d of [workspace(), paths.data, paths.soul, paths.tools, paths.vault]) { try { fs.mkdirSync(d, { recursive: true }); } catch { /* 下面授权时缺的会被跳过 */ } }
  return {
    denyRead: [paths.secrets, paths.config, path.join(paths.home, "state")],
    allowRead: [paths.vault, paths.tools, nodeDir, mainDir()],
    allowWrite: [workspace(), paths.data, paths.soul, ...share],
    denyWrite: [path.join(paths.soul, ".git")],
  };
}

/** Windows：初始化 sandbox-runtime 并验证（探针：沙箱里读不到 secrets\ 里的探针文件）。只做一次；失败就 fail-closed，原因记在 srtError。 */
export function prepareSandbox(): Promise<void> {
  if (!isWindows || process.env.QUETZAL_SANDBOX === "none") return Promise.resolve();
  if (srtPreparing) return srtPreparing;
  srtState = "preparing";
  srtPreparing = (async () => {
    try {
      srtMgr = await loadSrt();
      const exe = srtWinPath();
      if (!fs.existsSync(exe)) throw new Error(`缺少 ${exe}（重新运行安装）`);
      await srtMgr.initialize({
        network: { allowedDomains: [], deniedDomains: [] },
        filesystem: srtFilesystem(),
        windows: { srtWin: { path: exe } },
      }, async ({ host }) => !selfAddress(host)); // 没列在名单里的地址都来问：公网与局域网放行，这台机器自己不行
      fs.mkdirSync(paths.secrets, { recursive: true });
      fs.writeFileSync(path.join(paths.secrets, CANARY), "quetzal-sandbox-canary\n");
      const check = `if (Test-Path -LiteralPath ${psq(path.join(paths.secrets, CANARY))}) { exit 3 }; try { Get-ChildItem -LiteralPath ${psq(paths.secrets)} -ErrorAction Stop | Out-Null; exit 3 } catch { exit 0 }`;
      const code = await runWrapped(await srtWrap(check, workspace()), 60_000);
      if (code !== 0) throw new Error(`沙箱里读得到密钥目录（探针退出码 ${code}），不用它`);
      srtState = "ready";
      process.once("exit", () => { void srtMgr?.reset().catch(() => {}); });
      log("sandbox", "agent 的命令在 Windows 沙箱用户 srt-sandbox 里运行，密钥目录不可见，网络经代理且连不到本机");
    } catch (e) {
      srtState = "failed";
      srtError = (e as Error).message.split("\n")[0].slice(0, 300);
      // 开机任务（S4U，没人登录）里 Windows 不允许以沙箱用户启动进程：有人登录后登录任务会接管运行基座，沙箱随之可用
      if (/CreateProcessWithLogonW/.test(srtError) && !process.env.SESSIONNAME) srtError = "这台电脑还没有人登录：开机后在后台运行时，Windows 不允许以沙箱用户启动命令，有人登录桌面后自动恢复";
      log("sandbox", `Windows 沙箱不可用：${srtError}`);
    }
    probed = undefined; warned = false;
  })();
  return srtPreparing;
}

async function srtWrap(script: string, cwd: string): Promise<{ cmd: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }> {
  const r = await srtMgr!.wrapWithSandboxArgv(PS_PREAMBLE + script, { exe: powershellPath(), args: PS_FLAGS }, undefined, undefined, cwd);
  return { cmd: r.argv[0], args: r.argv.slice(1), cwd, env: r.env };
}

function runWrapped(w: { cmd: string; args: string[]; cwd: string; env?: NodeJS.ProcessEnv }, timeoutMs: number): Promise<number> {
  return new Promise((resolve) => {
    const p = spawn(w.cmd, w.args, { cwd: w.cwd, env: w.env, stdio: "ignore", windowsHide: true });
    const t = setTimeout(() => { try { p.kill(); } catch { /* 已退出 */ } resolve(124); }, timeoutMs);
    p.on("error", () => { clearTimeout(t); resolve(127); });
    p.on("exit", (code) => { clearTimeout(t); resolve(code ?? 1); });
  });
}

/** agent 的一条 shell 脚本包进沙箱：POSIX 用 $SHELL -c；Windows 用 PowerShell（UTF-8 前导）。env 为额外的环境变量（Windows 的沙箱用户拿到的是全新的环境，额外的变量写进脚本前面）。 */
export async function wrapScript(script: string, cwd = workDir(), env: Record<string, string> = {}): Promise<{ cmd: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }> {
  if (isWindows) {
    if (srtState === "idle" || srtState === "preparing") await prepareSandbox();
    try { fs.mkdirSync(cwd, { recursive: true }); } catch { /* 下面启动时报错 */ }
    const assign = Object.entries({ QUETZAL_HOME: paths.home, ...env }).map(([k, v]) => `$env:${k}=${psq(v)};`).join(""); // 沙箱用户拿到的是全新的环境：把家目录的位置带进去
    if (current().kind === "srt") return srtWrap(assign + script, cwd);
    if (!allowUnsandboxed()) throw new SandboxUnavailable();
    return { cmd: powershellPath(), args: [...PS_FLAGS, PS_PREAMBLE + assign + script], cwd, env: { ...process.env, ...env } };
  }
  const w = wrap(sh(), ["-c", script], cwd, { ...process.env, ...env });
  return { ...w, env: { ...process.env, ...env } };
}

/** 一个程序与参数包进沙箱。Windows 上写成 PowerShell 的调用（& 程序 参数…，退出码照传）。 */
export async function wrapArgv(cmd: string, args: string[], cwd = workDir(), env: Record<string, string> = {}): Promise<{ cmd: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }> {
  if (isWindows) return wrapScript(`& ${[cmd, ...args].map(psq).join(" ")}; exit $LASTEXITCODE`, cwd, env);
  const w = wrap(cmd, args, cwd, { ...process.env, ...env });
  return { ...w, env: { ...process.env, ...env } };
}

/** 把一条命令包进沙箱。返回实际要执行的程序与参数。env 为将要传给子进程的环境（Landlock 的启动器缺省不传环境变量，要逐个列出）。
 *  没有可用沙箱且没有允许不隔离运行时抛出 SandboxUnavailable。 */
export function wrap(cmd: string, args: string[], cwd = workDir(), env: NodeJS.ProcessEnv = process.env): { cmd: string; args: string[]; cwd: string } {
  if (isWindows) throw new Error("Windows 上用 wrapScript / wrapArgv（异步）");
  const p = current();
  if (p.kind === "bwrap") return { cmd: p.bin, args: [...bwrapArgs(p.pidns), "--chdir", cwd, "--", cmd, ...args], cwd };
  if (p.kind === "landlock") return { cmd: p.bin, args: [...landrunArgs(env), "--", cmd, ...args], cwd };
  if (p.kind === "proot") return { cmd: p.bin, args: [...prootArgs(), "-w", cwd, cmd, ...args], cwd };
  if (!allowUnsandboxed()) throw new SandboxUnavailable();
  return { cmd, args, cwd };
}

/** 网关 status 的 sandbox 字段：kind 与看不见 / 只读的目录（控制台据此提示）。 */
export function sandboxStatus(): SandboxStatus {
  const p = current(), allow = allowUnsandboxed();
  if (p.kind === "bwrap") return { kind: "bwrap", hidden: [paths.secrets, ...browserDirs()], readonly: [paths.home, ...userReadonly()], note: p.pidns ? "" : "没有独立的 pid 命名空间", allowUnsandboxed: allow };
  if (p.kind === "landlock") return { kind: "landlock", hidden: [paths.secrets, ...browserDirs()], readonly: [paths.home, ...userReadonly()], note: "Landlock：/、/home、主目录、QUETZAL_HOME 等被展开的目录本身不能列出、不能直接在里面新建文件", allowUnsandboxed: allow };
  if (p.kind === "proot") return { kind: "proot", hidden: prootHidden(), readonly: [], note: "proot 是尽力而为的隔离", allowUnsandboxed: allow };
  if (p.kind === "srt") { const f = srtFilesystem(); return { kind: "srt", hidden: f.denyRead, readonly: [...f.allowRead, ...f.denyWrite], note: `她的命令以沙箱用户 srt-sandbox 运行，只能写 ${f.allowWrite.join("、")}；网络经代理，连不到这台机器自己`, allowUnsandboxed: allow }; }
  if (isWindows && srtState === "preparing") return { kind: "none", hidden: [], readonly: [], note: "正在准备 Windows 沙箱", allowUnsandboxed: allow };
  return { kind: "none", hidden: [], readonly: [], note: allow ? "没有沙箱，已允许不隔离运行：她的命令能读到密钥目录" : `没有沙箱：她的命令一律不执行（${isWindows && srtError ? srtError + "；" : ""}重新运行安装补上沙箱，或在控制台明确允许不隔离运行）`, allowUnsandboxed: allow };
}

/**
 * 读文件的工具（read_document、view_image）不经过沙箱，由这里把关：解析真实路径（跟随符号链接）后落在密钥目录或保密库里就拒绝。
 * 比较的是真实路径，不是字符串：符号链接、..、（Windows 上）大小写与 8.3 短名的写法都绕不过去。返回拒绝的说明，可以读时为 undefined。
 */
export function protectedPath(p: string): string | undefined {
  const raw = p.replace(/^file:\/\//, "");
  if (isWindows) {
    // Windows：不收 UNC 与设备路径（\\localhost\C$\…、\\?\C:\… 绕得开盘符比较）和备用数据流（文件名:流名）
    if (/^[\\/]{2}/.test(raw)) return "没有读取：只能读本机盘符下的路径（C:\\…），不收网络路径与设备路径。";
    if (raw.replace(/^[a-zA-Z]:/, "").includes(":")) return "没有读取：路径里不能有冒号（备用数据流）。";
  }
  // 不存在的路径也要判断（按最近的已存在的上级目录取真实路径，再接上余下部分）：否则「没有这个文件」会透露保密库里有没有某个名字
  let f = path.resolve(workDir(), raw), rest = "";
  for (;;) {
    try { f = path.join(realNative(f), rest); break; }
    catch { const parent = path.dirname(f); if (parent === f) return undefined; rest = path.join(path.basename(f), rest); f = parent; }
  }
  // Windows 的文件系统不分大小写、8.3 短名（QUETZA~1）也指向同一个目录：两边都取系统给的真实路径（native 会展开短名并给出磁盘上的大小写），再不分大小写比较
  const fold = (x: string) => isWindows ? x.toLowerCase() : x;
  const inside = (dir: string) => { let d = dir; try { d = realNative(dir); } catch { d = path.resolve(dir); } d = fold(d); const g = fold(f); return g === d || g.startsWith(d + path.sep); };
  if (inside(paths.secrets)) return "没有读取：这是基座的密钥目录，不能读取。";
  if (inside(paths.vault)) return "没有读取：这是保密库，里面的值只能在命令里按路径引用（\"$(cat 路径)\"），不能读出来看。";
  if (isWindows && inside(paths.config)) return "没有读取：这是基座的配置目录。";
  return undefined;
}
const realNative = (p: string) => isWindows ? fs.realpathSync.native(p) : fs.realpathSync(p);
