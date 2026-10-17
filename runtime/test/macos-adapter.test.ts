// macOS 身体适配器：pmset / ioreg / scutil / launchctl 输出的解析，拍照、录音、播放用哪个程序，升级脱离进程组。
// 这台测试机不一定是 Mac：只测纯函数与命令拼装（输出用真实格式的样本），不调用 macOS 的程序。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parsePmsetBatt, batteryTempC, batteryCapacityPercent, platformUUID, cpuSpeedLimit, cameraCount, ioregNumber,
  photoCommand, recordCommand, playerCommand, scutilChanged, SCUTIL_WATCH, NOTIFY_JXA,
} from "../adapters/macos/mac.ts";
import { isDisabled, parsePrint, LABEL } from "../adapters/macos/supervise.ts";
import { detachUpgrade } from "../adapters/macos/upgrade.ts";

const BATT_AC_CHARGING = "Now drawing from 'AC Power'\n -InternalBattery-0 (id=4653155)\t87%; charging; 1:10 remaining present: true\n";
const BATT_DISCHARGING = "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=4653155)\t76%; discharging; 5:12 remaining present: true\n";
const BATT_NOT_CHARGING = "Now drawing from 'AC Power'\n -InternalBattery-0 (id=4653155)\t80%; AC attached; not charging present: true\n";
const BATT_CHARGED = "Now drawing from 'AC Power'\n -InternalBattery-0 (id=4653155)\t100%; charged; 0:00 remaining present: true\n";
const DESKTOP = "Now drawing from 'AC Power'\n";

test("pmset -g batt：电量、电源与充电状态；台式机没有电池", () => {
  assert.deepEqual(parsePmsetBatt(BATT_AC_CHARGING), { source: "ac", present: true, level: 87, state: "charging", charging: true });
  assert.deepEqual(parsePmsetBatt(BATT_DISCHARGING), { source: "battery", present: true, level: 76, state: "discharging", charging: false });
  assert.equal(parsePmsetBatt(BATT_NOT_CHARGING).charging, true, "接着电源但优化充电暂停：与 Linux 的 Not charging + 外接电源一致，算在充");
  assert.equal(parsePmsetBatt(BATT_CHARGED).charging, true);
  assert.equal(parsePmsetBatt(BATT_CHARGED).level, 100);
  assert.deepEqual(parsePmsetBatt(DESKTOP), { source: "ac", present: false });
  assert.deepEqual(parsePmsetBatt(""), { source: undefined, present: false });
});

test("ioreg AppleSmartBattery：电池温度（0.01 °C，个别为 0.1 K）与剩余容量", () => {
  const apple = `+-o AppleSmartBattery  <class AppleSmartBattery>\n    {\n      "Temperature" = 3051\n      "CycleCount" = 123\n      "MaxCapacity" = 100\n      "AppleRawMaxCapacity" = 4380\n      "DesignCapacity" = 4790\n    }`;
  assert.equal(batteryTempC(apple), 30.5);
  assert.equal(batteryCapacityPercent(apple), 91);
  assert.equal(ioregNumber(apple, "CycleCount"), 123);
  assert.equal(batteryTempC(`"Temperature" = 2981`), 29.8);
  assert.equal(batteryTempC(`"Temperature" = 99999`), undefined, "不像温度的值不报");
  assert.equal(batteryCapacityPercent(`"MaxCapacity" = 100\n"DesignCapacity" = 4790`), undefined, "MaxCapacity 是百分比时不能拿来除");
  assert.equal(batteryCapacityPercent(`"MaxCapacity" = 5100\n"DesignCapacity" = 5500`), 93, "老机器的 MaxCapacity 是 mAh");
  assert.equal(batteryTempC(""), undefined);
});

test("设备标识：IOPlatformUUID（小写）；格式不对的不用", () => {
  const out = `+-o J000AP  <class IOPlatformExpertDevice, id 0x100000214, registered, matched, active, busy 0 (0 ms), retain 37>\n    {\n      "IOPlatformSerialNumber" = "XXXXXXXXXX"\n      "IOPlatformUUID" = "0A1B2C3D-4E5F-6071-8293-A4B5C6D7E8F9"\n    }`;
  assert.equal(platformUUID(out), "0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9");
  assert.equal(platformUUID(`"IOPlatformUUID" = "not-a-uuid"`), undefined);
});

test("设备标识经 ioreg 读取（换掉执行函数）", async () => {
  const { machineId } = await import("../adapters/macos/index.ts");
  const calls: string[][] = [];
  const id = await machineId(async (cmd, args = []) => { calls.push([cmd, ...args]); return { code: 0, out: `"IOPlatformUUID" = "0A1B2C3D-4E5F-6071-8293-A4B5C6D7E8F9"`, err: "" }; });
  assert.equal(id, "0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9");
  assert.deepEqual(calls, [["ioreg", "-rd1", "-c", "IOPlatformExpertDevice"]]);
});

test("pmset -g therm 与 system_profiler 的摄像头", () => {
  assert.equal(cpuSpeedLimit("Note: No thermal warning level has been recorded\n CPU_Scheduler_Limit \t= 100\n CPU_Available_CPUs \t= 8\n CPU_Speed_Limit \t= 80\n"), 80);
  assert.equal(cpuSpeedLimit("Note: No thermal warning level has been recorded\nNote: No performance warning level has been recorded\n"), undefined);
  assert.equal(cameraCount(JSON.stringify({ SPCameraDataType: [{ _name: "camera" }] })), 1);
  assert.equal(cameraCount(JSON.stringify({ SPCameraDataType: [] })), 0);
  assert.equal(cameraCount("not json"), 0);
});

