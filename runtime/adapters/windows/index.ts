// Quetzal 身体适配器：任意 Windows 10（1809 起）/ 11 电脑（x64、arm64）。只依赖 body/adapter.ts 的类型定义（构建时擦除）。
//   一切靠探测、不装任何东西：电源读系统的电源状态，温度试 ACPI 热区（多数笔记本拿不到就不报），摄像头与声卡查即插即用设备。
//   开机自启时运行基座在会话 0（没人登录也在跑），看不到桌面：通知、截图、剪贴板、打开、播放、拍照、录音交给用户桌面里的身体助手
//   （windows-body.mjs，由控制台托盘启动，见 body.ts）；运行基座本来就在登录的桌面里时直接做。都不行时如实说「需要有人登录桌面」。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import type { BodyAdapter, AdapterTool, RawSample } from "../../src/body/adapter.ts";
import { ps, ops } from "./desktop.ts";
import * as supervise from "./supervise.ts";

const home = () => process.env.QUETZAL_HOME ?? path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "Quetzal", "home");
const obj = (props: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties: props, required });

let interactive = false; // 运行基座自己在用户的桌面会话里（不是会话 0）
let caption = "Windows";
let laptop = false;
let camera = false, sound = false;
let thermal = false;

// ---------- 桌面操作：自己在桌面里就直接做，否则找身体助手
interface Helper { port: number; token: string; pid: number }
function helper(): Helper | undefined {
  try { const h = JSON.parse(fs.readFileSync(path.join(home(), "secrets", "desktop-body.json"), "utf8")); return h.port && h.token ? h : undefined; } catch { return undefined; }
}
export class NoDesktop extends Error { constructor() { super("这台电脑现在没有人登录桌面（运行基座在开机后台跑着），截图、通知、剪贴板、打开、播放、拍照、录音要等有人登录 Windows、Quetzal 的托盘图标出现以后才能用"); } }

async function desk(op: string, args: Record<string, any> = {}, timeoutMs = 60_000): Promise<any> {
  if (interactive) return ops[op](args);
  const h = helper();
  if (!h) throw new NoDesktop();
  let r: Response;
  try {
    r = await fetch(`http://127.0.0.1:${h.port}/call`, { method: "POST", headers: { authorization: `Bearer ${h.token}`, "content-type": "application/json" }, body: JSON.stringify({ op, args }), signal: AbortSignal.timeout(timeoutMs) });
  } catch { throw new NoDesktop(); } // 助手退出了（注销了、托盘关了）
  const j = await r.json() as { ok: boolean; result?: unknown; error?: string };
  if (!j.ok) throw new Error(j.error ?? "身体助手出错");
  return j.result;
}
const say = async (f: () => Promise<any>) => { try { return String(await f()); } catch (e) { return (e as Error).message; } };

const tools: AdapterTool[] = [
  { name: "take_photo", permission: "camera", description: "用这台电脑的摄像头拍一张照片，返回文件路径（之后可以用 view_image 看）。", parameters: obj({}),
    handler: () => camera ? say(() => desk("camera", {}, 90_000)) : Promise.resolve("这台电脑没有摄像头") },
  { name: "record_audio", permission: "microphone", description: "用麦克风录一段声音（秒，最多 120），返回 WAV 文件路径。", parameters: obj({ seconds: { type: "number" } }, ["seconds"]),
    handler: (a) => say(() => desk("record", { seconds: Number(a.seconds) || 5 }, (Math.min(120, Number(a.seconds) || 5) + 45) * 1000)) },
  { name: "screenshot", permission: "hands", description: "截取这台电脑当前的屏幕（全部显示器），返回图片路径（之后可以用 view_image 看）。", parameters: obj({}),
    handler: () => say(() => desk("screenshot")) },
  { name: "clipboard", permission: "device", description: "读取（不给 text）或写入这台电脑的剪贴板。", parameters: obj({ text: { type: "string" } }),
    handler: (a) => say(() => a.text != null ? desk("clipboard.set", { text: String(a.text) }) : desk("clipboard.get")) },
  { name: "open", permission: "device", description: "用这台电脑的默认程序打开一个网址或本地的文档、图片、音视频文件、文件夹（会在桌面上弹出窗口；不打开程序与脚本）。", parameters: obj({ target: { type: "string" } }, ["target"]),
    handler: (a) => say(() => desk("open", { target: String(a.target) })) },
];

