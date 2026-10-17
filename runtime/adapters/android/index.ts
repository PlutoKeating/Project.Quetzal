// Quetzal 身体适配器：任意安卓手机，由 Quetzal App 自己提供身体能力（只装一个 App，不需要 Termux:API / Termux:Boot）。
// App 内置的运行基座由 App 的前台服务启动；同一个服务在 127.0.0.1 上开一个只认令牌的「身体接口」，
// 地址与令牌写在 QUETZAL_HOME/secrets/body.json（agent 的命令在沙箱里看不到密钥目录，绕不过闸门直接调用身体）。
// 只依赖 body/adapter.ts 的类型定义（构建时擦除）。设备差异全部靠 App 探测：有什么传感器就报什么，缺的能力工具报错而不崩溃。
// 手（看屏幕、点击、输入、打开应用）由 App 的无障碍服务提供（console/android 的 HandsService），用户在系统设置里开启后才能用。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BodyAdapter, AdapterTool, RawSample, SupervisionState, Hands, HandsStatus, ScreenElement, ScreenSnapshot } from "../../src/body/adapter.ts";

const HOME = process.env.QUETZAL_HOME ?? path.join(os.homedir(), ".quetzal");
const MEDIA = path.join(HOME, "data", "media");
const BODY_FILE = path.join(HOME, "secrets", "body.json");

interface Info { model?: string; sensors?: { light?: string; accel?: string }; camera?: boolean; torch?: boolean }
let info: Info = {};

/** 身体接口的地址与令牌：每次读文件（App 重启服务时会换端口与令牌）。 */
function endpoint(): { url: string; token: string } {
  const j = JSON.parse(fs.readFileSync(BODY_FILE, "utf8")) as { port: number; token: string };
  if (!Number.isInteger(j.port) || typeof j.token !== "string" || j.token.length < 32) throw new Error("身体接口的配置不完整");
  return { url: `http://127.0.0.1:${j.port}`, token: j.token };
}

/** 调用 App 的身体接口。失败抛出带原因的错误（工具把它当结果返回给她）。 */
export async function call<T = any>(p: string, body?: unknown, timeoutMs = 20_000): Promise<T> {
  const { url, token } = endpoint();
  const res = await fetch(url + p, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const j = await res.json().catch(() => ({})) as any;
  if (!res.ok || j?.ok === false) throw Object.assign(new Error(j?.error || `身体接口返回 ${res.status}`), { status: res.status });
  return j as T;
}
const quiet = async <T>(p: Promise<T>) => { try { return await p; } catch { return undefined; } };

const obj = (props: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties: props, required });
const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");
const media = (name: string) => { fs.mkdirSync(MEDIA, { recursive: true }); return path.join(MEDIA, name); };

