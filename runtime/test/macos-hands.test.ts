// macOS 的 hands：JXA 脚本的生成与逻辑（在 Node 里换上假的 ObjC / $ / Application 运行同一段脚本，核对发出的 CGEvent 与 System Events 调用）、
// 截图像素与系统的点之间的换算（Retina）、AX 角色映射、按键、cliclick 参数、权限报错的识别与说明、权限不够时不动手。
// 这台测试机不一定是 Mac，不调用 osascript。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  MOUSE_JXA, ELEMENTS_JXA, WINDOWS_JXA, FOCUS_JXA, KEY_JXA, PERMISSIONS_JXA, SCREEN_JXA,
  keyArgs, typeVia, cliclickArgs, mapRole, toElement, toPoints, toPixels, sipsSize, osaPermission, permissionHelp, createHands, SETTINGS, type Exec, type Geometry,
} from "../adapters/macos/hands.ts";

/** 把一段 JXA 当普通 JS 运行：globals 是脚本能看到的 ObjC、$、Application、delay。 */
function jxa(src: string, globals: Record<string, unknown>) {
  const names = Object.keys(globals);
  return new Function(...names, `${src}; return run;`)(...names.map((n) => globals[n])) as (argv?: string[]) => string;
}

/** 假的 CoreGraphics：记下每个事件（类型、坐标、按键、点击次数）。 */
function fakeCG() {
  const posted: { type: number | string; x?: number; y?: number; button?: number; clicks?: number; dy?: number; dx?: number }[] = [];
  const $ = {
    CGPointMake: (x: number, y: number) => ({ x, y }),
    CGEventCreateMouseEvent: (_s: unknown, type: number, p: { x: number; y: number }, button: number) => ({ type, x: p.x, y: p.y, button, clicks: 0 }),
    CGEventSetIntegerValueField: (e: any, field: number, v: number) => { assert.equal(field, 1); e.clicks = v; },
    CGEventCreateScrollWheelEvent2: (_s: unknown, unit: number, count: number, dy: number, dx: number) => { assert.equal(unit, 1); assert.equal(count, 2); return { type: "scroll", dy, dx }; },
    CGEventPost: (tap: number, e: any) => { assert.equal(tap, 0); posted.push(e); },
  };
  return { posted, globals: { ObjC: { import: () => {} }, $, delay: () => {} } };
}

test("鼠标 JXA：单击、双击（点击次数递增）、右键、中键、长按、拖拽、滚动发出的 CGEvent", () => {
  const ops = (arg: Record<string, unknown>) => { const cg = fakeCG(); assert.equal(jxa(MOUSE_JXA, cg.globals)([JSON.stringify(arg)]), "ok"); return cg.posted; };
  const t = (p: { type: number | string }[]) => p.map((e) => e.type);
  assert.deepEqual(t(ops({ op: "click", x: 10, y: 20 })), [5, 1, 2]);
  const dbl = ops({ op: "click", x: 10, y: 20, count: 2 });
  assert.deepEqual(t(dbl), [5, 1, 2, 1, 2]);
  assert.deepEqual(dbl.map((e) => e.clicks), [0, 1, 1, 2, 2]);
  const right = ops({ op: "click", x: 1, y: 2, button: "right" });
  assert.deepEqual(t(right), [5, 3, 4]);
  assert.deepEqual(right.slice(1).map((e) => e.button), [1, 1]);
  const mid = ops({ op: "click", x: 1, y: 2, button: "middle" });
  assert.deepEqual([t(mid), mid[1].button], [[5, 25, 26], 2]);
  assert.deepEqual(t(ops({ op: "click", x: 1, y: 2, hold: 500 })), [5, 1, 2]);
  const drag = ops({ op: "drag", x: 0, y: 0, x2: 100, y2: 50 });
  assert.equal(drag[1].type, 1);
  assert.equal(drag.filter((e) => e.type === 6).length, 20, "按住移动 20 步");
  assert.deepEqual([drag.at(-1)!.type, drag.at(-1)!.x, drag.at(-1)!.y], [2, 100, 50]);
  const sc = ops({ op: "scroll", x: 5, y: 5, dx: 0, dy: 3 });
  assert.deepEqual(sc.at(-1), { type: "scroll", dy: -3, dx: -0 }, "dy 正数向下：滚轮值取反");
});

