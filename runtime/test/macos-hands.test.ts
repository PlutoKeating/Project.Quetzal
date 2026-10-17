// macOS 的 hands：JXA 脚本的生成与逻辑（在 Node 里换上假的 ObjC / $ / Application 运行同一段脚本，核对发出的 CGEvent 与 System Events 调用）、
// 按键组合解析、cliclick 参数、界面元素格式、权限报错的识别与说明、权限不够时不动手。这台测试机不一定是 Mac，不调用 osascript。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  MOUSE_JXA, ELEMENTS_JXA, WINDOWS_JXA, FOCUS_JXA, KEY_JXA, PERMISSIONS_JXA, SCREEN_JXA,
  parseKey, typeVia, cliclickArgs, formatElement, formatWindow, osaPermission, permissionHelp, createHands, SETTINGS, type Exec,
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

test("鼠标 JXA：单击、双击（点击次数 2）、右键、长按、拖拽、滚动发出的 CGEvent", () => {
  const ops = (arg: Record<string, unknown>) => { const cg = fakeCG(); assert.equal(jxa(MOUSE_JXA, cg.globals)([JSON.stringify(arg)]), "ok"); return cg.posted; };
  const t = (p: { type: number | string }[]) => p.map((e) => e.type);
  assert.deepEqual(t(ops({ op: "click", x: 10, y: 20 })), [5, 1, 2]);
  const dbl = ops({ op: "double", x: 10, y: 20 });
  assert.deepEqual(t(dbl), [5, 1, 2, 1, 2]);
  assert.deepEqual(dbl.map((e) => e.clicks), [0, 1, 1, 2, 2]);
  const right = ops({ op: "right", x: 1, y: 2 });
  assert.deepEqual(t(right), [5, 3, 4]);
  assert.deepEqual(right.slice(1).map((e) => e.button), [1, 1]);
  assert.deepEqual(t(ops({ op: "long", x: 1, y: 2, ms: 500 })), [5, 1, 2]);
  const drag = ops({ op: "drag", x: 0, y: 0, x2: 100, y2: 50 });
  assert.equal(drag[1].type, 1);
  assert.equal(drag.filter((e) => e.type === 6).length, 20, "按住移动 20 步");
  assert.deepEqual([drag.at(-1)!.type, drag.at(-1)!.x, drag.at(-1)!.y], [2, 100, 50]);
  const sc = ops({ op: "scroll", x: 5, y: 5, dx: 0, dy: 3 });
  assert.deepEqual(sc.at(-1), { type: "scroll", dy: -3, dx: -0 }, "dy 正数向下：滚轮值取反");
});

test("界面元素 JXA：前台应用的窗口深度优先遍历，限数量与深度；读不到的元素跳过", () => {
  const el = (props: Record<string, unknown>, kids: unknown[] = [], broken = false) => ({ properties: () => { if (broken) throw new Error("x"); return props; }, uiElements: () => kids });
  const button = el({ role: "AXButton", name: "确定", position: [100, 200], size: [80, 30], enabled: true });
  const field = el({ role: "AXTextField", description: "搜索", value: "你好", position: [10, 10], size: [200, 24] });
  const win = el({ role: "AXWindow", title: "文稿", position: [0, 0], size: [800, 600] }, [button, el({}, [], true), field]);
  const proc = { name: () => "TextEdit", bundleIdentifier: () => "com.apple.TextEdit", windows: () => [win] };
  const se = { applicationProcesses: { whose: (q: unknown) => { assert.deepEqual(q, { frontmost: true }); return () => [proc]; } } };
  const run = jxa(ELEMENTS_JXA, { Application: (n: string) => { assert.equal(n, "System Events"); return se; } });
  const r = JSON.parse(run([JSON.stringify({ max: 10, depth: 5 })]));
  assert.equal(r.app, "TextEdit");
  assert.equal(r.bundle, "com.apple.TextEdit");
  assert.deepEqual(r.items.map((i: any) => [i.role, i.name, i.depth]), [["AXWindow", "文稿", 0], ["AXButton", "确定", 1], ["AXTextField", "搜索", 1]]);
  assert.equal(r.items[2].value, "你好");
  assert.equal(JSON.parse(run([JSON.stringify({ max: 2, depth: 5 })])).items.length, 2, "数量上限");
  assert.equal(JSON.parse(run([JSON.stringify({ max: 10, depth: 0 })])).items.length, 1, "深度上限");
  const none = jxa(ELEMENTS_JXA, { Application: () => ({ applicationProcesses: { whose: () => () => [] } }) });
  assert.deepEqual(JSON.parse(none([JSON.stringify({ max: 10, depth: 5 })])), { app: "", bundle: "", items: [] });
});

