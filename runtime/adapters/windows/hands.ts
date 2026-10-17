// Windows 的手（Hands，body/adapter.ts）：系统自带的 PowerShell 5.1 + .NET，不装任何东西。
//   - 无障碍树：UI Automation（System.Windows.Automation，CacheRequest 一次取回前台窗口的控件视图）。
//   - 输入：user32 的 SendInput（鼠标、键盘、Unicode 文字）与 SetCursorPos；进程设为每显示器 DPI 感知，坐标是物理像素。
//   - 截图：与原先的截图同一套（Graphics.CopyFromScreen 截整个虚拟屏幕），按需缩小、存 JPEG。
//   - 坐标：接口里的坐标以虚拟屏幕左上角为原点（与截图一致）；多显示器时系统坐标可能为负，这里加减偏移。
//   - 窗口：UI Automation 的顶层窗口；切换用 SetForegroundWindow（先放开 Alt 键绕过前台锁）。
//   - 打开应用：只打开开始菜单里有的应用（Get-StartApps → shell:AppsFolder\<AppID>），不执行任意程序。
//   都要在用户登录的桌面里做：运行基座在会话 0（开机计划任务）时，由 index.ts 经身体助手（body.ts）转交，与截图、通知同一条路。
//   以管理员身份运行的窗口（以及 UAC 弹窗、锁屏）收不到普通进程发的输入（UIPI），这是系统的限制。
import fs from "node:fs";
import path from "node:path";
import { ps, mediaDir } from "./desktop.ts";
import { psq } from "./ps.ts";
import type { ScreenElement, ScreenSnapshot, ScreenWindow, HandsStatus } from "../../src/body/adapter.ts";

const fail = (msg: string): never => { throw new Error(msg); };
const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");

