// 一个链接接入（同步服务协议 §2.1）在运行基座这边：新装的身体（种子身份）申请时不报 agent id、带上部署公钥；
// 批准后采用同步服务链接好的灵魂仓库；绑定文件里不留链接结果。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

process.env.QUETZAL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "quetzal-soullink-"));
const { paths, loadConfig, saveConfig } = await import("../src/config.ts");
loadConfig();
const { openStore } = await import("../src/store.ts");
openStore();
const rt = await import("../src/mesh/runtime.ts");

let asked: any;
const server = http.createServer((req, res) => {
  let body = ""; req.on("data", (d) => (body += d));
  req.on("end", () => {
    const send = (j: unknown) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(j)); };
    if (req.url === "/v1/device/code") { asked = JSON.parse(body); return send({ device_code: "dc", user_code: "BCDF-GHJK", verification_uri: "x", verification_uri_complete: "https://web.example/device?code=BCDF-GHJK", expires_in: 60, interval: 1, check: "🦊🌙🍵" }); }
    if (req.url === "/v1/device/token") return send({ access_token: "qsb_x", token_type: "bearer", agent: { id: "11111111-2222-4333-8444-555555555555", name: "Kaoru" }, body: "phone", account: "pluto", soul: { repo: "pluto/kaoru.soul", remote: "git@github.com:pluto/kaoru.soul.git" } });
    res.writeHead(404); res.end();
  });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
after(() => server.close());

test("新装的身体：不报 agent id、带部署公钥；批准后采用链接好的灵魂仓库", async () => {
  saveConfig({ mesh: { server: `http://127.0.0.1:${(server.address() as { port: number }).port}` } });
  const adopted: string[] = [];
  rt.registerSoulLink({ key: async () => "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGVyZXZlcnlvbmUgbmVlZHMgYSBzb3VsIHRvIGxpdmUgaW4gISE quetzal@phone", adopt: async (r) => { adopted.push(r); } });
  const s = await rt.bind();
  assert.equal(s.binding?.check, "🦊🌙🍵");
  assert.equal(asked.agent.id, undefined, "种子身份不报 agent id，由批准的人选");
  assert.match(asked.soulKey, /^ssh-ed25519 /);
  for (let i = 0; i < 50 && !adopted.length; i++) await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(adopted, ["git@github.com:pluto/kaoru.soul.git"]);
  const saved = JSON.parse(fs.readFileSync(path.join(paths.secrets, "sync.json"), "utf8"));
  assert.equal(saved.token, "qsb_x");
  assert.equal(saved.soul, undefined);
  rt.stopMesh?.();
});
