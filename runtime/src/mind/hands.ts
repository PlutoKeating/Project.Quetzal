// 手：把身体适配器的 Hands（body/adapter.ts）包装成她用的 screen_* 工具（计算机使用）。
//   - 理解屏幕优先读无障碍树（screen_read：元素带编号与坐标），截图交给能看图的模型兜底（screen_capture，复用 view_image 的看图流程与缩图）。
//   - 坐标：她看到的一律是「视图坐标」= 截图缩到长边 VIEW_EDGE 之后的像素；元素列表也按视图坐标给。动手时换回屏幕像素交给适配器。
//     缩到 1280 是为了让各家模型都不再二次缩图（二次缩图后模型说的坐标就对不上了）。
//   - 按编号操作：编号来自最近一次 screen_read；换成元素中心点，连同适配器的 ref 一起交下去（适配器能直接对元素做动作时更准）。
//   - 闸门：全部归「操作屏幕与应用」（hands，缺省每次询问）；急停时闸门直接拒绝；审计由 callTool 统一写。
//   - 这些操作由运行基座进程（适配器）执行，不经过她的命令沙箱：能做的就是这块屏幕前的人能做的一切，所以缺省每次询问。
import fs from "node:fs";
import type { Hands, ScreenElement, ScreenPoint, ScreenSnapshot } from "../body/adapter.ts";
import type { Tool, ToolContext } from "./tools.ts";
import { loadImage, shrink } from "./images.ts";

export const VIEW_EDGE = 1280;
const MAX_ITEMS = 250;
const SETTLE_MS = 400; // 动作之后等界面稳定一下再返回，紧接着读屏才看得到变化

const obj = (props: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties: props, required });
const num = (description: string) => ({ type: "number", description });
const str = (description: string) => ({ type: "string", description });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- 图片尺寸（只读文件头）
/** PNG / JPEG / BMP / GIF / WebP 的像素尺寸；认不出返回 undefined。 */
export function imageSize(b: Buffer): { width: number; height: number } | undefined {
  if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47) return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  if (b.length >= 10 && b.subarray(0, 4).toString("latin1") === "GIF8") return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
  if (b.length >= 26 && b.subarray(0, 2).toString("latin1") === "BM") return { width: b.readInt32LE(18), height: Math.abs(b.readInt32LE(22)) };
  if (b.length >= 30 && b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP") {
    const kind = b.subarray(12, 16).toString("latin1");
    if (kind === "VP8X") return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
    if (kind === "VP8 ") return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
    if (kind === "VP8L") { const v = b.readUInt32LE(21); return { width: 1 + (v & 0x3fff), height: 1 + ((v >> 14) & 0x3fff) }; }
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const m = b[i + 1];
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7) || m === 0xff) { i += m === 0xff ? 1 : 2; continue; }
      const len = b.readUInt16BE(i + 2);
      if ((m >= 0xc0 && m <= 0xcf) && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
      i += 2 + len;
    }
  }
  return undefined;
}
const sizeOf = (file: string) => { const fd = fs.openSync(file, "r"); try { const b = Buffer.alloc(256 << 10); const n = fs.readSync(fd, b, 0, b.length, 0); return imageSize(b.subarray(0, n)); } finally { fs.closeSync(fd); } };

