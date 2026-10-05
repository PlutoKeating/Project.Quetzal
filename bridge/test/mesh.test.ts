// 灵魂桥作为只读成员入网：连上运行基座，取近况写进 now.md；身体登记带上节点公钥；只能调用可读的方法。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "soul-bridge-mesh-"));
process.env.SOUL_BRIDGE_HOME = tmp;
const { modulesReady, startMesh, renderNow, meshKeyIfAny, nodeKey, nowPath, meshStatus } = await import("../src/mesh.ts");
const { repoDir, dirOf } = await import("../src/config.ts");
const { loadNodeKey } = await import("../../runtime/src/mesh/identity.ts");
import type { BridgeConfig } from "../src/types.ts";

const skip = !modulesReady() && "这台机器没有网状层组件";
const c: BridgeConfig = { agent: "kaoru", framework: "hermes", home: path.join(tmp, "hermes"), remote: "git@example.com:x/kaoru.soul.git", branch: "main", body: "hermes-box", poll: 0 };
const stops: (() => void)[] = [];
after(() => { for (const s of stops) s(); });

test("没绑定过网状层时身体登记不带 meshKey，也不平白生成节点密钥；生成后带上", () => {
  assert.equal(meshKeyIfAny(c.agent), undefined);
  fs.mkdirSync(dirOf(c.agent), { recursive: true });
  const k = nodeKey(c.agent).nodeKey;
  assert.equal(meshKeyIfAny(c.agent), k);
  assert.equal(fs.statSync(path.join(dirOf(c.agent), "mesh_ed25519")).mode & 0o777, 0o600);
});

test("近况写成给 agent 看的 Markdown：进行中的事、最近的会话、最后几句", () => {
  const md = renderNow({
    body: "phone", at: 0,
    live: [{ body: "phone", conv: "c1", origin: "chat", channel: "控制台", started: 0, status: "running", text: "在聊晚饭" }, { body: "pc", conv: "", origin: "dream", channel: "", started: 0, status: "running", text: "" }],
    sessions: [{ id: "c1", title: "晚饭", channel: "控制台", updated: 0, last: "吃面吧" }],
    recent: [{ ts: 0, role: "user", body: null, text: "吃什么" }, { ts: 0, role: "agent", body: "phone", text: "吃面吧" }],
  }, ["phone", "pc"], "hermes-box");
  assert.match(md, /在 phone 上和人说话（控制台）/);
  assert.match(md, /在 pc 上做梦/);
  assert.match(md, /晚饭（控制台/);
  assert.match(md, /我（在 phone）：吃面吧/);
  assert.match(renderNow(undefined, [], "x"), /没有连上任何运行基座/);
});

test("守护进程以只读成员连上运行基座：取到近况写进 now.md；它不是正式成员", { skip }, async () => {
  const { fakeSync } = await import("../../runtime/test/fixtures/fake-sync.ts");
  const { Mesh } = await import("../../runtime/src/mesh/mesh.ts");
  const { createRequire } = await import("node:module");
  const { pathToFileURL } = await import("node:url");
  const ndcMod: any = await import(pathToFileURL(createRequire(new URL("../../runtime/package.json", import.meta.url)).resolve("node-datachannel")).href);
  const ndc = ndcMod.default ?? ndcMod;
  const phone = loadNodeKey(path.join(tmp, "phone.key"));
  const bridgeKey = nodeKey(c.agent).nodeKey;
  const sync = await fakeSync({ phone: phone.nodeKey, [c.body]: bridgeKey }, { [c.body]: "bridge" });
  stops.push(() => sync.close());
  // 灵魂仓库里的登记（信任根）
  fs.mkdirSync(path.join(repoDir(c.agent), "bodies"), { recursive: true });
  fs.writeFileSync(path.join(repoDir(c.agent), "bodies", "phone.json"), JSON.stringify({ body: "phone", kind: "runtime", meshKey: phone.nodeKey }));
  fs.writeFileSync(path.join(repoDir(c.agent), "bodies", `${c.body}.json`), JSON.stringify({ body: c.body, kind: "bridge", meshKey: bridgeKey }));
  fs.writeFileSync(path.join(dirOf(c.agent), "sync.json"), JSON.stringify({ server: sync.url, token: c.body, agent: "x", body: c.body, account: "t" }));

  const kinds: Record<string, string> = { phone: "runtime", [c.body]: "bridge" };
  const keys: Record<string, string> = { phone: phone.nodeKey, [c.body]: bridgeKey };
  const rt = new Mesh({ me: "phone", key: phone, ndc, binding: { server: sync.url, token: "phone", agent: "x", body: "phone", account: "t" }, keyOf: (b) => keys[b], kindOf: (b) => kinds[b], hello: () => ({ version: "t" }), log: () => {} });
  let woke = 0;
  rt.handle("presence.digest", () => ({ body: "phone", at: Date.now(), live: [{ body: "phone", conv: "c1", origin: "chat", channel: "飞书", started: Date.now(), status: "running", text: "在聊天" }], sessions: [], recent: [] }), true);
  rt.handle("mind.wake", () => { woke++; return "x"; });
  rt.start();
  stops.push(() => rt.stop());

  const stop = await startMesh(c, "0.2.0", () => {}, async () => {});
  assert.ok(stop);
  stops.push(stop!);
  const t = Date.now();
  while (!(fs.existsSync(nowPath(c.agent)) && /在 phone 上和人说话（飞书）/.test(fs.readFileSync(nowPath(c.agent), "utf8")))) {
    if (Date.now() - t > 15_000) throw new Error(`等待近况超时：${fs.existsSync(nowPath(c.agent)) ? fs.readFileSync(nowPath(c.agent), "utf8") : "没有 now.md"}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.deepEqual(rt.connected(), [], "灵魂桥不是正式成员");
  assert.deepEqual(rt.connectedReaders(), [c.body]);
  assert.equal(meshStatus(c).bound, true);
  assert.equal(woke, 0);
});
