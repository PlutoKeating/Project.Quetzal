// 路径与运行配置。所有可调参数集中在 config/quetzal.json，缺省值在此定义。
import fs from "node:fs";
import { bus } from "./bus.ts";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { log } from "./log.ts";

/** 家目录缺省：Termux（安卓）沿用 ~/quetzal（安卓安装器、runit 服务与开机脚本都按此约定）；其他机器（Linux 等）是 ~/.quetzal。环境变量 QUETZAL_HOME 优先
 *  （App 内置的运行基座由 App 设置，指向 App 自己的数据目录）。 */
export const isTermux = /com\.termux/.test(process.env.PREFIX ?? "");
/** 跑在安卓上（Termux 里，或 App 内置的运行环境）：没有 bubblewrap / Landlock，别的应用也能连本机端口。 */
export const isAndroid = process.platform === "android" || isTermux;
export const defaultHome = () => path.join(os.homedir(), isTermux ? "quetzal" : ".quetzal");
export const HOME = process.env.QUETZAL_HOME ?? defaultHome();
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
  // 灵魂仓库：sshMode 决定访问远端用哪把钥匙——deploy（默认，本机专属部署私钥 secrets/soul_ed25519）、custom（sshKeyPath 指定的私钥）、system（不传 -i，交给 ~/.ssh/config 与 ssh-agent）
  soul: { remote: string; branch: string; sshMode: "deploy" | "custom" | "system"; sshKeyPath: string };
  // 网关：明文 HTTP 只监听本机回环（port）；局域网访问一律走 HTTPS / WSS（lanPort，自签名证书 + 控制台钉住指纹，见 tls.ts）。
  //   lan 为真，或 host 不是回环地址（旧配置的 0.0.0.0），都表示对局域网开放：HTTPS 监听 host（回环时为 0.0.0.0）:lanPort
  gateway: { port: number; host: string; lan: boolean; lanPort: number };
  // 网状层：同步服务的地址（HTTPS）。绑定后的令牌在 secrets/sync.json；节点密钥在 secrets/mesh_ed25519
  // 命令沙箱：没有可用的沙箱时，她的命令缺省一律不执行；allowUnsandboxed 为真时照常执行（部署者在控制台明确打开，不安全）。只属于这具身体，不随多具身体同步
  sandbox: { allowUnsandboxed: boolean };
  mesh: { server: string; priority: number }; // priority：当协调者的优先级（越大越优先，适合一直开着、接着电源的身体）
  // 多具身体共用的设置分区最近一次被修改的时刻（毫秒）。网状层据此在身体之间同步：较新的修改生效（mesh/shared.ts）
  sharedRev: Record<string, number>;
  // 通道：feishuHolder 为持有飞书长连接的身体（多具身体时由部署者指定；空 = 这具身体自己连）。全网共用
  channels: { feishuHolder: string };
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

/** 官方同步服务：默认就用它，用户不用填；自己部署的同步服务在控制台「高级 · 同步」里改，清空即恢复官方。 */
export const OFFICIAL_SYNC = "https://sync.quetzal.plutokeating.beer";

export const defaults: Config = {
  body: "default",
  adapter: "",
  timezone: systemTimezone(),
  heart: { activity: 1, baseRatePerHour: 4, paused: false },
  budget: { dailyTokens: 2_000_000, dailyCostUsd: 5, minBattery: 15, maxTempC: 45 },
  // 相机、麦克风、定位、操作屏幕、造工具默认「每次询问」：新装的用户先看见她想做什么，再决定放开；其余默认允许。
  // 注意：shell（执行命令）为「允许」时，其他类别的限制挡不住她——命令能做设备工具、联网、改文件能做的一切（沙箱只藏起密钥目录）。
  // 这是产品上的取舍（她要能干活），文档（docs/API.md §3）写明；要真正收紧，先把 shell 改成「每次询问」。
  permissions: {
    network: "allow", shell: "allow", device: "allow", camera: "ask", microphone: "ask",
    location: "ask", message: "allow", self_modify: "allow", memory: "allow", hands: "ask", secret: "allow", session: "allow", body: "allow",
    tool_write: "ask", // 造工具：写的是之后会被执行的代码（mind/tools.ts）
  },
  brain: { maxOutputTokens: 4096 },
  feishu: { enabled: false, appId: "", ownerOpenId: "", bindCode: "" },
  soul: { remote: "", branch: "main", sshMode: "deploy", sshKeyPath: "" },
  gateway: { port: 7788, host: "127.0.0.1", lan: false, lanPort: 7789 },
  sandbox: { allowUnsandboxed: false },
  mesh: { server: OFFICIAL_SYNC, priority: 0 },
  sharedRev: {},
  channels: { feishuHolder: "" },
  speech: { region: "", endpoint: "", voice: "zh-CN-XiaoxiaoNeural", style: "", rate: "0%", pitch: "0%", volume: "100", format: "audio-24khz-48kbitrate-mono-mp3" },
  hearing: { enabled: false, windowMin: 10, sensitivity: 2, language: "", minChars: 2 },
};

