// macOS 的手（Hands，body/adapter.ts）：看屏幕、读无障碍树、点击 / 双击 / 右键 / 长按、拖拽、滚动、输入文字与按键组合、打开应用、列出与切换窗口。
//   不引入任何依赖，全部用系统自带的程序：
//   - 截图：screencapture（主显示器）；sips 读尺寸、按 maxEdge 缩小；
//   - 无障碍树、窗口、按键、输入：osascript -l JavaScript（JXA）经 System Events 读写；
//   - 鼠标：有 cliclick（开源，Homebrew 可装）就用它做普通的单击、双击与右键，其余（中键、多击、长按、拖拽、滚轮）与没有 cliclick 时
//     用 JXA 的 ObjC 桥直接调 CoreGraphics 的 CGEvent；
//   - 打开应用：open -a <名字> 或 open -b <bundle id>，只打开已安装的应用（不收路径与网址）。
//   坐标：接口里一律是截图的像素（主显示器左上角为原点）；系统的事件与无障碍坐标是「点」，Retina 屏一点是两个像素——
//   这里按主显示器的像素宽度 / 点宽度换算（CGDisplayModeGetPixelWidth 与 CGDisplayBounds）。只截主显示器：别的显示器上的窗口与元素看不到。
//   数据一律经参数（JSON）传给脚本，不拼进脚本源码，名字里有引号也不会变成代码。
//   权限：读界面与发送鼠标键盘事件要「辅助功能」，截到别的窗口要「屏幕录制」（没有它 screencapture 只拍到桌面与菜单栏），
//   控制 System Events 要「自动化」。授权的对象是运行基座的 node（launchd 拉起的那个程序，osascript 等子进程沿用它的授权）。
//   没有授权时如实说明去系统设置哪里打开，并替对方打开那一页（每个进程每种权限只打开一次）。
//   这些操作由运行基座进程直接执行，不经过 agent 的命令沙箱（闸门在核心：「操作屏幕与应用」缺省每次询问）。
import fs from "node:fs";
import type { Hands, HandsStatus, ScreenElement, ScreenPoint, ScreenSnapshot, ScreenWindow, ClickOptions } from "../../src/body/adapter.ts";
import { run, which } from "./mac.ts";

export type Exec = (cmd: string, args: string[], timeoutMs?: number) => Promise<{ code: number; out: string; err: string }>;
const fail = (msg: string): never => { throw new Error(msg); };

/** JXA：权限预检。AXIsProcessTrusted（辅助功能）与 CGPreflightScreenCaptureAccess（屏幕录制，macOS 10.15 起）都不弹窗。 */
export const PERMISSIONS_JXA = `ObjC.import('ApplicationServices');
ObjC.import('CoreGraphics');
function run() {
  var screen = true;
  try { if (typeof $.CGPreflightScreenCaptureAccess === 'function') screen = !!$.CGPreflightScreenCaptureAccess(); } catch (e) {}
  return JSON.stringify({ accessibility: !!$.AXIsProcessTrusted(), screen: screen });
}`;

/** JXA：主显示器的位置与大小（点）和像素宽高（Retina 时是点的两倍）。 */
export const SCREEN_JXA = `ObjC.import('CoreGraphics');
function run() {
  var id = $.CGMainDisplayID(), b = $.CGDisplayBounds(id), pw = 0, ph = 0;
  try { var m = $.CGDisplayCopyDisplayMode(id); pw = $.CGDisplayModeGetPixelWidth(m); ph = $.CGDisplayModeGetPixelHeight(m); } catch (e) {}
  return JSON.stringify({ x: b.origin.x, y: b.origin.y, w: b.size.width, h: b.size.height, pw: pw || b.size.width, ph: ph || b.size.height });
}`;

