// Linux 身体适配器：电池与温度按 /sys 条目挑选，桌面工具按可用程序挑选；没有任何工具的机器上不崩溃。
import { test } from "node:test";
import assert from "node:assert/strict";
import { pickBattery, pickThermal, prettyName, playerCommand, screenshotCommand, clipboardCommand, recordCommand } from "../adapters/linux/linux.ts";

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