/** 常驻 PowerShell 里编译一次的输入与窗口帮手（C#）。 */
export const HELPER = String.raw`
if (-not ('QuetzalHands' -as [type])) { Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Threading;
public static class QuetzalHands {
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx; public int dy; public uint data; public uint flags; public uint time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort vk; public ushort scan; public uint flags; public uint time; public IntPtr extra; }
  [StructLayout(LayoutKind.Explicit)] struct UNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public UNION u; }
  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int i);
  [DllImport("user32.dll")] static extern short VkKeyScan(char c);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  public static void Dpi() { try { if (!SetProcessDpiAwarenessContext(new IntPtr(-4))) SetProcessDPIAware(); } catch { SetProcessDPIAware(); } }
  /** 虚拟屏幕：左、上、宽、高（物理像素）。 */
  public static int[] Screen() { return new int[] { GetSystemMetrics(76), GetSystemMetrics(77), GetSystemMetrics(78), GetSystemMetrics(79) }; }
  static void Send(INPUT[] a) {
    if (a.Length == 0) return;
    if (SendInput((uint)a.Length, a, Marshal.SizeOf(typeof(INPUT))) != a.Length) throw new Exception("系统没有接受模拟的输入（可能是锁屏、UAC 弹窗，或前台是以管理员身份运行的窗口）");
  }
  static INPUT Mouse(uint flags, int data) { INPUT i = new INPUT(); i.type = 0; i.u.mi.flags = flags; i.u.mi.data = unchecked((uint)data); return i; }
  static INPUT Key(ushort vk, ushort scan, uint flags) { INPUT i = new INPUT(); i.type = 1; i.u.ki.vk = vk; i.u.ki.scan = scan; i.u.ki.flags = flags; return i; }
  public static void Move(int x, int y) { int[] s = Screen(); if (!SetCursorPos(x + s[0], y + s[1])) throw new Exception("移不动鼠标（桌面被锁住了？）"); Thread.Sleep(20); }
  static uint Down(string b) { return b == "right" ? 0x0008u : b == "middle" ? 0x0020u : 0x0002u; }
  public static void Click(int x, int y, string b, int count, int holdMs) {
    Move(x, y);
    for (int k = 0; k < count; k++) {
      Send(new INPUT[] { Mouse(Down(b), 0) });
      Thread.Sleep(holdMs > 0 ? holdMs : 30);
      Send(new INPUT[] { Mouse(Down(b) << 1, 0) });
      if (k + 1 < count) Thread.Sleep(70);
    }
  }
  public static void Drag(int x1, int y1, int x2, int y2, int ms) {
    Move(x1, y1); Send(new INPUT[] { Mouse(0x0002, 0) }); Thread.Sleep(60);
    int steps = 12;
    for (int k = 1; k <= steps; k++) { Move(x1 + (x2 - x1) * k / steps, y1 + (y2 - y1) * k / steps); Thread.Sleep(Math.Max(1, ms / steps)); }
    Send(new INPUT[] { Mouse(0x0004, 0) });
  }
  /** 滚轮：dy 正数向上，dx 正数向右（格）。 */
  public static void Wheel(int dx, int dy) {
    for (int k = 0; k < Math.Abs(dy); k++) { Send(new INPUT[] { Mouse(0x0800, dy > 0 ? 120 : -120) }); Thread.Sleep(30); }
    for (int k = 0; k < Math.Abs(dx); k++) { Send(new INPUT[] { Mouse(0x01000, dx > 0 ? 120 : -120) }); Thread.Sleep(30); }
  }
  /** 组合键：tokens 为 v<虚拟键码>、x<扩展键的虚拟键码> 或 c<字符>；按顺序按下、倒序松开。 */
  public static void Combo(string[] tokens) {
    var keys = new System.Collections.Generic.List<INPUT>();
    var ups = new System.Collections.Generic.List<INPUT>();
    foreach (string t in tokens) {
      ushort vk; uint ext = 0;
      if (t[0] == 'c') {
        short s = VkKeyScan(t[1]);
        if (s == -1) throw new Exception("这个键盘布局里没有这个键：" + t.Substring(1));
        vk = (ushort)(s & 0xff);
        if ((s & 0x100) != 0) { keys.Add(Key(0x10, 0, 0)); ups.Insert(0, Key(0x10, 0, 2)); }
      } else { vk = Convert.ToUInt16(t.Substring(1)); if (t[0] == 'x') ext = 1; }
      keys.Add(Key(vk, 0, ext)); ups.Insert(0, Key(vk, 0, ext | 2));
    }
    keys.AddRange(ups);
    Send(keys.ToArray());
  }
  /** 输入任意文字（KEYEVENTF_UNICODE，逐个 UTF-16 码元）；换行按回车。 */
  public static void Text(string s) {
    foreach (char c in s) {
      if (c == '\r') continue;
      if (c == '\n') Send(new INPUT[] { Key(0x0D, 0, 0), Key(0x0D, 0, 2) });
      else Send(new INPUT[] { Key(0, c, 4), Key(0, c, 6) });
      Thread.Sleep(4);
    }
  }
  public static bool Focus(long hwnd) {
    IntPtr h = new IntPtr(hwnd);
    if (IsIconic(h)) ShowWindow(h, 9);
    Send(new INPUT[] { Key(0x12, 0, 0), Key(0x12, 0, 2) }); // 先按一下 Alt：系统才允许把别的窗口放到前台
    return SetForegroundWindow(h);
  }
}
'@ }
[QuetzalHands]::Dpi()
`;

// ---------- 键
const VK: Record<string, number> = {
  enter: 0x0d, esc: 0x1b, tab: 0x09, space: 0x20, backspace: 0x08, capslock: 0x14, printscreen: 0x2c, menu: 0x5d,
  ctrl: 0x11, alt: 0x12, shift: 0x10, meta: 0x5b,
  ...Object.fromEntries(Array.from({ length: 24 }, (_, i) => [`f${i + 1}`, 0x70 + i])),
};
const EXT: Record<string, number> = { delete: 0x2e, insert: 0x2d, home: 0x24, end: 0x23, pageup: 0x21, pagedown: 0x22, left: 0x25, up: 0x26, right: 0x27, down: 0x28 };
const PHONE_ONLY = new Set(["back", "recents", "notifications", "quick_settings", "lock", "power"]);