/**
 * JXA：鼠标事件（CoreGraphics 的 CGEvent，坐标是全局的「点」）。
 * 参数 {op, x, y, button?, count?, hold?, x2?, y2?, ms?, dx?, dy?}；op：click / drag / scroll / move。
 * 常量直接写数值：左键按下 1 / 松开 2，右键 3 / 4，其他键 25 / 26，移动 5，左键拖动 6；kCGHIDEventTap 0；kCGMouseEventClickState 1；
 * 按钮号 左 0、右 1、中 2。滚轮用非变参的 CGEventCreateScrollWheelEvent2（macOS 10.13 起），单位 1 = 行。
 */
export const MOUSE_JXA = `ObjC.import('CoreGraphics');
function run(argv) {
  var a = JSON.parse(argv[0]);
  function ev(type, x, y, button, clicks) {
    var e = $.CGEventCreateMouseEvent(null, type, $.CGPointMake(x, y), button);
    if (clicks) $.CGEventSetIntegerValueField(e, 1, clicks);
    $.CGEventPost(0, e);
  }
  function pause(ms) { delay(ms / 1000); }
  var btn = a.button === 'right' ? 1 : a.button === 'middle' ? 2 : 0;
  var down = btn === 1 ? 3 : btn === 2 ? 25 : 1, up = btn === 1 ? 4 : btn === 2 ? 26 : 2;
  ev(5, a.x, a.y, 0, 0);
  pause(30);
  if (a.op === 'click') {
    var n = Math.max(1, Math.min(3, a.count || 1));
    for (var i = 1; i <= n; i++) {
      ev(down, a.x, a.y, btn, i);
      if (a.hold) pause(a.hold);
      ev(up, a.x, a.y, btn, i);
      if (i < n) pause(60);
    }
  } else if (a.op === 'drag') {
    ev(1, a.x, a.y, 0, 1);
    var steps = 20;
    for (var j = 1; j <= steps; j++) { ev(6, a.x + (a.x2 - a.x) * j / steps, a.y + (a.y2 - a.y) * j / steps, 0, 0); pause(Math.max(5, (a.ms || 300) / steps)); }
    ev(2, a.x2, a.y2, 0, 1);
  } else if (a.op === 'scroll') {
    var s = $.CGEventCreateScrollWheelEvent2(null, 1, 2, -(a.dy || 0), -(a.dx || 0), 0);
    $.CGEventPost(0, s);
  }
  return 'ok';
}`;

/** JXA：前台应用的前台窗口（没有就全部窗口）与菜单栏之外的界面元素，深度优先，限数量与深度：角色、子角色、名称、值、位置、大小、状态。 */
export const ELEMENTS_JXA = `function run(argv) {
  var o = JSON.parse(argv[0]);
  var se = Application('System Events');
  var procs = se.applicationProcesses.whose({ frontmost: true })();
  if (!procs.length) return JSON.stringify({ app: '', bundle: '', window: '', items: [] });
  var p = procs[0], out = [];
  function str(v) { return v === null || v === undefined ? '' : String(v); }
  function walk(el, d) {
    if (out.length >= o.max) return;
    var pr = null;
    try { pr = el.properties(); } catch (e) { return; }
    var pos = pr.position || [], size = pr.size || [];
    out.push({ role: str(pr.role), sub: str(pr.subrole), name: str(pr.name || pr.title || pr.description), value: str(pr.value).slice(0, 200),
      x: pos[0], y: pos[1], w: size[0], h: size[1], depth: d, enabled: pr.enabled !== false, focused: pr.focused === true, selected: pr.selected === true });
    if (d >= o.depth) return;
    var kids = [];
    try { kids = el.uiElements(); } catch (e) {}
    for (var i = 0; i < kids.length && out.length < o.max; i++) walk(kids[i], d + 1);
  }
  var wins = [], title = '';
  try { wins = p.windows(); } catch (e) {}
  if (wins.length) { try { title = String(wins[0].name() || ''); } catch (e) {} walk(wins[0], 0); }
  var bundle = '';
  try { bundle = p.bundleIdentifier(); } catch (e) {}
  return JSON.stringify({ app: p.name(), bundle: bundle, window: title, items: out });
}`;

