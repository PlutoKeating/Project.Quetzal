// Linux 的手（Hands，body/adapter.ts）：看屏幕、点击、输入、打开应用。一切靠探测，有什么用什么：
//   - 输入：X11 用 xdotool；Wayland 用 ydotool（鼠标与键盘，要 ydotoold 在跑、能写 /dev/uinput）与 wtype（键盘，wlroots 系的合成器）。
//     Wayland 下没有可用的输入程序时，有无障碍引用的元素退回 AT-SPI 的动作（点按钮、往输入框里写字）。
//   - 无障碍树：AT-SPI（python3 + gi 的 Atspi 2.0，多数桌面自带）；读前台窗口里看得见的元素。
//   - 截图：grim / scrot / gnome-screenshot / spectacle / ImageMagick 的 import（与原先的截图工具同一套探测）。
//   - 窗口：X11 有 wmctrl 时列出与切换；否则只经 AT-SPI 列出。
//   - 打开应用：只打开已安装的 .desktop 应用（gtk-launch / gio launch），不执行任意命令。
//   运行基座常常是 systemd 用户服务，环境里不一定有 DISPLAY / WAYLAND_DISPLAY / DBUS_SESSION_BUS_ADDRESS：按 XDG_RUNTIME_DIR 与 /tmp/.X11-unix 探测补上。
//   这些操作由运行基座进程直接执行，不经过 agent 的命令沙箱（闸门在核心：「操作屏幕与应用」缺省交给审核模型）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Hands, HandsStatus, ScreenElement, ScreenPoint, ScreenSnapshot, ScreenWindow, ClickOptions } from "../../src/body/adapter.ts";
import { run, have } from "./linux.ts";

type Has = (c: string) => boolean;
type Cmd = [string, string[]];
const fail = (msg: string): never => { throw new Error(msg); };

// ---------- 桌面会话的环境
export interface Probe { env: NodeJS.ProcessEnv; uid: number; home: string; ls: (d: string) => string[]; exists: (f: string) => boolean }
/** 探测用的系统读数（测试里替换成假的）。 */
export const probe = { get: (): Probe => realProbe() };
const realProbe = (): Probe => ({
  env: process.env, uid: process.getuid?.() ?? 1000, home: os.homedir(),
  ls: (d) => { try { return fs.readdirSync(d); } catch { return []; } },
  exists: (f) => fs.existsSync(f),
});

