// 网关的加密局域网传输：证书生成与保存、明文只在回环、HTTPS / WSS、配对证明（与证书指纹绑定）。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import crypto from "node:crypto";
import WebSocket from "ws";

process.env.QUETZAL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "quetzal-tls-"));
const cfg = await import("../src/config.ts");
const { loadConfig, saveConfig, paths } = cfg;
loadConfig();
saveConfig({ body: "tlsbox", gateway: { port: 0, host: "0.0.0.0", lanPort: 0 } }); // 旧配置的写法：host 0.0.0.0 即对局域网开放
const { openStore } = await import("../src/store.ts");
openStore();
const { startGateway, lanEnabled, lanHost } = await import("../src/gateway.ts");
const { generateCert, fingerprintOf, shortFingerprint, pairProof, gatewayTls } = await import("../src/tls.ts");
const { bus } = await import("../src/bus.ts");

const gw = startGateway(false);
await gw.ready;
after(() => gw.close());
const plainPort = (gw.plain.address() as any).port as number;
const lanPort = (gw.tls!.address() as any).port as number;
const notices: string[] = [];
bus.on("notice", (t) => notices.push(t));

/** 本机之外的一个 IPv4 地址（没有网卡时跳过相关测试）。 */
const lanIp = Object.values(os.networkInterfaces()).flat().find((a) => a && a.family === "IPv4" && !a.internal)?.address;

/** HTTPS 请求：只认指纹为 fp 的证书（模拟控制台的钉住）。返回状态、内容与握手时看到的指纹。 */
function req(method: string, url: string, body?: unknown, o: { secure?: boolean; headers?: Record<string, string> } = {}): Promise<{ status: number; json: any; fp?: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === "https:" ? https : http;
    const r = lib.request(u, { method, rejectUnauthorized: false, headers: { "content-type": "application/json", ...o.headers }, agent: false } as any, (res) => {
      const fp = (res.socket as tls.TLSSocket).getPeerCertificate?.()?.raw;
      let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => resolve({ status: res.statusCode!, json: b ? JSON.parse(b) : {}, fp: fp ? fingerprintOf(fp) : undefined }));
    });
    r.on("error", reject);
    r.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
/** 从通知里取出配对码。 */
const lastCode = () => notices.at(-1)!.match(/配对码 ([A-Z0-9]{4})-([A-Z0-9]{4})/)!.slice(1).join("");

test("证书：首次生成并保存（私钥 0600），ECDSA P-256 自签名、10 年、CN=quetzal-<身体名>；再次读取指纹不变", () => {
  const key = path.join(paths.secrets, "gateway-tls.key"), crt = path.join(paths.secrets, "gateway-tls.crt");
  assert.equal(fs.statSync(key).mode & 0o777, 0o600);
  assert.equal(fs.statSync(crt).mode & 0o777, 0o600);
  const x = new crypto.X509Certificate(fs.readFileSync(crt));
  assert.equal(x.subject, "CN=quetzal-tlsbox");
  assert.equal((x.publicKey.asymmetricKeyDetails as any).namedCurve, "prime256v1");
  assert.ok(x.verify(x.publicKey), "自签名验证通过");
  assert.ok(x.checkPrivateKey(crypto.createPrivateKey(fs.readFileSync(key))));
  const years = (Date.parse(x.validTo) - Date.parse(x.validFrom)) / (365.25 * 864e5);
  assert.ok(years > 9.9 && years < 10.1, `有效期 ${years} 年`);
  assert.equal(gw.fingerprint, fingerprintOf(x.raw));
  assert.equal(x.fingerprint256.replace(/:/g, "").toLowerCase(), gw.fingerprint);
  assert.match(shortFingerprint(gw.fingerprint), /^[0-9a-f]{4} [0-9a-f]{4} [0-9a-f]{4} [0-9a-f]{4}$/);
  assert.equal(gatewayTls("tlsbox").fingerprint, gw.fingerprint, "缓存与文件一致");
  const g = generateCert("quetzal-x");
  assert.notEqual(fingerprintOf(new crypto.X509Certificate(g.cert).raw), gw.fingerprint, "每次生成都是新密钥");
});

