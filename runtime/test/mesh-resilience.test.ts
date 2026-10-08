// 网状层的韧性：网络变化、同步服务的在场失真、直连打不通时经第三具身体中转。真实的 node-datachannel + 测试用的精简同步服务。
import { test, after, mock } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fakeSync } from "./fixtures/fake-sync.ts";
import { Mesh } from "../src/mesh/mesh.ts";
import { loadNodeKey, sign, type NodeKey } from "../src/mesh/identity.ts";
import { watchNetwork, routeLocal, localAddresses } from "../src/mesh/netwatch.ts";
import { Link } from "../src/mesh/link.ts";

let ndc: typeof import("node-datachannel") | undefined;
try { ndc = (await import("node-datachannel")).default as any; } catch {}
const skip = !ndc && "这台机器没有 node-datachannel（可选依赖）";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "quetzal-resilience-"));
const keys: Record<string, NodeKey> = { alpha: loadNodeKey(path.join(tmp, "a.key")), beta: loadNodeKey(path.join(tmp, "b.key")), gamma: loadNodeKey(path.join(tmp, "g.key")) };
const soul: Record<string, string> = Object.fromEntries(Object.entries(keys).map(([b, k]) => [b, k.nodeKey]));
const sync = await fakeSync({ ...soul });
const logs: string[] = [];
function body(me: string) {
  const m = new Mesh({
    me, key: keys[me], ndc: ndc!, binding: { server: sync.url, token: me, agent: "x", body: me, account: "t" },
    keyOf: (b) => soul[b], hello: () => ({ version: "t" }), log: (l) => logs.push(`${me}: ${l}`), warn: () => {},
  });
  m.start();
  meshes.push(m);
  return m;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (f: () => boolean, ms = 20_000) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error("等待超时"); await sleep(50); } };
const meshes: Mesh[] = [];
const stopAll = async () => { for (const m of meshes.splice(0)) m.stop(); sync.tamper = undefined; await until(() => !sync.conns.size); };
after(async () => { await stopAll(); sync.close(); await sleep(200); ndc?.cleanup(); });

test("网络监视：平台通知合并后报告一次；路由探测不发包也能给出本机地址", async () => {
  let fire: (d: string) => void = () => {};
  const got: string[] = [];
  const stop = watchNetwork({ onChange: (w) => got.push(w), platform: (cb) => { fire = cb; }, pollMs: 60_000 });
  fire("WLAN → 移动数据"); fire("WLAN → 移动数据");
  await sleep(1300);
  assert.deepEqual(got, ["WLAN → 移动数据"]);
  stop();
  assert.equal(await routeLocal("127.0.0.1"), "127.0.0.1");
  assert.equal(await routeLocal("不是地址"), undefined);
  assert.ok(localAddresses() instanceof Set);
});

test("网络变了：信令连接用的本机地址没了就立即重连；已连上的直连探一次，通着就留着", { skip }, async () => {
  const a = body("alpha"), b = body("beta");
  await until(() => a.connected().includes("beta") && b.connected().includes("alpha"));
  const ws = sync.conns.get("alpha");
  await (a.dir as any).checkPath(new Set(["203.0.113.9"])); // 本机地址里没有这条连接用的那个
  await until(() => sync.conns.get("alpha") !== ws && a.dir.state === "online", 5000);
  a.onNetwork("测试");
  await sleep(9000); // 探测的时限（8 秒）过去：对方回了音，连接留着
  assert.ok(a.connected().includes("beta"));
  assert.equal(a.peerStatus("beta").link, "open");
  await stopAll();
});

test("同步服务说对方下线、直连其实通着：探一次就留着；直连断了以后不再重试，对方发来连接请求就恢复", { skip }, async () => {
  const a = body("alpha"), b = body("beta");
  await until(() => a.connected().includes("beta") && b.connected().includes("alpha"));
  sync.announce("alpha", "beta", false);
  await sleep(9000);
  assert.ok(a.connected().includes("beta"), "直连通着，不因同步服务的一句「下线」断开");
  // 直连断开（且很久没收到它的信令）：同步服务仍说它下线，就停下不试……
  const la = (a as any).links.get("beta");
  la.lastSignalAt = 0;
  la.fail("测试：断开");
  assert.equal(la.state, "closed");
  // ……beta 那边发现断了会请求重连（hello）：验过签名，说明它在线，alpha 恢复连接
  (b as any).links.get("alpha").fail("测试：断开");
  await until(() => a.connected().includes("beta") && b.connected().includes("alpha"), 20_000);
  await stopAll();
});

