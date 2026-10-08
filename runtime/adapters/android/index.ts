// Quetzal 身体适配器：任意安卓手机，由 Quetzal App 自己提供身体能力（只装一个 App，不需要 Termux:API / Termux:Boot）。
// App 内置的运行基座由 App 的前台服务启动；同一个服务在 127.0.0.1 上开一个只认令牌的「身体接口」，
// 地址与令牌写在 QUETZAL_HOME/secrets/body.json（agent 的命令在沙箱里看不到密钥目录，绕不过闸门直接调用身体）。
// 只依赖 body/adapter.ts 的类型定义（构建时擦除）。设备差异全部靠 App 探测：有什么传感器就报什么，缺的能力工具报错而不崩溃。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BodyAdapter, AdapterTool, RawSample, SupervisionState } from "../../src/body/adapter.ts";

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
