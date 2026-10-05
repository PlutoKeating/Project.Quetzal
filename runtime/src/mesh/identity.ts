// 节点身份：每具身体一把 ed25519 节点密钥（QUETZAL_HOME/secrets/mesh_ed25519，0600），公钥登记在灵魂仓库 bodies/<身体>.json 的 meshKey（规范 v8）。
// 身体之间的信令由发送方签名；接收方只认灵魂仓库里登记的公钥（灵魂仓库是信任根，同步服务只是目录）。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface NodeKey { privateKey: crypto.KeyObject; publicKey: crypto.KeyObject; nodeKey: string }

/** 读取或生成节点密钥。nodeKey 为 32 字节原始公钥的 base64url（43 个字符）。 */
export function loadNodeKey(file: string): NodeKey {
  let privateKey: crypto.KeyObject;
  try {
    privateKey = crypto.createPrivateKey(fs.readFileSync(file, "utf8"));
  } catch {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    privateKey = crypto.generateKeyPairSync("ed25519").privateKey;
    fs.writeFileSync(file, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  }
  const publicKey = crypto.createPublicKey(privateKey);
  return { privateKey, publicKey, nodeKey: rawKey(publicKey) };
}

export const rawKey = (k: crypto.KeyObject) => (k.export({ format: "jwk" }) as { x: string }).x;
export const keyFromRaw = (nodeKey: string) => crypto.createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: nodeKey }, format: "jwk" });
export const isNodeKey = (s: unknown): s is string => typeof s === "string" && /^[A-Za-z0-9_-]{43}$/.test(s);

/** 指纹：原始公钥字节的 SHA-256 前 16 个十六进制字符，4 个一组（与同步服务网页上显示的一致，给人核对）。 */
export const fingerprint = (nodeKey: string) =>
  crypto.createHash("sha256").update(Buffer.from(nodeKey, "base64url")).digest("hex").slice(0, 16).replace(/(.{4})(?!$)/g, "$1 ");

/** 规范化 JSON：键按字典序，签名与验签用同一份字节。 */
export function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  return `{${Object.keys(v as object).filter((k) => (v as any)[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as any)[k])}`).join(",")}}`;
}

export const sign = (key: NodeKey, data: string) => crypto.sign(null, Buffer.from(data), key.privateKey).toString("base64url");
export function verify(nodeKey: string, data: string, sig: string): boolean {
  try { return crypto.verify(null, Buffer.from(data), keyFromRaw(nodeKey), Buffer.from(sig, "base64url")); } catch { return false; }
}

/** 签名的信令信封：谁发给谁、何时、一次性随机数、内容。 */
export interface Envelope { v: 1; from: string; to: string; ts: number; nonce: string; body: Record<string, unknown>; sig?: string }

export function seal(key: NodeKey, from: string, to: string, body: Record<string, unknown>, now = Date.now()): Envelope {
  const e: Envelope = { v: 1, from, to, ts: now, nonce: crypto.randomBytes(16).toString("base64url"), body };
  return { ...e, sig: sign(key, canonical(e)) };
}

const SKEW_MS = 5 * 60_000;
/** 验证信封：签名（用灵魂仓库里登记的公钥）、收件人、时间窗、随机数没见过。返回错误说明或 undefined。 */
export class Opener {
  private seen = new Map<string, number>();
  private me: string;
  private keyOf: (body: string) => string | undefined;
  constructor(me: string, keyOf: (body: string) => string | undefined) { this.me = me; this.keyOf = keyOf; }
  open(e: unknown, now = Date.now()): { ok: true; env: Envelope } | { ok: false; error: string; from?: string } {
    const x = e as Envelope;
    if (!x || x.v !== 1 || typeof x.from !== "string" || typeof x.to !== "string" || typeof x.ts !== "number" || typeof x.nonce !== "string" || typeof x.sig !== "string" || typeof x.body !== "object" || !x.body) return { ok: false, error: "信封格式不对" };
    if (x.to !== this.me) return { ok: false, error: "不是发给这具身体的", from: x.from };
    if (Math.abs(now - x.ts) > SKEW_MS) return { ok: false, error: "时间相差超过 5 分钟（重放或时钟不准）", from: x.from };
    const key = this.keyOf(x.from);
    if (!key) return { ok: false, error: `灵魂仓库里没有登记 ${x.from} 的节点公钥`, from: x.from };
    const { sig, ...rest } = x;
    if (!verify(key, canonical(rest), sig)) return { ok: false, error: "签名不对：与灵魂仓库登记的公钥不符", from: x.from };
    const id = `${x.from}/${x.nonce}`;
    if (this.seen.has(id)) return { ok: false, error: "重放的信令", from: x.from };
    this.seen.set(id, x.ts);
    if (this.seen.size > 5000) for (const [k, t] of this.seen) if (now - t > SKEW_MS) this.seen.delete(k);
    return { ok: true, env: x };
  }
}
