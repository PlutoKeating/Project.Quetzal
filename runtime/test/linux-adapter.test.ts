// Linux 身体适配器：电池与温度按 /sys 条目挑选，桌面工具按可用程序挑选；没有任何工具的机器上不崩溃。
import { test } from "node:test";
import assert from "node:assert/strict";
import { pickBattery, pickThermal, prettyName, playerCommand, screenshotCommand, clipboardCommand, recordCommand } from "../adapters/linux/linux.ts";
import { hasRebootLine, withRebootLine, DROPIN_OFF } from "../adapters/linux/supervise.ts";
import { upgradeShell, detachCommand, parseUpgradeLog } from "../adapters/linux/upgrade.ts";

test("挑出整机电池，跳过蓝牙鼠标之类的外设电池", () => {
  assert.equal(pickBattery([{ name: "ADP0", type: "Mains" }, { name: "hidpp_battery_7", type: "Battery", scope: "Device" }, { name: "BAT0", type: "Battery" }]), "BAT0");
  assert.equal(pickBattery([{ name: "axp20x-battery", type: "Battery" }, { name: "axp20x-usb", type: "USB" }]), "axp20x-battery");
  assert.equal(pickBattery([{ name: "AC", type: "Mains" }, { name: "hidpp_battery_0", type: "Battery", scope: "Device" }]), undefined);
});

test("挑出代表机器体温的热区；解析发行版名字", () => {
  assert.equal(pickThermal([{ name: "thermal_zone0", type: "INT3400 Thermal" }, { name: "thermal_zone1", type: "x86_pkg_temp" }]), "thermal_zone1");
  assert.equal(pickThermal([{ name: "thermal_zone0", type: "cpu-thermal" }]), "thermal_zone0");
  assert.equal(pickThermal([{ name: "thermal_zone0", type: "iwlwifi_1" }]), "thermal_zone0");
  assert.equal(prettyName('NAME="Ubuntu"\nPRETTY_NAME="Ubuntu 24.04 LTS"\nID=ubuntu'), "Ubuntu 24.04 LTS");
  assert.equal(prettyName("ID=alpine"), undefined);
});

test("桌面工具按可用程序挑选", () => {
  const has = (set: string[]) => (c: string) => set.includes(c);
  assert.deepEqual(playerCommand("a.mp3", has(["paplay", "ffplay"])), ["paplay", ["a.mp3"]]);
  assert.equal(playerCommand("a.mp3", has(["aplay"])), undefined); // aplay 只认 WAV
  assert.deepEqual(playerCommand("a.wav", has(["aplay"])), ["aplay", ["-q", "a.wav"]]);
  assert.deepEqual(screenshotCommand("s.png", true, has(["scrot", "grim"])), ["grim", ["s.png"]]);
  assert.deepEqual(screenshotCommand("s.png", false, has(["scrot", "grim"])), ["scrot", ["-o", "s.png"]]);
  assert.deepEqual(clipboardCommand(false, true, has(["xclip"])), ["xclip", ["-selection", "clipboard", "-o"]]);
  assert.deepEqual(clipboardCommand(true, true, has(["wl-copy", "xclip"])), ["wl-copy", []]);
  assert.deepEqual(recordCommand("r.wav", 3, has(["pw-record"])), { cmd: "pw-record", args: ["r.wav"], limited: false });
  assert.equal(recordCommand("r.wav", 3, has([])), undefined);
});

test("什么工具都没有的机器上：初始化与采样不崩溃，工具给出可读的提示", async () => {
  process.env.PATH = "/nonexistent";
  delete process.env.DISPLAY; delete process.env.WAYLAND_DISPLAY;
  const { default: adapter } = await import("../adapters/linux/index.ts");
  await adapter.init!();
  assert.equal(adapter.name, "linux");
  assert.match(adapter.describe, /Linux/);
  assert.match(adapter.describe, /没有图形界面/);
  const s = await adapter.sample();
  if (s.battery) { assert.ok(s.battery.level >= 0 && s.battery.level <= 100); assert.equal(typeof s.battery.charging, "boolean"); }
  const names = adapter.tools!.map((t) => t.name);
  assert.deepEqual(names, ["take_photo", "record_audio", "screenshot", "clipboard", "open"]);
  assert.match(await adapter.tools!.find((t) => t.name === "screenshot")!.handler({}), /没有图形界面/);
  assert.match(await adapter.tools!.find((t) => t.name === "record_audio")!.handler({ seconds: 1 }), /需要/);
  await assert.rejects(adapter.playAudio!("x.mp3"), /播放器/);
  await adapter.stopAudio!();
});

