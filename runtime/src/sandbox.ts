// 沙箱：agent 能运行的一切命令（shell 工具、后台任务、自造工具 sh 与 node）都经这里包一层，让基座的密钥目录（QUETZAL_HOME/secrets）在里面不存在。
//   agent 与基座是同一个系统用户，工具层的拦截（tools.ts 的 soulGitBlock / secretsBlock）只是提示，换个写法就绕过去；边界在这里。
//   - Linux：有 bubblewrap（bwrap）就用它。整个文件系统按主机原样挂进来（网络照常），然后：
//       secrets/ 换成空的 tmpfs；QUETZAL_HOME 其余部分只读（data/ 与灵魂目录的工作区可写，灵魂目录的 .git 只读）；
//       用户的 shell 启动文件、systemd 用户单元、自启动项、~/.ssh 只读，浏览器配置目录（里面有网页控制台的令牌与各网站的 Cookie）换成空的；
//       会话 D-Bus 与 systemd 用户实例的套接字不可用（否则 systemd-run 能在沙箱外起进程）；新的 pid 命名空间（看不到也碰不到沙箱外的进程，
//       /proc/<pid>/root 走不出去），基座退出时沙箱里的一切随之结束。
//   - Termux（安卓）：有 proot 就用它，把 secrets/、config/、releases/、runit 服务目录与开机脚本目录绑定成空目录（proot 不能只读绑定）。
//       proot 基于 ptrace，是尽力而为：它挡得住普通的读文件，挡不住经 Android 的 intent（RUN_COMMAND）让 Termux 在沙箱外执行命令。
//   - 都没有：不隔离照常执行，status.sandbox.kind 为 "none"，时间线与日志各提醒一次；安装器负责装上 bubblewrap / proot。
//   保密库（vault/）在沙箱里仍然可读：pass_secret 的用法就是在命令里引用 "$(cat vault/名字)"。
//   环境变量 QUETZAL_SANDBOX=none 强制不用沙箱（只给部署者排查问题用）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { paths, isTermux } from "./config.ts";
import { log } from "./log.ts";
import { addTimeline } from "./store.ts";

export type SandboxKind = "bwrap" | "proot" | "none";
export interface SandboxStatus { kind: SandboxKind; hidden: string[]; readonly: string[]; note: string }

interface Probe { kind: SandboxKind; bin: string; pidns: boolean }
let probed: Probe | undefined;
let warned = false;

const real = (p: string) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const exists = (p: string) => { try { fs.lstatSync(p); return true; } catch { return false; } };

function which(cmd: string): string | undefined {
  for (const d of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!d) continue;
    const f = path.join(d, cmd);
    try { fs.accessSync(f, fs.constants.X_OK); return f; } catch { /* 下一个 */ }
  }
  return undefined;
}

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

/** proot 遮住的目录：密钥、配置（含灵魂仓库地址与权限）、运行基座的版本目录、runit 服务与开机脚本（改了会在沙箱外执行）。 */
function prootHidden(): string[] {
  const prefix = process.env.PREFIX ?? "";
  return [paths.secrets, paths.config, path.join(paths.home, "releases"),
    ...(prefix ? [path.join(prefix, "var", "service", "quetzal")] : []), path.join(os.homedir(), ".termux", "boot")].filter(exists);
}
function prootArgs(): string[] {
  const empty = emptyDir();
  return prootHidden().flatMap((d) => ["-b", `${empty}:${real(d)}`]);
}