/** 补齐桌面会话的环境变量（已有的不动）：WAYLAND_DISPLAY、DISPLAY、XAUTHORITY、DBUS_SESSION_BUS_ADDRESS、XDG_RUNTIME_DIR。返回 undefined 表示没有桌面。 */
export function sessionEnv(p: Probe = probe.get()): NodeJS.ProcessEnv | undefined {
  const env = { ...p.env };
  const rt = env.XDG_RUNTIME_DIR || `/run/user/${p.uid}`;
  if (p.exists(rt)) env.XDG_RUNTIME_DIR = rt;
  if (!env.WAYLAND_DISPLAY) { const w = p.ls(rt).filter((f) => /^wayland-\d+$/.test(f)).sort()[0]; if (w) env.WAYLAND_DISPLAY = w; }
  if (!env.DISPLAY) { const x = p.ls("/tmp/.X11-unix").filter((f) => /^X\d+$/.test(f)).sort()[0]; if (x) env.DISPLAY = `:${x.slice(1)}`; }
  if (env.DISPLAY && !env.XAUTHORITY) {
    const cands = [path.join(rt, "gdm", "Xauthority"), ...p.ls(rt).filter((f) => /^\.mutter-Xwaylandauth\./.test(f)).map((f) => path.join(rt, f)), path.join(p.home, ".Xauthority")];
    const x = cands.find(p.exists); if (x) env.XAUTHORITY = x;
  }
  if (!env.DBUS_SESSION_BUS_ADDRESS && p.exists(path.join(rt, "bus"))) env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${path.join(rt, "bus")}`;
  if (!env.WAYLAND_DISPLAY && !env.DISPLAY) return undefined;
  return env;
}
const isWayland = (env: NodeJS.ProcessEnv) => Boolean(env.WAYLAND_DISPLAY) || env.XDG_SESSION_TYPE === "wayland";

// ---------- 输入：按可用程序挑选
export interface Backend { mouse?: "xdotool" | "ydotool"; keys?: "xdotool" | "wtype" | "ydotool" }
export function backend(wayland: boolean, has: Has = have): Backend {
  if (!wayland) return has("xdotool") ? { mouse: "xdotool", keys: "xdotool" } : {};
  return { mouse: has("ydotool") ? "ydotool" : undefined, keys: has("wtype") ? "wtype" : has("ydotool") ? "ydotool" : undefined };
}

const XBUTTON = { left: "1", middle: "2", right: "3" } as const;
const YBUTTON = { left: 0x00, right: 0x01, middle: 0x02 } as const;
const hex = (n: number) => `0x${n.toString(16).toUpperCase()}`;
const r = Math.round;

/** 点击的命令序列。 */
export function clickCommands(b: Backend, at: ScreenPoint, o: ClickOptions = {}): Cmd[] {
  const button = o.button ?? "left", count = Math.max(1, Math.min(3, o.count ?? 1));
  if (b.mouse === "xdotool") {
    const move = ["mousemove", "--sync", String(r(at.x)), String(r(at.y))];
    if (o.holdMs) return [["xdotool", [...move, "mousedown", XBUTTON[button], "sleep", (o.holdMs / 1000).toFixed(2), "mouseup", XBUTTON[button]]]];
    return [["xdotool", [...move, "click", ...(count > 1 ? ["--repeat", String(count), "--delay", "80"] : []), XBUTTON[button]]]];
  }
  if (b.mouse === "ydotool") {
    const move: Cmd = ["ydotool", ["mousemove", "--absolute", "-x", String(r(at.x)), "-y", String(r(at.y))]];
    const code = YBUTTON[button];
    if (o.holdMs) return [move, ["ydotool", ["click", hex(0x40 | code)]], ["sleep", [(o.holdMs / 1000).toFixed(2)]], ["ydotool", ["click", hex(0x80 | code)]]];
    return [move, ["ydotool", ["click", ...(count > 1 ? ["-r", String(count), "-D", "80"] : []), hex(0xc0 | code)]]];
  }
  return [];
}

/** 拖拽：按下 → 分几步移过去 → 松开。 */
export function dragCommands(b: Backend, from: ScreenPoint, to: ScreenPoint, ms = 300): Cmd[] {
  const steps = 8, pause = (ms / steps / 1000).toFixed(3);
  const mid = Array.from({ length: steps }, (_, i) => [r(from.x + ((to.x - from.x) * (i + 1)) / steps), r(from.y + ((to.y - from.y) * (i + 1)) / steps)]);
  if (b.mouse === "xdotool") return [["xdotool", ["mousemove", "--sync", String(r(from.x)), String(r(from.y)), "mousedown", "1", ...mid.flatMap(([x, y]) => ["sleep", pause, "mousemove", "--sync", String(x), String(y)]), "mouseup", "1"]]];
  if (b.mouse === "ydotool") return [
    ["ydotool", ["mousemove", "--absolute", "-x", String(r(from.x)), "-y", String(r(from.y))]], ["ydotool", ["click", "0x40"]],
    ...mid.map(([x, y]): Cmd => ["ydotool", ["mousemove", "--absolute", "-x", String(x), "-y", String(y)]]),
    ["ydotool", ["click", "0x80"]],
  ];
  return [];
}

/** 滚动：X11 的滚轮是按钮 4–7；ydotool 发 REL_WHEEL / REL_HWHEEL（正数向上、向右）。 */
export function scrollCommands(b: Backend, dir: "up" | "down" | "left" | "right", n: number, at?: ScreenPoint): Cmd[] {
  if (b.mouse === "xdotool") return [["xdotool", [...(at ? ["mousemove", "--sync", String(r(at.x)), String(r(at.y))] : []), "click", "--repeat", String(n), "--delay", "40", { up: "4", down: "5", left: "6", right: "7" }[dir]]]];
  if (b.mouse === "ydotool") {
    const [x, y] = { up: [0, n], down: [0, -n], left: [-n, 0], right: [n, 0] }[dir];
    return [...(at ? [["ydotool", ["mousemove", "--absolute", "-x", String(r(at.x)), "-y", String(r(at.y))]] as Cmd] : []), ["ydotool", ["mousemove", "--wheel", "-x", String(x), "-y", String(y)]]];
  }
  return [];
}

// 键名 → X 的 keysym（xdotool、wtype 共用）与 Linux 输入事件码（ydotool）
const KEYSYM: Record<string, string> = {
  enter: "Return", esc: "Escape", tab: "Tab", space: "space", backspace: "BackSpace", delete: "Delete", insert: "Insert", home: "Home", end: "End",
  pageup: "Prior", pagedown: "Next", up: "Up", down: "Down", left: "Left", right: "Right", capslock: "Caps_Lock", printscreen: "Print", menu: "Menu",
  ctrl: "ctrl", alt: "alt", shift: "shift", meta: "super",
  "/": "slash", "\\": "backslash", ".": "period", ",": "comma", ";": "semicolon", "'": "apostrophe", "`": "grave", "-": "minus", "=": "equal", "[": "bracketleft", "]": "bracketright", "+": "plus", " ": "space",
};
const EVDEV: Record<string, number> = {
  esc: 1, "-": 12, "=": 13, backspace: 14, tab: 15, "[": 26, "]": 27, enter: 28, ctrl: 29, ";": 39, "'": 40, "`": 41, shift: 42, "\\": 43, ",": 51, ".": 52, "/": 53,
  alt: 56, space: 57, capslock: 58, home: 102, up: 103, pageup: 104, left: 105, right: 106, end: 107, down: 108, pagedown: 109, insert: 110, delete: 111, meta: 125, menu: 127, printscreen: 99,
  ...Object.fromEntries([..."1234567890"].map((c, i) => [c, 2 + i])),
  ...Object.fromEntries([..."qwertyuiop"].map((c, i) => [c, 16 + i])), ...Object.fromEntries([..."asdfghjkl"].map((c, i) => [c, 30 + i])), ...Object.fromEntries([..."zxcvbnm"].map((c, i) => [c, 44 + i])),
  ...Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`f${i + 1}`, 59 + i])), f11: 87, f12: 88,
};
const PHONE_ONLY = new Set(["back", "recents", "notifications", "quick_settings", "lock", "power"]);
const keysym = (k: string) => KEYSYM[k] ?? (/^f\d+$/.test(k) ? k.toUpperCase() : /^[a-z0-9]$/.test(k) ? k : undefined);

