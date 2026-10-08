// 快速接入：选一个供应商、粘贴一个 Key，其余全自动——存 Key、问供应商有哪些模型、从公共目录里挑最新的能调工具的、逐个试通、留下通的、排好顺序。
// 控制台「模型」页的默认入口用它；完整的管理（多个 Key、手选模型、排序、自定义供应商）仍走 saveProviders。
import crypto from "node:crypto";
import { getCatalog, type CatalogModel } from "./catalog.ts";
import { loadProviders, publicView, configVersion, saveProviders, keyProblem, ConfigError } from "./registry.ts";
import { testModel, remoteModels } from "./router.ts";
import type { Provider, ProviderModel } from "./types.ts";

/** 留下几个通的（第一个是主力，其余在它失败时接上）；最多试几个。 */
const KEEP = 2, TRIES = 6, TEST_TIMEOUT_MS = 30_000;
/** 目录标的状态：正式的在前，alpha / beta 其次，已弃用的最后（不按模型名猜「预览版」）。 */
const STATUS_RANK = (s?: string) => (s === "deprecated" ? 2 : s ? 1 : 0);

/**
 * 候选的先后：按目录标的状态；再按发布日期从新到旧；同一天的按输出价格从高到低（同代里更强的那个）。
 * 只选目录里写明能调工具、输出里有文字（能对话）的；目录没写输出模态的不排除。
 */
export function rankCandidates(models: CatalogModel[], remote: string[]): CatalogModel[] {
  const have = new Set(remote);
  const pool = models.filter((m) => m.toolCall && m.text !== false && (!remote.length || have.has(m.id)));
  return pool.sort((a, b) =>
    STATUS_RANK(a.status) - STATUS_RANK(b.status)
    || (b.released ?? "").localeCompare(a.released ?? "")
    || (b.cost?.output ?? 0) - (a.cost?.output ?? 0));
}

const withTimeout = <T>(p: Promise<T>, ms: number, fallback: T) => Promise.race([p, new Promise<T>((r) => setTimeout(() => r(fallback), ms).unref())]);

export interface QuickResult { ok: boolean; provider: string; models: string[]; message: string }

/**
 * 接入一个目录里的供应商：同一个（同 catalogId）已有就换上这把 Key，否则新建。
 * 试通的模型接在全局顺序最后；一个都不通时一切恢复原样（原来的 Key 与模型照常可用），返回失败原因。
 * o.test / o.remote 只给测试替换。
 */
export async function quickSetup(a: { catalogId: string; key: string }, actor: string, o: { test?: typeof testModel; remote?: typeof remoteModels } = {}): Promise<QuickResult> {
  const test = o.test ?? testModel, remote = o.remote ?? remoteModels;
  const key = String(a.key ?? "").trim();
  const why = keyProblem(key);
  if (why) throw new ConfigError("INVALID_KEY", `Key ${why}`);
  const entry = (await getCatalog()).providers.find((p) => p.id === a.catalogId);
  if (!entry || !entry.api) throw new ConfigError("INVALID", "没有这个供应商");

  // 1. 存 Key：新 Key 排在最前（试的是它），已有的 Key 先留着，试通了才换掉，一个都不通就撤回这把新 Key
  const draft = publicView();
  let p = draft.providers.find((x) => x.catalogId === entry.id) as Provider | undefined;
  if (!p) {
    p = { id: crypto.randomUUID(), catalogId: entry.id, name: entry.name, baseUrl: entry.api, protocol: entry.protocol, enabled: true, keys: [], models: [] };
    draft.providers.push(p);
  }
  const wasEnabled = p.enabled;
  const newKey = crypto.randomUUID();
  p.enabled = true;
  p.keys = [{ id: newKey, label: "key", lastFour: "", enabled: true, secret: key }, ...p.keys];
  saveProviders(draft, configVersion(), actor);
  const pid = p.id;
  const edit = (f: (q: Provider, d: ReturnType<typeof publicView>) => void) => { const d = publicView(); f(d.providers.find((x) => x.id === pid)!, d); saveProviders(d, configVersion(), actor); };

  // 2. 问供应商有哪些模型（问不到就按目录来），排出候选；已经配着的也算候选（只试，不重复加）
  const listed = await withTimeout(remote(pid).catch(() => [] as string[]), 20_000, [] as string[]);
  const cands = rankCandidates(entry.models, listed).slice(0, TRIES);

  // 3. 逐个试通（没配的先加上，不通再撤）；够 KEEP 个就停
  const order = () => Math.max(-1, ...loadProviders().providers.flatMap((x) => x.models.map((m) => m.sortOrder))) + 1;
  const kept: CatalogModel[] = [];
  let last = "";
  for (const m of cands) {
    if (kept.length >= KEEP) break;
    const existing = loadProviders().providers.find((x) => x.id === pid)!.models.some((x) => x.name === m.id);
    const id = crypto.randomUUID();
    if (!existing) edit((q) => q.models.push({ id, name: m.id, enabled: true, context: m.context || 16000, maxTokens: Math.min(m.output || 4096, 16384), sortOrder: order(), ...(m.cost ? { cost: m.cost } : {}) } satisfies ProviderModel));
    const r = await withTimeout(test(pid, m.id), TEST_TIMEOUT_MS, { ok: false, latencyMs: TEST_TIMEOUT_MS, message: "超时" });
    if (r.ok) { kept.push(m); continue; }
    last = r.message;
    if (!existing) edit((q) => { q.models = q.models.filter((x) => x.id !== id); });
    if (r.status === 401) break; // Key 不对（HTTP 401），换哪个模型都一样
  }

  if (!kept.length) { // 撤回：去掉这把新 Key，恢复原来的启用状态；新建的空供应商整个去掉
    const d = publicView(), q = d.providers.find((x) => x.id === pid)!;
    q.keys = q.keys.filter((k) => k.id !== newKey); q.enabled = wasEnabled;
    if (!q.keys.length && !q.models.length) d.providers = d.providers.filter((x) => x.id !== pid);
    saveProviders(d, configVersion(), actor);
    return { ok: false, provider: entry.name, models: [], message: last || (cands.length ? "没有试通的模型" : "这个供应商没有能调用工具的模型") };
  }
  edit((q) => { q.keys = q.keys.filter((k) => k.id === newKey); }); // 新 Key 通了：旧的不再需要
  const names = kept.map((m) => m.id);

  // 4. 内省用便宜的那个：比主力便宜才设
  if (kept.length > 1) {
    const [main, ...rest] = kept;
    const cheap = rest.filter((m) => (m.cost?.output ?? Infinity) < (main.cost?.output ?? Infinity)).sort((x, y) => (x.cost!.output) - (y.cost!.output))[0];
    if (cheap) edit((q, d) => { d.quickModelId = q.models.find((x) => x.name === cheap.id)?.id ?? d.quickModelId; });
  }
  return { ok: true, provider: entry.name, models: names, message: "" };
}
