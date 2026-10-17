// macOS 的「计算机使用」（hands）：看屏幕、读无障碍树、点击 / 双击 / 右键 / 长按 / 拖拽 / 滚动、输入文字与按键组合、打开应用、列出与切换窗口。
//   不引入任何依赖，全部用系统自带的程序：
//   - 截图：screencapture（主显示器），再用 sips 缩放到「点」的尺寸，截图上的坐标就是点击用的坐标（Retina 屏不用再除以 2）；
//   - 无障碍树、窗口、按键、输入：osascript -l JavaScript（JXA）经 System Events 读写（角色、名称、位置、大小，带编号）；
//   - 鼠标：有 cliclick（开源，Homebrew 可装）就用它，否则 JXA 的 ObjC 桥直接调 CoreGraphics 的 CGEvent（滚轮总是走 CGEvent）；
//   - 打开应用：open -a <名字> 或 open -b <bundle id>。
//   数据一律经参数（JSON）传给脚本，不拼进脚本源码，名字里有引号也不会变成代码。
//   权限：读界面与发送鼠标键盘事件要「辅助功能」，截到别的窗口要「屏幕录制」（没有它 screencapture 只拍到桌面与菜单栏），
//   控制 System Events 要「自动化」。授权的对象是运行基座的 node（launchd 拉起的那个程序，osascript 等子进程沿用它的授权）。
//   没有授权时如实说明去系统设置哪里打开，并替对方打开那一页（每个进程每种权限只打开一次）。
import fs from "node:fs";
import { run, which, have } from "./mac.ts";

export type Exec = (cmd: string, args: string[], timeoutMs?: number) => Promise<{ code: number; out: string; err: string }>;

/** JXA：权限预检。AXIsProcessTrusted（辅助功能）与 CGPreflightScreenCaptureAccess（屏幕录制，macOS 10.15 起）都不弹窗。 */
export const PERMISSIONS_JXA = `ObjC.import('ApplicationServices');
ObjC.import('CoreGraphics');
function run() {
  var screen = true;
  try { if (typeof $.CGPreflightScreenCaptureAccess === 'function') screen = !!$.CGPreflightScreenCaptureAccess(); } catch (e) {}
  return JSON.stringify({ accessibility: !!$.AXIsProcessTrusted(), screen: screen });
}`;

/** JXA：主显示器的大小（点）。 */
export const SCREEN_JXA = `ObjC.import('CoreGraphics');
function run() {
  var b = $.CGDisplayBounds($.CGMainDisplayID());
  return JSON.stringify({ w: b.size.width, h: b.size.height });
}`;

