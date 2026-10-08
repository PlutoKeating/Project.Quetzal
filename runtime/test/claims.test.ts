// 认领（#7）：几个会话（同一具身体上的、醒来时的、别的身体上的）避免同时去做同一件对外的事。
// 本机：认领 / 续期 / 被拒（告诉是谁、在哪个会话、做什么）/ 放下 / 到期；进入系统提示。多具身体：由协调者决定，两边同时认领只有一个成功。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fork, type ChildProcess } from "node:child_process";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "quetzal-claims-"));
process.env.QUETZAL_HOME = path.join(tmp, "home");
const { loadConfig, saveConfig } = await import("../src/config.ts");
loadConfig();
saveConfig({ body: "honor9" });
const store = await import("../src/store.ts");
store.openStore();
const claims = await import("../src/mind/claims.ts");
const { Session } = await import("../src/mind/activity.ts");
const { callTool } = await import("../src/mind/tools.ts");
const { systemPrompt } = await import("../src/mind/prompt.ts");

const chat = (conv: string, title: string) => { store.ensureSession(conv, title, "控制台"); const s = new Session("chat", "控制台", undefined, conv); s.close(); return s; };
const K = "GitHub：Project.X 开 issue 说登录超时";

test("两个会话认领同一件事：后来的被告知是谁、在哪个会话、做什么；同一个会话再认领是续期；放下后别人能认领", async () => {
  const a = chat("conv-a", "修 bug"), b = chat("conv-b", "闲聊");
  const think = new Session("think"); think.close();
  const r1 = await callTool("claim", { action: "take", key: K, note: "正在写 issue 正文" }, "测试", { session: a });
  assert.equal(r1.status, "ok"); assert.match(r1.text, /^已认领/);
  const r2 = await callTool("claim", { action: "take", key: "  github：project.x 开 issue   说登录超时 " }, "测试", { session: b }); // 只差空白与大小写，算同一个名字
  assert.match(r2.text, /已经有人认领了/); assert.match(r2.text, /会话「修 bug」/); assert.match(r2.text, /正在写 issue 正文/);
  const r3 = await callTool("claim", { action: "take", key: K }, "测试", { session: think });
  assert.match(r3.text, /已经有人认领了/);
  assert.match((await callTool("claim", { action: "take", key: K, note: "issue 发出去了，等回复", minutes: 60 }, "测试", { session: a })).text, /^已续期.*等回复/);
  assert.match((await callTool("claim", { action: "release", key: K }, "测试", { session: b })).text, /别的会话认领的/);

  // 系统提示：别的会话看得到这条认领，「处境」里说明了并发与这个手段
  const p = systemPrompt("", { conv: "conv-b" });
  assert.match(p, /【认领】「GitHub：Project\.X 开 issue 说登录超时」：issue 发出去了，等回复（这具身体 上的会话「修 bug」/);
  assert.match(p, /好几个你在进行[\s\S]*claim 认领/);
  assert.match(systemPrompt("", { conv: "conv-a" }), /【认领】「GitHub[^\n]*就是这个会话/);

  assert.match((await callTool("claim", { action: "release", key: K }, "测试", { session: a })).text, /^已放下/);
  assert.match((await callTool("claim", { action: "take", key: K, note: "接着做" }, "测试", { session: think })).text, /^已认领/);
  assert.match((await callTool("claim", { action: "list" }, "测试", { session: b })).text, /醒来思考/);
  assert.match((await callTool("claim", { action: "release", key: K, force: true }, "测试", { session: b })).text, /^已放下/); // 确认那边不会做了
  assert.equal(claims.active().length, 0);
});

test("到期自动失效；别处来的记录逐字段检查，同一编号取修改较新的，放下的留墓碑", () => {
  const now = Date.now();
  const r = claims.take({ key: "发周报", note: "", minutes: 1, body: "honor9", holder: "x", where: "醒来思考" }, now);
  assert.ok(r.ok);
  assert.equal(claims.holderOf("发周报", now + 2 * 60_000), undefined, "过了期限就没人认领了");
  assert.ok(claims.release({ key: "发周报", body: "honor9", holder: "x", where: "" }).ok);
  const id = "0123456789abcdef";
  const rec = { id, key: "下单买猫粮", note: "在比价", body: "pc", holder: "conv-z", where: "会话「家务」", ts: now, until: now + 600_000, updated: now };
  assert.equal(claims.merge([rec, { ...rec, id: "bad" }, { ...rec, id: "1111111111111111", until: now - 1 }, { ...rec, id: "2222222222222222", updated: now + 3600_000 }, { ...rec, id: "3333333333333333", until: now + 7 * 86_400_000 }]), true);
  assert.deepEqual(claims.active().map((c) => c.id), [id], "只收合格的那一条");
  assert.equal(claims.merge([{ ...rec, note: "旧的", updated: now - 1 }]), false, "较旧的修改不覆盖");
  assert.equal(claims.merge([{ ...rec, released: true, updated: now + 1 }]), true);
  assert.equal(claims.active().length, 0, "对方放下了");
  assert.equal(claims.merge([rec]), false, "过期的重放不会让它复活");
});

