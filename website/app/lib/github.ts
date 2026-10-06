/**
 * GitHub Releases 客户端：下载页的唯一数据来源。
 * 不硬编码任何版本号或下载链接；匿名调用公开 API（每 IP 每小时 60 次），结果缓存在 sessionStorage 10 分钟。
 */

export const GITHUB_OWNER = "PlutoKeating";
export const GITHUB_REPO_NAME = "Project.Quetzal";
export const RELEASES_API = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO_NAME}/releases?per_page=30`;
/** 官网自己的镜像源（worker/index.ts）：同源，预渲染页面在浏览器里请求；开发服务器没有它，会退回 GitHub。 */
export const SITE_RELEASES_API = "/api/releases";

const CACHE_KEY = "quetzal.releases";
const CACHE_TTL_MS = 10 * 60 * 1000;

export type AssetKind = "apk" | "runtime" | "checksums" | "other";

export interface ReleaseAsset {
  name: string;
  size: number;
  downloadCount: number;
  url: string;
  kind: AssetKind;
}

export interface Release {
  tag: string;
  /** 去掉前导 v 的版本号 */
  version: string;
  name: string;
  body: string;
  publishedAt: string;
  prerelease: boolean;
  url: string;
  assets: ReleaseAsset[];
}

export type FetchError =
  | { kind: "rate-limit"; resetAt: Date | null }
  | { kind: "network" }
  | { kind: "http"; status: number };

export class ReleasesError extends Error {
  readonly detail: FetchError;
  constructor(detail: FetchError) {
    super(detail.kind === "http" ? `GitHub API ${detail.status}` : detail.kind);
    this.detail = detail;
  }
}

/** 资产命名约定见 .github/workflows/release.yml。 */
export function classifyAsset(name: string): AssetKind {
  const n = name.toLowerCase();
  if (n === "sha256sums" || n.endsWith(".sha256") || n.endsWith("sha256sums.txt")) return "checksums";
  if (n.startsWith("quetzal-runtime-") && (n.endsWith(".tar.gz") || n.endsWith(".tgz"))) return "runtime";
  if (n.endsWith(".apk")) return "apk";
  return "other";
}

export function formatBytes(bytes: number, lang: "zh" | "en" = "en"): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  const digits = i === 0 ? 0 : v >= 100 ? 0 : 1;
  return `${new Intl.NumberFormat(lang === "zh" ? "zh-CN" : "en", { maximumFractionDigits: digits }).format(v)} ${units[i]}`;
}

export function versionOf(tag: string): string {
  return tag.replace(/^v/i, "");
}

interface RawAsset { name: string; size: number; download_count: number; browser_download_url: string }
interface RawRelease {
  tag_name: string;
  name: string | null;
  body: string | null;
  published_at: string | null;
  created_at: string;
  prerelease: boolean;
  draft: boolean;
  html_url: string;
  assets: RawAsset[];
}

/** 把 API 原始数据整理为页面模型：过滤草稿与非版本标签的发布，按发布时间倒序。纯函数。 */
export function normalizeReleases(raw: unknown): Release[] {
  if (!Array.isArray(raw)) return [];
  return (raw as RawRelease[])
    // 只要正式的版本标签 v<版本>：android-runtime-<配方哈希> 之类的预发布只供发版流程取用，不给人下载
    .filter((r) => r && !r.draft && typeof r.tag_name === "string" && /^v\d/.test(r.tag_name))
    .map((r) => ({
      tag: r.tag_name,
      version: versionOf(r.tag_name),
      name: r.name?.trim() || r.tag_name,
      body: r.body ?? "",
      publishedAt: r.published_at ?? r.created_at,
      prerelease: Boolean(r.prerelease),
      url: r.html_url,
      assets: (r.assets ?? []).map((a) => ({
        name: a.name,
        size: a.size,
        downloadCount: a.download_count ?? 0,
        url: a.browser_download_url,
        kind: classifyAsset(a.name),
      })),
    }))
    .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
}

/** 最新稳定版：第一个非预览版；没有稳定版时退回最新的预览版。 */
export function pickLatest(releases: Release[]): Release | null {
  return releases.find((r) => !r.prerelease) ?? releases[0] ?? null;
}

export function findAsset(release: Release, kind: AssetKind): ReleaseAsset | undefined {
  return release.assets.find((a) => a.kind === kind);
}

interface CacheEntry { at: number; data: Release[] }

function readCache(): Release[] | null {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const entry = JSON.parse(raw) as CacheEntry;
    if (!entry || Date.now() - entry.at > CACHE_TTL_MS) return null;
    return entry.data;
  } catch {
    return null;
  }
}

function writeCache(data: Release[]): void {
  try {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), data } satisfies CacheEntry));
  } catch {
    /* 存储不可用时忽略 */
  }
}

export async function fetchReleases(options: { force?: boolean } = {}): Promise<Release[]> {
  if (!options.force) {
    const cached = readCache();
    if (cached) return cached;
  }
  // 先走官网自己的镜像源（/api/releases：Cloudflare 边缘缓存，资产地址已改写为 /dl/ 镜像，GitHub 连不上的网络也能用），不行再直连 GitHub
  // 镜像源的 403 / 429 是它自己对 GitHub 的额度用完了（Cloudflare 出口 IP 共享），与访客无关：照样退回直连，访客自己的额度另算
  let res: Response;
  try {
    res = await fetch(SITE_RELEASES_API, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`site ${res.status}`);
  } catch {
    try {
      res = await fetch(RELEASES_API, { headers: { Accept: "application/vnd.github+json" } });
    } catch {
      throw new ReleasesError({ kind: "network" });
    }
  }
  if (res.status === 403 || res.status === 429) {
    const reset = res.headers.get("x-ratelimit-reset");
    const remaining = res.headers.get("x-ratelimit-remaining");
    if (remaining === "0" || res.status === 429) {
      throw new ReleasesError({ kind: "rate-limit", resetAt: reset ? new Date(Number(reset) * 1000) : null });
    }
    throw new ReleasesError({ kind: "http", status: res.status });
  }
  if (!res.ok) throw new ReleasesError({ kind: "http", status: res.status });
  const data = normalizeReleases(await res.json());
  writeCache(data);
  return data;
}

/* ---------- 仓库概况（首页凭证小字用） ---------- */

export type RepoStats = { stars: number; latestTag: string | null };
const STATS_KEY = "quetzal.repo-stats";

/** 星标数与最新版本号：GitHub 公开 API，sessionStorage 缓存 10 分钟；失败返回 null（页面静默降级）。 */
export async function fetchRepoStats(): Promise<RepoStats | null> {
  try {
    const raw = sessionStorage.getItem(STATS_KEY);
    if (raw) { const c = JSON.parse(raw) as { at: number; stats: RepoStats }; if (Date.now() - c.at < CACHE_TTL_MS) return c.stats; }
  } catch { /* ignore */ }
  try {
    const headers = { Accept: "application/vnd.github+json" };
    const [repo, rel] = await Promise.all([
      fetch(`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO_NAME}`, { headers }),
      fetch(`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO_NAME}/releases/latest`, { headers }),
    ]);
    if (!repo.ok) return null;
    const r = (await repo.json()) as { stargazers_count?: number };
    const latest = rel.ok ? ((await rel.json()) as { tag_name?: string }).tag_name ?? null : null;
    const stats = { stars: r.stargazers_count ?? 0, latestTag: latest };
    try { sessionStorage.setItem(STATS_KEY, JSON.stringify({ at: Date.now(), stats })); } catch { /* ignore */ }
    return stats;
  } catch { return null; }
}
