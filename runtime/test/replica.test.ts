// 复制：两具身体（独立进程）经网状层共用一份对话、会话与时间线；后加入的身体补齐全部历史；1.0 前的编号迁移进各自的编号段不撞号。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fork, type ChildProcess } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { fakeSync } from "./fixtures/fake-sync.ts";
import { loadNodeKey } from "../src/mesh/identity.ts";

let has = true;
try { await import("node-datachannel"); } catch { has = false; }
const skip = !has && "这台机器没有 node-datachannel（可选依赖）";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "quetzal-replica-"));
const bodies = ["honor9", "pc", "p9"];
// 「灵魂仓库」里登记的公钥：先在各自家目录生成节点密钥
const keys: Record<string, string> = {};
for (const b of bodies) { fs.mkdirSync(path.join(tmp, b, "secrets"), { recursive: true }); keys[b] = loadNodeKey(path.join(tmp, b, "secrets", "mesh_ed25519")).nodeKey; }
const sync = await fakeSync({ ...keys });

// 一具 1.0 之前的旧身体：编号从 1 开始，执行过程里有插话标记引用消息编号
{
  fs.mkdirSync(path.join(tmp, "p9", "data"), { recursive: true });
  const db = new DatabaseSync(path.join(tmp, "p9", "data", "quetzal.db"));
  db.exec(`CREATE TABLE kv(k TEXT PRIMARY KEY, v TEXT); CREATE TABLE timeline(id INTEGER PRIMARY KEY, ts INTEGER, kind TEXT, title TEXT, detail TEXT);
    CREATE TABLE messages(id INTEGER PRIMARY KEY, ts INTEGER, role TEXT, channel TEXT, text TEXT, session TEXT, process TEXT, attachments TEXT, mode TEXT);
    CREATE TABLE sessions(id TEXT PRIMARY KEY, title TEXT, channel TEXT, created INTEGER, updated INTEGER, archived INTEGER DEFAULT 0);`);
  const t0 = Date.now() - 86400_000; // 一天前（复制只收 2020 年以后、不在未来的时间）
  db.prepare("INSERT INTO sessions VALUES('first','最初的对话','控制台',?,?,0)").run(t0 + 1000, t0 + 3000);
  db.prepare("INSERT INTO messages VALUES(1,?,'user','控制台','P9 上的老消息','first',NULL,NULL,NULL)").run(t0 + 1000);
  db.prepare("INSERT INTO messages VALUES(2,?,'user','控制台','P9 上的插话','first',NULL,NULL,'steer')").run(t0 + 2000);
  db.prepare("INSERT INTO messages VALUES(3,?,'agent','控制台','P9 的回复','first',?,NULL,NULL)").run(t0 + 3000, JSON.stringify([{ type: "steer", msg: 2, text: "P9 上的插话" }]));
  db.prepare("INSERT INTO timeline VALUES(1,?,'chat','老的心流','null')").run(t0 + 1000);
  db.close();
}