// ---------- 键名
const ALIAS: Record<string, string> = {
  control: "ctrl", ctl: "ctrl", strg: "ctrl", option: "alt", opt: "alt", altgr: "alt", win: "meta", windows: "meta", super: "meta", cmd: "meta", command: "meta", logo: "meta",
  return: "enter", escape: "esc", del: "delete", ins: "insert", bksp: "backspace", back_space: "backspace", pgup: "pageup", page_up: "pageup", pgdn: "pagedown", page_down: "pagedown",
  arrowup: "up", arrowdown: "down", arrowleft: "left", arrowright: "right", spacebar: "space", recent: "recents", overview: "recents", app_switch: "recents",
  notification: "notifications", quicksettings: "quick_settings", lockscreen: "lock", lock_screen: "lock", 返回: "back", 主页: "home", 桌面: "home", 最近任务: "recents", 回车: "enter",
};
const MODS = new Set(["ctrl", "alt", "shift", "meta"]);
const NAMED = new Set(["enter", "esc", "tab", "space", "backspace", "delete", "insert", "home", "end", "pageup", "pagedown", "up", "down", "left", "right", "capslock", "printscreen", "menu",
  "back", "recents", "notifications", "quick_settings", "lock", "power", ...Array.from({ length: 24 }, (_, i) => `f${i + 1}`)]);

/** 「Ctrl+Shift+T」「cmd+c」「enter」「返回」→ 规范的键名数组（修饰键在前、去重，最后一个是主键）；写法不对时抛错。 */
export function parseKeys(combo: string): string[] {
  const raw = String(combo ?? "").trim();
  if (!raw) throw new Error("keys 不能为空：例如 enter、ctrl+c、alt+tab、back");
  const parts = raw === "+" ? ["+"] : raw.split(/\s*\+\s*/).map((p, i, all) => (p === "" && i === all.length - 1 ? "+" : p)).filter((p) => p !== "");
  const keys = parts.map((p) => {
    if ([...p].length === 1) return p.toLowerCase();
    const l = p.toLowerCase().replace(/[\s-]+/g, "_");
    return ALIAS[l] ?? ALIAS[l.replace(/_/g, "")] ?? (NAMED.has(l) ? l : l.replace(/_/g, ""));
  });
  const main = keys.at(-1)!, mods = [...new Set(keys.slice(0, -1))];
  for (const m of mods) if (!MODS.has(m)) throw new Error(`「${m}」不是修饰键：组合键写成 ctrl+shift+t，修饰键只有 ctrl、alt、shift、meta`);
  if (!MODS.has(main) && !NAMED.has(main) && [...main].length !== 1) throw new Error(`不认识的键「${main}」：可用 enter、esc、tab、space、backspace、delete、home、end、pageup、pagedown、up、down、left、right、f1–f24、单个字符，手机上还有 back、home、recents、notifications、quick_settings、lock`);
  return [...mods, main];
}

// ---------- 视图坐标
interface View { width: number; height: number; vw: number; vh: number } // 屏幕像素与她看到的视图像素
let view: View | undefined;
let last: { elements: ScreenElement[]; at: number } | undefined;

/** 屏幕尺寸 → 视图尺寸（长边不超过 VIEW_EDGE，只缩不放）。 */
export function viewOf(width: number, height: number): View {
  const s = Math.min(1, VIEW_EDGE / Math.max(width, height, 1));
  return { width, height, vw: Math.max(1, Math.round(width * s)), vh: Math.max(1, Math.round(height * s)) };
}
const setScreen = (width: number, height: number) => { if (width > 0 && height > 0 && (view?.width !== width || view?.height !== height)) view = viewOf(width, height); };
const toView = (v: View, x: number, y: number) => ({ x: Math.round(x * v.vw / v.width), y: Math.round(y * v.vh / v.height) });
const toScreen = (v: View, x: number, y: number) => ({ x: Math.round(x * v.width / v.vw), y: Math.round(y * v.height / v.vh) });

/** 测试用：清掉记住的屏幕尺寸与读屏结果。 */
export function resetHands() { view = undefined; last = undefined; }

// ---------- 元素过滤与排版
const ROLE: Record<string, string> = { button: "按钮", link: "链接", text: "文字", input: "输入框", checkbox: "复选框", radio: "单选", switch: "开关", combobox: "下拉框", slider: "滑块",
  tab: "标签页", menu: "菜单", menuitem: "菜单项", list: "列表", item: "条目", image: "图片", toolbar: "工具栏", dialog: "对话框", window: "窗口", group: "分组", scroll: "可滚动区域", other: "元素" };
