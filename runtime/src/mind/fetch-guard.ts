// web_fetch 的出站检查（防 SSRF）：她读网页时只能访问公网地址，不能借它访问这具身体自己的网关（127.0.0.1:7788）、局域网设备或云的元数据服务。
//   - 每一跳都解析 DNS，任何一个地址落在回环、链路本地、私有网段、CGNAT、0.0.0.0、组播或保留地址里就拒绝；
//   - 连接时用自定义 lookup 再查一次，连上的就是检查过的地址（防 DNS 重绑定：检查与连接之间换了解析结果）；
//   - 重定向手动跟随（最多 5 次），每一跳重新检查。
import http from "node:http";
import https from "node:https";
import dns from "node:dns";
import net from "node:net";
import zlib from "node:zlib";

const MAX_REDIRECTS = 5;
const MAX_BYTES = 10 << 20;

function v4Blocked(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
}

/** 这个 IP 不能访问（回环、链路本地、私有、CGNAT、未指定、组播与保留地址；含 IPv4 映射的 IPv6）。 */
export function blockedIp(ip: string): boolean {
  const v = net.isIP(ip);
  if (v === 4) return v4Blocked(ip);
  if (v !== 6) return true;
  const s = ip.toLowerCase();
  const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return v4Blocked(mapped[1]);
  if (/^::ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(s)) { // ::ffff:7f00:1 这种写法
    const [, h, l] = s.match(/^::ffff:([0-9a-f]+):([0-9a-f]+)$/)!;
    const n = (parseInt(h, 16) << 16) >>> 0 | parseInt(l, 16);
    return v4Blocked([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join("."));
  }
  if (s === "::" || s === "::1") return true;
  const first = parseInt(s.split(":")[0] || "0", 16);
  return (first & 0xfe00) === 0xfc00 /* fc00::/7 */ || (first & 0xffc0) === 0xfe80 /* fe80::/10 */ || (first & 0xff00) === 0xff00 /* 组播 */
    || s.startsWith("64:ff9b:") /* NAT64 */ || s.startsWith("2001:db8:");
}

/** 连接时用的 lookup：解析后检查，有不能访问的地址就报错。 */
const guardedLookup: net.LookupFunction = (host, opts, cb) => {
  dns.lookup(host, { ...(opts as dns.LookupOptions), all: true }, (err, addrs) => {
    if (err) return (cb as any)(err);
    const list = addrs as dns.LookupAddress[];
    const bad = list.find((a) => blockedIp(a.address));
    if (bad || !list.length) return (cb as any)(new Error(`不能访问内网或本机地址：${host}`));
    if ((opts as dns.LookupOptions).all) return (cb as any)(null, list);
    (cb as any)(null, list[0].address, list[0].family);
  });
};

/** 检查一个网址能不能访问；返回错误说明或 undefined。 */
export async function checkUrl(u: URL): Promise<string | undefined> {
  if (u.protocol !== "http:" && u.protocol !== "https:") return `只能读取 http / https 网页：${u.protocol}`;
  if (u.username || u.password) return "网址里不能带用户名或密码";
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host)) return blockedIp(host) ? `不能访问内网或本机地址：${host}` : undefined;
  if (/^localhost$|\.localhost$|\.local$|\.internal$/i.test(host)) return `不能访问内网或本机地址：${host}`;
  try {
    const addrs = await dns.promises.lookup(host, { all: true });
    if (!addrs.length || addrs.some((a) => blockedIp(a.address))) return `不能访问内网或本机地址：${host}`;
  } catch (e: any) { return `解析不了 ${host}：${e.code ?? e.message}`; }
  return undefined;
}

export interface GuardedResponse { status: number; url: string; type: string; text: string }

function once(u: URL, headers: Record<string, string>, timeoutMs: number): Promise<http.IncomingMessage> {
  const mod = u.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.request(u, { method: "GET", headers: { ...headers, "accept-encoding": "gzip, deflate, br" }, lookup: guardedLookup, timeout: timeoutMs, agent: false }, resolve);
    req.on("timeout", () => req.destroy(new Error("超时")));
    req.on("error", reject);
    req.end();
  });
}

function body(res: http.IncomingMessage): Promise<string> {
  const enc = String(res.headers["content-encoding"] ?? "").toLowerCase();
  const stream = enc === "gzip" ? res.pipe(zlib.createGunzip()) : enc === "deflate" ? res.pipe(zlib.createInflate()) : enc === "br" ? res.pipe(zlib.createBrotliDecompress()) : res;
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let n = 0;
    stream.on("data", (c: Buffer) => { n += c.length; if (n > MAX_BYTES) { res.destroy(); resolve(Buffer.concat(chunks).toString("utf8")); } else chunks.push(c); });
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    stream.on("error", reject);
  });
}

/** 读取一个公网网页（每一跳都检查地址）。 */
export async function guardedFetch(url: string, headers: Record<string, string> = {}, timeoutMs = 30_000): Promise<GuardedResponse> {
  let u: URL;
  try { u = new URL(url); } catch { throw new Error(`网址不对：${url}`); }
  for (let hop = 0; ; hop++) {
    const bad = await checkUrl(u);
    if (bad) throw new Error(bad);
    const res = await once(u, headers, timeoutMs);
    const loc = res.headers.location;
    if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && loc) {
      res.resume();
      if (hop >= MAX_REDIRECTS) throw new Error(`重定向超过 ${MAX_REDIRECTS} 次`);
      u = new URL(loc, u);
      continue;
    }
    return { status: res.statusCode ?? 0, url: u.toString(), type: String(res.headers["content-type"] ?? ""), text: await body(res) };
  }
}
