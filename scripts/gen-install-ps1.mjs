#!/usr/bin/env node
// 由 scripts/install.src.ps1 生成 scripts/install.ps1（官网的 /install.ps1，Windows 一键安装）。
// Windows PowerShell 5.1 按 ANSI 代码页读取脚本，因此生成的 install.ps1 必须是纯 ASCII；
// 源文件里若出现非 ASCII 字符，这里直接失败（源文件本身也保持英文注释，便于审计）。
// 生成后的文件与源文件只差文件头：一段说明来源的注释 + 源文件内容的 sha256，可在不联网的情况下核对。
// 用法：node scripts/gen-install-ps1.mjs            重新生成
//       node scripts/gen-install-ps1.mjs --check    只检查已提交的 install.ps1 是否与源文件一致（测试用）
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const SRC = fileURLToPath(new URL("./install.src.ps1", import.meta.url));
export const OUT = fileURLToPath(new URL("./install.ps1", import.meta.url));

const NON_ASCII = /[^\x00-\x7f]/;

export function generate(source) {
  const bad = source.search(NON_ASCII);
  if (bad >= 0) {
    const line = source.slice(0, bad).split(/\r?\n/).length;
    throw new Error(`install.src.ps1 must stay pure ASCII for Windows PowerShell 5.1 (first non-ASCII at line ${line})`);
  }
  const hash = createHash("sha256").update(source, "utf8").digest("hex");
  const header = [
    "# Quetzalcoatl installer for Windows: irm https://quetzal.plutokeating.beer/install.ps1 | iex",
    "# GENERATED from scripts/install.src.ps1 by scripts/gen-install-ps1.mjs - edit the source, not this file.",
    `# source sha256: ${hash}`,
    "# The Ed25519 verifier and the embedded release key are part of this file: there is no black box.",
    "",
  ].join("\r\n");
  return header + source.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const generated = generate(readFileSync(SRC, "utf8"));
  if (process.argv.includes("--check")) {
    const current = existsSync(OUT) ? readFileSync(OUT, "utf8") : "";
    if (current !== generated) {
      console.error("scripts/install.ps1 is out of date: run node scripts/gen-install-ps1.mjs");
      process.exit(1);
    }
    console.log("scripts/install.ps1 is up to date");
  } else {
    writeFileSync(OUT, generated);
    console.log(`generated ${OUT}`);
  }
}
