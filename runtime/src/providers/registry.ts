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

/** API Key 的形状检查：HTTP 头只能放 Latin1，实际的 Key 都是可打印 ASCII 且没有空白。粘错成聊天内容、带了换行或引号时在这里就拦住，而不是等到请求时报一句看不懂的 ByteString 错误。返回错误说明，合法为空。 */
export function keyProblem(secret: string): string | undefined {
  const s = secret.trim();
  if (s.length < 8) return "太短，不像 API Key";
  if (/[^\x21-\x7e]/.test(s)) {
    const bad = s.match(/[^\x21-\x7e]/)![0];
    return bad === " " || bad === "\t" || bad === "\n" || bad === "\r" ? "含有空格或换行，不像 API Key——是不是多复制了什么？" : `含有非 ASCII 字符（如「${bad}」），不像 API Key——是不是把别的文字粘进来了？`;
  }
  if (/^(Bearer|sk-)?\s*$/i.test(s)) return "不像 API Key";
  return undefined;
}

export function saveProviders(draft: ProviderConfig, expected: string, actor = "console", o: { remote?: boolean } = {}): ProviderConfig {
  const current = loadProviders();
  if (expected !== configVersion(current)) throw new ConfigError("STALE_CONFIG", "配置已被其他地方修改，请刷新后重试（你的修改仍保留在页面上）");
  const ids = new Set<string>();
  const next: Provider[] = draft.providers.map((p) => {
    if (!p.name?.trim()) throw new ConfigError("INVALID", "供应商名称不能为空");
    if (!/^https?:\/\/[^\s?#@]+$/.test(p.baseUrl)) throw new ConfigError("INVALID", `${p.name}：API 地址无效`);
    if (!PROTOCOLS.includes(p.protocol)) throw new ConfigError("INVALID", `${p.name}：未知协议 ${p.protocol}`);
    const old = current.providers.find((o) => o.id === p.id);
    if (old && old.baseUrl !== p.baseUrl && old.keys.length && p.keys.some((k) => !k.secret))
      throw new ConfigError("KEYS_EXIST", `${p.name}：修改 API 地址前请先移除旧的 Key，避免旧凭据被发往新地址`);
    const names = new Set<string>();
    for (const x of [p.id, ...p.keys.map((k) => k.id), ...p.models.map((m) => m.id)]) {
      if (ids.has(x)) throw new ConfigError("INVALID", `ID 重复：${x}`); ids.add(x);
    }
    return {
      ...p, name: p.name.trim(),
      keys: p.keys.map((k) => {
        if (k.secret) {
          const why = keyProblem(k.secret);
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
  });
  // 全局顺序重新编号为 0..n-1，保持相对顺序
  next.flatMap((p) => p.models).sort((a, b) => a.sortOrder - b.sortOrder).forEach((m, i) => (m.sortOrder = i));
  cache = { providers: next, quickModelId: draft.quickModelId };
  fs.writeFileSync(file(), JSON.stringify(cache, null, 2), { mode: 0o600 });
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
export function importProviders(c: ProviderConfig, actor: string) {
  const current = loadProviders();
  // 旧地址上的 Key 会被替换（导入带着全部明文 Key），所以不受「改地址前先移除旧 Key」的限制：先清空再保存
  cache = { providers: current.providers.map((p) => ({ ...p, keys: [] })), quickModelId: current.quickModelId };
  return saveProviders(c, configVersion(cache), actor, { remote: true });
}

export function keySecret(p: Provider, keyId: string): string {
  const k = p.keys.find((x) => x.id === keyId);
  if (!k?.ciphertext) throw new ConfigError("KEY_REQUIRED", "没有可用的 Key");
  return decrypt(k.ciphertext, p.id);
}