test("窗口 JXA 与切换窗口 JXA：按 pid 找应用，按标题（退回序号）找窗口，取消最小化、AXRaise、设为前台", () => {
  const done: string[] = [];
  const mk = (title: string, mini: boolean) => {
    // attributes.byName(..).value 既要能调用（读）也要能赋值（写）：用 getter / setter
    return {
      name: () => title, properties: () => ({ name: title, position: [1, 2], size: [3, 4] }),
      attributes: { byName: (n: string) => ({ get value() { return () => mini; }, set value(v: unknown) { done.push(`${title}:${n}=${v}`); } }) },
      actions: { byName: (n: string) => ({ perform: () => done.push(`${title}:${n}`) }) },
    };
  };
  const proc: any = { name: () => "Safari", unixId: () => 321, frontmost: () => true, windows: () => [mk("首页", false), mk("文档", true)] };
  const se = { applicationProcesses: { whose: (q: any) => () => ("unixId" in q ? (q.unixId === 321 ? [proc] : []) : [proc]) } };
  const list = JSON.parse(jxa(WINDOWS_JXA, { Application: () => se })());
  assert.deepEqual(list.map((w: any) => [w.app, w.pid, w.title, w.index, w.minimized]), [["Safari", 321, "首页", 0, false], ["Safari", 321, "文档", 1, true]]);
  const focus = jxa(FOCUS_JXA, { Application: () => se });
  assert.equal(focus([JSON.stringify({ pid: 321, index: 0, title: "文档" })]), "ok");
  assert.deepEqual(done, ["文档:AXMinimized=false", "文档:AXRaise"]);
  assert.equal(proc.frontmost, true);
  assert.throws(() => focus([JSON.stringify({ pid: 999, index: 0, title: "x" })]), /gone/);
});

test("按键 JXA：key code 与 keystroke，修饰键经 using 传入", () => {
  const calls: unknown[] = [];
  const se = { keyCode: (c: number, o: unknown) => calls.push(["code", c, o]), keystroke: (t: string, o: unknown) => calls.push(["text", t, o]) };
  const run = jxa(KEY_JXA, { Application: () => se });
  run([JSON.stringify(parseKey("cmd+shift+t"))]);
  run([JSON.stringify(parseKey("enter"))]);
  run([JSON.stringify({ text: "hello", mods: [] })]);
  assert.deepEqual(calls, [["text", "t", { using: ["command down", "shift down"] }], ["code", 36, {}], ["text", "hello", {}]]);
});

test("权限与屏幕大小 JXA", () => {
  const run = jxa(PERMISSIONS_JXA, { ObjC: { import: () => {} }, $: { AXIsProcessTrusted: () => false, CGPreflightScreenCaptureAccess: () => true } });
  assert.deepEqual(JSON.parse(run()), { accessibility: false, screen: true });
  const old = jxa(PERMISSIONS_JXA, { ObjC: { import: () => {} }, $: { AXIsProcessTrusted: () => true } });
  assert.deepEqual(JSON.parse(old()), { accessibility: true, screen: true }, "没有 CGPreflightScreenCaptureAccess 的旧系统不需要屏幕录制权限");
  const size = jxa(SCREEN_JXA, { ObjC: { import: () => {} }, $: { CGMainDisplayID: () => 1, CGDisplayBounds: () => ({ size: { width: 1440, height: 900 } }) } });
  assert.deepEqual(JSON.parse(size()), { w: 1440, h: 900 });
});

