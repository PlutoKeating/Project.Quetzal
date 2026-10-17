// 远程 MCP 的 OAuth 2.1 授权（MCP 授权规范：受保护资源元数据 → 授权服务器元数据 → 动态客户端注册 → 授权码 + PKCE → 令牌与刷新），
// 流程由官方 SDK 的 auth() 完成；这里只提供 OAuthClientProvider 的存取：
//   - 客户端注册信息与令牌存在 secrets/mcp-oauth-<来源>.json（0600，secrets/ 在沙箱里不可见），不进日志、灵魂、模型，也不在身体之间同步；
//   - 回调地址是这具身体网关的本机回环地址 /mcp/oauth/callback（RFC 8252 原生应用的做法）；控制台在别的设备上时，可以把浏览器最后停下的地址粘贴回来（finishLogin）；
//   - state 一次有效、10 分钟过期，PKCE 的 code_verifier 只在内存里。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { auth, type OAuthClientProvider, type OAuthClientMetadata, type FetchLike } from "@modelcontextprotocol/client";
import { config, paths, writeSecret } from "../config.ts";
import type { RemoteServer } from "./client.ts";

interface Stored { client?: Record<string, unknown>; tokens?: Record<string, unknown>; discovery?: unknown; saved?: number }
const file = (id: string) => path.join(paths.secrets, `mcp-oauth-${id}.json`);
export const callbackPath = "/mcp/oauth/callback";
export const redirectUrl = () => `http://127.0.0.1:${config.gateway.port}${callbackPath}`;

function load(id: string): Stored {
  try { const j = JSON.parse(fs.readFileSync(file(id), "utf8")); return j && typeof j === "object" ? j : {}; } catch { return {}; }
}
function save(id: string, patch: Partial<Stored>) { writeSecret(path.basename(file(id)), JSON.stringify({ ...load(id), ...patch, saved: Date.now() })); }
export const hasTokens = (id: string) => !!load(id).tokens;
export function forget(id: string) { try { fs.rmSync(file(id), { force: true }); } catch {} }

interface Pending { id: string; state: string; verifier?: string; url?: string; created: number }
const pending = new Map<string, Pending>(); // 按 state
const verifiers = new Map<string, string>(); // 按来源：SDK 先存 verifier 再给授权地址
const PENDING_MS = 10 * 60_000;
const sweep = () => { for (const [k, p] of pending) if (Date.now() - p.created > PENDING_MS) pending.delete(k); };

/** 一个来源的 OAuth 存取。interactive 为假时（启动来源时）不记录待登录的授权地址，只让 SDK 报未授权。 */
export class Provider implements OAuthClientProvider {
  private server: RemoteServer;
  private interactive: boolean;
  private stateValue?: string;
  authorizationUrl?: URL;
  constructor(server: RemoteServer, interactive = false) { this.server = server; this.interactive = interactive; }
  get redirectUrl() { return redirectUrl(); }
  get clientMetadata(): OAuthClientMetadata {
    return { client_name: "Quetzal", redirect_uris: [redirectUrl()], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none",
      ...(this.server.oauth && this.server.oauth.scope ? { scope: this.server.oauth.scope } : {}) } as OAuthClientMetadata;
  }
  state() { this.stateValue ??= crypto.randomBytes(24).toString("base64url"); return this.stateValue; }
  clientInformation() {
    const fixed = this.server.oauth && this.server.oauth.clientId;
    if (fixed) return { client_id: fixed } as never; // 部署者在授权服务器上预先登记的公开客户端
    return load(this.server.id).client as never;
  }
  saveClientInformation(info: unknown) { save(this.server.id, { client: info as Record<string, unknown> }); }
  tokens() { return load(this.server.id).tokens as never; }
  saveTokens(tokens: unknown) { save(this.server.id, { tokens: tokens as Record<string, unknown> }); }
  saveDiscoveryState(state: unknown) { save(this.server.id, { discovery: state }); }
  discoveryState() { return load(this.server.id).discovery as never; }
  redirectToAuthorization(url: URL) {
    this.authorizationUrl = url;
    if (!this.interactive) return;
    sweep();
    const state = url.searchParams.get("state") ?? this.state();
    pending.set(state, { id: this.server.id, state, verifier: verifiers.get(this.server.id), url: url.toString(), created: Date.now() });
  }
  saveCodeVerifier(v: string) { verifiers.set(this.server.id, v); }
  codeVerifier() {
    const v = verifiers.get(this.server.id);
    if (!v) throw new Error("没有进行中的登录（PKCE 校验值不在了，请重新登录）");
    return v;
  }
  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery") {
    if (scope === "verifier") { verifiers.delete(this.server.id); return; }
    if (scope === "all") { forget(this.server.id); return; }
    const s = load(this.server.id);
    if (scope === "client") delete s.client;
    if (scope === "tokens") delete s.tokens;
    if (scope === "discovery") delete s.discovery;
    writeSecret(path.basename(file(this.server.id)), JSON.stringify(s));
  }
}

/** 开始登录：发现、注册，返回要在浏览器里打开的授权地址；已有可用令牌（或刷新成功）时返回 undefined。 */
export async function beginLogin(server: RemoteServer, fetchFn: FetchLike): Promise<string | undefined> {
  const p = new Provider(server, true);
  const r = await auth(p, { serverUrl: server.url, fetchFn, ...(server.oauth && server.oauth.scope ? { scope: server.oauth.scope } : {}) });
  if (r === "AUTHORIZED") return undefined;
  if (!p.authorizationUrl) throw new Error("授权服务器没有给出授权地址");
  const u = p.authorizationUrl;
  if (u.protocol !== "https:" && !(u.protocol === "http:" && /^(127\.|localhost$|\[::1\]$)/.test(u.hostname))) throw new Error("授权地址不是 HTTPS，不打开");
  return u.toString();
}

/** 回调（网关的 /mcp/oauth/callback 或粘贴回来的地址）：按 state 找到待登录的来源，换取令牌。返回来源 id。 */
export async function completeLogin(params: URLSearchParams, find: (id: string) => RemoteServer | undefined, fetchFn: (s: RemoteServer) => FetchLike): Promise<string> {
  sweep();
  const state = params.get("state") ?? "";
  const p = pending.get(state);
  if (!p) throw new Error("登录已过期或不是从这里发起的，请在控制台重新登录");
  pending.delete(state); // 一次有效
  const error = params.get("error");
  if (error) throw new Error(`授权服务器拒绝了：${error}${params.get("error_description") ? `（${params.get("error_description")!.slice(0, 200)}）` : ""}`);
  const code = params.get("code");
  if (!code) throw new Error("回调里没有授权码");
  const server = find(p.id);
  if (!server) throw new Error("这个来源已经删除");
  if (p.verifier) verifiers.set(p.id, p.verifier);
  const provider = new Provider(server, true);
  const iss = params.get("iss") ?? undefined;
  const r = await auth(provider, { serverUrl: server.url, authorizationCode: code, ...(iss ? { iss } : {}), fetchFn: fetchFn(server) });
  verifiers.delete(p.id);
  if (r !== "AUTHORIZED") throw new Error("没有拿到令牌");
  return p.id;
}
/** 待登录的来源（控制台显示「在浏览器里完成登录」）。 */
export const pendingLogins = () => { sweep(); return [...pending.values()].map((p) => p.id); };
