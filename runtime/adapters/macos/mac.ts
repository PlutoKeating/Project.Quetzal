// macOS 适配器的探测、命令拼装与输出解析（纯函数为主）：pmset、ioreg、sw_vers、system_profiler 的输出解析，
// 拍照、录音、播放用哪个程序。与具体机型无关，一切靠探测；系统自带的程序（pmset、ioreg、screencapture、pbcopy、afplay、osascript）
// 也按 PATH 找，找不到就不提供对应能力。
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** 运行一个程序：返回退出码与标准输出（不抛错）。input 写进标准输入；env 覆盖部分环境变量。 */
export function run(cmd: string, args: string[] = [], timeoutMs = 20_000, input?: string, env?: Record<string, string>): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const p = execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 16 << 20, env: env ? { ...process.env, ...env } : process.env }, (e: any, out, err) =>
      resolve({ code: e ? (typeof e.code === "number" ? e.code : 1) : 0, out: String(out), err: String(err) }));
    p.stdin?.on("error", () => {}); // 程序没读完标准输入就退出了：不当成崩溃
    if (input != null) p.stdin?.end(input);
  });
}

/** 启动一个后台程序（播放、录音），返回子进程；调用方负责停止。 */
export function start(cmd: string, args: string[]) {
  return spawn(cmd, args, { stdio: "ignore" });
}

const found = new Map<string, boolean>();
/** PATH 里有没有这个命令（结果缓存）。launchd 用户代理的 PATH 很短：/usr/local/bin 与 /opt/homebrew/bin（Homebrew）也看。 */
export function have(cmd: string): boolean {
  if (!found.has(cmd)) found.set(cmd, searchPath().some((d) => { try { fs.accessSync(path.join(d, cmd), fs.constants.X_OK); return true; } catch { return false; } }));
  return found.get(cmd)!;
}
/** 命令的完整路径（cliclick、imagesnap 这类 Homebrew 装的程序可能不在服务的 PATH 里）。 */
export function which(cmd: string): string | undefined {
  for (const d of searchPath()) { const f = path.join(d, cmd); try { fs.accessSync(f, fs.constants.X_OK); return f; } catch { /* 下一个 */ } }
  return undefined;
}
const searchPath = () => [...new Set([...(process.env.PATH ?? "").split(path.delimiter).filter(Boolean), "/usr/bin", "/bin", "/usr/sbin", "/sbin", "/usr/local/bin", "/opt/homebrew/bin"])];

/** 文本工具（pbcopy / pbpaste）按 UTF-8 处理：launchd 的环境里没有 LANG，缺省会按 MacRoman 编码中文。 */
export const UTF8_ENV = { LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" };

export interface MacBattery { source?: "ac" | "battery" | "ups"; present: boolean; level?: number; state?: string; charging?: boolean }

/**
 * `pmset -g batt` 的输出：第一行是电源（'AC Power' / 'Battery Power' / 'UPS Power'），之后每块电池一行
 * `-InternalBattery-0 (id=…)\t87%; charging; 1:10 remaining present: true`。台式机没有电池行。
 * charging 的含义与 Linux 适配器一致：在充、已充满、快充满为真；接着外接电源但「not charging」（优化充电）也为真；在放电为假。
 */
export function parsePmsetBatt(out: string): MacBattery {
  const src = out.match(/drawing from '([^']+)'/i)?.[1]?.toLowerCase() ?? "";
  const source = src.startsWith("ac") ? "ac" : src.startsWith("battery") ? "battery" : src.startsWith("ups") ? "ups" : undefined;
  const line = out.split("\n").find((l) => /InternalBattery/i.test(l) && /\d+%/.test(l));
  if (!line) return { source, present: false };
  const level = Number(line.match(/(\d+)%/)![1]);
  const state = line.split(";")[1]?.trim().toLowerCase();
  let charging: boolean;
  if (state === "discharging") charging = false;
  else if (state === "charging" || state === "charged" || state === "finishing charge") charging = true;
  else charging = source === "ac";
  return { source, present: true, level, state, charging };
}

/** `ioreg -rn AppleSmartBattery` 里的一个数值键（如 "Temperature" = 3051）。 */
export function ioregNumber(out: string, key: string): number | undefined {
  const m = out.match(new RegExp(`"${key}"\\s*=\\s*(-?\\d+)`));
  return m ? Number(m[1]) : undefined;
}

/** 电池自身的温度（°C）：AppleSmartBattery 的 Temperature 以 0.01 °C 计；个别机器以 0.1 K 计，按合理范围判断，都不像就不报。 */
export function batteryTempC(out: string): number | undefined {
  const t = ioregNumber(out, "Temperature");
  if (t === undefined) return undefined;
  const c = t / 100;
  if (c > -20 && c < 90) return Math.round(c * 10) / 10;
  const k = t / 10 - 273.15;
  if (k > -20 && k < 90) return Math.round(k * 10) / 10;
  return undefined;
}

