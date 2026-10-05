// 协调者与单一心脏：选法确定；跟随的身体把心脏操作转给协调者、采用协调者广播的状态；协调者断开后另一具身体接过心跳。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fork, type ChildProcess } from "node:child_process";
import { fakeSync } from "./fixtures/fake-sync.ts";
import { loadNodeKey } from "../src/mesh/identity.ts";
import { pickLeader } from "../src/mesh/coordinator.ts";

let has = true;
try { await import("node-datachannel"); } catch { has = false; }
const skip = !has && "这台机器没有 node-datachannel（可选依赖）";

test("选法：优先级 → 接着电源 → 启动早 → 名字", () => {
  const c = (priority: number, powered: boolean, started: number) => ({ priority, powered, started });
  assert.equal(pickLeader([["a", c(0, true, 1)], ["b", c(1, false, 9)]]), "b");
  assert.equal(pickLeader([["a", c(0, false, 1)], ["b", c(0, true, 9)]]), "b");
  assert.equal(pickLeader([["a", c(0, true, 5)], ["b", c(0, true, 1)]]), "b");
  assert.equal(pickLeader([["b", c(0, true, 1)], ["a", c(0, true, 1)]]), "a");
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "quetzal-coord-"));
const keys: Record<string, string> = {};
for (const b of ["phone", "server"]) { fs.mkdirSync(path.join(tmp, b, "secrets"), { recursive: true }); keys[b] = loadNodeKey(path.join(tmp, b, "secrets", "mesh_ed25519")).nodeKey; }
const sync = await fakeSync({ ...keys });
const procs: ChildProcess[] = [];
function spawnBody(name: string, priority = 0) {
  const p = fork(path.join(import.meta.dirname, "fixtures", "body.ts"), [], {
    execArgv: ["--experimental-strip-types", "--disable-warning=ExperimentalWarning"],
    env: { ...process.env, QUETZAL_HOME: path.join(tmp, name), BODY: name, SYNC: sync.url, KEYS: JSON.stringify(keys), PRIORITY: String(priority) }, stdio: ["ignore", "ignore", "inherit", "ipc"],
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

test("优先级高的身体持有心跳；跟随者的心脏操作转给它，状态广播回来；它断开后跟随者接过心跳", { skip }, async () => {
  const phone = spawnBody("phone", 0), server = spawnBody("server", 5);
  await Promise.all([phone.ready, server.ready]);
  await until(async () => (await phone.call("coordinator")) === "server" && (await server.call("coordinator")) === "server");
  assert.equal((await phone.call<any>("heart")).follower, true);
  assert.equal((await server.call<any>("heart")).follower, false);

  const before = (await server.call<any>("heart")).drives.social;
  await phone.call("nudge", { reason: "被拿起", drives: { social: 0.3 } }); // 手机上的感觉 → 转给 server 的心脏
  await phone.call("experience", { n: 2 });
  await until(async () => (await server.call<any>("heart")).drives.social > before + 0.2);
  await until(async () => (await server.call<any>("heart")).unconsolidated >= 2);
  await until(async () => Math.abs((await phone.call<any>("heart")).drives.social - (await server.call<any>("heart")).drives.social) < 0.01, 10_000); // 状态广播回手机

  server.proc.kill();
  await until(async () => (await phone.call("coordinator")) === "phone", 60_000);
  const h = await phone.call<any>("heart");
  assert.equal(h.follower, false, "手机接过心跳");
  assert.ok(h.unconsolidated >= 2, "从最新的状态接着跳");
});