/** JXA：所有前台应用（不是纯后台进程）的窗口：应用、pid、序号、标题、位置、大小、是否最小化、应用是否在前台。 */
export const WINDOWS_JXA = `function run() {
  var se = Application('System Events');
  var procs = se.applicationProcesses.whose({ backgroundOnly: false })();
  var out = [];
  for (var i = 0; i < procs.length; i++) {
    var p = procs[i], wins = [];
    try { wins = p.windows(); } catch (e) { continue; }
    var front = false; try { front = p.frontmost(); } catch (e) {}
    for (var j = 0; j < wins.length; j++) {
      var w = wins[j], pr = {}, mini = false;
      try { pr = w.properties(); } catch (e) {}
      try { mini = !!w.attributes.byName('AXMinimized').value(); } catch (e) {}
      var pos = pr.position || [], size = pr.size || [];
      out.push({ app: p.name(), pid: p.unixId(), front: front, index: j, title: String(pr.name || pr.title || ''), x: pos[0], y: pos[1], w: size[0], h: size[1], minimized: mini });
    }
  }
  return JSON.stringify(out);
}`;

/** JXA：把某个应用的某个窗口切到最前（取消最小化、AXRaise、应用设为前台）。参数 {pid, index, title?}：有标题时按标题找，找不到再按序号。 */
export const FOCUS_JXA = `function run(argv) {
  var a = JSON.parse(argv[0]);
  var se = Application('System Events');
  var ps = se.applicationProcesses.whose({ unixId: a.pid })();
  if (!ps.length) throw new Error('window owner is gone');
  var p = ps[0], wins = [], w = null;
  try { wins = p.windows(); } catch (e) {}
  if (a.title) for (var i = 0; i < wins.length; i++) { try { if (String(wins[i].name()) === a.title) { w = wins[i]; break; } } catch (e) {} }
  if (!w && wins[a.index]) w = wins[a.index];
  p.frontmost = true;
  if (w) {
    try { w.attributes.byName('AXMinimized').value = false; } catch (e) {}
    try { w.actions.byName('AXRaise').perform(); } catch (e) {}
  }
  return w ? 'ok' : 'app';
}`;

/** JXA：按键（System Events）。参数 {code?, text?, mods[]}：有 code 用 key code（功能键、方向键），否则 keystroke 字符。 */
export const KEY_JXA = `function run(argv) {
  var a = JSON.parse(argv[0]);
  var se = Application('System Events');
  var opt = a.mods && a.mods.length ? { using: a.mods } : {};
  if (a.code !== undefined && a.code !== null) se.keyCode(a.code, opt); else se.keystroke(a.text, opt);
  return 'ok';
}`;

/** 规范化的修饰键名 → System Events 的 using 值（meta 在 Mac 上是 Command）。 */
const MODS: Record<string, string> = { ctrl: "control down", alt: "option down", shift: "shift down", meta: "command down" };
/** 有名字的键 → 虚拟键码（kVK_*，与键盘布局无关）。delete 是向前删除，backspace 是退格；insert 对应 Mac 键盘的 Help 键。 */
export const KEY_CODES: Record<string, number> = {
  enter: 36, tab: 48, space: 49, backspace: 51, esc: 53, delete: 117, insert: 114,
  left: 123, right: 124, down: 125, up: 126, home: 115, end: 119, pageup: 116, pagedown: 121,
  f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100, f9: 101, f10: 109, f11: 103, f12: 111,
  f13: 105, f14: 107, f15: 113, f16: 106, f17: 64, f18: 79, f19: 80, f20: 90,
};

