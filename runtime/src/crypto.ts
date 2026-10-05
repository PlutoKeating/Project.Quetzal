// 供应商密钥的本地加密：AES-256-GCM，主密钥存于 secrets/master.key，provider id 作为附加认证数据（AAD），
// 密文只能在保存时所属的供应商下解密（与 GoGoGo 管理后台一致）。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { paths, readSecret, writeSecret } from "./config.ts";

/** 主密钥：文件不存在才生成；存在却是空的或不是 32 字节的 base64，就报错而不是重新生成——重新生成会让所有已保存的 Key 再也解不开。 */
function master(): Buffer {
  const f = path.join(paths.secrets, "master.key");
  if (!fs.existsSync(f)) { const k = crypto.randomBytes(32).toString("base64"); writeSecret("master.key", k); return Buffer.from(k, "base64"); }
  const k = readSecret("master.key") ?? "";
  const buf = Buffer.from(k, "base64");
  if (buf.length !== 32 || !/^[A-Za-z0-9+/]+=*$/.test(k)) throw new Error("secrets/master.key 损坏（为空或不是 32 字节的 base64）：不会自动重新生成，否则已保存的模型 Key 都会失效。请从备份恢复，或删除它后在控制台重新填写各个 Key");
  return buf;
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