const INTERACTIVE = new Set(["button", "link", "input", "checkbox", "radio", "switch", "combobox", "slider", "tab", "menuitem", "item"]);
const clip = (s: string | undefined, n = 80) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };
const interactive = (e: ScreenElement) => !!(e.clickable || e.editable || e.scrollable || INTERACTIVE.has(e.role));
const inside = (e: ScreenElement, x: number, y: number) => x >= e.x && x <= e.x + e.w && y >= e.y && y <= e.y + e.h;

/** 只留看得见、有用的元素：在屏幕内、有大小，能操作或带文字；与包住它的可操作元素同名的文字不重复列。 */
export function pickElements(snap: ScreenSnapshot): ScreenElement[] {
  const out: ScreenElement[] = [];
  const W = snap.width || Infinity, H = snap.height || Infinity;
  for (const e of snap.elements ?? []) {
    if (!(e.w >= 1 && e.h >= 1) || e.x >= W || e.y >= H || e.x + e.w <= 0 || e.y + e.h <= 0) continue;
    const name = clip(e.name), value = clip(e.value);
    if (!interactive(e) && !name && !value) continue;
    if (!interactive(e)) {
      const cx = e.x + e.w / 2, cy = e.y + e.h / 2;
      const owner = [...out].reverse().find((o) => interactive(o) && inside(o, cx, cy));
      if (owner && (clip(owner.name) === name || (!value && clip(owner.name).includes(name)))) continue;
    }
    out.push(e);
  }
  return out;
}

function line(i: number, e: ScreenElement, v: View): string {
  const c = toView(v, e.x + e.w / 2, e.y + e.h / 2), s = toView(v, e.w, e.h);
  const role = ROLE[e.role] ?? e.role, name = clip(e.name), value = clip(e.value);
  const flags = [
    e.editable && e.role !== "input" ? "可输入" : "", e.clickable && !INTERACTIVE.has(e.role) ? "可点" : "", e.scrollable ? "可滚动" : "",
    e.focused ? "焦点" : "", e.selected ? "已选中" : "", e.checked === true ? "已勾选" : e.checked === false && ["checkbox", "switch", "radio"].includes(e.role) ? "未勾选" : "",
    e.enabled === false ? "不可用" : "",
  ].filter(Boolean);
  return `[${i}] ${role}${name ? `「${name}」` : ""}${value && value !== name ? ` 值「${value}」` : ""} (${c.x},${c.y} · ${s.x}×${s.y})${flags.length ? ` ${flags.join(" ")}` : ""}`;
}

/** 读屏结果排版成给她看的文字，并记住编号 → 元素（之后按编号操作）。 */
export function formatSnapshot(snap: ScreenSnapshot): string {
  setScreen(snap.width, snap.height);
  const v = view ?? viewOf(snap.width || 1, snap.height || 1);
  const all = pickElements(snap), shown = all.slice(0, MAX_ITEMS);
  last = { elements: shown, at: Date.now() };
  const head = [`屏幕 ${v.vw}×${v.vh}${v.vw !== v.width ? `（实际 ${v.width}×${v.height}，这里的坐标都已换算成截图上的像素）` : ""}`, snap.app && `应用 ${snap.app}`, snap.window && `窗口「${clip(snap.window)}」`].filter(Boolean).join(" · ");
  const body = shown.length ? shown.map((e, i) => line(i + 1, e, v)).join("\n") : "（没有读到可用的元素）";
  const more = all.length > shown.length ? `\n……还有 ${all.length - shown.length} 个元素没有列出` : "";
  const tail = "\n用编号操作最准（screen_click 的 element）；编号只对这一次读屏有效，屏幕变了要重新读。看不清时用 screen_capture 截图。";
  return `${head}\n${body}${more}${snap.note ? `\n说明：${snap.note}` : ""}${tail}`;
}

