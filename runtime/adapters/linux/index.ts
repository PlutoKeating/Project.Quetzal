// Quetzal 身体适配器：任意 Linux 电脑或服务器（笔记本、小主机、树莓派、云主机）。
// 由 npm 包 `@plutokeating/quetzal`（cli/）随运行基座一起安装；只依赖 body/adapter.ts 的类型定义（构建时擦除）。
// 一切靠探测：电池、温度读 /sys；桌面工具（通知、播放、截图、剪贴板、相机、录音）有什么用什么，没有时工具报错而不崩溃。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import type { BodyAdapter, AdapterTool, RawSample } from "../../src/body/adapter.ts";
import { run, start, have, first, readText, prettyName, pickBattery, pickThermal, playerCommand, screenshotCommand, clipboardCommand, recordCommand } from "./linux.ts";
import * as supervise from "./supervise.ts";
import { upgrade, upgradeStatus } from "./upgrade.ts";

const MEDIA = path.join(process.env.QUETZAL_HOME ?? path.join(os.homedir(), ".quetzal"), "data", "media"); // Linux 的家目录缺省 ~/.quetzal（服务里总是由 QUETZAL_HOME 指定）
const POWER = "/sys/class/power_supply";
const THERMAL = "/sys/class/thermal";

let distro = "Linux";
let battery: string | undefined; // /sys/class/power_supply/<电池>
let thermal: string | undefined; // /sys/class/thermal/<区>/temp
let camera: string | undefined; // /dev/video0
let sound = false; // 有声卡
let playing: ChildProcess | undefined;

const desktop = () => Boolean(process.env.WAYLAND_DISPLAY || process.env.DISPLAY);
const wayland = () => Boolean(process.env.WAYLAND_DISPLAY) || process.env.XDG_SESSION_TYPE === "wayland";
const obj = (props: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties: props, required });
const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");
const media = (name: string) => { fs.mkdirSync(MEDIA, { recursive: true }); return path.join(MEDIA, name); };
const sizeKB = (f: string) => Math.round(fs.statSync(f).size / 1024);

function listSys(dir: string, attrs: string[]) {
  try {
    return fs.readdirSync(dir).map((name) => Object.fromEntries([["name", name], ...attrs.map((a) => [a, readText(path.join(dir, name, a))])])) as Record<string, string | undefined>[];
  } catch { return []; }
}

/** 外接电源是否接着（有 Mains / USB 类电源且 online=1）。 */
function acOnline(): boolean {
  return listSys(POWER, ["type", "online"]).some((e) => (e.type === "Mains" || e.type === "USB") && e.online === "1");
}

const tools: AdapterTool[] = [
  {
    name: "take_photo", permission: "camera", description: "用这台电脑的摄像头拍一张照片，返回文件路径。",
    parameters: obj({}),
    handler: async () => {
      if (!camera) return "这台电脑没有摄像头";
      if (!have("ffmpeg")) return "拍照需要 ffmpeg（请安装后再试）";
      const f = media(`photo-${stamp()}.jpg`);
      const r = await run("ffmpeg", ["-y", "-loglevel", "error", "-f", "v4l2", "-i", camera, "-frames:v", "1", f], 30_000);
      return r.code === 0 && fs.existsSync(f) ? `已拍摄：${f}（${sizeKB(f)} KB）` : "拍照失败（摄像头被占用或不可用）";
    },
  },
  {
    name: "record_audio", permission: "microphone", description: "用麦克风录一段声音（秒），返回 WAV 文件路径。",
    parameters: obj({ seconds: { type: "number" } }, ["seconds"]),
    handler: async (a) => {
      const s = Math.max(1, Math.min(120, Number(a.seconds) || 5));
      const f = media(`audio-${stamp()}.wav`);
      const c = recordCommand(f, s);
      if (!c) return "录音需要 arecord、pw-record、parecord 或 ffmpeg 之一";
      if (c.limited) await run(c.cmd, c.args, (s + 10) * 1000);
      else { const p = start(c.cmd, c.args); await new Promise((r) => setTimeout(r, s * 1000)); p.kill("SIGINT"); await new Promise((r) => p.once("exit", r)); }
      return fs.existsSync(f) && fs.statSync(f).size > 44 ? `已录制 ${s} 秒：${f}` : "录音失败（没有麦克风或音频服务没有运行）";
    },
  },
  {
    name: "screenshot", permission: "hands", description: "截取这台电脑当前的屏幕，返回图片路径（之后可以用 view_image 看）。",
    parameters: obj({}),
    handler: async () => {
      if (!desktop()) return "这台电脑没有图形界面";
      const f = media(`screen-${stamp()}.png`);
      const c = screenshotCommand(f, wayland());
      if (!c) return `截图需要 ${wayland() ? "grim、gnome-screenshot 或 spectacle" : "scrot、gnome-screenshot、spectacle 或 ImageMagick"} 之一`;
      const r = await run(c[0], c[1], 30_000);
      return r.code === 0 && fs.existsSync(f) ? `已截图：${f}（${sizeKB(f)} KB）` : `截图失败：${r.out.trim().slice(0, 200)}`;
    },
  },
  {
    name: "clipboard", permission: "device", description: "读取（不给 text）或写入这台电脑的剪贴板。",
    parameters: obj({ text: { type: "string" } }),
    handler: async (a) => {
      if (!desktop()) return "这台电脑没有图形界面，没有剪贴板";
      const c = clipboardCommand(a.text != null, wayland());
      if (!c) return "剪贴板需要 wl-clipboard、xclip 或 xsel 之一";
      if (a.text != null) return (await run(c[0], c[1], 10_000, String(a.text))).code === 0 ? "已写入剪贴板" : "写入失败";
      const r = await run(c[0], c[1], 10_000);
      return r.code === 0 ? r.out || "（剪贴板为空）" : "（剪贴板为空）";
    },
  },
  {
    name: "open", permission: "device", description: "用这台电脑的默认程序打开一个网址或本地文件（会在桌面上弹出窗口）。",
    parameters: obj({ target: { type: "string" } }, ["target"]),
    handler: async (a) => {
      if (!desktop()) return "这台电脑没有图形界面";
      if (!have("xdg-open")) return "需要 xdg-open（xdg-utils）";
      return (await run("xdg-open", [String(a.target)], 15_000)).code === 0 ? `已打开：${a.target}` : "打开失败";
    },
  },
];

