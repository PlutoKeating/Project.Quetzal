// 版本目录布局：放入、切换、回滚、清理，与 Android 安装器的约定一致。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { layout, putRelease, switchTo, rollback, prune, versionOf, patchConfig, readConfig, defaultBody } from "../src/layout.ts";

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "quetzal-cli-"));
  const src = path.join(home, "src"); fs.mkdirSync(src);
  fs.writeFileSync(path.join(src, "main.cjs"), "// main"); fs.writeFileSync(path.join(src, "linux.mjs"), "// adapter");
  const files = ["main.cjs", "linux.mjs"].map((name) => ({ name, from: path.join(src, name) }));
  return { l: layout(home), files };
}

test("放入版本并切换：previous 跟着 current 走；回滚互换", () => {
  const { l, files } = fixture();
  fs.mkdirSync(l.releases, { recursive: true });
  const a = putRelease(l, "0.1.0", files);
  assert.equal(switchTo(l, a), undefined);
  assert.equal(versionOf(l.current), "0.1.0");
  assert.equal(versionOf(l.previous), undefined);
  const b = putRelease(l, "0.2.0", files);
  assert.equal(switchTo(l, b), a);
  assert.equal(versionOf(l.current), "0.2.0");
  assert.equal(versionOf(l.previous), "0.1.0");
  assert.ok(fs.readFileSync(path.join(l.current, "main.cjs"), "utf8").includes("main"));
  assert.equal(rollback(l), "0.1.0");
  assert.equal(versionOf(l.current), "0.1.0");
  assert.equal(versionOf(l.previous), "0.2.0");
  switchTo(l, b); // 再切回 b：previous 变成 a（不是自己）
  assert.equal(versionOf(l.previous), "0.1.0");
  switchTo(l, b); // 同一个目录再切一次：previous 不变
  assert.equal(versionOf(l.previous), "0.1.0");
});

test("清理只保留最近几个版本，current 与 previous 永远保留", () => {
  const { l, files } = fixture();
  fs.mkdirSync(l.releases, { recursive: true });
  const dirs = ["0.1.0", "0.2.0", "0.3.0", "0.4.0", "0.5.0"].map((v, i) => { const d = putRelease(l, v, files); fs.utimesSync(d, 1000 + i, 1000 + i); return d; });
  switchTo(l, dirs[0]); switchTo(l, dirs[1]); // current 0.2.0，previous 0.1.0（都是最老的）
  const removed = prune(l, 2);
  assert.deepEqual(removed.sort(), ["0.3.0"]);
  assert.deepEqual(fs.readdirSync(l.releases).sort(), ["0.1.0", "0.2.0", "0.4.0", "0.5.0"]);
});

test("配置只改安装需要的键；身体名字由主机名派生", () => {
  const { l } = fixture();
  fs.mkdirSync(path.dirname(l.config), { recursive: true });
  fs.writeFileSync(l.config, JSON.stringify({ body: "default", heart: { activity: 2 }, gateway: { port: 7799 } }));
  patchConfig(l, (c) => { c.body = defaultBody("My Laptop.local"); c.gateway = { ...c.gateway, host: "0.0.0.0" }; });
  assert.deepEqual(readConfig(l), { body: "my-laptop-local", heart: { activity: 2 }, gateway: { port: 7799, host: "0.0.0.0" } });
  assert.equal(defaultBody("---"), "linux");
  assert.equal(defaultBody("srv_01").length, 6);
});

test("整个子目录（网页控制台 web/）随版本放入，重复放入时整体替换", () => {
  const { l, files } = fixture();
  fs.mkdirSync(l.releases, { recursive: true });
  const web = path.join(l.home, "web-src"); fs.mkdirSync(path.join(web, "assets"), { recursive: true });
  fs.writeFileSync(path.join(web, "index.html"), "<html>v1</html>"); fs.writeFileSync(path.join(web, "assets", "a.js"), "1");
  const dir = putRelease(l, "0.5.0", files, [{ name: "web", from: web }]);
  assert.equal(fs.readFileSync(path.join(dir, "web", "index.html"), "utf8"), "<html>v1</html>");
  assert.equal(fs.readFileSync(path.join(dir, "web", "assets", "a.js"), "utf8"), "1");
  fs.writeFileSync(path.join(web, "index.html"), "<html>v2</html>"); fs.rmSync(path.join(web, "assets"), { recursive: true });
  putRelease(l, "0.5.0", files, [{ name: "web", from: web }]);
  assert.equal(fs.readFileSync(path.join(dir, "web", "index.html"), "utf8"), "<html>v2</html>");
  assert.ok(!fs.existsSync(path.join(dir, "web", "assets")), "旧文件不残留");
  assert.ok(!fs.existsSync(path.join(dir, "web.part")));
});
