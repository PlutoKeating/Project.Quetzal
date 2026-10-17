// Canvas 的复制：两具身体（独立进程）经网状层共用 canvas——新建、对方的编辑（新版本）、改名、评论与解决实时同步；
//   后连上的身体补齐全部历史；出错或被攻破的身体冒充别的身体写的行被丢弃。
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "quetzal-canvas-replica-"));
const bodies = ["handset", "pc", "tablet"];
const keys: Record<string, string> = {};
for (const b of bodies) { fs.mkdirSync(path.join(tmp, b, "secrets"), { recursive: true }); keys[b] = loadNodeKey(path.join(tmp, b, "secrets", "mesh_ed25519")).nodeKey; }
const sync = await fakeSync({ ...keys });

const procs: ChildProcess[] = [];
function spawnBody(name: string) {
  const p = fork(path.join(import.meta.dirname, "fixtures", "canvas-body.ts"), [], {
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

test("两具身体：新建、编辑、改名、评论与解决实时同步，id 与版本相同", { skip }, async () => {
  a = spawnBody("handset"); b = spawnBody("pc");
  await Promise.all([a.ready, b.ready]);
  await until(async () => (await a.call<string[]>("connected")).includes("pc"));
  const v = await a.call<any>("create", { conv: "first", title: "一起写的方案", content: "第一版" });
  await until(async () => !!(await b.call<any>("get", { id: v.id })));
  assert.equal((await b.call<any>("get", { id: v.id })).content, "第一版");

  await b.call("edit", { id: v.id, content: "pc 上改的第二版" });
  await until(async () => (await a.call<any>("get", { id: v.id }))?.content === "pc 上改的第二版");
  const va = await a.call<any[]>("versions", { id: v.id }), vb = await b.call<any[]>("versions", { id: v.id });
  assert.deepEqual(va.map((x) => x.id), vb.map((x) => x.id));
  assert.deepEqual(va.map((x) => x.body), ["handset", "pc"]);

  await a.call("rename", { id: v.id, title: "改过的标题" });
  await until(async () => (await b.call<any>("get", { id: v.id }))?.title === "改过的标题");

  const c = await b.call<any>("comment", { id: v.id, text: "这句再斟酌", quote: "第二版" });
  await until(async () => ((await a.call<any>("get", { id: v.id }))?.threads ?? []).some((t: any) => t.id === c.id && t.quote === "第二版"));
  await a.call("resolve", { id: c.id, resolved: true });
  await until(async () => (await b.call<any>("get", { id: v.id })).threads.find((t: any) => t.id === c.id)?.resolved === true);
});

test("后连上的身体补齐全部 canvas、版本与评论", { skip }, async () => {
  const c = spawnBody("tablet");
  await c.ready;
  await until(async () => (await c.call<any[]>("list", { conv: "first" })).length === 1);
  const id = (await c.call<any[]>("list", { conv: "first" }))[0].id;
  await until(async () => (await c.call<any[]>("versions", { id })).length === 2 && ((await c.call<any>("get", { id }))?.threads ?? []).length === 1);
  const got = await c.call<any>("get", { id });
  assert.deepEqual([got.title, got.content, got.threads[0].resolved], ["改过的标题", "pc 上改的第二版", true]);
});

test("冒充别的身体写的行、坏字段都被丢弃，进程照常复制", { skip }, async () => {
  const now = Date.now();
  await a.call("emit", { name: "canvas", data: {
    docs: [{ id: "cv-eeeeeeeeeeee", conv: "evil", title: "冒充 pc", kind: "markdown", lang: "", created: now, changed: now, deleted: 0, body: "pc" }],
    versions: [{ id: "v-eeeeeeeeeeeeeeee", doc: "cv-eeeeeeeeeeee", ts: now, author: "agent", body: "handset", content: "x", note: "", parent: "不是版本号" }, null, "x"],
  } });
  const ok = await a.call<any>("create", { conv: "evil", title: "正常的一份", content: "好" });
  await until(async () => !!(await b.call<any>("get", { id: ok.id })));
  assert.equal(await b.call("get", { id: "cv-eeeeeeeeeeee" }), null);
  assert.deepEqual((await b.call<any[]>("list", { conv: "evil" })).map((s: any) => s.title), ["正常的一份"]);
});
