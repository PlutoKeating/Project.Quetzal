// 全网共用：设置分区（较新的修改生效）、模型供应商连同 Key（接收方用自己的主密钥重新加密）、急停（全网 / 只停这具身体）、审批（在哪里批准都行）、每日用量合计。
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "quetzal-shared-"));
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
let step = "";
const until = async (f: () => Promise<boolean>, ms = 20_000) => { const t = Date.now(); while (!(await f())) { if (Date.now() - t > ms) throw new Error(`等待超时：${step}`); await new Promise((r) => setTimeout(r, 50)); } };
after(() => { for (const p of procs) p.kill(); sync.close(); });

test("设置、Key、急停、审批、用量：一处改了，所有身体跟着改", { skip }, async () => {
  const phone = spawnBody("phone"), pc = spawnBody("pc");
  await Promise.all([phone.ready, pc.ready]);
  step = "连上";
  await until(async () => (await phone.call<string[]>("connected")).includes("pc") && (await pc.call<string[]>("connected")).includes("phone"));
  await new Promise((r) => setTimeout(r, 300)); // 连上时的对齐

  // 设置分区
  step = "设置分区";
  await phone.call("saveConfig", { patch: { permissions: { camera: "deny" }, budget: { dailyCostUsd: 3 } } });
  await until(async () => (await pc.call<any>("config", { section: "permissions" })).camera === "deny" && (await pc.call<any>("config", { section: "budget" })).dailyCostUsd === 3);

  // 模型供应商连同 Key：电脑上明文一致，但密文是用电脑自己的主密钥加密的
  step = "Key";
  await phone.call("addProviderKey", { id: "shared-llm", secret: "sk-shared-0123456789" });
  await until(async () => (await pc.call("providerSecret", { id: "shared-llm" })) === "sk-shared-0123456789");
  assert.notEqual(await pc.call("providerCipher", { id: "shared-llm" }), await phone.call("providerCipher", { id: "shared-llm" }));

  // 全网急停与解除
  step = "急停";
  await phone.call("stopNow", {});
  await until(async () => (await pc.call<boolean>("stopped")) === true);
  await pc.call("unstop");
  await until(async () => (await phone.call<boolean>("stopped")) === false);
  // 只停这具身体：电脑不受影响；电脑上的「解除」也清不掉它
  await phone.call("stopNow", { scope: "body" });
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(await pc.call("stopped"), false);
  await phone.call("unstop");

  // 审批：电脑上等待批准，手机上批准，电脑那边的动作继续
  step = "审批";
  await phone.call("saveConfig", { patch: { permissions: { shell: "ask" } } });
  await until(async () => (await pc.call<any>("config", { section: "permissions" })).shell === "ask");
  const allowed = pc.call<boolean>("check", { permission: "shell", action: "在电脑上执行命令" });
  await until(async () => (await phone.call<any[]>("approvals")).some((a) => a.body === "pc" && a.status === "pending"));
  const a = (await phone.call<any[]>("approvals")).find((x) => x.body === "pc")!;
  assert.equal(a.action, "在电脑上执行命令");
  assert.equal(await phone.call("decide", { id: a.id, approve: true }), true);
  assert.equal(await allowed, true);
  await until(async () => !(await phone.call<any[]>("approvals")).some((x) => x.id === a.id));

  // 每日用量全网合计
  step = "用量";
  await phone.call("addUsage", { input: 1000, output: 500, cost: 0.5 });
  await pc.call("addUsage", { input: 200, output: 100, cost: 0.25 });
  await until(async () => (await phone.call<any>("usageToday")).tokens === 1800 && (await pc.call<any>("usageToday")).tokens === 1800);
});