function probe(): Probe {
  const force = process.env.QUETZAL_SANDBOX;
  if (force === "none") return { kind: "none", bin: "", pidns: false };
  const ok = (bin: string, args: string[]) => { try { return spawnSync(bin, [...args, sh(), "-c", "true"], { timeout: 10_000, stdio: "ignore" }).status === 0; } catch { return false; } };
  const bwrap = isTermux ? undefined : which("bwrap");
  if (bwrap && force !== "proot") {
    if (ok(bwrap, [...bwrapArgs(true), "--"])) return { kind: "bwrap", bin: bwrap, pidns: true };
    if (ok(bwrap, [...bwrapArgs(false), "--"])) return { kind: "bwrap", bin: bwrap, pidns: false };
    log("sandbox", "bwrap 存在但无法运行（可能是系统禁止了非特权用户命名空间），改试 proot");
  }
  const proot = which("proot");
  if (proot && ok(proot, prootArgs())) return { kind: "proot", bin: proot, pidns: false };
  return { kind: "none", bin: "", pidns: false };
}

function current(): Probe {
  if (!probed) {
    probed = probe();
    if (probed.kind === "none" && !warned) {
      warned = true;
      const text = "没有可用的沙箱（Linux 需要 bubblewrap，Termux 需要 proot）：agent 的命令能读到基座的密钥目录。重新运行安装脚本或手动安装后重启基座即可";
      log("sandbox", text);
      try { addTimeline("sandbox", "命令没有隔离：缺少沙箱程序", { text }); } catch { /* 存储还没打开（测试） */ }
    } else if (probed.kind !== "none") log("sandbox", `agent 的命令在 ${probed.kind}${probed.pidns ? "（独立 pid 命名空间）" : ""} 里运行，密钥目录不可见`);
  }
  return probed;
}

/** 测试用：重新探测。 */
export function resetSandbox() { probed = undefined; warned = false; }

/** agent 的命令默认在哪个目录里运行：用户主目录（QUETZAL_HOME 在沙箱里大多只读，运行基座的版本目录也不该被改）。 */
export const workDir = () => os.homedir();

/** 把一条命令包进沙箱。返回实际要执行的程序与参数。 */
export function wrap(cmd: string, args: string[], cwd = workDir()): { cmd: string; args: string[]; cwd: string } {
  const p = current();
  if (p.kind === "bwrap") return { cmd: p.bin, args: [...bwrapArgs(p.pidns), "--chdir", cwd, "--", cmd, ...args], cwd };
  if (p.kind === "proot") return { cmd: p.bin, args: [...prootArgs(), "-w", cwd, cmd, ...args], cwd };
  return { cmd, args, cwd };
}

/** 网关 status 的 sandbox 字段：kind 与看不见 / 只读的目录（控制台据此提示）。 */
export function sandboxStatus(): SandboxStatus {
  const p = current();
  if (p.kind === "bwrap") return { kind: "bwrap", hidden: [paths.secrets, ...browserDirs()], readonly: [paths.home, ...userReadonly()], note: p.pidns ? "" : "没有独立的 pid 命名空间" };
  if (p.kind === "proot") return { kind: "proot", hidden: prootHidden(), readonly: [], note: "proot 是尽力而为的隔离" };
  return { kind: "none", hidden: [], readonly: [], note: "缺少 bubblewrap（Linux）或 proot（Termux）：agent 的命令能读到密钥目录" };
}

/**
 * 读文件的工具（read_document、view_image）不经过沙箱，由这里把关：解析真实路径（跟随符号链接）后落在密钥目录或保密库里就拒绝。
 * 比较的是真实路径，不是字符串：符号链接、..、大小写以外的写法都绕不过去。返回拒绝的说明，可以读时为 undefined。
 */
export function protectedPath(p: string): string | undefined {
  let f: string;
  try { f = fs.realpathSync(path.resolve(workDir(), p.replace(/^file:\/\//, ""))); } catch { return undefined; } // 不存在：交给工具自己报「没有这个文件」
  const inside = (dir: string) => { const d = real(dir); return f === d || f.startsWith(d + path.sep); };
  if (inside(paths.secrets)) return "没有读取：这是基座的密钥目录，不能读取。";
  if (inside(paths.vault)) return "没有读取：这是保密库，里面的值只能在命令里按路径引用（\"$(cat 路径)\"），不能读出来看。";
  return undefined;
}
