// OpenSSH 格式的 ed25519 密钥对，用 Node 内置的 crypto 生成，不依赖 ssh-keygen（Windows 上它是可选组件，不一定装了）。
//   私钥是 openssh-key-v1 格式、不加密（与 ssh-keygen -N "" 相同），公钥是 authorized_keys 那一行。格式见 OpenSSH 的 PROTOCOL.key。
import crypto from "node:crypto";
import fs from "node:fs";

const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };
const str = (b: Buffer | string) => { const v = Buffer.isBuffer(b) ? b : Buffer.from(b); return Buffer.concat([u32(v.length), v]); };

/** 生成一对 ed25519 密钥：返回 OpenSSH 私钥文本与公钥行。 */
export function generateSshEd25519(comment: string): { privateKey: string; publicKey: string } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const pub = Buffer.from(publicKey.export({ format: "jwk" }).x!, "base64url");
  const seed = Buffer.from(privateKey.export({ format: "jwk" }).d!, "base64url");
  const blob = Buffer.concat([str("ssh-ed25519"), str(pub)]);
  const check = crypto.randomBytes(4).readUInt32BE();
  let priv = Buffer.concat([u32(check), u32(check), str("ssh-ed25519"), str(pub), str(Buffer.concat([seed, pub])), str(comment)]);
  const pad = (8 - (priv.length % 8)) % 8;
  priv = Buffer.concat([priv, Buffer.from(Array.from({ length: pad }, (_, i) => i + 1))]);
  const body = Buffer.concat([Buffer.from("openssh-key-v1\0"), str("none"), str("none"), str(""), u32(1), str(blob), str(priv)]).toString("base64");
  const pem = `-----BEGIN OPENSSH PRIVATE KEY-----\n${body.match(/.{1,70}/g)!.join("\n")}\n-----END OPENSSH PRIVATE KEY-----\n`;
  return { privateKey: pem, publicKey: `ssh-ed25519 ${blob.toString("base64")} ${comment}` };
}

/** 写一对密钥文件（私钥 0600，Windows 上靠所在目录的 ACL；公钥 <私钥>.pub）。已有私钥就不动。返回公钥行。 */
export function ensureSshKeyFile(file: string, comment: string): string {
  if (!fs.existsSync(file)) {
    const k = generateSshEd25519(comment);
    fs.writeFileSync(file, k.privateKey, { mode: 0o600, flag: "wx" });
    fs.writeFileSync(`${file}.pub`, k.publicKey + "\n", { mode: 0o644 });
  }
  return fs.readFileSync(`${file}.pub`, "utf8").trim();
}