/** 按键组合（核心已规范为小写、修饰键在前）→ System Events 的参数。不支持的键抛错。 */
export function keyArgs(keys: string[]): { code?: number; text?: string; mods: string[] } {
  if (!keys.length) fail("按键为空");
  const mods: string[] = [];
  for (const k of keys.slice(0, -1)) { const m = MODS[k] ?? fail(`「${k}」不是修饰键（ctrl、alt、shift、meta）`); if (!mods.includes(m)) mods.push(m); }
  const k = keys[keys.length - 1];
  if (MODS[k]) fail("按键组合的最后一个要是主键（如 meta+c 里的 c）");
  const code = KEY_CODES[k];
  if (code !== undefined) return { code, mods };
  if ([...k].length === 1) return { text: k, mods };
  return fail(/^f(2[1-4])$/.test(k) ? `Mac 键盘没有 ${k}` : ["back", "recents", "notifications", "quick_settings", "lock", "power"].includes(k) ? `「${k}」是手机上的动作，Mac 上没有` : `不支持的键：${k}`);
}

/** 输入文字的方式：可打印 ASCII（含换行、制表）直接 keystroke；中文、表情等经剪贴板粘贴（keystroke 按键盘布局打字，打不出它们），粘贴后恢复原来的剪贴板。 */
export const typeVia = (text: string): "keystroke" | "paste" => (/^[\x20-\x7e\n\t]*$/.test(text) ? "keystroke" : "paste");

/** cliclick 的坐标写法：取整，负数（主显示器左边或上边的副屏）要加 = 前缀。 */
const cc = (n: number) => { const v = Math.round(n); return v < 0 ? `=${v}` : String(v); };
/** cliclick 能做的点击（左键单击 / 双击、右键单击，不按住）的参数；做不了返回 undefined，走 CGEvent。 */
export function cliclickArgs(x: number, y: number, o: ClickOptions = {}): string[] | undefined {
  const at = `${cc(x)},${cc(y)}`, button = o.button ?? "left", count = o.count ?? 1;
  if (o.holdMs) return undefined;
  if (button === "left" && count === 1) return [`c:${at}`];
  if (button === "left" && count === 2) return [`dc:${at}`];
  if (button === "right" && count === 1) return [`rc:${at}`];
  return undefined;
}

/** 屏幕几何：主显示器在全局坐标里的位置与大小（点）和像素尺寸。scale = 像素 / 点。 */
export interface Geometry { x: number; y: number; w: number; h: number; pw: number; ph: number }
export const scaleOf = (g: Geometry) => (g.w > 0 ? g.pw / g.w : 1);
/** 截图像素 → 系统的点（事件坐标）。 */
export const toPoints = (g: Geometry, p: { x: number; y: number }) => ({ x: g.x + p.x / scaleOf(g), y: g.y + p.y / scaleOf(g) });
/** 系统的点 → 截图像素。 */
export const toPixels = (g: Geometry, x: number, y: number) => ({ x: (x - g.x) * scaleOf(g), y: (y - g.y) * scaleOf(g) });

/** AX 角色（加子角色）→ 通用角色名。 */
export function mapRole(role: string, sub = ""): string {
  if (sub === "AXSwitch") return "switch";
  if (sub === "AXTabButton") return "tab";
  if (sub === "AXSearchField" || sub === "AXSecureTextField") return "input";
  if (sub === "AXDialog" || sub === "AXSystemDialog") return "dialog";
  const m: Record<string, string> = {
    AXButton: "button", AXMenuButton: "button", AXDisclosureTriangle: "button", AXIncrementor: "button", AXLink: "link",
    AXStaticText: "text", AXHeading: "text", AXTextField: "input", AXTextArea: "input", AXComboBox: "combobox", AXPopUpButton: "combobox",
    AXCheckBox: "checkbox", AXRadioButton: "radio", AXSlider: "slider", AXTabGroup: "tab",
    AXMenu: "menu", AXMenuBar: "menu", AXMenuItem: "menuitem", AXMenuBarItem: "menuitem",
    AXList: "list", AXTable: "list", AXOutline: "list", AXBrowser: "list", AXRow: "item", AXCell: "item",
    AXImage: "image", AXToolbar: "toolbar", AXSheet: "dialog", AXWindow: "window",
    AXGroup: "group", AXSplitGroup: "group", AXLayoutArea: "group", AXScrollArea: "scroll", AXWebArea: "group",
  };
  return m[role] ?? "other";
}