/** 从参数里取一个点：element（编号）优先，否则 x、y（视图坐标）。prefix 用于拖拽的终点（to_element、to_x、to_y）。都没有时返回 undefined。 */
export function pointOf(a: Record<string, any>, prefix = ""): { at: ScreenPoint; label: string } | undefined {
  const el = a[`${prefix}element`];
  if (el !== undefined && el !== null && el !== "") {
    const n = Number(el), e = last?.elements[n - 1];
    if (!Number.isInteger(n) || !e) throw new Error(last ? `编号 ${el} 不在最近一次读屏的结果里（1–${last.elements.length}）：屏幕变了就先 screen_read 重新读` : "还没有读过屏幕：先 screen_read，再按编号操作");
    return { at: { x: Math.round(e.x + e.w / 2), y: Math.round(e.y + e.h / 2), ...(e.ref ? { ref: e.ref } : {}) }, label: `[${n}] ${ROLE[e.role] ?? e.role}${e.name ? `「${clip(e.name, 30)}」` : ""}` };
  }
  const x = a[`${prefix}x`], y = a[`${prefix}y`];
  if (x === undefined || y === undefined || x === null || y === null) return undefined;
  if (!Number.isFinite(Number(x)) || !Number.isFinite(Number(y))) throw new Error(`${prefix}x、${prefix}y 要是数字`);
  if (!view) throw new Error("还不知道屏幕多大：先 screen_read 或 screen_capture 看一眼，坐标按看到的截图为准");
  const vx = Math.round(Number(x)), vy = Math.round(Number(y));
  if (vx < 0 || vy < 0 || vx >= view.vw || vy >= view.vh) throw new Error(`坐标 (${vx},${vy}) 在屏幕外：屏幕是 ${view.vw}×${view.vh}（截图坐标）`);
  return { at: toScreen(view, vx, vy), label: `(${vx},${vy})` };
}
const needPoint = (a: Record<string, any>, prefix = "", what = "位置") => pointOf(a, prefix) ?? (() => { throw new Error(`要给${what}：${prefix}element（screen_read 的编号）或 ${prefix}x、${prefix}y（截图上的坐标）`); })();

// ---------- 截图
/** 截图并缩成视图大小；有进行中的思考就交给她看（与 view_image 同一条路）。返回给她看的文字。 */
async function capture(h: Hands, ctx: ToolContext): Promise<string> {
  const shot = await h.screenshot(VIEW_EDGE);
  setScreen(shot.width, shot.height);
  let file = shot.file, dims = sizeOf(file);
  if (!dims) throw new Error(`截到的不是可识别的图片：${file}`);
  if (Math.max(dims.width, dims.height) > VIEW_EDGE + 1) {
    const small = await shrink(file, undefined, VIEW_EDGE);
    if (small) {
      const dst = file.replace(/\.[^./\\]+$/, "") + "-view.jpg";
      fs.copyFileSync(small, dst); fs.rmSync(small, { force: true }); fs.rmSync(file, { force: true });
      file = dst; dims = sizeOf(file) ?? dims;
    }
  }
  view = { width: shot.width, height: shot.height, vw: dims.width, vh: dims.height }; // 按她真正看到的那张图换算
  const coords = `截图 ${dims.width}×${dims.height}${dims.width !== shot.width ? `（屏幕实际 ${shot.width}×${shot.height}）` : ""}，坐标就按这张图上的像素`;
  if (!ctx.session) return `已截图：${file}（${coords}）`;
  const { image, note } = await loadImage(file);
  ctx.session.images.push({ image, label: `屏幕截图 ${file}${note ? `（${note}）` : ""}` });
  ctx.session.seen.add(file);
  return `已截图：${file}（${coords}）。图片会在你下一步思考时出现（会自动选用能看图的模型）。`;
}

// ---------- 工具
const POINT = {
  element: num("screen_read 列出的元素编号（优先用它）"),
  x: num("截图坐标 x（没有编号时用）"), y: num("截图坐标 y"),
};

