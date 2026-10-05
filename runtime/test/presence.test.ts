// 在场与路由：一具身体上正在进行的一轮，另一具身体看得到（带 body）；发到那个会话的话转过去作为插话；回复与插话经复制两边都有；身体断开时进展快照清掉。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fork, type ChildProcess } from "node:child_process";
import { fakeSync } from "./fixtures/fake-sync.ts";
import { loadNodeKey } from "../src/mesh/identity.ts";

let has = true;
try { await import("node-datachannel"); } catch { has = false; }
const skip = !has && "这台机器没有 node-datachannel（可选依赖）";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "quetzal-presence-"));
const keys: Record<string, string> = {};
for (const b of ["honor9", "pc"]) { fs.mkdirSync(path.join(tmp, b, "secrets"), { recursive: true }); keys[b] = loadNodeKey(path.join(tmp, b, "secrets", "mesh_ed25519")).nodeKey; }
const sync = await fakeSync({ ...keys });
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
  return { ready, call, proc: p };
}
const until = async (f: () => Promise<boolean>, ms = 20_000) => { const t = Date.now(); while (!(await f())) { if (Date.now() - t > ms) throw new Error("等待超时"); await new Promise((r) => setTimeout(r, 50)); } };
after(() => { for (const p of procs) p.kill(); sync.close(); });

test("别处进行中的一轮：看得到、话转过去作为插话、两边都有完整记录；断开后快照清掉", { skip }, async () => {
  const a = spawnBody("honor9"), b = spawnBody("pc");
  await Promise.all([a.ready, b.ready]);
  await until(async () => (await a.call<string[]>("connected")).includes("pc") && (await b.call<string[]>("connected")).includes("honor9"));

  await a.call("llmDelay", { ms: 2500 });
  const replyA = a.call<string>("converse", { text: "在手机上开始的话题", conv: "c1" });
  await until(async () => (await b.call<any[]>("live")).some((t) => t.conv === "c1" && t.body === "honor9"));

  // 在电脑上对同一个会话说话：转到手机上那一轮，作为插话
  const ack = await b.call<string>("converse", { text: "电脑上补充一句", conv: "c1" });
  assert.match(ack, /已送达/);
  assert.equal(await replyA, "honor9 的回复", "这一轮在手机上完成");

  // 两边的会话记录一致：手机上的话、电脑上的插话（标记 steer）、手机上的回复
  const view = async (x: typeof a) => (await x.call<any[]>("messages", { session: "c1" })).map((m) => [m.role, m.text, m.mode ?? ""]);
  await until(async () => (await view(b)).length === 3);
  assert.deepEqual(await view(b), [["user", "在手机上开始的话题", ""], ["user", "电脑上补充一句", "steer"], ["agent", "honor9 的回复", ""]]);
  assert.deepEqual(await view(a), await view(b));

  // 给只读成员（灵魂桥）的近况：最近的会话与它的最后几句，只取摘要
  const d = await b.call<any>("digest");
  assert.equal(d.body, "pc");
  assert.equal(d.sessions[0].id, "c1");
  assert.deepEqual(d.recent.map((m: any) => [m.role, m.text]), [["user", "在手机上开始的话题"], ["user", "电脑上补充一句"], ["agent", "honor9 的回复"]]);

  // 没有进行中的一轮时，新的一轮由收到消息的身体接
  await b.call("llmDelay", { ms: 0 });
  assert.equal(await b.call("converse", { text: "电脑上新开的话", conv: "c1" }), "pc 的回复");

  // 手机正在进行一轮时断开：电脑上的进展快照随之清掉
  const pending = a.call<string>("converse", { text: "又一轮", conv: "c2" });
  void pending.catch(() => {});
  await until(async () => (await b.call<any[]>("live")).some((t) => t.conv === "c2"));
  a.proc.kill();
  await until(async () => !(await b.call<any[]>("live")).some((t) => t.conv === "c2"), 60_000);
});
