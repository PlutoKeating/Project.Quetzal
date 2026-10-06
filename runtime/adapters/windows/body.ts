// Windows 的身体助手（构建为 windows-body.mjs）：在用户登录的桌面会话里，替会话 0 里的运行基座做要桌面的事（通知、截图、剪贴板、打开、播放、拍照、录音）。
//   由控制台托盘在登录时以不显示窗口的方式启动并看护（docs/WINDOWS_DECISIONS.md §4.3）。只监听 127.0.0.1 的随机端口，令牌随机，
//   端口与令牌写进 QUETZAL_HOME\secrets\desktop-body.json（目录只有本用户能读，agent 的命令在沙箱里看不到它，也连不到回环）。
//   启动它的进程（控制台托盘）退出时它也退出。协议：GET /health → {ok, session, pid}；POST /call {op, args}（Authorization: Bearer <令牌>）→ {ok, result} | {ok:false, error}。
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { ops as desktopOps, ps } from "./desktop.ts";
import { startUpgrade } from "./supervise.ts";

// 桌面操作，加上「升级」：从用户的桌面里启动安装（需要提权时能弹出 UAC；会话 0 里的运行基座弹不出）
const ops: Record<string, (a: Record<string, any>) => Promise<unknown>> = { ...desktopOps, upgrade: async (a) => { startUpgrade(a.version ? String(a.version) : undefined, a.id ? String(a.id) : undefined); return "已开始"; } };

export const DESKTOP_BODY_FILE = "desktop-body.json";
const home = process.env.QUETZAL_HOME ?? path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "Quetzal", "home");
const file = path.join(home, "secrets", DESKTOP_BODY_FILE);
const token = crypto.randomBytes(32).toString("hex");
const MAX_BODY = 64 << 10;

const same = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const reply = (res: http.ServerResponse, code: number, body: unknown) => { res.writeHead(code, { "content-type": "application/json; charset=utf-8" }); res.end(JSON.stringify(body)); };

const server = http.createServer((req, res) => {
  const host = String(req.headers.host ?? "").replace(/:\d+$/, "");
  if (!["127.0.0.1", "localhost"].includes(host) || req.headers.origin !== undefined) return reply(res, 403, { ok: false, error: "只接受本机的运行基座" }); // 浏览器发的（带 Origin）一律不收
  if (req.method === "GET" && req.url === "/health") return reply(res, 200, { ok: true, session: "interactive", pid: process.pid });
  if (req.method !== "POST" || req.url !== "/call") return reply(res, 404, { ok: false, error: "没有这个接口" });
  if (!same(String(req.headers.authorization ?? ""), `Bearer ${token}`)) return reply(res, 401, { ok: false, error: "令牌不对" });
  let b = "", n = 0;
  req.on("data", (c: Buffer) => { n += c.length; if (n > MAX_BODY) req.destroy(); else b += c; });
  req.on("end", async () => {
    let q: { op?: string; args?: Record<string, any> };
    try { q = JSON.parse(b || "{}"); } catch { return reply(res, 400, { ok: false, error: "请求不是 JSON" }); }
    const f = ops[String(q.op)];
    if (!f) return reply(res, 400, { ok: false, error: `不认识的操作：${q.op}` });
    try { reply(res, 200, { ok: true, result: (await f(q.args ?? {})) ?? null }); }
    catch (e) { reply(res, 200, { ok: false, error: (e as Error).message.slice(0, 500) }); }
  });
});

server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as { port: number }).port;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ port, token, pid: process.pid, started: Date.now() }));
  fs.renameSync(tmp, file);
  process.stdout.write(`[windows-body] 身体助手在 127.0.0.1:${port}\n`);
});

const bye = () => {
  try { const cur = JSON.parse(fs.readFileSync(file, "utf8")); if (cur.pid === process.pid) fs.rmSync(file, { force: true }); } catch { /* 已经没有 */ }
  ps.stop();
  process.exit(0);
};
process.on("SIGINT", bye); process.on("SIGTERM", bye); process.on("SIGBREAK", bye);
// 启动它的控制台托盘退出了（父进程不在了）：跟着退出，由下一次登录时的托盘重新启动
const parent = process.ppid;
setInterval(() => { try { process.kill(parent, 0); } catch { bye(); } }, 5000).unref();
setInterval(() => {}, 1 << 30); // 保持运行（服务器之外没有别的事件）