test("界面元素 JXA：前台窗口深度优先遍历，限数量与深度；读不到的元素跳过；带窗口标题与状态", () => {
  const el = (props: Record<string, unknown>, kids: unknown[] = [], broken = false) => ({ properties: () => { if (broken) throw new Error("x"); return props; }, uiElements: () => kids, name: () => props.title });
  const button = el({ role: "AXButton", name: "确定", position: [100, 200], size: [80, 30], enabled: true, focused: true });
  const field = el({ role: "AXTextField", description: "搜索", value: "你好", position: [10, 10], size: [200, 24] });
  const win = el({ role: "AXWindow", title: "文稿", position: [0, 0], size: [800, 600] }, [button, el({}, [], true), field]);
  const proc = { name: () => "TextEdit", bundleIdentifier: () => "com.apple.TextEdit", windows: () => [win] };
  const se = { applicationProcesses: { whose: (q: unknown) => { assert.deepEqual(q, { frontmost: true }); return () => [proc]; } } };
  const run = jxa(ELEMENTS_JXA, { Application: (n: string) => { assert.equal(n, "System Events"); return se; } });
  const r = JSON.parse(run([JSON.stringify({ max: 10, depth: 5 })]));
  assert.deepEqual([r.app, r.bundle, r.window], ["TextEdit", "com.apple.TextEdit", "文稿"]);
  assert.deepEqual(r.items.map((i: any) => [i.role, i.name, i.depth]), [["AXWindow", "文稿", 0], ["AXButton", "确定", 1], ["AXTextField", "搜索", 1]]);
  assert.equal(r.items[1].focused, true);
  assert.equal(r.items[2].value, "你好");
  assert.equal(JSON.parse(run([JSON.stringify({ max: 2, depth: 5 })])).items.length, 2, "数量上限");
  assert.equal(JSON.parse(run([JSON.stringify({ max: 10, depth: 0 })])).items.length, 1, "深度上限");
  const none = jxa(ELEMENTS_JXA, { Application: () => ({ applicationProcesses: { whose: () => () => [] } }) });
  assert.deepEqual(JSON.parse(none([JSON.stringify({ max: 10, depth: 5 })])), { app: "", bundle: "", window: "", items: [] });
});

test("窗口 JXA 与切换窗口 JXA：按 pid 找应用、按序号找窗口，取消最小化、AXRaise、设为前台", () => {
  const done: string[] = [];
  const mk = (title: string, mini: boolean) => ({
    name: () => title, properties: () => ({ name: title, position: [1, 2], size: [3, 4] }),
    attributes: { byName: (n: string) => ({ get value() { return () => mini; }, set value(v: unknown) { done.push(`${title}:${n}=${v}`); } }) },
    actions: { byName: (n: string) => ({ perform: () => done.push(`${title}:${n}`) }) },
  });
  const proc: any = { name: () => "Safari", unixId: () => 321, frontmost: () => true, windows: () => [mk("首页", false), mk("文档", true)] };
  const se = { applicationProcesses: { whose: (q: any) => () => ("unixId" in q ? (q.unixId === 321 ? [proc] : []) : [proc]) } };
  const list = JSON.parse(jxa(WINDOWS_JXA, { Application: () => se })());
  assert.deepEqual(list.map((w: any) => [w.app, w.pid, w.title, w.index, w.minimized]), [["Safari", 321, "首页", 0, false], ["Safari", 321, "文档", 1, true]]);
  const focus = jxa(FOCUS_JXA, { Application: () => se });
  assert.equal(focus([JSON.stringify({ pid: 321, index: 1 })]), "ok");
  assert.deepEqual(done, ["文档:AXMinimized=false", "文档:AXRaise"]);
  assert.equal(proc.frontmost, true);
  assert.throws(() => focus([JSON.stringify({ pid: 999, index: 0 })]), /gone/);
});