/** 按键 / 组合键的命令。 */
export function keyCommands(b: Backend, keys: string[]): Cmd[] {
  const bad = keys.find((k) => PHONE_ONLY.has(k));
  if (bad) fail(`电脑上没有「${bad}」键（那是手机的按键）：返回可以试 alt+left，切换窗口用 alt+tab`);
  if (b.keys === "xdotool" || b.keys === "wtype") {
    const syms = keys.map((k) => keysym(k) ?? fail(`这个键在这台电脑上按不出来：${k}`));
    if (b.keys === "xdotool") return [["xdotool", ["key", "--clearmodifiers", syms.join("+")]]];
    const mods = syms.slice(0, -1), main = syms.at(-1)!;
    return [["wtype", [...mods.flatMap((m) => ["-M", m]), "-k", main === "super" ? "Super_L" : main, ...mods.reverse().flatMap((m) => ["-m", m])]]];
  }
  if (b.keys === "ydotool") {
    const codes = keys.map((k) => EVDEV[k] ?? fail(`ydotool 按不出这个键：${k}`));
    return [["ydotool", ["key", ...codes.map((c) => `${c}:1`), ...[...codes].reverse().map((c) => `${c}:0`)]]];
  }
  return [];
}

/** 输入文字。ydotool 只能打 ASCII：其他文字经剪贴板粘贴（wl-copy + ctrl+v）。返回 undefined 表示这条路走不通。 */
export function typeCommands(b: Backend, text: string, has: Has = have): { cmds: Cmd[]; stdin?: string } | undefined {
  if (b.keys === "xdotool") return { cmds: [["xdotool", ["type", "--clearmodifiers", "--delay", "12", "--", text]]] };
  if (b.keys === "wtype") return { cmds: [["wtype", ["--", text]]] };
  if (b.keys === "ydotool") {
    if (/^[\x20-\x7e\n\t]*$/.test(text)) return { cmds: [["ydotool", ["type", "--key-delay", "12", "--", text]]] };
    if (has("wl-copy")) return { cmds: [["wl-copy", []], ["ydotool", ["key", "29:1", "47:1", "47:0", "29:0"]]], stdin: text };
  }
  return undefined;
}

