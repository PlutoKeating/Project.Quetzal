// 局域网信令（mesh/lan.ts）：先经同步服务连上、记下彼此的局域网地址；同步服务连不上之后重启，照样经局域网连上。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import dgram from "node:dgram";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fakeSync } from "./fixtures/fake-sync.ts";
import { Mesh } from "../src/mesh/mesh.ts";
import { Lan, privateAddr } from "../src/mesh/lan.ts";
import { loadNodeKey, seal, type NodeKey } from "../src/mesh/identity.ts";
import { localAddresses } from "../src/mesh/netwatch.ts";

let ndc: typeof import("node-datachannel") | undefined;
try { ndc = (await import("node-datachannel")).default as any; } catch {}
const hasLanAddr = [...(localAddresses() ?? [])].some((a) => privateAddr(a) && !a.startsWith("127."));
const skip = !ndc ? "这台机器没有 node-datachannel（可选依赖）" : !hasLanAddr ? "这台机器没有私有网段的地址" : false;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "quetzal-lan-"));
const keys: Record<string, NodeKey> = { alpha: loadNodeKey(path.join(tmp, "a.key")), beta: loadNodeKey(path.join(tmp, "b.key")), mallory: loadNodeKey(path.join(tmp, "m.key")) };
const soul: Record<string, string> = { alpha: keys.alpha.nodeKey, beta: keys.beta.nodeKey };
const sync = await fakeSync({ ...soul });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (f: () => boolean, ms = 20_000) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error("等待超时"); await sleep(50); } };
const meshes: Mesh[] = [];
after(async () => { for (const m of meshes) m.stop(); sync.close(); await sleep(200); ndc?.cleanup(); });

/** 一个空闲的 UDP 端口。 */
async function freePort(): Promise<number> {
  const s = dgram.createSocket("udp4");
  await new Promise<void>((r) => s.bind(0, () => r()));
  const p = s.address().port;
  await new Promise<void>((r) => s.close(() => r()));
  return p;
}

test("只认私有地址；只在验证过身份后记下地址，记住的地址表写盘、重启后还在", async () => {
  for (const a of ["10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.8", "169.254.3.4", "127.0.0.1"]) assert.ok(privateAddr(a), a);
  for (const a of ["8.8.8.8", "172.32.0.1", "100.64.0.1", "fd00::1", "fe80::1", "不是地址"]) assert.ok(!privateAddr(a), a);
  const file = path.join(tmp, "lan-unit.json");
  const lan = new Lan({ me: "alpha", port: 0, file, onEnvelope: () => {}, log: () => {} });
  lan.learn("beta", "8.8.8.8", 7788);
  lan.learn("beta", "192.168.1.8", 70000);
  lan.learn("alpha", "192.168.1.9", 7788);
  assert.deepEqual(lan.known(), []);
  lan.learn("beta", "192.168.1.8", 7788);
  assert.deepEqual(new Lan({ me: "alpha", port: 0, file, onEnvelope: () => {}, log: () => {} }).known(), ["beta"]);
});

test("收到的包：太大、不是发给我的、来源是自己的名字、不是 JSON 都丢弃；合格的交给网状层验签", async () => {
  const got: string[] = [];
  const lan = new Lan({ me: "alpha", port: 0, onEnvelope: (from) => got.push(from), log: () => {} });
  await lan.start();
  const s = dgram.createSocket("udp4");
  const send = (x: string | Buffer) => new Promise<void>((r) => s.send(x, lan.bound, "127.0.0.1", () => r()));
  await send("not json");
  await send(JSON.stringify({ from: "beta", to: "gamma" }));
  await send(JSON.stringify({ from: "alpha", to: "alpha" }));
  await send(Buffer.alloc(70 << 10, 32));
  await send(JSON.stringify(seal(keys.beta, "x", "beta", "alpha", { kind: "hello" })));
  await sleep(300);
  assert.deepEqual(got, ["beta"]);
  s.close(); lan.stop();
});

test("同步服务连不上：记得局域网地址的身体照样连上；签名不对的局域网信令不收", { skip }, async () => {
  const [pa, pb] = [await freePort(), await freePort()];
  const files = { alpha: path.join(tmp, "a-lan.json"), beta: path.join(tmp, "b-lan.json") };
  const ports = { alpha: pa, beta: pb } as Record<string, number>;
  const body = (me: string, server: string) => {
    const m = new Mesh({
      me, key: keys[me], ndc: ndc!, binding: { server, token: me, agent: "x", body: me, account: "t" },
      keyOf: (b) => soul[b], kindOf: (b) => (soul[b] ? "runtime" : undefined), hello: () => ({ version: "t" }), log: () => {}, warn: () => {},
      lan: { port: ports[me], file: files[me as "alpha" | "beta"], kickMs: 300 }, watchNetwork: false,
    });
    m.start(); meshes.push(m);
    return m;
  };
  // 第一次：经同步服务连上，互相告诉局域网端口
  let a = body("alpha", sync.url), b = body("beta", sync.url);
  await until(() => a.connected().includes("beta") && b.connected().includes("alpha"));
  await until(() => fs.existsSync(files.alpha) && fs.existsSync(files.beta), 5000);
  assert.ok(JSON.parse(fs.readFileSync(files.alpha, "utf8")).beta, "alpha 记下了 beta 的局域网地址");
  a.stop(); b.stop();
  // 同步服务连不上（地址指向一个没人监听的端口）：重启后经局域网连上
  const dead = `http://127.0.0.1:${await freePort()}`;
  a = body("alpha", dead); b = body("beta", dead);
  await until(() => a.connected().includes("beta") && b.connected().includes("alpha"), 30_000);
  assert.notEqual(a.dir.state, "online");
  assert.equal(a.status().peers.find((p) => p.body === "beta")?.link, "open");
  // 灵魂仓库里没有登记的身体发来的局域网信令：不收，也不记它的地址
  const s = dgram.createSocket("udp4");
  await new Promise<void>((r) => s.send(JSON.stringify(seal(keys.mallory, "x", "mallory", "alpha", { kind: "hello" })), pa, "127.0.0.1", () => r()));
  await sleep(300);
  s.close();
  assert.ok(!JSON.parse(fs.readFileSync(files.alpha, "utf8")).mallory);
  assert.ok(!a.status().peers.some((p) => p.body === "mallory"));
  a.stop(); b.stop();
});