/** 设备标识：注册表 HKLM\\SOFTWARE\\Microsoft\\Cryptography 的 MachineGuid（安装 Windows 时生成，重装系统会变）。只用来派生身体 uuid。 */
export function parseMachineGuid(out: string): string | undefined {
  const m = out.match(/MachineGuid\s+REG_SZ\s+([0-9a-fA-F-]{36})/);
  return m ? m[1].toLowerCase() : undefined;
}
const machineGuid = () => new Promise<string | undefined>((resolve) => execFile(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "reg.exe"),
  ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid", "/reg:64"], { timeout: 10_000, windowsHide: true }, (e, out) => resolve(e ? undefined : parseMachineGuid(String(out)))));

const adapter: BodyAdapter = {
  name: "windows",
  get describe() {
    const parts = [`一台运行 ${caption} 的${laptop ? "笔记本电脑" : "电脑"}`];
    parts.push(interactive ? "运行在登录的桌面里（能截图、看剪贴板、打开网页）" : "开机就在后台运行；有人登录桌面时能截图、看剪贴板、打开网页");
    const has = [camera && "摄像头", sound && "扬声器与麦克风"].filter(Boolean);
    if (has.length) parts.push(`有${has.join("、")}`);
    return parts.join("，");
  },
  deviceId: machineGuid,
  async init() {
    const out = await ps.run(`
$s = [System.Diagnostics.Process]::GetCurrentProcess().SessionId
$os = (Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue).Caption
$cam = @(Get-CimInstance Win32_PnPEntity -Filter "PNPClass='Camera' OR PNPClass='Image'" -ErrorAction SilentlyContinue).Count
$snd = @(Get-CimInstance Win32_SoundDevice -ErrorAction SilentlyContinue).Count
$t = 0; try { $t = @(Get-CimInstance -Namespace root/wmi MSAcpi_ThermalZoneTemperature -ErrorAction Stop).Count } catch {}
Add-Type -AssemblyName System.Windows.Forms
$bat = -not ([System.Windows.Forms.SystemInformation]::PowerStatus.BatteryChargeStatus -band [System.Windows.Forms.BatteryChargeStatus]::NoSystemBattery)
"$s|$os|$cam|$snd|$t|$bat"`, 60_000).catch(() => "");
    const [s, os_, cam, snd, t, bat] = out.trim().split("|");
    interactive = s !== undefined && s !== "" && s !== "0";
    caption = (os_ || "Windows").replace(/^Microsoft\s+/, "");
    camera = Number(cam) > 0; sound = Number(snd) > 0; thermal = Number(t) > 0; laptop = bat === "True";
  },
  // 电量与是否接着电源（SystemInformation.PowerStatus = GetSystemPowerStatus，会话 0 里也能读）；温度只在 ACPI 热区可读时报，放进 extra，不冒充体温
  async sample(): Promise<RawSample> {
    const out = await ps.run(`
Add-Type -AssemblyName System.Windows.Forms
$p = [System.Windows.Forms.SystemInformation]::PowerStatus
"$([int]($p.BatteryLifePercent * 100))|$($p.PowerLineStatus)|$([int]$p.BatteryChargeStatus)"`).catch(() => "");
    const [lv, line, st] = out.trim().split("|");
    const extra: Record<string, string | number | boolean> = {};
    if (thermal) {
      const t = Number((await ps.run("(@(Get-CimInstance -Namespace root/wmi MSAcpi_ThermalZoneTemperature -ErrorAction Stop) | Measure-Object CurrentTemperature -Maximum).Maximum").catch(() => "")).trim());
      if (Number.isFinite(t) && t > 2732) extra.温度 = Math.round(t / 10 - 273.15); // 十分之一开尔文
    }
    const level = Number(lv), status = Number(st);
    if (!laptop || !Number.isFinite(level) || (status & 128)) { if (line) extra.电源 = "外接电源"; return { extra: Object.keys(extra).length ? extra : undefined }; }
    const plugged = line === "Online";
    extra.电源 = plugged ? "外接电源" : "电池";
    return { battery: { level: Math.max(0, Math.min(100, level)), charging: plugged }, extra };
  },
  // 系统通知：Toast（桌面里）；没人登录时写进日志（配对码这类内容只写标题）
  async notify(title, text) {
    try { await desk("notify", { title, text }); process.stdout.write(`[windows] 通知：${title}（内容见桌面通知或控制台）\n`); }
    catch { process.stdout.write(`[windows] 通知：${title} — ${text}\n`); }
  },
  async playAudio(file) { await desk("playAudio", { file }); },
  async stopAudio() { await desk("stopAudio").catch(() => {}); },
  tools,
  supervision: { status: supervise.status, set: supervise.set },
  quit: () => supervise.quit(),
  // 从控制台升级：有人登录时交给桌面里的身体助手启动（安装包需要提权时能弹 UAC），否则自己在后台启动
  upgrade: (version) => supervise.upgrade(version, interactive ? undefined : async (id, v) => (await desk("upgrade", { id, version: v }, 20_000).then(() => true))),
  upgradeStatus: supervise.upgradeStatus,
  // speak 不提供：说话统一由运行基座的 voice_speak 完成（声音经 playAudio 播放）
};

export default adapter;
