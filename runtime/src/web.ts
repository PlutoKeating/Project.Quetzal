// 网页控制台：网关托管随运行基座放在 current/web/ 的静态文件（控制台的 Flutter Web 构建），并让同一台机器上的浏览器免配对码登录。
//   目录：QUETZAL_WEB_DIR，缺省为 main.cjs 旁边的 web/（npm 安装器把它放进 releases/<版本>/web/；没有这个目录就不托管）。
//   GET /auth/local：只对「同一台机器上的浏览器」返回令牌——连接来自回环地址、Host 是本机名（防 DNS 重绑定）、Origin（若有）也是本机。
//     任何本机进程本来就读得到 secrets/gateway.token，所以这不扩大信任边界；别的机器仍然走配对码。
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".map": "application/json; charset=utf-8",
  ".wasm": "application/wasm", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".jpg": "image/jpeg",
  ".otf": "font/otf", ".ttf": "font/ttf", ".woff": "font/woff", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8",
};
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

/** 网页控制台的目录；没有 index.html 就视为没有网页版。 */
export function webDir(): string | undefined {
  const d = process.env.QUETZAL_WEB_DIR ?? path.join(path.dirname(process.argv[1] ?? ""), "web");
  return fs.existsSync(path.join(d, "index.html")) ? path.resolve(d) : undefined;
}

const hostOf = (v: string | undefined) => (v ?? "").trim().replace(/:\d+$/, "").replace(/^\[|\]$/g, "").toLowerCase();

/** 请求是否来自同一台机器上的浏览器（见文件头）。 */
export function isLocalBrowser(req: Pick<http.IncomingMessage, "headers"> & { socket: { remoteAddress?: string } }): boolean {
  if (!LOOPBACK.has(req.socket.remoteAddress ?? "")) return false;
  if (!LOCAL_HOSTS.has(hostOf(req.headers.host))) return false;
  const origin = req.headers.origin;
  if (origin) { try { if (!LOCAL_HOSTS.has(hostOf(new URL(origin).host))) return false; } catch { return false; } }
  return true;
}

/** 托管静态文件：/ → index.html；没有扩展名的未知路径回退到 index.html（单页应用的路由）；带 ETag，命中返回 304。处理了返回 true。 */
export function serveWeb(dir: string, req: http.IncomingMessage, res: http.ServerResponse): boolean {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  let p: string;
  try { p = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname); } catch { return false; }
  if (p === "/") p = "/index.html";
  let f = path.resolve(dir, "." + p);
  if (f !== dir && !f.startsWith(dir + path.sep)) return false; // 不出目录
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) {
    if (path.extname(p)) return false;
    f = path.join(dir, "index.html");
  }
  const st = fs.statSync(f);
  const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  if (req.headers["if-none-match"] === etag) { res.writeHead(304); res.end(); return true; }
  res.writeHead(200, { "content-type": TYPES[path.extname(f).toLowerCase()] ?? "application/octet-stream", "content-length": st.size, etag, "cache-control": "no-cache" });
  if (req.method === "HEAD") res.end(); else fs.createReadStream(f).pipe(res);
  return true;
}