const tools: AdapterTool[] = [
  {
    name: "take_photo", permission: "camera", description: "用手机相机拍一张照片（camera 0 后置，1 前置），返回文件路径。",
    parameters: obj({ camera: { type: "number", enum: [0, 1] } }),
    handler: async (a) => {
      const f = media(`photo-${stamp()}.jpg`);
      await call("/v1/photo", { camera: Number(a.camera ?? 0), file: f }, 45_000);
      return fs.existsSync(f) ? `已拍摄：${f}（${Math.round(fs.statSync(f).size / 1024)} KB）` : "拍照失败";
    },
  },
  {
    name: "record_audio", permission: "microphone", description: "用麦克风录一段声音（秒），返回文件路径。",
    parameters: obj({ seconds: { type: "number" } }, ["seconds"]),
    handler: async (a) => {
      const s = Math.max(1, Math.min(120, Number(a.seconds) || 5));
      const f = media(`audio-${stamp()}.m4a`);
      await call("/v1/record", { seconds: s, file: f }, (s + 20) * 1000);
      return fs.existsSync(f) ? `已录制 ${s} 秒：${f}` : "录音失败";
    },
  },
  {
    name: "location", permission: "location", description: "获取手机的大致位置（网络定位）。",
    parameters: obj({}),
    handler: async () => {
      const j = await call<{ latitude: number; longitude: number; accuracy?: number; ageMinutes?: number }>("/v1/location", {}, 70_000);
      const age = j.ageMinutes ?? 0;
      const when = age < 3 ? "" : `（这是 ${age < 120 ? `${age} 分钟` : age < 2880 ? `${Math.round(age / 60)} 小时` : `${Math.round(age / 1440)} 天`}前的位置，现在定不到新的）`;
      return `纬度 ${j.latitude.toFixed(3)}，经度 ${j.longitude.toFixed(3)}，精度约 ${Math.round(j.accuracy ?? 0)} 米${when}`;
    },
  },
  {
    name: "vibrate", permission: "device", description: "让手机振动（毫秒）。",
    parameters: obj({ ms: { type: "number" } }),
    handler: async (a) => { await call("/v1/vibrate", { ms: Math.min(3000, Number(a.ms) || 500) }); return "振动了"; },
  },
  {
    name: "torch", permission: "device", description: "打开或关闭手电筒。",
    parameters: obj({ on: { type: "boolean" } }, ["on"]),
    handler: async (a) => { await call("/v1/torch", { on: !!a.on }); return a.on ? "手电筒开了" : "手电筒关了"; },
  },
  {
    name: "clipboard", permission: "device", description: "读取（不给 text）或写入手机剪贴板。",
    parameters: obj({ text: { type: "string" } }),
    handler: async (a) => {
      if (a.text != null) { await call("/v1/clipboard", { text: String(a.text) }); return "已写入剪贴板"; }
      const j = await call<{ text?: string }>("/v1/clipboard", {});
      return j.text || "（剪贴板为空，或系统不允许后台读取）";
    },
  },
  {
    name: "read_sensor", permission: "device", description: "读取一个传感器的当前数值；不给 name 时列出所有传感器。",
    parameters: obj({ name: { type: "string" } }),
    handler: async (a) => {
      if (!a.name) return ((await call<{ sensors: string[] }>("/v1/sensors")).sensors ?? []).join("\n") || "没有读到传感器列表";
      const j = await call<{ values: number[] }>("/v1/sensor", { name: String(a.name) }, 15_000);
      return `${a.name}: ${j.values.join(", ")}`;
    },
  },
];

// ---------- 手：App 的无障碍服务（HandsService，用户在系统设置里开启「Quetzal 操作屏幕」），经身体接口的 /v1/hands/…
const PHONE_GLOBAL = new Set(["back", "home", "recents", "notifications", "quick_settings", "lock", "power"]);
/** 键 → 手机上的动作：global 是系统的全局动作（返回、主页、最近任务……），edit 是对当前输入框的编辑。做不到的抛错并说明能按什么。 */
export function phoneKey(keys: string[]): { kind: "global" | "edit"; action: string } {
  const main = keys.at(-1) ?? "", mods = keys.slice(0, -1);
  if (!mods.length) {
    if (PHONE_GLOBAL.has(main)) return { kind: "global", action: main };
    if (main === "esc") return { kind: "global", action: "back" };
    if (["enter", "backspace", "delete"].includes(main)) return { kind: "edit", action: main };
  }
  const edit = ({ c: "copy", x: "cut", v: "paste", a: "select_all" } as Record<string, string>)[main];
  if (mods.length === 1 && (mods[0] === "ctrl" || mods[0] === "meta") && edit) return { kind: "edit", action: edit };
  throw new Error(`手机上不能按 ${keys.join("+")}：可用 back、home、recents、notifications、quick_settings、lock、enter、backspace、ctrl+c、ctrl+x、ctrl+v、ctrl+a`);
}

const CLASS_ROLE: Record<string, string> = {
  Button: "button", ImageButton: "button", MaterialButton: "button", FloatingActionButton: "button", ExtendedFloatingActionButton: "button", Chip: "button",
  EditText: "input", AutoCompleteTextView: "input", TextInputEditText: "input", MultiAutoCompleteTextView: "input",
  CheckBox: "checkbox", MaterialCheckBox: "checkbox", RadioButton: "radio", MaterialRadioButton: "radio", Switch: "switch", SwitchCompat: "switch", SwitchMaterial: "switch", ToggleButton: "switch",
  Spinner: "combobox", SeekBar: "slider", RatingBar: "slider", Slider: "slider", ProgressBar: "slider",
  ImageView: "image", TextView: "text", CheckedTextView: "item",
  RecyclerView: "list", ListView: "list", GridView: "list", ExpandableListView: "list",
  ScrollView: "scroll", HorizontalScrollView: "scroll", NestedScrollView: "scroll", ViewPager: "scroll",
  TabWidget: "toolbar", TabLayout: "toolbar", Toolbar: "toolbar", ActionBar: "toolbar", WebView: "group", Dialog: "dialog",
};
/** 安卓控件类名 → 通用角色：能编辑的是输入框；可点的容器当按钮。 */
export function phoneRole(cls: string, flags: { clickable?: boolean; editable?: boolean } = {}): string {
  if (flags.editable) return "input";
  const short = cls.split(".").pop() ?? "";
  const role = CLASS_ROLE[short] ?? (/Button$/.test(short) ? "button" : /Layout$|ViewGroup$|^View$/.test(short) ? "group" : "other");
  return flags.clickable && (role === "group" || role === "other") ? "button" : role;
}

