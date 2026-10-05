// 登录：GitHub OAuth（授权码 + PKCE S256）+ 服务端会话（做法按 Lucia 的会话指南：随机令牌放 Cookie，库里只存它的 SHA-256，滑动续期）。
// 不保存 GitHub 的访问令牌：只用它读一次公开资料（不申请任何 scope），读完立即向 GitHub 吊销（尽力而为，不阻塞登录）。
import crypto from "node:crypto";
import { generateCodeVerifier, generateState } from "arctic";
import type { Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { MAX_SESSION_DAYS, type Db, type User } from "./db.ts";
import type { Config } from "./config.ts";
import { CONSOLE_SESSION_DAYS } from "./device.ts";
import { now, randomToken, sha256 } from "./util.ts";

export interface GitHubUser { id: number; login: string; name: string }
/** 可替换的 GitHub 客户端（测试里注入假的）。codeChallenge / codeVerifier 是 PKCE（RFC 7636，S256）。 */
export interface GitHubClient { authorizationUrl(state: string, codeChallenge: string): URL; user(code: string, codeVerifier: string): Promise<GitHubUser> }

const UA = "quetzal-sync";

/** arctic 的 GitHub 提供方不支持 PKCE，授权地址在这里自己拼（GitHub 的 OAuth App 支持 code_challenge_method=S256）。fetcher 供测试注入。 */
export function githubClient(cfg: Config, fetcher: typeof fetch = fetch): GitHubClient | undefined {
  if (!cfg.github) return undefined;
  const redirectUri = `${cfg.publicUrl}/auth/github/callback`;
  const { id, secret } = cfg.github;
  return {
    authorizationUrl(state, codeChallenge) {
      const u = new URL("https://github.com/login/oauth/authorize");
      for (const [k, v] of Object.entries({ response_type: "code", client_id: id, redirect_uri: redirectUri, state, code_challenge: codeChallenge, code_challenge_method: "S256" })) u.searchParams.set(k, v);
      return u;
    },
    async user(code, codeVerifier) {
      const accessToken = await exchangeCode({ id, secret, code, redirectUri, verifier: codeVerifier, relay: cfg.githubRelay }, fetcher);
      try {
        const r = await retry(() => fetcher("https://api.github.com/user", {
          headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/vnd.github+json", "User-Agent": UA },
          signal: AbortSignal.timeout(10_000),
        }));
        if (!r.ok) throw new Error(`读取 GitHub 资料失败：HTTP ${r.status}`);
        const u = await r.json() as { id: number; login: string; name?: string | null };
        if (!Number.isInteger(u.id) || typeof u.login !== "string") throw new Error("GitHub 返回的资料不完整");
        return { id: u.id, login: u.login, name: u.name ?? "" };
      } finally {
        void revokeToken({ id, secret, accessToken }, fetcher);
      }
    },
  };
}

/** 读完资料就吊销 GitHub 访问令牌（DELETE /applications/{client_id}/token，Basic 认证）。尽力而为：5 秒超时，失败只是令牌按 GitHub 的规则自然闲置，不影响登录。 */
export function revokeToken(o: { id: string; secret: string; accessToken: string }, fetcher: typeof fetch = fetch): Promise<boolean> {
  try {
    return fetcher(`https://api.github.com/applications/${encodeURIComponent(o.id)}/token`, {
      method: "DELETE",
      headers: { Authorization: `Basic ${Buffer.from(`${o.id}:${o.secret}`).toString("base64")}`, Accept: "application/vnd.github+json", "Content-Type": "application/json", "User-Agent": UA, "X-GitHub-Api-Version": "2022-11-28" },
      body: JSON.stringify({ access_token: o.accessToken }),
      signal: AbortSignal.timeout(5_000),
    }).then((r) => r.status === 204, () => false);
  } catch { return Promise.resolve(false); }
}

/** 网络错误时再试一次（连 GitHub 时通时断的机房里常见）；GitHub 明确的回应不重试。 */
async function retry<T>(f: () => Promise<T>, times = 2): Promise<T> {
  for (let i = 1; ; i++) {
    try { return await f(); } catch (e) { if (i >= times) throw e; await new Promise((r) => setTimeout(r, 500)); }
  }
}

/** 授权码换访问令牌：先直连 github.com（各 8 秒、试两次），不通时经配置的中转（GITHUB_OAUTH_RELAY，例如官网 Worker）。
 *  请求体原样是 OAuth 2.0 的表单；中转只转发，不保存。GitHub 明确拒绝（bad_verification_code 等）时不再换路。 */
export async function exchangeCode(o: { id: string; secret: string; code: string; redirectUri: string; verifier?: string; relay?: string }, fetcher: typeof fetch = fetch): Promise<string> {
  const body = new URLSearchParams({ client_id: o.id, client_secret: o.secret, code: o.code, redirect_uri: o.redirectUri, ...(o.verifier ? { code_verifier: o.verifier } : {}) }).toString();
  const targets = ["https://github.com/login/oauth/access_token", ...(o.relay ? [o.relay] : [])];
  let lastError = "";
  for (const url of targets) {
    try {
      const r = await retry(() => fetcher(url, { method: "POST", body, headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json", "User-Agent": UA }, signal: AbortSignal.timeout(8_000) }), url === targets[0] ? 2 : 1);
      const j = await r.json().catch(() => ({})) as { access_token?: string; error?: string };
      if (typeof j.access_token === "string" && j.access_token) return j.access_token;
      if (j.error && r.status < 500 && !["relay_not_configured", "client_not_allowed", "upstream_unreachable"].includes(j.error)) throw Object.assign(new Error(`GitHub 拒绝了授权码：${j.error}`), { final: true });
      lastError = `${new URL(url).host} 返回 ${r.status}${j.error ? ` ${j.error}` : ""}`;
    } catch (e) {
      if ((e as { final?: boolean }).final) throw e;
      lastError = `${new URL(url).host}：${(e as Error).message}`;
    }
  }
  throw new Error(`无法连接 GitHub（${lastError}）`);
}

const DAY = 86_400_000;

export class Sessions {
  readonly cookie: string;
  private db: Db;
  private cfg: Config;
  constructor(db: Db, cfg: Config) {
    this.db = db; this.cfg = cfg;
    // HTTPS 下用 __Host- 前缀：浏览器保证它只能由本站、在 HTTPS 下、对整个站点设置，子域与明文连接都改不了它
    this.cookie = cfg.secure ? "__Host-quetzal_session" : "quetzal_session";
  }
  private set(c: Context, token: string, expires: number) {
    setCookie(c, this.cookie, token, {
      httpOnly: true, secure: this.cfg.secure, sameSite: "Lax", path: "/", expires: new Date(expires),
    });
  }
  create(c: Context, userId: number) {
    const token = randomToken();
    const expires = now() + Math.min(this.cfg.sessionDays, MAX_SESSION_DAYS) * DAY;
    this.db.createSession(token, userId, expires);
    this.set(c, token, expires);
  }
  /** 当前登录的用户。剩余不到一半有效期时续期（网页按 SYNC_SESSION_DAYS，控制台按 CONSOLE_SESSION_DAYS），但不超过创建后 MAX_SESSION_DAYS 天。
   *  allowBearer：/v1/web/* 也接受控制台登录的令牌（Authorization: Bearer qsc_…，只认 console 类型的会话；发起它的身体被解绑后失效）。 */
  user(c: Context, allowBearer = false): User | undefined {
    const bearer = allowBearer ? /^Bearer (qsc_[\w-]{1,96})$/.exec(c.req.header("authorization") ?? "")?.[1] : undefined;
    const token = bearer ?? getCookie(c, this.cookie);
    if (!token || token.length > 100) return undefined;
    const s = this.db.session(token);
    if (!s || (bearer ? s.kind !== "console" : s.kind === "console")) return undefined;
    const t = now(), hardEnd = s.created + MAX_SESSION_DAYS * DAY;
    if (s.expires < t || hardEnd < t || (s.kind === "console" && !this.db.consoleBodyAlive(s))) { this.db.deleteSession(token); return undefined; }
    const life = (s.kind === "console" ? CONSOLE_SESSION_DAYS : this.cfg.sessionDays) * DAY;
    if (s.expires - t < life / 2) {
      const e = Math.min(t + life, hardEnd);
      if (e > s.expires) { this.db.touchSession(token, e); if (!bearer) this.set(c, token, e); }
    }
    if (bearer) this.db.usedSession(token);
    return this.db.user(s.user_id);
  }
  /** 这次请求用的控制台登录的编号（哈希前 16 位）；网页 Cookie 登录时为 undefined。 */
  consoleHandle(c: Context): string | undefined {
    const t = /^Bearer (qsc_[\w-]{1,96})$/.exec(c.req.header("authorization") ?? "")?.[1];
    return t ? sha256(t).slice(0, 16) : undefined;
  }
  destroy(c: Context) {
    const bearer = /^Bearer (qsc_[\w-]{1,96})$/.exec(c.req.header("authorization") ?? "")?.[1];
    if (bearer) { this.db.deleteSession(bearer); return; } // 控制台退出登录：只作废它自己的令牌
    const token = getCookie(c, this.cookie);
    if (token) this.db.deleteSession(token);
    deleteCookie(c, this.cookie, { path: "/", secure: this.cfg.secure });
  }
}

/** OAuth 的临时 Cookie（10 分钟）：state、PKCE 的 code_verifier、登录后要回到的页面。HTTPS 下用 __Host- 前缀（子域与明文连接都种不了、改不了）。 */
const oauthCookies = (cfg: Config) => {
  const p = cfg.secure ? "__Host-" : "";
  return { state: `${p}quetzal_oauth_state`, verifier: `${p}quetzal_oauth_verifier`, returnTo: `${p}quetzal_return_to` };
};
export function beginLogin(c: Context, cfg: Config, gh: GitHubClient, returnTo: string) {
  const state = generateState(), verifier = generateCodeVerifier();
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const names = oauthCookies(cfg);
  const opts = { httpOnly: true, secure: cfg.secure, sameSite: "Lax" as const, path: "/", maxAge: 600 };
  setCookie(c, names.state, state, opts);
  setCookie(c, names.verifier, verifier, opts);
  setCookie(c, names.returnTo, safeReturnTo(returnTo, cfg.webUrl), opts);
  return gh.authorizationUrl(state, challenge);
}
export function finishLogin(c: Context, cfg: Config): { state?: string; verifier?: string; returnTo: string } {
  const names = oauthCookies(cfg);
  const state = getCookie(c, names.state), verifier = getCookie(c, names.verifier);
  const returnTo = safeReturnTo(getCookie(c, names.returnTo) ?? "", cfg.webUrl);
  for (const n of Object.values(names)) deleteCookie(c, n, { path: "/", secure: cfg.secure });
  return { state, verifier, returnTo };
}
/** 只允许回到本站的绝对路径，或网页前端（SYNC_WEB_URL）同源下的地址（防开放重定向：拒绝 //host、/\host、其他协议与主机）。 */
export function safeReturnTo(p: string, webUrl?: string) {
  if (webUrl) {
    try { const u = new URL(p); if (u.origin === webUrl && /^\/(?![/\\])[\w\-./?=&%]*$/.test(u.pathname + u.search)) return u.origin + u.pathname + u.search; } catch {}
    return webUrl + "/account";
  }
  return /^\/(?![/\\])[\w\-./?=&%]*$/.test(p) ? p : "/account";
}
