// 小工具：随机令牌、哈希、限流、日志。令牌只以 SHA-256 存库，库泄露也拿不到可用的令牌。
import crypto from "node:crypto";

export const now = () => Date.now();

/** 32 字节随机数的 base64url（256 位熵），用于会话、设备码、身体令牌。 */
export const randomToken = (prefix = "") => prefix + crypto.randomBytes(32).toString("base64url");

export const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

/** 设备码绑定时给人看的短码：去掉易混淆字母的 20 个辅音（与 GitHub 设备流程同一字母表），8 位约 34 位熵，配合限流与 15 分钟有效期。 */
const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";
export function userCode() {
  let s = "";
  for (let i = 0; i < 8; i++) s += USER_CODE_ALPHABET[crypto.randomInt(USER_CODE_ALPHABET.length)];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}
/** 规范化用户输入的短码：大写、去掉空白与连字符后重新分组；不合法返回 undefined。 */
export function normalizeUserCode(input: string) {
  const s = input.toUpperCase().replace(/[\s-]/g, "");
  if (s.length !== 8 || [...s].some((ch) => !USER_CODE_ALPHABET.includes(ch))) return undefined;
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

/** 节点公钥（ed25519，32 字节，base64url）的指纹：原始公钥字节的 SHA-256 前 16 个十六进制字符，4 个一组。身体在本机显示同样的指纹，给人核对。 */
export const fingerprint = (nodeKey: string) =>
  crypto.createHash("sha256").update(Buffer.from(nodeKey, "base64url")).digest("hex").slice(0, 16).replace(/(.{4})(?!$)/g, "$1 ");

/** 固定窗口限流：key → 窗口内次数。内存里，进程重启清零（只防滥用，不做计费）。 */
export class RateLimiter {
  private hits = new Map<string, { n: number; reset: number }>();
  private limit: number;
  private windowMs: number;
  constructor(limit: number, windowMs: number) { this.limit = limit; this.windowMs = windowMs; }
  take(key: string): boolean {
    const t = now();
    let h = this.hits.get(key);
    if (!h || h.reset <= t) { h = { n: 0, reset: t + this.windowMs }; this.hits.set(key, h); }
    h.n++;
    if (this.hits.size > 50_000) for (const [k, v] of this.hits) if (v.reset <= t) this.hits.delete(k);
    return h.n <= this.limit;
  }
}

/** 日志写到标准输出（docker 收集）。不记令牌、不记 IP 地址。 */
export const log = (scope: string, msg: string) => console.log(`${new Date().toISOString()} [${scope}] ${msg}`);
