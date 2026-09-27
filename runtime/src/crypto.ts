// 供应商密钥的本地加密：AES-256-GCM，主密钥存于 secrets/master.key，provider id 作为附加认证数据（AAD），
// 密文只能在保存时所属的供应商下解密（与 GoGoGo 管理后台一致）。
import crypto from "node:crypto";
import { readSecret, writeSecret } from "./config.ts";

function master(): Buffer {
  let k = readSecret("master.key");
  if (!k) { k = crypto.randomBytes(32).toString("base64"); writeSecret("master.key", k); }
  return Buffer.from(k, "base64");
}

export function encrypt(plain: string, aad: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", master(), iv).setAAD(Buffer.from(aad));
  const body = Buffer.concat([c.update(plain, "utf8"), c.final(), c.getAuthTag()]);
  return `v1.${iv.toString("base64")}.${body.toString("base64")}`;
}

export function decrypt(blob: string, aad: string): string {
  const [, ivB, bodyB] = blob.split(".");
  const body = Buffer.from(bodyB, "base64");
  const d = crypto.createDecipheriv("aes-256-gcm", master(), Buffer.from(ivB, "base64")).setAAD(Buffer.from(aad));
  d.setAuthTag(body.subarray(body.length - 16));
  return Buffer.concat([d.update(body.subarray(0, body.length - 16)), d.final()]).toString("utf8");
}
