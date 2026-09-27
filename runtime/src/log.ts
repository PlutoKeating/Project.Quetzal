// 日志输出到 stdout，由 runit 的 svlogd 接管轮转。写入前统一脱敏。
const SENSITIVE = [
  /\b([0-9a-f]{2}[:-]){5}[0-9a-f]{2}\b/gi, // MAC
  /\b(?!127\.0\.0\.1\b)(?:\d{1,3}\.){3}\d{1,3}\b/g, // IPv4（回环地址除外）
  /\b(sk|key|token)-[A-Za-z0-9_-]{12,}\b/g, // 常见密钥前缀
];
export function redact(s: string) {
  return SENSITIVE.reduce((t, re) => t.replace(re, "‹redacted›"), s);
}
export const log = (scope: string, msg: string, extra?: unknown) =>
  console.log(`[${scope}] ${redact(msg)}${extra === undefined ? "" : " " + redact(JSON.stringify(extra))}`);
