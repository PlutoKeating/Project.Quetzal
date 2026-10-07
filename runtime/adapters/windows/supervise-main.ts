// Windows 的守护进程（构建为 windows-supervise.mjs）：计划任务 \Quetzal\Runtime-Boot（开机、S4U，不登录也跑）与 \Quetzal\Runtime-Logon（登录时）
// 都执行它；同一时间只留一个（state\supervise.lock 里的 pid）。它拉起运行基座、退出后退避重启，与 Linux 的守护循环同义：
//   - 每次拉起都重新读 %LOCALAPPDATA%\Quetzal\runtime\current.txt：升级只换指针，守护进程不用跟着换；
//   - state\supervise.off 存在时暂停拉起（控制台「守护」开关）；state\quit 存在时，运行基座退出后连同自己一起退出（托盘的「退出」）；
//   - 输出写 home\logs\runtime.log，超过 5 MB 轮转（留 3 份）；10 分钟内反复退出就把等待拉长到 1 分钟（熔断由运行基座自己做）；
//   - 交接：开机任务的 S4U 会话里，Windows 不允许以沙箱用户启动进程（CreateProcessWithLogonW 被拒），她的命令只能 fail-closed。
//     所以有人登录后，登录任务启动的守护进程（交互会话，有 SESSIONNAME）写 state\takeover 请开机任务那份让位：后者停掉运行基座、放开锁退出，
//     前者接过来在用户的桌面会话里重新拉起（命令沙箱可用）。注销后交互会话里的进程被结束，开机任务每 5 分钟重试一次，又在后台接上。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";

const ROOT = path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "Quetzal");
const HOME = process.env.QUETZAL_HOME ?? path.join(ROOT, "home");
const STATE = path.join(HOME, "state"), LOGS = path.join(HOME, "logs");
const LOCK = path.join(STATE, "supervise.lock"), OFF = path.join(STATE, "supervise.off"), QUIT = path.join(STATE, "quit"), TAKEOVER = path.join(STATE, "takeover");
const interactive = Boolean(process.env.SESSIONNAME); // 登录任务（交互会话）有 SESSIONNAME；开机任务（S4U，会话 0）没有
const LOG = path.join(LOGS, "runtime.log"), MAX_LOG = 5 << 20, KEEP = 3;
fs.mkdirSync(STATE, { recursive: true }); fs.mkdirSync(LOGS, { recursive: true });

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; } };

// ---------- 单实例：锁文件里的 pid 还活着就退出（开机任务与登录任务都会执行它）；交互会话里的会请后台那份让位（见文件头）
const owner = () => { try { const p = Number(fs.readFileSync(LOCK, "utf8").trim()); return p && p !== process.pid && alive(p) ? p : 0; } catch { return 0; } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
if (owner()) {
  if (!interactive) process.exit(0);
  fs.writeFileSync(TAKEOVER, String(process.pid));
  for (let i = 0; i < 60 && owner(); i++) await sleep(1000);
  if (owner()) process.exit(0); // 对方没让位（比如它本身也在交互会话里）：留着它
}
fs.writeFileSync(LOCK, String(process.pid));
if (interactive) fs.rmSync(TAKEOVER, { force: true });

// ---------- 日志：追加写，超过上限轮转
let out = fs.createWriteStream(LOG, { flags: "a" });
let written = (() => { try { return fs.statSync(LOG).size; } catch { return 0; } })();
function write(b: Buffer | string) {
  out.write(b); written += Buffer.byteLength(b);
  if (written < MAX_LOG) return;
  out.end();
  for (let i = KEEP - 1; i >= 1; i--) { try { fs.renameSync(`${LOG}.${i}`, `${LOG}.${i + 1}`); } catch { /* 没有这一份 */ } }
  try { fs.renameSync(LOG, `${LOG}.1`); } catch { /* 被占用：下次再轮转 */ }
  out = fs.createWriteStream(LOG, { flags: "a" }); written = 0;
}
const note = (s: string) => write(`[supervise ${new Date().toISOString()}] ${s}\n`);

function current(): { dir: string; version: string } | undefined {
  try {
    const version = fs.readFileSync(path.join(ROOT, "runtime", "current.txt"), "utf8").trim();
    const dir = path.join(ROOT, "runtime", version);
    return /^[\w.+-]+$/.test(version) && fs.existsSync(path.join(dir, "main.cjs")) ? { dir, version } : undefined;
  } catch { return undefined; }
}

let child: ChildProcess | undefined;
let stopping = false;
const starts: number[] = [];

function launch() {
  if (stopping) return;
  if (fs.existsSync(OFF)) { setTimeout(launch, 10_000); return; } // 守护已关：不拉起，过一会儿再看开关
  const c = current();
  if (!c) { note("找不到当前版本（runtime\\current.txt），1 分钟后再看"); setTimeout(launch, 60_000); return; }
  const env = { ...process.env, QUETZAL_HOME: HOME, QUETZAL_ADAPTER: path.join(c.dir, "windows.mjs") };
  note(`拉起运行基座 ${c.version}`);
  starts.push(Date.now());
  const p = spawn(process.execPath, ["--enable-source-maps", path.join(c.dir, "main.cjs")], { cwd: c.dir, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  child = p;
  p.stdout!.on("data", write); p.stderr!.on("data", write);
  p.on("error", (e) => note(`起不来：${e.message}`));
  p.on("exit", (code, sig) => {
    child = undefined;
    note(`运行基座退出（${code ?? sig}）`);
    if (fs.existsSync(QUIT)) { fs.rmSync(QUIT, { force: true }); note("收到退出：守护进程也退出"); return finish(); }
    const recent = starts.filter((t) => Date.now() - t < 600_000).length;
    setTimeout(launch, recent > 5 ? 60_000 : 3_000);
  });
}

function finish() {
  stopping = true;
  try { if (Number(fs.readFileSync(LOCK, "utf8").trim()) === process.pid) fs.rmSync(LOCK, { force: true }); } catch { /* 已经没有 */ }
  out.end(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
function stop() {
  stopping = true;
  if (child?.pid) spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  finish();
}
process.on("SIGINT", stop); process.on("SIGTERM", stop); process.on("SIGBREAK", stop);

// 后台（开机任务）那份：有人登录后交互会话里的守护进程请求接管，就停下运行基座、放开锁退出
if (!interactive) setInterval(() => {
  try { const who = Number(fs.readFileSync(TAKEOVER, "utf8").trim()); if (who && who !== process.pid && alive(who)) { note(`有人登录了：交给登录会话里的守护进程 ${who}（那里命令沙箱可用）`); stop(); } } catch { /* 没有请求 */ }
}, 2000).unref();

if (fs.existsSync(QUIT)) fs.rmSync(QUIT, { force: true }); // 上次的退出标志不影响这一次开机
note(`守护进程 ${process.pid} 启动（${process.env.SESSIONNAME ? "登录会话" : "开机任务"}）`);
launch();
