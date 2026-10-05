// 网状层：两具身体经（测试用的精简）同步服务交换签名信令，用真实的 node-datachannel 建立 WebRTC 连接；
// 请求 / 应答、事件、大消息分块；以及安全：伪造签名的信令被拒、冒用身体名字但密钥不对的一方过不了通道认证。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fakeSync } from "./fixtures/fake-sync.ts";
import { Mesh } from "../src/mesh/mesh.ts";
import { loadNodeKey, seal, Opener, canonical, fingerprint, isNodeKey, type NodeKey } from "../src/mesh/identity.ts";
import { toNdcIce, sdpFingerprint } from "../src/mesh/link.ts";
import { serverOrigin } from "../src/mesh/directory.ts";

let ndc: typeof import("node-datachannel") | undefined;
try { ndc = (await import("node-datachannel")).default as any; } catch {}
const skip = !ndc && "这台机器没有 node-datachannel（可选依赖）";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "quetzal-mesh-"));
const keys: Record<string, NodeKey> = { alpha: loadNodeKey(path.join(tmp, "a.key")), beta: loadNodeKey(path.join(tmp, "b.key")), hermes: loadNodeKey(path.join(tmp, "h.key")), gamma: loadNodeKey(path.join(tmp, "g.key")) };

const registered: Record<string, string> = { alpha: keys.alpha.nodeKey, beta: keys.beta.nodeKey };
const sync = await fakeSync(registered);
const conns = sync.conns, SERVER = sync.url;

const warnings: string[] = [];
function body(me: string, soulKeys: Record<string, string> = { alpha: keys.alpha.nodeKey, beta: keys.beta.nodeKey }, key = keys[me], o: { soulKinds?: Record<string, string>; reader?: boolean } = {}) {
  const m = new Mesh({
    me, key, ndc: ndc!, binding: { server: SERVER, token: me, agent: "x", body: me, account: "t" },
    keyOf: (b) => soulKeys[b], kindOf: (b) => o.soulKinds?.[b], reader: o.reader, hello: () => ({ version: "t" }), log: () => {}, warn: (w) => warnings.push(`${me}: ${w}`),
  });
  m.start();
  return m;
}
const until = async (f: () => boolean, ms = 15_000) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error("等待超时"); await new Promise((r) => setTimeout(r, 50)); } };
const meshes: Mesh[] = [];
after(async () => { for (const m of meshes) m.stop(); sync.close(); await new Promise((r) => setTimeout(r, 200)); ndc?.cleanup(); });

test("节点密钥：生成后持久化（0600），公钥 43 个字符；规范化 JSON 与键的顺序无关", () => {
  const again = loadNodeKey(path.join(tmp, "a.key"));
  assert.equal(again.nodeKey, keys.alpha.nodeKey);
  assert.ok(isNodeKey(keys.alpha.nodeKey));
  assert.equal(fs.statSync(path.join(tmp, "a.key")).mode & 0o777, 0o600);
  assert.equal(canonical({ b: 1, a: [2, { d: 3, c: 4 }] }), canonical({ a: [2, { c: 4, d: 3 }], b: 1 }));
  assert.match(fingerprint(keys.alpha.nodeKey), /^[0-9a-f]{4}( [0-9a-f]{4}){3}$/);
});

