// 安装网状层的原生组件到 <目标目录>/node_modules：按 mesh-modules.lock.json 的版本下载 npm 包，逐个核对 sha512 后解压。
// 用法：node install-mesh-modules.mjs [--extra=<名>] <锁定文件> <目标目录> <平台> [registry …]
//   --extra=bridge：同时装上锁定文件 extra.bridge 里的包（灵魂桥从源代码运行时需要）。
//   平台：android-arm64 / linux-x64-gnu / linux-arm64-gnu / linux-x64-musl / linux-arm64-musl；registry 依次尝试（默认 npmjs，可再给镜像源）。
// 只用 Node 内置模块（安卓 Termux 与 Linux 安装器共用）。核对不过就不安装：宁可没有网状层，也不装来路不明的原生代码。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";

const argv = process.argv.slice(2);
const extras = argv.filter((a) => a.startsWith("--extra=")).map((a) => a.slice(8));
const [lockFile, dest, platform, ...registries] = argv.filter((a) => !a.startsWith("--extra="));
if (!lockFile || !dest || !platform) { console.error("用法：node install-mesh-modules.mjs <锁定文件> <目标目录> <平台> [registry …]"); process.exit(2); }
const lock = JSON.parse(fs.readFileSync(lockFile, "utf8"));
const plat = lock.platform[platform];
if (!plat) { console.error(`不支持的平台：${platform}`); process.exit(3); }
const pkgs = { ...lock.common, ...plat };
for (const x of extras) { if (!lock.extra?.[x]) { console.error(`锁定文件里没有 extra.${x}`); process.exit(3); } Object.assign(pkgs, lock.extra[x]); }
const regs = registries.length ? registries : ["https://registry.npmjs.org"];

async function fetchVerified(name, { version, integrity }) {
  const [algo, want] = integrity.split("-", 2);
  const file = `${name.split("/").pop()}-${version}.tgz`;
  let lastErr = "";
  for (const reg of regs) {
    const url = `${reg.replace(/\/$/, "")}/${name}/-/${file}`;
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(300_000) });
      if (!r.ok) { lastErr = `${url}: HTTP ${r.status}`; continue; }
      const buf = Buffer.from(await r.arrayBuffer());
      const got = crypto.createHash(algo).update(buf).digest("base64");
      if (got !== want) { lastErr = `${url}: 校验不符（内容被改过或下载不完整）`; continue; }
      return buf;
    } catch (e) { lastErr = `${url}: ${e.message}`; }
  }
  throw new Error(`下载 ${name}@${version} 失败：${lastErr}`);
}

/** 解压 npm 包（gzip 的 tar，条目都在 package/ 下）到 dir。只接受普通文件与目录，拒绝越界路径与链接。 */
function untar(tgz, dir) {
  const tar = zlib.gunzipSync(tgz);
  let off = 0, longName = "";
  while (off + 512 <= tar.length) {
    const h = tar.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const str = (a, b) => h.subarray(a, b).toString("utf8").replace(/\0.*$/s, "");
    let name = longName || (str(345, 500) ? `${str(345, 500)}/${str(0, 100)}` : str(0, 100));
    longName = "";
    const size = parseInt(str(124, 136).trim() || "0", 8), type = String.fromCharCode(h[156] || 48);
    const body = tar.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === "L") { longName = body.toString("utf8").replace(/\0.*$/s, ""); continue; }
    if (type === "x" || type === "g") continue; // pax 头
    const rel = name.replace(/^package\//, "");
    const out = path.resolve(dir, rel);
    if (!out.startsWith(path.resolve(dir) + path.sep)) throw new Error(`包里有越界路径：${name}`);
    if (type === "5") fs.mkdirSync(out, { recursive: true });
    else if (type === "0" || type === "\0") { fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, body, { mode: parseInt(str(100, 108).trim() || "644", 8) & 0o755 }); }
    else throw new Error(`包里有不接受的条目类型 ${type}：${name}`);
  }
}

const nm = path.join(dest, "node_modules");
const stage = fs.mkdtempSync(path.join(dest, ".mesh-modules-"));
try {
  for (const [name, spec] of Object.entries(pkgs)) {
    const buf = await fetchVerified(name, spec);
    untar(buf, path.join(stage, name));
    console.log(`✓ ${name}@${spec.version}（${(buf.length / 1048576).toFixed(1)} MB，sha512 核对通过）`);
  }
  for (const name of Object.keys(pkgs)) {
    const to = path.join(nm, name);
    fs.rmSync(to, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(path.join(stage, name), to);
  }
} finally { fs.rmSync(stage, { recursive: true, force: true }); }
