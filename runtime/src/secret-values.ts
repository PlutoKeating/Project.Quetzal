// 基座自己的密钥值：secrets/ 下的各个文件（令牌、主密钥、私钥、同步服务的令牌）与模型供应商的 Key（解密后）。
//   用途：工具输出与参数的脱敏（mind/secrets.ts 的 redactSecrets，与保密库的值一起）、灵魂仓库提交前的检查（memory/soul-sync.ts）。
//   值只留在内存里；文件或供应商配置变了（按修改时间）就重新读取。只收 12 个字符以上的值，免得误伤无关的输出。
import fs from "node:fs";
import path from "node:path";
import { paths } from "./config.ts";
import { loadProviders, keySecret } from "./providers/registry.ts";

export const MIN_SECRET = 12;
const MAX_FILE = 64 << 10;

let cache: { stamp: string; list: [value: string, name: string][] } | undefined;

function stamp(): string {
  const parts: string[] = [];
  const st = (f: string) => { try { const s = fs.statSync(f); return `${s.mtimeMs}:${s.size}`; } catch { return "-"; } };
  parts.push(st(paths.secrets), st(path.join(paths.config, "providers.json")));
  try { for (const f of fs.readdirSync(paths.secrets).sort()) parts.push(`${f}=${st(path.join(paths.secrets, f))}`); } catch { /* 没有目录 */ }
  return parts.join("|");
}

/** 一个密钥文件里值得替换的片段：JSON 的字符串值、私钥的每一行正文、其余整段。 */
export function valuesOf(text: string): string[] {
  const t = text.trim();
  const out: string[] = [];
  if (t.startsWith("{")) {
    try {
      const walk = (v: unknown) => { if (typeof v === "string") out.push(v.trim()); else if (v && typeof v === "object") for (const x of Object.values(v)) walk(x); };
      walk(JSON.parse(t));
      return out.filter((v) => v.length >= MIN_SECRET && !/^https?:\/\//.test(v));
    } catch { /* 不是 JSON，按文本处理 */ }
  }
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(t)) {
    out.push(t);
    for (const l of t.split("\n").map((x) => x.trim())) if (l.length >= MIN_SECRET && !l.startsWith("-----")) out.push(l);
    return out;
  }
  return t.length >= MIN_SECRET ? [t] : [];
}

/** 当前的全部密钥值（按长度从长到短，替换时先换长的）。 */
export function baseSecrets(): [value: string, name: string][] {
  const s = stamp();
  if (cache?.stamp === s) return cache.list;
  const list: [string, string][] = [];
  let files: string[] = [];
  try { files = fs.readdirSync(paths.secrets); } catch { /* 没有目录 */ }
  for (const f of files) {
    if (f.endsWith(".pub") || f.endsWith(".tmp")) continue; // 公钥本来就是公开的
    const full = path.join(paths.secrets, f);
    try {
      const st = fs.statSync(full);
      if (!st.isFile() || st.size > MAX_FILE) continue;
      for (const v of valuesOf(fs.readFileSync(full, "utf8"))) list.push([v, f]);
    } catch { /* 读不了就跳过 */ }
  }
  try {
    for (const p of loadProviders().providers) for (const k of p.keys) {
      try { const v = keySecret(p, k.id).trim(); if (v.length >= MIN_SECRET) list.push([v, `provider:${p.id}`]); } catch { /* 没有密文或解不开 */ }
    }
  } catch { /* 没有供应商配置 */ }
  cache = { stamp: s, list: [...new Map(list.map((x) => [x[0], x])).values()].sort((a, b) => b[0].length - a[0].length) };
  return cache.list;
}