// ---------- AT-SPI（python3 + gi.repository.Atspi）
// 模式：snapshot <上限>（前台窗口的元素）、windows（顶层窗口）、act <路径> <click|focus|insert> [文字]。路径是从桌面起的子节点序号，用「.」连接。
export const ATSPI_PY = String.raw`
import sys, json
try:
    import gi
    gi.require_version("Atspi", "2.0")
    from gi.repository import Atspi
except Exception as e:
    print(json.dumps({"error": "noatspi", "detail": str(e)[:200]})); sys.exit(0)
S = Atspi.StateType
mode = sys.argv[1]
desk = Atspi.get_desktop(0)
def kids(n, cap=400):
    try: c = n.get_child_count()
    except Exception: return []
    out = []
    for i in range(min(c, cap)):
        try:
            k = n.get_child_at_index(i)
            if k is not None: out.append((i, k))
        except Exception: pass
    return out
def sset(n):
    try: return n.get_state_set()
    except Exception: return None
def name(n):
    try: return n.get_name() or ""
    except Exception: return ""
def node(path):
    n = desk
    for i in path.split("."):
        n = n.get_child_at_index(int(i))
        if n is None: raise Exception("元素已经不在了")
    return n
def windows():
    out = []
    for ai, app in kids(desk):
        an = name(app)
        for wi, w in kids(app, 50):
            st = sset(w)
            if st is None: continue
            out.append({"path": "%d.%d" % (ai, wi), "title": name(w), "app": an, "active": st.contains(S.ACTIVE), "showing": st.contains(S.SHOWING)})
    return out
if mode == "windows":
    print(json.dumps({"windows": [w for w in windows() if w["showing"] or w["active"]]})); sys.exit(0)
if mode == "act":
    n = node(sys.argv[2]); what = sys.argv[3]
    if what == "click":
        try: k = n.get_n_actions()
        except Exception: k = 0
        if k <= 0: raise SystemExit("这个元素没有可执行的动作")
        names = [(n.get_action_name(i) or "").lower() for i in range(k)]
        pick = next((i for i, a in enumerate(names) if a in ("click", "press", "activate", "jump", "toggle", "open")), 0)
        print(json.dumps({"ok": bool(n.do_action(pick))})); sys.exit(0)
    if what == "insert":
        text = sys.argv[4]
        try: n.grab_focus()
        except Exception: pass
        try:
            pos = n.get_caret_offset()
            if pos < 0: pos = n.get_character_count()
            ok = n.insert_text(pos, text, len(text.encode("utf-8")))
        except Exception:
            ok = n.set_text_contents((n.get_text(0, -1) or "") + text)
        print(json.dumps({"ok": bool(ok)})); sys.exit(0)
    raise SystemExit("不认识的动作")
limit = int(sys.argv[2])
size = [0, 0]
try:
    e = desk.get_extents(Atspi.CoordType.SCREEN); size = [e.width, e.height]
except Exception: pass
wins = windows()
target = next((w for w in wins if w["active"]), None)
res = {"width": size[0], "height": size[1], "windows": len(wins), "elements": []}
if target is None:
    print(json.dumps(res)); sys.exit(0)
res["app"] = target["app"]; res["window"] = target["title"]
stack = [(target["path"], node(target["path"]))]
seen = 0
while stack and len(res["elements"]) < limit and seen < 8000:
    p, n = stack.pop(); seen += 1
    st = sset(n)
    if st is None or not (st.contains(S.SHOWING) or st.contains(S.VISIBLE)): continue
    try: role = n.get_role_name() or ""
    except Exception: role = ""
    try:
        e = n.get_extents(Atspi.CoordType.SCREEN); box = [e.x, e.y, e.width, e.height]
    except Exception: box = [0, 0, 0, 0]
    try: acts = [(n.get_action_name(i) or "").lower() for i in range(n.get_n_actions())]
    except Exception: acts = []
    val = ""
    if role not in ("password text",):
        try:
            c = n.get_character_count()
            if c > 0 and (st.contains(S.EDITABLE) or role in ("entry", "text", "spin button")): val = n.get_text(0, min(c, 200))
        except Exception: pass
    res["elements"].append({"r": role, "n": name(n)[:200], "v": val, "b": box, "p": p,
        "c": any(a in ("click", "press", "activate", "jump", "toggle", "open") for a in acts),
        "e": st.contains(S.EDITABLE), "en": st.contains(S.ENABLED) or st.contains(S.SENSITIVE), "f": st.contains(S.FOCUSED),
        "s": st.contains(S.SELECTED), "k": (st.contains(S.CHECKED) if st.contains(S.CHECKABLE) or role in ("check box", "radio button", "toggle button", "switch") else None)})
    for i, k in reversed(kids(n)): stack.append(("%s.%d" % (p, i), k))
print(json.dumps(res))
`;