/**
 * JXA：鼠标事件（CoreGraphics 的 CGEvent，坐标是全局的「点」，主显示器左上角为原点）。
 * 参数 {op, x, y, x2?, y2?, ms?, dx?, dy?}；op：move / click / double / right / long / drag / scroll。
 * 常量直接写数值：kCGEventLeftMouseDown 1、Up 2、RightMouseDown 3、Up 4、MouseMoved 5、LeftMouseDragged 6；kCGHIDEventTap 0；
 * kCGMouseEventClickState 1；滚轮用非变参的 CGEventCreateScrollWheelEvent2（macOS 10.13 起），单位 1 = 行。
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
  ev(5, a.x, a.y, 0, 0);
  pause(30);
  if (a.op === 'click') { ev(1, a.x, a.y, 0, 1); ev(2, a.x, a.y, 0, 1); }
  else if (a.op === 'double') { ev(1, a.x, a.y, 0, 1); ev(2, a.x, a.y, 0, 1); pause(60); ev(1, a.x, a.y, 0, 2); ev(2, a.x, a.y, 0, 2); }
  else if (a.op === 'right') { ev(3, a.x, a.y, 1, 1); ev(4, a.x, a.y, 1, 1); }
  else if (a.op === 'long') { ev(1, a.x, a.y, 0, 1); pause(a.ms || 800); ev(2, a.x, a.y, 0, 1); }
  else if (a.op === 'drag') {
    ev(1, a.x, a.y, 0, 1);
    var steps = 20;
    for (var i = 1; i <= steps; i++) { ev(6, a.x + (a.x2 - a.x) * i / steps, a.y + (a.y2 - a.y) * i / steps, 0, 0); pause(Math.max(5, (a.ms || 400) / steps)); }
    ev(2, a.x2, a.y2, 0, 1);
  }
  else if (a.op === 'scroll') {
    var s = $.CGEventCreateScrollWheelEvent2(null, 1, 2, -(a.dy || 0), -(a.dx || 0), 0);
    $.CGEventPost(0, s);
  }
  return 'ok';
}`;

/** JXA：前台应用的窗口里的界面元素（深度优先，限数量与深度）：角色、名称、值、位置、大小。 */
export const ELEMENTS_JXA = `function run(argv) {
  var o = JSON.parse(argv[0]);
  var se = Application('System Events');
  var procs = se.applicationProcesses.whose({ frontmost: true })();
  if (!procs.length) return JSON.stringify({ app: '', bundle: '', items: [] });
  var p = procs[0], out = [];
  function str(v) { return v === null || v === undefined ? '' : String(v); }
  function walk(el, d) {
    if (out.length >= o.max) return;
    var pr = null;
    try { pr = el.properties(); } catch (e) { return; }
    var pos = pr.position || [], size = pr.size || [];
    out.push({ role: str(pr.role), sub: str(pr.subrole), name: str(pr.name || pr.title || pr.description), value: str(pr.value).slice(0, 80),
      x: pos[0], y: pos[1], w: size[0], h: size[1], depth: d, enabled: pr.enabled !== false });
    if (d >= o.depth) return;
    var kids = [];
    try { kids = el.uiElements(); } catch (e) {}
    for (var i = 0; i < kids.length && out.length < o.max; i++) walk(kids[i], d + 1);
  }
  var wins = [];
  try { wins = p.windows(); } catch (e) {}
  for (var i = 0; i < wins.length && out.length < o.max; i++) walk(wins[i], 0);
  var bundle = '';
  try { bundle = p.bundleIdentifier(); } catch (e) {}
  return JSON.stringify({ app: p.name(), bundle: bundle, items: out });
}`;

/** JXA：所有前台应用（不是纯后台进程）的窗口：应用、pid、标题、位置、大小、是否最小化。 */
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