const procs: ChildProcess[] = [];
function spawnBody(name: string) {
  const p = fork(path.join(import.meta.dirname, "fixtures", "body.ts"), [], {
    execArgv: ["--experimental-strip-types", "--disable-warning=ExperimentalWarning"],
    env: { ...process.env, QUETZAL_HOME: path.join(tmp, name), BODY: name, SYNC: sync.url, KEYS: JSON.stringify(keys) }, stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
  procs.push(p);
  let seq = 0;
  const waiting = new Map<number, (m: any) => void>();
  const ready = new Promise<void>((r) => p.on("message", (m: any) => { if (m.ready) r(); else waiting.get(m.id)?.(m); }));
  const call = <T = any>(cmd: string, args?: unknown) => new Promise<T>((resolve, reject) => {
    const id = ++seq; waiting.set(id, (m) => { waiting.delete(id); m.error ? reject(new Error(m.error)) : resolve(m.result); });
    p.send({ id, cmd, args });
  });
  return { ready, call };
}
const until = async (f: () => Promise<boolean>, ms = 20_000) => { const t = Date.now(); while (!(await f())) { if (Date.now() - t > ms) throw new Error("等待超时"); await new Promise((r) => setTimeout(r, 100)); } };
after(() => { for (const p of procs) p.kill(); sync.close(); });

let a: ReturnType<typeof spawnBody>, b: ReturnType<typeof spawnBody>;

test("两具身体：一边写的对话、会话标题、时间线、消息标记，另一边实时看到；同一个 id", { skip }, async () => {
  a = spawnBody("honor9"); b = spawnBody("pc");
  await Promise.all([a.ready, b.ready]);
  await until(async () => (await a.call<string[]>("connected")).includes("pc"));
  assert.notEqual(await a.call("idPrefix"), await b.call("idPrefix"), "两具身体的编号段不同");

  const id = await a.call<number>("addMessage", { role: "user", text: "在手机上说的话", session: "first" });
  await until(async () => (await b.call<any[]>("messages", { session: "first" })).some((m) => m.id === id));
  const onB = (await b.call<any[]>("messages", { session: "first" })).find((m) => m.id === id);
  assert.deepEqual([onB.text, onB.body], ["在手机上说的话", "honor9"]);

  await b.call("ensureSession", { id: "s-pc", title: "新的对话" });
  await b.call("addMessage", { role: "agent", text: "在电脑上的回复", session: "s-pc" });
  await b.call("updateSession", { id: "s-pc", patch: { title: "电脑上起的标题" } });
  await until(async () => (await a.call<any[]>("sessions")).some((s) => s.id === "s-pc" && s.title === "电脑上起的标题"));

  const tl = await b.call<number>("addTimeline", { kind: "think", title: "在电脑上想了想" });
  await until(async () => (await a.call<any[]>("timeline")).some((e) => e.id === tl && e.body === "pc"));

  await a.call("setMode", { id, mode: "ignored" });
  await until(async () => (await b.call<any[]>("messages", { session: "first" })).find((m) => m.id === id)?.mode === "ignored");

  // 以「时间」排序：两边看到的顺序一致
  const order = async (x: ReturnType<typeof spawnBody>) => (await x.call<any[]>("messages", { session: "first" })).map((m) => m.id).join(",");
  assert.equal(await order(a), await order(b));
});

test("1.0 之前的旧身体入网：编号迁移进自己的编号段（插话引用一并改写），然后与其他身体互相补齐全部历史", { skip }, async () => {
  const c = spawnBody("p9");
  await c.ready;
  const mine = await c.call<any[]>("messages", { session: "first" });
  const prefix = await c.call<number>("idPrefix");
  const old = mine.filter((m) => m.text.startsWith("P9"));
  assert.equal(old.length, 3);
  assert.ok(old.every((m) => Math.floor(m.id / 2 ** 32) === prefix), "旧编号搬进了 P9 的编号段");
  const reply = old.find((m) => m.text === "P9 的回复")!, steer = old.find((m) => m.text === "P9 上的插话")!;
  assert.equal(reply.process[0].msg, steer.id, "插话标记引用的消息编号一并改写");

  // 补齐：P9 拿到 honor9 / pc 的全部历史，honor9 也拿到 P9 的旧对话；「最初的对话」合成一个（按时间排列）
  await until(async () => (await c.call<any[]>("messages", { session: "first" })).some((m) => m.text === "在手机上说的话"));
  await until(async () => (await c.call<any[]>("sessions")).some((s) => s.id === "s-pc"));
  await until(async () => (await a.call<any[]>("messages", { session: "first" })).some((m) => m.text === "P9 的回复"));
  const onA = (await a.call<any[]>("messages", { session: "first" })).find((m) => m.text === "P9 的回复");
  assert.equal(onA.id, reply.id, "honor9 拿到的是同一个编号");
  const firstOnP9 = await c.call<any[]>("messages", { session: "first" });
  const ts = firstOnP9.map((m) => m.ts);
  assert.deepEqual(ts, [...ts].sort((x, y) => x - y), "合并后的「最初的对话」按时间排列");
});

test("出错或被攻破的身体发来的复制：冒充别的身体、段尾编号、坏字段都被丢弃，进程照常工作", { skip }, async () => {
  const pcPrefix = await b.call<number>("idPrefix"), hPrefix = await a.call<number>("idPrefix");
  const R = 2 ** 32, now = Date.now();
  const row = (id: number, body: string, text: string, o: Record<string, unknown> = {}) => ({ id, ts: now, role: "user", channel: "控制台", text, session: "evil", process: null, attachments: null, mode: null, body, ...o });
  await a.call("emit", { name: "replica", data: { table: "messages", rows: [
    row(pcPrefix * R + 9_000_000, "pc", "冒充 pc 说的话"),           // 不是发来的身体自己的行
    row(hPrefix * R + R - 1, "honor9", "段尾的编号"),                 // 段尾：会把编号顶出段外
    row(hPrefix * R + 9_000_001, "honor9", "坏角色", { role: "root" }),
    row(hPrefix * R + 9_000_002, "honor9", "坏过程", { process: "{" }),
    { id: 1e300 }, null, "x",
  ] } });
  await a.call("emit", { name: "replica", data: { table: "sessions", rows: [{ id: "evil", title: "冻住的标题", channel: "控制台", created: 0, updated: now, archived: 0, changed: now + 365 * 86400_000 }] } });
  await a.call("emit", { name: "replica", data: { table: "messages", rows: [row(hPrefix * R + 9_000_003, "honor9", "正常的一句")] } });
  await until(async () => (await b.call<any[]>("messages", { session: "evil" })).some((m) => m.text === "正常的一句"));
  assert.deepEqual((await b.call<any[]>("messages", { session: "evil" })).map((m) => m.text), ["正常的一句"]);
  const s = (await b.call<any[]>("sessions")).find((x) => x.id === "evil");
  assert.ok(s.changed <= Date.now() + 5 * 60_000, "会话的修改时刻被钳住");
  // pc 照常写，编号仍在自己的段里
  const id = await b.call<number>("addMessage", { role: "user", text: "pc 还活着", session: "evil" });
  assert.equal(Math.floor(id / R), pcPrefix);
});
