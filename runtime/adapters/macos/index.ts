// Quetzal 身体适配器：任意 Mac（macOS 12 起，Intel 与 Apple 芯片）。
// 由 npm 包 `@plutokeating/quetzal`（cli/）随运行基座一起安装；只依赖 body/adapter.ts 的类型定义（构建时擦除）。
// 一切靠探测：电量与充电读 pmset，电池温度与容量读 ioreg（AppleSmartBattery），设备标识读 ioreg 的 IOPlatformUUID；
// 通知（osascript）、截图（screencapture）、剪贴板（pbcopy / pbpaste）、打开（open）、播放（afplay）用系统自带的程序；
// 拍照与录音按可用程序探测（imagesnap 或 ffmpeg 的 avfoundation；录音 ffmpeg 或 SoX），没有就报错说明，不崩溃。
// hands（看屏幕、读无障碍树、点击、输入、窗口；截图也在这里，核心统一提供 screen_* 工具）见 hands.ts：有图形登录会话时才提供。网络变化用 scutil 监听系统配置的变化键。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import type { BodyAdapter, AdapterTool, RawSample } from "../../src/body/adapter.ts";
import {
  run, start, have, UTF8_ENV, parsePmsetBatt, batteryTempC, batteryCapacityPercent, platformUUID, cpuSpeedLimit, cameraCount,
  photoCommand, recordCommand, playerCommand, NOTIFY_JXA, openArgs, SCUTIL_WATCH, scutilChanged,
} from "./mac.ts";
import { createHands, permissionHelp } from "./hands.ts";
import * as supervise from "./supervise.ts";
import { upgrade, upgradeStatus } from "./upgrade.ts";

const MEDIA = path.join(process.env.QUETZAL_HOME ?? path.join(os.homedir(), ".quetzal"), "data", "media"); // macOS 的家目录缺省 ~/.quetzal（与 Linux 相同，服务里总是由 QUETZAL_HOME 指定）

let version = "";
let laptop = false; // 有内置电池
let cameras = 0;
let gui = true; // 在图形登录会话里（launchd 的 Aqua 会话）；ssh 进来、没人登录时为 false
let playing: ChildProcess | undefined;

const obj = (props: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties: props, required });
const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");
const media = (name: string) => { fs.mkdirSync(MEDIA, { recursive: true }); return path.join(MEDIA, name); };
const sizeKB = (f: string) => Math.round(fs.statSync(f).size / 1024);
/** 做不成：抛出错误，核心把这次调用标为失败（只返回一句说明会被当成成功）。 */
const fail = (msg: string): never => { throw new Error(msg); };
const noGui = () => fail("这台 Mac 现在没有人登录图形界面（只有 ssh 会话），没有屏幕、通知与剪贴板可用");

export const hands = createHands({ mediaFile: media, gui: () => gui });

const tools: AdapterTool[] = [
  {
    name: "take_photo", permission: "camera", description: "用这台 Mac 的摄像头拍一张照片，返回文件路径。",
    parameters: obj({}),
    handler: async () => {
      if (!gui) return noGui();
      const f = media(`photo-${stamp()}.jpg`);
      const c = photoCommand(f);
      if (!c) return fail("拍照需要 imagesnap 或 ffmpeg（brew install imagesnap）");
      const r = await run(c[0], c[1], 30_000);
      return r.code === 0 && fs.existsSync(f) ? `已拍摄：${f}（${sizeKB(f)} KB）` : fail(`拍照失败（${(r.err || r.out).trim().slice(0, 160) || "没有摄像头或被占用"}；第一次使用要在 系统设置 › 隐私与安全性 › 相机 里允许 ${process.execPath}）`);
    },
  },
  {
    name: "record_audio", permission: "microphone", description: "用麦克风录一段声音（秒），返回 WAV 文件路径。",
    parameters: obj({ seconds: { type: "number" } }, ["seconds"]),
    handler: async (a) => {
      const s = Math.max(1, Math.min(120, Number(a.seconds) || 5));
      const f = media(`audio-${stamp()}.wav`);
      const c = recordCommand(f, s);
      if (!c) return fail("录音需要 ffmpeg 或 SoX（brew install ffmpeg）");
      const r = await run(c.cmd, c.args, (s + 15) * 1000);
      return r.code === 0 && fs.existsSync(f) && fs.statSync(f).size > 44 ? `已录制 ${s} 秒：${f}` : fail(`录音失败（没有麦克风，或没有授权：系统设置 › 隐私与安全性 › 麦克风 里允许 ${process.execPath}）`);
    },
  },
  {
    name: "clipboard", permission: "device", description: "读取（不给 text）或写入这台 Mac 的剪贴板。",
    parameters: obj({ text: { type: "string" } }),
    handler: async (a) => {
      if (a.text != null) return (await run("pbcopy", [], 10_000, String(a.text), UTF8_ENV)).code === 0 ? "已写入剪贴板" : fail("写入失败");
      const r = await run("pbpaste", [], 10_000, undefined, UTF8_ENV);
      return r.code === 0 && r.out ? r.out : "（剪贴板为空）";
    },
  },
  {
    name: "open", permission: "device", description: "用这台 Mac 的默认程序打开一个网址或本地文件（会在桌面上弹出窗口）。",
    parameters: obj({ target: { type: "string" } }, ["target"]),
    handler: async (a) => {
      if (!gui) return noGui();
      const r = await run("open", openArgs(String(a.target)), 15_000);
      return r.code === 0 ? `已打开：${a.target}` : fail(`打开失败：${(r.err || r.out).trim().slice(0, 200)}`);
    },
  },
];

