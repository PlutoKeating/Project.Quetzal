// 网状层：两具身体经（测试用的精简）同步服务交换签名信令，用真实的 node-datachannel 建立 WebRTC 连接；
// 请求 / 应答、事件、大消息分块；以及安全：伪造签名的信令被拒、冒用身体名字但密钥不对的一方过不了通道认证。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { Mesh } from "../src/mesh/mesh.ts";
import { loadNodeKey, seal, Opener, canonical, fingerprint, isNodeKey, type NodeKey } from "../src/mesh/identity.ts";
import { toNdcIce, sdpFingerprint } from "../src/mesh/link.ts";
import { serverOrigin } from "../src/mesh/directory.ts";

let ndc: typeof import("node-datachannel") | undefined;
try { ndc = (await import("node-datachannel")).default as any; } catch {}
const skip = !ndc && "这台机器没有 node-datachannel（可选依赖）";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "quetzal-mesh-"));
const keys: Record<string, NodeKey> = { alpha: loadNodeKey(path.join(tmp, "a.key")), beta: loadNodeKey(path.join(tmp, "b.key")) };

/** 精简的同步服务：hello（令牌 = 身体名）→ welcome；peer 上下线；signal 原样转发（可被测试篡改）。 */
const conns = new Map<string, WebSocket>();
let tamper: ((from: string, to: string, data: any) => any) | undefined;
const registered: Record<string, string> = { alpha: keys.alpha.nodeKey, beta: keys.beta.nodeKey };
const server = http.createServer();
const wss = new WebSocketServer({ server, path: "/v1/ws" });
wss.on("connection", (ws) => {
  let me = "";
  const peer = (b: string, online: boolean) => ({ body: b, kind: "runtime", nodeKey: registered[b], version: "t", online, lastSeen: 0 });
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.t === "hello") {
      me = m.token; conns.set(me, ws);
      ws.send(JSON.stringify({ t: "welcome", protocol: 1, now: Date.now(), agent: { id: "x", name: "x" }, body: me, account: "t",
        peers: Object.keys(registered).filter((b) => b !== me).map((b) => peer(b, conns.has(b))), iceServers: [], ttl: 0 }));
      for (const [b, c] of conns) if (b !== me) c.send(JSON.stringify({ t: "peer", peer: peer(me, true) }));
    } else if (m.t === "signal") {
      const data = tamper ? tamper(me, m.to, m.data) : m.data;
      conns.get(m.to)?.send(JSON.stringify({ t: "signal", from: me, data }));
    }
  });
  ws.on("close", () => { if (conns.get(me) === ws) { conns.delete(me); for (const [, c] of conns) c.send(JSON.stringify({ t: "peer", peer: peer(me, false) })); } });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const SERVER = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

const warnings: string[] = [];
function body(me: string, soulKeys: Record<string, string> = { alpha: keys.alpha.nodeKey, beta: keys.beta.nodeKey }, key = keys[me]) {
  const m = new Mesh({
    me, key, ndc: ndc!, binding: { server: SERVER, token: me, agent: "x", body: me, account: "t" },
    keyOf: (b) => soulKeys[b], hello: () => ({ version: "t" }), log: () => {}, warn: (w) => warnings.push(`${me}: ${w}`),
  });
  m.start();
  return m;
}
const until = async (f: () => boolean, ms = 15_000) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error("等待超时"); await new Promise((r) => setTimeout(r, 50)); } };
const meshes: Mesh[] = [];
after(async () => { for (const m of meshes) m.stop(); wss.close(); server.close(); await new Promise((r) => setTimeout(r, 200)); ndc?.cleanup(); });

test("节点密钥：生成后持久化（0600），公钥 43 个字符；规范化 JSON 与键的顺序无关", () => {
  const again = loadNodeKey(path.join(tmp, "a.key"));
  assert.equal(again.nodeKey, keys.alpha.nodeKey);
  assert.ok(isNodeKey(keys.alpha.nodeKey));
  assert.equal(fs.statSync(path.join(tmp, "a.key")).mode & 0o777, 0o600);
  assert.equal(canonical({ b: 1, a: [2, { d: 3, c: 4 }] }), canonical({ a: [2, { c: 4, d: 3 }], b: 1 }));
  assert.match(fingerprint(keys.alpha.nodeKey), /^[0-9a-f]{4}( [0-9a-f]{4}){3}$/);
});