const ROLE_MAP: Record<string, string> = {
  "push button": "button", "toggle button": "switch", button: "button", link: "link", "check box": "checkbox", "radio button": "radio", switch: "switch",
  entry: "input", "password text": "input", text: "input", "spin button": "input", "combo box": "combobox", slider: "slider", "scroll bar": "slider",
  "page tab": "tab", menu: "menu", "menu item": "menuitem", "check menu item": "menuitem", "radio menu item": "menuitem", "menu bar": "toolbar",
  list: "list", "list box": "list", tree: "list", table: "list", "tree table": "list", "list item": "item", "table cell": "item", "tree item": "item",
  image: "image", icon: "image", "tool bar": "toolbar", dialog: "dialog", alert: "dialog", "file chooser": "dialog", frame: "window", window: "window",
  label: "text", static: "text", heading: "text", paragraph: "text", caption: "text", "status bar": "text",
  panel: "group", filler: "group", section: "group", form: "group", grouping: "group", "scroll pane": "scroll", viewport: "scroll", "document web": "group", "document frame": "group",
};

interface RawEl { r: string; n: string; v: string; b: number[]; p: string; c: boolean; e: boolean; en: boolean; f: boolean; s: boolean; k: boolean | null }
/** AT-SPI 脚本的输出 → ScreenSnapshot。text 角色只有可编辑时才算输入框。 */
export function parseAtspi(out: string): ScreenSnapshot & { error?: string; windowCount?: number } {
  const j = JSON.parse(out.trim().split("\n").pop() || "{}");
  if (j.error) return { width: 0, height: 0, elements: [], error: j.error };
  const elements: ScreenElement[] = (j.elements ?? []).map((e: RawEl): ScreenElement => {
    let role = ROLE_MAP[e.r] ?? "other";
    if (role === "input" && e.r === "text" && !e.e) role = "text";
    return {
      role, name: e.n || undefined, value: e.r === "password text" ? undefined : e.v || undefined,
      x: e.b[0], y: e.b[1], w: e.b[2], h: e.b[3], ref: `atspi:${e.p}`,
      clickable: e.c || undefined, editable: e.e || undefined, scrollable: role === "scroll" || undefined,
      enabled: e.en, focused: e.f || undefined, selected: e.s || undefined, checked: e.k ?? undefined,
    };
  });
  return { width: j.width ?? 0, height: j.height ?? 0, app: j.app || undefined, window: j.window || undefined, elements, windowCount: j.windows };
}

// ---------- 窗口（X11 的 wmctrl）
/** `wmctrl -lpx` 的输出：窗口 id、桌面、pid、WM_CLASS、主机、标题。主机名不交出去。 */
export function parseWmctrl(out: string, active?: number): ScreenWindow[] {
  return out.split("\n").map((l) => l.match(/^(0x[0-9a-f]+)\s+(-?\d+)\s+\d+\s+(\S+)\s+\S+\s?(.*)$/i)).filter((m): m is RegExpMatchArray => !!m && m[2] !== "-1")
    .map((m) => ({ id: m[1], title: m[4].trim(), app: m[3].split(".").pop(), ...(active !== undefined && parseInt(m[1], 16) === active ? { focused: true } : {}) }));
}

