// 登录：OpenID Connect（授权码 + PKCE S256 + nonce，openid-client 实现：发现、换令牌、ID 令牌校验）+ 服务端会话
// （做法按 Lucia 的会话指南：随机令牌放 Cookie，库里只存它的 SHA-256，滑动续期）。
// 账号由外部的身份服务提供（OIDC_ISSUER），用户以它的 sub 区分；不保存它发的任何令牌，只取一次 ID 令牌里的资料。
// 这里另外保留 GitHub 的换令牌（exchangeCode）：只给链接灵魂仓库用（GitHub App 的用户授权），与登录无关。
import crypto from "node:crypto";
import * as oidc from "openid-client";
import type { Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { MAX_SESSION_DAYS, type Db, type User } from "./db.ts";
import type { Config } from "./config.ts";
import { CONSOLE_SESSION_DAYS } from "./device.ts";
import { now, randomToken, sha256 } from "./util.ts";

/** 身份服务给的资料：sub 在这个身份服务里唯一且不变；email 只在身份服务确认过（email_verified）时才有。 */
export interface LoginUser { sub: string; login: string; name: string; email: string }
/** 可替换的登录客户端（测试里注入假的）。callback 是身份服务带回来的完整回调地址（含 code、state）。 */
export interface LoginClient {
  authorizationUrl(o: { state: string; nonce: string; codeChallenge: string }): Promise<URL>;
  user(callback: URL, o: { state: string; nonce: string; codeVerifier: string }): Promise<LoginUser>;
}

const UA = "quetzal-sync";

/** OIDC 客户端：第一次用到时才去取发现文档（失败下次再取，不影响同步服务启动）。fetcher 供测试注入。 */
export function oidcClient(cfg: Config, fetcher: typeof fetch = fetch): LoginClient | undefined {
  const o = cfg.oidc;
  if (!o) return undefined;
  const redirectUri = `${cfg.publicUrl}/auth/oidc/callback`;
  let found: Promise<oidc.Configuration> | undefined;
  const config = () => (found ??= oidc.discovery(new URL(o.issuer), o.clientId, o.clientSecret, undefined, {
    [oidc.customFetch]: (url, init) => {
      const headers = new Headers(init.headers); headers.set("user-agent", UA);
      return fetcher(url, { ...init, body: init.body as BodyInit, headers, signal: AbortSignal.timeout(10_000) });
    },
    ...(new URL(o.issuer).protocol === "http:" ? { execute: [oidc.allowInsecureRequests] } : {}),
  }).catch((e) => { found = undefined; throw new Error(`连不上身份服务（${(e as Error).message}）`); }));
  return {
    async authorizationUrl({ state, nonce, codeChallenge }) {
      return oidc.buildAuthorizationUrl(await config(), { redirect_uri: redirectUri, scope: "openid profile email", state, nonce, code_challenge: codeChallenge, code_challenge_method: "S256" });
    },
    async user(callback, { state, nonce, codeVerifier }) {
      const tokens = await oidc.authorizationCodeGrant(await config(), callback, { pkceCodeVerifier: codeVerifier, expectedState: state, expectedNonce: nonce, idTokenExpected: true });
      return profile(tokens.claims()!);
    },
  };
}

/** 从 ID 令牌的声明里取资料。显示名：name，没有时拼 given_name / family_name，再没有用 preferred_username。 */
export function profile(c: oidc.IDToken): LoginUser {
  const str = (v: unknown) => (typeof v === "string" ? v.trim().slice(0, 200) : "");
  const email = c.email_verified === true ? str(c.email).toLowerCase() : "";
  const login = str(c.preferred_username) || email || c.sub.slice(0, 12);
  const name = str(c.name) || [str(c.given_name), str(c.family_name)].filter(Boolean).join(" ");
  return { sub: c.sub, login, name, email };
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

/** 登录的临时 Cookie（10 分钟）：state、nonce、PKCE 的 code_verifier、登录后要回到的页面。HTTPS 下用 __Host- 前缀（子域与明文连接都种不了、改不了）。 */
const oauthCookies = (cfg: Config) => {
  const p = cfg.secure ? "__Host-" : "";
  return { state: `${p}quetzal_oauth_state`, nonce: `${p}quetzal_oauth_nonce`, verifier: `${p}quetzal_oauth_verifier`, returnTo: `${p}quetzal_return_to` };
};
export async function beginLogin(c: Context, cfg: Config, client: LoginClient, returnTo: string) {
  const state = oidc.randomState(), nonce = oidc.randomNonce(), verifier = oidc.randomPKCECodeVerifier();
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const url = await client.authorizationUrl({ state, nonce, codeChallenge: challenge }); // 先取到地址（身份服务连不上时不种 Cookie）
  const names = oauthCookies(cfg);
  const opts = { httpOnly: true, secure: cfg.secure, sameSite: "Lax" as const, path: "/", maxAge: 600 };
  setCookie(c, names.state, state, opts);
  setCookie(c, names.nonce, nonce, opts);
  setCookie(c, names.verifier, verifier, opts);
  setCookie(c, names.returnTo, safeReturnTo(returnTo, cfg.webUrl), opts);
  return url;
}
export function finishLogin(c: Context, cfg: Config): { state?: string; nonce?: string; verifier?: string; returnTo: string } {
  const names = oauthCookies(cfg);
  const state = getCookie(c, names.state), nonce = getCookie(c, names.nonce), verifier = getCookie(c, names.verifier);
  const returnTo = safeReturnTo(getCookie(c, names.returnTo) ?? "", cfg.webUrl);
  for (const n of Object.values(names)) deleteCookie(c, n, { path: "/", secure: cfg.secure });
  return { state, nonce, verifier, returnTo };
}
/** 只允许回到本站的绝对路径，或网页前端（SYNC_WEB_URL）同源下的地址（防开放重定向：拒绝 //host、/\host、其他协议与主机）。 */
export function safeReturnTo(p: string, webUrl?: string) {
  if (webUrl) {
    try { const u = new URL(p); if (u.origin === webUrl && /^\/(?![/\\])[\w\-./?=&%]*$/.test(u.pathname + u.search)) return u.origin + u.pathname + u.search; } catch {}
    return webUrl + "/account";
  }
  return /^\/(?![/\\])[\w\-./?=&%]*$/.test(p) ? p : "/account";
}