test("签名信封：收件人、时间窗、重放、篡改、未登记的公钥都会被拒绝", () => {
  const o = new Opener("beta", (b) => (b === "alpha" ? keys.alpha.nodeKey : undefined));
  const e = seal(keys.alpha, "alpha", "beta", { kind: "hello" });
  assert.equal(o.open(e).ok, true);
  assert.match((o.open(e) as any).error, /重放/);
  assert.match((o.open({ ...seal(keys.alpha, "alpha", "beta", { kind: "x" }), body: { kind: "evil" } }) as any).error, /签名不对/);
  assert.match((o.open(seal(keys.alpha, "alpha", "gamma", {})) as any).error, /不是发给/);
  assert.match((o.open(seal(keys.alpha, "alpha", "beta", {}, Date.now() - 10 * 60_000)) as any).error, /5 分钟/);
  assert.match((o.open(seal(keys.beta, "mallory", "beta", {})) as any).error, /没有登记/);
  assert.match((o.open(seal(keys.beta, "alpha", "beta", {})) as any).error, /签名不对/, "用别人的密钥冒充 alpha");
});

test("ICE 服务器格式转换、SDP 指纹、同步服务只接受 HTTPS", () => {
  assert.deepEqual(toNdcIce([{ urls: ["stun:s.example:3478"] }, { urls: ["turn:s.example:3478?transport=udp", "turn:s.example:3478?transport=tcp"], username: "1:a", credential: "c" }]), [
    { hostname: "s.example", port: 3478 },
    { hostname: "s.example", port: 3478, username: "1:a", password: "c", relayType: "TurnUdp" },
    { hostname: "s.example", port: 3478, username: "1:a", password: "c", relayType: "TurnTcp" },
  ]);
  assert.equal(sdpFingerprint("a=fingerprint:sha-256 AB:CD:EF\r\n"), "abcdef");
  assert.throws(() => serverOrigin("http://sync.example"), /HTTPS/);
  assert.equal(serverOrigin("https://sync.example/x"), "https://sync.example");
  assert.equal(serverOrigin("http://127.0.0.1:8080"), "http://127.0.0.1:8080");
});

test("两具身体连上：请求 / 应答、事件、大消息分块", { skip }, async () => {
  const a = body("alpha"), b = body("beta");
  meshes.push(a, b);
  b.handle("echo", (p, from) => ({ p, from }));
  b.handle("boom", () => { throw new Error("故意的"); });
  await until(() => a.connected().includes("beta") && b.connected().includes("alpha"));
  const st = a.status().peers[0];
  assert.deepEqual([st.body, st.link, st.keyOk, st.path?.local], ["beta", "open", true, "host"]);
  assert.deepEqual(await a.request("beta", "echo", { x: 1 }), { p: { x: 1 }, from: "alpha" });
  await assert.rejects(a.request("beta", "boom"), /故意的/);
  await assert.rejects(a.request("beta", "nope"), /没有这个方法/);
  const big = "薰".repeat(300_000); // 约 900 KB：分块传输后重组
  assert.equal(((await a.request("beta", "echo", big)) as any).p.length, big.length);
  const got = new Promise((r) => b.once("event", r));
  a.broadcast("soul.pushed", { files: ["notes/x.md"] });
  assert.deepEqual(await got, { from: "alpha", name: "soul.pushed", data: { files: ["notes/x.md"] } });
  a.stop(); b.stop();
  await until(() => !conns.size);
});

test("同步服务篡改信令：签名不符，被拒绝且提醒；连接建立不起来", { skip }, async () => {
  warnings.length = 0;
  tamper = (_from, _to, data) => ({ ...data, body: { ...data.body, sdp: String(data.body?.sdp ?? "").replace(/a=fingerprint:sha-256 [0-9A-F:]+/, "a=fingerprint:sha-256 00:11") } });
  const a = body("alpha"), b = body("beta");
  meshes.push(a, b);
  await until(() => warnings.some((w) => /签名不对/.test(w)), 10_000);
  assert.equal(a.connected().length + b.connected().length, 0);
  tamper = undefined;
  a.stop(); b.stop();
  await until(() => !conns.size);
});

test("冒用身体：同步服务转告了冒充者的公钥，但灵魂仓库登记的是真的——信令验签失败，连不上", { skip }, async () => {
  warnings.length = 0;
  const mallory = loadNodeKey(path.join(tmp, "m.key"));
  registered.alpha = mallory.nodeKey; // 被攻破的同步服务把 alpha 的公钥换成冒充者的
  const fake = body("alpha", undefined, mallory), b = body("beta");
  meshes.push(fake, b);
  await until(() => warnings.some((w) => /beta: .*(不一致|签名不对)/.test(w)), 10_000);
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(b.connected().length, 0, "beta 不与冒充者建立连接");
  registered.alpha = keys.alpha.nodeKey;
  fake.stop(); b.stop();
});