test("签名信封：收件人、时间窗、重放、篡改、未登记的公钥、别的 agent、旧协议、早于启动都会被拒绝", () => {
  const o = new Opener("beta", "x", (b) => (b === "alpha" ? keys.alpha.nodeKey : undefined));
  const e = seal(keys.alpha, "x", "alpha", "beta", { kind: "hello" });
  assert.equal(o.open(e).ok, true);
  assert.match((o.open(e) as any).error, /重放/);
  assert.match((o.open({ ...seal(keys.alpha, "x", "alpha", "beta", { kind: "x" }), body: { kind: "evil" } }) as any).error, /签名不对/);
  assert.match((o.open(seal(keys.alpha, "x", "alpha", "gamma", {})) as any).error, /不是发给/);
  assert.match((o.open(seal(keys.alpha, "x", "alpha", "beta", {}, Date.now() - 10 * 60_000)) as any).error, /5 分钟/);
  const unknown = o.open(seal(keys.beta, "x", "mallory", "beta", {})) as any;
  assert.match(unknown.error, /没有登记/); assert.equal(unknown.unknown, true);
  assert.match((o.open(seal(keys.beta, "x", "alpha", "beta", {})) as any).error, /签名不对/, "用别人的密钥冒充 alpha");
  assert.match((o.open(seal(keys.alpha, "other-agent", "alpha", "beta", {})) as any).error, /不是同一个 agent/, "另一个 agent 的信令不能拿来重放");
  const old = { ...seal(keys.alpha, "x", "alpha", "beta", {}), v: 1 };
  assert.match((o.open(old) as any).error, /协议版本/);
  assert.match((o.open({ ...seal(keys.alpha, "x", "alpha", "beta", {}), from: "Alpha!" }) as any).error, /格式不对/);
  // 重启后随机数清空：签于这次启动一分钟以前的信封不收（在 5 分钟时间窗之内也不收）
  const fresh = new Opener("beta", "x", (b) => (b === "alpha" ? keys.alpha.nodeKey : undefined), Date.now());
  assert.match((fresh.open(seal(keys.alpha, "x", "alpha", "beta", {}, Date.now() - 3 * 60_000)) as any).error, /启动之前/);
  assert.equal(fresh.open(seal(keys.alpha, "x", "alpha", "beta", {}, Date.now() - 30_000)).ok, true);
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
  sync.tamper = (_from, _to, data) => ({ ...data, body: { ...data.body, sdp: String(data.body?.sdp ?? "").replace(/a=fingerprint:sha-256 [0-9A-F:]+/, "a=fingerprint:sha-256 00:11") } });
  const a = body("alpha"), b = body("beta");
  meshes.push(a, b);
  await until(() => warnings.some((w) => /签名不对/.test(w)), 10_000);
  assert.equal(a.connected().length + b.connected().length, 0);
  sync.tamper = undefined;
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

test("只读成员（灵魂桥）：连得上，只能调用可读的方法；发来的事件丢弃；不在 connected() 里、收不到广播；同步服务谎称它是运行基座也不行", { skip }, async () => {
  const soulKeys = { alpha: keys.alpha.nodeKey, beta: keys.beta.nodeKey, hermes: keys.hermes.nodeKey };
  const soulKinds = { alpha: "runtime", hermes: "bridge" };
  registered.hermes = keys.hermes.nodeKey;
  sync.kinds.hermes = "runtime"; // 同步服务说它是运行基座，灵魂仓库登记的是灵魂桥：以灵魂仓库为准
  const a = body("alpha", soulKeys, keys.alpha, { soulKinds }), h = body("hermes", soulKeys, keys.hermes, { soulKinds, reader: true });
  meshes.push(a, h);
  let poked = 0;
  a.handle("digest", () => ({ ok: 1 }), true);
  a.handle("mind.wake", () => { poked++; return "woke"; });
  a.on("event", () => poked++);
  const gotPeer: string[] = [];
  a.on("peer", (s: { body: string }) => gotPeer.push(s.body));
  await until(() => a.connectedReaders().includes("hermes") && h.connected().includes("alpha"));
  assert.deepEqual(a.connected(), [], "灵魂桥不是正式成员");
  assert.ok(!gotPeer.includes("hermes"), "不触发正式成员的上线事件（不复制、不选协调者）");
  assert.equal(a.peerStatus("hermes").kind, "bridge");
  assert.deepEqual(await h.request("alpha", "digest"), { ok: 1 });
  await assert.rejects(h.request("alpha", "mind.wake", { kind: "think" }), /只读成员不能调用/);
  h.emitTo("alpha", "replica", { table: "messages", rows: [{ id: 1 }] });
  const heard = new Promise((r) => { h.once("event", () => r("heard")); setTimeout(() => r("silent"), 800); });
  a.broadcast("soul.pushed", {});
  assert.equal(await heard, "silent", "广播不发给只读成员");
  await assert.rejects(a.request("hermes", "anything", {}, 1500), /没有回应/, "只读成员不提供方法");
  assert.equal(poked, 0);
  a.stop(); h.stop();
  delete registered.hermes; delete sync.kinds.hermes;
  await until(() => !conns.size);
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("对方发来坏消息：进程不崩，断开这条连接；监听者抛错不影响别的监听者", { skip }, async () => {
  const a = body("alpha"), b = body("beta");
  meshes.push(a, b);
  await until(() => a.connected().includes("beta") && b.connected().includes("alpha"));
  let got = 0;
  b.on("event", () => { throw new Error("监听者出错"); });
  b.on("event", () => got++);
  a.broadcast("x", {});
  await until(() => got === 1);
  const errors: string[] = [];
  b.on("peer", (st: { link: string; error?: string }) => { if (st.link !== "open" && st.error) errors.push(st.error); });
  const CHUNK = 48 * 1024;
  for (const bad of ["null", "[1]", "5", "不是 JSON", JSON.stringify({ t: "chunk", id: "x", i: 0, n: 2, d: "a".repeat(CHUNK + 1) }), JSON.stringify({ t: "chunk", id: "y", i: 0, n: 10_000, d: "a" })]) {
    await until(() => a.connected().includes("beta") && b.connected().includes("alpha"));
    const n = errors.length;
    (a as any).links.get("beta").dc.sendMessage(bad);
    await until(() => errors.length > n);
    assert.match(errors.at(-1)!, /违反了协议/, bad.slice(0, 20));
  }
  // 连接恢复后照常工作
  b.handle("echo", (p) => p);
  await until(() => a.connected().includes("beta"));
  assert.equal(await a.request("beta", "echo", 1), 1);
  a.stop(); b.stop();
  await until(() => !conns.size);
});

test("回应只认发给它的那具身体：第三具身体冒用请求编号送来的回应被丢弃", { skip }, async () => {
  const soul3 = { alpha: keys.alpha.nodeKey, beta: keys.beta.nodeKey, gamma: keys.gamma.nodeKey };
  registered.gamma = keys.gamma.nodeKey;
  const a = body("alpha", soul3), b = body("beta", soul3), g = body("gamma", soul3);
  meshes.push(a, b, g);
  b.handle("slow", async () => { await sleep(600); return "真的"; });
  await until(() => a.connected().includes("beta") && a.connected().includes("gamma") && g.connected().includes("alpha"));
  const p = a.request("beta", "slow");
  const id = [...(a as any).pending.keys()][0];
  (g as any).links.get("alpha").send({ t: "res", id, ok: true, r: "伪造的" });
  assert.equal(await p, "真的");
  a.stop(); b.stop(); g.stop();
  delete registered.gamma;
  await until(() => !conns.size);
});

test("钉住公钥（TOFU）：灵魂仓库里的公钥变了，现有连接断开、不再连接，确认（acceptPin）后才恢复", { skip }, async () => {
  warnings.length = 0;
  const soulB = { alpha: keys.alpha.nodeKey, beta: keys.beta.nodeKey };
  const a = body("alpha"), b = body("beta", soulB);
  meshes.push(a, b);
  await until(() => b.connected().includes("alpha"));
  // alpha 换了密钥（重装，或有人改了灵魂仓库）：拉取灵魂仓库后核对
  const alpha2 = loadNodeKey(path.join(tmp, "a2.key"));
  soulB.alpha = alpha2.nodeKey;
  b.reverify();
  await until(() => b.peerStatus("alpha").pinMismatch === true && !b.connected().includes("alpha"));
  assert.ok(warnings.some((w) => /beta: .*公钥变了/.test(w)));
  a.stop();
  await until(() => !conns.has("alpha"));
  registered.alpha = alpha2.nodeKey;
  const a2 = body("alpha", { alpha: alpha2.nodeKey, beta: keys.beta.nodeKey }, alpha2);
  meshes.push(a2);
  await sleep(2500); // 发起方 2 秒内的重复请求会被忽略：等它过去
  assert.equal(b.connected().length, 0, "确认之前不连");
  assert.equal(b.peerStatus("alpha").keyOk, false);
  b.acceptPin("alpha");
  await until(() => b.connected().includes("alpha"));
  assert.equal(b.peerStatus("alpha").pinMismatch, undefined);
  registered.alpha = keys.alpha.nodeKey;
  a2.stop(); b.stop();
  await until(() => !conns.size);
});

test("被攻破的同步服务：形状不对的消息不崩、不拉灵魂仓库（一分钟最多一次）、提醒有上限；灵魂桥升成运行基座要确认", () => {
  let pulls = 0;
  const got: string[] = [];
  const soulKinds: Record<string, string> = { hermes: "bridge" };
  const m = new Mesh({
    me: "beta", key: keys.beta, ndc: ndc ?? ({} as any), binding: { server: SERVER, token: "beta", agent: "x", body: "beta", account: "t" },
    keyOf: (b) => ({ beta: keys.beta.nodeKey, hermes: keys.hermes.nodeKey } as Record<string, string>)[b], kindOf: (b) => soulKinds[b],
    refreshKeys: async () => { pulls++; }, hello: () => ({ version: "t" }), log: () => {}, warn: (w) => got.push(w),
  });
  const d = m.dir as any;
  for (const bad of [
    { t: "welcome", peers: null, agent: 5, iceServers: "x", now: "y" }, { t: "welcome", peers: [null, { body: "../x" }, { body: "ok", kind: "runtime", nodeKey: "bad" }], ttl: 1e99 },
    { t: "peer", peer: null }, { t: "peer", peer: { body: "A".repeat(100), kind: "runtime" } }, { t: "signal", from: 5 }, { t: "signal", from: "x", data: null },
    { t: "peer.removed", body: {} }, { t: "turn", iceServers: [{ urls: "stun:x" }, { urls: ["stun:ok.example:3478", 5] }], ttl: -1 }, { t: "error", code: { toString: 1 } }, { t: "bye" },
  ]) assert.doesNotThrow(() => d.onMessage(bad), JSON.stringify(bad));
  assert.deepEqual(d.iceServers, [{ urls: ["stun:ok.example:3478"] }]);
  assert.equal(d.peers.size, 0);
  return (async () => {
    // 同步服务登记过、但灵魂仓库里没有公钥的身体发来信令：拉一次灵魂仓库；一分钟内再来不再拉；同步服务都没登记的直接丢弃
    d.onMessage({ t: "peer", peer: { body: "ghost", kind: "runtime", nodeKey: "", version: "t", online: false, lastSeen: 0 } });
    d.emit("signal", { from: "ghost", data: seal(keys.gamma, "x", "ghost", "beta", { kind: "hello" }) });
    await sleep(50);
    d.emit("signal", { from: "ghost", data: seal(keys.gamma, "x", "ghost", "beta", { kind: "hello" }) });
    d.emit("signal", { from: "stranger", data: seal(keys.gamma, "x", "stranger", "beta", { kind: "hello" }) });
    await sleep(50);
    assert.equal(pulls, 1);
    // 大量不同来源的拒绝：去重记录有上限，进时间线的提醒限频
    for (let i = 0; i < 300; i++) {
      d.onMessage({ t: "peer", peer: { body: `g${i}`, kind: "runtime", nodeKey: "", version: "t", online: false, lastSeen: 0 } });
      d.emit("signal", { from: `g${i}`, data: seal(keys.gamma, "x", `g${i}`, "beta", { kind: "hello" }) });
    }
    await sleep(100);
    assert.ok((m as any).warned.m.size <= 200);
    assert.ok(got.length <= 20, `提醒 ${got.length} 条`);
    assert.ok(got.every((w) => w.length <= 301));
    // 灵魂桥：第一次见到时钉住类型；之后灵魂仓库与同步服务都说它是运行基座，也要确认
    d.onMessage({ t: "peer", peer: { body: "hermes", kind: "bridge", nodeKey: keys.hermes.nodeKey, version: "t", online: false, lastSeen: 0 } });
    assert.equal(m.peerStatus("hermes").kind, "bridge");
    soulKinds.hermes = "runtime";
    d.onMessage({ t: "peer", peer: { body: "hermes", kind: "runtime", nodeKey: keys.hermes.nodeKey, version: "t", online: false, lastSeen: 0 } });
    m.reverify();
    assert.equal(m.peerStatus("hermes").pinMismatch, true);
    m.acceptPin("hermes");
    assert.equal(m.peerStatus("hermes").pinMismatch, undefined);
    assert.equal(m.peerStatus("hermes").kind, "runtime");
    m.stop();
  })();
});
