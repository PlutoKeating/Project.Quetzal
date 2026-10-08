// Quetzal 身体适配器：任意安卓手机（Termux + Termux:API，无需 root）。
// 由控制台的安装器随运行基座一起放到手机上；只依赖 body/adapter.ts 的类型定义（构建时擦除）。
// 设备差异全部靠探测：有什么传感器就报什么，没有 Termux:API 时采样为空、工具报错而不崩溃。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BodyAdapter, AdapterTool, RawSample } from "../../src/body/adapter.ts";
import { run, json, pickSensors } from "./termux.ts";
import * as supervise from "./supervise.ts";

const MEDIA = path.join(process.env.QUETZAL_HOME ?? path.join(os.homedir(), "quetzal"), "data", "media");
const CONSOLE_ACTIVITY = process.env.QUETZAL_CONSOLE_ACTIVITY ?? "xyz.quetzal.console/.MainActivity";
let sensors: { light?: string; accel?: string } = {};
let model = "";

async function readSensor(name?: string): Promise<number[] | undefined> {
  if (!name) return undefined;
  const j = await json<Record<string, { values: number[] }>>("termux-sensor", ["-s", name, "-n", "1"], 10_000);
  await run("termux-sensor", ["-c"], 5_000);
  return j ? Object.values(j)[0]?.values : undefined;
}

const obj = (props: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties: props, required });
const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");

const tools: AdapterTool[] = [
  {
    name: "take_photo", permission: "camera", description: "用手机相机拍一张照片（camera 0 后置，1 前置），返回文件路径。",
    parameters: obj({ camera: { type: "number", enum: [0, 1] } }),
    handler: async (a) => {
      fs.mkdirSync(MEDIA, { recursive: true });
      const f = path.join(MEDIA, `photo-${stamp()}.jpg`);
      const r = await run("termux-camera-photo", ["-c", String(a.camera ?? 0), f], 30_000);
      return r.code === 0 && fs.existsSync(f) ? `已拍摄：${f}（${Math.round(fs.statSync(f).size / 1024)} KB）` : "拍照失败";
    },
  },
  {
    name: "record_audio", permission: "microphone", description: "用麦克风录一段声音（秒），返回文件路径。",
    parameters: obj({ seconds: { type: "number" } }, ["seconds"]),
    handler: async (a) => {
      fs.mkdirSync(MEDIA, { recursive: true });
      const f = path.join(MEDIA, `audio-${stamp()}.m4a`);
      const s = Math.max(1, Math.min(120, Number(a.seconds) || 5));
      await run("termux-microphone-record", ["-f", f, "-l", String(s)], 10_000);
      await new Promise((r) => setTimeout(r, (s + 1) * 1000));
      await run("termux-microphone-record", ["-q"], 5_000);
      return fs.existsSync(f) ? `已录制 ${s} 秒：${f}` : "录音失败";
    },
  },
  {
    name: "location", permission: "location", description: "获取手机的大致位置（网络定位）。",
    parameters: obj({}),
    handler: async () => {
      const j = await json("termux-location", ["-p", "network", "-r", "once"], 60_000);
      return j ? `纬度 ${j.latitude?.toFixed(3)}，经度 ${j.longitude?.toFixed(3)}，精度约 ${Math.round(j.accuracy ?? 0)} 米` : "定位失败";
    },
  },
  {
    name: "vibrate", permission: "device", description: "让手机振动（毫秒）。",
    parameters: obj({ ms: { type: "number" } }),
    handler: async (a) => ((await run("termux-vibrate", ["-d", String(Math.min(3000, Number(a.ms) || 500)), "-f"])).code === 0 ? "振动了" : "失败"),
  },
  {
    name: "torch", permission: "device", description: "打开或关闭手电筒。",
    parameters: obj({ on: { type: "boolean" } }, ["on"]),
    handler: async (a) => ((await run("termux-torch", [a.on ? "on" : "off"])).code === 0 ? (a.on ? "手电筒开了" : "手电筒关了") : "失败"),
  },
  {
    name: "clipboard", permission: "device", description: "读取（不给 text）或写入手机剪贴板。",
    parameters: obj({ text: { type: "string" } }),
    handler: async (a) => a.text != null ? ((await run("termux-clipboard-set", [a.text])).code === 0 ? "已写入剪贴板" : "失败") : (await run("termux-clipboard-get")).out || "（剪贴板为空）",
  },
  {
    name: "read_sensor", permission: "device", description: "读取一个传感器的当前数值；不给 name 时列出所有传感器。",
    parameters: obj({ name: { type: "string" } }),
    handler: async (a) => {
      if (!a.name) return ((await json("termux-sensor", ["-l"]))?.sensors ?? []).join("\n") || "没有读到传感器列表（Termux:API 未安装或未授权？）";
      const v = await readSensor(a.name);
      return v ? `${a.name}: ${v.join(", ")}` : "读取失败";
    },
  },
];