// ---------- 打开应用：.desktop
export interface DesktopEntry { id: string; file: string; names: string[]; hidden: boolean }
/** 解析一个 .desktop 文件的 [Desktop Entry] 段；不是应用返回 undefined。 */
export function parseDesktop(id: string, file: string, text: string): DesktopEntry | undefined {
  const sec = text.split(/^\[/m).find((s) => s.startsWith("Desktop Entry]"));
  if (!sec) return undefined;
  const kv = sec.split("\n").map((l) => l.match(/^([A-Za-z]+(?:\[[^\]]+\])?)\s*=\s*(.*)$/)).filter((m): m is RegExpMatchArray => !!m);
  const get = (k: string) => kv.find((m) => m[1] === k)?.[2];
  if ((get("Type") ?? "Application") !== "Application") return undefined;
  const names = kv.filter((m) => /^(Name|GenericName|X-GNOME-FullName)(\[|$)/.test(m[1])).map((m) => m[2].trim()).filter(Boolean);
  return { id, file, names, hidden: get("NoDisplay") === "true" || get("Hidden") === "true" };
}
/** 按 id（不区分大小写，可带 .desktop）、显示名完全相同、显示名包含，依次找；显示的应用优先。 */
export function findDesktop(q: string, entries: DesktopEntry[]): DesktopEntry | undefined {
  const k = q.trim().toLowerCase().replace(/\.desktop$/, "");
  const order = [...entries].sort((a, b) => Number(a.hidden) - Number(b.hidden));
  return order.find((e) => e.id.toLowerCase() === k) ?? order.find((e) => e.id.toLowerCase().split(".").pop() === k)
    ?? order.find((e) => e.names.some((n) => n.toLowerCase() === k)) ?? order.find((e) => !e.hidden && e.names.some((n) => n.toLowerCase().includes(k)));
}
function desktopEntries(env: NodeJS.ProcessEnv): DesktopEntry[] {
  const h = os.homedir();
  const dirs = [env.XDG_DATA_HOME || path.join(h, ".local", "share"), ...(env.XDG_DATA_DIRS || "/usr/local/share:/usr/share").split(":"),
    path.join(h, ".local", "share", "flatpak", "exports", "share"), "/var/lib/flatpak/exports/share", "/var/lib/snapd/desktop"].map((d) => path.join(d, "applications"));
  const seen = new Set<string>(), out: DesktopEntry[] = [];
  for (const d of dirs) {
    let files: string[] = [];
    try { files = fs.readdirSync(d).filter((f) => f.endsWith(".desktop")); } catch { continue; }
    for (const f of files) {
      const id = f.slice(0, -8);
      if (seen.has(id)) continue; // 前面的目录优先（用户自己的覆盖系统的）
      seen.add(id);
      try { const e = parseDesktop(id, path.join(d, f), fs.readFileSync(path.join(d, f), "utf8")); if (e) out.push(e); } catch { /* 读不了就跳过 */ }
    }
  }
  return out;
}

// ---------- 截图
/** 截图命令（能出 JPEG 的出 JPEG，核心缩图不依赖 ffmpeg 也行）。 */
export function shotCommand(base: string, wayland: boolean, has: Has = have): { cmd: Cmd; file: string } | undefined {
  const c: { cmd: Cmd; file: string }[] = wayland
    ? [{ cmd: ["grim", ["-t", "jpeg", "-q", "85", `${base}.jpg`]], file: `${base}.jpg` }, { cmd: ["gnome-screenshot", ["-f", `${base}.png`]], file: `${base}.png` }, { cmd: ["spectacle", ["-b", "-n", "-o", `${base}.png`]], file: `${base}.png` }]
    : [{ cmd: ["scrot", ["-o", "-q", "85", `${base}.jpg`]], file: `${base}.jpg` }, { cmd: ["gnome-screenshot", ["-f", `${base}.png`]], file: `${base}.png` }, { cmd: ["spectacle", ["-b", "-n", "-o", `${base}.png`]], file: `${base}.png` }, { cmd: ["import", ["-window", "root", "-quality", "85", `${base}.jpg`]], file: `${base}.jpg` }];
  return c.find((x) => has(x.cmd[0]));
}
/** PNG / JPEG 的像素尺寸（只读文件头）。 */
export function pictureSize(b: Buffer): { width: number; height: number } | undefined {
  if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47) return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  if (b[0] === 0xff && b[1] === 0xd8) {
    for (let i = 2; i + 9 < b.length;) {
      if (b[i] !== 0xff) { i++; continue; }
      const m = b[i + 1];
      if (m === 0xff || m === 0x01 || (m >= 0xd0 && m <= 0xd8)) { i += m === 0xff ? 1 : 2; continue; }
      if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
      i += 2 + b.readUInt16BE(i + 2);
    }
  }
  return undefined;
}

