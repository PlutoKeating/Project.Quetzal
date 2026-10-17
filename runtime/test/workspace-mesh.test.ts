// 工作区跟着任务走（#38 第二阶段、#37），两具身体真连起来：
//   在电脑上 cd 进仓库工作 → 这个会话的工作区自动登记为电脑上的那个目录，并复制到手机；之后从手机发到这个会话的话由协调层放到电脑上执行；
//   两个会话各自绑定不同身体时互不干扰、各自路由；这一轮中途把工作区设到别的身体上，剩下的 shell 在那边、工作区目录里执行；
//   子 agent 在工作区所在的身体上派出、报告回到派出它的会话；每具身体的 git 仓库概况出现在另一具身体的系统提示里；工作区所在的身体离线时在本机执行并如实说明。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, fork, type ChildProcess } from "node:child_process";
import { fakeSync } from "./fixtures/fake-sync.ts";
import { loadNodeKey } from "../src/mesh/identity.ts";

let has = true;
try { await import("node-datachannel"); } catch { has = false; }
const skip = (!has && "这台机器没有 node-datachannel（可选依赖）") || (process.platform === "win32" && "沙箱里的命令按 POSIX shell 写");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "quetzal-wsmesh-"));
const keys: Record<string, string> = {};
const homes: Record<string, string> = {};
for (const b of ["phone", "pc"]) {
  fs.mkdirSync(path.join(tmp, b, "secrets"), { recursive: true });
  keys[b] = loadNodeKey(path.join(tmp, b, "secrets", "mesh_ed25519")).nodeKey;
  homes[b] = path.join(tmp, `${b}-home`); // 每具身体的用户主目录（Linux 上沙箱的工作目录）
  fs.mkdirSync(homes[b], { recursive: true });
}
// 电脑上已经克隆过的仓库（#37：新会话要知道它在哪）
const proj = path.join(homes.pc, "proj");
execFileSync("git", ["init", "-q", "-b", "main", proj]);
execFileSync("git", ["-C", proj, "remote", "add", "origin", "https://u:secret-token@example.com/u/proj.git"]);
const projB = path.join(homes.phone, "notes-app");
execFileSync("git", ["init", "-q", "-b", "dev", projB]);

