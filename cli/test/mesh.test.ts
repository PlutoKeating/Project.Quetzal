// 网状层原生组件的平台名：安装器算出的名字必须在运行基座的锁定文件里有条目（版本一致、带 sha512）。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { meshPlatform } from "../src/mesh.ts";

const lock = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "runtime", "tool", "mesh-modules.lock.json"), "utf8"));

test("平台名：Linux 分 glibc / musl，macOS 分 x64 / arm64；别的架构与系统没有预编译包", () => {
  assert.equal(meshPlatform("linux", "x64", () => "2.39"), "linux-x64-gnu");
  assert.equal(meshPlatform("linux", "arm64", () => undefined), "linux-arm64-musl");
  assert.equal(meshPlatform("darwin", "arm64"), "darwin-arm64");
  assert.equal(meshPlatform("darwin", "x64"), "darwin-x64");
  assert.equal(meshPlatform("darwin", "ia32"), undefined);
  assert.equal(meshPlatform("freebsd", "x64"), undefined);
});

test("锁定文件里有安装器会用到的每个平台，版本与 node-datachannel 一致，哈希是 sha512", () => {
  const version = lock.common["node-datachannel"].version;
  for (const p of ["linux-x64-gnu", "linux-arm64-gnu", "linux-x64-musl", "linux-arm64-musl", "darwin-x64", "darwin-arm64"]) {
    const entries = Object.entries(lock.platform[p] ?? {}) as [string, { version: string; integrity: string }][];
    assert.equal(entries.length, 1, p);
    const [name, spec] = entries[0];
    assert.equal(name, `@node-datachannel/${p}`);
    assert.equal(spec.version, version, p);
    assert.match(spec.integrity, /^sha512-[A-Za-z0-9+/]{86}==$/, p);
  }
});
