#!/usr/bin/env node
// 构建 Windows 安装包时下载并核对锁定的官方安装包（deps.lock.json）：只用 Node 内置模块。
// 用法：
//   node fetch-deps.mjs <x64|arm64> <目标目录>      下载 Node.js / Git for Windows / Python 三个安装包到 <目标目录>/<文件名>
//   node fetch-deps.mjs --tool nsis <目标目录>       下载构建工具（NSIS 的 zip）
// 已存在且哈希相符的文件不再下载。任何一个文件的大小或 SHA-256 与锁定值不符都以非 0 退出，不留下半个文件。
// 只接受锁定文件里写的官方地址（https，主机在 OFFICIAL_HOSTS 里），跟随跳转时也只接受 https。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const OFFICIAL_HOSTS = new Set(["nodejs.org", "github.com", "www.python.org", "downloads.sourceforge.net"]);
const MAX_BYTES = 256 * 1048576;

export function readLock(file = fileURLToPath(new URL("./deps.lock.json", import.meta.url))) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/** 锁定文件里某个架构要下载的条目：[{ key, file, url, sha256, size }]；kind 为 embedded 时 arch 是 x64 / arm64，tools 时是工具名。 */
export function entries(lock, kind, arch) {
  if (kind === "embedded") {
    if (!["x64", "arm64"].includes(arch)) throw new Error(`不认识的架构：${arch}`);
    return Object.entries(lock.embedded).map(([key, v]) => ({ key, version: v.version, ...v[arch] }));
  }
  const t = lock.tools[arch];
  if (!t) throw new Error(`锁定文件里没有工具：${arch}`);
  return [{ key: arch, version: t.version, ...t.any }];
}

/** 一个条目是否合规：官方 https 地址、64 位十六进制 SHA-256、文件名与地址末段一致、没有路径成分。 */
export function checkEntry(e) {
  const u = new URL(e.url);
  if (u.protocol !== "https:" || !OFFICIAL_HOSTS.has(u.hostname)) throw new Error(`${e.key}：不是官方 https 地址：${e.url}`);
  if (!/^[0-9a-f]{64}$/.test(e.sha256)) throw new Error(`${e.key}：sha256 格式不对`);
  if (!/^[A-Za-z0-9._-]+$/.test(e.file) || decodeURIComponent(u.pathname.split("/").pop()) !== e.file) throw new Error(`${e.key}：文件名与地址不符：${e.file}`);
  if (e.size !== undefined && !(Number.isInteger(e.size) && e.size > 0)) throw new Error(`${e.key}：size 不对`);
  return true;
}

export const sha256File = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");

/** 文件存在、大小（锁定了的话）与 SHA-256 都相符。 */
export function verified(f, e) {
  try {
    if (e.size !== undefined && fs.statSync(f).size !== e.size) return false;
    return sha256File(f) === e.sha256;
  } catch { return false; }
}

async function download(e, to) {
  let url = e.url;
  for (let hop = 0; hop < 8; hop++) {
    const r = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(600_000), headers: { "User-Agent": "quetzal-build" } });
    if (r.status >= 300 && r.status < 400 && r.headers.get("location")) {
      const next = new URL(r.headers.get("location"), url);
      if (next.protocol !== "https:") throw new Error(`${e.key}：跳转到了非 https 地址 ${next}`);
      url = next.toString(); continue;
    }
    if (!r.ok || !r.body) throw new Error(`${e.key}：${url} 返回 HTTP ${r.status}`);
    const hash = crypto.createHash("sha256");
    const out = fs.createWriteStream(to);
    let n = 0;
    try {
      for await (const chunk of r.body) {
        n += chunk.length;
        if (n > MAX_BYTES) throw new Error(`${e.key}：超过 ${MAX_BYTES / 1048576} MB 上限`);
        hash.update(chunk);
        if (!out.write(chunk)) await new Promise((res) => out.once("drain", res));
      }
    } finally { await new Promise((res) => out.end(res)); }
    const got = hash.digest("hex");
    if (e.size !== undefined && n !== e.size) throw new Error(`${e.key}：大小 ${n} 与锁定的 ${e.size} 不符`);
    if (got !== e.sha256) throw new Error(`${e.key}：SHA-256 ${got} 与锁定的 ${e.sha256} 不符`);
    return;
  }
  throw new Error(`${e.key}：跳转次数太多`);
}

/** 下载并核对一组条目到 dir；返回 [{ key, file, path }]。 */
export async function fetchAll(list, dir, say = (s) => console.log(s)) {
  fs.mkdirSync(dir, { recursive: true });
  const done = [];
  for (const e of list) {
    checkEntry(e);
    const to = path.join(dir, e.file);
    if (verified(to, e)) { say(`已有 ${e.file}（${e.key} ${e.version}，SHA-256 相符）`); done.push({ key: e.key, file: e.file, path: to }); continue; }
    const part = `${to}.part`;
    fs.rmSync(part, { force: true });
    let last;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try { say(`下载 ${e.url}`); await download(e, part); last = undefined; break; }
      catch (err) { last = err; fs.rmSync(part, { force: true }); say(`第 ${attempt} 次失败：${err.message}`); }
    }
    if (last) throw last;
    fs.renameSync(part, to);
    say(`核对通过 ${e.file}（${e.key} ${e.version}，SHA-256 ${e.sha256}）`);
    done.push({ key: e.key, file: e.file, path: to });
  }
  return done;
}

async function main(argv) {
  const lock = readLock();
  const [a, b, c] = argv;
  const list = a === "--tool" ? entries(lock, "tools", b) : entries(lock, "embedded", a);
  const dir = a === "--tool" ? c : b;
  if (!dir) { console.error("用法：node fetch-deps.mjs <x64|arm64> <目标目录> | --tool nsis <目标目录>"); process.exit(2); }
  await fetchAll(list, path.resolve(dir));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => { console.error(e.message); process.exit(1); });
}
