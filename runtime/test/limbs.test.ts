// 肢体：在一具身体上调用另一具身体的工具（body_call，在那边执行、那边的闸门与审计）；换到另一具身体继续对话（move_to）。
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "quetzal-limbs-"));
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

test("body_call：在手机上调用电脑的 shell，在电脑上执行、电脑记审计；move_to：换到电脑上继续对话，回复回到手机这边的调用方", { skip }, async () => {
  const phone = spawnBody("phone"), pc = spawnBody("pc");
  await Promise.all([phone.ready, pc.ready]);
  await until(async () => (await phone.call<string[]>("connected")).includes("pc") && (await pc.call<string[]>("connected")).includes("phone"));
  await new Promise((r) => setTimeout(r, 300)); // 等双方取回彼此的工具清单

  await phone.call("llmScript", { messages: [toolCall("body_call", { body: "pc", tool: "shell", args: { command: "echo 在这里：$QUETZAL_HOME" } }), { content: "电脑那边执行完了" }] });
  assert.equal(await phone.call("converse", { text: "在电脑上看看家目录", conv: "x" }), "电脑那边执行完了");
  const reply = (await phone.call<any[]>("messages", { session: "x" })).find((m) => m.role === "agent");
  assert.equal(reply.process.find((i: any) => i.type === "tool" && i.name === "body_call").status, "ok");
  const step = (await phone.call<any[]>("timeline")).find((e) => e.kind === "chat").detail.steps.find((x: any) => x.tool === "body_call");
  assert.ok(step.result.includes(`在这里：${path.join(tmp, "pc")}`), `命令在电脑上执行：${step.result}`);
  assert.ok((await pc.call<any[]>("audit")).some((a) => a.action === "shell" && /来自 phone/.test(a.reason)), "电脑记了审计");

  // 不能跨身体调用心智层面的工具
  await phone.call("llmScript", { messages: [toolCall("body_call", { body: "pc", tool: "memory", args: { action: "add", target: "memory", content: "x" } }), { content: "好吧" }] });
  await phone.call("converse", { text: "试试在电脑上改记忆", conv: "x" });
  const step2 = (await phone.call<any[]>("timeline")).find((e) => e.kind === "chat").detail.steps.find((x: any) => x.tool === "body_call");
  assert.match(step2.result, /没有可以跨身体调用的工具/);

  // move_to：手机上的这一轮结束，电脑在同一个会话里接着做；调用方拿到的是电脑的回复
  await phone.call("llmScript", { messages: [toolCall("move_to", { body: "pc", note: "接着聊电脑上的文件" })] });
  assert.equal(await phone.call("converse", { text: "换到电脑上聊吧", conv: "y" }), "pc 的回复");
  const view = async (x: typeof phone) => (await x.call<any[]>("messages", { session: "y" })).map((m) => [m.role, m.channel, m.body]);
  await until(async () => (await view(phone)).length === 3);
  assert.deepEqual(await view(phone), [["user", "控制台", "phone"], ["ambient", "换身体", "pc"], ["agent", "换身体", "pc"]]);
  assert.deepEqual(await view(pc), await view(phone));
});