test("局域网开关：host 非回环或 lan 为真都算开放；只开 lan 时 HTTPS 监听 0.0.0.0", () => {
  assert.equal(lanEnabled({ host: "0.0.0.0" }), true);
  assert.equal(lanEnabled({ host: "127.0.0.1" }), false);
  assert.equal(lanEnabled({ host: "127.0.0.1", lan: true }), true);
  assert.equal(lanHost({ host: "127.0.0.1" }), "0.0.0.0");
  assert.equal(lanHost({ host: "192.168.1.5" }), "192.168.1.5");
  assert.equal(cfg.config.gateway.lanPort, 0);
  assert.equal(cfg.defaults.gateway.lanPort, 7789);
});

test("明文 HTTP 只在回环：127.0.0.1 可用，局域网地址上连不上明文端口；HTTPS 端口不接受明文请求", { skip: !lanIp && "没有非回环的 IPv4 地址" }, async () => {
  assert.equal((await req("GET", `http://127.0.0.1:${plainPort}/health`)).json.ok, true);
  await assert.rejects(req("GET", `http://${lanIp}:${plainPort}/health`), /ECONNREFUSED/);
  await assert.rejects(req("GET", `http://${lanIp}:${lanPort}/health`));
  const r = await req("GET", `https://${lanIp}:${lanPort}/health`);
  assert.equal(r.json.ok, true);
  assert.equal(r.fp, gw.fingerprint, "局域网上看到的就是这张证书");
});

test("HTTPS：TLS 1.2 起，拒绝 TLS 1.1；/pair/info 返回指纹；/auth/local 在加密监听上一律拒绝", async () => {
  const info = await req("GET", `https://127.0.0.1:${lanPort}/pair/info`);
  assert.deepEqual({ ...info.json, version: undefined }, { ok: true, fingerprint: gw.fingerprint, short: shortFingerprint(gw.fingerprint), body: "tlsbox", version: undefined, tls: true });
  assert.equal(info.fp, gw.fingerprint);
  assert.equal((await req("GET", `http://127.0.0.1:${plainPort}/pair/info`)).json.fingerprint, gw.fingerprint, "回环上也给出 TLS 证书的指纹");
  await assert.rejects(new Promise((resolve, reject) => {
    const s = tls.connect({ host: "127.0.0.1", port: lanPort, rejectUnauthorized: false, maxVersion: "TLSv1.1", minVersion: "TLSv1" }, () => { s.end(); resolve(s.getProtocol()); });
    s.on("error", reject);
  }));
  const a = await req("GET", `https://127.0.0.1:${lanPort}/auth/local`, undefined, { headers: { origin: `https://127.0.0.1:${lanPort}` } });
  assert.equal(a.status, 403);
});

test("配对：加密监听上只收证明——拒绝 {code}；指纹不同算出的证明不正确；正确的证明换到令牌与指纹", async () => {
  const base = `https://127.0.0.1:${lanPort}`;
  assert.equal((await req("POST", `${base}/pair/start`)).status, 200);
  const code = lastCode();
  assert.match(notices.at(-1)!, new RegExp(`证书指纹 ${shortFingerprint(gw.fingerprint)}`), "通知里有短指纹");
  const plain = await req("POST", `${base}/pair/finish`, { code });
  assert.equal(plain.status, 400, "加密连接上不收配对码");
  // 中间人：客户端看到的是另一张证书，算出的证明对不上
  const mitm = fingerprintOf(new crypto.X509Certificate(generateCert("quetzal-evil").cert).raw);
  assert.equal((await req("POST", `${base}/pair/finish`, { proof: pairProof(code, mitm) })).status, 403);
  const seen = (await req("GET", `${base}/pair/info`)).fp!; // 控制台握手时看到的指纹
  const ok = await req("POST", `${base}/pair/finish`, { proof: pairProof(code, seen) });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.fingerprint, gw.fingerprint);
  assert.equal(ok.json.token, fs.readFileSync(path.join(paths.secrets, "gateway.token"), "utf8").trim());
  assert.equal((await req("POST", `${base}/pair/finish`, { proof: pairProof(code, gw.fingerprint) })).status, 410, "用过即失效");
});

