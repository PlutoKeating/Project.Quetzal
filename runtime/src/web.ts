// 网页控制台：网关托管随运行基座放在 current/web/ 的静态文件（控制台的 Flutter Web 构建），并让同一台机器上的浏览器免配对码登录。
//   目录：QUETZAL_WEB_DIR，缺省为 main.cjs 旁边的 web/（npm 安装器把它放进 releases/<版本>/web/；没有这个目录就不托管）。
//   GET /auth/local：只对「同一台机器上、打开着网关自己托管的网页控制台的浏览器」返回令牌——
//     连接来自回环地址、Host 是本机名（防 DNS 重绑定）、必须带 Origin 且正好是网关自己的源（http://127.0.0.1|localhost|[::1]:<端口>；
//     开发时的其他源只能由环境变量 QUETZAL_DEV_ORIGINS 明确列出），并且发起连接的进程不是运行基座的子孙（agent 的命令都是）。
//     注意：本机的其他进程并不都「本来就读得到」secrets/gateway.token——agent 的命令在沙箱里读不到它，安卓上别的应用也读不到；
//     Origin 头是浏览器加的，命令行程序可以伪造，所以真正挡住 agent 的是子孙进程检查（/proc）与沙箱（浏览器配置目录在沙箱里是空的）。
//     原生的桌面控制台（Linux，dart:io）不是浏览器，请求里没有 Origin：这时改为要求发起连接的 socket 属于运行基座同一个系统用户
//     （读 /proc/net/tcp 的 uid 列），同样不能是运行基座的子孙。没有 Origin 的请求不可能来自别的网页（跨源 fetch 浏览器一定带 Origin，
//     不带 Origin 的 no-cors 请求读不到响应），而别的系统用户的进程连 uid 这一关也过不去。
//     安卓（Termux）上不提供：别的应用能连 127.0.0.1，而控制台 App 由安装器直接拿到令牌。
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";

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
type Req = Pick<http.IncomingMessage, "headers"> & { socket: { remoteAddress?: string; remotePort?: number } };

/** 网关自己的源（网页控制台从这里加载），加上 QUETZAL_DEV_ORIGINS（逗号分隔，开发时 flutter run 的页面）明确列出的。 */
export function allowedOrigins(port: number): Set<string> {
  const dev = (process.env.QUETZAL_DEV_ORIGINS ?? "").split(",").map((x) => x.trim().replace(/\/+$/, "")).filter(Boolean);
  return new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`, ...dev]);
}

/** 请求是否来自同一台机器上打开着网页控制台的浏览器（见文件头；不含子孙进程检查，那个见 fromDescendant）。 */
export function isLocalBrowser(req: Req, port: number): boolean {
  if (!LOOPBACK.has(req.socket.remoteAddress ?? "")) return false;
  if (!LOCAL_HOSTS.has(hostOf(req.headers.host))) return false;
  const origin = String(req.headers.origin ?? "");
  return !!origin && allowedOrigins(port).has(origin);
}

/** 请求是否来自同一台机器上、同一个系统用户的原生客户端（桌面控制台）：回环、Host 是本机名、没有 Origin、连接属于运行基座的用户。只在 Linux 上成立。 */
export function isLocalNative(req: Req, serverPort: number, uid = process.getuid?.()): boolean {
  if (process.platform !== "linux" || uid === undefined) return false;
  if (!LOOPBACK.has(req.socket.remoteAddress ?? "")) return false;
  if (!LOCAL_HOSTS.has(hostOf(req.headers.host))) return false;
  if (req.headers.origin !== undefined) return false; // 带 Origin 的是浏览器：只按 isLocalBrowser 判断
  const port = req.socket.remotePort;
  return !!port && socketUid(port, serverPort) === uid;
}

/**
 * Host 头检查（防 DNS 重绑定：恶意网页把自己的域名解析到 127.0.0.1 后就能向网关发请求，但 Host 仍是它的域名）。
 * 回环连接：Host 必须是本机名。局域网连接（gateway.host 为 0.0.0.0 等）：Host 是 IP 字面量、本机名、配置的监听地址，
 * 或环境变量 QUETZAL_GATEWAY_HOSTS（逗号分隔，如 mybox.local）列出的名字。
 */
export function hostAllowed(req: Req, listen: string): boolean {
  const h = hostOf(req.headers.host);
  if (!h) return false;
  if (LOCAL_HOSTS.has(h)) return true;
  if (LOOPBACK.has(req.socket.remoteAddress ?? "")) return false;
  if (net.isIP(h)) return true;
  const extra = (process.env.QUETZAL_GATEWAY_HOSTS ?? "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
  return h === listen.toLowerCase() || extra.includes(h);
}

/** 客户端一侧端口为 port、对端端口为 serverPort 的那条连接的所属用户（/proc/net/tcp 的 uid 列）。 */
function socketUid(port: number, serverPort: number): number | undefined {
  const row = socketRow(port, serverPort);
  return row ? Number(row[7]) : undefined;
}

/** 客户端一侧端口为 port、对端端口为 serverPort 的那条连接的 socket inode。 */
function socketInode(port: number, serverPort: number): string | undefined {
  return socketRow(port, serverPort)?.[9];
}

/** 读 /proc/net/tcp(6) 里那条连接的一行（按空白切开的各列）。 */
function socketRow(port: number, serverPort: number): string[] | undefined {
  const hex = (n: number) => n.toString(16).toUpperCase().padStart(4, "0");
  for (const f of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let text = "";
    try { text = fs.readFileSync(f, "utf8"); } catch { continue; }
    for (const line of text.split("\n").slice(1)) {
      const c = line.trim().split(/\s+/);
      if (c.length > 9 && c[1].endsWith(`:${hex(port)}`) && c[2].endsWith(`:${hex(serverPort)}`)) return c;
    }
  }
  return undefined;
}

/** 这个进程的全部子孙（读 /proc/<pid>/stat 的父进程号）。 */
function descendants(root: number): number[] {
  const parent = new Map<number, number>();
  let pids: string[] = [];
  try { pids = fs.readdirSync("/proc").filter((d) => /^\d+$/.test(d)); } catch { return []; }
  for (const d of pids) {
    try { const st = fs.readFileSync(`/proc/${d}/stat`, "utf8"); parent.set(Number(d), Number(st.slice(st.lastIndexOf(")") + 2).split(" ")[1])); } catch { /* 已退出 */ }
  }
  const out: number[] = [], seen = new Set([root]);
  let frontier = [root];
  while (frontier.length) {
    const next: number[] = [];
    for (const [pid, pp] of parent) if (frontier.includes(pp) && !seen.has(pid)) { seen.add(pid); next.push(pid); out.push(pid); }
    frontier = next;
  }
  return out;
}

/**
 * 发起这个连接的进程是不是运行基座的子孙（agent 的命令、后台任务、自造工具都是；有独立 pid 命名空间的沙箱里，脱离父进程的守护进程也仍然是）。
 * Linux 上读 /proc；读不到（不是 Linux）时为 false。
 */
export function fromDescendant(req: Req, serverPort: number): boolean {
  const port = req.socket.remotePort;
  if (!port || process.platform !== "linux") return false;
  const inode = socketInode(port, serverPort);
  if (!inode || inode === "0") return false;
  const want = `socket:[${inode}]`;
  for (const pid of descendants(process.pid)) {
    let fds: string[] = [];
    try { fds = fs.readdirSync(`/proc/${pid}/fd`); } catch { continue; }
    for (const fd of fds) { try { if (fs.readlinkSync(`/proc/${pid}/fd/${fd}`) === want) return true; } catch { /* 已关闭 */ } }
  }
  return false;
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