test("JXA 脚本不用新语法（老的 JavaScriptCore 也能跑），数据只经 argv 传入", () => {
  for (const s of [MOUSE_JXA, ELEMENTS_JXA, WINDOWS_JXA, FOCUS_JXA, KEY_JXA, PERMISSIONS_JXA, SCREEN_JXA]) {
    assert.doesNotMatch(s, /\?\.|\?\?|`/, "不用可选链、空值合并与模板字符串");
    new Function(s); // 语法正确
  }
});

test("按键组合解析", () => {
  assert.deepEqual(parseKey("cmd+c"), { text: "c", mods: ["command down"] });
  assert.deepEqual(parseKey("Ctrl + Alt + Delete"), { code: 51, mods: ["control down", "option down"] });
  assert.deepEqual(parseKey("⌘+⇧+T"), { text: "t", mods: ["command down", "shift down"] });
  assert.deepEqual(parseKey("esc"), { code: 53, mods: [] });
  assert.deepEqual(parseKey("F5"), { code: 96, mods: [] });
  assert.deepEqual(parseKey("A"), { text: "A", mods: [] }, "没有修饰键时大小写原样");
  assert.throws(() => parseKey("cmd+shift"), /正好一个主键/);
  assert.throws(() => parseKey("cmd+a+b"), /正好一个主键/);
  assert.throws(() => parseKey("cmd+hello"), /不认识的键/);
  assert.throws(() => parseKey(""), /为空/);
});

test("输入方式：ASCII 直接按键，中文与表情经剪贴板粘贴", () => {
  assert.equal(typeVia("hello world\n"), "keystroke");
  assert.equal(typeVia("你好"), "paste");
  assert.equal(typeVia("ok 👍"), "paste");
});

test("cliclick 参数：取整，负坐标加 = 前缀；拖拽 dd/dm/du，长按 dd/w/du", () => {
  assert.deepEqual(cliclickArgs("click", 10.4, 20.6), ["c:10,21"]);
  assert.deepEqual(cliclickArgs("double", -100, 5), ["dc:=-100,5"]);
  assert.deepEqual(cliclickArgs("right", 1, 2), ["rc:1,2"]);
  assert.deepEqual(cliclickArgs("long", 1, 2, { ms: 900 }), ["dd:1,2", "w:900", "du:1,2"]);
  assert.deepEqual(cliclickArgs("drag", 0, 0, { x2: 30, y2: -40, ms: 400 }), ["-e", "20", "dd:0,0", "dm:30,=-40", "du:30,=-40"]);
  assert.deepEqual(cliclickArgs("move", 3, 4), ["m:3,4"]);
});

test("界面元素与窗口的一行：编号、角色、名称、值、中心坐标", () => {
  assert.equal(formatElement({ role: "AXButton", name: "确定", x: 100, y: 200, w: 80, h: 30, depth: 1 }, 3), "  [3] Button 「确定」 中心 (140, 215) 80×30");
  assert.equal(formatElement({ role: "AXTextField", name: "搜索", value: "你好", x: 0, y: 0, w: 10, h: 10, depth: 0, enabled: false }, 1), "[1] TextField 「搜索」 值=\"你好\" 中心 (5, 5) 10×10（不可用）");
  assert.equal(formatElement({ role: "AXGroup", name: "", depth: 2 }, 9), "    [9] Group");
  assert.equal(formatWindow({ app: "Safari", pid: 1, front: true, index: 0, title: "首页", x: 0, y: 25, w: 1200, h: 800 }, 1), "[1] Safari（前台） — 「首页」 位置 (0, 25) 1200×800");
});

test("权限报错的识别与说明：说清去系统设置哪里、给谁授权", () => {
  assert.equal(osaPermission("execution error: Not authorized to send Apple events to System Events. (-1743)"), "automation");
  assert.equal(osaPermission("System Events got an error: osascript is not allowed assistive access. (-1719)"), "accessibility");
  assert.equal(osaPermission("syntax error"), undefined);
  const h = permissionHelp("accessibility", "/opt/node/bin/node");
  assert.match(h, /辅助功能/);
  assert.match(h, /系统设置 › 隐私与安全性 › 辅助功能/);
  assert.match(h, /\/opt\/node\/bin\/node/);
  assert.match(permissionHelp("screen", "/n"), /屏幕/);
  assert.match(permissionHelp("automation", "/n"), /System Events/);
  assert.match(SETTINGS.accessibility, /^x-apple\.systempreferences:.*Privacy_Accessibility$/);
});

/** 假的 osascript / screencapture / sips / open：按脚本内容回应，记下每次调用。 */
function fakeExec(perm = { accessibility: true, screen: true }) {
  const calls: { cmd: string; args: string[] }[] = [];
  const exec: Exec = async (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === "osascript") {
      const src = args[3];
      if (src === PERMISSIONS_JXA) return { code: 0, out: JSON.stringify(perm), err: "" };
      if (src === SCREEN_JXA) return { code: 0, out: JSON.stringify({ w: 1440, h: 900 }), err: "" };
      if (src === WINDOWS_JXA) return { code: 0, out: JSON.stringify([{ app: "Safari", pid: 7, front: true, index: 0, title: "首页" }, { app: "Notes", pid: 8, front: false, index: 0, title: "清单" }]), err: "" };
      if (src === ELEMENTS_JXA) return { code: 0, out: JSON.stringify({ app: "Safari", bundle: "com.apple.Safari", items: [{ role: "AXButton", name: "后退", x: 10, y: 10, w: 20, h: 20, depth: 1 }] }), err: "" };
      return { code: 0, out: "ok", err: "" };
    }
    if (cmd === "screencapture") { fs.writeFileSync(args.at(-1)!, "png"); return { code: 0, out: "", err: "" }; }
    return { code: 0, out: "", err: "" };
  };
  return { calls, exec };
}

test("hands：权限够时，点击走 CGEvent（没有 cliclick）、截图缩放到点的尺寸、窗口按编号与标题切换", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "quetzal-mac-hands-"));
  const { calls, exec } = fakeExec();
  const PATH = process.env.PATH; process.env.PATH = "/nonexistent"; // 没有 cliclick
  try {
    const h = createHands({ exec, mediaFile: (n) => path.join(dir, n), node: "/n", openSettings: () => {} });
    await h.click(10, 20);
    const mouse = calls.find((c) => c.cmd === "osascript" && c.args[3] === MOUSE_JXA)!;
    assert.deepEqual(JSON.parse(mouse.args[4]), { op: "click", x: 10, y: 20 });
    assert.deepEqual(mouse.args.slice(0, 3), ["-l", "JavaScript", "-e"]);
    const f = await h.screenshot();
    assert.ok(f.startsWith(dir) && f.endsWith(".png"));
    assert.deepEqual(calls.find((c) => c.cmd === "screencapture")!.args.slice(0, 4), ["-x", "-t", "png", "-m"]);
    assert.deepEqual(calls.find((c) => c.cmd === "sips")!.args, ["--resampleWidth", "1440", f, "--out", f]);
    assert.match(await h.windows(), /\[2\] Notes — 「清单」/);
    await h.focusWindow(2);
    await h.focusWindow("首页");
    const focus = calls.filter((c) => c.args[3] === FOCUS_JXA).map((c) => JSON.parse(c.args[4]));
    assert.deepEqual(focus, [{ pid: 8, index: 0, title: "清单" }, { pid: 7, index: 0, title: "首页" }]);
    await assert.rejects(h.focusWindow("没有这个"), /没有这个窗口/);
    assert.match(await h.elements(), /前台应用：Safari（com\.apple\.Safari）[\s\S]*\[1\] Button 「后退」 中心 \(20, 20\)/);
    await h.key("cmd+w");
    assert.deepEqual(JSON.parse(calls.filter((c) => c.args[3] === KEY_JXA).at(-1)!.args[4]), { text: "w", mods: ["command down"] });
    await h.scroll(5, 6, 0, 2);
    assert.deepEqual(JSON.parse(calls.filter((c) => c.args[3] === MOUSE_JXA).at(-1)!.args[4]), { op: "scroll", x: 5, y: 6, dx: 0, dy: 2 });
    await h.openApp("com.apple.Safari");
    await h.openApp("Visual Studio Code");
    assert.deepEqual(calls.filter((c) => c.cmd === "open").map((c) => c.args), [["-b", "com.apple.Safari"], ["-a", "Visual Studio Code"]]);
    await assert.rejects(h.click(Number.NaN, 1), /数字/);
    await h.tap(1, 2); await h.swipe(0, 0, 10, 10);
    assert.deepEqual(calls.filter((c) => c.args[3] === MOUSE_JXA).slice(-2).map((c) => JSON.parse(c.args[4]).op), ["click", "drag"]);
  } finally { process.env.PATH = PATH; }
});

test("hands：没有辅助功能 / 屏幕录制权限时不动手，说明去哪里开，并只打开一次设置页", async () => {
  const { calls, exec } = fakeExec({ accessibility: false, screen: false });
  const opened: string[] = [];
  const h = createHands({ exec, node: "/opt/node", openSettings: (k) => opened.push(k) });
  await assert.rejects(h.click(1, 2), /辅助功能[\s\S]*\/opt\/node/);
  await assert.rejects(h.key("enter"), /辅助功能/);
  await assert.rejects(h.screenshot(), /屏幕录制/);
  assert.deepEqual(opened, ["accessibility", "screen"]);
  assert.equal(calls.filter((c) => c.args[3] === MOUSE_JXA || c.args[3] === KEY_JXA || c.cmd === "screencapture").length, 0, "没有发出任何事件");
});

test("hands：System Events 没有自动化授权（-1743）时如实说明", async () => {
  const exec: Exec = async (_cmd, args) => args[3] === PERMISSIONS_JXA ? { code: 0, out: JSON.stringify({ accessibility: true, screen: true }), err: "" }
    : { code: 1, out: "", err: "execution error: Not authorized to send Apple events to System Events. (-1743)" };
  const h = createHands({ exec, node: "/n", openSettings: () => {} });
  await assert.rejects(h.windows(), /自动化[\s\S]*System Events/);
});
