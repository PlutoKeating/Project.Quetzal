#!/usr/bin/env node
// 由 cli/windows/install.src.ps1（UTF-8，中文直接写）生成纯 ASCII 的 cli/install.ps1（官网的 /install.ps1）：
//   - 含非 ASCII 字符的整行注释删掉；
//   - 含非 ASCII 字符的单引号字符串 '…'（'' 是转义的单引号）换成 (Z '<UTF-8 的 base64>')，运行时解码；
//   - 其余原样；生成后仍有非 ASCII 字符就报错。
// 用法：node gen-install-ps1.mjs          重新生成
//       node gen-install-ps1.mjs --check  只检查已提交的 install.ps1 是否与源文件一致（测试用）
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const SRC = path.join(here, "install.src.ps1");
export const OUT = path.join(here, "..", "install.ps1");
const NON_ASCII = /[^\x00-\x7f]/;
const HEADER = "# This file is GENERATED from cli/windows/install.src.ps1 by cli/windows/gen-install-ps1.mjs; edit the source, not this file.";

export function generate(src) {
  const out = [];
  for (const line of src.replace(/\r\n/g, "\n").split("\n")) {
    if (/^\s*#/.test(line)) {
      if (NON_ASCII.test(line)) continue;
      out.push(line.includes("GENERATED-HEADER") ? HEADER : line);
      continue;
    }
    const conv = line.replace(/'(?:[^']|'')*'/g, (lit) => {
      if (!NON_ASCII.test(lit)) return lit;
      const text = lit.slice(1, -1).replace(/''/g, "'");
      return `(Z '${Buffer.from(text, "utf8").toString("base64")}')`;
    });
    const bad = conv.search(NON_ASCII);
    if (bad >= 0) throw new Error(`install.src.ps1 有单引号字符串之外的非 ASCII 字符：${line.trim().slice(0, 80)}`);
    out.push(conv);
  }
  return out.join("\r\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const text = generate(fs.readFileSync(SRC, "utf8"));
  if (process.argv.includes("--check")) {
    const cur = fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf8") : "";
    if (cur !== text) { console.error("cli/install.ps1 与 install.src.ps1 不一致：运行 node cli/windows/gen-install-ps1.mjs"); process.exit(1); }
  } else {
    fs.writeFileSync(OUT, text);
    console.log(`已生成 ${OUT}`);
  }
}