/** 设备标识：IOPlatformUUID（硬件 UUID）。只用来派生身体 uuid，不写进日志与工具结果。 */
export async function machineId(exec = run): Promise<string | undefined> {
  return platformUUID((await exec("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], 10_000)).out);
}

/** 网络变化：scutil 监听主网络与各网卡地址的变化键，去抖 1 秒后通知；scutil 意外退出就隔 30 秒重开。 */
function watchNetwork(cb: (detail: string) => void): () => void {
  let child: ChildProcess | undefined, timer: NodeJS.Timeout | undefined, restart: NodeJS.Timeout | undefined, stopped = false;
  const open = () => {
    if (stopped || !have("scutil")) return;
    const p = spawn("scutil", [], { stdio: ["pipe", "pipe", "ignore"] });
    child = p;
    p.stdin.on("error", () => {});
    p.stdin.write(SCUTIL_WATCH);
    p.stdout.on("data", (d: Buffer) => {
      if (!scutilChanged(String(d))) return; // 只认变化通知（「notification callback」「changed key」），其余输出是 scutil 的提示
      clearTimeout(timer);
      timer = setTimeout(() => cb("网络变了（系统配置的网络状态有变化）"), 1000);
    });
    p.once("exit", () => { if (child === p) child = undefined; if (!stopped) restart = setTimeout(open, 30_000); });
  };
  open();
  return () => { stopped = true; clearTimeout(timer); clearTimeout(restart); child?.kill(); };
}

const adapter: BodyAdapter = {
  name: "macos",
  get describe() {
    const parts = [`一台运行 macOS${version ? ` ${version}` : ""} 的 Mac ${laptop ? "笔记本电脑" : "电脑"}`];
    parts.push(gui ? "有图形界面（能截图、看剪贴板、打开网页；看屏幕、点击、输入、切换窗口需要对方在系统设置里给辅助功能与屏幕录制权限）" : "现在没有人登录图形界面");
    const has = [cameras > 0 && "摄像头", "扬声器与麦克风"].filter(Boolean);
    parts.push(`有${has.join("、")}`);
    return parts.join("，");
  },
  async deviceId() { return machineId(); },
  async init() {
    version = (await run("sw_vers", ["-productVersion"], 10_000)).out.trim();
    laptop = parsePmsetBatt((await run("pmset", ["-g", "batt"], 10_000)).out).present;
    const mgr = (await run("launchctl", ["managername"], 10_000)).out.trim();
    gui = !mgr || /aqua/i.test(mgr);
    cameras = cameraCount((await run("system_profiler", ["SPCameraDataType", "-json"], 15_000)).out);
  },
  // 体温：battery.tempC 是电池自身的温度（心脏与听觉按 budget.maxTempC 抑制，阈值按手机电池设计），与 Linux 一致；
  // CPU 温度要管理员权限（powermetrics）才读得到，不读。Intel 机器上 pmset 报 CPU 降频比例，放进 extra。
  async sample(): Promise<RawSample> {
    const b = parsePmsetBatt((await run("pmset", ["-g", "batt"], 10_000)).out);
    const extra: Record<string, string | number | boolean> = {};
    if (b.source) extra.电源 = b.source === "ac" ? "外接电源" : b.source === "ups" ? "UPS" : "电池";
    const limit = cpuSpeedLimit((await run("pmset", ["-g", "therm"], 10_000)).out);
    if (limit !== undefined && limit < 100) extra.CPU限速 = limit;
    if (!b.present || b.level === undefined) return { extra: Object.keys(extra).length ? extra : undefined };
    const io = (await run("ioreg", ["-rn", "AppleSmartBattery"], 10_000)).out;
    const cap = batteryCapacityPercent(io);
    if (cap !== undefined) extra.电池容量 = cap;
    return { battery: { level: b.level, charging: Boolean(b.charging), tempC: batteryTempC(io) }, extra };
  },
  // 系统通知：osascript（JXA）的 display notification；服务日志里只记标题（配对码这类内容不留在日志里），弹不出来时才把内容写进日志
  async notify(title, text) {
    const shown = gui && (await run("osascript", ["-l", "JavaScript", "-e", NOTIFY_JXA, JSON.stringify({ title, text })], 10_000)).code === 0;
    process.stdout.write(shown ? `[macos] 通知：${title}（内容见通知中心或控制台）\n` : `[macos] 通知：${title} — ${text}\n`);
  },
  // 播放音频（如语音合成的结果）：afplay 后台播放，立即返回；stopAudio 停止
  async playAudio(file) {
    const c = playerCommand(file);
    if (!c) throw new Error("没有可用的播放器（afplay）");
    await adapter.stopAudio?.();
    const p = start(c[0], c[1]);
    playing = p;
    p.once("exit", () => { if (playing === p) playing = undefined; });
  },
  async stopAudio() { playing?.kill("SIGTERM"); playing = undefined; },
  tools,
  get hands() { return gui ? hands : undefined; }, // 计算机使用（status / screenshot / snapshot / click / drag / scroll / type / key / openApp / windows / focusWindow）：只在有图形登录会话时提供
  supervision: { status: supervise.status, set: supervise.set }, // 守护开关：launchd 用户代理
  quit: () => supervise.quit(), // 托盘的「退出」：这一次不再拉起
  upgrade, // 从控制台升级：后台重跑一键安装脚本（脱离 launchd 代理的进程组）
  upgradeStatus,
  onNetworkChange: (cb) => watchNetwork(cb),
  // speak 不提供：与 Linux 适配器一致，说话统一由运行基座的 voice_speak 完成
};

export { permissionHelp };
export default adapter;
