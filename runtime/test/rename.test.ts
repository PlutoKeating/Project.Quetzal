// 项目由 Amani 更名为 Windler：旧配置与旧数据库被沿用，旧的 agent 标记统一为 agent。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "windler-rename-"));
process.env.WINDLER_HOME = home;
fs.mkdirSync(path.join(home, "config"), { recursive: true });
fs.mkdirSync(path.join(home, "data"), { recursive: true });
fs.writeFileSync(path.join(home, "config/windler.json"), JSON.stringify({ body: "b", timezone: "Asia/Shanghai" }));
fs.writeFileSync(path.join(home, "config/amani.json"), JSON.stringify({ body: "b", soul: { remote: "git@example.com:x/y.git" }, feishu: { enabled: true, appId: "cli_x" } }));
const old = new DatabaseSync(path.join(home, "data/amani.db"));
old.exec("CREATE TABLE messages(id INTEGER PRIMARY KEY, ts INTEGER, role TEXT, channel TEXT, text TEXT); CREATE TABLE audit(id INTEGER PRIMARY KEY, ts INTEGER, actor TEXT, action TEXT, reason TEXT, args TEXT, result TEXT);");
old.exec("INSERT INTO messages(ts,role,channel,text) VALUES(1,'user','c','hi'),(2,'amani','c','yo'); INSERT INTO audit(ts,actor,action) VALUES(1,'amani','shell');");
old.close();

const { loadConfig } = await import("../src/config.ts");
const { openStore, recentMessages, db } = await import("../src/store.ts");

test("旧配置合并进新配置并移除", () => {
  const c = loadConfig();
  assert.equal(c.soul.remote, "git@example.com:x/y.git");
  assert.equal(c.feishu.enabled, true);
  assert.equal(c.body, "b");
  assert.ok(!fs.existsSync(path.join(home, "config/amani.json")));
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, "config/windler.json"), "utf8")).feishu.appId, "cli_x");
});

test("旧数据库改名沿用，旧标记统一为 agent", async () => {
  openStore();
  const { db: d } = await import("../src/store.ts");
  assert.ok(fs.existsSync(path.join(home, "data/windler.db")));
  assert.ok(!fs.existsSync(path.join(home, "data/amani.db")));
  assert.deepEqual(recentMessages(10).map((m: any) => m.role), ["user", "agent"]);
  assert.equal((d.prepare("SELECT actor FROM audit").get() as any).actor, "agent");
  void db;
});
