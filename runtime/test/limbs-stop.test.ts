// 肢体：body_call 进行中停止这一轮，停止要传到被调用的身体（issue #39）。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fork, type ChildProcess } from "node:child_process";
import { fakeSync } from "./fixtures/fake-sync.ts";
import crypto from "node:crypto";
import { loadNodeKey } from "../src/mesh/identity.ts";

let has = true;
try { await import("node-datachannel"); } catch { has = false; }
const skip = !has && "这台机器没有 node-datachannel（可选依赖）";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "quetzal-limbs-stop-"));
const keys: Record<string, string> = {};
for (const b of ["phone", "pc"]) { fs.mkdirSync(path.join(tmp, b, "secrets"), { recursive: true }); keys[b] = loadNodeKey(path.join(tmp, b, "secrets", "mesh_ed25519")).nodeKey; }
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
const toolCall = (name: string, args: unknown) => ({ content: null, tool_calls: [{ id: `c-${name}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
after(() => { for (const p of procs) p.kill(); sync.close(); });

test("body_call 时停止这一轮：停止传到被调用的身体，那边的命令（连同它的子进程）结束，之后的 body_call 照常可用", { skip: skip || (process.platform === "win32" && "用 sh 的子进程核对") }, async () => {
  const phone = spawnBody("phone"), pc = spawnBody("pc");
  await Promise.all([phone.ready, pc.ready]);
  await until(async () => (await phone.call<string[]>("connected")).includes("pc") && (await pc.call<string[]>("connected")).includes("phone"));
  await new Promise((r) => setTimeout(r, 300));
  const pcId = await pc.call<string>("uuid");
  fs.mkdirSync(path.join(tmp, "phone", "soul", "bodies"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "phone", "soul", "bodies", "pc.json"), JSON.stringify({ body: "pc", kind: "runtime", uuid: pcId }));

  // 一条不输出、还会派生子进程的长命令：子进程占着输出管道，只结束直接子进程时命令一直不算结束
  const mark = `quetzal-stop-${crypto.randomBytes(4).toString("hex")}`;
  await phone.call("llmScript", { messages: [toolCall("body_call", { body: pcId, tool: "shell", args: { command: `sh -c 'sleep 300; echo ${mark}' & sleep 300; echo ${mark}`, timeout: 600 } })] });
  const turn = phone.call<string>("converse", { text: "在电脑上跑个长命令", conv: "stop" });
  await until(async () => (await pc.call<number>("procs", { pattern: mark })) >= 2);
  const t0 = Date.now();
  assert.equal(await phone.call("stopTurn", { conv: "stop" }), true);
  assert.match(await turn, /被对方停止/);
  // 停止传到了电脑：命令和它派生的子进程都结束，那边的审计记下了被停止
  await until(async () => (await pc.call<number>("procs", { pattern: mark })) === 0, 15_000);
  await until(async () => (await pc.call<any[]>("audit")).some((a) => a.action === "shell" && /被停止/.test(a.result ?? "")), 15_000);
  assert.ok(Date.now() - t0 < 15_000, "停止后很快结束，不等超时");

  // 之后的 body_call 照常可用
  await phone.call("llmScript", { messages: [toolCall("body_call", { body: pcId, tool: "shell", args: { command: "echo 还能用" } }), { content: "好了" }] });
  const again = await phone.call("converse", { text: "再试一次", conv: "stop" });
  assert.equal(again, "好了", String(again));
  const step = (await phone.call<any[]>("timeline")).find((e) => e.kind === "chat").detail.steps.find((x: any) => x.tool === "body_call");
  assert.match(step.result, /还能用/);
});
