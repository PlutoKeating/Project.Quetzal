// 登录：GitHub OAuth（arctic）+ 服务端会话（做法按 Lucia 的会话指南：随机令牌放 Cookie，库里只存它的 SHA-256，滑动续期）。
// 不保存 GitHub 的访问令牌，只读公开资料（不申请任何 scope）。
import { GitHub, generateState, OAuth2RequestError } from "arctic";
import type { Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { Db, User } from "./db.ts";
import type { Config } from "./config.ts";
import { now, randomToken, sha256 } from "./util.ts";

export interface GitHubUser { id: number; login: string; name: string }
/** 可替换的 GitHub 客户端（测试里注入假的）。 */
export interface GitHubClient { authorizationUrl(state: string): URL; user(code: string): Promise<GitHubUser> }

export function githubClient(cfg: Config): GitHubClient | undefined {
  if (!cfg.github) return undefined;
  const gh = new GitHub(cfg.github.id, cfg.github.secret, `${cfg.publicUrl}/auth/github/callback`);
  return {
    authorizationUrl: (state) => gh.createAuthorizationURL(state, []),
    async user(code) {
      let tokens;
      try { tokens = await gh.validateAuthorizationCode(code); }
      catch (e) { throw new Error(e instanceof OAuth2RequestError ? `GitHub 拒绝了授权码：${e.code}` : `无法连接 GitHub：${(e as Error).message}`); }
      const r = await fetch("https://api.github.com/user", {
        headers: { Authorization: `Bearer ${tokens.accessToken()}`, Accept: "application/vnd.github+json", "User-Agent": "quetzal-sync" },
        signal: AbortSignal.timeout(10_000),
      });
      if (!r.ok) throw new Error(`读取 GitHub 资料失败：HTTP ${r.status}`);
      const u = await r.json() as { id: number; login: string; name?: string | null };
      if (!Number.isInteger(u.id) || typeof u.login !== "string") throw new Error("GitHub 返回的资料不完整");
      return { id: u.id, login: u.login, name: u.name ?? "" };
    },
  };
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
    const expires = now() + this.cfg.sessionDays * DAY;
    this.db.createSession(token, userId, expires);
    this.set(c, token, expires);
  }
  /** 当前登录的用户；会话剩余不到一半时续期。allowBearer：/v1/web/* 也接受控制台登录的令牌（Authorization: Bearer qsc_…，只认 console 类型的会话）。 */
  user(c: Context, allowBearer = false): User | undefined {
    const bearer = allowBearer ? /^Bearer (qsc_[\w-]{1,96})$/.exec(c.req.header("authorization") ?? "")?.[1] : undefined;
    const token = bearer ?? getCookie(c, this.cookie);
    if (!token || token.length > 100) return undefined;
    const s = this.db.session(token);
    if (!s || (bearer ? s.kind !== "console" : s.kind === "console")) return undefined;
    if (s.expires < now()) { this.db.deleteSession(token); return undefined; }
    const life = this.cfg.sessionDays * DAY;
    if (s.expires - now() < life / 2) { const e = now() + life; this.db.touchSession(token, e); if (!bearer) this.set(c, token, e); }
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

/** OAuth 的 state 与登录后要回到的页面放在短期 Cookie 里（10 分钟）。 */
export function beginLogin(c: Context, cfg: Config, gh: GitHubClient, returnTo: string) {
  const state = generateState();
  const opts = { httpOnly: true, secure: cfg.secure, sameSite: "Lax" as const, path: "/", maxAge: 600 };
  setCookie(c, "quetzal_oauth_state", state, opts);
  setCookie(c, "quetzal_return_to", safeReturnTo(returnTo, cfg.webUrl), opts);
  return gh.authorizationUrl(state);
}
export function finishLogin(c: Context, cfg: Config): { state?: string; returnTo: string } {
  const state = getCookie(c, "quetzal_oauth_state");
  const returnTo = safeReturnTo(getCookie(c, "quetzal_return_to") ?? "", cfg.webUrl);
  deleteCookie(c, "quetzal_oauth_state", { path: "/" });
  deleteCookie(c, "quetzal_return_to", { path: "/" });
  return { state, returnTo };
}
/** 只允许回到本站的绝对路径，或网页前端（SYNC_WEB_URL）同源下的地址（防开放重定向：拒绝 //host、/\host、其他协议与主机）。 */
export function safeReturnTo(p: string, webUrl?: string) {
  if (webUrl) {
    try { const u = new URL(p); if (u.origin === webUrl && /^\/(?![/\\])[\w\-./?=&%]*$/.test(u.pathname + u.search)) return u.origin + u.pathname + u.search; } catch {}
    return webUrl + "/account";
  }
  return /^\/(?![/\\])[\w\-./?=&%]*$/.test(p) ? p : "/account";
}
