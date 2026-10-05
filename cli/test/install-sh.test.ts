// 一键安装脚本 install.sh 里的校验与引用函数：去掉最后一行 main 调用后 source 进 bash，单独调用。
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, writeFileSync, readFileSync, copyFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const script = join(dirname(fileURLToPath(import.meta.url)), "..", "install.sh");
const body = readFileSync(script, "utf8").replace(/\nmain "\$@"\s*$/, "\n");
const dir = mkdtempSync(join(tmpdir(), "quetzal-install-sh-"));
const lib = join(dir, "lib.sh");
writeFileSync(lib, body);

/** 在 source 了 install.sh 的 bash 里跑一段，返回 { code, out } */
function sh(code: string, env: Record<string, string> = {}) {
  const r = spawnSync("bash", ["-c", `source "$LIB"; LOG=/dev/null; NODE="$NODE_BIN"; ${code}`], {
    env: { ...process.env, LIB: lib, NODE_BIN: process.execPath, ...env }, encoding: "utf8",
  });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr };
}

test("install.sh 语法正确，最后一行才调用 main（下载中断不会跑半截）", () => {
  execFileSync("bash", ["-n", script]);
  assert.match(readFileSync(script, "utf8"), /\nmain "\$@"\n?$/);
});

test("release_sum：签名正确、提交行标签一致才输出资产的哈希；篡改、换标签、缺条目一律拒绝", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const x = (publicKey.export({ format: "jwk" }) as { x: string }).x;
  const name = "quetzal-1.2.3-linux-x64-console.tar.gz";
  const h = createHash("sha256").update("tarball").digest("hex");
  const sums = `${h}  ${name}\n${"a".repeat(64)}  quetzal-1.2.3-android-arm64.apk\ncommit ${"c".repeat(40)} v1.2.3\n`;
  const write = (content: string, sigOf = content) => {
    writeFileSync(join(dir, "SHA256SUMS"), content);
    writeFileSync(join(dir, "SHA256SUMS.sig"), sign(null, Buffer.from(sigOf), privateKey).toString("base64") + "\n");
  };
  const run = (asset = name, tag = "v1.2.3") =>
    sh(`release_sum "$D/SHA256SUMS" "$D/SHA256SUMS.sig" "${asset}" "${tag}"`, { D: dir, RELEASE_PUBKEY: x });
  // RELEASE_PUBKEY 在脚本里写死：source 之后再覆盖成测试公钥
  const withKey = (asset = name, tag = "v1.2.3") =>
    sh(`RELEASE_PUBKEY="${x}"; release_sum "$D/SHA256SUMS" "$D/SHA256SUMS.sig" "${asset}" "${tag}"`, { D: dir });

  write(sums);
  assert.deepEqual([withKey().code, withKey().out], [0, h]);
  assert.notEqual(run().code, 0, "脚本自带的正式公钥不认测试签名");
  assert.notEqual(withKey(name, "v1.2.4").code, 0, "提交行的标签必须是这个版本");
  assert.notEqual(withKey("quetzal-1.2.3-linux-riscv-console.tar.gz").code, 0, "清单里没有的资产");
  write(sums.replace(h, "b".repeat(64)), sums);
  assert.notEqual(withKey().code, 0, "清单被改过，签名不再对得上");
});

test("sha256_is：哈希一致才通过", () => {
  const f = join(dir, "blob");
  writeFileSync(f, "hello");
  const h = createHash("sha256").update("hello").digest("hex");
  assert.equal(sh(`sha256_is "$F" ${h}`, { F: f }).code, 0);
  assert.notEqual(sh(`sha256_is "$F" ${"0".repeat(64)}`, { F: f }).code, 0);
});

test("sq / cron_q：带单引号、空格、$ 与 % 的路径原样还原", () => {
  const p = "/home/a b/it's $x `y` \"q\" 50%";
  assert.equal(sh(`eval "v=$(sq "$P")"; printf '%s' "$v"`, { P: p }).out, p);
  assert.equal(sh(`cron_q "$P"`, { P: p }).out, `'/home/a b/it'\\''s $x \`y\` "q" 50\\%'`);
  assert.equal(sh(`desk_q "$P"`, { P: p }).out, `"/home/a b/it's \\\\$x \\\\\`y\\\\\` \\\\"q\\\\" 50%%"`);
});

test("console_runs_here：只读解析 ELF；本机已有的程序通过，缺库的不通过", () => {
  const d = join(dir, "console");
  mkdirSync(join(d, "lib"), { recursive: true });
  copyFileSync(process.execPath, join(d, "quetzal-console"));
  const ok = sh(`console_runs_here "$D"`, { D: d });
  assert.equal(ok.code, 0, ok.err);
  // 依赖一个不存在的库：把 lib_present 换成永远找不到
  const miss = sh(`lib_present() { return 1; }; console_runs_here "$D"`, { D: d });
  const tools = spawnSync("bash", ["-c", "command -v readelf || command -v objdump"]).status === 0;
  if (tools) assert.notEqual(miss.code, 0);
});