interface PhoneEl { c: string; n: string; v: string; b: number[]; r: string; k: boolean; e: boolean; s: boolean; en: boolean; f: boolean; se: boolean; ch: boolean | null }
export function parsePhoneSnapshot(j: { width: number; height: number; app?: string; window?: string; elements?: PhoneEl[] }): ScreenSnapshot {
  const elements = (j.elements ?? []).map((e): ScreenElement => ({
    role: phoneRole(e.c, { clickable: e.k, editable: e.e }), name: e.n || undefined, value: e.v || undefined,
    x: e.b[0], y: e.b[1], w: e.b[2], h: e.b[3], ref: e.r,
    clickable: e.k || undefined, editable: e.e || undefined, scrollable: e.s || undefined,
    enabled: e.en, focused: e.f || undefined, selected: e.se || undefined, checked: e.ch ?? undefined,
  }));
  return { width: j.width, height: j.height, app: j.app || undefined, window: j.window || undefined, elements, ...(elements.length < 2 ? { note: "这个界面几乎没有无障碍信息（游戏、视频、部分自绘界面），请截图看" } : {}) };
}

const HANDS_OFF = "手机上的无障碍服务没有开启：请打开 Quetzal App → 控制 → 权限 →「操作屏幕」，按提示在系统设置的无障碍里开启「Quetzal 操作屏幕」";
const hands: Hands = {
  async status(): Promise<HandsStatus> {
    let j: { enabled?: boolean; connected?: boolean; screenshot?: boolean };
    try { j = await call("/v1/hands"); } catch (e) {
      const old = (e as { status?: number }).status === 404;
      return { ready: false, reason: old ? "这个版本的 Quetzal App 还不支持操作屏幕：请升级 App" : `连不上 App 的身体接口：${(e as Error).message}`, screenshot: false, tree: false, input: false };
    }
    if (!j.connected) return { ready: false, reason: j.enabled ? "无障碍服务已经开启，但还没有连上：在系统设置里把「Quetzal 操作屏幕」关掉再打开，或重启手机" : HANDS_OFF, screenshot: false, tree: false, input: false };
    return { ready: true, screenshot: !!j.screenshot, tree: true, input: true, reason: j.screenshot ? undefined : "安卓 11 以下不能截图，只能读屏幕元素", detail: "Quetzal App 的无障碍服务" };
  },
  async screenshot(maxEdge) {
    const file = media(`screen-${stamp()}.jpg`);
    const j = await call<{ width: number; height: number }>("/v1/hands/screenshot", { file, maxEdge: maxEdge ?? 0 }, 30_000);
    if (!fs.existsSync(file)) throw new Error("截图失败");
    return { file, width: j.width, height: j.height };
  },
  snapshot: async () => parsePhoneSnapshot(await call("/v1/hands/snapshot", { limit: 600 }, 30_000)),
  click: async (at, o = {}) => { await call("/v1/hands/click", { x: at.x, y: at.y, ref: at.ref, button: o.button, count: o.count, holdMs: o.holdMs }, 30_000); },
  drag: async (from, to, ms) => { await call("/v1/hands/drag", { x1: from.x, y1: from.y, x2: to.x, y2: to.y, ms }, 30_000); },
  scroll: async (direction, amount, at) => { await call("/v1/hands/scroll", { direction, amount, ...(at ? { x: at.x, y: at.y } : {}) }, 60_000); },
  type: async (text, at) => { await call("/v1/hands/type", { text, ...(at ? { x: at.x, y: at.y, ref: at.ref } : {}) }, 30_000); },
  key: async (keys) => { await call("/v1/hands/key", phoneKey(keys)); },
  openApp: async (id) => { const j = await call<{ app: string; package: string }>("/v1/hands/open", { id }); return `已打开 ${j.app}（${j.package}）`; },
  windows: async () => ((await call<{ windows: { id: string; title: string; app: string; focused: boolean; x: number; y: number; w: number; h: number }[] }>("/v1/hands/windows")).windows ?? [])
    .map((w) => ({ id: w.id, title: w.title, app: w.app || undefined, ...(w.focused ? { focused: true } : {}), x: w.x, y: w.y, w: w.w, h: w.h })),
};

