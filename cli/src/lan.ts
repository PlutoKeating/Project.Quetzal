// 局域网访问：网关的明文 HTTP 只在本机回环（gateway.port），对局域网开放时另开 HTTPS / WSS（gateway.lanPort，自签名证书）。
//   规则与运行基座（runtime/src/gateway.ts）一致：gateway.lan 为真，或 gateway.host 不是回环地址（旧配置的 0.0.0.0），即为开放。
//   证书由运行基座第一次启动时生成在 secrets/gateway-tls.crt；这里只读它算指纹（SHA-256（DER）），给人在 App 与浏览器里核对。
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type Layout, readConfig } from "./layout.ts";

const LOOP = new Set(["127.0.0.1", "::1", "localhost"]);

export const lanEnabled = (l: Layout) => { const g = readConfig(l).gateway ?? {}; return g.lan === true || !LOOP.has(String(g.host || "127.0.0.1")); };
export const lanPort = (l: Layout) => Number(readConfig(l).gateway?.lanPort) || 7789;

/** 网关证书的指纹：{hex, short}（短格式为前 16 位、4 位一组）；运行基座还没生成证书时为 undefined。 */
export function certFingerprint(l: Layout): { hex: string; short: string } | undefined {
  try {
    const x = new crypto.X509Certificate(fs.readFileSync(path.join(l.home, "secrets", "gateway-tls.crt")));
    const hex = crypto.createHash("sha256").update(x.raw).digest("hex");
    return { hex, short: (hex.slice(0, 16).match(/.{4}/g) ?? []).join(" ") };
  } catch { return undefined; }
}

/** 这台机器在局域网上的地址（非回环的 IPv4，最多 4 个）拼成的 https 地址。 */
export function lanUrls(l: Layout, nets = os.networkInterfaces()): string[] {
  const port = lanPort(l);
  const host = String(readConfig(l).gateway?.host || "");
  const ips = LOOP.has(host) || !host || host === "0.0.0.0" || host === "::"
    ? Object.values(nets).flat().filter((a) => a && a.family === "IPv4" && !a.internal).map((a) => a!.address)
    : [host];
  return [...new Set(ips)].slice(0, 4).map((ip) => `https://${ip.includes(":") ? `[${ip}]` : ip}:${port}`);
}
