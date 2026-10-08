// 通道在多具身体之间：几只耳朵同时听到同一句话只留一只（最长的；一样长按身体名），不同的话各自保留；她回话时知道该从哪具身体说。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fork, type ChildProcess } from "node:child_process";
import { fakeSync } from "./fixtures/fake-sync.ts";
import { loadNodeKey } from "../src/mesh/identity.ts";
import { sameWords, overlap, winner } from "../src/mesh/channels.ts";

let has = true;
try { await import("node-datachannel"); } catch { has = false; }
const skip = !has && "这台机器没有 node-datachannel（可选依赖）";

test("同一句话：时间重叠、同样的字（不靠相似度猜）；留哪一份按身体名", () => {
  assert.ok(sameWords("薰，今天天气怎么样", "薰今天天气怎么样？"));
  assert.ok(!sameWords("今天天气怎么样", "今天天气怎么"), "少一个字就不是同一句：都交给她");
  assert.ok(overlap({ start: 0, end: 1000 }, { start: 900, end: 2000 }));
  assert.ok(!overlap({ start: 0, end: 1000 }, { start: 1001, end: 2000 }));
  assert.equal(winner([{ id: "1", body: "phone", text: "你好", start: 0, end: 1 }, { id: "2", body: "p9", text: "你好", start: 0, end: 1 }]).body, "p9");
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "quetzal-channels-"));
const keys: Record<string, string> = {};
for (const b of ["honor9", "p9"]) { fs.mkdirSync(path.join(tmp, b, "secrets"), { recursive: true }); keys[b] = loadNodeKey(path.join(tmp, b, "secrets", "mesh_ed25519")).nodeKey; }
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
  return { ready, call };
}
const until = async (f: () => Promise<boolean>, ms = 20_000) => { const t = Date.now(); while (!(await f())) { if (Date.now() - t > ms) throw new Error("等待超时"); await new Promise((r) => setTimeout(r, 50)); } };
after(() => { for (const p of procs) p.kill(); sync.close(); });

test("两部手机的耳朵同时听到同一句话：只有一只交给她；不同的话各自保留；另一具身体知道该从哪里说", { skip }, async () => {
  const a = spawnBody("honor9"), b = spawnBody("p9");
  await Promise.all([a.ready, b.ready]);
  await until(async () => (await a.call<string[]>("connected")).includes("p9") && (await b.call<string[]>("connected")).includes("honor9"));

  const at = Date.now();
  const [ka, kb] = await Promise.all([a.call<boolean>("heard", { text: "薰，今天天气怎么样", conv: "v1", at }), b.call<boolean>("heard", { text: "薰今天天气怎么样？", conv: "v1", at: at + 300 })]);
  assert.deepEqual([ka, kb].filter(Boolean).length, 1, "只有一只耳朵把这句话交给她");
  const keeper = ka ? "honor9" : "p9", other = ka ? b : a;
  await until(async () => (await other.call("earOf", { conv: "v1" })) === keeper);

  const [ka2, kb2] = await Promise.all([a.call<boolean>("heard", { text: "帮我看看日程", conv: "v2" }), b.call<boolean>("heard", { text: "今晚吃什么好呢", conv: "v3" })]);
  assert.deepEqual([ka2, kb2], [true, true], "不同的话各自保留");
});