test("守护开关：crontab 的 @reboot 行增删不碰其他行；systemd 覆盖片段关闭自动重启", () => {
  const sup = "/home/u/quetzal/bin/quetzal-supervise";
  assert.equal(hasRebootLine("", sup), false);
  assert.equal(hasRebootLine(`0 * * * * backup\n@reboot ${sup}\n`, sup), true);
  assert.equal(withRebootLine("0 * * * * backup\n", sup, true), `0 * * * * backup\n@reboot ${sup}\n`);
  assert.equal(withRebootLine(`0 * * * * backup\n@reboot ${sup}\n`, sup, false), "0 * * * * backup\n");
  assert.equal(withRebootLine(`@reboot ${sup}\n`, sup, false), "");
  assert.match(DROPIN_OFF, /\[Service\]\nRestart=no/);
});

test("没有 systemd 单元也没有守护循环的机器：守护开关不可用，不崩溃", async () => {
  process.env.XDG_CONFIG_HOME = "/nonexistent/config"; process.env.QUETZAL_HOME = "/nonexistent/quetzal";
  const { default: adapter } = await import("../adapters/linux/index.ts");
  const s = await adapter.supervision!.status();
  assert.equal(s.available, false);
  await assert.rejects(adapter.supervision!.set(true), /守护者/);
});

test("从控制台升级：命令下载安装脚本并写日志；有 systemd 用 systemd-run 脱离服务 cgroup，没有用 setsid", () => {
  const sh = upgradeShell("/h/quetzal/logs/upgrade.log");
  assert.match(sh, /curl -fsSL https:\/\/quetzal\.plutokeating\.beer\/install/);
  assert.match(sh, /bash -s -- --no-open/);
  assert.match(sh, /upgrade\.log/);
  const a = detachCommand(sh, true, "u1");
  assert.equal(a.cmd, "systemd-run"); assert.ok(a.args.includes("--unit=u1") && a.args.includes("--user"));
  const b = detachCommand(sh, false);
  assert.equal(b.cmd, "setsid"); assert.equal(b.args[0], "-f");
});

test("升级指定版本；日志里每次升级带编号，读得出进行中、成功、失败与最后一步", () => {
  const sh = upgradeShell("/h/l.log", undefined, "1.2.3", "100");
  assert.match(sh, /bash -s -- --no-open --version 1\.2\.3/);
  assert.match(sh, /== 升级 100 开始.*（目标 1\.2\.3）/);
  assert.match(sh, /pipefail/, "下载脚本失败也算失败");
  assert.doesNotMatch(upgradeShell("/h/l.log", undefined, "1.2.3; rm -rf /", "1"), /rm -rf/, "版本号不合格就不带");
  const t0 = 1_000_000;
  assert.deepEqual(parseUpgradeLog(""), { running: false });
  const started = `== 升级 ${t0} 开始 Tue（目标 1.2.3）\n◆ Runtime\n  ▸ Downloading @plutokeating/quetzal@1.2.3\n`;
  assert.deepEqual(parseUpgradeLog(started, t0 + 1000), { running: true, id: String(t0), startedAt: t0, target: "1.2.3", step: "Downloading @plutokeating/quetzal@1.2.3" });
  assert.equal(parseUpgradeLog(started, t0 + 16 * 60_000).stalled, true, "超过 15 分钟算卡住，不再挡着下一次");
  const failed = `${started}curl: (35) TLS connect error\n== 升级 ${t0} 退出码 35\n`;
  assert.deepEqual(parseUpgradeLog(failed, t0), { running: false, id: String(t0), startedAt: t0, target: "1.2.3", exitCode: 35, step: "curl: (35) TLS connect error" });
  // 只看最近一次；旧格式的记录不影响
  const two = `== Tue 从控制台发起升级\n== 退出码 0\n${failed}== 升级 ${t0 + 5} 开始 Tue\n  ✓ Native console in place\n== 升级 ${t0 + 5} 退出码 0\n`;
  const st = parseUpgradeLog(two, t0);
  assert.equal(st.exitCode, 0); assert.equal(st.target, undefined); assert.equal(st.step, "Native console in place");
});
