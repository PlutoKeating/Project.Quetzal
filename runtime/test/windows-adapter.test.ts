// Windows 适配器：能在任何平台上测的纯逻辑（打开的白名单），以及只在 Windows（CI 的 windows runner）上跑的真机部分：
// 常驻 PowerShell、电源采样、会话判断。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openable } from "../adapters/windows/desktop.ts";

const WIN = process.platform === "win32";

test("打开：网址与文档可以，程序与脚本不行", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "q-open-"));
  const doc = path.join(dir, "a.pdf"), exe = path.join(dir, "a.exe"), lnk = path.join(dir, "b.LNK");
  for (const f of [doc, exe, lnk]) fs.writeFileSync(f, "x");
  assert.equal(openable("https://example.com"), undefined);
  assert.equal(openable("mailto:a@b.c"), undefined);
  assert.equal(openable(doc), undefined);
  assert.equal(openable(dir), undefined, "文件夹可以");
  assert.match(openable(exe)!, /不打开可执行/);
  assert.match(openable(lnk)!, /不打开可执行/);
  assert.match(openable("ms-settings:privacy")!, /只能打开网址/);
  assert.match(openable("file:///C:/Windows/System32/calc.exe")!, /只能打开网址/);
  assert.match(openable(path.join(dir, "nope.pdf"))!, /找不到/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("Windows：常驻 PowerShell 来回传中文与多行输出，出错时拒绝", { skip: !WIN && "只在 Windows 上跑" }, async () => {
  const { PsHost } = await import("../adapters/windows/ps.ts");
  const h = new PsHost();
  assert.equal(await h.run("'你好' + \"`n\" + 'world'"), "你好\nworld");
  await assert.rejects(() => h.run("throw '坏了'"), /坏了/);
  assert.equal(await h.run("1 + 1"), "2", "出错之后还能接着用");
  h.stop();
});

test("Windows：适配器初始化与采样不抛错", { skip: !WIN && "只在 Windows 上跑" }, async () => {
  const a = (await import("../adapters/windows/index.ts")).default;
  await a.init!();
  assert.match(a.describe, /Windows/);
  const s = await a.sample();
  assert.equal(typeof s, "object");
  const { ps } = await import("../adapters/windows/desktop.ts");
  ps.stop();
});