const adapter: BodyAdapter = {
  name: "android",
  get describe() {
    const parts = [info.model ? `一台 ${info.model} 安卓手机` : "一台安卓手机", "通常插着电放着"];
    const has = [info.sensors?.light && "光线", info.sensors?.accel && "运动"].filter(Boolean);
    parts.push(`有${info.camera === false ? "" : "相机、"}麦克风、扬声器${has.length ? `、${has.join("与")}传感器` : ""}`);
    return parts.join("，");
  },
  // 设备标识：App 原生代码取的 Settings.Secure.ANDROID_ID（恢复出厂设置、换签名会变）。只用来派生身体 uuid
  async deviceId() { const j = await quiet(call<{ id?: string }>("/v1/device-id")); return typeof j?.id === "string" && /^[0-9a-f]{1,16}$/i.test(j.id) ? j.id.toLowerCase() : undefined; }, // ANDROID_ID 是 64 位数的十六进制写法
  async init() { info = (await quiet(call<Info>("/v1/info"))) ?? {}; }, // 机型是公开的非唯一信息；传感器由 App 按类型探测
  // 网络变化：App 注册了系统的默认网络回调，这里长轮询 /v1/network（变了立即返回，否则 50 秒后返回原样）
  onNetworkChange(cb) {
    let stopped = false;
    const names: Record<string, string> = { wifi: "Wi-Fi", cellular: "移动数据", ethernet: "有线网络", vpn: "VPN", none: "没有网络" };
    void (async () => {
      let seq = -1;
      while (!stopped) {
        try {
          const j = await call<{ seq: number; transport?: string }>("/v1/network", { seq }, 65_000);
          if (stopped) return;
          if (seq >= 0 && j.seq !== seq) cb(`系统报告默认网络变了（现在是${names[j.transport ?? ""] ?? "其他网络"}）`);
          seq = j.seq;
        } catch (e) {
          if ((e as { status?: number }).status === 404) return; // 旧版 App 没有这个接口（HTTP 404）：只靠轮询
          await new Promise((r) => setTimeout(r, 10_000).unref?.());
        }
      }
    })();
    return () => { stopped = true; };
  },
  async sample(): Promise<RawSample> {
    const j = await quiet(call<RawSample & { plugged?: string }>("/v1/sample", undefined, 15_000));
    if (!j) return {};
    const { plugged, ...s } = j;
    return { ...s, extra: { ...(s.extra ?? {}), ...(plugged ? { 充电方式: plugged } : {}), ...(s.battery?.health ? { 电池健康: s.battery.health } : {}) } };
  },
  async notify(title, text) { await call("/v1/notify", { title, text }); },
  async playAudio(file) { await call("/v1/play", { file }, 30_000); },
  async stopAudio() { await quiet(call("/v1/stop", {})); },
  tools,
  hands, // 看屏幕与操作应用：要用户在系统设置里开启 App 的无障碍服务，没开时各操作如实说明怎么开
  supervision: {
    status: async (): Promise<SupervisionState> => {
      const j = await quiet(call<{ enabled: boolean }>("/v1/supervision"));
      return j ? { available: true, kind: "loop", enabled: j.enabled, detail: "Quetzal App 的前台服务：开机自启，退出后自动重启" } : { available: false, kind: "none", enabled: false, detail: "连不上 App 的身体接口" };
    },
    set: async (enabled) => { await call("/v1/supervision", { enabled }); },
  },
  // speak 不提供：说话统一由运行基座的 voice_speak 完成（合成后经 playAudio 播放）
  // upgrade 不提供：升级 App 即升级运行基座
};

export default adapter;