/** 键名 → C# Combo 的记号：v<键码>、x<扩展键码>、c<字符>（字母数字直接用键码）。 */
export function keyTokens(keys: string[]): string[] {
  return keys.map((k) => {
    if (PHONE_ONLY.has(k)) fail(`电脑上没有「${k}」键（那是手机的按键）：返回可以试 alt+left，切换窗口用 alt+tab`);
    if (k in VK) return `v${VK[k]}`;
    if (k in EXT) return `x${EXT[k]}`;
    if (/^[a-z0-9]$/.test(k)) return `v${k.toUpperCase().charCodeAt(0)}`;
    if ([...k].length === 1 && k.length === 1) return `c${k}`;
    return fail(`这个键在这台电脑上按不出来：${k}`);
  });
}

const arr = (xs: string[]) => `@(${xs.map(psq).join(", ")})`;
const int = (n: number) => String(Math.round(Number(n) || 0));

// ---------- 脚本拼装（纯函数，便于测试）
export const scripts = {
  click: (a: { x: number; y: number; button?: string; count?: number; holdMs?: number }) => `${HELPER}[QuetzalHands]::Click(${int(a.x)}, ${int(a.y)}, ${psq(a.button ?? "left")}, ${int(Math.max(1, Math.min(3, a.count ?? 1)))}, ${int(a.holdMs ?? 0)})`,
  drag: (a: { x1: number; y1: number; x2: number; y2: number; ms?: number }) => `${HELPER}[QuetzalHands]::Drag(${int(a.x1)}, ${int(a.y1)}, ${int(a.x2)}, ${int(a.y2)}, ${int(a.ms ?? 300)})`,
  scroll: (a: { direction: string; amount: number; x?: number; y?: number }) => {
    const n = Math.max(1, Math.min(50, Math.round(a.amount)));
    const [dx, dy] = ({ up: [0, n], down: [0, -n], left: [-n, 0], right: [n, 0] } as Record<string, number[]>)[a.direction] ?? fail("方向不对");
    return `${HELPER}${a.x !== undefined && a.y !== undefined ? `[QuetzalHands]::Move(${int(a.x)}, ${int(a.y)})\n` : ""}[QuetzalHands]::Wheel(${dx}, ${dy})`;
  },
  type: (a: { text: string; x?: number; y?: number }) => `${HELPER}${a.x !== undefined && a.y !== undefined ? `[QuetzalHands]::Click(${int(a.x)}, ${int(a.y)}, 'left', 1, 0)\nStart-Sleep -Milliseconds 150\n` : ""}[QuetzalHands]::Text(${psq(a.text)})`,
  key: (a: { keys: string[] }) => `${HELPER}[QuetzalHands]::Combo([string[]]${arr(keyTokens(a.keys))})`,
  focus: (a: { id: string }) => `${HELPER}if (-not [QuetzalHands]::Focus([long]${int(Number(a.id))})) { throw '系统没有让这个窗口到前台（可以用 screen_key 按 alt+tab）' }`,
  screenshot: (a: { file: string; maxEdge?: number }) => `${HELPER}
Add-Type -AssemblyName System.Drawing
$s = [QuetzalHands]::Screen()
$bmp = New-Object System.Drawing.Bitmap $s[2], $s[3]
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($s[0], $s[1], 0, 0, $bmp.Size)
$g.Dispose()
$k = [Math]::Min(1.0, ${int(a.maxEdge ?? 0) === "0" ? "1.0" : `${int(a.maxEdge!)} / [double][Math]::Max($s[2], $s[3])`})
$out = $bmp
if ($k -lt 1.0) {
  $out = New-Object System.Drawing.Bitmap ([int][Math]::Round($s[2] * $k)), ([int][Math]::Round($s[3] * $k))
  $g2 = [System.Drawing.Graphics]::FromImage($out)
  $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g2.DrawImage($bmp, 0, 0, $out.Width, $out.Height)
  $g2.Dispose()
}
$enc = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
$ep = New-Object System.Drawing.Imaging.EncoderParameters 1
$ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality), ([long]85)
$out.Save(${psq(a.file)}, $enc, $ep)
if ($out -ne $bmp) { $out.Dispose() }
$bmp.Dispose()
"$($s[2])|$($s[3])"`,
  /** 前台窗口的控件视图：第一行 SCREEN、宽、高、进程名、窗口标题；之后每行一个元素（制表符分隔）。 */
  snapshot: (limit = 1500) => `${HELPER}
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$A = [System.Windows.Automation.AutomationElement]
$s = [QuetzalHands]::Screen()
$h = [QuetzalHands]::GetForegroundWindow()
[uint32]$pid0 = 0; [void][QuetzalHands]::GetWindowThreadProcessId($h, [ref]$pid0)
$proc = ''; try { $proc = (Get-Process -Id $pid0 -ErrorAction Stop).ProcessName } catch {}
function clean($t) { if ($null -eq $t) { '' } else { ([string]$t -replace '[\\t\\r\\n]+', ' ').Trim() } }
if ($h -eq [IntPtr]::Zero) { "SCREEN\`t$($s[2])\`t$($s[3])\`t\`t"; return }
$root = $A::FromHandle($h)
$cr = New-Object System.Windows.Automation.CacheRequest
foreach ($p in @($A::NameProperty, $A::ControlTypeProperty, $A::BoundingRectangleProperty, $A::IsEnabledProperty, $A::HasKeyboardFocusProperty, $A::IsOffscreenProperty, $A::IsPasswordProperty, $A::RuntimeIdProperty,
  $A::IsInvokePatternAvailableProperty, $A::IsValuePatternAvailableProperty, $A::IsTogglePatternAvailableProperty, $A::IsScrollPatternAvailableProperty, $A::IsSelectionItemPatternAvailableProperty, $A::IsExpandCollapsePatternAvailableProperty,
  [System.Windows.Automation.ValuePattern]::ValueProperty, [System.Windows.Automation.ValuePattern]::IsReadOnlyProperty, [System.Windows.Automation.TogglePattern]::ToggleStateProperty, [System.Windows.Automation.SelectionItemPattern]::IsSelectedProperty)) { $cr.Add($p) }
$cr.TreeScope = [System.Windows.Automation.TreeScope]::Subtree
$cr.TreeFilter = [System.Windows.Automation.Automation]::ControlViewCondition
$cr.AutomationElementMode = [System.Windows.Automation.AutomationElementMode]::None
$act = $cr.Activate()
try { $top = $root.GetUpdatedCache($cr) } finally { $act.Dispose() }
"SCREEN\`t$($s[2])\`t$($s[3])\`t$proc\`t$(clean $top.Cached.Name)"
$NS = $A::NotSupported
function v($e, $p) { $x = $e.GetCachedPropertyValue($p, $true); if ($x -eq $NS) { $null } else { $x } }
$n = 0
$stack = New-Object System.Collections.Stack
$stack.Push($top)
while ($stack.Count -gt 0 -and $n -lt ${int(limit)}) {
  $e = $stack.Pop()
  $c = $e.Cached
  $kids = @($e.CachedChildren)
  for ($i = $kids.Count - 1; $i -ge 0; $i--) { $stack.Push($kids[$i]) }
  if ($c.IsOffscreen) { continue }
  $r = $c.BoundingRectangle
  if ($r.IsEmpty -or [double]::IsInfinity($r.Width) -or $r.Width -lt 1 -or $r.Height -lt 1) { continue }
  $role = $c.ControlType.ProgrammaticName -replace '^ControlType\\.', ''
  $val = ''; if ((v $e $A::IsValuePatternAvailableProperty) -and -not $c.IsPassword) { $val = clean (v $e ([System.Windows.Automation.ValuePattern]::ValueProperty)) }
  if ($val.Length -gt 200) { $val = $val.Substring(0, 200) }
  $f = ''
  if ((v $e $A::IsInvokePatternAvailableProperty) -or (v $e $A::IsSelectionItemPatternAvailableProperty) -or (v $e $A::IsExpandCollapsePatternAvailableProperty) -or (v $e $A::IsTogglePatternAvailableProperty)) { $f += 'c' }
  if ((v $e $A::IsValuePatternAvailableProperty) -and -not (v $e ([System.Windows.Automation.ValuePattern]::IsReadOnlyProperty))) { $f += 'e' }
  if (v $e $A::IsScrollPatternAvailableProperty) { $f += 's' }
  if (-not $c.IsEnabled) { $f += 'd' }
  if ($c.HasKeyboardFocus) { $f += 'f' }
  if (v $e ([System.Windows.Automation.SelectionItemPattern]::IsSelectedProperty)) { $f += 'S' }
  $t = v $e ([System.Windows.Automation.TogglePattern]::ToggleStateProperty)
  if ($null -ne $t) { if ([int]$t -eq 1) { $f += 'K' } else { $f += 'k' } }
  $rid = ''; $ri = v $e $A::RuntimeIdProperty; if ($ri) { $rid = ($ri -join '.') }
  "$role\`t$(clean $c.Name)\`t$val\`t$([int]($r.X - $s[0]))\`t$([int]($r.Y - $s[1]))\`t$([int]$r.Width)\`t$([int]$r.Height)\`t$rid\`t$f"
  $n++
}`,
  /** 顶层窗口：每行 句柄、进程名、是否前台、标题、左上宽高。 */
  windows: () => `${HELPER}
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$A = [System.Windows.Automation.AutomationElement]
$s = [QuetzalHands]::Screen()
$fg = [long][QuetzalHands]::GetForegroundWindow()
$cr = New-Object System.Windows.Automation.CacheRequest
foreach ($p in @($A::NameProperty, $A::NativeWindowHandleProperty, $A::ProcessIdProperty, $A::BoundingRectangleProperty, $A::IsOffscreenProperty)) { $cr.Add($p) }
$cr.AutomationElementMode = [System.Windows.Automation.AutomationElementMode]::None
$act = $cr.Activate()
try { $list = $A::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Automation]::ControlViewCondition) } finally { $act.Dispose() }
foreach ($w in $list) {
  $c = $w.Cached
  if ($c.NativeWindowHandle -eq 0) { continue }
  $proc = ''; try { $proc = (Get-Process -Id $c.ProcessId -ErrorAction Stop).ProcessName } catch {}
  $r = $c.BoundingRectangle
  "$($c.NativeWindowHandle)\`t$proc\`t$([int]($c.NativeWindowHandle -eq $fg))\`t$(([string]$c.Name -replace '[\\t\\r\\n]+', ' ').Trim())\`t$([int]($r.X - $s[0]))\`t$([int]($r.Y - $s[1]))\`t$([int]$r.Width)\`t$([int]$r.Height)"
}`,
  /** 开始菜单里的应用：按 AppID、名字、名字包含依次找，经 shell:AppsFolder 启动。 */
  openApp: (id: string) => `
$q = ${psq(id)}
$apps = @(Get-StartApps)
$hit = $apps | Where-Object { $_.AppID -eq $q } | Select-Object -First 1
if (-not $hit) { $hit = $apps | Where-Object { $_.Name -eq $q } | Select-Object -First 1 }
if (-not $hit) { $hit = $apps | Where-Object { $_.Name -like ('*' + $q + '*') } | Sort-Object { $_.Name.Length } | Select-Object -First 1 }
if (-not $hit) { throw ('开始菜单里没有叫「' + $q + '」的应用（只打开已安装的应用）') }
Start-Process -FilePath ('shell:AppsFolder\\' + $hit.AppID)
$hit.Name + '|' + $hit.AppID`,
};

