// 手（hands.ts）：键名规范、图片尺寸、元素过滤与编号、视图坐标换算；工具经闸门（缺省询问、急停拒绝）、写审计；截图交给她看。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "quetzal-hands-"));
process.env.QUETZAL_HOME = home;
const { loadConfig, config, paths } = await import("../src/config.ts");
loadConfig();
const store = await import("../src/store.ts");
store.openStore();
const hands = await import("../src/mind/hands.ts");
const { parseKeys, imageSize, pickElements, formatSnapshot, pointOf, viewOf, resetHands, VIEW_EDGE } = hands;

/** 生成一张纯色 PNG（w×h）。 */
function png(w: number, h: number): Buffer {
  const crc = (b: Buffer) => { let c = ~0; for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
  const chunk = (t: string, d: Buffer) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h, 0x80); for (let y = 0; y < h; y++) raw[y * (w * 3 + 1)] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

test("键名：别名、大小写、组合键；写错时说清楚", () => {
  assert.deepEqual(parseKeys("Ctrl+Shift+T"), ["ctrl", "shift", "t"]);
  assert.deepEqual(parseKeys("cmd + c"), ["meta", "c"]);
  assert.deepEqual(parseKeys("Return"), ["enter"]);
  assert.deepEqual(parseKeys("Page Up"), ["pageup"]);
  assert.deepEqual(parseKeys("返回"), ["back"]);
  assert.deepEqual(parseKeys("quick settings"), ["quick_settings"]);
  assert.deepEqual(parseKeys("ctrl++"), ["ctrl", "+"]);
  assert.deepEqual(parseKeys("F5"), ["f5"]);
  assert.deepEqual(parseKeys("alt+alt+tab"), ["alt", "tab"]);
  assert.throws(() => parseKeys(""), /不能为空/);
  assert.throws(() => parseKeys("x+c"), /不是修饰键/);
  assert.throws(() => parseKeys("launchrocket"), /不认识的键/);
});

test("图片尺寸：PNG、JPEG、BMP 只读文件头", () => {
  assert.deepEqual(imageSize(png(37, 21)), { width: 37, height: 21 });
  const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0xd0, 0x05, 0x00, 0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(imageSize(jpg), { width: 1280, height: 720 });
  const bmp = Buffer.alloc(54); bmp.write("BM", 0, "latin1"); bmp.writeUInt32LE(40, 14); bmp.writeInt32LE(64, 18); bmp.writeInt32LE(-32, 22);
  assert.deepEqual(imageSize(bmp), { width: 64, height: 32 });
  assert.equal(imageSize(Buffer.from("not an image")), undefined);
});

test("视图：长边缩到 VIEW_EDGE，只缩不放", () => {
  assert.deepEqual(viewOf(2560, 1440), { width: 2560, height: 1440, vw: 1280, vh: 720 });
  assert.deepEqual(viewOf(1080, 2400), { width: 1080, height: 2400, vw: 576, vh: 1280 });
  assert.deepEqual(viewOf(800, 600), { width: 800, height: 600, vw: 800, vh: 600 });
  assert.equal(VIEW_EDGE, 1280);
});

const SNAP = {
  width: 2560, height: 1440, app: "示例应用", window: "收件箱",
  elements: [
    { role: "window", x: 0, y: 0, w: 2560, h: 1440 },                                     // 没名字的容器：不列
    { role: "button", name: "发送", x: 100, y: 100, w: 200, h: 80, ref: "r1", clickable: true },
    { role: "text", name: "发送", x: 120, y: 110, w: 100, h: 40 },                        // 与包住它的按钮同名：不重复列
    { role: "input", name: "收件人", value: "someone@example.com", x: 400, y: 100, w: 800, h: 80, editable: true, focused: true },
    { role: "checkbox", name: "抄送自己", x: 400, y: 300, w: 60, h: 60, checked: false },
    { role: "text", name: "屏幕外", x: 3000, y: 100, w: 100, h: 40 },                   // 在屏幕外：不列
    { role: "button", name: "灰掉的", x: 1300, y: 100, w: 100, h: 40, enabled: false },
  ],
};

test("元素：过滤、编号、换算成视图坐标；按编号取中心点与 ref", () => {
  resetHands();
  assert.deepEqual(pickElements(SNAP).map((e) => e.name), ["发送", "收件人", "抄送自己", "灰掉的"]);
  const text = formatSnapshot(SNAP);
  assert.match(text, /^屏幕 1280×720（实际 2560×1440/);
  assert.match(text, /应用 示例应用 · 窗口「收件箱」/);
  assert.match(text, /^\[1\] 按钮「发送」 \(100,70 · 100×40\)$/m);
  assert.match(text, /^\[2\] 输入框「收件人」 值「someone@example.com」 \(400,70 · 400×40\) 焦点$/m);
  assert.match(text, /^\[3\] 复选框「抄送自己」 .* 未勾选$/m);
  assert.match(text, /^\[4\] 按钮「灰掉的」 .* 不可用$/m);
  assert.deepEqual(pointOf({ element: 1 })!.at, { x: 200, y: 140, ref: "r1" });
  assert.equal(pointOf({ element: 1 })!.label, "[1] 按钮「发送」");
  assert.deepEqual(pointOf({ x: 640, y: 360 })!.at, { x: 1280, y: 720 }, "视图坐标换回屏幕像素");
  assert.deepEqual(pointOf({ to_x: 10, to_y: 20 }, "to_")!.at, { x: 20, y: 40 });
  assert.equal(pointOf({}), undefined);
  assert.throws(() => pointOf({ element: 9 }), /不在最近一次读屏的结果里（1–4）/);
  assert.throws(() => pointOf({ x: 1280, y: 10 }), /在屏幕外/);
});

test("没读过屏幕时：坐标与编号都要求先看一眼", () => {
  resetHands();
  assert.throws(() => pointOf({ x: 1, y: 1 }), /先 screen_read 或 screen_capture/);
  assert.throws(() => pointOf({ element: 1 }), /还没有读过屏幕/);
});

// ---------- 工具：经 callTool（闸门、审计）调用一个假的 Hands
const calls: { op: string; args: unknown[] }[] = [];
const shotFile = path.join(home, "shot.png");
let ready = true, tree = true;
const fake = {
  status: async () => ({ ready, reason: ready ? undefined : "无障碍服务没有开启", screenshot: true, tree, input: true }),
  screenshot: async (maxEdge?: number) => { calls.push({ op: "screenshot", args: [maxEdge] }); fs.writeFileSync(shotFile, png(400, 300)); return { file: shotFile, width: 800, height: 600 }; },
  snapshot: async () => { calls.push({ op: "snapshot", args: [] }); return SNAP; },
  click: async (...args: unknown[]) => { calls.push({ op: "click", args }); },
  drag: async (...args: unknown[]) => { calls.push({ op: "drag", args }); },
  scroll: async (...args: unknown[]) => { calls.push({ op: "scroll", args }); },
  type: async (...args: unknown[]) => { calls.push({ op: "type", args }); },
  key: async (...args: unknown[]) => { calls.push({ op: "key", args }); },
  openApp: async (id: string) => { calls.push({ op: "openApp", args: [id] }); return `已打开 ${id}`; },
  windows: async () => [{ id: "0x1", title: "收件箱", app: "mail", focused: true }, { id: "0x2", title: "", app: "term" }],
  focusWindow: async (id: string) => { calls.push({ op: "focus", args: [id] }); },
};
const twin = await import("../src/body/twin.ts");
const adapterFile = path.join(home, "fake-adapter.mjs");
fs.writeFileSync(adapterFile, "export default { name: 'fake', describe: '测试用身体', sample: async () => ({}) };");
await twin.loadAdapter(adapterFile);
(twin.adapter as { hands?: unknown }).hands = fake;
const { callTool, allTools, builtinNames, limbTools } = await import("../src/mind/tools.ts");

test("有 hands 才出现 screen_* 工具，全部归「操作屏幕与应用」，也能被别的身体调用", () => {
  const names = ["screen_read", "screen_capture", "screen_click", "screen_drag", "screen_scroll", "screen_type", "screen_key", "app_open", "window_list", "window_focus"];
  const mine = allTools().filter((t) => names.includes(t.name));
  assert.deepEqual(mine.map((t) => t.name).sort(), [...names].sort());
  assert.ok(mine.every((t) => t.permission === "hands" && t.onBody));
  assert.ok(names.every((n) => builtinNames().includes(n)), "自造工具不得与之重名");
  assert.ok(names.every((n) => limbTools(new Set()).some((t) => t.name === n)), "跨身体可调用（mesh/limbs.ts 的 tool.list）");
});

test("闸门：缺省每次询问；急停时拒绝，不碰屏幕", async () => {
  assert.equal(config.permissions.hands, "ask");
  fs.writeFileSync(paths.stop, "test\n");
  calls.length = 0;
  const r = await callTool("screen_click", { x: 1, y: 1 }, "测试");
  assert.equal(r.status, "denied");
  assert.equal(calls.length, 0);
  fs.rmSync(paths.stop, { force: true });
});

test("工具：读屏、按编号点击、坐标拖拽、滚动、输入、按键、打开应用、窗口；结果写审计", async () => {
  config.permissions.hands = "allow";
  resetHands();
  calls.length = 0;
  const read = await callTool("screen_read", {}, "看看屏幕");
  assert.equal(read.status, "ok");
  assert.match(read.text, /\[1\] 按钮「发送」/);
  const click = await callTool("screen_click", { element: 2, count: 2 }, "双击输入框");
  assert.equal(click.text, "已双击 [2] 输入框「收件人」");
  assert.deepEqual(calls.at(-1), { op: "click", args: [{ x: 800, y: 140 }, { button: "left", count: 2 }] });
  await callTool("screen_click", { x: 10, y: 10, hold: 900 }, "长按");
  assert.deepEqual(calls.at(-1)!.args, [{ x: 20, y: 20 }, { button: "left", count: 1, holdMs: 900 }]);
  await callTool("screen_drag", { element: 1, to_x: 100, to_y: 100, ms: 500 }, "拖");
  assert.deepEqual(calls.at(-1), { op: "drag", args: [{ x: 200, y: 140, ref: "r1" }, { x: 200, y: 200 }, 500] });
  await callTool("screen_scroll", { direction: "down" }, "往下看");
  assert.deepEqual(calls.at(-1), { op: "scroll", args: ["down", 3, undefined] });
  const typed = await callTool("screen_type", { text: "你好", element: 2, enter: true }, "输入");
  assert.equal(typed.text, "已输入 2 个字到 [2] 输入框「收件人」，并按了回车");
  assert.deepEqual(calls.slice(-2), [{ op: "type", args: ["你好", { x: 800, y: 140 }] }, { op: "key", args: [["enter"]] }]);
  await callTool("screen_key", { keys: "Ctrl+L" }, "地址栏");
  assert.deepEqual(calls.at(-1), { op: "key", args: [["ctrl", "l"]] });
  assert.equal((await callTool("app_open", { id: "设置" }, "打开设置")).text, "已打开 设置");
  assert.match((await callTool("window_list", {}, "")).text, /^\[0x1\] 收件箱 — mail（前台）\n\[0x2\] （无标题） — term$/);
  await callTool("window_focus", { id: "0x2" }, "");
  assert.deepEqual(calls.at(-1), { op: "focus", args: ["0x2"] });
  const bad = await callTool("screen_click", {}, "没给位置");
  assert.equal(bad.status, "error");
  assert.match(bad.text, /要给点哪里/);
  const log = store.listAudit(50).map((a: { action: string }) => a.action);
  assert.ok(log.includes("screen_click") && log.includes("screen_type"), "每次调用都写审计");
});

test("截图：缩到视图大小交给她看，之后的坐标按这张图换算；读不到无障碍树时改为截图", async () => {
  config.permissions.hands = "allow";
  resetHands();
  calls.length = 0;
  const shot = await callTool("screen_capture", {}, "看一眼");
  assert.equal(shot.status, "ok");
  assert.match(shot.text, /截图 400×300（屏幕实际 800×600）/);
  assert.deepEqual(calls[0], { op: "screenshot", args: [1280] });
  assert.deepEqual(pointOf({ x: 100, y: 100 })!.at, { x: 200, y: 200 }, "图上一像素 = 屏幕两像素");
  tree = false;
  assert.match((await callTool("screen_read", {}, "")).text, /读不到无障碍树，改为截图/);
  tree = true; ready = false;
  const r = await callTool("screen_read", {}, "");
  assert.equal(r.status, "error");
  assert.match(r.text, /无障碍服务没有开启/);
  ready = true;
});
