// 肢体：在一具身体上调用另一具身体的工具（body_call，在那边执行、那边的闸门与审计）；换到另一具身体继续对话（move_to）。
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

test("body_call：在手机上调用电脑的 shell，在电脑上执行、电脑记审计；move_to：换到电脑上继续对话，回复回到手机这边的调用方；view_image、read_document、shell 带 body：用电脑上的文件", { skip }, async () => {
  const phone = spawnBody("phone"), pc = spawnBody("pc");
  await Promise.all([phone.ready, pc.ready]);
  await until(async () => (await phone.call<string[]>("connected")).includes("pc") && (await pc.call<string[]>("connected")).includes("phone"));
  await new Promise((r) => setTimeout(r, 300)); // 等双方取回彼此的工具清单
  // body 一律填身体的 uuid：以灵魂仓库的身体登记为准（这里直接写进手机的灵魂目录），电脑经网状层自报的要一致
  const pcId = await pc.call<string>("uuid");
  fs.mkdirSync(path.join(tmp, "phone", "soul", "bodies"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "phone", "soul", "bodies", "pc.json"), JSON.stringify({ body: "pc", kind: "runtime", uuid: pcId }));

  await phone.call("llmScript", { messages: [toolCall("body_call", { body: pcId, tool: "shell", args: { command: process.platform === "win32" ? "\"在这里：$env:QUETZAL_HOME\"" : "echo 在这里：$QUETZAL_HOME" } }), { content: "电脑那边执行完了" }] });
  assert.equal(await phone.call("converse", { text: "在电脑上看看家目录", conv: "x" }), "电脑那边执行完了");
  const reply = (await phone.call<any[]>("messages", { session: "x" })).find((m) => m.role === "agent");
  assert.equal(reply.process.find((i: any) => i.type === "tool" && i.name === "body_call").status, "ok");
  const step = (await phone.call<any[]>("timeline")).find((e) => e.kind === "chat").detail.steps.find((x: any) => x.tool === "body_call");
  assert.ok(step.result.includes(`在这里：${path.join(tmp, "pc")}`), `命令在电脑上执行：${step.result}`);
  assert.ok((await pc.call<any[]>("audit")).some((a) => a.action === "shell" && /来自 phone/.test(a.reason)), "电脑记了审计");

  // 不能跨身体调用心智层面的工具
  await phone.call("llmScript", { messages: [toolCall("body_call", { body: pcId, tool: "memory", args: { action: "add", target: "memory", content: "x" } }), { content: "好吧" }] });
  await phone.call("converse", { text: "试试在电脑上改记忆", conv: "x" });
  const step2 = (await phone.call<any[]>("timeline")).find((e) => e.kind === "chat").detail.steps.find((x: any) => x.tool === "body_call");
  assert.match(step2.result, /没有可以跨身体调用的工具/);

  // 填身体名不行：提示该用哪个 uuid
  await phone.call("llmScript", { messages: [toolCall("body_call", { body: "pc", tool: "shell", args: { command: "echo x" } }), { content: "知道了" }] });
  await phone.call("converse", { text: "用名字试试", conv: "x" });
  const step3 = (await phone.call<any[]>("timeline")).find((e) => e.kind === "chat").detail.steps.find((x: any) => x.tool === "body_call");
  assert.ok(step3.result.includes(`不是名字：pc 的 uuid 是 ${pcId}`), step3.result);

  // move_to：手机上的这一轮结束，电脑在同一个会话里接着做；调用方拿到的是电脑的回复
  await phone.call("llmScript", { messages: [toolCall("move_to", { body: pcId, note: "接着聊电脑上的文件" })] });
  assert.equal(await phone.call("converse", { text: "换到电脑上聊吧", conv: "y" }), "pc 的回复");
  const view = async (x: typeof phone) => (await x.call<any[]>("messages", { session: "y" })).map((m) => [m.role, m.channel, m.body]);
  await until(async () => (await view(phone)).length === 3);
  assert.deepEqual(await view(phone), [["user", "控制台", "phone"], ["ambient", "换身体", "pc"], ["agent", "换身体", "pc"]]);
  assert.deepEqual(await view(pc), await view(phone));

  // 带 body（电脑的 uuid）：view_image、read_document、shell 读电脑上的文件——经网状层的 file.read 取到手机上，电脑那边过闸门、记审计；密钥目录不给

  const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a5f2e2d20000000049454e44ae426082", "hex");
  const shot = path.join(tmp, "pc", "photo.png"), doc = path.join(tmp, "pc", "notes.md"), blob = path.join(tmp, "pc", "blob.bin"), bin = crypto.randomBytes(1_500_000);
  fs.writeFileSync(shot, PNG); fs.writeFileSync(doc, "电脑上的笔记"); fs.writeFileSync(blob, bin);
  fs.writeFileSync(path.join(tmp, "pc", "secrets", "probe.png"), PNG);
  const got = path.join(tmp, "phone", "data", "from-bodies", "pc");
  const stepOf = async (tool: string) => (await phone.call<any[]>("timeline")).find((e) => e.kind === "chat").detail.steps.find((x: any) => x.tool === tool);

  await phone.call("llmScript", { messages: [toolCall("view_image", { body: pcId, paths: [shot, path.join(tmp, "pc", "secrets", "probe.png")] }), { content: "看到了电脑上的图" }] });
  assert.equal(await phone.call("converse", { text: "看看电脑上拍的照片", conv: "z" }), "看到了电脑上的图");
  const vstep = await stepOf("view_image");
  assert.ok(vstep.result.includes(`✓ pc:${shot} → ${path.join(got, "photo.png")}`), vstep.result);
  assert.match(vstep.result, /✗ pc:.*probe\.png：没有读取：这是基座的密钥目录/);
  assert.ok((await phone.call<string[]>("llmSeen")).some((t) => t.includes("以下是你用 view_image 请求查看的 1 张图片")), "图片放进了手机这边的上下文");
  assert.ok(fs.readFileSync(path.join(got, "photo.png")).equals(PNG));

  await phone.call("llmScript", { messages: [toolCall("read_document", { body: pcId, path: doc }), { content: "读完了" }] });
  assert.equal(await phone.call("converse", { text: "读读电脑上的笔记", conv: "z" }), "读完了");
  assert.match((await stepOf("read_document")).result, /电脑上的笔记/);

  const local = path.join(got, "blob.bin");
  const command = process.platform === "win32" ? `"$((Get-Item '${blob}').Length) $((Get-Item '${blob}').FullName)"` : `wc -c '${blob}'`;
  await phone.call("llmScript", { messages: [toolCall("shell", { body: pcId, files: [blob], command }), { content: "数完了" }] });
  assert.equal(await phone.call("converse", { text: "数一下电脑上那个文件多大", conv: "z" }), "数完了");
  const sstep = await stepOf("shell");
  assert.ok(sstep.result.includes(`1500000`) && sstep.result.includes(local), `命令在手机上对取来的文件执行：${sstep.result}`);
  assert.ok(fs.readFileSync(local).equals(bin), "取回的二进制文件字节一致");

  const lent = (await pc.call<any[]>("audit")).filter((a) => a.action === "file.read" && /来自 phone/.test(a.reason));
  assert.equal(lent.length, 4, "电脑上每次都记审计（给了的与拒绝的）");
  assert.equal(lent.filter((a) => a.result.startsWith("✓")).length, 3);
  assert.equal((await phone.call<any[]>("audit")).filter((a) => a.action === "file.read" && a.result.startsWith("✓")).length, 3, "手机上也记审计");
});
