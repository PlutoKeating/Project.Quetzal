// 路径与运行配置。所有可调参数集中在 config/windler.json，缺省值在此定义。
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export const HOME = process.env.WINDLER_HOME ?? path.join(os.homedir(), "windler");
export const paths = {
  home: HOME,
  config: path.join(HOME, "config"),
  secrets: path.join(HOME, "secrets"),
  vault: path.join(HOME, "vault"), // 保密库：对方通过 pass_secret 交给 agent 的保密值（见 mind/secrets.ts）
  data: path.join(HOME, "data"),
  state: path.join(HOME, "state"),
  soul: path.join(HOME, "soul"), // 与 Hermes 共享的灵魂仓库（git）
  tools: path.join(HOME, "tools"), // 她自己造的工具的实现（只在这具身体上；意图文档在灵魂仓库 skills/）
  stop: path.join(HOME, "STOP"),
};

export type Level = "allow" | "ask" | "deny";

export interface Config {
  body: string; // 这具身体的名字，写入共享记忆时区分来源
  adapter: string; // 身体适配器模块路径（空 = 通用适配器）
  timezone: string;
  heart: {
    activity: number; // 活跃度旋钮：醒来率整体倍率
    baseRatePerHour: number; // 驱动力饱和时的醒来率
    paused: boolean;
  };
  budget: { dailyTokens: number; dailyCostUsd: number; minBattery: number; maxTempC: number };
  permissions: Record<string, Level>;
  brain: { maxOutputTokens: number };
  feishu: { enabled: boolean; appId: string; ownerOpenId: string; bindCode: string };
  soul: { remote: string; branch: string };
  gateway: { port: number; host: string }; // host 缺省只监听本机；填 0.0.0.0 对局域网开放（配对码与令牌仍是唯一门槛）
  // 语音（Azure 语音服务文本转语音）。密钥单独保存在 secrets/azure_speech_key
  speech: { region: string; endpoint: string; voice: string; style: string; rate: string; pitch: string; volume: string; format: string };
  // 听觉：控制台 App 当耳朵（采集、降噪、断句），基座识别（Azure，与语音合成同一把密钥）并交给她判断要不要回应
  hearing: {
    enabled: boolean;
    windowMin: number; // 最近一个会话在多少分钟内有更新就并入它，否则新开会话
    sensitivity: number; // 1 迟钝（只听清晰的近距离说话）· 2 适中 · 3 灵敏
    language: string; // 识别语言（BCP 47），空时取她的偏好语言
    minChars: number; // 识别结果短于这个字数当作没听清，不打扰她
  };
}

/** 系统时区（部署者未配置时的缺省）；拿不到就用上海。 */
function systemTimezone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai"; } catch { return "Asia/Shanghai"; }
}

export const defaults: Config = {
  body: "default",
  adapter: "",
  timezone: systemTimezone(),
  heart: { activity: 1, baseRatePerHour: 4, paused: false },
  budget: { dailyTokens: 2_000_000, dailyCostUsd: 5, minBattery: 15, maxTempC: 45 },
  // 相机、麦克风、定位、操作屏幕默认「每次询问」：新装的用户先看见她想做什么，再决定放开；其余默认允许
  permissions: {
    network: "allow", shell: "allow", device: "allow", camera: "ask", microphone: "ask",
    location: "ask", message: "allow", self_modify: "allow", memory: "allow", hands: "ask", secret: "allow", session: "allow",
  },
  brain: { maxOutputTokens: 4096 },
  feishu: { enabled: false, appId: "", ownerOpenId: "", bindCode: "" },
  soul: { remote: "", branch: "main" },
  gateway: { port: 7788, host: "127.0.0.1" },
  speech: { region: "", endpoint: "", voice: "zh-CN-XiaoxiaoNeural", style: "", rate: "0%", pitch: "0%", volume: "100", format: "audio-24khz-48kbitrate-mono-mp3" },
  hearing: { enabled: false, windowMin: 10, sensitivity: 2, language: "", minChars: 2 },
};

const file = () => path.join(paths.config, "windler.json");

function merge<T>(base: T, over: unknown): T {
  if (typeof base !== "object" || base === null || Array.isArray(base)) return (over ?? base) as T;
  const out: any = { ...base };
  for (const [k, v] of Object.entries((over as object) ?? {})) out[k] = k in out ? merge(out[k], v) : v;
  return out;
}

export let config: Config = defaults;

export function loadConfig(): Config {
  for (const p of Object.values(paths)) if (p !== paths.stop) fs.mkdirSync(p, { recursive: true });
  fs.chmodSync(paths.secrets, 0o700);
  fs.chmodSync(paths.vault, 0o700);
  const read = (f: string) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return {}; } };
  config = merge(defaults, read(file()));
  if (!config.feishu.bindCode) config.feishu.bindCode = Math.random().toString(36).slice(2, 8);
  saveConfig();
  return config;
}

export function saveConfig(patch?: unknown) {
  if (patch) config = merge(config, patch);
  fs.writeFileSync(file(), JSON.stringify(config, null, 2));
}

export function readSecret(name: string): string | undefined {
  try { return fs.readFileSync(path.join(paths.secrets, name), "utf8").trim() || undefined; } catch { return undefined; }
}

export function writeSecret(name: string, value: string) {
  fs.writeFileSync(path.join(paths.secrets, name), value, { mode: 0o600 });
}
