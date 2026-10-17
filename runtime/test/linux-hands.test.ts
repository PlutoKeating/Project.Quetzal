// Linux 的手：会话环境探测、按可用程序挑输入方式、xdotool / ydotool / wtype 的命令拼装、AT-SPI 与 wmctrl 输出解析、.desktop 查找、截图命令。
import { test } from "node:test";
import assert from "node:assert/strict";
import { sessionEnv, backend, clickCommands, dragCommands, scrollCommands, keyCommands, typeCommands, parseAtspi, parseWmctrl, parseDesktop, findDesktop, shotCommand, pictureSize, ATSPI_PY } from "../adapters/linux/hands.ts";

const has = (set: string[]) => (c: string) => set.includes(c);

test("会话环境：服务里没有 DISPLAY 时按 XDG_RUNTIME_DIR 与 /tmp/.X11-unix 补齐；什么都没有时返回 undefined", () => {
  const files: Record<string, string[]> = { "/run/user/1000": ["bus", "wayland-0", "wayland-0.lock", ".mutter-Xwaylandauth.ABC123"], "/tmp/.X11-unix": ["X0"] };
  const exists = (f: string) => f in files || ["/run/user/1000/bus", "/run/user/1000/.mutter-Xwaylandauth.ABC123"].includes(f);
  const env = sessionEnv({ env: { PATH: "/usr/bin" }, uid: 1000, home: "/home/u", ls: (d) => files[d] ?? [], exists })!;
  assert.equal(env.WAYLAND_DISPLAY, "wayland-0");
  assert.equal(env.DISPLAY, ":0");
  assert.equal(env.XAUTHORITY, "/run/user/1000/.mutter-Xwaylandauth.ABC123");
  assert.equal(env.DBUS_SESSION_BUS_ADDRESS, "unix:path=/run/user/1000/bus");
  assert.equal(env.XDG_RUNTIME_DIR, "/run/user/1000");
  const kept = sessionEnv({ env: { DISPLAY: ":1", XAUTHORITY: "/x" }, uid: 1000, home: "/h", ls: () => [], exists: () => false })!;
  assert.equal(kept.DISPLAY, ":1"); assert.equal(kept.XAUTHORITY, "/x");
  assert.equal(sessionEnv({ env: {}, uid: 1000, home: "/h", ls: () => [], exists: () => false }), undefined);
});

test("输入方式：X11 用 xdotool；Wayland 鼠标用 ydotool，键盘优先 wtype", () => {
  assert.deepEqual(backend(false, has(["xdotool", "ydotool"])), { mouse: "xdotool", keys: "xdotool" });
  assert.deepEqual(backend(false, has(["ydotool"])), {});
  assert.deepEqual(backend(true, has(["xdotool", "ydotool", "wtype"])), { mouse: "ydotool", keys: "wtype" });
  assert.deepEqual(backend(true, has(["ydotool"])), { mouse: "ydotool", keys: "ydotool" });
  assert.deepEqual(backend(true, has(["wtype"])), { mouse: undefined, keys: "wtype" });
});

test("xdotool：点击、双击、右键、长按、拖拽、滚动、按键、输入", () => {
  const x = { mouse: "xdotool", keys: "xdotool" } as const;
  assert.deepEqual(clickCommands(x, { x: 10.4, y: 20.6 }), [["xdotool", ["mousemove", "--sync", "10", "21", "click", "1"]]]);
  assert.deepEqual(clickCommands(x, { x: 1, y: 2 }, { count: 2 }), [["xdotool", ["mousemove", "--sync", "1", "2", "click", "--repeat", "2", "--delay", "80", "1"]]]);
  assert.deepEqual(clickCommands(x, { x: 1, y: 2 }, { button: "right" })[0][1].at(-1), "3");
  assert.deepEqual(clickCommands(x, { x: 1, y: 2 }, { holdMs: 800 }), [["xdotool", ["mousemove", "--sync", "1", "2", "mousedown", "1", "sleep", "0.80", "mouseup", "1"]]]);
  const drag = dragCommands(x, { x: 0, y: 0 }, { x: 80, y: 40 }, 400)[0][1];
  assert.deepEqual(drag.slice(0, 6), ["mousemove", "--sync", "0", "0", "mousedown", "1"]);
  assert.deepEqual(drag.slice(-6), ["mousemove", "--sync", "80", "40", "mouseup", "1"]);
  assert.deepEqual(scrollCommands(x, "down", 3, { x: 5, y: 6 }), [["xdotool", ["mousemove", "--sync", "5", "6", "click", "--repeat", "3", "--delay", "40", "5"]]]);
  assert.deepEqual(scrollCommands(x, "left", 1)[0][1].at(-1), "6");
  assert.deepEqual(keyCommands(x, ["ctrl", "shift", "t"]), [["xdotool", ["key", "--clearmodifiers", "ctrl+shift+t"]]]);
  assert.deepEqual(keyCommands(x, ["meta"]), [["xdotool", ["key", "--clearmodifiers", "super"]]]);
  assert.deepEqual(keyCommands(x, ["ctrl", "/"]), [["xdotool", ["key", "--clearmodifiers", "ctrl+slash"]]]);
  assert.deepEqual(keyCommands(x, ["pagedown"]), [["xdotool", ["key", "--clearmodifiers", "Next"]]]);
  assert.throws(() => keyCommands(x, ["back"]), /手机的按键/);
  assert.throws(() => keyCommands(x, ["ctrl", "é"]), /按不出来/);
  assert.deepEqual(typeCommands(x, "你好 -x"), { cmds: [["xdotool", ["type", "--clearmodifiers", "--delay", "12", "--", "你好 -x"]]] });
});