/** JXA：把某个应用的某个窗口切到最前（取消最小化、AXRaise、应用设为前台）。参数 {pid, index, title}。 */
export const FOCUS_JXA = `function run(argv) {
  var a = JSON.parse(argv[0]);
  var se = Application('System Events');
  var ps = se.applicationProcesses.whose({ unixId: a.pid })();
  if (!ps.length) throw new Error('window owner is gone');
  var p = ps[0], wins = [], w = null;
  try { wins = p.windows(); } catch (e) {}
  for (var i = 0; i < wins.length; i++) { try { if (String(wins[i].name()) === a.title) { w = wins[i]; break; } } catch (e) {} }
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

/** 修饰键的写法 → System Events 的 using 值。 */
const MODS: Record<string, string> = {
  cmd: "command down", command: "command down", "⌘": "command down", meta: "command down", super: "command down", win: "command down",
  ctrl: "control down", control: "control down", "⌃": "control down",
  alt: "option down", option: "option down", opt: "option down", "⌥": "option down",
  shift: "shift down", "⇧": "shift down",
};
/** 有名字的键 → 虚拟键码（kVK_*，与键盘布局无关）。 */
export const KEY_CODES: Record<string, number> = {
  return: 36, enter: 36, tab: 48, space: 49, delete: 51, backspace: 51, escape: 53, esc: 53, forwarddelete: 117, del: 117,
  left: 123, right: 124, down: 125, up: 126, home: 115, end: 119, pageup: 116, pagedown: 121,
  f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100, f9: 101, f10: 109, f11: 103, f12: 111,
};

/** 解析按键组合（cmd+shift+t、ctrl+c、enter、cmd+space、⌘+w）：修饰键之外必须正好一个键。 */
export function parseKey(combo: string): { code?: number; text?: string; mods: string[] } {
  const parts = combo.trim().split(/\s*\+\s*/).filter(Boolean);
  if (!parts.length) throw new Error("按键为空");
  const mods: string[] = [];
  const keys: string[] = [];
  for (const p of parts) { const m = MODS[p.toLowerCase()]; if (m) { if (!mods.includes(m)) mods.push(m); } else keys.push(p); }
  if (keys.length !== 1) throw new Error(`按键组合要有正好一个主键（如 cmd+c、enter），收到：${combo}`);
  const k = keys[0], code = KEY_CODES[k.toLowerCase()];
  if (code !== undefined) return { code, mods };
  if ([...k].length !== 1) throw new Error(`不认识的键：${k}（字母数字直接写，功能键写 enter、esc、tab、space、delete、up、down、left、right、home、end、pageup、pagedown、f1–f12）`);
  return { text: mods.length ? k.toLowerCase() : k, mods };
}

/** 输入文字的方式：可打印 ASCII（含换行、制表）直接 keystroke；中文、表情等经剪贴板粘贴（keystroke 按键盘布局打字，打不出它们），粘贴后恢复原来的剪贴板。 */
export const typeVia = (text: string): "keystroke" | "paste" => (/^[\x20-\x7e\n\t]*$/.test(text) ? "keystroke" : "paste");

/** cliclick 的坐标写法：取整，负数（主显示器左边或上边的副屏）要加 = 前缀。 */
const cc = (n: number) => { const v = Math.round(n); return v < 0 ? `=${v}` : String(v); };
/** cliclick 的参数（不支持滚轮：滚动总是走 CGEvent）。 */
export function cliclickArgs(op: "move" | "click" | "double" | "right" | "long" | "drag", x: number, y: number, o: { x2?: number; y2?: number; ms?: number } = {}): string[] {
  const at = `${cc(x)},${cc(y)}`;
  switch (op) {
    case "move": return [`m:${at}`];
    case "click": return [`c:${at}`];
    case "double": return [`dc:${at}`];
    case "right": return [`rc:${at}`];
    case "long": return [`dd:${at}`, `w:${Math.round(o.ms ?? 800)}`, `du:${at}`];
    case "drag": { const to = `${cc(o.x2 ?? x)},${cc(o.y2 ?? y)}`; return ["-e", String(Math.max(10, Math.round((o.ms ?? 400) / 20))), `dd:${at}`, `dm:${to}`, `du:${to}`]; }
  }
}

export interface UiElement { role: string; sub?: string; name: string; value?: string; x?: number; y?: number; w?: number; h?: number; depth: number; enabled?: boolean }
export interface UiWindow { app: string; pid: number; front: boolean; index: number; title: string; x?: number; y?: number; w?: number; h?: number; minimized?: boolean }

/** 界面元素的一行：[编号] 角色 「名称」 值 中心 (x, y) 宽×高。没有大小的（看不见）也列出，但不给坐标。 */
export function formatElement(e: UiElement, n: number): string {
  const role = (e.role || "?").replace(/^AX/, "") + (e.sub ? `/${e.sub.replace(/^AX/, "")}` : "");
  const name = e.name ? ` 「${e.name.replace(/\s+/g, " ").slice(0, 60)}」` : "";
  const value = e.value && e.value !== e.name ? ` 值=${JSON.stringify(e.value.replace(/\s+/g, " ").slice(0, 40))}` : "";
  const box = [e.x, e.y, e.w, e.h].every((v) => typeof v === "number" && Number.isFinite(v)) && (e.w! > 0 || e.h! > 0)
    ? ` 中心 (${Math.round(e.x! + e.w! / 2)}, ${Math.round(e.y! + e.h! / 2)}) ${Math.round(e.w!)}×${Math.round(e.h!)}` : "";
  return `${"  ".repeat(Math.min(e.depth, 6))}[${n}] ${role}${name}${value}${box}${e.enabled === false ? "（不可用）" : ""}`;
}

export function formatWindow(w: UiWindow, n: number): string {
  const box = [w.x, w.y, w.w, w.h].every((v) => typeof v === "number") ? ` 位置 (${Math.round(w.x!)}, ${Math.round(w.y!)}) ${Math.round(w.w!)}×${Math.round(w.h!)}` : "";
  return `[${n}] ${w.app}${w.front ? "（前台）" : ""} — 「${w.title || "（无标题）"}」${box}${w.minimized ? "（已最小化）" : ""}`;
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
  const how = kind === "automation" ? `在 node（${node}）下面勾选「System Events」` : `点「+」加入 ${node}（或打开它旁边的开关），之后重启 Quetzal（quetzal restart）`;
  return `没有「${kind === "accessibility" ? "辅助功能" : kind === "screen" ? "屏幕录制" : "自动化"}」权限，不能${what}。请对方打开 ${where}，${how}。`;
}

/** osascript 的报错 → 缺哪项权限（认不出为 undefined）。 */
export function osaPermission(err: string): Permission | undefined {
  if (/-1743|not authori[sz]ed to send apple events|不允许发送/i.test(err)) return "automation";
  if (/-1719|-25211|-25200|assistive access|辅助访问|accessibility/i.test(err)) return "accessibility";
  return undefined;
}

export interface MacHandsOptions { exec?: Exec; mediaFile?: (name: string) => string; node?: string; openSettings?: (kind: Permission) => void }

/**
 * macOS 的 hands。方法名是通用的（screenshot、elements、click、doubleClick、rightClick、longPress、drag、scroll、type、key、openApp、windows、focusWindow），
 * 同时满足现有 Hands 接口（describeScreen、tap、swipe）。做不成时抛错（核心把这次调用标为失败）。坐标一律是「点」，与 screenshot 返回的图片一致。
 */
export function createHands(o: MacHandsOptions = {}) {
  const exec: Exec = o.exec ?? ((cmd, args, t) => run(cmd, args, t ?? 30_000));
  const node = o.node ?? process.execPath;
  const opened = new Set<Permission>();
  const openSettings = o.openSettings ?? ((kind: Permission) => { void run("open", [SETTINGS[kind]], 10_000); });
  let lastWindows: UiWindow[] = [];
  let permCache: { at: number; accessibility: boolean; screen: boolean } | undefined;

  const denied = (kind: Permission): never => {
    if (!opened.has(kind)) { opened.add(kind); try { openSettings(kind); } catch { /* 打不开设置也照样说明 */ } }
    throw new Error(permissionHelp(kind, node) + (opened.has(kind) ? "（已在这台 Mac 上打开了那一页）" : ""));
  };
  const jxa = async (script: string, arg?: unknown, timeoutMs = 30_000): Promise<string> => {
    const r = await exec("osascript", ["-l", "JavaScript", "-e", script, ...(arg === undefined ? [] : [JSON.stringify(arg)])], timeoutMs);
    if (r.code !== 0) {
      const kind = osaPermission(r.err + r.out);
      if (kind) denied(kind);
      throw new Error(`osascript 失败：${(r.err || r.out).trim().slice(0, 300)}`);
    }
    return r.out.trim();
  };
  const permissions = async () => {
    if (permCache && Date.now() - permCache.at < 60_000) return permCache;
    const p = JSON.parse(await jxa(PERMISSIONS_JXA)) as { accessibility: boolean; screen: boolean };
    permCache = { at: Date.now(), ...p };
    if (!p.accessibility || !p.screen) permCache.at = 0; // 没授权时不缓存：对方一打开开关就能用
    return permCache;
  };
  const need = async (kind: "accessibility" | "screen") => { if (!(await permissions())[kind]) denied(kind); };
  const num = (v: unknown, what: string) => { const n = Number(v); if (!Number.isFinite(n)) throw new Error(`${what}要是数字`); return n; };

  const cliclick = () => which("cliclick");
  const mouse = async (op: "move" | "click" | "double" | "right" | "long" | "drag", x: number, y: number, extra: { x2?: number; y2?: number; ms?: number } = {}) => {
    await need("accessibility");
    const c = cliclick();
    if (c) {
      const r = await exec(c, cliclickArgs(op, x, y, extra), 30_000);
      if (r.code === 0) return;
      const kind = osaPermission(r.err + r.out);
      if (kind) denied(kind);
      // cliclick 出错（版本太旧不认 dm: 之类）：退回 CGEvent
    }
    await jxa(MOUSE_JXA, { op, x, y, ...extra });
  };

  const screenSize = async () => JSON.parse(await jxa(SCREEN_JXA)) as { w: number; h: number };

  const hands = {
    /** 截主显示器，缩放到「点」的尺寸（与点击坐标一致），返回 PNG 路径。 */
    async screenshot(): Promise<string> {
      await need("screen");
      const f = (o.mediaFile ?? ((n: string) => `/tmp/${n}`))(`screen-${new Date().toISOString().replace(/[:.]/g, "-")}.png`);
      const r = await exec("screencapture", ["-x", "-t", "png", "-m", f], 30_000);
      if (r.code !== 0 || !fs.existsSync(f)) throw new Error(`截图失败：${(r.err || r.out).trim().slice(0, 200) || "screencapture 没有生成文件"}`);
      try { const s = await screenSize(); if (s.w > 0) await exec("sips", ["--resampleWidth", String(Math.round(s.w)), f, "--out", f], 30_000); } catch { /* 缩放失败：原图也能用，只是坐标要按比例换算 */ }
      return f;
    },
    /** 前台应用窗口里的界面元素，带编号与中心坐标。 */
    async elements(max = 150): Promise<string> {
      await need("accessibility");
      const r = JSON.parse(await jxa(ELEMENTS_JXA, { max: Math.max(10, Math.min(400, max)), depth: 12 }, 60_000)) as { app: string; bundle: string; items: UiElement[] };
      if (!r.app) return "现在没有前台应用。";
      const head = `前台应用：${r.app}${r.bundle ? `（${r.bundle}）` : ""}，界面元素 ${r.items.length} 个${r.items.length >= max ? "（只列前这些）" : ""}；坐标是「点」，与截图一致，点击用中心坐标：`;
      return r.items.length ? `${head}\n${r.items.map((e, i) => formatElement(e, i + 1)).join("\n")}` : `${head}\n（这个应用没有可读的窗口元素：可能没有打开窗口，或它不支持辅助功能）`;
    },
    /** 现有 Hands 接口：一段文字描述屏幕（前台应用、屏幕大小、窗口与前台应用的元素）。 */
    async describeScreen(): Promise<string> {
      const size = await screenSize().catch(() => undefined);
      const wins = await hands.windows().catch((e: Error) => `（读不到窗口：${e.message}）`);
      const els = await hands.elements(80).catch((e: Error) => `（读不到界面元素：${e.message}）`);
      return [size ? `主显示器 ${Math.round(size.w)}×${Math.round(size.h)} 点。` : "", wins, els].filter(Boolean).join("\n\n");
    },
    async click(x: number, y: number) { await mouse("click", num(x, "x"), num(y, "y")); },
    async doubleClick(x: number, y: number) { await mouse("double", num(x, "x"), num(y, "y")); },
    async rightClick(x: number, y: number) { await mouse("right", num(x, "x"), num(y, "y")); },
    async longPress(x: number, y: number, ms = 800) { await mouse("long", num(x, "x"), num(y, "y"), { ms: Math.max(100, Math.min(10_000, num(ms, "ms"))) }); },
    async move(x: number, y: number) { await mouse("move", num(x, "x"), num(y, "y")); },
    async drag(x1: number, y1: number, x2: number, y2: number, ms = 400) { await mouse("drag", num(x1, "x1"), num(y1, "y1"), { x2: num(x2, "x2"), y2: num(y2, "y2"), ms: Math.max(50, Math.min(10_000, num(ms, "ms"))) }); },
    /** 在 (x, y) 处滚动：dy 正数向下、负数向上，dx 正数向右（单位：行）。 */
    async scroll(x: number, y: number, dx: number, dy: number) {
      await need("accessibility");
      await jxa(MOUSE_JXA, { op: "scroll", x: num(x, "x"), y: num(y, "y"), dx: Math.round(num(dx, "dx")), dy: Math.round(num(dy, "dy")) });
    },
    /** 在当前焦点处输入文字。 */
    async type(text: string) {
      await need("accessibility");
      const t = String(text);
      if (typeVia(t) === "keystroke") { await jxa(KEY_JXA, { text: t, mods: [] }); return; }
      const saved = await run("pbpaste", [], 10_000, undefined, { LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" });
      const put = await run("pbcopy", [], 10_000, t, { LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" });
      if (put.code !== 0) throw new Error("写剪贴板失败，没能输入");
      try { await jxa(KEY_JXA, { text: "v", mods: ["command down"] }); await new Promise((r) => setTimeout(r, 400)); }
      finally { if (saved.code === 0) await run("pbcopy", [], 10_000, saved.out, { LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" }); }
    },
    /** 按键或组合键：cmd+c、cmd+shift+t、enter、esc、tab、up、f5…… */
    async key(combo: string) { await need("accessibility"); await jxa(KEY_JXA, parseKey(combo)); },
    /** 打开（或切到）一个应用：名字（Safari、"Visual Studio Code"）或 bundle id（com.apple.Safari）。 */
    async openApp(id: string) {
      const name = String(id).trim();
      if (!name) throw new Error("要给应用的名字或 bundle id");
      const byId = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+){2,}$/.test(name) && !/\.app$/i.test(name);
      const r = await exec("open", byId ? ["-b", name] : ["-a", name], 30_000);
      if (r.code !== 0) throw new Error(`打不开「${name}」：${(r.err || r.out).trim().slice(0, 200) || "没有这个应用"}`);
    },
    /** 所有应用的窗口（带编号）；focusWindow 用这里的编号。 */
    async windows(): Promise<string> {
      await need("accessibility");
      lastWindows = JSON.parse(await jxa(WINDOWS_JXA, undefined, 60_000)) as UiWindow[];
      if (!lastWindows.length) return "没有打开的窗口。";
      return `窗口 ${lastWindows.length} 个（focusWindow 用编号或标题）：\n${lastWindows.map((w, i) => formatWindow(w, i + 1)).join("\n")}`;
    },
    /** 切到某个窗口：windows() 列出的编号，或标题 / 应用名里的一段文字。 */
    async focusWindow(target: number | string) {
      await need("accessibility");
      if (!lastWindows.length) lastWindows = JSON.parse(await jxa(WINDOWS_JXA, undefined, 60_000)) as UiWindow[];
      const t = String(target).trim();
      const w = /^\d+$/.test(t) ? lastWindows[Number(t) - 1] : lastWindows.find((x) => x.title.includes(t)) ?? lastWindows.find((x) => x.app.toLowerCase().includes(t.toLowerCase()));
      if (!w) throw new Error(`没有这个窗口：${t}（先用 windows 列出）`);
      await jxa(FOCUS_JXA, { pid: w.pid, index: w.index, title: w.title });
    },
    // 现有 Hands 接口的名字
    async tap(x: number, y: number) { await hands.click(x, y); },
    async swipe(x1: number, y1: number, x2: number, y2: number) { await hands.drag(x1, y1, x2, y2); },
    /** 权限状态（控制台或她自己查）：{accessibility, screen}。 */
    async permissions() { const p = await permissions(); return { accessibility: p.accessibility, screen: p.screen }; },
  };
  return hands;
}

export type MacHands = ReturnType<typeof createHands>;
/** 有没有 cliclick（只影响鼠标事件走哪条路）。 */
export const hasCliclick = () => have("cliclick");
