// 供应商配置的存取：整体草稿保存 + 版本号防并发覆盖（参考 GoGoGo 管理后台的 PUT /provider-config 语义）。
// 存储：config/providers.json；密钥加密后只保留密文与末四位，明文永不返回给前端。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { paths, markShared } from "../config.ts";
import { encrypt, decrypt } from "../crypto.ts";
import { audit } from "../store.ts";
import { PROTOCOLS, type Provider, type ProviderConfig } from "./types.ts";

const file = () => path.join(paths.config, "providers.json");
let cache: ProviderConfig | undefined;

export function loadProviders(): ProviderConfig {
  if (!cache) { try { cache = JSON.parse(fs.readFileSync(file(), "utf8")); } catch { cache = { providers: [] }; } }
  return cache!;
}

/** 版本号：对整个配置（去掉密文）做规范化 JSON 的 sha256。前端保存时带上加载时的版本号。 */
export function configVersion(c = loadProviders()): string {
  const canon = JSON.stringify(publicView(c));
  return crypto.createHash("sha256").update(canon).digest("hex");
}

/** 对外视图：去掉密文。 */
export function publicView(c = loadProviders()): ProviderConfig {
  return {
    quickModelId: c.quickModelId,
    providers: [...c.providers].sort((a, b) => a.id.localeCompare(b.id)).map((p) => ({
      ...p, keys: p.keys.map(({ ciphertext, secret, ...k }) => k),
      models: [...p.models].sort((a, b) => a.id.localeCompare(b.id)),
    })),
  };
}

export class ConfigError extends Error { code: string; constructor(code: string, message: string) { super(message); this.code = code; } }

/** API Key 的形状检查（只查确定的事：HTTP 头只能放可打印 ASCII、不能有空白；不按长短猜像不像 Key）。粘错成聊天内容、带了换行或引号时在这里就拦住，而不是等到请求时报一句看不懂的 ByteString 错误。返回错误说明，合法为空。 */
export function keyProblem(secret: string): string | undefined {
  const s = secret.trim();
  if (!s) return "是空的";
  if (/[^\x21-\x7e]/.test(s)) {
    const bad = s.match(/[^\x21-\x7e]/)![0];
    return bad === " " || bad === "\t" || bad === "\n" || bad === "\r" ? "含有空格或换行，不像 API Key——是不是多复制了什么？" : `含有非 ASCII 字符（如「${bad}」），不像 API Key——是不是把别的文字粘进来了？`;
  }
  return undefined;
}

/**
 * 校验并整理一个供应商（新 Key 加密）。不改动任何状态：保存与导入都先在局部副本上整理完、全部合格后才替换缓存。
 * old：本机同 id 的供应商（没写密钥的 Key 从它那里沿用）；导入时为 undefined（每把 Key 都必须带着密钥）。
 */