// ---------- 组装
export function createHands(mediaFile: (name: string) => string): Hands {
  let atspi: boolean | undefined; // python3 + Atspi 能不能用（探测一次）
  let screen: { width: number; height: number } | undefined;
  const env = () => sessionEnv() ?? fail("这台电脑现在没有图形界面（没有找到 X11 或 Wayland 的桌面会话）：要有人登录桌面才能操作屏幕");
  const b = () => backend(isWayland(env()));
  const exec = async (cmds: Cmd[], stdin?: string) => {
    const e = env();
    for (const [cmd, args] of cmds) {
      const res = cmd === "sleep" ? (await new Promise((ok) => setTimeout(ok, Number(args[0]) * 1000)), { code: 0, out: "" }) : await run(cmd, args, 30_000, cmd === "wl-copy" ? stdin : undefined, e);
      if (res.code !== 0) fail(`${cmd} 没有做成${res.out.trim() ? `：${res.out.trim().slice(0, 200)}` : ""}${cmd === "ydotool" ? "（ydotool 需要 ydotoold 在运行，且当前用户能写 /dev/uinput）" : ""}`);
    }
  };
  const py = async (args: string[], timeout = 20_000) => {
    const res = await run("python3", ["-c", ATSPI_PY, ...args], timeout, undefined, env());
    if (res.code !== 0) fail(`读无障碍信息失败：${res.out.trim().split("\n").pop()?.slice(0, 200) || "AT-SPI 没有响应"}`);
    return res.out;
  };
  const hasAtspi = async () => {
    if (atspi === undefined) atspi = have("python3") && (await run("python3", ["-c", "import gi; gi.require_version('Atspi', '2.0'); from gi.repository import Atspi"], 10_000, undefined, sessionEnv())).code === 0;
    return atspi;
  };
  /** 没有能用的鼠标输入时，有 ref 的元素退回 AT-SPI 的动作。 */
  const viaAtspi = async (at: ScreenPoint | undefined, what: "click" | "insert", text?: string) => {
    if (!at?.ref?.startsWith("atspi:") || !(await hasAtspi())) return false;
    const j = JSON.parse((await py(["act", at.ref.slice(6), what, ...(text !== undefined ? [text] : [])])).trim().split("\n").pop() || "{}");
    return j.ok === true || fail("这个元素不接受这个动作");
  };
  const noInput = (what: string) => fail(isWayland(env())
    ? `Wayland 下${what}需要 ydotool（要 ydotoold 在运行）${what.includes("键") || what.includes("输入") ? "或 wtype" : ""}；GNOME 不支持 wtype。也可以登录时选 X11 会话并安装 xdotool`
    : `${what}需要 xdotool（请安装后再试）`);

  const hands: Hands = {
    async status(): Promise<HandsStatus> {
      const e = sessionEnv();
      if (!e) return { ready: false, reason: "这台电脑现在没有图形界面（没有找到 X11 或 Wayland 的桌面会话）", screenshot: false, tree: false, input: false };
      const wl = isWayland(e), bk = backend(wl), shot = !!shotCommand("/tmp/x", wl), tree = await hasAtspi();
      const missing = [!bk.mouse && (wl ? "鼠标输入要 ydotool" : "鼠标与键盘输入要 xdotool"), wl && !bk.keys && "键盘输入要 wtype 或 ydotool", !tree && "读屏幕元素要 python3 的 gi 与 AT-SPI（python3-gi、gir1.2-atspi-2.0 一类的包）", !shot && "截图要 grim、scrot、gnome-screenshot、spectacle 或 ImageMagick"].filter(Boolean);
      return {
        ready: !!(bk.mouse || bk.keys || tree || shot), screenshot: shot, tree, input: !!(bk.mouse || bk.keys),
        reason: missing.length ? `缺：${missing.join("；")}` : undefined,
        detail: `${wl ? "Wayland" : "X11"}：${[bk.mouse, bk.keys && bk.keys !== bk.mouse ? bk.keys : "", tree ? "AT-SPI" : ""].filter(Boolean).join(" + ") || "只能截图"}`,
      };
    },
    async screenshot() {
      const e = env(), base = mediaFile(`screen-${new Date().toISOString().replace(/[:.]/g, "-")}`);
      const c = shotCommand(base, isWayland(e)) ?? fail(`截图需要 ${isWayland(e) ? "grim、gnome-screenshot 或 spectacle" : "scrot、gnome-screenshot、spectacle 或 ImageMagick"} 之一`);
      const res = await run(c.cmd[0], c.cmd[1], 30_000, undefined, e);
      if (res.code !== 0 || !fs.existsSync(c.file)) fail(`截图失败：${res.out.trim().slice(0, 200) || c.cmd[0] + " 没有输出图片"}`);
      const fd = fs.openSync(c.file, "r"), head = Buffer.alloc(128 << 10), n = fs.readSync(fd, head, 0, head.length, 0); fs.closeSync(fd);
      const size = pictureSize(head.subarray(0, n)) ?? fail("截到的图片读不出尺寸");
      screen = size;
      return { file: c.file, ...size };
    },
    async snapshot() {
      if (!(await hasAtspi())) fail("读屏幕元素需要 python3 的 gi 与 AT-SPI（python3-gi、gir1.2-atspi-2.0 一类的包）；也可以用 screen_capture 截图看");
      const s = parseAtspi(await py(["snapshot", "600"]));
      if (s.error) fail("AT-SPI 不可用：请安装 python3-gi 与 gir1.2-atspi-2.0 一类的包");
      // 屏幕尺寸：X11 下 AT-SPI 的桌面范围可靠；Wayland 下常常是假的（如 1024×768），以截图的尺寸为准
      if (isWayland(env()) || !s.width || !s.height) {
        if (!screen && shotCommand("/tmp/x", isWayland(env()))) { const f = await hands.screenshot().catch(() => undefined); if (f) fs.rmSync(f.file, { force: true }); }
        if (screen) Object.assign(s, screen);
      } else screen = { width: s.width, height: s.height };
      if (!s.width || !s.height) fail("读不出屏幕尺寸：请装一个截图程序（grim、gnome-screenshot 或 spectacle）");
      const notes = [
        !s.window && "没有找到前台窗口（可能桌面上没有打开的窗口，或前台应用没有暴露无障碍信息）",
        s.window && s.elements.length < 3 && "这个窗口几乎没有无障碍信息（Chromium / Electron 应用要开启无障碍支持），请截图看",
        isWayland(env()) && "Wayland 下有些应用报告的坐标是相对窗口的，点不准时先截图核对",
      ].filter(Boolean);
      return { width: s.width, height: s.height, app: s.app, window: s.window, elements: s.elements, note: notes.join("；") || undefined };
    },
    async click(at, o = {}) {
      const bk = b();
      if (!bk.mouse) { if (!o.holdMs && o.button !== "right" && await viaAtspi(at, "click")) return; noInput("点击"); }
      await exec(clickCommands(bk, at, o));
    },
    async drag(from, to, ms) { const bk = b(); if (!bk.mouse) noInput("拖拽"); await exec(dragCommands(bk, from, to, ms)); },
    async scroll(dir, n, at) {
      const bk = b();
      if (bk.mouse) return exec(scrollCommands(bk, dir, n, at));
      if (bk.keys && (dir === "up" || dir === "down")) return exec(Array.from({ length: Math.max(1, Math.round(n / 3)) }, () => keyCommands(bk, [dir === "down" ? "pagedown" : "pageup"])[0]));
      noInput("滚动");
    },
    async type(text, at) {
      const bk = b();
      if (at) { if (bk.mouse) await exec(clickCommands(bk, at)); else if (await viaAtspi(at, "insert", text)) return; }
      const t = typeCommands(bk, text) ?? (await viaAtspi(at, "insert", text) ? undefined : noInput("输入文字"));
      if (t) await exec(t.cmds, t.stdin);
    },
    async key(keys) { const bk = b(); if (!bk.keys) noInput("按键"); await exec(keyCommands(bk, keys)); },
    async openApp(id) {
      const e = env(), entry = findDesktop(id, desktopEntries(e)) ?? fail(`没有找到叫「${id}」的应用（只打开已安装、有 .desktop 启动项的应用）`);
      const name = entry.names[0] ?? entry.id;
      const tries: Cmd[] = [["gtk-launch", [entry.id]], ["gio", ["launch", entry.file]], ["kioclient", ["exec", entry.file]], ["kioclient5", ["exec", entry.file]]];
      const c = tries.find(([cmd]) => have(cmd)) ?? fail("打开应用需要 gtk-launch（GTK）、gio（GLib）或 kioclient（KDE）之一");
      const res = await run(c[0], c[1], 15_000, undefined, e);
      return res.code === 0 ? `已打开 ${name}（${entry.id}）` : fail(`打开 ${name} 失败：${res.out.trim().slice(0, 200)}`);
    },
    async windows() {
      const e = env();
      if (!isWayland(e) && have("wmctrl")) {
        const res = await run("wmctrl", ["-lpx"], 10_000, undefined, e);
        const act = have("xdotool") ? Number((await run("xdotool", ["getactivewindow"], 5_000, undefined, e)).out.trim()) : undefined;
        if (res.code === 0) return parseWmctrl(res.out, Number.isFinite(act) ? act : undefined);
      }
      if (!(await hasAtspi())) fail("列出窗口需要 wmctrl（X11）或 AT-SPI");
      const j = JSON.parse((await py(["windows"])).trim().split("\n").pop() || "{}");
      return (j.windows ?? []).map((w: { path: string; title: string; app: string; active: boolean }) => ({ id: `atspi:${w.path}`, title: w.title, app: w.app, ...(w.active ? { focused: true } : {}) }));
    },
    async focusWindow(id) {
      const e = env();
      if (/^0x[0-9a-f]+$/i.test(id)) {
        const c: Cmd | undefined = have("wmctrl") ? ["wmctrl", ["-ia", id]] : have("xdotool") ? ["xdotool", ["windowactivate", "--sync", String(parseInt(id, 16))]] : undefined;
        if (!c) fail("切换窗口需要 wmctrl 或 xdotool");
        const res = await run(c![0], c![1], 10_000, undefined, e);
        if (res.code !== 0) fail(`切换失败：${res.out.trim().slice(0, 200)}`);
        return;
      }
      fail(isWayland(e) ? "Wayland 下不能直接切换别的应用的窗口：用 screen_key 按 alt+tab，或用 app_open 打开那个应用" : "这个窗口 id 不对：用 window_list 给的 id");
    },
  };
  return hands;
}