// ---------- 解析
const ROLE: Record<string, string> = {
  Button: "button", SplitButton: "button", Hyperlink: "link", Text: "text", Edit: "input", Document: "group", CheckBox: "checkbox", RadioButton: "radio",
  ComboBox: "combobox", Slider: "slider", Spinner: "input", ScrollBar: "scroll", ProgressBar: "slider", Tab: "group", TabItem: "tab", Menu: "menu", MenuBar: "toolbar", MenuItem: "menuitem",
  List: "list", Tree: "list", DataGrid: "list", Table: "list", ListItem: "item", TreeItem: "item", DataItem: "item", HeaderItem: "item", Header: "group",
  Image: "image", ToolBar: "toolbar", StatusBar: "text", ToolTip: "text", Window: "window", Pane: "group", Group: "group", Custom: "other", TitleBar: "group", Thumb: "other", Calendar: "group", AppBar: "toolbar", SemanticZoom: "group", Separator: "other",
};
/** snapshot 脚本的输出 → ScreenSnapshot。Document 能编辑时算输入框。 */
export function parseSnapshot(out: string): ScreenSnapshot {
  const lines = out.split("\n").map((l) => l.replace(/\r$/, ""));
  const head = lines.find((l) => l.startsWith("SCREEN\t"))?.split("\t") ?? fail("读不到前台窗口的信息");
  const elements: ScreenElement[] = [];
  for (const l of lines.slice(lines.indexOf(head.join("\t")) + 1)) {
    const f = l.split("\t");
    if (f.length < 9) continue;
    const [raw, name, value, x, y, w, h, rid, flags] = f;
    let role = ROLE[raw] ?? "other";
    if (raw === "Document" && flags.includes("e")) role = "input";
    elements.push({
      role, name: name || undefined, value: value || undefined, x: Number(x), y: Number(y), w: Number(w), h: Number(h), ...(rid ? { ref: `uia:${rid}` } : {}),
      clickable: flags.includes("c") || undefined, editable: flags.includes("e") || undefined, scrollable: flags.includes("s") || undefined,
      enabled: !flags.includes("d"), focused: flags.includes("f") || undefined, selected: flags.includes("S") || undefined,
      checked: flags.includes("K") ? true : flags.includes("k") ? false : undefined,
    });
  }
  const note = !head[4] && !elements.length ? "前台没有窗口" : elements.length < 3 ? "这个窗口几乎没有无障碍信息，请截图看" : undefined;
  return { width: Number(head[1]), height: Number(head[2]), app: head[3] || undefined, window: head[4] || undefined, elements, ...(note ? { note } : {}) };
}
/** windows 脚本的输出 → ScreenWindow[]（没有标题的跳过：多是看不见的工具窗口）。 */
export function parseWindows(out: string): ScreenWindow[] {
  return out.split("\n").map((l) => l.replace(/\r$/, "").split("\t")).filter((f) => f.length >= 8 && f[3])
    .map(([id, app, fg, title, x, y, w, h]) => ({ id, title, app: app || undefined, ...(fg === "1" ? { focused: true } : {}), x: Number(x), y: Number(y), w: Number(w), h: Number(h) }));
}

