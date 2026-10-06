// Windows 安装包内嵌依赖的锁定文件与下载核对脚本（cli/windows/fetch-deps.mjs）的纯逻辑：不联网。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// @ts-expect-error 纯 JS 模块（构建脚本），没有类型声明
import { readLock, entries, checkEntry, verified } from "../windows/fetch-deps.mjs";

test("锁定文件：三个依赖各有 x64 与 arm64，都是官方 https 地址、SHA-256 与大小齐全", () => {
  const lock = readLock();
  for (const arch of ["x64", "arm64"]) {
    const list = entries(lock, "embedded", arch);
    assert.deepEqual(list.map((e: { key: string }) => e.key).sort(), ["git", "node", "python"]);
    for (const e of list) { assert.ok(checkEntry(e)); assert.ok(Number.isInteger(e.size)); }
  }
  const [nsis] = entries(lock, "tools", "nsis");
  assert.ok(checkEntry(nsis));
  assert.match(lock.embedded.node.version, /^24\./, "Windows 用 Node 24 LTS");
  assert.match(lock.embedded.python.version, /^3\.14\./);
  const [maj, min] = lock.embedded.node.version.split(".").map(Number);
  assert.ok(maj > 22 || (maj === 22 && min >= 13), "内嵌的 Node 必须满足运行基座的 22.13+");
  assert.throws(() => entries(lock, "embedded", "x86"));
});

test("checkEntry：非官方主机、http、文件名与地址不符、哈希格式不对都拒绝", () => {
  const ok = { key: "t", file: "a.exe", url: "https://nodejs.org/dist/a.exe", sha256: "0".repeat(64) };
  assert.ok(checkEntry(ok));
  assert.throws(() => checkEntry({ ...ok, url: "https://evil.example/a.exe" }));
  assert.throws(() => checkEntry({ ...ok, url: "http://nodejs.org/dist/a.exe" }));
  assert.throws(() => checkEntry({ ...ok, file: "b.exe" }));
  assert.throws(() => checkEntry({ ...ok, file: "../a.exe", url: "https://nodejs.org/dist/../a.exe" }));
  assert.throws(() => checkEntry({ ...ok, sha256: "XYZ" }));
});

test("verified：大小与 SHA-256 都相符才算已有", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "quetzal-deps-"));
  const f = path.join(dir, "a.exe");
  fs.writeFileSync(f, "installer");
  const sha256 = createHash("sha256").update("installer").digest("hex");
  assert.equal(verified(f, { sha256, size: 9 }), true);
  assert.equal(verified(f, { sha256 }), true);
  assert.equal(verified(f, { sha256, size: 10 }), false);
  assert.equal(verified(f, { sha256: "0".repeat(64) }), false);
  assert.equal(verified(path.join(dir, "missing"), { sha256 }), false);
});