/** 电池还剩设计容量的百分之几（AppleRawMaxCapacity / DesignCapacity；拿不到 raw 时用 MaxCapacity 与 DesignCapacity，二者都是 mAh 才算）。 */
export function batteryCapacityPercent(out: string): number | undefined {
  const design = ioregNumber(out, "DesignCapacity");
  const max = ioregNumber(out, "AppleRawMaxCapacity") ?? ioregNumber(out, "MaxCapacity");
  if (!design || !max || max <= 100) return undefined; // MaxCapacity 在新机器上是百分比（100），不能拿来除
  const p = Math.round((max / design) * 100);
  return p > 0 && p <= 150 ? p : undefined;
}

/** 设备标识：`ioreg -rd1 -c IOPlatformExpertDevice` 的 IOPlatformUUID（重装系统也不变的硬件 UUID）。只用来派生身体 uuid。 */
export function platformUUID(out: string): string | undefined {
  const m = out.match(/"IOPlatformUUID"\s*=\s*"([0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12})"/);
  return m?.[1].toLowerCase();
}

/** `pmset -g therm`：Intel 的机器给出 CPU_Speed_Limit（100 = 没有降频）；Apple 芯片只有「没有记录到热警告」，不报。 */
export function cpuSpeedLimit(out: string): number | undefined {
  const m = out.match(/CPU_Speed_Limit\s*=\s*(\d+)/);
  return m ? Number(m[1]) : undefined;
}

/** `system_profiler SPCameraDataType -json` 里有几个摄像头（解析不了为 0）。 */
export function cameraCount(json: string): number {
  try { const v = JSON.parse(json).SPCameraDataType; return Array.isArray(v) ? v.length : 0; } catch { return 0; }
}

/** 拍照命令：imagesnap（Homebrew，专为 macOS 摄像头写的小工具）优先，否则 ffmpeg 的 avfoundation 输入。都没有返回 undefined。 */
export function photoCommand(file: string, has: (c: string) => boolean = have): [string, string[]] | undefined {
  if (has("imagesnap")) return ["imagesnap", ["-q", "-w", "1", file]];
  if (has("ffmpeg")) return ["ffmpeg", ["-y", "-loglevel", "error", "-f", "avfoundation", "-framerate", "30", "-i", "0", "-frames:v", "1", file]];
  return undefined;
}

/** 录音命令：ffmpeg 的 avfoundation（默认麦克风 ":0"），否则 SoX 的 rec；都自带时长。 */
export function recordCommand(file: string, seconds: number, has: (c: string) => boolean = have): { cmd: string; args: string[] } | undefined {
  if (has("ffmpeg")) return { cmd: "ffmpeg", args: ["-y", "-loglevel", "error", "-f", "avfoundation", "-i", ":0", "-t", String(seconds), "-ac", "1", "-ar", "16000", file] };
  if (has("rec")) return { cmd: "rec", args: ["-q", "-c", "1", "-r", "16000", file, "trim", "0", String(seconds)] };
  return undefined;
}

/** 播放命令：系统自带的 afplay，退回 ffplay。 */
export function playerCommand(file: string, has: (c: string) => boolean = have): [string, string[]] | undefined {
  if (has("afplay")) return ["afplay", [file]];
  if (has("ffplay")) return ["ffplay", ["-nodisp", "-autoexit", "-loglevel", "error", file]];
  return undefined;
}

/** 系统通知的 JXA（标题与正文经参数传入，不拼进脚本）。 */
export const NOTIFY_JXA = `function run(argv) {
  var a = JSON.parse(argv[0]);
  var app = Application.currentApplication();
  app.includeStandardAdditions = true;
  app.displayNotification(a.text, { withTitle: a.title, subtitle: "Quetzal" });
  return "ok";
}`;

/** `open` 的参数：网址与本地文件都交给默认程序。 */
export const openArgs = (target: string) => [target];

/** `scutil` 的监听命令：主网络（默认路由所在的服务）与各网卡的地址变化时打印通知（喂给它的标准输入）。 */
export const SCUTIL_WATCH = [
  "n.add State:/Network/Global/IPv4",
  "n.add State:/Network/Global/IPv6",
  "n.add State:/Network/Interface/[^/]+/IPv4 pattern",
  "n.add State:/Network/Interface/[^/]+/IPv6 pattern",
  "n.watch",
  "",
].join("\n");
/** scutil 的输出里有没有一次变化通知（「notification callback」与随后列出的变化键）。 */
export const scutilChanged = (chunk: string) => /notification callback|changed key/i.test(chunk);