test("ydotool 与 wtype：绝对坐标、按键事件码、非 ASCII 文字经剪贴板粘贴", () => {
  const y = { mouse: "ydotool", keys: "ydotool" } as const;
  assert.deepEqual(clickCommands(y, { x: 100, y: 200 }), [["ydotool", ["mousemove", "--absolute", "-x", "100", "-y", "200"]], ["ydotool", ["click", "0xC0"]]]);
  assert.deepEqual(clickCommands(y, { x: 1, y: 1 }, { button: "right", count: 2 })[1], ["ydotool", ["click", "-r", "2", "-D", "80", "0xC1"]]);
  assert.deepEqual(clickCommands(y, { x: 1, y: 1 }, { holdMs: 500 }).slice(1), [["ydotool", ["click", "0x40"]], ["sleep", ["0.50"]], ["ydotool", ["click", "0x80"]]]);
  assert.deepEqual(scrollCommands(y, "down", 2), [["ydotool", ["mousemove", "--wheel", "-x", "0", "-y", "-2"]]]);
  assert.deepEqual(keyCommands(y, ["ctrl", "c"]), [["ydotool", ["key", "29:1", "46:1", "46:0", "29:0"]]]);
  assert.deepEqual(keyCommands(y, ["alt", "f4"]), [["ydotool", ["key", "56:1", "62:1", "62:0", "56:0"]]]);
  assert.deepEqual(typeCommands(y, "hello"), { cmds: [["ydotool", ["type", "--key-delay", "12", "--", "hello"]]] });
  assert.deepEqual(typeCommands(y, "你好", has(["wl-copy"])), { cmds: [["wl-copy", []], ["ydotool", ["key", "29:1", "47:1", "47:0", "29:0"]]], stdin: "你好" });
  assert.equal(typeCommands(y, "你好", has([])), undefined);
  const w = { keys: "wtype" } as const;
  assert.deepEqual(keyCommands(w, ["ctrl", "shift", "t"]), [["wtype", ["-M", "ctrl", "-M", "shift", "-k", "t", "-m", "shift", "-m", "ctrl"]]]);
  assert.deepEqual(keyCommands(w, ["enter"]), [["wtype", ["-k", "Return"]]]);
  assert.deepEqual(typeCommands(w, "你好"), { cmds: [["wtype", ["--", "你好"]]] });
  assert.deepEqual(clickCommands(w, { x: 1, y: 1 }), [], "没有鼠标输入：没有命令（由调用方说明）");
});

test("AT-SPI：脚本里有三种模式；输出解析成通用角色，密码框不给值", () => {
  for (const m of ['mode == "windows"', 'mode == "act"', "get_extents(Atspi.CoordType.SCREEN)"]) assert.ok(ATSPI_PY.includes(m));
  const out = JSON.stringify({ width: 1920, height: 1080, app: "gedit", window: "无标题文档", windows: 3, elements: [
    { r: "push button", n: "保存", v: "", b: [10, 20, 80, 30], p: "2.0.1.4", c: true, e: false, en: true, f: false, s: false, k: null },
    { r: "text", n: "", v: "正文", b: [0, 60, 1900, 900], p: "2.0.2", c: false, e: true, en: true, f: true, s: false, k: null },
    { r: "label", n: "第 1 行", v: "", b: [0, 1000, 100, 20], p: "2.0.3", c: false, e: false, en: true, f: false, s: false, k: null },
    { r: "password text", n: "密码", v: "secret", b: [0, 0, 10, 10], p: "2.0.4", c: false, e: true, en: true, f: false, s: false, k: null },
    { r: "check box", n: "自动换行", v: "", b: [0, 0, 10, 10], p: "2.0.5", c: true, e: false, en: false, f: false, s: false, k: true },
  ] });
  const s = parseAtspi(`警告：无关的输出\n${out}`);
  assert.equal(s.width, 1920); assert.equal(s.app, "gedit"); assert.equal(s.windowCount, 3);
  assert.deepEqual(s.elements.map((e) => e.role), ["button", "input", "text", "input", "checkbox"]);
  assert.equal(s.elements[0].ref, "atspi:2.0.1.4");
  assert.equal(s.elements[0].clickable, true);
  assert.equal(s.elements[1].value, "正文");
  assert.equal(s.elements[3].value, undefined, "密码框的内容不交出去");
  assert.equal(s.elements[4].checked, true); assert.equal(s.elements[4].enabled, false);
  assert.deepEqual(parseAtspi('{"error":"noatspi"}').error, "noatspi");
});

