// 局域网访问的判定、地址与证书指纹（与运行基座的规则一致）。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { layout, patchConfig } from "../src/layout.ts";
import { lanEnabled, lanPort, lanUrls, certFingerprint } from "../src/lan.ts";
import { writeDefaults } from "../src/install.ts";

const fresh = () => layout(fs.mkdtempSync(path.join(os.tmpdir(), "quetzal-lan-")));
const nets = { lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }], eth0: [{ address: "192.168.1.8", family: "IPv4", internal: false }, { address: "fe80::1", family: "IPv6", internal: false }] } as any;

test("开放判定：缺省不开；旧配置的 host 0.0.0.0、或 lan 为真都算开；--lan / --no-lan 同时写 host 与 lan", () => {
  const l = fresh();
  assert.equal(lanEnabled(l), false);
  patchConfig(l, (c) => { c.gateway = { host: "0.0.0.0" }; });
  assert.equal(lanEnabled(l), true);
  patchConfig(l, (c) => { c.gateway = { host: "127.0.0.1", lan: true }; });
  assert.equal(lanEnabled(l), true);
  writeDefaults(l, false);
  assert.equal(lanEnabled(l), false);
  writeDefaults(l, true);
  assert.equal(lanEnabled(l), true);
  assert.equal(lanPort(l), 7789);
  assert.deepEqual(lanUrls(l, nets), ["https://192.168.1.8:7789"]);
  patchConfig(l, (c) => { c.gateway.host = "10.0.0.2"; c.gateway.lanPort = 9443; });
  assert.deepEqual(lanUrls(l, nets), ["https://10.0.0.2:9443"]);
});

test("证书指纹：SHA-256（DER），短格式前 16 位 4 位一组；没有证书时为 undefined", { skip: (() => { try { execFileSync("openssl", ["version"], { stdio: "ignore" }); return false; } catch { return "没有 openssl"; } })() }, () => {
  const l = fresh();
  assert.equal(certFingerprint(l), undefined);
  fs.mkdirSync(path.join(l.home, "secrets"), { recursive: true });
  const crt = path.join(l.home, "secrets", "gateway-tls.crt");
  execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", path.join(l.home, "secrets", "k"), "-out", crt, "-subj", "/CN=t", "-days", "1"], { stdio: "ignore" });
  const fp = certFingerprint(l)!;
  assert.equal(fp.hex, new crypto.X509Certificate(fs.readFileSync(crt)).fingerprint256.replace(/:/g, "").toLowerCase());
  assert.equal(fp.short, fp.hex.slice(0, 16).match(/.{4}/g)!.join(" "));
});
