// winget 清单生成（cli/windows/winget/make-manifests.mjs）：只信验过签名的 SHA256SUMS，模板变量全部填上。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
// @ts-expect-error 纯 JS 模块，没有类型声明
import { installerHashes, manifests, fill, TEMPLATES, RELEASE_PUBKEY } from "../windows/winget/make-manifests.mjs";

const h = (s: string) => createHash("sha256").update(s).digest("hex");
const sums = Buffer.from(`${h("x")}  quetzal-1.4.0-windows-x64-setup.exe\n${h("a")}  quetzal-1.4.0-windows-arm64-setup.exe\ncommit ${"c".repeat(40)} v1.4.0\n`);

test("哈希只取自签名正确、标签相符的清单", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pub = (publicKey.export({ format: "jwk" }) as { x: string }).x;
  const sig = sign(null, sums, privateKey).toString("base64");
  assert.deepEqual(installerHashes(sums, sig, "1.4.0", pub), { x64: h("x"), arm64: h("a") });
  assert.throws(() => installerHashes(sums, sig, "1.4.1", pub));
  assert.throws(() => installerHashes(sums, sig, "1.4.0", RELEASE_PUBKEY), /签名/);
  assert.throws(() => installerHashes(Buffer.concat([sums, Buffer.from("x")]), sig, "1.4.0", pub), /签名/);
});

test("四个清单都填好、没有残留的模板变量；预发布版本不生成", () => {
  const m = manifests("1.4.0", { x64: h("x"), arm64: h("a") }, "2026-10-07");
  assert.deepEqual(Object.keys(m), TEMPLATES);
  for (const text of Object.values(m) as string[]) { assert.doesNotMatch(text, /\{\{/); assert.match(text, /^PackageVersion: 1\.4\.0$/m); }
  const inst = m["PlutoKeating.Quetzal.installer.yaml"];
  assert.match(inst, new RegExp(`InstallerSha256: ${h("x").toUpperCase()}`));
  assert.match(inst, /InstallerUrl: https:\/\/github\.com\/PlutoKeating\/Project\.Quetzal\/releases\/download\/v1\.4\.0\/quetzal-1\.4\.0-windows-arm64-setup\.exe/);
  assert.match(inst, /^Scope: user$/m);
  assert.throws(() => manifests("1.4.0-rc.1", { x64: h("x"), arm64: h("a") }, "2026-10-07"));
  assert.throws(() => fill("{{NOPE}}", {}));
});
