// 网页控制台的托管与本机登录判定。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import { serveWeb, isLocalBrowser, isLocalNative, hostAllowed, fromDescendant, webDir } from "../src/web.ts";
import { spawn } from "node:child_process";

function site() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "quetzal-web-"));
  fs.writeFileSync(path.join(dir, "index.html"), "<html>console</html>");
  fs.mkdirSync(path.join(dir, "assets"));
  fs.writeFileSync(path.join(dir, "assets", "a.js"), "js();");
  fs.writeFileSync(path.join(path.dirname(dir), path.basename(dir) + "-secret.txt"), "nope");
  return dir;
}

/** 原样发送请求行（fetch 与 URL 解析都会先把 /../ 规范化掉，测不到服务端）。 */
function raw(server: http.Server, p: string): Promise<number> {
  const port = (server.address() as any).port;
  return new Promise((resolve) => {
    const s = net.connect(port, "127.0.0.1", () => s.write(`GET ${p} HTTP/1.0\r\nHost: 127.0.0.1:${port}\r\n\r\n`));
    let buf = ""; s.on("data", (d) => (buf += d)); s.on("end", () => resolve(Number(buf.split(" ")[1])));
  });
}

async function get(server: http.Server, p: string, headers: Record<string, string> = {}) {
  const port = (server.address() as any).port;
  const r = await fetch(`http://127.0.0.1:${port}${p}`, { headers });
  return { status: r.status, type: r.headers.get("content-type"), etag: r.headers.get("etag"), text: r.status === 304 ? "" : await r.text() };
}

test("静态文件、单页回退、ETag 与目录穿越", async () => {
  const dir = site();
  const server = http.createServer((req, res) => { if (!serveWeb(dir, req, res)) { res.writeHead(404); res.end("no"); } }).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  try {
    const index = await get(server, "/");
    assert.equal(index.status, 200); assert.match(index.type!, /text\/html/); assert.equal(index.text, "<html>console</html>");
    const js = await get(server, "/assets/a.js");
    assert.equal(js.status, 200); assert.match(js.type!, /javascript/); assert.equal(js.text, "js();");
    assert.equal((await get(server, "/control/models")).text, "<html>console</html>", "无扩展名的路径回退到 index.html");
    assert.equal((await get(server, "/assets/missing.js")).status, 404, "有扩展名的缺失文件是 404");
    assert.equal(await raw(server, "/../" + path.basename(dir) + "-secret.txt"), 404, "不能出目录");
    assert.equal(await raw(server, "/%2e%2e/" + path.basename(dir) + "-secret.txt"), 404, "不能出目录（编码的点）");
    assert.equal((await get(server, "/", { "if-none-match": index.etag! })).status, 304);
  } finally { server.close(); }
});

test("只有同一台机器上打开着网页控制台的浏览器能直接登录：Origin 必须正好是网关自己的源", () => {
  const req = (remote: string, host: string, origin?: string) => ({ socket: { remoteAddress: remote }, headers: { host, ...(origin ? { origin } : {}) } });
  assert.ok(isLocalBrowser(req("127.0.0.1", "127.0.0.1:7788", "http://127.0.0.1:7788"), 7788));
  assert.ok(isLocalBrowser(req("::1", "localhost:7788", "http://localhost:7788"), 7788));
  assert.ok(isLocalBrowser(req("::ffff:127.0.0.1", "[::1]:7788", "http://[::1]:7788"), 7788));
  assert.ok(!isLocalBrowser(req("127.0.0.1", "127.0.0.1:7788"), 7788), "没有 Origin（curl、别的进程）");
  assert.ok(!isLocalBrowser(req("127.0.0.1", "127.0.0.1:7788", "http://localhost:5000"), 7788), "本机其他端口的页面：要由 QUETZAL_DEV_ORIGINS 明确列出");
  process.env.QUETZAL_DEV_ORIGINS = "http://localhost:5000";
  try { assert.ok(isLocalBrowser(req("127.0.0.1", "127.0.0.1:7788", "http://localhost:5000"), 7788)); } finally { delete process.env.QUETZAL_DEV_ORIGINS; }
  assert.ok(!isLocalBrowser(req("192.168.1.5", "192.168.1.2:7788", "http://192.168.1.2:7788"), 7788), "局域网的浏览器");
  assert.ok(!isLocalBrowser(req("127.0.0.1", "evil.example:7788", "http://127.0.0.1:7788"), 7788), "DNS 重绑定：Host 不是本机名");
  assert.ok(!isLocalBrowser(req("127.0.0.1", "127.0.0.1:7788", "https://evil.example"), 7788), "跨站页面");
  assert.ok(!isLocalBrowser(req("127.0.0.1", "127.0.0.1:7788", "null"), 7788), "沙箱化的页面（Origin: null）");
});

