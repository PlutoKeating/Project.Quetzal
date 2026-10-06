// 公共模型目录：来自 models.dev（与 GoGoGo 相同），缓存在 data/catalog.json。用于"添加供应商"时选择供应商与模型。
import fs from "node:fs";
import path from "node:path";
import { paths } from "../config.ts";
import type { Protocol } from "./types.ts";

export interface CatalogModel { id: string; name: string; context: number; output: number; toolCall: boolean; vision?: boolean; released?: string; cost?: { input: number; output: number } } // released：发布日期 YYYY-MM-DD（快速接入按它挑最新的）
export interface CatalogProvider { id: string; name: string; api: string; protocol: Protocol; models: CatalogModel[] }

const DEFAULT_BASE: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1",
  google: "https://generativelanguage.googleapis.com/v1beta",
};
const file = () => path.join(paths.data, "catalog.json");

function protocolOf(npm = ""): Protocol {
  if (npm.includes("anthropic")) return "anthropic-messages";
  if (npm === "@ai-sdk/google") return "google-generative-ai";
  if (npm === "@ai-sdk/openai") return "openai-responses";
  return "openai-completions";
}

/** 能否看图只看输入模态（attachment 表示能收文件，不代表能看图）；目录没有模态信息时才退而参考 attachment。 */
export const visionOf = (m: any): boolean => (Array.isArray(m.modalities?.input) ? m.modalities.input.includes("image") : !!m.attachment);

export async function refreshCatalog(): Promise<CatalogProvider[]> {
  const res = await fetch("https://models.dev/api.json", { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`models.dev HTTP ${res.status}`);
  const raw: Record<string, any> = await res.json();
  const list: CatalogProvider[] = Object.values(raw).map((p: any) => ({
    id: p.id, name: p.name ?? p.id, api: DEFAULT_BASE[p.id] ?? p.api ?? "", protocol: protocolOf(p.npm),
    models: Object.values(p.models ?? {}).map((m: any) => ({
      id: m.id, name: m.name ?? m.id, context: m.limit?.context ?? 0, output: m.limit?.output ?? 0, toolCall: !!m.tool_call,
      vision: visionOf(m),
      ...(typeof m.release_date === "string" ? { released: m.release_date } : {}),
      cost: m.cost ? { input: m.cost.input ?? 0, output: m.cost.output ?? 0 } : undefined,
    })),
  })).sort((a, b) => a.name.localeCompare(b.name));
  fs.writeFileSync(file(), JSON.stringify({ fetchedAt: Date.now(), providers: list }));
  return list;
}

let refreshing = false;
/** 缓存是旧格式（没有「能否看图」或发布日期）时，在后台刷新一次。 */
function refreshIfStale(c: { providers: CatalogProvider[] }) {
  if (refreshing || c.providers.some((p) => p.models.some((m) => typeof m.vision === "boolean" && typeof m.released === "string"))) return;
  refreshing = true;
  refreshCatalog().catch(() => {}).finally(() => { refreshing = false; });
}

/** 启动时检查：没有缓存或缓存是旧格式时，在后台刷新。 */
export function ensureCatalogFresh() {
  try { refreshIfStale(JSON.parse(fs.readFileSync(file(), "utf8"))); } catch { refreshIfStale({ providers: [] }); }
}

/** 公共目录里某个模型能否看图（同步读取缓存；目录没有该信息时返回 undefined）。 */
export function catalogVision(catalogId: string, model: string): boolean | undefined {
  try {
    const c: { providers: CatalogProvider[] } = JSON.parse(fs.readFileSync(file(), "utf8"));
    refreshIfStale(c);
    const name = model.replace(/^.*\//, "");
    const hit = c.providers.find((p) => p.id === catalogId)?.models.find((m) => m.id === model || m.id === name)
      ?? c.providers.flatMap((p) => p.models).find((m) => m.id === name && m.vision !== undefined);
    return hit?.vision;
  } catch { return undefined; }
}

export async function getCatalog(): Promise<{ fetchedAt: number; providers: CatalogProvider[] }> {
  try { return JSON.parse(fs.readFileSync(file(), "utf8")); } catch {
    const providers = await refreshCatalog();
    return { fetchedAt: Date.now(), providers };
  }
}