const sync = await fakeSync({ ...keys });
const procs: ChildProcess[] = [];
function spawnBody(name: string) {
  const p = fork(path.join(import.meta.dirname, "fixtures", "body.ts"), [], {
    execArgv: ["--experimental-strip-types", "--disable-warning=ExperimentalWarning"],
    env: { ...process.env, HOME: homes[name], QUETZAL_HOME: path.join(tmp, name), BODY: name, SYNC: sync.url, KEYS: JSON.stringify(keys) }, stdio: ["ignore", "ignore", "inherit", "ipc"],
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
const toolCall = (name: string, args: unknown) => ({ content: null, tool_calls: [{ id: `c-${name}-${Math.random().toString(36).slice(2, 6)}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
after(() => { for (const p of procs) p.kill(); sync.close(); });

test("工作区跟着任务走：自动登记并复制、协调层把这一轮放到工作区所在的身体、多任务各走各的、子 agent 在那边做、仓库概况、离线时如实说明", { skip, timeout: 120_000 }, async () => {
  const phone = spawnBody("phone"), pc = spawnBody("pc");
  await Promise.all([phone.ready, pc.ready]);
  await until(async () => (await phone.call<string[]>("connected")).includes("pc") && (await pc.call<string[]>("connected")).includes("phone"));
  // 身体的 uuid 以灵魂仓库的身体登记为准（这里直接写进两边的灵魂目录）
  const ids = { phone: await phone.call<string>("uuid"), pc: await pc.call<string>("uuid") };
  for (const me of ["phone", "pc"]) {
    fs.mkdirSync(path.join(tmp, me, "soul", "bodies"), { recursive: true });
    for (const b of ["phone", "pc"]) fs.writeFileSync(path.join(tmp, me, "soul", "bodies", `${b}.json`), JSON.stringify({ body: b, kind: "runtime", uuid: ids[b as "phone" | "pc"] }));
  }

  // #37：电脑上的仓库（路径、分支、去掉凭据的远端）出现在手机的系统提示「其他身体」一节；手机自己的在「身体」一节
  await until(async () => (await phone.call<string>("systemPrompt", { conv: "fresh" })).includes(`${proj.replace(homes.pc, "~")}`) || (await phone.call<string>("systemPrompt", { conv: "fresh" })).includes(proj));
  const p0 = await phone.call<string>("systemPrompt", { conv: "fresh" });
  const others = p0.slice(p0.indexOf("## 其他身体"));
  assert.match(others, /proj（main） ← https:\/\/example\.com\/u\/proj\.git/);
  assert.ok(!p0.includes("secret-token"), "远端地址里的凭据去掉了");
  assert.match(p0.slice(p0.indexOf("## 身体"), p0.indexOf("## 其他身体")), /notes-app（dev）/);
  assert.match(p0, /这个会话还没有绑定工作区/);

  // 在电脑上 cd 进仓库工作：这个会话的工作区自动登记为电脑上的 proj，并复制到手机
  await pc.call("llmScript", { messages: [toolCall("shell", { command: "cd ~/proj && git status --short && pwd" }), { content: "看过了" }] });
  assert.equal(await pc.call("converse", { text: "看看仓库", conv: "w" }), "看过了");
  assert.deepEqual((({ body, dir, source }) => ({ body, dir, source }))(await pc.call<any>("workspace", { key: "w" })), { body: "pc", dir: proj, source: "auto" });
  await until(async () => (await phone.call<any>("workspace", { key: "w" }))?.dir === proj);

  // 回到手机上接着说：协调层把这一轮放到电脑上执行（不用她判断），回复回到手机这边的调用方；她看到的话标明经手机进来
  assert.equal(await phone.call("converse", { text: "接着做", conv: "w" }), "pc 的回复");
  const msgs = (await phone.call<any[]>("messages", { session: "w" })).slice(-2).map((m) => [m.role, m.text, m.body, m.via ?? null]);
  assert.deepEqual(msgs, [["user", "接着做", "pc", "phone"], ["agent", "pc 的回复", "pc", null]]);
  const pcSeen = await pc.call<string[]>("llmSeen");
  assert.ok(pcSeen.some((t) => t.includes(`这个会话的工作区在 pc（body: ${ids.pc}） 的 ${proj}，你此刻就在这具身体上`)), "电脑上的这一轮知道工作区就在这里");

  // 多任务：会话 v 的工作区在手机上，会话 w 在电脑上。两边同时各自从对面进来，各走各的
  await phone.call("setWorkspace", { key: "v", dir: projB });
  await until(async () => (await pc.call<any>("workspace", { key: "v" }))?.body === "phone");
  await phone.call("llmDelay", { ms: 800 }); await pc.call("llmDelay", { ms: 800 });
  const [rw, rv] = await Promise.all([phone.call("converse", { text: "任务 A", conv: "w" }), pc.call("converse", { text: "任务 B", conv: "v" })]);
  assert.deepEqual([rw, rv], ["pc 的回复", "phone 的回复"]);
  await phone.call("llmDelay", { ms: 0 }); await pc.call("llmDelay", { ms: 0 });
  // 「其他会话」里显示每个会话的工作区
  assert.ok((await pc.call<string>("systemPrompt", { conv: "w" })).includes(`工作区：phone 的 ${projB}`));

  // 这一轮中途把工作区设到电脑上：剩下的 shell 由基座放到电脑上、在工作区目录里执行；下一轮直接在电脑上
  await phone.call("llmScript", { messages: [toolCall("workspace", { action: "set", body: ids.pc, dir: "proj" }), toolCall("shell", { command: "pwd && echo 在：$HOME" }), { content: "在电脑上看过了" }] });
  assert.equal(await phone.call("converse", { text: "去电脑上的 proj 看看", conv: "m" }), "在电脑上看过了");
  const steps = (await phone.call<any[]>("timeline")).find((e) => e.kind === "chat" && e.detail.conv === "m").detail.steps;
  const sh = steps.find((x: any) => x.tool === "shell");
  assert.equal(sh.status, "ok", sh.result);
  assert.ok(sh.result.includes(`在工作区所在的 pc 上、${proj} 里执行`) && sh.result.includes(`\n${proj}\n`) && sh.result.includes(`在：${homes.pc}`), sh.result);
  assert.ok((await pc.call<any[]>("audit")).some((a) => a.action === "shell" && /来自 phone/.test(a.reason)), "电脑那边过闸门、记审计");
  assert.equal(await phone.call("converse", { text: "继续", conv: "m" }), "pc 的回复");

  // 子 agent：在会话 u 里派出、指定在电脑上的 proj 里做；它在电脑上跑，报告回到会话 u
  await phone.call("llmScript", { messages: [toolCall("agent_spawn", { name: "小助手", goal: "看看仓库状态", body: ids.pc, dir: "proj", maxSteps: 2 }), { content: "派出去了" }] });
  assert.equal(await phone.call("converse", { text: "派个子 agent 去电脑上看", conv: "u" }), "派出去了");
  await until(async () => (await pc.call<any[]>("agents")).some((a) => a.name === "小助手" && a.parentConv === "u"));
  assert.ok(!(await phone.call<any[]>("agents")).some((a) => a.name === "小助手"), "子 agent 不在手机上");
  const sub = (await pc.call<any[]>("agents")).find((a) => a.name === "小助手");
  assert.match((await phone.call<any>("callTool", { name: "agent_status", args: { id: sub.id } })).text, /^（在 pc 上）\[/);
  await until(async () => (await phone.call<any[]>("messages", { session: "u" })).some((m) => m.role === "ambient" && m.channel === "子agent" && /小助手/.test(m.text)), 30_000);
  assert.ok((await pc.call<string[]>("llmSeen")).some((t) => t.includes(`## 工作区\n你的工作区在 pc（body: ${ids.pc}） 的 ${proj}`)), "子 agent 的系统提示里有工作区");

  // 电脑离线：会话 w 的这一轮在手机上执行，系统提示如实写明工作区在电脑、此刻不在线
  pc.proc.kill();
  await until(async () => !(await phone.call<string[]>("connected")).includes("pc"), 60_000);
  assert.equal(await phone.call("converse", { text: "电脑关了还能做吗", conv: "w" }), "phone 的回复");
  assert.ok((await phone.call<string[]>("llmSeen")).some((t) => t.includes(`这个会话的工作区在 pc（body: ${ids.pc}） 的 ${proj}，但 pc 此刻不在线`)));
});
