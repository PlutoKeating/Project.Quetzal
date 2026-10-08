// 基座自己的密钥值：secrets/ 下的各个文件（令牌、主密钥、私钥、同步服务的令牌）与模型供应商的 Key（解密后）。
//   用途：工具输出与参数的脱敏（mind/secrets.ts 的 redactSecrets，与保密库的值一起）。
//   哪些是密钥只按结构认定，不按长度猜：
//   - PEM 块（私钥）：整段，以及正文的每一行（只输出其中几行也认得出）；
//   - JSON 文件（同步服务的绑定、账户令牌、身体接口）：只有凭据字段（token）是密钥，账户名、身体名、地址、端口是公开的；
//   - 其余文件（网关令牌、主密钥、飞书与语音的密钥）：整个文件的内容；
//   - 公钥（.pub）、证书（.crt）不是密钥；模型供应商的 Key 整个是密钥。
//   值只留在内存里；文件或供应商配置变了（按修改时间）就重新读取。
import fs from "node:fs";
import path from "node:path";
import { paths } from "./config.ts";
import { loadProviders, keySecret } from "./providers/registry.ts";

const MAX_FILE = 64 << 10;

let cache: { stamp: string; list: [value: string, name: string][] } | undefined;

function stamp(): string {
  const parts: string[] = [];
  const st = (f: string) => { try { const s = fs.statSync(f); return `${s.mtimeMs}:${s.size}`; } catch { return "-"; } };
  parts.push(st(paths.secrets), st(path.join(paths.config, "providers.json")));
  try { for (const f of fs.readdirSync(paths.secrets).sort()) parts.push(`${f}=${st(path.join(paths.secrets, f))}`); } catch { /* 没有目录 */ }
  return parts.join("|");
}

/** JSON 密钥文件里的凭据字段（sync.json、sync-account.json、body.json、desktop-body.json 都只有 token 是凭据）。 */
const CREDENTIAL_FIELDS = new Set(["token"]);

/** PEM 块（私钥等，-----BEGIN …----- 包着的 base64）：整段与正文的每一行。 */
export function pemValues(text: string): string[] | undefined {
  const t = text.trim();
  if (!/^-----BEGIN [A-Z0-9 ]+-----/.test(t)) return undefined;
  return [t, ...t.split("\n").map((x) => x.trim()).filter((l) => l && !l.startsWith("-----"))];
}

/** 一个密钥文件里要替换的值（按文件的结构，见文件头）。 */
export function valuesOf(text: string): string[] {
  const t = text.trim();
  if (!t) return [];
  const pem = pemValues(t);
  if (pem) return pem;
  if (t.startsWith("{")) {
    let j: unknown;
    try { j = JSON.parse(t); } catch { return [t]; } // 不是 JSON：整个内容
    const out: string[] = [];
    if (j && typeof j === "object" && !Array.isArray(j)) for (const [k, v] of Object.entries(j)) if (CREDENTIAL_FIELDS.has(k) && typeof v === "string" && v.trim()) out.push(v.trim());
    return out;
  }
  return [t];
}

/** 当前的全部密钥值（按长度从长到短，替换时先换长的）。 */
export function baseSecrets(): [value: string, name: string][] {
  const s = stamp();
  if (cache?.stamp === s) return cache.list;
  const list: [string, string][] = [];
  let files: string[] = [];
  try { files = fs.readdirSync(paths.secrets); } catch { /* 没有目录 */ }
  for (const f of files) {
    if (f.endsWith(".pub") || f.endsWith(".crt") || f.endsWith(".tmp")) continue; // 公钥与证书本来就是公开的
    const full = path.join(paths.secrets, f);
    try {
      const st = fs.statSync(full);
      if (!st.isFile() || st.size > MAX_FILE) continue;
      for (const v of valuesOf(fs.readFileSync(full, "utf8"))) list.push([v, f]);
    } catch { /* 读不了就跳过 */ }
  }
  try {
    for (const p of loadProviders().providers) for (const k of p.keys) {
      try { const v = keySecret(p, k.id).trim(); if (v) list.push([v, `provider:${p.id}`]); } catch { /* 没有密文或解不开 */ }
    }
  } catch { /* 没有供应商配置 */ }
  cache = { stamp: s, list: [...new Map(list.map((x) => [x[0], x])).values()].sort((a, b) => b[0].length - a[0].length) };
  return cache.list;
}
