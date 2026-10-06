#!/usr/bin/env node
// 生成某个版本的 winget 清单（PlutoKeating.Quetzal 的 version / installer / 两个 locale）：只用 Node 内置模块。
// 用法：node make-manifests.mjs --version X.Y.Z --sums SHA256SUMS --sig SHA256SUMS.sig --out <目录> [--date YYYY-MM-DD]
// 哈希只取自验过签名的 SHA256SUMS（发版签名公钥与 cli/install.sh、release.yml 相同），提交行的标签必须是 vX.Y.Z。
// 输出 <目录>/manifests/p/PlutoKeating/Quetzal/<版本>/*.yaml，即 microsoft/winget-pkgs 仓库里的路径；
// 向 winget-pkgs 提交 PR 是对外操作，由所有者自己做（见 cli/docs/README.md「winget」）。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const RELEASE_PUBKEY = "QbWLzC1yhOWroLTHtHiAAvVWq1UtWDiQP--D9wHaLU8";
export const TEMPLATES = ["PlutoKeating.Quetzal.yaml", "PlutoKeating.Quetzal.installer.yaml", "PlutoKeating.Quetzal.locale.en-US.yaml", "PlutoKeating.Quetzal.locale.zh-CN.yaml"];
const REPO_DL = "https://github.com/PlutoKeating/Project.Quetzal/releases/download";

/** 验签名、核对提交行，返回两个架构 setup.exe 的 sha256（小写）。 */
export function installerHashes(sums, sigText, version, pubkey = RELEASE_PUBKEY) {
  const key = crypto.createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: pubkey }, format: "jwk" });
  if (!crypto.verify(null, sums, key, Buffer.from(String(sigText).trim(), "base64"))) throw new Error("SHA256SUMS 的签名不对");
  const lines = sums.toString("utf8").split("\n").map((l) => l.trim());
  if (!lines.some((l) => { const m = /^commit [0-9a-f]{40} (\S+)$/.exec(l); return m && m[1] === `v${version}`; })) throw new Error(`SHA256SUMS 里没有 v${version} 的提交行`);
  const out = {};
  for (const arch of ["x64", "arm64"]) {
    const name = `quetzal-${version}-windows-${arch}-setup.exe`;
    const hit = lines.map((l) => /^([0-9a-f]{64}) [ *](.+)$/.exec(l)).find((m) => m && m[2] === name);
    if (!hit) throw new Error(`SHA256SUMS 里没有 ${name}`);
    out[arch] = hit[1];
  }
  return out;
}

export function fill(template, vars) {
  return template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_, k) => { if (!(k in vars)) throw new Error(`模板变量没有值：${k}`); return vars[k]; });
}

export function manifests(version, hashes, date) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`winget 只收正式版本：${version}`);
  const vars = {
    VERSION: version, RELEASE_DATE: date,
    URL_X64: `${REPO_DL}/v${version}/quetzal-${version}-windows-x64-setup.exe`, SHA256_X64: hashes.x64.toUpperCase(),
    URL_ARM64: `${REPO_DL}/v${version}/quetzal-${version}-windows-arm64-setup.exe`, SHA256_ARM64: hashes.arm64.toUpperCase(),
  };
  return Object.fromEntries(TEMPLATES.map((t) => [t, fill(fs.readFileSync(path.join(here, `${t}.in`), "utf8"), vars)]));
}

function main(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i += 2) o[argv[i].replace(/^--/, "")] = argv[i + 1];
  for (const k of ["version", "sums", "sig", "out"]) if (!o[k]) throw new Error(`缺少 --${k}`);
  const hashes = installerHashes(fs.readFileSync(o.sums), fs.readFileSync(o.sig, "utf8"), o.version);
  const date = o.date ?? new Date().toISOString().slice(0, 10);
  const dir = path.join(o.out, "manifests", "p", "PlutoKeating", "Quetzal", o.version);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(manifests(o.version, hashes, date))) fs.writeFileSync(path.join(dir, name), text);
  console.log(`已生成 ${dir}（验证：winget validate --manifest "${dir}"）`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(1); }
}
