// 停止要真的停下（issue #39）：等批准时被停止，审批撤销、视为拒绝；结束命令时连它派生的子进程一起结束，不被占着输出管道的孙进程拖住。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "quetzal-stop-cancel-"));
process.env.QUETZAL_HOME = path.join(tmp, "home");
const { loadConfig } = await import("../src/config.ts");
loadConfig();
const store = await import("../src/store.ts");
store.openStore();
const guard = await import("../src/guard/guard.ts");
const { run } = await import("../src/sh.ts");

test("等批准时调用被停止：审批撤销、视为拒绝，不再等 30 分钟", async () => {
  const ctl = new AbortController();
  const asked = guard.check("camera", "拍照", "测试", {}, ctl.signal); // 相机默认「每次询问」
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(guard.approvals().filter((a) => a.status === "pending").length, 1);
  ctl.abort();
  assert.equal(await asked, false);
  assert.equal(guard.approvals().filter((a) => a.status === "pending").length, 0);
  assert.equal(await guard.check("camera", "拍照", "测试", {}, ctl.signal), false, "已经停止的不再生成审批");
  assert.equal(guard.approvals().filter((a) => a.status === "pending").length, 0);
});

test("停止命令时整组结束：后台派生的子进程占着输出管道，也不会让命令一直不返回", { skip: process.platform === "win32" && "Windows 用 taskkill /T，另有覆盖" }, async () => {
  const ctl = new AbortController();
  const t0 = Date.now();
  const r = run("sh", ["-c", "sleep 300 & sleep 300"], 600_000, { signal: ctl.signal });
  setTimeout(() => ctl.abort(), 200);
  const { err } = await r;
  assert.match(err, /这一轮被停止，命令已结束/);
  assert.ok(Date.now() - t0 < 4_000, `很快返回（${Date.now() - t0} ms）`);
});
