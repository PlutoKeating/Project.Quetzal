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
let hands: Record<string, unknown> = { enabled: false, connected: false, screenshot: true }; // App 的无障碍服务状态
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
  if (req.url === "/v1/device-id") return send(200, { ok: true, id: "9A7B3C2D1E0F4A5B" });
  if (req.url === "/v1/hands") return send(200, { ok: true, ...hands });
  if (req.url === "/v1/hands/snapshot") return send(200, { ok: true, width: 1080, height: 2400, app: "设置（com.android.settings）", window: "设置", elements: [
    { c: "android.widget.FrameLayout", n: "", v: "", b: [0, 0, 1080, 2400], r: "3:0", k: false, e: false, s: false, en: true, f: false, se: false, ch: null },
    { c: "android.widget.LinearLayout", n: "WLAN", v: "", b: [0, 300, 1080, 160], r: "3:1", k: true, e: false, s: false, en: true, f: false, se: false, ch: null },
    { c: "android.widget.EditText", n: "搜索设置", v: "", b: [40, 120, 1000, 120], r: "3:2", k: true, e: true, s: false, en: true, f: true, se: false, ch: null },
    { c: "android.widget.Switch", n: "", v: "", b: [900, 330, 120, 80], r: "3:3", k: true, e: false, s: false, en: true, f: false, se: false, ch: true },
  ] });
  if (req.url === "/v1/hands/screenshot") { fs.writeFileSync(body.file, Buffer.from([0xff, 0xd8, 0xff, 0xd9])); return send(200, { ok: true, width: 1080, height: 2400 }); }
  if (req.url === "/v1/hands/open") return send(200, { ok: true, app: "设置", package: "com.android.settings" });
  if (req.url === "/v1/hands/windows") return send(200, { ok: true, windows: [{ id: "12", title: "设置", app: "com.android.settings", focused: true, x: 0, y: 0, w: 1080, h: 2400 }] });
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
  assert.equal(await adapter.deviceId!(), undefined, "取不到设备标识时返回 undefined（运行基座随机生成 uuid）");
});

test("设备标识：经身体接口取 App 原生代码读的 ANDROID_ID", async () => {
  writeBody(TOKEN);
  assert.equal(await adapter.deviceId!(), "9a7b3c2d1e0f4a5b");
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

test("工具：参数被约束、输出落在家目录；做不成时抛错（核心标为失败，原因交给她）", async () => {
  writeBody(TOKEN);
  const tool = (n: string) => adapter.tools!.find((t) => t.name === n)!;
  seen.length = 0;
  assert.equal(await tool("vibrate").handler({ ms: 99999 }), "振动了");
  assert.equal(seen.at(-1)!.body.ms, 3000);
  await tool("take_photo").handler({ camera: 1 });
  const photo = seen.find((r) => r.url === "/v1/photo")!;
  assert.equal(photo.body.camera, 1);
  assert.ok(photo.body.file.startsWith(path.join(home, "data", "media") + path.sep));
  await assert.rejects(tool("location").handler({}), /没有定位权限/);
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

test("手：无障碍服务没开时如实说明怎么开；开了以后读屏、点击、输入、按键、打开应用都经身体接口", async () => {
  writeBody(TOKEN);
  const { phoneKey, phoneRole } = await import("../adapters/android/index.ts");
  const h = adapter.hands!;
  let st = await h.status();
  assert.equal(st.ready, false);
  assert.match(st.reason!, /控制 → 权限 →「操作屏幕」/);
  hands = { enabled: true, connected: false, screenshot: true };
  assert.match((await h.status()).reason!, /还没有连上/);
  hands = { enabled: true, connected: true, screenshot: true };
  st = await h.status();
  assert.deepEqual([st.ready, st.tree, st.input, st.screenshot], [true, true, true, true]);
  const snap = await h.snapshot();
  assert.equal(snap.width, 1080);
  assert.deepEqual(snap.elements.map((e) => e.role), ["group", "button", "input", "switch"]);
  assert.equal(snap.elements[1].ref, "3:1");
  assert.equal(snap.elements[3].checked, true);
  seen.length = 0;
  await h.click({ x: 540, y: 380, ref: "3:1" }, { holdMs: 800 });
  assert.deepEqual(seen.at(-1), { method: "POST", url: "/v1/hands/click", body: { x: 540, y: 380, ref: "3:1", holdMs: 800 } });
  await h.type("你好", { x: 540, y: 180, ref: "3:2" });
  assert.deepEqual(seen.at(-1)!.body, { text: "你好", x: 540, y: 180, ref: "3:2" });
  await h.key(["back"]);
  assert.deepEqual(seen.at(-1)!.body, { kind: "global", action: "back" });
  await h.scroll("down", 3);
  assert.deepEqual(seen.at(-1)!.body, { direction: "down", amount: 3 });
  assert.equal(await h.openApp("设置"), "已打开 设置（com.android.settings）");
  assert.deepEqual(await h.windows!(), [{ id: "12", title: "设置", app: "com.android.settings", focused: true, x: 0, y: 0, w: 1080, h: 2400 }]);
  const shot = await h.screenshot(1280);
  assert.ok(shot.file.startsWith(path.join(home, "data", "media") + path.sep), "截图只落在家目录里");
  assert.equal(seen.at(-1)!.body.maxEdge, 1280);
  assert.deepEqual([shot.width, shot.height], [1080, 2400]);
  assert.deepEqual(phoneKey(["ctrl", "v"]), { kind: "edit", action: "paste" });
  assert.deepEqual(phoneKey(["enter"]), { kind: "edit", action: "enter" });
  assert.deepEqual(phoneKey(["esc"]), { kind: "global", action: "back" });
  assert.throws(() => phoneKey(["alt", "tab"]), /手机上不能按 alt\+tab/);
  assert.equal(phoneRole("android.widget.ImageView", { clickable: true }), "image");
  assert.equal(phoneRole("android.view.View", { clickable: true }), "button");
  assert.equal(phoneRole("com.google.android.material.button.MaterialButton"), "button");
  assert.equal(phoneRole("android.widget.TextView", { editable: true }), "input");
});

test("令牌不对：报错而不是静默成功", async () => {
  writeBody("x".repeat(64));
  await assert.rejects(adapter.tools!.find((t) => t.name === "torch")!.handler({ on: true }), /令牌不对/);
  await assert.rejects(adapter.notify!("标题", "内容"), /令牌不对/);
  writeBody("short");
  assert.deepEqual(await adapter.sample(), {});
  server.close();
});
