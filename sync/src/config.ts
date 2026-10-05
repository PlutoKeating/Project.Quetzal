// 配置：只来自环境变量（docker compose 从 .env 注入）。启动时整体校验，缺什么一次说清楚。
import { z } from "zod";

const bool = z.enum(["0", "1", "true", "false", ""]).default("").transform((v) => v === "1" || v === "true");
const list = z.string().default("").transform((v) => v.split(",").map((s) => s.trim()).filter(Boolean));

const schema = z.object({
  SYNC_PUBLIC_URL: z.url({ protocol: /^https?$/ }),
  SYNC_WEB_URL: z.union([z.literal(""), z.url({ protocol: /^https?$/ })]).default(""), // 网页前端（例如官网）：给人看的页面都在那里，同步服务只提供接口
  SYNC_HOST: z.string().default("0.0.0.0"),
  SYNC_PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  SYNC_DATA_DIR: z.string().default("/data"),
  SYNC_TRUST_PROXY: bool, // 前面有反向代理（compose 里的 Caddy，或隧道模式的 cloudflared）时为真：客户端地址取 CF-Connecting-IP，没有时取 X-Forwarded-For 最右一项
  GITHUB_CLIENT_ID: z.string().default(""),
  GITHUB_CLIENT_SECRET: z.string().default(""),
  GITHUB_OAUTH_RELAY: z.union([z.literal(""), z.url({ protocol: /^https$/ })]).default(""), // 直连 github.com 不通时，换令牌经这里中转（例如官网 Worker 的 /api/oauth/github/token）
  TURN_SECRET: z.string().default(""), // 与 coturn 的 static-auth-secret 相同；空则不签发 TURN 凭据
  TURN_HOST: z.string().regex(/^[A-Za-z0-9.:-]*$/).default(""), // STUN / TURN 用的主机名或地址，缺省与公开地址相同（公开地址经 CDN / 隧道代理时必须单独指定一个直连的）
  TURN_URLS: list, // 缺省 turn:<TURN_HOST>:3478（UDP 与 TCP）
  STUN_URLS: list, // 缺省 stun:<host>:3478
  TURN_TTL_SECONDS: z.coerce.number().int().min(300).max(86400).default(3600),
  SYNC_SESSION_DAYS: z.coerce.number().int().min(1).max(90).default(30), // 滑动续期；无论怎么续，会话自创建起最长 90 天
  SYNC_MAX_AGENTS_PER_USER: z.coerce.number().int().min(1).default(20),
  SYNC_MAX_BODIES_PER_AGENT: z.coerce.number().int().min(1).default(16),
});

export type Config = ReturnType<typeof loadConfig>;

export function loadConfig(env: Record<string, string | undefined> = process.env) {
  const r = schema.safeParse(env);
  if (!r.success) throw new Error("配置有误：\n" + r.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n"));
  const c = r.data;
  const url = new URL(c.SYNC_PUBLIC_URL);
  const h = c.TURN_HOST || url.hostname;
  const host = h.includes(":") ? `[${h.replace(/^\[|\]$/g, "")}]` : h;
  if (c.TURN_SECRET && c.TURN_SECRET.length < 32) throw new Error("配置有误：TURN_SECRET 至少 32 个字符（start.sh 会自动生成）");
  return {
    publicUrl: url.origin,
    webUrl: c.SYNC_WEB_URL ? new URL(c.SYNC_WEB_URL).origin : undefined,
    secure: url.protocol === "https:",
    host: c.SYNC_HOST,
    port: c.SYNC_PORT,
    dataDir: c.SYNC_DATA_DIR,
    trustProxy: c.SYNC_TRUST_PROXY,
    github: c.GITHUB_CLIENT_ID && c.GITHUB_CLIENT_SECRET ? { id: c.GITHUB_CLIENT_ID, secret: c.GITHUB_CLIENT_SECRET } : undefined,
    githubRelay: c.GITHUB_OAUTH_RELAY || undefined,
    turn: c.TURN_SECRET ? {
      secret: c.TURN_SECRET,
      urls: c.TURN_URLS.length ? c.TURN_URLS : [`turn:${host}:3478?transport=udp`, `turn:${host}:3478?transport=tcp`],
      ttl: c.TURN_TTL_SECONDS,
    } : undefined,
    stun: c.STUN_URLS.length ? c.STUN_URLS : [`stun:${host}:3478`],
    sessionDays: c.SYNC_SESSION_DAYS,
    maxAgents: c.SYNC_MAX_AGENTS_PER_USER,
    maxBodies: c.SYNC_MAX_BODIES_PER_AGENT,
  };
}
