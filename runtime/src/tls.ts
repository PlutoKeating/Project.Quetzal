// 网关的 TLS 证书：局域网监听（HTTPS / WSS）用的自签名证书，与配对证明（MITM 防护）。
//   第一次需要时生成 ECDSA P-256 密钥与自签名证书（CN=quetzal-<身体名>，10 年有效）：secrets/gateway-tls.key（0600）、secrets/gateway-tls.crt。
//   Node 没有生成 X.509 的接口：证书结构用 @peculiar/asn1-x509（@peculiar/x509 的 ASN.1 层；上层的 @peculiar/x509 依赖 tsyringe，
//   要求进程里装全局的 reflect-metadata 补丁，所以不用），签名用 node:crypto。
//   客户端不靠 CA，而是钉住证书指纹：SHA-256（证书 DER）的小写十六进制；短格式（前 16 位，4 位一组）给人在通知与浏览器警告页上比对。
//   配对证明：proof = hex(PBKDF2-HMAC-SHA256(配对码, "quetzal-pair-v2|" + 指纹, 100000 次, 32 字节))，把配对码与客户端看到的证书绑在一起，
//   中间人看到的是自己的证书，算出来的证明对不上；配对码本身不上网络。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { AsnConvert, OctetString } from "@peculiar/asn1-schema";
import {
  AlgorithmIdentifier, AttributeTypeAndValue, AttributeValue, BasicConstraints, Certificate, ExtendedKeyUsage, Extension, Extensions,
  Name, RelativeDistinguishedName, SubjectPublicKeyInfo, TBSCertificate, Validity, Version, id_ce_basicConstraints, id_ce_extKeyUsage, id_kp_serverAuth,
} from "@peculiar/asn1-x509";
import { paths, readSecret, writeSecret } from "./config.ts";
import { log } from "./log.ts";

export const TLS_KEY = "gateway-tls.key", TLS_CERT = "gateway-tls.crt";
const ECDSA_SHA256 = "1.2.840.10045.4.3.2", CN = "2.5.4.3";
const YEARS = 10;
export const PAIR_SALT = "quetzal-pair-v2|", PAIR_ITER = 100_000, PAIR_LEN = 32;

export interface GatewayTls { key: string; cert: string; fingerprint: string; short: string }

/** 证书指纹：SHA-256（DER）的小写十六进制。 */
export const fingerprintOf = (der: Buffer | Uint8Array) => crypto.createHash("sha256").update(der).digest("hex");
/** 短格式：前 16 位十六进制，4 位一组（「1a2b 3c4d 5e6f 7a8b」）。 */
export const shortFingerprint = (fp: string) => (fp.slice(0, 16).match(/.{4}/g) ?? []).join(" ");

/** 生成自签名证书（PEM）。 */
export function generateCert(commonName: string, now = new Date()): { key: string; cert: string } {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const sigAlg = new AlgorithmIdentifier({ algorithm: ECDSA_SHA256 }); // ecdsa-with-SHA256：参数缺省
  const serial = crypto.randomBytes(16); serial[0] &= 0x7f; serial[0] |= 0x40; // 正整数、无前导零
  const name = new Name([new RelativeDistinguishedName([new AttributeTypeAndValue({ type: CN, value: new AttributeValue({ utf8String: commonName }) })])]);
  const notAfter = new Date(now); notAfter.setUTCFullYear(notAfter.getUTCFullYear() + YEARS);
  const notBefore = new Date(now.getTime() - 3600_000); // 往前留一小时，容忍客户端时钟偏差
  const tbs = new TBSCertificate({
    version: Version.v3,
    serialNumber: new Uint8Array(serial).buffer,
    signature: sigAlg,
    issuer: name,
    subject: name,
    validity: new Validity({ notBefore, notAfter }),
    subjectPublicKeyInfo: AsnConvert.parse(publicKey.export({ type: "spki", format: "der" }), SubjectPublicKeyInfo),
    extensions: new Extensions([
      new Extension({ extnID: id_ce_basicConstraints, critical: true, extnValue: new OctetString(AsnConvert.serialize(new BasicConstraints({ cA: false }))) }),
      new Extension({ extnID: id_ce_extKeyUsage, critical: false, extnValue: new OctetString(AsnConvert.serialize(new ExtendedKeyUsage([id_kp_serverAuth]))) }),
    ]),
  });
  const tbsDer = Buffer.from(AsnConvert.serialize(tbs));
  const sig = crypto.sign("sha256", tbsDer, { key: privateKey, dsaEncoding: "der" });
  const der = Buffer.from(AsnConvert.serialize(new Certificate({ tbsCertificate: tbs, signatureAlgorithm: sigAlg, signatureValue: new Uint8Array(sig).buffer })));
  const cert = `-----BEGIN CERTIFICATE-----\n${der.toString("base64").match(/.{1,64}/g)!.join("\n")}\n-----END CERTIFICATE-----\n`;
  return { key: privateKey.export({ type: "pkcs8", format: "pem" }) as string, cert };
}

/** 读出并检查已有的证书：能解析、私钥与证书配对、自签名验证通过、没过期。不合格返回 undefined。 */
function loadExisting(): GatewayTls | undefined {
  const key = readSecret(TLS_KEY), cert = readSecret(TLS_CERT);
  if (!key || !cert) return undefined;
  try {
    const x = new crypto.X509Certificate(cert);
    const k = crypto.createPrivateKey(key);
    if (!x.checkPrivateKey(k) || !x.verify(x.publicKey) || Date.parse(x.validTo) < Date.now()) return undefined;
    const fp = fingerprintOf(x.raw);
    return { key, cert, fingerprint: fp, short: shortFingerprint(fp) };
  } catch { return undefined; }
}

let cached: GatewayTls | undefined;

/** 网关的证书：已有就用，没有（或损坏、过期）就生成并保存。换了证书，钉住旧指纹的控制台需要重新配对。 */
export function gatewayTls(body: string): GatewayTls {
  if (cached) return cached;
  let t = loadExisting();
  if (!t) {
    const had = fs.existsSync(path.join(paths.secrets, TLS_CERT));
    const { key, cert } = generateCert(`quetzal-${body}`.slice(0, 64));
    writeSecret(TLS_KEY, key);
    writeSecret(TLS_CERT, cert);
    t = loadExisting();
    if (!t) throw new Error("网关证书生成后校验失败");
    log("gateway", `${had ? "原有的网关证书无效，已重新生成（已配对的控制台需要重新配对）" : "已生成网关证书"}，指纹 ${t.short}`);
  }
  cached = t;
  return t;
}

/** 只读：已有的有效证书的指纹（不生成；命令行等外部读取用同一套规则时参考）。 */
export function existingFingerprint(): string | undefined { return loadExisting()?.fingerprint; }

/** 配对证明：hex(PBKDF2-HMAC-SHA256(规范化的配对码, "quetzal-pair-v2|" + 指纹, 100000, 32))。 */
export function pairProof(code: string, fingerprint: string): string {
  return crypto.pbkdf2Sync(Buffer.from(code, "utf8"), Buffer.from(PAIR_SALT + fingerprint.toLowerCase(), "utf8"), PAIR_ITER, PAIR_LEN, "sha256").toString("hex");
}

/** 测试用：清掉缓存。 */
export function resetTlsCache() { cached = undefined; }