test("wmctrl：解析窗口列表，跳过粘在所有桌面上的面板，主机名不交出去，标出前台窗口", () => {
  const out = "0x01e00003 -1 1234   gnome-panel.Gnome-panel  myhost 顶栏\n0x03a00003  0 2345   Navigator.firefox     myhost 新标签页 — Mozilla Firefox\n0x04000006  0 3456   gedit.Gedit  myhost \n";
  assert.deepEqual(parseWmctrl(out, 0x03a00003), [{ id: "0x03a00003", title: "新标签页 — Mozilla Firefox", app: "firefox", focused: true }, { id: "0x04000006", title: "", app: "Gedit" }]);
  assert.ok(!JSON.stringify(parseWmctrl(out)).includes("myhost"));
});

test(".desktop：只认应用；按 id、显示名（含本地化名）、包含查找", () => {
  const ff = parseDesktop("org.mozilla.firefox", "/a/firefox.desktop", "[Desktop Entry]\nType=Application\nName=Firefox\nName[zh_CN]=火狐浏览器\nGenericName=Web Browser\nExec=firefox %u\n[Desktop Action new]\nName=新窗口\n")!;
  assert.deepEqual(ff.names, ["Firefox", "火狐浏览器", "Web Browser"]);
  const set = parseDesktop("org.gnome.Settings", "/a/s.desktop", "[Desktop Entry]\nName=设置\nExec=gnome-control-center\n")!;
  const hidden = parseDesktop("settings-daemon", "/a/h.desktop", "[Desktop Entry]\nName=设置守护进程\nNoDisplay=true\n")!;
  assert.equal(parseDesktop("x", "/a/x.desktop", "[Desktop Entry]\nType=Link\nName=X\n"), undefined);
  const all = [hidden, ff, set];
  assert.equal(findDesktop("firefox", all)?.id, "org.mozilla.firefox");
  assert.equal(findDesktop("org.mozilla.firefox.desktop", all)?.id, "org.mozilla.firefox");
  assert.equal(findDesktop("火狐浏览器", all)?.id, "org.mozilla.firefox");
  assert.equal(findDesktop("设置", all)?.id, "org.gnome.Settings");
  assert.equal(findDesktop("settings", all)?.id, "org.gnome.Settings");
  assert.equal(findDesktop("守护", all), undefined, "隐藏的应用只在完全匹配时打开");
  assert.equal(findDesktop("不存在", all), undefined);
});

test("截图：能出 JPEG 的出 JPEG；读出 PNG / JPEG 的尺寸", () => {
  assert.deepEqual(shotCommand("/m/s", true, has(["grim", "scrot"])), { cmd: ["grim", ["-t", "jpeg", "-q", "85", "/m/s.jpg"]], file: "/m/s.jpg" });
  assert.deepEqual(shotCommand("/m/s", false, has(["grim", "scrot"])), { cmd: ["scrot", ["-o", "-q", "85", "/m/s.jpg"]], file: "/m/s.jpg" });
  assert.deepEqual(shotCommand("/m/s", true, has(["gnome-screenshot"]))?.file, "/m/s.png");
  assert.equal(shotCommand("/m/s", true, has(["scrot"])), undefined);
  const pngHead = Buffer.alloc(24); pngHead.writeUInt32BE(0x89504e47, 0); pngHead.writeUInt32BE(1920, 16); pngHead.writeUInt32BE(1080, 20);
  assert.deepEqual(pictureSize(pngHead), { width: 1920, height: 1080 });
  const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x04, 0, 0, 0xff, 0xc2, 0x00, 0x11, 0x08, 0x04, 0x38, 0x07, 0x80, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(pictureSize(jpg), { width: 1920, height: 1080 });
});