const file = () => path.join(paths.config, "quetzal.json");

function merge<T>(base: T, over: unknown): T {
  if (typeof base !== "object" || base === null || Array.isArray(base)) return (over ?? base) as T;
  const out: any = { ...base };
  for (const [k, v] of Object.entries((over as object) ?? {})) out[k] = k in out ? merge(out[k], v) : v;
  return out;
}

export let config: Config = defaults;

/** 家目录与其中不该给别的系统用户看的目录：0700（只改这几个目录本身，不递归）。 */
const PRIVATE_DIRS = () => [paths.home, paths.secrets, paths.vault, paths.config, paths.data, paths.soul, paths.state];

export function loadConfig(): Config {
  for (const p of Object.values(paths)) if (p !== paths.stop) fs.mkdirSync(p, { recursive: true, mode: 0o700 });
  for (const d of PRIVATE_DIRS()) { try { fs.chmodSync(d, 0o700); } catch { /* 不是自己的目录（如共享的家目录）就不动 */ } }
  const read = (f: string) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return {}; } };
  config = merge(defaults, read(file()));
  if (!config.feishu.bindCode || config.feishu.bindCode.length < 10) config.feishu.bindCode = newBindCode();
  if (!config.mesh.server) config.mesh.server = OFFICIAL_SYNC; // 旧配置里留空的地址：补上官方同步服务
  sanitize();
  saveConfig();
  return config;
}

/** 不易看错的字母表（去掉 0/O、1/l/I）：配对码、绑定码共用。 */
export const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const randomCode = (n: number) => Array.from({ length: n }, () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]).join("");
/** 飞书手动绑定用的绑定码：10 位，密码学随机。 */
export const newBindCode = () => randomCode(10);

/**
 * Azure 语音的自定义端点只允许 Azure 的域名（HTTPS）：密钥随每次请求发往这个地址，指到别处就是把密钥交出去。
 * 设置分区 speech 会在身体之间同步，所以加载、保存（含来自其他身体的）时都校验，不合规的端点清空。
 */
const AZURE_HOSTS = [/\.microsoft\.com$/, /\.azure\.com$/, /\.cognitiveservices\.azure\.com$/, /\.tts\.speech\.microsoft\.com$/];
export function speechEndpointOk(endpoint: string): boolean {
  if (!endpoint) return true;
  try {
    const u = new URL(endpoint);
    if (process.env.SPEECH_ALLOW_LOCAL_ENDPOINT === "1" && u.hostname === "127.0.0.1") return true; // 只给测试的本地模拟服务用
    return u.protocol === "https:" && !u.username && !u.password && AZURE_HOSTS.some((re) => re.test(u.hostname.toLowerCase()));
  } catch { return false; }
}
export const speechRegionOk = (region: string) => !region || /^[a-z0-9-]{1,40}$/i.test(region);
function sanitize() {
  if (!speechEndpointOk(config.speech.endpoint)) { log("config", `语音端点不是 Azure 的地址，已清空：${config.speech.endpoint.slice(0, 80)}`); config.speech.endpoint = ""; }
  if (!speechRegionOk(config.speech.region)) config.speech.region = "";
}

/** 全网统一的设置分区（DISTRIBUTED.md C8）：一处改了，所有身体跟着改。身体名、时区、适配器、网关、飞书、同步服务地址等属于这具身体，不在其中。 */
export const SHARED_SECTIONS = ["permissions", "budget", "heart", "hearing", "speech", "brain", "channels"] as const;
/** 记下某个共享分区被这具身体改了（设置分区、模型供应商、语音密钥、急停），并通知网状层。 */
export function markShared(sections: string[]) {
  if (!sections.length) return;
  const now = Date.now();
  config = merge(config, { sharedRev: Object.fromEntries(sections.map((s) => [s, now])) });
  fs.writeFileSync(file(), JSON.stringify(config, null, 2));
  bus.emit("shared", sections);
}

/** 保存配置。remote：来自其他身体的同步（不再标记、不再转发）。 */
export function saveConfig(patch?: unknown, o: { remote?: boolean } = {}) {
  if (patch) { config = merge(config, patch); sanitize(); }
  const touched = patch && !o.remote ? Object.keys(patch as object).filter((k) => (SHARED_SECTIONS as readonly string[]).includes(k)) : [];
  if (touched.length) { markShared(touched); return; }
  fs.writeFileSync(file(), JSON.stringify(config, null, 2));
}

export function readSecret(name: string): string | undefined {
  try { return fs.readFileSync(path.join(paths.secrets, name), "utf8").trim() || undefined; } catch { return undefined; }
}

/** 写一个密钥文件：先写临时文件、fsync，再原子改名（写到一半断电不会留下半个密钥）；已有的文件也明确改成 0600。 */
export function writeSecret(name: string, value: string) {
  fs.mkdirSync(paths.secrets, { recursive: true, mode: 0o700 });
  const f = path.join(paths.secrets, name), tmp = `${f}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  const fd = fs.openSync(tmp, "w", 0o600);
  try { fs.writeSync(fd, value); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, f);
  fs.chmodSync(f, 0o600);
}
