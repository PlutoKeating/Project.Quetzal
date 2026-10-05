// 安卓身体适配器（只装一个 App）：经 App 的本机身体接口拿身体能力；地址与令牌在密钥目录的 body.json；连不上时不崩溃。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "quetzal-android-"));
process.env.QUETZAL_HOME = home;
const { default: adapter } = await import("../adapters/android/index.ts");

/** 一个假的 App 身体接口：只认 TOKEN，记下收到的请求。 */
const TOKEN = "t".repeat(64);
const seen: { method: string; url: string; body: any }[] = [];
let located: unknown = undefined; // 设了就让 /v1/location 成功返回它
const server = http.createServer(async (req, res) => {
  let raw = ""; for await (const c of req) raw += c;
  const body = raw ? JSON.parse(raw) : undefined;
  seen.push({ method: req.method!, url: req.url!, body });
  const send = (code: number, j: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(j)); };
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { ok: false, error: "令牌不对" });
  if (req.url === "/v1/info") return send(200, { ok: true, model: "示例机型", sensors: { light: "Light", accel: "Accelerometer" }, camera: true });
  if (req.url === "/v1/sample") return send(200, { ok: true, battery: { level: 80, charging: true, tempC: 30.5, health: "GOOD" }, lux: 120, motion: 0.02, screenOn: false, plugged: "USB" });
  if (req.url === "/v1/location" && located) return send(200, { ok: true, ...(located as object) });
  if (req.url === "/v1/location") return send(500, { ok: false, error: "没有定位权限：请在 Quetzal App 里允许定位" });
  if (req.url === "/v1/supervision") return send(200, { ok: true, enabled: true });
  return send(200, { ok: true });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as { port: number }).port;
const writeBody = (token: string) => { fs.mkdirSync(path.join(home, "secrets"), { recursive: true }); fs.writeFileSync(path.join(home, "secrets", "body.json"), JSON.stringify({ port, token })); };

test("没有身体接口时：采样为空、描述仍然成立，不崩溃", async () => {
  await adapter.init!();
  assert.equal(adapter.name, "android");
  assert.match(adapter.describe, /安卓手机/);
  assert.deepEqual(await adapter.sample(), {});
  assert.equal((await adapter.supervision!.status()).available, false);
});

test("采样、描述与守护：经身体接口，带令牌", async () => {
  writeBody(TOKEN);
  await adapter.init!();
  assert.match(adapter.describe, /示例机型/);
  assert.match(adapter.describe, /光线与运动传感器/);
  const s = await adapter.sample();
  assert.deepEqual(s.battery, { level: 80, charging: true, tempC: 30.5, health: "GOOD" });
  assert.equal(s.lux, 120);
  assert.equal(s.extra?.["充电方式"], "USB");
  assert.equal((s as Record<string, unknown>).plugged, undefined);
  assert.deepEqual(await adapter.supervision!.status(), { available: true, kind: "loop", enabled: true, detail: "Quetzal App 的前台服务：开机自启，退出后自动重启" });
});

test("工具：参数被约束、输出落在家目录、失败原因交给她", async () => {
  writeBody(TOKEN);
  const tool = (n: string) => adapter.tools!.find((t) => t.name === n)!;
  seen.length = 0;
  assert.equal(await tool("vibrate").handler({ ms: 99999 }), "振动了");
  assert.equal(seen.at(-1)!.body.ms, 3000);
  await tool("take_photo").handler({ camera: 1 });
  const photo = seen.find((r) => r.url === "/v1/photo")!;
  assert.equal(photo.body.camera, 1);
  assert.ok(photo.body.file.startsWith(path.join(home, "data", "media") + path.sep));
  assert.match(await tool("location").handler({}), /失败：没有定位权限/);
});

test("定位：定不到新位置时退回最近的已知位置，并说明是多久以前的", async () => {
  writeBody(TOKEN);
  const loc = adapter.tools!.find((t) => t.name === "location")!;
  located = { latitude: 1.23456, longitude: 2.34567, accuracy: 30, ageMinutes: 0 };
  assert.equal(await loc.handler({}), "纬度 1.235，经度 2.346，精度约 30 米");
  located = { latitude: 1.23456, longitude: 2.34567, accuracy: 30, ageMinutes: 4400 };
  assert.match(await loc.handler({}), /（这是 3 天前的位置，现在定不到新的）$/);
  located = undefined;
});

test("令牌不对：报错而不是静默成功", async () => {
  writeBody("x".repeat(64));
  assert.match(await adapter.tools!.find((t) => t.name === "torch")!.handler({ on: true }), /失败：令牌不对/);
  await assert.rejects(adapter.notify!("标题", "内容"), /令牌不对/);
  writeBody("short");
  assert.deepEqual(await adapter.sample(), {});
  server.close();
});
