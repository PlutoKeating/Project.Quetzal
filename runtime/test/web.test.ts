// 网页控制台的托管与本机登录判定。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import { serveWeb, isLocalBrowser, webDir } from "../src/web.ts";

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

test("只有同一台机器上的浏览器能直接登录", () => {
  const req = (remote: string, host: string, origin?: string) => ({ socket: { remoteAddress: remote }, headers: { host, ...(origin ? { origin } : {}) } });
  assert.ok(isLocalBrowser(req("127.0.0.1", "127.0.0.1:7788")));
  assert.ok(isLocalBrowser(req("::1", "localhost:7788")));
  assert.ok(isLocalBrowser(req("::ffff:127.0.0.1", "[::1]:7788")));
  assert.ok(isLocalBrowser(req("127.0.0.1", "127.0.0.1:7788", "http://localhost:5000")), "本机其他端口的页面（开发）");
  assert.ok(!isLocalBrowser(req("192.168.1.5", "192.168.1.2:7788")), "局域网的浏览器");
  assert.ok(!isLocalBrowser(req("127.0.0.1", "evil.example:7788")), "DNS 重绑定：Host 不是本机名");
  assert.ok(!isLocalBrowser(req("127.0.0.1", "127.0.0.1:7788", "https://evil.example")), "跨站页面");
  assert.ok(!isLocalBrowser(req("127.0.0.1", "127.0.0.1:7788", "not a url")));
});

test("没有 index.html 就没有网页版", () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "quetzal-noweb-"));
  process.env.QUETZAL_WEB_DIR = empty;
  assert.equal(webDir(), undefined);
  process.env.QUETZAL_WEB_DIR = site();
  assert.ok(webDir());
  delete process.env.QUETZAL_WEB_DIR;
});
