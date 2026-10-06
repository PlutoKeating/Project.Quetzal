// install.ps1（irm https://quetzal.plutokeating.beer/install.ps1 | iex）：生成的文件与源文件一致、纯 ASCII；
// PowerShell 里自己实现的 Ed25519 验签用 RFC 8032 测试向量与仓库发版签名的格式（Node 生成的测试密钥对）核对；升级日志的首尾行能被运行基座解析。
// PowerShell 部分在有 powershell.exe（Windows，5.1）或 pwsh 时运行。
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error 纯 JS 模块（生成脚本），没有类型声明
import { generate, SRC, OUT } from "../windows/gen-install-ps1.mjs";
import { powershell } from "./windows/ps.ts";

const here = path.dirname(fileURLToPath(import.meta.url));

// RFC 8032 第 7.1 节 TEST 1–3
const RFC = [
  { name: "rfc8032 test 1", pub: "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a", msg: "",
    sig: "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b" },
  { name: "rfc8032 test 2", pub: "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c", msg: "72",
    sig: "92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00" },
  { name: "rfc8032 test 3", pub: "fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025", msg: "af82",
    sig: "6291d657deec24024827e69c3abe01a30ce548a284743a445e3680d7db5ac3ac18ff9b538d16f290ae67f760984dc6594a7c15e9716ed28dc027beceea1ec40a" },
];
const L = (1n << 252n) + 27742317777372353535851937790883648493n;
const rawPub = (hex: string) => createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(hex, "hex").toString("base64url") }, format: "jwk" });
const nodeVerify = (v: { pub: string; msg: string; sig: string }) => verify(null, Buffer.from(v.msg, "hex"), rawPub(v.pub), Buffer.from(v.sig, "hex"));

function vectors() {
  const out: { name: string; pub: string; msg: string; sig: string; ok: boolean }[] = RFC.map((v) => ({ ...v, ok: true }));
  const t1 = RFC[1];
  const flip = (hex: string, i: number) => { const b = Buffer.from(hex, "hex"); b[i] ^= 1; return b.toString("hex"); };
  out.push({ ...t1, name: "wrong message", msg: "73", ok: false });
  out.push({ ...t1, name: "flipped R", sig: flip(t1.sig, 0), ok: false });
  out.push({ ...t1, name: "flipped S", sig: flip(t1.sig, 40), ok: false });
  out.push({ ...t1, name: "other key", pub: RFC[0].pub, ok: false });
  // S + L：同一个点，但 S 不是规范形式，必须拒绝（RFC 8032 5.1.7）
  const s = Buffer.from(t1.sig.slice(64), "hex");
  let n = 0n; for (let i = 31; i >= 0; i--) n = (n << 8n) | BigInt(s[i]);
  n += L; const sl = Buffer.alloc(32); for (let i = 0; i < 32; i++) { sl[i] = Number(n & 0xffn); n >>= 8n; }
  out.push({ ...t1, name: "non-canonical S", sig: t1.sig.slice(0, 64) + sl.toString("hex"), ok: false });
  out.push({ ...t1, name: "short signature", sig: t1.sig.slice(0, 126), ok: false });
  // 测试密钥对签的一条长消息
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const msg = Buffer.from("quetzal ".repeat(300));
  const pub = Buffer.from((publicKey.export({ format: "jwk" }) as { x: string }).x, "base64url").toString("hex");
  out.push({ name: "node keypair long message", pub, msg: msg.toString("hex"), sig: sign(null, msg, privateKey).toString("hex"), ok: true });
  return out;
}

test("install.ps1 由 install.src.ps1 生成、与之一致，且只含 ASCII", () => {
  const text = generate(fs.readFileSync(SRC, "utf8"));
  assert.equal(fs.readFileSync(OUT, "utf8"), text, "运行 node cli/windows/gen-install-ps1.mjs 重新生成");
  assert.ok(!/[^\x00-\x7f]/.test(text));
  assert.match(text, /\r\nif \(\$env:QUETZAL_PS1_LIB -ne '1'\) \{ Install-Quetzal \}(\r\n)?$/, "最后一行才调用，下载中断不会跑半截");
  assert.match(text, /QbWLzC1yhOWroLTHtHiAAvVWq1UtWDiQP--D9wHaLU8/, "公钥与 install.sh、release.yml 一致");
  assert.equal(generate("$a = '中文'"), `$a = (Z '${Buffer.from("中文").toString("base64")}')`);
  assert.equal(generate("$a = 'it''s 中'"), `$a = (Z '${Buffer.from("it's 中").toString("base64")}')`);
  assert.throws(() => generate('$a = "中"'));
});

test("测试向量本身用 Node 核对过（防止抄错）", () => {
  for (const v of vectors()) {
    let ok = false;
    try { ok = nodeVerify(v); } catch { ok = false; }
    if (v.name === "non-canonical S") continue; // OpenSSL 同样拒绝，但个别版本抛错而不是返回 false：不在这里断言
    assert.equal(ok, v.ok, v.name);
  }
});

test("PowerShell：Ed25519 验签、发版清单、文案解码、升级日志", (t) => {
  const ps = powershell();
  if (!ps) { t.skip("没有 powershell / pwsh"); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "quetzal-ps1-"));
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pub = (publicKey.export({ format: "jwk" }) as { x: string }).x;
  const name = "quetzal-1.2.3-windows-x64-setup.exe";
  const hash = createHash("sha256").update("setup").digest("hex");
  const sums = `${"a".repeat(64)}  quetzal-1.2.3-android-arm64.apk\n${hash}  ${name}\ncommit ${"c".repeat(40)} v1.2.3\n`;
  const fixture = {
    vectors: vectors(),
    release: { sums: Buffer.from(sums).toString("base64"), sig: sign(null, Buffer.from(sums), privateKey).toString("base64") + "\n", name, tag: "v1.2.3", pub, hash },
  };
  const fx = path.join(dir, "fixture.json"), log = path.join(dir, "upgrade.log");
  fs.writeFileSync(fx, JSON.stringify(fixture));
  const r = spawnSync(ps, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(here, "windows", "install.tests.ps1"), fx, log], { encoding: "utf8", timeout: 600_000 });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  // 与运行基座 parseUpgradeLog 用的同一组正则
  const text = fs.readFileSync(log, "utf8");
  const starts = [...text.matchAll(/^== 升级 (\d+) 开始[^\n]*?(?:（目标 ([^）]+)）)?$/gm)];
  assert.deepEqual(starts.map((m) => [m[1], m[2]]), [["1700000000000", "1.4.0"], ["1700000000001", undefined]]);
  assert.match(text, /^== 升级 1700000000001 退出码 14$/m);
});