test("按键 JXA：key code 与 keystroke，修饰键经 using 传入；meta 是 Command", () => {
  const calls: unknown[] = [];
  const se = { keyCode: (c: number, o: unknown) => calls.push(["code", c, o]), keystroke: (t: string, o: unknown) => calls.push(["text", t, o]) };
  const run = jxa(KEY_JXA, { Application: () => se });
  run([JSON.stringify(keyArgs(["meta", "shift", "t"]))]);
  run([JSON.stringify(keyArgs(["enter"]))]);
  run([JSON.stringify({ text: "hello", mods: [] })]);
  assert.deepEqual(calls, [["text", "t", { using: ["command down", "shift down"] }], ["code", 36, {}], ["text", "hello", {}]]);
});

test("权限与屏幕几何 JXA", () => {
  const run = jxa(PERMISSIONS_JXA, { ObjC: { import: () => {} }, $: { AXIsProcessTrusted: () => false, CGPreflightScreenCaptureAccess: () => true } });
  assert.deepEqual(JSON.parse(run()), { accessibility: false, screen: true });
  const old = jxa(PERMISSIONS_JXA, { ObjC: { import: () => {} }, $: { AXIsProcessTrusted: () => true } });
  assert.deepEqual(JSON.parse(old()), { accessibility: true, screen: true }, "没有 CGPreflightScreenCaptureAccess 的旧系统不需要屏幕录制权限");
  const $ = { CGMainDisplayID: () => 1, CGDisplayBounds: () => ({ origin: { x: 0, y: 0 }, size: { width: 1440, height: 900 } }), CGDisplayCopyDisplayMode: () => ({}), CGDisplayModeGetPixelWidth: () => 2880, CGDisplayModeGetPixelHeight: () => 1800 };
  assert.deepEqual(JSON.parse(jxa(SCREEN_JXA, { ObjC: { import: () => {} }, $ })()), { x: 0, y: 0, w: 1440, h: 900, pw: 2880, ph: 1800 });
});

