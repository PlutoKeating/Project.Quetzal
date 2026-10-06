// OpenSSH 格式的 ed25519 密钥：ssh-keygen 认得出私钥，并能从它推出同一行公钥。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { generateSshEd25519, ensureSshKeyFile } from "../src/ssh-key.ts";

const hasKeygen = (() => { try { execFileSync("ssh-keygen", ["-?"], { stdio: "ignore" }); return true; } catch (e: any) { return e.status !== undefined && e.code !== "ENOENT"; } })();

test("公钥行的格式", () => {
  const k = generateSshEd25519("quetzal@test");
  assert.match(k.publicKey, /^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI[A-Za-z0-9+/]+=* quetzal@test$/);
  assert.match(k.privateKey, /^-----BEGIN OPENSSH PRIVATE KEY-----\n[\s\S]+\n-----END OPENSSH PRIVATE KEY-----\n$/);
});

test("ssh-keygen 能读这把私钥并推出同一个公钥", (t) => {
  if (!hasKeygen) return t.skip("没有 ssh-keygen");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "q-sshkey-"));
  const f = path.join(dir, "id");
  const pub = ensureSshKeyFile(f, "quetzal@test");
  const derived = execFileSync("ssh-keygen", ["-y", "-f", f], { encoding: "utf8" }).trim();
  assert.equal(derived.split(" ").slice(0, 2).join(" "), pub.split(" ").slice(0, 2).join(" "));
  assert.equal(ensureSshKeyFile(f, "别的注释"), pub, "已有私钥就不重新生成");
  fs.rmSync(dir, { recursive: true, force: true });
});