function buildProvider(p: Provider, old: Provider | undefined, ids: Set<string>, rekey: boolean): Provider {
  if (!p || typeof p !== "object" || !Array.isArray(p.keys) || !Array.isArray(p.models)) throw new ConfigError("INVALID", "供应商格式不对");
  if (typeof p.name !== "string" || !p.name.trim()) throw new ConfigError("INVALID", "供应商名称不能为空");
  if (typeof p.baseUrl !== "string" || !/^https?:\/\/[^\s?#@]+$/.test(p.baseUrl)) throw new ConfigError("INVALID", `${p.name}：API 地址无效`);
  if (!PROTOCOLS.includes(p.protocol)) throw new ConfigError("INVALID", `${p.name}：未知协议 ${p.protocol}`);
  if (!rekey && old && old.baseUrl !== p.baseUrl && old.keys.length && p.keys.some((k) => !k.secret))
    throw new ConfigError("KEYS_EXIST", `${p.name}：修改 API 地址前请先移除旧的 Key，避免旧凭据被发往新地址`);
  const names = new Set<string>();
  for (const x of [p.id, ...p.keys.map((k) => k.id), ...p.models.map((m) => m.id)]) {
    if (typeof x !== "string" || !x) throw new ConfigError("INVALID", `${p.name}：ID 不能为空`);
    if (ids.has(x)) throw new ConfigError("INVALID", `ID 重复：${x}`); ids.add(x);
  }
  return {
    ...p, name: p.name.trim(),
    keys: p.keys.map((k) => {
      if (k.secret) {
        const why = typeof k.secret === "string" ? keyProblem(k.secret) : "不是文字";
        if (why) throw new ConfigError("INVALID_KEY", `${p.name}：Key「${k.label}」${why}`);
        const secret = k.secret.trim();
        return { id: k.id, label: k.label, enabled: k.enabled, lastFour: secret.slice(-4), ciphertext: encrypt(secret, p.id) };
      }
      const ok = old?.keys.find((o) => o.id === k.id);
      if (!ok) throw new ConfigError("INVALID_KEY", `${p.name}：新 Key 必须填写密钥`);
      return { ...ok, label: k.label, enabled: k.enabled };
    }),
    models: p.models.map((m) => {
      if (names.has(m.name)) throw new ConfigError("INVALID", `${p.name}：模型重复 ${m.name}`); names.add(m.name);
      return { ...m, context: Math.max(1000, m.context || 16000), maxTokens: Math.max(256, m.maxTokens || 4096) };
    }),
  };
}

/** 全局顺序重新编号为 0..n-1，保持相对顺序；替换缓存并写盘。 */
function commit(next: Provider[], quickModelId: string | undefined) {
  next.flatMap((p) => p.models).sort((a, b) => a.sortOrder - b.sortOrder).forEach((m, i) => (m.sortOrder = i));
  const c: ProviderConfig = { providers: next, quickModelId };
  fs.writeFileSync(file(), JSON.stringify(c, null, 2), { mode: 0o600 });
  cache = c;
}

export function saveProviders(draft: ProviderConfig, expected: string, actor = "console", o: { remote?: boolean } = {}): ProviderConfig {
  const current = loadProviders();
  if (expected !== configVersion(current)) throw new ConfigError("STALE_CONFIG", "配置已被其他地方修改，请刷新后重试（你的修改仍保留在页面上）");
  const ids = new Set<string>();
  const next: Provider[] = draft.providers.map((p) => buildProvider(p, current.providers.find((x) => x.id === p.id), ids, false));
  commit(next, draft.quickModelId);
  audit(actor, "providers.save", "", { providers: next.length }, "ok");
  if (!o.remote) markShared(["providers"]);
  return publicView();
}

/**
 * 导出完整的供应商配置（Key 为明文）：只用于多具身体之间同步，经网状层端到端加密的通道传给灵魂仓库登记过的身体，不写日志、不给前端。
 * 接收方用导入（importProviders）以自己的主密钥重新加密保存。
 */
export function exportProviders(): ProviderConfig {
  const c = loadProviders();
  return { quickModelId: c.quickModelId, providers: c.providers.map((p) => ({ ...p, keys: p.keys.map(({ ciphertext, ...k }) => ({ ...k, secret: ciphertext ? decrypt(ciphertext, p.id) : undefined })) })) };
}

/** 从另一具身体来的 API 地址只接受 HTTPS（本机回环地址除外）：Key 不能被一处配置发往明文地址。 */
export function remoteUrlOk(baseUrl: unknown): boolean {
  if (typeof baseUrl !== "string") return false;
  try {
    const u = new URL(baseUrl);
    return u.protocol === "https:" || (u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname));
  } catch { return false; }
}

/**
 * 导入另一具身体的完整配置（带明文 Key，见 exportProviders）：逐个供应商校验，不合格的（地址不是 HTTPS、Key 不合格、格式不对）
 * 保留本机原来的那个（没有就不要）；全部整理完才替换。导入带着全部明文 Key，所以不受「改地址前先移除旧 Key」的限制。
 * 返回被拒的供应商名（不含任何密钥）。
 */
export function importProviders(c: ProviderConfig, actor: string): { rejected: string[] } {
  if (!c || typeof c !== "object" || !Array.isArray(c.providers)) throw new ConfigError("INVALID", "供应商配置格式不对");
  const current = loadProviders();
  const ids = new Set<string>(), rejected: string[] = [], next: Provider[] = [];
  for (const p of c.providers.slice(0, 200)) {
    const name = (typeof (p as Provider)?.name === "string" ? (p as Provider).name : typeof (p as Provider)?.id === "string" ? (p as Provider).id : "?").slice(0, 60);
    const local = current.providers.find((x) => x.id === (p as Provider)?.id);
    const trial = new Set(ids);
    try {
      if (!remoteUrlOk((p as Provider)?.baseUrl)) throw new ConfigError("INVALID", "API 地址不是 HTTPS");
      next.push(buildProvider(p, undefined, trial, true));
      for (const x of trial) ids.add(x);
    } catch (e) {
      rejected.push(`${name}（${(e as ConfigError).code ?? "INVALID"}）`);
      if (local && ![local.id, ...local.keys.map((k) => k.id), ...local.models.map((m) => m.id)].some((x) => ids.has(x))) {
        next.push(local);
        for (const x of [local.id, ...local.keys.map((k) => k.id), ...local.models.map((m) => m.id)]) ids.add(x);
      }
    }
  }
  const models = new Set(next.flatMap((p) => p.models.map((m) => m.id)));
  commit(next, typeof c.quickModelId === "string" && models.has(c.quickModelId) ? c.quickModelId : current.quickModelId && models.has(current.quickModelId) ? current.quickModelId : undefined);
  audit(actor, "providers.import", "", { providers: next.length, rejected }, "ok");
  return { rejected };
}

export function keySecret(p: Provider, keyId: string): string {
  const k = p.keys.find((x) => x.id === keyId);
  if (!k?.ciphertext) throw new ConfigError("KEY_REQUIRED", "没有可用的 Key");
  return decrypt(k.ciphertext, p.id);
}