const adapter: BodyAdapter = {
  name: "linux",
  get describe() {
    const parts = [`一台运行 ${distro} 的 Linux ${battery ? "笔记本电脑" : "电脑"}`];
    parts.push(desktop() ? "有桌面环境（能截图、看剪贴板、打开网页）" : "没有图形界面，像服务器一样一直开着");
    const has = [camera && "摄像头", sound && "扬声器与麦克风"].filter(Boolean);
    if (has.length) parts.push(`有${has.join("、")}`);
    return parts.join("，");
  },
  async init() {
    distro = prettyName(readText("/etc/os-release") ?? "") ?? "Linux";
    battery = pickBattery(listSys(POWER, ["type", "scope"]) as { name: string; type?: string; scope?: string }[]);
    const zone = pickThermal(listSys(THERMAL, ["type"]).filter((z) => /^thermal_zone/.test(z.name ?? "")) as { name: string; type?: string }[]);
    thermal = zone ? path.join(THERMAL, zone, "temp") : undefined;
    camera = ["/dev/video0", "/dev/video1"].find((d) => fs.existsSync(d));
    sound = Boolean(readText("/proc/asound/cards"));
  },
  // 体温：battery.tempC 是电池自身的温度（心脏与听觉按 budget.maxTempC 抑制，阈值按手机电池设计），笔记本电池很少提供；
  // CPU 温度正常就有六七十度，只放进 extra 让她知道，不冒充体温。
  async sample(): Promise<RawSample> {
    const cpu = thermal ? Number(readText(thermal)) : NaN;
    const extra: Record<string, string | number | boolean> = {};
    if (Number.isFinite(cpu) && cpu > 0) extra.CPU温度 = Math.round(cpu / 100) / 10;
    if (!battery) return { extra: Object.keys(extra).length ? extra : undefined };
    const level = Number(readText(path.join(POWER, battery, "capacity")));
    const status = readText(path.join(POWER, battery, "status")) ?? "";
    const charging = /^(Charging|Full)$/i.test(status) || (/Not charging/i.test(status) && acOnline());
    const temp = Number(readText(path.join(POWER, battery, "temp")));
    extra.电源 = acOnline() ? "外接电源" : "电池";
    return {
      battery: Number.isFinite(level) ? { level, charging, tempC: Number.isFinite(temp) ? temp / 10 : undefined, health: readText(path.join(POWER, battery, "health")) } : undefined,
      extra,
    };
  },
  // 系统通知：有桌面时用 notify-send，服务日志里只记标题（配对码这类内容不留在日志里）；没有桌面（或弹不出来）的机器才把内容写进日志，从日志里看配对码
  async notify(title, text) {
    const shown = desktop() && have("notify-send") && (await run("notify-send", ["-a", "Quetzal", "-u", "normal", title, text], 10_000)).code === 0;
    process.stdout.write(shown ? `[linux] 通知：${title}（内容见桌面通知或控制台）\n` : `[linux] 通知：${title} — ${text}\n`);
  },
  // 播放音频（如语音合成的结果）：后台播放，立即返回；stopAudio 停止
  async playAudio(file) {
    const c = playerCommand(file);
    if (!c) throw new Error("没有可用的播放器（pw-play、paplay、ffplay 或 mpv）");
    await adapter.stopAudio?.();
    const p = start(c[0], c[1]);
    playing = p;
    p.once("exit", () => { if (playing === p) playing = undefined; });
  },
  async stopAudio() { playing?.kill("SIGTERM"); playing = undefined; },
  tools,
  supervision: { status: supervise.status, set: supervise.set }, // 守护开关：systemd 用户服务或一键安装脚本的守护循环
  quit: () => supervise.quit(), // 托盘的「退出」：停掉后台服务（这一次）
  upgrade, // 从控制台升级：后台重跑一键安装脚本（systemd-run 脱离服务的 cgroup）
  upgradeStatus, // 读 logs/upgrade.log：进行中、退出码、最后一步
  // speak 不提供：与 Termux 适配器一致，说话统一由运行基座的 voice_speak 完成
  // hands：看屏幕与操作其他应用——只提供 screenshot 工具；点击与输入待做
};

export default adapter;
