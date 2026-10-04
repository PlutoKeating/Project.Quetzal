// Linux 适配器的探测与纯函数：电池、温度、桌面工具的挑选。与具体发行版、具体机器无关，一切靠探测。
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export function run(cmd: string, args: string[] = [], timeoutMs = 20_000, input?: string): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const p = execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 8 << 20 }, (e: any, out) =>
      resolve({ code: e ? (typeof e.code === "number" ? e.code : 1) : 0, out: String(out) }));
    if (input != null) p.stdin?.end(input);
  });
}

/** 启动一个后台程序（播放、录音），返回子进程；调用方负责停止。 */
export function start(cmd: string, args: string[]) {
  return spawn(cmd, args, { stdio: "ignore" });
}

const found = new Map<string, boolean>();
/** PATH 里有没有这个命令（结果缓存）。 */
export function have(cmd: string): boolean {
  if (!found.has(cmd)) found.set(cmd, (process.env.PATH ?? "").split(path.delimiter).some((d) => { try { fs.accessSync(path.join(d, cmd), fs.constants.X_OK); return true; } catch { return false; } }));
  return found.get(cmd)!;
}
export const first = (cands: string[]) => cands.find(have);

export function readText(file: string): string | undefined {
  try { return fs.readFileSync(file, "utf8").trim(); } catch { return undefined; }
}

/** `/etc/os-release` 的 PRETTY_NAME（如 Ubuntu 24.04 LTS）。 */
export function prettyName(osRelease: string): string | undefined {
  const m = osRelease.match(/^PRETTY_NAME="?([^"\n]+)"?/m);
  return m?.[1];
}

/** 从 /sys/class/power_supply 的条目里挑出整机的电池：type=Battery，且不是外设（scope=Device，如蓝牙鼠标 hidpp_battery_*）。优先 BAT*。 */
export function pickBattery(entries: { name: string; type?: string; scope?: string }[]): string | undefined {
  const bats = entries.filter((e) => e.type === "Battery" && e.scope !== "Device" && !/^hidpp|^hid-|^wacom/i.test(e.name));
  return (bats.find((e) => /^BAT/i.test(e.name)) ?? bats[0])?.name;
}

/** 从 /sys/class/thermal 的区里挑出能代表机器体温的那个（CPU 封装、SoC），没有就第一个。 */
export function pickThermal(zones: { name: string; type?: string }[]): string | undefined {
  return (zones.find((z) => /x86_pkg_temp|cpu|soc|core|k10temp|coretemp|acpitz/i.test(z.type ?? "")) ?? zones[0])?.name;
}

/** 音频播放器候选（按优先级）：PipeWire、PulseAudio、ffplay、mpv；aplay 只认 WAV。 */
export function playerCommand(file: string, has: (c: string) => boolean = have): [string, string[]] | undefined {
  const c: [string, string[]][] = [
    ["pw-play", [file]], ["paplay", [file]],
    ["ffplay", ["-nodisp", "-autoexit", "-loglevel", "error", file]], ["mpv", ["--no-video", "--really-quiet", file]],
  ];
  if (/\.wav$/i.test(file)) c.push(["aplay", ["-q", file]]);
  return c.find(([cmd]) => has(cmd));
}

/** 截图命令：Wayland 下 grim / gnome-screenshot / spectacle，X11 下 scrot / gnome-screenshot / spectacle / import。 */
export function screenshotCommand(file: string, wayland: boolean, has: (c: string) => boolean = have): [string, string[]] | undefined {
  const c: [string, string[]][] = wayland
    ? [["grim", [file]], ["gnome-screenshot", ["-f", file]], ["spectacle", ["-b", "-n", "-o", file]]]
    : [["scrot", ["-o", file]], ["gnome-screenshot", ["-f", file]], ["spectacle", ["-b", "-n", "-o", file]], ["import", ["-window", "root", file]]];
  return c.find(([cmd]) => has(cmd));
}

/** 剪贴板读写命令：Wayland 的 wl-clipboard，X11 的 xclip / xsel。 */
export function clipboardCommand(write: boolean, wayland: boolean, has: (c: string) => boolean = have): [string, string[]] | undefined {
  const c: [string, string[]][] = wayland
    ? [write ? ["wl-copy", []] : ["wl-paste", ["-n"]]]
    : [];
  c.push(write ? ["xclip", ["-selection", "clipboard"]] : ["xclip", ["-selection", "clipboard", "-o"]]);
  c.push(write ? ["xsel", ["-ib"]] : ["xsel", ["-ob"]]);
  return c.find(([cmd]) => has(cmd));
}

/** 录音命令：arecord 自带时长；pw-record / parecord 没有，由调用方到时停止（返回 limited=false）。 */
export function recordCommand(file: string, seconds: number, has: (c: string) => boolean = have): { cmd: string; args: string[]; limited: boolean } | undefined {
  if (has("arecord")) return { cmd: "arecord", args: ["-q", "-f", "cd", "-d", String(seconds), file], limited: true };
  if (has("pw-record")) return { cmd: "pw-record", args: [file], limited: false };
  if (has("parecord")) return { cmd: "parecord", args: ["--file-format=wav", file], limited: false };
  if (has("ffmpeg")) return { cmd: "ffmpeg", args: ["-y", "-loglevel", "error", "-f", "pulse", "-i", "default", "-t", String(seconds), file], limited: true };
  return undefined;
}