// ---------- 身体助手与适配器共用的操作表（index.ts 直接调或经 body.ts 转交）
export const handsOps: Record<string, (a: Record<string, any>) => Promise<unknown>> = {
  "hands.status": async (): Promise<HandsStatus> => {
    await ps.run(`${HELPER}Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes`, 60_000);
    return { ready: true, screenshot: true, tree: true, input: true, detail: "UI Automation + SendInput（PowerShell）" };
  },
  "hands.screenshot": async (a) => {
    const file = path.join(mediaDir(), `screen-${stamp()}.jpg`);
    const [w, h] = (await ps.run(scripts.screenshot({ file, maxEdge: Number(a.maxEdge) || undefined }), 60_000)).trim().split("|").map(Number);
    return fs.existsSync(file) && w > 0 ? { file, width: w, height: h } : fail("截图失败");
  },
  "hands.snapshot": async () => parseSnapshot(await ps.run(scripts.snapshot(), 60_000)),
  "hands.click": async (a) => { await ps.run(scripts.click({ x: a.x, y: a.y, button: a.button, count: a.count, holdMs: a.holdMs }), 30_000); return null; },
  "hands.drag": async (a) => { await ps.run(scripts.drag({ x1: a.x1, y1: a.y1, x2: a.x2, y2: a.y2, ms: a.ms }), 30_000); return null; },
  "hands.scroll": async (a) => { await ps.run(scripts.scroll({ direction: String(a.direction), amount: Number(a.amount) || 3, x: a.x, y: a.y }), 30_000); return null; },
  "hands.type": async (a) => { await ps.run(scripts.type({ text: String(a.text ?? ""), x: a.x, y: a.y }), 120_000); return null; },
  "hands.key": async (a) => { await ps.run(scripts.key({ keys: (a.keys as string[]) ?? [] }), 30_000); return null; },
  "hands.openApp": async (a) => { const [name, id] = (await ps.run(scripts.openApp(String(a.id ?? "")), 60_000)).trim().split("|"); return `已打开 ${name}（${id}）`; },
  "hands.windows": async () => parseWindows(await ps.run(scripts.windows(), 60_000)),
  "hands.focus": async (a) => { await ps.run(scripts.focus({ id: String(a.id ?? "") }), 30_000); return null; },
};
