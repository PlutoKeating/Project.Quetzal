// 运行位置：协调者醒来时看各具身体的概况与推荐，她选在哪里做；选中的身体执行这次醒来（日记与心流在那具身体上，经复制两边都有）。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fork, type ChildProcess } from "node:child_process";
import { fakeSync } from "./fixtures/fake-sync.ts";
import { loadNodeKey } from "../src/mesh/identity.ts";
import { score, type Overview } from "../src/mesh/placement.ts";

let has = true;
try { await import("node-datachannel"); } catch { has = false; }
const skip = !has && "这台机器没有 node-datachannel（可选依赖）";

test("打分：接着电源、电量、温度、联网、手头的事、对方最近在不在这里", () => {
  const o = (x: Partial<Overview>): Overview => ({ body: "x", describe: "", online: true, busy: 0, tools: [], lastUserAt: 0, version: "", ...x });
  assert.ok(score(o({ charging: true, battery: 80 }), "think", false, "me") > score(o({ charging: false, battery: 15 }), "think", false, "me"));
  assert.ok(score(o({ tempC: 46 }), "dream", false, "me") < score(o({}), "dream", false, "me"));
  assert.ok(score(o({ lastUserAt: Date.now() }), "think", true, "me") > score(o({}), "think", true, "me"));
  assert.ok(score(o({ online: false }), "think", false, "me") < score(o({ busy: 1 }), "think", false, "me"));
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "quetzal-place-"));
const keys: Record<string, string> = {};
for (const b of ["phone", "pc"]) { fs.mkdirSync(path.join(tmp, b, "secrets"), { recursive: true }); keys[b] = loadNodeKey(path.join(tmp, b, "secrets", "mesh_ed25519")).nodeKey; }
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
  return { ready, call };
}
const until = async (f: () => Promise<boolean>, ms = 20_000) => { const t = Date.now(); while (!(await f())) { if (Date.now() - t > ms) throw new Error("等待超时"); await new Promise((r) => setTimeout(r, 50)); } };
after(() => { for (const p of procs) p.kill(); sync.close(); });

test("她不表态时用推荐（对方刚在电脑上说过话 → 电脑）；她选两具身体时两边同时做", { skip }, async () => {
  const phone = spawnBody("phone", 5), pc = spawnBody("pc");
  await Promise.all([phone.ready, pc.ready]);
  await until(async () => (await phone.call("coordinator")) === "phone" && (await pc.call<string[]>("connected")).includes("phone"));
  await pc.call("addMessage", { role: "user", text: "我在电脑前", session: "first" });

  await phone.call("wake", { kind: "think", reason: "好奇心（0.80）" });
  const tl = async (x: typeof phone) => (await x.call<any[]>("timeline")).map((e) => [e.kind, e.body, e.title]);
  await until(async () => (await tl(phone)).some(([k, b]) => k === "think" && b === "pc"));
  assert.ok((await tl(phone)).some(([k, b, t]) => k === "place" && b === "phone" && /pc/.test(t)), "协调者记下了选在哪里");
  assert.ok(!(await tl(phone)).some(([k, b]) => k === "think" && b === "phone"), "这次没有在手机上做");

  await phone.call("llmWhere", { where: ["phone", "pc"] });
  await phone.call("wake", { kind: "think", reason: "想表达（0.90）" });
  await until(async () => (await tl(pc)).filter(([k, b]) => k === "think" && b === "phone").length >= 1 && (await tl(pc)).filter(([k, b]) => k === "think" && b === "pc").length >= 2);
});
