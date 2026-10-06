// 小工具：随机令牌、哈希、限流、客户端地址、日志。令牌只以 SHA-256 存库，库泄露也拿不到可用的令牌。
import crypto from "node:crypto";
import net from "node:net";

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

/** 核对词：从设备码的哈希取 3 个表情（64 选 3，约 18 位）。身体在发给人的消息里给出，批准页显示同样的 3 个，人一眼比对：
 *  别人发来的钓鱼链接对不上自己的 agent 刚说的那 3 个。不是秘密，也不参与认证。 */
const CHECK_EMOJI = [..."🦊🐳🦉🐢🦋🐝🐙🦔🐧🦄🐌🦀🐬🦜🐞🦩🌙⭐🌈🔥🌊🍀🌵🌻🍄🌸🍎🍋🍇🍑🥝🍵☕🎈🎵🎲🧩🔑🔔📚🎨🧭⏰🚲⛵🚀🏔🌋🏝🎪🧸🪁🕯💎🧲🔭🪐🌍🍯🥐🧀🍩🍉🌰"];
export function checkWords(idHex: string): string {
  const b = Buffer.from(idHex.slice(0, 6), "hex");
  return [b[0] % 64, b[1] % 64, b[2] % 64].map((i) => CHECK_EMOJI[i]).join("");
}

/** 节点公钥（ed25519，32 字节，base64url）的指纹：原始公钥字节的 SHA-256 前 16 个十六进制字符，4 个一组。身体在本机显示同样的指纹，给人核对。 */
export const fingerprint = (nodeKey: string) =>
  crypto.createHash("sha256").update(Buffer.from(nodeKey, "base64url")).digest("hex").slice(0, 16).replace(/(.{4})(?!$)/g, "$1 ");

/** 固定窗口限流：key → 窗口内的计数（take 可带权重，例如按字节计）。内存里，进程重启清零（只防滥用，不做计费）。
 *  有硬上限：过期的条目每个窗口整体清理一次；条目满了就淘汰最早建立的，单次调用的开销是常数。 */
export class RateLimiter {
  private hits = new Map<string, { n: number; reset: number }>();
  private limit: number;
  private windowMs: number;
  private max: number;
  private nextSweep = 0;
  constructor(limit: number, windowMs: number, max = 50_000) { this.limit = limit; this.windowMs = windowMs; this.max = max; }
  private entry(key: string) {
    const t = now();
    if (t >= this.nextSweep) { for (const [k, v] of this.hits) if (v.reset <= t) this.hits.delete(k); this.nextSweep = t + this.windowMs; }
    let h = this.hits.get(key);
    if (!h || h.reset <= t) {
      if (h) this.hits.delete(key);
      while (this.hits.size >= this.max) this.hits.delete(this.hits.keys().next().value!);
      h = { n: 0, reset: t + this.windowMs };
      this.hits.set(key, h);
    }
    return h;
  }
  /** 计一次（或 cost 次）；返回是否仍在限额内。 */
  take(key: string, cost = 1): boolean { const h = this.entry(key); h.n += cost; return h.n <= this.limit; }
  /** 只看不计：是否已经用完限额。 */
  over(key: string): boolean { const h = this.hits.get(key); return !!h && h.reset > now() && h.n >= this.limit; }
  get size() { return this.hits.size; }
}

/** 限流用的地址键：IPv6 按 /64 聚合（一户人家或一台云主机通常就有一整段 /64，逐个地址计数等于不限），IPv4 映射地址还原成 IPv4。 */
export function ipKey(ip: string): string {
  const a = ip.replace(/%.*$/, "");
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(a);
  if (mapped) return mapped[1];
  if (!net.isIPv6(a)) return a;
  const [head, tail] = a.split("::");
  const groups = (s: string | undefined) => (s ? s.split(":").flatMap((g) => (g.includes(".") ? ["0", "0"] : [g])) : []);
  const h = groups(head), t = tail === undefined ? [] : groups(tail);
  const all = tail === undefined ? h : [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t];
  return all.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(":") + "::/64";
}

/** 客户端地址：只用于内存里的限流，不写库、不写日志。trustProxy 时：有 CF-Connecting-IP（Cloudflare 边缘设置，客户端伪造不了；
 *  Caddy 会删掉客户端带来的这个头）就用它，否则取 X-Forwarded-For 的最右一项（由最近的代理追加）。 */
export function clientIp(header: (name: string) => string | undefined, remote: string | undefined, trustProxy: boolean): string {
  if (trustProxy) {
    const cf = header("cf-connecting-ip")?.trim();
    if (cf && net.isIP(cf)) return cf;
    const xff = header("x-forwarded-for");
    if (xff) { const last = xff.split(",").pop()!.trim(); if (net.isIP(last)) return last; }
  }
  return remote ?? "?";
}

/** JSON 文本的最大嵌套深度（只数字符串之外的 [ 与 {）。在 JSON.parse 之前用它拒绝深层嵌套：解析、校验与再序列化都不会因此耗尽调用栈。 */
export function jsonDepth(text: string): number {
  let depth = 0, max = 0, inStr = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    if (inStr) { if (ch === 92) i++; else if (ch === 34) inStr = false; continue; } // \ 跳过下一个字符；" 结束字符串
    if (ch === 34) inStr = true;
    else if (ch === 123 || ch === 91) { if (++depth > max) max = depth; }
    else if (ch === 125 || ch === 93) depth--;
  }
  return max;
}

/** 日志写到标准输出（docker 收集）。不记令牌、不记 IP 地址。 */
export const log = (scope: string, msg: string) => console.log(`${new Date().toISOString()} [${scope}] ${msg}`);