/** JXA 读到的一个元素（点坐标）。 */
export interface RawElement { role: string; sub?: string; name?: string; value?: string; x?: number; y?: number; w?: number; h?: number; depth?: number; enabled?: boolean; focused?: boolean; selected?: boolean }

/** 元素换成接口的形状：坐标换成截图像素，没有大小的（看不见）不要，密码框不给值，复选框的值换成 checked。 */
export function toElement(e: RawElement, g: Geometry): ScreenElement | undefined {
  if (![e.x, e.y, e.w, e.h].every((v) => typeof v === "number" && Number.isFinite(v)) || (e.w! <= 0 && e.h! <= 0)) return undefined;
  const role = mapRole(e.role, e.sub), s = scaleOf(g), p = toPixels(g, e.x!, e.y!);
  const out: ScreenElement = { role, x: Math.round(p.x), y: Math.round(p.y), w: Math.round(e.w! * s), h: Math.round(e.h! * s) };
  if (e.name) out.name = e.name.replace(/\s+/g, " ").trim().slice(0, 200);
  const secret = e.sub === "AXSecureTextField";
  if (role === "checkbox" || role === "radio" || role === "switch") out.checked = e.value === "1" || e.value === "true";
  else if (e.value && !secret && e.value !== e.name) out.value = e.value;
  if (["button", "link", "checkbox", "radio", "switch", "tab", "menuitem", "combobox", "item"].includes(role)) out.clickable = true;
  if (role === "input" || role === "combobox") out.editable = true;
  if (role === "scroll" || role === "list") out.scrollable = true;
  if (e.enabled === false) out.enabled = false;
  if (e.focused) out.focused = true;
  if (e.selected) out.selected = true;
  return out;
}

/** 系统设置里各项权限的页面（x-apple.systempreferences 链接，macOS 13 起的「系统设置」与更早的「系统偏好设置」都认）。 */
export const SETTINGS = {
  accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  screen: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
  automation: "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation",
} as const;
export type Permission = keyof typeof SETTINGS;

/** 没有某项权限时给她（转告对方）的说明：去哪里、给谁授权。node 是运行基座的程序路径。 */
export function permissionHelp(kind: Permission, node = process.execPath): string {
  const where = {
    accessibility: "系统设置 › 隐私与安全性 › 辅助功能",
    screen: "系统设置 › 隐私与安全性 › 屏幕与系统录音（较早的系统叫「屏幕录制」）",
    automation: "系统设置 › 隐私与安全性 › 自动化",
  }[kind];
  const what = { accessibility: "读取界面元素、点击和输入", screen: "截到其他应用的窗口（没有它只拍得到桌面与菜单栏）", automation: "经「System Events」读取窗口与按键" }[kind];
  const how = kind === "automation" ? `在 node（${node}）下面勾选「System Events」` : `点「+」加入 ${node}（选择窗口里按 ⌘⇧G 粘贴这个路径；已经在列表里就打开它旁边的开关），之后重启 Quetzal（quetzal restart）`;
  return `没有「${kind === "accessibility" ? "辅助功能" : kind === "screen" ? "屏幕录制" : "自动化"}」权限，不能${what}。请对方打开 ${where}，${how}。`;
}

/** osascript 的报错 → 缺哪项权限（认不出为 undefined）。 */
export function osaPermission(err: string): Permission | undefined {
  if (/-1743|not authori[sz]ed to send apple events|不允许发送/i.test(err)) return "automation";
  if (/-1719|-25211|-25200|assistive access|辅助访问|accessibility/i.test(err)) return "accessibility";
  return undefined;
}