test("配对：回环明文监听仍收 {code}（同一台机器、旧控制台），也收证明（指纹为 TLS 证书的）；配对码的写法不计大小写与连字符", async () => {
  const base = `http://127.0.0.1:${plainPort}`;
  await req("POST", `${base}/pair/start`);
  const code = lastCode();
  const r = await req("POST", `${base}/pair/finish`, { code: `${code.slice(0, 4).toLowerCase()}-${code.slice(4)}` });
  assert.equal(r.status, 200);
  assert.ok(r.json.token);
  await req("POST", `${base}/pair/start`);
  const c2 = lastCode();
  assert.notEqual(c2, code);
  assert.equal((await req("POST", `${base}/pair/finish`, { proof: pairProof(c2, gw.fingerprint).toUpperCase() })).status, 200, "证明不区分大小写");
});

test("WSS：加密监听上的 /rpc 认证后收到 hello；令牌不对断开", async () => {
  const token = fs.readFileSync(path.join(paths.secrets, "gateway.token"), "utf8").trim();
  const hello = await new Promise<any>((resolve, reject) => {
    const ws = new WebSocket(`wss://127.0.0.1:${lanPort}/rpc`, { rejectUnauthorized: false });
    ws.on("open", () => ws.send(JSON.stringify({ auth: token })));
    ws.on("message", (m) => { ws.close(); resolve(JSON.parse(String(m))); });
    ws.on("error", reject);
  });
  assert.equal(hello.event, "hello");
  const code = await new Promise<number>((resolve) => {
    const ws = new WebSocket(`wss://127.0.0.1:${lanPort}/rpc`, { rejectUnauthorized: false });
    ws.on("open", () => ws.send(JSON.stringify({ auth: "wrong" })));
    ws.on("close", (c) => resolve(c));
    ws.on("error", () => {});
  });
  assert.equal(code, 4401);
});

test("配对证明的已知向量（控制台的 Dart 实现用同一组数据核对）", () => {
  assert.equal(pairProof("ABCDEFGH", "00".repeat(32)), "23473714b2a61fbc2a61de0a7636402e197af0b3fe1ee19be90503518e30e4df");
  assert.equal(pairProof("K7MP2QXR", "3f9a1c0be5d24477a86e0f1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f"), "fe1a8c085d10102af4004ba42642242a5cb860cad28ec405b64e480c19e57794");
  assert.equal(pairProof("K7MP2QXR", "3F9A1C0BE5D24477A86E0F1B2C3D4E5F60718293A4B5C6D7E8F90A1B2C3D4E5F"), "fe1a8c085d10102af4004ba42642242a5cb860cad28ec405b64e480c19e57794", "指纹不区分大小写");
});

test("证书：重启后从文件读回同一张；文件损坏时重新生成（指纹改变，控制台需重新配对）", async () => {
  const { resetTlsCache } = await import("../src/tls.ts");
  resetTlsCache();
  assert.equal(gatewayTls("tlsbox").fingerprint, gw.fingerprint);
  fs.writeFileSync(path.join(paths.secrets, "gateway-tls.crt"), "broken");
  resetTlsCache();
  const again = gatewayTls("tlsbox");
  assert.notEqual(again.fingerprint, gw.fingerprint);
  assert.equal(fingerprintOf(new crypto.X509Certificate(fs.readFileSync(path.join(paths.secrets, "gateway-tls.crt"))).raw), again.fingerprint);
});