test("重新连上同步服务：正在连接（信令被吞了）的直连立即重来，不等 30 秒超时", { skip }, async () => {
  sync.tamper = () => null; // 信令全部丢失（例如信令连接已经走不通）
  const a = body("alpha"), b = body("beta");
  await until(() => (a as any).links.get("beta")?.state === "connecting", 5000);
  await sleep(1500);
  sync.tamper = undefined;
  const t = Date.now();
  sync.conns.get("alpha")!.close(); // alpha 的信令连接断了又连上：welcome 带来整份名单
  await until(() => a.connected().includes("beta") && b.connected().includes("alpha"), 20_000);
  assert.ok(Date.now() - t < 15_000, `用了 ${Date.now() - t} 毫秒`);
  await stopAll();
});

test("应答方请对方发起后没有回音：按时限与退避再请；发起方手上就是对方那一次尝试时不必重来", () => {
  mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: Date.now() });
  try {
    const sent: Record<string, unknown>[] = [];
    const deps = { agent: "x", iceServers: () => ({ servers: [], issued: 0, ttl: 0 }), signal: (b: Record<string, unknown>) => sent.push(b), ndc: ndc ?? ({} as any), log: () => {} };
    const r = new Link({ ...deps, me: "beta", peer: "alpha", key: keys.beta, peerKey: () => soul.alpha });
    r.start();
    assert.deepEqual([sent.length, sent[0].kind, r.state], [1, "hello", "connecting"]);
    mock.timers.tick(15_000);
    assert.equal(r.state, "idle");
    assert.match(r.lastError, /没有回应连接请求/);
    mock.timers.tick(1000);
    assert.equal(sent.length, 2, "退避之后再请一次");
    r.stop();
    if (!ndc) return;
    const i = new Link({ ...deps, me: "alpha", peer: "beta", key: keys.alpha, peerKey: () => soul.beta });
    i.start();
    const gen = (i as any).gen;
    mock.timers.tick(3000);
    i.onSignal({ kind: "hello", have: gen });
    assert.equal((i as any).gen, gen, "对方手上就是这一次：不重来");
    i.onSignal({ kind: "hello", have: "" });
    assert.notEqual((i as any).gen, gen, "对方手上没有连接：重来");
    i.stop();
  } finally { mock.timers.reset(); }
});

test("经第三具身体中转：alpha 与 gamma 直连不通、都连得上 beta——照样连着、请求与事件都到，伪造与重放被拒", { skip }, async () => {
  const blocked = (x: string, y: string) => (x === "alpha" && y === "gamma") || (x === "gamma" && y === "alpha");
  sync.tamper = (from, to, data) => (blocked(from, to) ? null : data);
  const a = body("alpha"), b = body("beta"), g = body("gamma");
  g.handle("echo", (p, from) => ({ p, from }));
  a.handle("echo", (p, from) => ({ p, from }));
  await until(() => a.connected().includes("gamma") && g.connected().includes("alpha"), 30_000);
  assert.equal(a.peerStatus("gamma").via, "beta");
  assert.equal(a.peerStatus("gamma").link, "open");
  assert.deepEqual(await a.request("gamma", "echo", { x: 1 }), { p: { x: 1 }, from: "alpha" });
  assert.deepEqual(await g.request("alpha", "echo", "嗨"), { p: "嗨", from: "gamma" });
  const big = "薰".repeat(200_000);
  assert.equal(((await a.request("gamma", "echo", big)) as any).p.length, big.length);
  const heard: unknown[] = [];
  g.on("event", (e: { from: string; name: string }) => { if (e.name === "hello.all") heard.push(e.from); });
  a.broadcast("hello.all", {});
  await until(() => heard.length === 1);
  assert.deepEqual(heard, ["alpha"]);
  // 中转的 beta 伪造「alpha 发来的」事件：签名对不上，丢弃
  const forged: unknown[] = [];
  g.on("event", (e: { name: string }) => { if (e.name === "evil") forged.push(e); });
  const lb = (b as any).links.get("gamma");
  const p = JSON.stringify({ t: "ev", e: "evil", d: 1 }), ts = Date.now(), nonce = crypto.randomBytes(16).toString("base64url");
  lb.send({ t: "fwd", o: "alpha", d: "gamma", ttl: 8, ts, nonce, p, sig: sign(keys.beta, `quetzal-mesh-fwd/1|x|alpha|gamma|${ts}|${nonce}|${crypto.createHash("sha256").update(p).digest("hex")}`) });
  // 截下一条真的转发再重放：只收一次
  const real: Record<string, unknown>[] = [];
  const la = (a as any).links.get("beta"), send = la.send.bind(la);
  la.send = (m: any) => { if (m?.t === "fwd") real.push(m); return send(m); };
  a.emitTo("gamma", "evil", 2);
  await until(() => real.length === 1 && forged.length === 1);
  lb.send(real[0]);
  await sleep(500);
  assert.equal(forged.length, 1, "伪造的没收，重放的只收了一次");
  la.send = send;
  // 中转的身体走了：经中转也到不了，对上层来说断开
  b.stop();
  await until(() => !a.connected().includes("gamma") && !g.connected().includes("alpha"), 15_000);
  await stopAll();
});