test("拍照、录音、播放按可用程序挑选；都没有时不提供", () => {
  const has = (set: string[]) => (c: string) => set.includes(c);
  assert.deepEqual(photoCommand("p.jpg", has(["imagesnap", "ffmpeg"])), ["imagesnap", ["-q", "-w", "1", "p.jpg"]]);
  assert.deepEqual(photoCommand("p.jpg", has(["ffmpeg"])), ["ffmpeg", ["-y", "-loglevel", "error", "-f", "avfoundation", "-framerate", "30", "-i", "0", "-frames:v", "1", "p.jpg"]]);
  assert.equal(photoCommand("p.jpg", has([])), undefined);
  assert.deepEqual(recordCommand("r.wav", 3, has(["ffmpeg"]))?.args.slice(4, 8), ["avfoundation", "-i", ":0", "-t"]);
  assert.deepEqual(recordCommand("r.wav", 3, has(["rec"])), { cmd: "rec", args: ["-q", "-c", "1", "-r", "16000", "r.wav", "trim", "0", "3"] });
  assert.equal(recordCommand("r.wav", 3, has([])), undefined);
  assert.deepEqual(playerCommand("a.mp3", has(["afplay"])), ["afplay", ["a.mp3"]]);
  assert.deepEqual(playerCommand("a.mp3", has(["ffplay"]))?.[0], "ffplay");
  assert.equal(playerCommand("a.mp3", has([])), undefined);
});

test("通知脚本：标题与正文经参数传入，不拼进脚本", () => {
  assert.match(NOTIFY_JXA, /JSON\.parse\(argv\[0\]\)/);
  assert.doesNotMatch(NOTIFY_JXA, /\$\{/);
  const shown: unknown[] = [];
  const app = { includeStandardAdditions: false, displayNotification: (t: string, o: unknown) => shown.push([t, o]) };
  const fn = new Function("Application", `${NOTIFY_JXA}; return run;`)({ currentApplication: () => app });
  assert.equal(fn([JSON.stringify({ title: `配对 "码"`, text: "ABCD-EFGH'); do shell script(\"x" })]), "ok");
  assert.deepEqual(shown, [["ABCD-EFGH'); do shell script(\"x", { withTitle: `配对 "码"`, subtitle: "Quetzal" }]]);
});

test("网络变化：scutil 监听主网络与网卡地址，只认变化通知", () => {
  assert.match(SCUTIL_WATCH, /n\.add State:\/Network\/Global\/IPv4\n/);
  assert.match(SCUTIL_WATCH, /n\.add State:\/Network\/Interface\/\[\^\/\]\+\/IPv4 pattern\n/);
  assert.match(SCUTIL_WATCH, /n\.watch\n$/);
  assert.equal(scutilChanged("notification callback (store address = 0x7f9).\n  changed key [0] = State:/Network/Global/IPv4\n"), true);
  assert.equal(scutilChanged("> "), false);
});

test("launchctl：print 的运行状态与 print-disabled 的停用标记", () => {
  const print = `gui/501/${LABEL} = {\n\tactive count = 1\n\tpath = /Users/u/Library/LaunchAgents/${LABEL}.plist\n\ttype = LaunchAgent\n\tstate = running\n\n\tprogram = /bin/sh\n\tpid = 4242\n}`;
  assert.deepEqual(parsePrint(print), { running: true, pid: 4242 });
  assert.deepEqual(parsePrint(print.replace("state = running", "state = not running").replace("\tpid = 4242\n", "")), { running: false, pid: undefined });
  assert.equal(isDisabled(`disabled services = {\n\t"${LABEL}" => disabled\n\t"com.example.other" => enabled\n}`), true);
  assert.equal(isDisabled(`disabled services = {\n\t"${LABEL}" => true\n}`), true, "旧系统写 true");
  assert.equal(isDisabled(`disabled services = {\n\t"${LABEL}" => enabled\n}`), false);
  assert.equal(isDisabled(`disabled services = {\n\t"xyz.quetzal.runtimeX" => disabled\n}`), false, "标签要完全一致");
});

test("升级：bash 在新会话里运行（脱离 launchd 代理的进程组），不等它", () => {
  let got: { cmd: string; args: string[]; opts: any } | undefined;
  let unref = false;
  const fake = ((cmd: string, args: string[], opts: any) => { got = { cmd, args, opts }; return { unref: () => { unref = true; } }; }) as any;
  detachUpgrade("echo hi", fake);
  assert.equal(got!.cmd, "/bin/bash");
  assert.deepEqual(got!.args, ["-c", "echo hi"]);
  assert.equal(got!.opts.detached, true);
  assert.equal(got!.opts.stdio, "ignore");
  assert.match(got!.opts.env.PATH, /\/opt\/homebrew\/bin/);
  assert.equal(unref, true);
});

test("适配器的工具与 hands 方法齐全", async () => {
  const { default: adapter } = await import("../adapters/macos/index.ts");
  assert.equal(adapter.name, "macos");
  assert.deepEqual(adapter.tools!.map((t) => t.name), ["take_photo", "record_audio", "screenshot", "clipboard", "open"]);
  const h = adapter.hands as unknown as Record<string, unknown>;
  for (const m of ["screenshot", "describeScreen", "tap", "swipe", "type", "openApp", "elements", "click", "doubleClick", "rightClick", "longPress", "drag", "scroll", "key", "windows", "focusWindow"]) assert.equal(typeof h[m], "function", m);
  assert.ok(adapter.supervision && adapter.upgrade && adapter.upgradeStatus && adapter.onNetworkChange && adapter.deviceId);
});
