// 同步服务的账户接口客户端（/v1/web/*，协议见 sync/docs/PROTOCOL.md §5）。
// 官网是唯一给人看的前端：登录、账户、批准身体、控制台登录都在这里；同步服务只提供接口。
// 会话 Cookie 属于同步服务（与官网同站不同源），所以请求一律 credentials: "include"；改动类请求是 JSON（跨源时浏览器先预检）。
export const SYNC_ORIGIN = "https://sync.quetzal.plutokeating.beer";

export interface SessionInfo { loginEnabled: boolean; user: { login: string; name: string } | null }
export interface AccountBody { body: string; kind: "runtime" | "bridge" | string; version: string; created: number; lastSeen: number; online: boolean; fingerprint: string }
export interface AccountAgent { id: string; name: string; created: number; bodies: AccountBody[] }
export interface ConsoleSignIn { id: string; body: string; created: number; lastUsed: number; current: boolean }
export interface Account {
  user: { login: string; name: string };
  limits: { agents: number; bodies: number };
  agents: AccountAgent[];
  consoles: ConsoleSignIn[];
}
export interface PendingCode {
  code: string; agent: { id: string; name: string }; body: string; kind: "runtime" | "bridge" | "console" | string;
  version: string; fingerprint: string; replaces: boolean; newAgent: boolean; expires: number;
  /** 码的创建时间（毫秒；旧版同步服务没有）。 */
  createdAt?: number;
  /** 只有 console：发起登录的那台 App 所连运行基座（身体）的公钥指纹与它绑定到账户的时间（旧版同步服务没有）。 */
  bodyFingerprint?: string; bodyBoundAt?: number;
  /** 核对词（3 个表情）：与身体在消息里给出的一致（旧版同步服务没有）。 */
  check?: string;
  /** 身体带了部署公钥：它的指纹；soulLink 为真时批准后经 GitHub 加到灵魂仓库。 */
  soulKey?: string; soulLink?: boolean;
  /** 身体没说属于哪个 agent：账户里可选的 agent（空数组表示新建）。 */
  choose?: { id: string; name: string; repo: string }[];
}

/** 接口错误：code 为同步服务返回的 error（unauthorized / bad_code / expired / not_yours …），网络不通时为 network。 */
export class SyncError extends Error {
  constructor(readonly code: string, readonly status = 0) { super(code); }
}

async function call<T>(path: string, body?: unknown): Promise<T> {
  let r: Response;
  try {
    r = await fetch(SYNC_ORIGIN + path, body === undefined
      ? { credentials: "include", cache: "no-store" }
      : { method: "POST", credentials: "include", cache: "no-store", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  } catch {
    throw new SyncError("network");
  }
  const j = (await r.json().catch(() => ({}))) as { error?: string };
  if (!r.ok) throw new SyncError(j.error ?? `http_${r.status}`, r.status);
  return j as T;
}

export const sync = {
  session: () => call<SessionInfo>("/v1/web/session"),
  account: () => call<Account>("/v1/web/account"),
  lookup: (code: string) => call<PendingCode>("/v1/web/device/lookup", { code }),
  /** agent：身体没给 agent 时选定的 agent id 或 "new"。返回 next 时把人带过去（同一个标签页经 GitHub 跳一次，把部署密钥加到灵魂仓库）。 */
  decide: (code: string, approve: boolean, agent?: string) => call<{ ok: true; approved: boolean; next?: string }>("/v1/web/device/decide", { code, approve, ...(agent ? { agent } : {}) }),
  removeBody: (agent: string, body: string) => call<{ ok: true }>("/v1/web/bodies/remove", { agent, body }),
  removeAgent: (agent: string) => call<{ ok: true }>("/v1/web/agents/remove", { agent }),
  revokeConsole: (id: string) => call<{ ok: true }>("/v1/web/consoles/revoke", { id }),
  logout: () => call<{ ok: true }>("/v1/web/logout", {}),
  /** 吊销这个账户的所有网页登录会话（包括当前这个）。 */
  revokeAllSessions: () => call<{ ok: true }>("/v1/web/sessions/revoke-all", {}),
  deleteAccount: () => call<{ ok: true }>("/v1/web/account/delete", { confirm: true }),
};

/** GitHub 登录：经同步服务跳到 GitHub，登录后回到 returnTo（必须是官网上的地址，同步服务会核对）。 */
export const loginUrl = (returnTo: string) => `${SYNC_ORIGIN}/login?return_to=${encodeURIComponent(returnTo)}`;

/** 绑定码规范化：去掉空白与连字符，转大写，8 位时显示为 XXXX-XXXX。 */
export function formatCode(input: string): string {
  const s = input.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 8);
  return s.length > 4 ? `${s.slice(0, 4)}-${s.slice(4)}` : s;
}