test("配对接口的 Host 检查：回环只认本机名，局域网认 IP 字面量与配置的名字", () => {
  const req = (remote: string, host: string) => ({ socket: { remoteAddress: remote }, headers: { host } });
  assert.ok(hostAllowed(req("127.0.0.1", "127.0.0.1:7788"), "127.0.0.1"));
  assert.ok(!hostAllowed(req("127.0.0.1", "evil.example:7788"), "127.0.0.1"), "DNS 重绑定");
  assert.ok(!hostAllowed(req("127.0.0.1", "192.168.1.2:7788"), "0.0.0.0"), "回环连接却带着别的 Host");
  assert.ok(hostAllowed(req("192.168.1.5", "192.168.1.2:7788"), "0.0.0.0"), "局域网：IP 字面量");
  assert.ok(!hostAllowed(req("192.168.1.5", "evil.example:7788"), "0.0.0.0"));
  process.env.QUETZAL_GATEWAY_HOSTS = "mybox.local";
  try { assert.ok(hostAllowed(req("192.168.1.5", "mybox.local:7788"), "0.0.0.0")); } finally { delete process.env.QUETZAL_GATEWAY_HOSTS; }
  assert.ok(!hostAllowed(req("192.168.1.5", ""), "0.0.0.0"), "没有 Host");
});

test("子孙进程检查：基座自己启动的进程连过来能认出，别的连接不算", { skip: process.platform !== "linux" }, async () => {
  const server = http.createServer((req, res) => res.end(String(fromDescendant(req, (server.address() as any).port)))).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const port = (server.address() as any).port;
  try {
    const child = await new Promise<string>((resolve) => {
      const p = spawn(process.execPath, ["-e", `fetch("http://127.0.0.1:${port}/").then((r) => r.text()).then((t) => process.stdout.write(t))`]);
      let out = ""; p.stdout.on("data", (d) => (out += d)); p.on("close", () => resolve(out));
    });
    assert.equal(child, "true", "子进程（agent 的命令就是）");
  } finally { server.close(); }
});


test("没有 index.html 就没有网页版", () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "quetzal-noweb-"));
  process.env.QUETZAL_WEB_DIR = empty;
  assert.equal(webDir(), undefined);
  process.env.QUETZAL_WEB_DIR = site();
  assert.ok(webDir());
  delete process.env.QUETZAL_WEB_DIR;
});


test("原生桌面控制台（没有 Origin）：同一个系统用户的本机连接放行；带 Origin、Host 不对、别的用户都不行", { skip: process.platform !== "linux" }, async () => {
  const seen: http.IncomingMessage[] = [];
  const srv = http.createServer((req, res) => { seen.push(req); res.end("ok"); });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const port = (srv.address() as { port: number }).port;
  const get = (headers: Record<string, string> = {}) => new Promise<void>((r) => { http.get({ host: "127.0.0.1", port, path: "/", headers, agent: false }, (res) => { res.resume(); res.on("end", () => r()); }); });
  // 判断要在连接还开着时做（/proc/net/tcp 里要有这条连接）：在请求处理里调用
  const verdicts: boolean[] = [];
  srv.removeAllListeners("request");
  srv.on("request", (req, res) => { verdicts.push(isLocalNative(req, port)); res.end("ok"); });
  await get();
  await get({ origin: `http://127.0.0.1:${port}` });
  await get({ host: "evil.example" });
  srv.removeAllListeners("request");
  srv.on("request", (req, res) => { verdicts.push(isLocalNative(req, port, 424242)); res.end("ok"); });
  await get();
  srv.close();
  assert.deepEqual(verdicts, [true, false, false, false]);
});
