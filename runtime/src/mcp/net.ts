// 远程 MCP 的出站检查：沿用 web_fetch 的思路（mind/fetch-guard.ts）。
//   - 地址只收 HTTPS；回环地址（127.0.0.1、::1、localhost）例外，且只在来源本身配置为回环地址时才允许访问回环；
//   - 其余地址解析 DNS，落在私有、链路本地、CGNAT、元数据等网段的拒绝，连接时再查一次（防 DNS 重绑定）；
//   - 官方 SDK 的每一个请求（MCP 本身、OAuth 的发现、注册、换令牌）都经这里，授权服务器元数据指向内网时同样被挡下。
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { Readable } from "node:stream";
import type { FetchLike } from "@modelcontextprotocol/client";
import { checkUrl, guardedLookup } from "../mind/fetch-guard.ts";

export const loopbackHost = (host: string) => { const h = host.replace(/^\[|\]$/g, "").toLowerCase(); return h === "localhost" || h === "::1" || (net.isIPv4(h) && h.startsWith("127.")); };

/** 来源地址：HTTPS，或回环上的 HTTP；不带用户名密码。返回规范化的 URL，不合格时抛错。 */
export function remoteUrl(raw: string): URL {
  let u: URL;
  try { u = new URL(raw); } catch { throw new Error("MCP 地址不是合法的网址"); }
  if (u.username || u.password) throw new Error("MCP 地址里不能带用户名或密码（凭据放请求头或 OAuth）");
  if (u.protocol !== "https:" && !(u.protocol === "http:" && loopbackHost(u.hostname))) throw new Error("远程 MCP 只接受 HTTPS 地址（本机回环地址除外）");
  if (raw.length > 2048) throw new Error("MCP 地址太长");
  u.hash = "";
  return u;
}

/** 一次请求是否放行：返回错误说明或 undefined。 */
export async function allowed(u: URL, server: URL): Promise<string | undefined> {
  if (u.username || u.password) return "网址里不能带用户名或密码";
  if (loopbackHost(u.hostname)) return loopbackHost(server.hostname) && (u.protocol === "http:" || u.protocol === "https:") ? undefined : "远程 MCP 来源不能访问本机回环地址";
  if (u.protocol !== "https:") return `只接受 HTTPS：${u.origin}`;
  return checkUrl(u);
}

async function bodyOf(input: RequestInfo | URL, init?: RequestInit): Promise<{ headers: Headers; body?: Buffer; method: string; signal?: AbortSignal | null }> {
  if (input instanceof Request) {
    const buf = Buffer.from(await input.arrayBuffer());
    return { headers: new Headers(input.headers), body: buf.length ? buf : undefined, method: input.method, signal: input.signal };
  }
  const headers = new Headers(init?.headers);
  let body: Buffer | undefined;
  const b = init?.body;
  if (typeof b === "string") body = Buffer.from(b);
  else if (b instanceof URLSearchParams) { body = Buffer.from(b.toString()); if (!headers.has("content-type")) headers.set("content-type", "application/x-www-form-urlencoded;charset=UTF-8"); }
  else if (b instanceof Uint8Array) body = Buffer.from(b);
  else if (b instanceof ArrayBuffer) body = Buffer.from(new Uint8Array(b));
  else if (b != null) throw new Error("MCP 请求体类型不受支持");
  return { headers, body, method: init?.method ?? (body ? "POST" : "GET"), signal: init?.signal };
}

/** 给官方 SDK 用的 fetch：每个请求先检查地址，连接时用检查过的解析结果；不自己跟随重定向（交给 SDK 的同源策略）。 */
export function mcpFetch(server: URL): FetchLike {
  return async (input, init) => {
    const u = new URL(input instanceof Request ? input.url : String(input));
    const bad = await allowed(u, server);
    if (bad) throw new Error(bad);
    const { headers, body, method, signal } = await bodyOf(input, init);
    signal?.throwIfAborted();
    const mod = u.protocol === "https:" ? https : http;
    const h: Record<string, string> = {};
    headers.forEach((v, k) => { h[k] = v; });
    if (body) h["content-length"] = String(body.length);
    return new Promise<Response>((resolve, reject) => {
      const req = mod.request(u, { method, headers: h, agent: false, ...(loopbackHost(u.hostname) ? {} : { lookup: guardedLookup }) }, (res) => {
        const out = new Headers();
        for (let i = 0; i + 1 < res.rawHeaders.length; i += 2) out.append(res.rawHeaders[i], res.rawHeaders[i + 1]);
        const status = res.statusCode ?? 502;
        const empty = status === 204 || status === 304 || status < 200 || method === "HEAD";
        if (empty) res.resume();
        resolve(new Response(empty ? null : Readable.toWeb(res) as ReadableStream, { status, statusText: res.statusMessage, headers: out }));
      });
      const onAbort = () => req.destroy(signal?.reason instanceof Error ? signal.reason : new Error("请求已取消"));
      signal?.addEventListener("abort", onAbort, { once: true });
      req.on("error", (e) => { signal?.removeEventListener("abort", onAbort); reject(e); });
      req.on("close", () => signal?.removeEventListener("abort", onAbort));
      req.end(body);
    });
  };
}
