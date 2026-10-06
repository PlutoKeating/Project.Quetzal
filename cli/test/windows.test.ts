// Windows 运维命令的纯逻辑（cli/src/windows.ts）：目录、版本指针、回滚、控制台位置、schtasks 输出解析、日志末尾。任何系统上都能跑。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { winRoot, winLayout, readPointer, writePointer, currentVersion, previousVersion, winRollback, consoleExe, parseSchtasksCsv, tailLines } from "../src/windows.ts";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "quetzal-win-"));
  const l = winLayout(root, path.join(root, "home"));
  for (const v of ["1.4.0", "1.4.1"]) {
    fs.mkdirSync(path.join(l.runtime, v), { recursive: true });
    fs.mkdirSync(path.join(l.console, v), { recursive: true });
    fs.writeFileSync(path.join(l.console, v, "quetzal-console.exe"), "");
  }
  return l;
}

test("安装目录：QUETZAL_ROOT 优先，否则 %LOCALAPPDATA%\\Quetzal；家目录默认在 home 下", () => {
  assert.equal(winRoot({ QUETZAL_ROOT: "/r" }), "/r");
  assert.equal(winRoot({ LOCALAPPDATA: "/la" }), path.join("/la", "Quetzal"));
  const l = winLayout("/r", "/h");
  assert.equal(l.current, path.join("/r", "runtime", "current.txt"));
  assert.equal(l.log, path.join("/h", "logs", "runtime.log"));
  assert.equal(l.uninstaller, path.join("/r", "uninstall.exe"));
});

test("指针文件：带 BOM 与 CRLF 也能读；不是版本号的内容当作没有；指向的目录不在也当作没有", () => {
  const l = fixture();
  fs.writeFileSync(l.current, "﻿1.4.1\r\n");
  assert.equal(readPointer(l.current), "1.4.1");
  assert.equal(currentVersion(l), "1.4.1");
  fs.writeFileSync(l.current, "..\\..\\x");
  assert.equal(readPointer(l.current), undefined);
  writePointer(l.current, "9.9.9");
  assert.equal(readPointer(l.current), "9.9.9");
  assert.equal(currentVersion(l), undefined);
  assert.throws(() => writePointer(l.current, "x"));
  assert.ok(!fs.readdirSync(l.runtime).some((f) => f.endsWith(".tmp")));
});

test("回滚：current 与 previous 互换，控制台跟着走；没有上一版时不动", () => {
  const l = fixture();
  writePointer(l.current, "1.4.1");
  assert.equal(winRollback(l), undefined);
  writePointer(l.previous, "1.4.0");
  writePointer(l.consoleCurrent, "1.4.1");
  assert.equal(winRollback(l), "1.4.0");
  assert.equal(currentVersion(l), "1.4.0");
  assert.equal(previousVersion(l), "1.4.1");
  assert.equal(consoleExe(l), path.join(l.console, "1.4.0", "quetzal-console.exe"));
  assert.equal(winRollback(l), "1.4.1");
});

test("schtasks 的 CSV 输出：取任务名与状态（引号里的逗号与转义引号）", () => {
  assert.deepEqual(parseSchtasksCsv('\r\n"\\Quetzal\\Runtime-Boot","N/A","Running"\r\n'), { name: "\\Quetzal\\Runtime-Boot", status: "Running" });
  assert.deepEqual(parseSchtasksCsv('"\\Quetzal\\Runtime-Logon","2026/10/8 9:00:00","就绪"'), { name: "\\Quetzal\\Runtime-Logon", status: "就绪" });
  assert.deepEqual(parseSchtasksCsv('"a, ""b""","x","y"'), { name: 'a, "b"', status: "y" });
  assert.equal(parseSchtasksCsv("ERROR: The system cannot find the file specified."), undefined);
});

test("日志末尾 n 行", () => {
  assert.equal(tailLines("a\r\nb\r\nc\r\n", 2), "b\nc");
  assert.equal(tailLines("a\nb", 5), "a\nb");
  assert.equal(tailLines("", 3), "");
});