test("多具身体：认领经协调者决定；连不上协调者时在本机决定", async () => {
  const seen: string[] = [];
  claims.setClaimRouter((op, req) => { seen.push(`${op}:${req.key}`); return Promise.reject(new Error("断了")); });
  try {
    const r = await claims.claim({ key: "离线时认领", body: "honor9", holder: "h", where: "w" });
    assert.ok(r.ok, "连不上协调者：本机决定");
    assert.deepEqual(seen, ["take:离线时认领"]);
    const by = { id: "4444444444444444", key: "协调者那边有人认领了", note: "", body: "pc", holder: "c", where: "醒来思考", ts: Date.now(), until: Date.now() + 60_000, updated: Date.now() };
    claims.setClaimRouter(() => Promise.resolve({ ok: false, by }));
    const r2 = await claims.claim({ key: "协调者那边有人认领了", body: "honor9", holder: "h", where: "w" });
    assert.equal(r2.ok, false);
    assert.equal(claims.holderOf("协调者那边有人认领了")?.body, "pc", "协调者的结果先在本机记下");
  } finally { claims.setClaimRouter(undefined); }
});

// ---------- 两具身体经网状层
let has = true;
try { await import("node-datachannel"); } catch { has = false; }
const skip = !has && "这台机器没有 node-datachannel（可选依赖）";
const procs: ChildProcess[] = [];
let close = () => {};
after(() => { for (const p of procs) p.kill(); close(); });

test("两具身体：认领在两边都看得到；对方认领着的被拒；两边同时认领同一件事只有一个成功；放下后两边都没有了", { skip }, async () => {
  const { fakeSync } = await import("./fixtures/fake-sync.ts");
  const { loadNodeKey } = await import("../src/mesh/identity.ts");
  const keys: Record<string, string> = {};
  for (const b of ["phone", "pc"]) { fs.mkdirSync(path.join(tmp, b, "secrets"), { recursive: true }); keys[b] = loadNodeKey(path.join(tmp, b, "secrets", "mesh_ed25519")).nodeKey; }
  const sync = await fakeSync({ ...keys });
  close = () => sync.close();
  const spawnBody = (name: string, priority: number) => {
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
  };
  const until = async (f: () => Promise<boolean>, ms = 20_000) => { const t = Date.now(); while (!(await f())) { if (Date.now() - t > ms) throw new Error("等待超时"); await new Promise((r) => setTimeout(r, 50)); } };

  const phone = spawnBody("phone", 0), pc = spawnBody("pc", 5);
  await Promise.all([phone.ready, pc.ready]);
  await until(async () => (await phone.call("coordinator")) === "pc" && (await pc.call("coordinator")) === "pc");

  const r1 = await phone.call<any>("claim", { key: K, note: "手机上在写", holder: "conv-1", where: "会话「修 bug」" }); // 跟随者：转给协调者 pc 决定
  assert.equal(r1.ok, true);
  await until(async () => (await pc.call<any[]>("claims")).some((c) => c.key === K && c.body === "phone"));
  const r2 = await pc.call<any>("claim", { key: K, holder: "wake-1", where: "醒来思考" });
  assert.equal(r2.ok, false);
  assert.equal(r2.by.body, "phone"); assert.equal(r2.by.where, "会话「修 bug」"); assert.equal(r2.by.note, "手机上在写");

  const both = await Promise.all([phone.call<any>("claim", { key: "发邮件给房东", holder: "conv-2" }), pc.call<any>("claim", { key: "发邮件给房东", holder: "conv-3" })]);
  assert.equal(both.filter((r) => r.ok).length, 1, JSON.stringify(both));

  assert.equal((await phone.call<any>("unclaim", { key: K, holder: "conv-1" })).ok, true);
  await until(async () => !(await pc.call<any[]>("claims")).some((c) => c.key === K) && !(await phone.call<any[]>("claims")).some((c) => c.key === K));
});