/** sips -g pixelWidth -g pixelHeight 的输出 → 图片尺寸。 */
export function sipsSize(out: string): { width: number; height: number } | undefined {
  const w = out.match(/pixelWidth:\s*(\d+)/)?.[1], h = out.match(/pixelHeight:\s*(\d+)/)?.[1];
  return w && h ? { width: Number(w), height: Number(h) } : undefined;
}

export interface MacHandsOptions { exec?: Exec; mediaFile?: (name: string) => string; node?: string; openSettings?: (kind: Permission) => void; gui?: () => boolean }

/** macOS 的 Hands。做不成时抛错（核心把这次调用标为失败），消息写明怎么才能做。 */
export function createHands(o: MacHandsOptions = {}): Hands {
  const exec: Exec = o.exec ?? ((cmd, args, t) => run(cmd, args, t ?? 30_000));
  const node = o.node ?? process.execPath;
  const gui = o.gui ?? (() => true);
  const opened = new Set<Permission>();
  const openSettings = o.openSettings ?? ((kind: Permission) => { void run("open", [SETTINGS[kind]], 10_000); });
  let permCache: { at: number; accessibility: boolean; screen: boolean } | undefined;
  let geo: { at: number; g: Geometry } | undefined;

  const denied = (kind: Permission): never => {
    const first = !opened.has(kind);
    if (first) { opened.add(kind); try { openSettings(kind); } catch { /* 打不开设置也照样说明 */ } }
    throw new Error(permissionHelp(kind, node) + (first ? "（已在这台 Mac 上打开了那一页）" : ""));
  };
  const noGui = () => fail("这台 Mac 现在没有人登录图形界面（只有 ssh 会话），没有屏幕可操作；登录桌面后再试");
  const jxa = async (script: string, arg?: unknown, timeoutMs = 30_000): Promise<string> => {
    const r = await exec("osascript", ["-l", "JavaScript", "-e", script, ...(arg === undefined ? [] : [JSON.stringify(arg)])], timeoutMs);
    if (r.code !== 0) {
      const kind = osaPermission(r.err + r.out);
      if (kind) denied(kind);
      fail(`osascript 失败：${(r.err || r.out).trim().slice(0, 300)}`);
    }
    return r.out.trim();
  };
  const permissions = async () => {
    if (permCache && Date.now() - permCache.at < 60_000) return permCache;
    const p = JSON.parse(await jxa(PERMISSIONS_JXA)) as { accessibility: boolean; screen: boolean };
    permCache = { at: p.accessibility && p.screen ? Date.now() : 0, ...p }; // 没授权时不缓存：对方一打开开关就能用
    return permCache;
  };
  const need = async (kind: "accessibility" | "screen") => { if (!gui()) noGui(); if (!(await permissions())[kind]) denied(kind); };
  const geometry = async (): Promise<Geometry> => {
    if (geo && Date.now() - geo.at < 10_000) return geo.g;
    const g = JSON.parse(await jxa(SCREEN_JXA)) as Geometry;
    if (!(g.w > 0 && g.h > 0)) fail("读不到主显示器的大小");
    geo = { at: Date.now(), g };
    return g;
  };
  const num = (v: unknown, what: string) => { const n = Number(v); if (!Number.isFinite(n)) fail(`${what}要是数字`); return n; };
  const pt = async (p: ScreenPoint) => toPoints(await geometry(), { x: num(p?.x, "x"), y: num(p?.y, "y") });

  const click = async (at: ScreenPoint, opts: ClickOptions = {}) => {
    await need("accessibility");
    const p = await pt(at);
    const c = which("cliclick"), args = cliclickArgs(p.x, p.y, opts);
    if (c && args) {
      const r = await exec(c, args, 30_000);
      if (r.code === 0) return;
      const kind = osaPermission(r.err + r.out);
      if (kind) denied(kind);
      // cliclick 出错：退回 CGEvent
    }
    const hold = opts.holdMs ? Math.max(50, Math.min(10_000, num(opts.holdMs, "holdMs"))) : 0;
    await jxa(MOUSE_JXA, { op: "click", x: p.x, y: p.y, button: opts.button ?? "left", count: Math.max(1, Math.min(3, Math.round(opts.count ?? 1))), hold });
  };

  return {
    async status(): Promise<HandsStatus> {
      if (!gui()) return { ready: false, reason: "这台 Mac 现在没有人登录图形界面（只有 ssh 会话）", screenshot: false, tree: false, input: false };
      let p: { accessibility: boolean; screen: boolean };
      try { p = await permissions(); } catch (e) { return { ready: false, reason: (e as Error).message, screenshot: false, tree: false, input: false }; }
      const missing = [!p.accessibility && permissionHelp("accessibility", node), !p.screen && permissionHelp("screen", node)].filter(Boolean);
      return {
        ready: p.accessibility || p.screen, screenshot: p.screen, tree: p.accessibility, input: p.accessibility,
        reason: missing.length ? missing.join(" ") : undefined,
        detail: `macOS：screencapture + System Events（无障碍）+ ${which("cliclick") ? "cliclick / " : ""}CGEvent`,
      };
    },
    /** 截主显示器。width / height 是屏幕像素（缩小之前）；给了 maxEdge 就用 sips 缩小图片。 */
    async screenshot(maxEdge?: number) {
      await need("screen");
      const f = (o.mediaFile ?? ((n: string) => `/tmp/${n}`))(`screen-${new Date().toISOString().replace(/[:.]/g, "-")}.png`);
      const r = await exec("screencapture", ["-x", "-t", "png", "-m", f], 30_000);
      if (r.code !== 0 || !fs.existsSync(f)) fail(`截图失败：${(r.err || r.out).trim().slice(0, 200) || "screencapture 没有生成文件"}`);
      const size = sipsSize((await exec("sips", ["-g", "pixelWidth", "-g", "pixelHeight", f], 30_000)).out) ?? await (async () => { const g = await geometry(); return { width: g.pw, height: g.ph }; })();
      if (maxEdge && maxEdge > 0 && Math.max(size.width, size.height) > maxEdge) await exec("sips", ["-Z", String(Math.round(maxEdge)), f, "--out", f], 30_000);
      return { file: f, ...size };
    },
    /** 前台应用的前台窗口里的元素（坐标换成截图像素）。 */
    async snapshot(): Promise<ScreenSnapshot> {
      await need("accessibility");
      const g = await geometry();
      const r = JSON.parse(await jxa(ELEMENTS_JXA, { max: 600, depth: 20 }, 60_000)) as { app: string; bundle: string; window: string; items: RawElement[] };
      const elements = r.items.map((e) => toElement(e, g)).filter((e): e is ScreenElement => !!e);
      const snap: ScreenSnapshot = { width: Math.round(g.pw), height: Math.round(g.ph), elements };
      if (r.app) snap.app = r.bundle ? `${r.app}（${r.bundle}）` : r.app;
      if (r.window) snap.window = r.window;
      if (!r.app) snap.note = "现在没有前台应用";
      else if (!elements.length) snap.note = "这个应用没有可读的窗口元素（可能没有打开窗口，或它不支持辅助功能）：请截图看";
      return snap;
    },
    click,
    async drag(from, to, durationMs = 300) {
      await need("accessibility");
      const a = await pt(from), b = await pt(to);
      await jxa(MOUSE_JXA, { op: "drag", x: a.x, y: a.y, x2: b.x, y2: b.y, ms: Math.max(50, Math.min(10_000, num(durationMs, "durationMs"))) });
    },
    /** 滚动 amount 格：down 看下面的内容（与滚轮一致）。at 缺省为主显示器中央。 */
    async scroll(direction, amount, at) {
      await need("accessibility");
      const g = await geometry();
      const p = at ? toPoints(g, { x: num(at.x, "x"), y: num(at.y, "y") }) : { x: g.x + g.w / 2, y: g.y + g.h / 2 };
      const n = Math.max(1, Math.min(50, Math.round(num(amount, "amount"))));
      const d = { up: [0, -n], down: [0, n], left: [-n, 0], right: [n, 0] }[direction] ?? fail(`不认识的方向：${direction}`);
      await jxa(MOUSE_JXA, { op: "scroll", x: p.x, y: p.y, dx: d[0], dy: d[1] });
    },
    /** 输入文字：给了 at 先点它；ASCII 直接按键，其余经剪贴板粘贴（之后恢复剪贴板）。 */
    async type(text, at) {
      await need("accessibility");
      if (at) { await click(at); await new Promise((r) => setTimeout(r, 150)); }
      const t = String(text);
      if (typeVia(t) === "keystroke") { await jxa(KEY_JXA, { text: t, mods: [] }); return; }
      const env = { LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" };
      const saved = await run("pbpaste", [], 10_000, undefined, env);
      if ((await run("pbcopy", [], 10_000, t, env)).code !== 0) fail("写剪贴板失败，没能输入");
      try { await jxa(KEY_JXA, { text: "v", mods: ["command down"] }); await new Promise((r) => setTimeout(r, 400)); }
      finally { if (saved.code === 0) await run("pbcopy", [], 10_000, saved.out, env); }
    },
    async key(keys) { await need("accessibility"); await jxa(KEY_JXA, keyArgs(keys)); },
    /** 打开（或切到）一个已安装的应用：显示名（Safari、"Visual Studio Code"）或 bundle id（com.apple.Safari）。不收路径与网址。 */
    async openApp(id) {
      if (!gui()) noGui();
      const name = String(id).trim();
      if (!name) fail("要给应用的名字或 bundle id");
      if (/[/:]/.test(name)) fail("只打开已安装的应用：给应用名或 bundle id，不收路径与网址");
      const byId = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+){2,}$/.test(name) && !/\.app$/i.test(name);
      const r = await exec("open", byId ? ["-b", name] : ["-a", name], 30_000);
      if (r.code !== 0) fail(`没有找到叫「${name}」的已安装应用：${(r.err || r.out).trim().slice(0, 200)}`);
      return `已打开 ${name}`;
    },
    /** 所有应用的窗口；id 是「pid:序号」，交回 focusWindow。坐标换成截图像素。 */
    async windows(): Promise<ScreenWindow[]> {
      await need("accessibility");
      const g = await geometry(), s = scaleOf(g);
      const list = JSON.parse(await jxa(WINDOWS_JXA, undefined, 60_000)) as { app: string; pid: number; front: boolean; index: number; title: string; x?: number; y?: number; w?: number; h?: number; minimized?: boolean }[];
      return list.map((w) => {
        const out: ScreenWindow = { id: `${w.pid}:${w.index}`, title: w.title + (w.minimized ? "（已最小化）" : ""), app: w.app, focused: w.front && w.index === 0 };
        if ([w.x, w.y, w.w, w.h].every((v) => typeof v === "number")) { const p = toPixels(g, w.x!, w.y!); Object.assign(out, { x: Math.round(p.x), y: Math.round(p.y), w: Math.round(w.w! * s), h: Math.round(w.h! * s) }); }
        return out;
      });
    },
    async focusWindow(id) {
      await need("accessibility");
      const m = String(id).match(/^(\d+):(\d+)$/) ?? fail(`没有这个窗口：${id}（先用窗口列表取 id）`);
      await jxa(FOCUS_JXA, { pid: Number(m[1]), index: Number(m[2]) });
    },
  };
}