test("JXA 脚本不用新语法（老的 JavaScriptCore 也能跑），数据只经 argv 传入", () => {
  for (const s of [MOUSE_JXA, ELEMENTS_JXA, WINDOWS_JXA, FOCUS_JXA, KEY_JXA, PERMISSIONS_JXA, SCREEN_JXA]) {
    assert.doesNotMatch(s, /\?\.|\?\?|`/, "不用可选链、空值合并与模板字符串");
    new Function(s); // 语法正确
  }
});

test("坐标：截图像素与系统的点互换（Retina 两倍、主显示器原点）", () => {
  const retina: Geometry = { x: 0, y: 0, w: 1440, h: 900, pw: 2880, ph: 1800 };
  assert.deepEqual(toPoints(retina, { x: 200, y: 100 }), { x: 100, y: 50 });
  assert.deepEqual(toPixels(retina, 100, 50), { x: 200, y: 100 });
  const plain: Geometry = { x: 0, y: 0, w: 1920, h: 1080, pw: 1920, ph: 1080 };
  assert.deepEqual(toPoints(plain, { x: 7, y: 9 }), { x: 7, y: 9 });
});

test("AX 角色映射与元素转换：坐标换成像素、看不见的不要、密码框不给值、复选框给 checked", () => {
  assert.equal(mapRole("AXButton"), "button");
  assert.equal(mapRole("AXCheckBox", "AXSwitch"), "switch");
  assert.equal(mapRole("AXRadioButton", "AXTabButton"), "tab");
  assert.equal(mapRole("AXTextField", "AXSecureTextField"), "input");
  assert.equal(mapRole("AXStaticText"), "text");
  assert.equal(mapRole("AXPopUpButton"), "combobox");
  assert.equal(mapRole("AXMenuBarItem"), "menuitem");
  assert.equal(mapRole("AXRow"), "item");
  assert.equal(mapRole("AXScrollArea"), "scroll");
  assert.equal(mapRole("AXUnknownThing"), "other");
  const g: Geometry = { x: 0, y: 0, w: 1440, h: 900, pw: 2880, ph: 1800 };
  assert.deepEqual(toElement({ role: "AXButton", name: "确定", x: 100, y: 200, w: 80, h: 30, focused: true }, g), { role: "button", x: 200, y: 400, w: 160, h: 60, name: "确定", clickable: true, focused: true });
  assert.equal(toElement({ role: "AXTextField", sub: "AXSecureTextField", value: "hunter2", x: 0, y: 0, w: 10, h: 10 }, g)!.value, undefined, "密码框的内容不给");
  assert.deepEqual(toElement({ role: "AXTextField", value: "你好", x: 0, y: 0, w: 10, h: 10, enabled: false }, g), { role: "input", x: 0, y: 0, w: 20, h: 20, value: "你好", editable: true, enabled: false });
  assert.equal(toElement({ role: "AXCheckBox", value: "1", x: 0, y: 0, w: 10, h: 10 }, g)!.checked, true);
  assert.equal(toElement({ role: "AXGroup", x: 0, y: 0, w: 0, h: 0 }, g), undefined, "没有大小的不要");
  assert.equal(toElement({ role: "AXGroup" }, g), undefined);
});

test("按键：修饰键在前、最后一个是主键；不支持的键说明原因", () => {
  assert.deepEqual(keyArgs(["meta", "c"]), { text: "c", mods: ["command down"] });
  assert.deepEqual(keyArgs(["ctrl", "alt", "delete"]), { code: 117, mods: ["control down", "option down"] });
  assert.deepEqual(keyArgs(["backspace"]), { code: 51, mods: [] });
  assert.deepEqual(keyArgs(["esc"]), { code: 53, mods: [] });
  assert.deepEqual(keyArgs(["f20"]), { code: 90, mods: [] });
  assert.deepEqual(keyArgs(["/"]), { text: "/", mods: [] });
  assert.throws(() => keyArgs(["f22"]), /Mac 键盘没有 f22/);
  assert.throws(() => keyArgs(["back"]), /手机上的动作/);
  assert.throws(() => keyArgs(["shift"]), /主键/);
  assert.throws(() => keyArgs(["c", "v"]), /不是修饰键/);
  assert.throws(() => keyArgs([]), /为空/);
});

test("输入方式、cliclick 参数与 sips 尺寸", () => {
  assert.equal(typeVia("hello world\n"), "keystroke");
  assert.equal(typeVia("你好"), "paste");
  assert.equal(typeVia("ok 👍"), "paste");
  assert.deepEqual(cliclickArgs(10.4, 20.6), ["c:10,21"]);
  assert.deepEqual(cliclickArgs(-100, 5, { count: 2 }), ["dc:=-100,5"]);
  assert.deepEqual(cliclickArgs(1, 2, { button: "right" }), ["rc:1,2"]);
  assert.equal(cliclickArgs(1, 2, { holdMs: 800 }), undefined, "长按走 CGEvent");
  assert.equal(cliclickArgs(1, 2, { button: "middle" }), undefined);
  assert.deepEqual(sipsSize("/tmp/a.png\n  pixelWidth: 2880\n  pixelHeight: 1800\n"), { width: 2880, height: 1800 });
  assert.equal(sipsSize("nothing"), undefined);
});

test("权限报错的识别与说明：说清去系统设置哪里、给谁授权", () => {
  assert.equal(osaPermission("execution error: Not authorized to send Apple events to System Events. (-1743)"), "automation");
  assert.equal(osaPermission("System Events got an error: osascript is not allowed assistive access. (-1719)"), "accessibility");
  assert.equal(osaPermission("syntax error"), undefined);
  const h = permissionHelp("accessibility", "/opt/node/bin/node");
  assert.match(h, /系统设置 › 隐私与安全性 › 辅助功能/);
  assert.match(h, /\/opt\/node\/bin\/node/);
  assert.match(permissionHelp("screen", "/n"), /屏幕/);
  assert.match(permissionHelp("automation", "/n"), /System Events/);
  assert.match(SETTINGS.accessibility, /^x-apple\.systempreferences:.*Privacy_Accessibility$/);
});

/** 假的 osascript / screencapture / sips / open：按脚本内容回应（Retina 屏），记下每次调用。 */
function fakeExec(perm = { accessibility: true, screen: true }) {
  const calls: { cmd: string; args: string[] }[] = [];
  const exec: Exec = async (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === "osascript") {
      const src = args[3];
      if (src === PERMISSIONS_JXA) return { code: 0, out: JSON.stringify(perm), err: "" };
      if (src === SCREEN_JXA) return { code: 0, out: JSON.stringify({ x: 0, y: 0, w: 1440, h: 900, pw: 2880, ph: 1800 }), err: "" };
      if (src === WINDOWS_JXA) return { code: 0, out: JSON.stringify([{ app: "Safari", pid: 7, front: true, index: 0, title: "首页", x: 0, y: 25, w: 1200, h: 800 }, { app: "Notes", pid: 8, front: false, index: 0, title: "清单", minimized: true }]), err: "" };
      if (src === ELEMENTS_JXA) return { code: 0, out: JSON.stringify({ app: "Safari", bundle: "com.apple.Safari", window: "首页", items: [{ role: "AXButton", name: "后退", x: 10, y: 10, w: 20, h: 20, depth: 1 }, { role: "AXGroup", depth: 1 }] }), err: "" };
      return { code: 0, out: "ok", err: "" };
    }
    if (cmd === "screencapture") { fs.writeFileSync(args.at(-1)!, "png"); return { code: 0, out: "", err: "" }; }
    if (cmd === "sips" && args[0] === "-g") return { code: 0, out: `${args.at(-1)}\n  pixelWidth: 2880\n  pixelHeight: 1800\n`, err: "" };
    return { code: 0, out: "", err: "" };
  };
  return { calls, exec };
}
const lastArg = (calls: { cmd: string; args: string[] }[], src: string) => JSON.parse(calls.filter((c) => c.args[3] === src).at(-1)!.args[4]);

test("hands：坐标按 Retina 换算成点；截图返回屏幕像素并按 maxEdge 缩小；元素、窗口、滚动、按键、打开应用", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "quetzal-mac-hands-"));
  const { calls, exec } = fakeExec();
  const PATH = process.env.PATH; process.env.PATH = "/nonexistent"; // 没有 cliclick
  try {
    const h = createHands({ exec, mediaFile: (n) => path.join(dir, n), node: "/n", openSettings: () => {} });
    const st = await h.status();
    assert.deepEqual([st.ready, st.screenshot, st.tree, st.input], [true, true, true, true]);
    await h.click({ x: 200, y: 100 });
    assert.deepEqual(lastArg(calls, MOUSE_JXA), { op: "click", x: 100, y: 50, button: "left", count: 1, hold: 0 });
    await h.click({ x: 20, y: 40 }, { button: "right", count: 2, holdMs: 900 });
    assert.deepEqual(lastArg(calls, MOUSE_JXA), { op: "click", x: 10, y: 20, button: "right", count: 2, hold: 900 });
    const shot = await h.screenshot(1280);
    assert.ok(shot.file.startsWith(dir) && shot.file.endsWith(".png"));
    assert.deepEqual([shot.width, shot.height], [2880, 1800], "缩小之前的屏幕像素");
    assert.deepEqual(calls.find((c) => c.cmd === "screencapture")!.args.slice(0, 4), ["-x", "-t", "png", "-m"]);
    assert.deepEqual(calls.find((c) => c.cmd === "sips" && c.args[0] === "-Z")!.args, ["-Z", "1280", shot.file, "--out", shot.file]);
    const snap = await h.snapshot();
    assert.deepEqual([snap.width, snap.height, snap.app, snap.window], [2880, 1800, "Safari（com.apple.Safari）", "首页"]);
    assert.deepEqual(snap.elements, [{ role: "button", x: 20, y: 20, w: 40, h: 40, name: "后退", clickable: true }]);
    const wins = await h.windows!();
    assert.deepEqual(wins[0], { id: "7:0", title: "首页", app: "Safari", focused: true, x: 0, y: 50, w: 2400, h: 1600 });
    assert.deepEqual(wins[1], { id: "8:0", title: "清单（已最小化）", app: "Notes", focused: false });
    await h.focusWindow!("8:0");
    assert.deepEqual(lastArg(calls, FOCUS_JXA), { pid: 8, index: 0 });
    await assert.rejects(h.focusWindow!("Notes"), /没有这个窗口/);
    await h.key(["meta", "w"]);
    assert.deepEqual(lastArg(calls, KEY_JXA), { text: "w", mods: ["command down"] });
    await h.scroll("down", 3);
    assert.deepEqual(lastArg(calls, MOUSE_JXA), { op: "scroll", x: 720, y: 450, dx: 0, dy: 3 }, "缺省在屏幕中央");
    await h.scroll("left", 2, { x: 20, y: 20 });
    assert.deepEqual(lastArg(calls, MOUSE_JXA), { op: "scroll", x: 10, y: 10, dx: -2, dy: 0 });
    await h.drag({ x: 0, y: 0 }, { x: 200, y: 200 }, 500);
    assert.deepEqual(lastArg(calls, MOUSE_JXA), { op: "drag", x: 0, y: 0, x2: 100, y2: 100, ms: 500 });
    await h.type("hi", { x: 2, y: 2 });
    assert.deepEqual(lastArg(calls, KEY_JXA), { text: "hi", mods: [] });
    assert.equal(await h.openApp("com.apple.Safari"), "已打开 com.apple.Safari");
    await h.openApp("Visual Studio Code");
    assert.deepEqual(calls.filter((c) => c.cmd === "open").map((c) => c.args), [["-b", "com.apple.Safari"], ["-a", "Visual Studio Code"]]);
    await assert.rejects(h.openApp("/Applications/Evil.app"), /不收路径/);
    await assert.rejects(h.openApp("https://example.com"), /不收路径与网址/);
    await assert.rejects(h.click({ x: Number.NaN, y: 1 }), /数字/);
  } finally { process.env.PATH = PATH; }
});

test("hands：没有辅助功能 / 屏幕录制权限时不动手，说明去哪里开，并只打开一次设置页；status 如实报告", async () => {
  const { calls, exec } = fakeExec({ accessibility: false, screen: false });
  const opened: string[] = [];
  const h = createHands({ exec, node: "/opt/node", openSettings: (k) => opened.push(k) });
  const st = await h.status();
  assert.equal(st.ready, false);
  assert.match(st.reason!, /辅助功能[\s\S]*屏幕录制/);
  await assert.rejects(h.click({ x: 1, y: 2 }), /辅助功能[\s\S]*\/opt\/node[\s\S]*已在这台 Mac 上打开了那一页/);
  await assert.rejects(h.key(["enter"]), /辅助功能/);
  await assert.rejects(h.screenshot(), /屏幕录制/);
  assert.deepEqual(opened, ["accessibility", "screen"]);
  assert.equal(calls.filter((c) => c.args[3] === MOUSE_JXA || c.args[3] === KEY_JXA || c.cmd === "screencapture").length, 0, "没有发出任何事件");
});

test("hands：没有图形登录会话时如实说明；System Events 没有自动化授权（-1743）时说明", async () => {
  const off = createHands({ exec: fakeExec().exec, gui: () => false });
  assert.equal((await off.status()).ready, false);
  await assert.rejects(off.click({ x: 1, y: 1 }), /没有人登录图形界面/);
  const exec: Exec = async (_cmd, args) => args[3] === PERMISSIONS_JXA ? { code: 0, out: JSON.stringify({ accessibility: true, screen: true }), err: "" }
    : args[3] === SCREEN_JXA ? { code: 0, out: JSON.stringify({ x: 0, y: 0, w: 10, h: 10, pw: 10, ph: 10 }), err: "" }
    : { code: 1, out: "", err: "execution error: Not authorized to send Apple events to System Events. (-1743)" };
  const h = createHands({ exec, node: "/n", openSettings: () => {} });
  await assert.rejects(h.windows!(), /自动化[\s\S]*System Events/);
});