const adapter: BodyAdapter = {
  name: "termux",
  get describe() {
    const parts = [model ? `一台 ${model} 安卓手机` : "一台安卓手机", "通常插着电放着"];
    const has = [sensors.light && "光线", sensors.accel && "运动"].filter(Boolean);
    parts.push(`有相机、麦克风、扬声器${has.length ? `、${has.join("与")}传感器` : ""}`);
    return parts.join("，");
  },
  // 设备标识：尽力取 ANDROID_ID（settings 命令在多数手机上 Termux 没有权限读，取不到就随机生成 uuid）。只用来派生身体 uuid
  async deviceId() {
    const r = await run("settings", ["get", "secure", "android_id"], 5_000);
    const v = r.code === 0 ? r.out.trim().toLowerCase() : "";
    return /^[0-9a-f]{8,32}$/.test(v) ? v : undefined;
  },
  async init() {
    // 机型是公开的非唯一信息；传感器按名字探测，没有 Termux:API 时两者都为空
    model = (await run("getprop", ["ro.product.model"], 5_000)).out.trim();
    sensors = pickSensors((await json("termux-sensor", ["-l"]))?.sensors ?? []);
  },
  async sample(): Promise<RawSample> {
    const bat = await json("termux-battery-status");
    const lux = await readSensor(sensors.light);
    const acc = await readSensor(sensors.accel);
    return {
      battery: bat ? { level: bat.percentage, charging: bat.status === "CHARGING" || bat.status === "FULL", tempC: bat.temperature, health: bat.health } : undefined,
      lux: lux ? Math.round(lux[0]) : undefined,
      motion: acc ? Math.round(Math.abs(Math.hypot(...acc) - 9.81) * 100) / 100 : undefined,
      extra: bat ? { 充电方式: bat.plugged, 电池健康: bat.health } : undefined,
    };
  },
  async notify(title, text) {
    await run("termux-notification", ["--id", "quetzal-say", "--title", title, "--content", text, "--priority", "high",
      "--button1", "打开 Quetzal", "--button1-action", `am start -n ${CONSOLE_ACTIVITY}`]);
  },
  // 播放音频（如语音合成的结果）：Termux:API 的媒体播放器，后台播放，立即返回
  async playAudio(file) {
    const r = await run("termux-media-player", ["play", file], 30_000);
    if (r.code !== 0 || /error|fail/i.test(r.out)) throw new Error(`播放失败：${r.out.trim().slice(0, 200)}`);
  },
  async stopAudio() { await run("termux-media-player", ["stop"], 10_000); },
  tools,
  supervision: { status: supervise.status, set: supervise.set }, // 守护开关：runit 服务 + Termux:Boot 开机脚本
  // speak 不提供：很多手机没有系统 TTS 引擎，termux-tts-speak 不出声；说话统一由运行基座的 voice_speak 完成
  // hands：看屏幕与操作其他应用——预留，尚未实现（需要无障碍服务或 shell 身份）
};

export default adapter;
