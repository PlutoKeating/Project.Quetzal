// 会话的置顶、项目与归属在所有身体上一致（#30）：两具身体（独立进程）经网状层真实连接——
// 一边置顶、建项目、归类，另一边实时看到；后连上的身体补齐；删除项目留墓碑，两边的会话都解除归属；逐字段以较新的为准。
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "quetzal-organize-mesh-"));
const bodies = ["handset", "pc", "p3"];
const keys: Record<string, string> = {};
for (const b of bodies) { fs.mkdirSync(path.join(tmp, b, "secrets"), { recursive: true }); keys[b] = loadNodeKey(path.join(tmp, b, "secrets", "mesh_ed25519")).nodeKey; }
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
  return { ready, call, kill: () => p.kill() };
}
type Body = ReturnType<typeof spawnBody>;
const until = async (f: () => Promise<boolean>, ms = 20_000) => { const t = Date.now(); while (!(await f())) { if (Date.now() - t > ms) throw new Error("等待超时"); await new Promise((r) => setTimeout(r, 100)); } };
after(() => { for (const p of procs) p.kill(); sync.close(); });
const sessionOn = async (b: Body, id: string) => (await b.call<any[]>("sessions")).find((s) => s.id === id);
const liveProjects = async (b: Body) => (await b.call<any[]>("projects")).filter((p) => !p.deleted);

let a: Body, b: Body;

test("一边置顶、建项目、把会话归进去，另一边实时看到；另一边改了也传回来", { skip }, async () => {
  a = spawnBody("handset"); b = spawnBody("pc");
  await Promise.all([a.ready, b.ready]);
  await until(async () => (await a.call<string[]>("connected")).includes("pc"));

  await a.call("ensureSession", { id: "trip", title: "旅行计划" });
  await a.call("addMessage", { role: "user", text: "下个月去海边", session: "trip" });
  await a.call("setPinned", { id: "trip" });
  const p = await a.call<any>("createProject", { name: "旅行", instructions: "预算控制在五千以内", color: "#3366ff" });
  await a.call("setProject", { id: "trip", project: p.id });

  await until(async () => (await liveProjects(b)).some((x) => x.id === p.id && x.instructions === "预算控制在五千以内"));
  await until(async () => { const s = await sessionOn(b, "trip"); return !!s && s.pinned > 0 && s.project === p.id; });
  assert.equal((await b.call<any[]>("sessions"))[0].id, "trip", "在另一具身体上也排在最前");

  // pc 上改名、取消置顶，传回手机
  await b.call("updateProject", { id: p.id, patch: { name: "海边旅行" } });
  await b.call("setPinned", { id: "trip", pinned: false });
  await until(async () => (await liveProjects(a)).some((x) => x.id === p.id && x.name === "海边旅行"));
  await until(async () => (await sessionOn(a, "trip"))?.pinned === 0);
  assert.equal((await sessionOn(a, "trip")).project, p.id, "取消置顶不动项目归属（逐字段）");
});

test("后连上的身体补齐项目与归属；删除项目留墓碑，所有身体上的会话都解除归属", { skip }, async () => {
  const c = spawnBody("p3");
  await c.ready;
  const p = (await liveProjects(a)).find((x) => x.name === "海边旅行")!;
  await until(async () => (await liveProjects(c)).some((x) => x.id === p.id));
  await until(async () => (await sessionOn(c, "trip"))?.project === p.id);

  await c.call("removeProject", { id: p.id });
  for (const x of [a, b]) {
    await until(async () => !(await liveProjects(x)).some((y) => y.id === p.id));
    await until(async () => (await sessionOn(x, "trip"))?.project === null);
  }
  assert.ok((await a.call<any[]>("projects")).find((y) => y.id === p.id)?.deleted, "墓碑也同步了过来");
  assert.ok(await sessionOn(a, "trip"), "会话没被删");
  c.kill();
});
