// Windows 安装包（cli/windows/）：构建脚本的纯函数、PowerShell 脚本只能是 ASCII（Windows PowerShell 5.1 按 ANSI 代码页读无 BOM 的文件），
// 以及 setup 辅助脚本的纯逻辑测试（有 powershell.exe 或 pwsh 时运行：Windows 上用系统自带的 5.1，其他系统有 pwsh 才跑）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error 纯 JS 模块（构建脚本），没有类型声明
import { viVersion, setupName, consoleRoot, RUNTIME_FILES } from "../windows/build-setup.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const win = path.join(here, "..", "windows");

/** 能跑 PowerShell 测试的解释器：Windows 上是 powershell.exe（5.1），其他系统是 PATH 上的 pwsh；都没有返回空。 */
export function powershell(): string | undefined {
  const cands = process.platform === "win32" ? ["powershell.exe", "pwsh.exe"] : ["pwsh"];
  return cands.find((c) => spawnSync(c, ["-NoProfile", "-Command", "exit 0"], { stdio: "ignore" }).status === 0);
}

test("版本号与资产名", () => {
  assert.equal(viVersion("1.4.0"), "1.4.0.0");
  assert.equal(viVersion("1.4.0-rc.1"), "1.4.0.0");
  assert.throws(() => viVersion("1.4"));
  assert.equal(setupName("1.4.0", "arm64"), "quetzal-1.4.0-windows-arm64-setup.exe");
  assert.deepEqual(RUNTIME_FILES, ["main.cjs", "windows.mjs", "windows-body.mjs", "windows-supervise.mjs", "srt.mjs"]);
});

test("控制台压缩包解开后的目录：有没有顶层目录都能找到 quetzal-console.exe", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "quetzal-console-"));
  fs.mkdirSync(path.join(d, "a", "quetzal-console"), { recursive: true });
  fs.writeFileSync(path.join(d, "a", "quetzal-console", "quetzal-console.exe"), "");
  assert.equal(consoleRoot(path.join(d, "a")), path.join(d, "a", "quetzal-console"));
  assert.equal(consoleRoot(path.join(d, "a", "quetzal-console")), path.join(d, "a", "quetzal-console"));
  fs.mkdirSync(path.join(d, "b"));
  assert.throws(() => consoleRoot(path.join(d, "b")));
});

test("装到用户机器上由 Windows PowerShell 5.1 / cmd 执行的脚本只含 ASCII", () => {
  const files = ["setup/quetzal-setup.ps1", "setup/quetzal-machine.ps1", "setup/quetzal-supervise.ps1", "setup/quetzal.cmd", "../install.ps1"];
  for (const f of files) {
    const p = path.join(win, f);
    if (!fs.existsSync(p)) continue;
    const bad = [...fs.readFileSync(p)].findIndex((b) => b > 0x7e || (b < 0x20 && b !== 0x0a && b !== 0x0d && b !== 0x09));
    assert.equal(bad, -1, `${f} 在字节 ${bad} 处有非 ASCII 字符`);
  }
});

test("setup 辅助脚本的纯逻辑（PowerShell）", (t) => {
  const ps = powershell();
  if (!ps) { t.skip("没有 powershell / pwsh"); return; }
  const r = spawnSync(ps, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(here, "windows", "setup.tests.ps1")], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});