export function handsTools(h: Hands): Tool[] {
  const p = "hands";
  const done = async (text: string) => { await sleep(SETTLE_MS); return text; };
  const tools: Tool[] = [
    {
      name: "screen_read", permission: p,
      description: "读这具身体的屏幕：列出前台窗口（手机上是当前界面）里看得见的按钮、文字、输入框等元素，每个带编号与坐标（截图上的像素）。操作屏幕前先读；之后用编号点击、输入最准。screenshot 为 true 时同时截图给你看。读不到元素（应用没有无障碍信息）时用 screen_capture 看图。",
      parameters: obj({ screenshot: { type: "boolean", description: "同时截图给你看" } }),
      handler: async (a, ctx) => {
        const st = await h.status();
        if (!st.ready) throw new Error(st.reason ?? "现在不能操作这块屏幕");
        if (!st.tree) {
          if (!st.screenshot) throw new Error(st.reason ?? "读不到屏幕内容");
          return `读不到无障碍树${st.reason ? `（${st.reason}）` : ""}，改为截图：\n${await capture(h, ctx)}`;
        }
        const text = formatSnapshot(await h.snapshot());
        return a.screenshot && st.screenshot ? `${text}\n\n${await capture(h, ctx)}` : text;
      },
    },
    {
      name: "screen_capture", permission: p,
      description: "截取这具身体当前的整个屏幕给你看（缩到长边 1280 像素）。看到的图上的像素就是 screen_click 等工具的 x、y 坐标。元素列表（screen_read）读不到或看不懂时用它。",
      parameters: obj({}),
      handler: async (_a, ctx) => capture(h, ctx),
    },
    {
      name: "screen_click", permission: p,
      description: "点击屏幕：element 填 screen_read 的编号，或给截图坐标 x、y。count 2 为双击；button right 为右键（手机上等同长按）；hold 为按住的毫秒数（长按）。",
      parameters: obj({ ...POINT, button: { type: "string", enum: ["left", "right", "middle"] }, count: { type: "number", enum: [1, 2] }, hold: num("按住多少毫秒（长按，如 800）") }),
      handler: async (a) => {
        const t = needPoint(a, "", "点哪里");
        const holdMs = a.hold ? Math.max(50, Math.min(10_000, Number(a.hold) || 800)) : undefined;
        const count = Number(a.count) === 2 ? 2 : 1, button = ["right", "middle"].includes(a.button) ? a.button : "left";
        await h.click(t.at, { button, count, ...(holdMs ? { holdMs } : {}) });
        return done(`已${holdMs ? `长按 ${holdMs} 毫秒` : count === 2 ? "双击" : button === "right" ? "右键点击" : button === "middle" ? "中键点击" : "点击"} ${t.label}`);
      },
    },
    {
      name: "screen_drag", permission: p,
      description: "拖拽 / 滑动：从起点按住移到终点再松开。起点用 element 或 x、y，终点用 to_element 或 to_x、to_y（截图坐标）；ms 为用时（缺省 300，慢慢拖用 800 以上）。翻页滚动用 screen_scroll 更简单。",
      parameters: obj({ ...POINT, to_element: num("终点的元素编号"), to_x: num("终点 x"), to_y: num("终点 y"), ms: num("用时（毫秒）") }),
      handler: async (a) => {
        const from = needPoint(a, "", "起点"), to = needPoint(a, "to_", "终点");
        await h.drag(from.at, to.at, Math.max(50, Math.min(10_000, Number(a.ms) || 300)));
        return done(`已从 ${from.label} 拖到 ${to.label}`);
      },
    },
    {
      name: "screen_scroll", permission: p,
      description: "滚动：direction 为 down（看下面的内容）、up、left、right；amount 为格数（鼠标滚轮的格，缺省 3；手机上一格约六分之一屏）。给 element 或 x、y 时在那里滚，否则在屏幕中央。",
      parameters: obj({ direction: { type: "string", enum: ["up", "down", "left", "right"] }, amount: num("格数（1–20）"), ...POINT }, ["direction"]),
      handler: async (a) => {
        if (!["up", "down", "left", "right"].includes(a.direction)) throw new Error("direction 只能是 up、down、left、right");
        const t = pointOf(a), n = Math.max(1, Math.min(20, Math.round(Number(a.amount) || 3)));
        await h.scroll(a.direction, n, t?.at);
        return done(`已向${({ up: "上", down: "下", left: "左", right: "右" } as Record<string, string>)[a.direction]}滚动 ${n} 格${t ? `（在 ${t.label}）` : ""}`);
      },
    },
    {
      name: "screen_type", permission: p,
      description: "输入文字（任意语言）：给 element 或 x、y 时先点那个输入框，否则输入到当前焦点。enter 为 true 时输完按回车。密码、验证码这类保密信息不要替对方输入：需要登录时请对方自己来。",
      parameters: obj({ text: str("要输入的文字"), ...POINT, enter: { type: "boolean", description: "输完按回车" } }, ["text"]),
      handler: async (a) => {
        const text = String(a.text ?? "");
        if (!text && !a.enter) throw new Error("text 不能为空");
        const t = pointOf(a);
        if (text) await h.type(text, t?.at);
        if (a.enter) await h.key(["enter"]);
        return done(`已输入 ${[...text].length} 个字${t ? `到 ${t.label}` : ""}${a.enter ? "，并按了回车" : ""}`);
      },
    },
    {
      name: "screen_key", permission: p,
      description: "按键或组合键：如 enter、esc、tab、ctrl+c、ctrl+shift+t、alt+tab、meta（Win / Command 键）、pagedown、f5；手机上还有 back（返回）、home（回到桌面）、recents（最近任务）、notifications（通知栏）、quick_settings、lock。repeat 为连按次数。",
      parameters: obj({ keys: str("键或组合键，如 ctrl+c、enter、back"), repeat: num("连按几次（缺省 1，最多 20）") }, ["keys"]),
      handler: async (a) => {
        const keys = parseKeys(a.keys), n = Math.max(1, Math.min(20, Math.round(Number(a.repeat) || 1)));
        for (let i = 0; i < n; i++) { await h.key(keys); if (n > 1) await sleep(80); }
        return done(`已按 ${keys.join("+")}${n > 1 ? ` ${n} 次` : ""}`);
      },
    },
    {
      name: "app_open", permission: p,
      description: "打开这具身体上已安装的应用：id 填应用名（如「设置」「Firefox」）或包名 / 应用 ID。只能打开已安装的应用，不执行命令。",
      parameters: obj({ id: str("应用名或包名 / 应用 ID") }, ["id"]),
      handler: async (a) => {
        const id = String(a.id ?? "").trim();
        if (!id) throw new Error("id 不能为空");
        return done(await h.openApp(id));
      },
    },
  ];
  if (h.windows) tools.push({
    name: "window_list", permission: p,
    description: "列出这具身体上打开着的窗口（id、标题、所属应用、哪个在前台）。切换用 window_focus。",
    parameters: obj({}),
    handler: async () => {
      const list = await h.windows!();
      return list.length ? list.map((w) => `[${w.id}] ${clip(w.title) || "（无标题）"}${w.app ? ` — ${w.app}` : ""}${w.focused ? "（前台）" : ""}`).join("\n") : "没有打开着的窗口";
    },
  });
  if (h.focusWindow) tools.push({
    name: "window_focus", permission: p,
    description: "把一个窗口切到前台：id 来自 window_list。",
    parameters: obj({ id: str("window_list 给的窗口 id") }, ["id"]),
    handler: async (a) => { await h.focusWindow!(String(a.id ?? "")); return done(`已切换到窗口 ${a.id}`); },
  });
  return tools;
}
