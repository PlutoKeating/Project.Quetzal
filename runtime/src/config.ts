// 路径与运行配置。所有可调参数集中在 config/windler.json，缺省值在此定义。
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export const HOME = process.env.WINDLER_HOME ?? path.join(os.homedir(), "windler");
export const paths = {
  home: HOME,
  config: path.join(HOME, "config"),
  secrets: path.join(HOME, "secrets"),
  data: path.join(HOME, "data"),
  state: path.join(HOME, "state"),
  soul: path.join(HOME, "soul"), // 与 Hermes 共享的灵魂仓库（git）
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
  soul: { remote: string; branch: string; memoryCharLimit: number; userCharLimit: number };
  gateway: { port: number };
}

export const defaults: Config = {
  body: "default",
  adapter: "",
  timezone: "Asia/Shanghai",
  heart: { activity: 1, baseRatePerHour: 4, paused: false },
  budget: { dailyTokens: 2_000_000, dailyCostUsd: 5, minBattery: 15, maxTempC: 45 },
  permissions: {
    network: "allow", shell: "allow", device: "allow", camera: "allow", microphone: "allow",
    location: "allow", message: "allow", self_modify: "allow", memory: "allow", hands: "allow",
  },
  brain: { maxOutputTokens: 4096 },
  feishu: { enabled: false, appId: "", ownerOpenId: "", bindCode: "" },
  soul: { remote: "", branch: "main", memoryCharLimit: 2200, userCharLimit: 1375 },
  gateway: { port: 7788 },
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
  const read = (f: string) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return {}; } };
  // 项目曾名 Amani：旧配置 amani.json 优先合并进新配置（部署者可能已预先写入 windler.json 的少量字段），然后移除
  const legacy = path.join(paths.config, "amani.json");
  config = merge(merge(defaults, read(file())), fs.existsSync(legacy) ? read(legacy) : {});
  if (!config.feishu.bindCode) config.feishu.bindCode = Math.random().toString(36).slice(2, 8);
  saveConfig();
  fs.rmSync(legacy, { force: true });
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
