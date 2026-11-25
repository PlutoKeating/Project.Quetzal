// 发布版本共用的纯函数：官网 Worker 的 /api/releases 镜像与下载页直连 GitHub 的退路共用同一份逻辑，
// 避免「Worker 封顶了、页面没封顶」这类两处不一致。
//
// 资产命名（发版工作流按此生成）：
//   quetzalcoatl-<版本>-<linux|macos>-<x64|arm64>.tar.gz    qz / quetzalcoatld / quetzalcoatl-sandbox-exec
//   quetzalcoatl-<版本>-windows-<x64|arm64>.zip             同上（.exe）
//   SHA256SUMS + SHA256SUMS.sig                            每个资产一行 sha256，外加一行 commit <sha> <tag>；Ed25519 签名
// 只有带齐 SHA256SUMS 与 SHA256SUMS.sig 的发布才算「已签名」，下载页只展示这类发布。
// 还必须属于**本产品品牌**（至少一个资产名以 `quetzalcoatl-` 开头）：同一仓库里 V1 的
// `v1.11.0` 等旧发布没有这些资产，绝不能被解析成 latest。

export const REPO = "PlutoKeating/Project.Quetzal";
export const GITHUB_RELEASES_API = `https://api.github.com/repos/${REPO}/releases`;
export const GITHUB_LATEST_API = `${GITHUB_RELEASES_API}/latest`;
// npm 上发布的引导包（安装脚本 / 运行基座的版本来源）。npm 与 GitHub 上线有先后，
// 「最新」取两者中较老的那个，免得官网先推荐一个 npm 通道还装不到的版本。
export const NPM_PACKAGE = "@plutokeating/quetzalcoatl";
export const NPM_LATEST_API = `https://registry.npmjs.org/${NPM_PACKAGE.replace("/", "%2F")}/latest`;

export const TAG_RE = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;
export const PLATFORM_ASSET_RE = /^quetzalcoatl-\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?-(?:linux|macos)-(?:x64|arm64)\.tar\.gz$/;
export const WINDOWS_ASSET_RE = /^quetzalcoatl-\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?-windows-(?:x64|arm64)\.zip$/;
export const MANIFEST_ASSET_RE = /^SHA256SUMS(?:\.sig)?$/;

export function isAllowedAsset(name: string): boolean {
  return PLATFORM_ASSET_RE.test(name) || WINDOWS_ASSET_RE.test(name) || MANIFEST_ASSET_RE.test(name);
}

export type ReleaseAsset = {
  name?: unknown;
  size?: unknown;
  digest?: unknown;
  browser_download_url?: unknown;
  github_download_url?: unknown;
};

export type Release = {
  tag_name?: unknown;
  name?: unknown;
  html_url?: unknown;
  published_at?: unknown;
  draft?: unknown;
  prerelease?: unknown;
  body?: unknown;
  assets?: unknown;
};

const numeric = (tag: string): number[] =>
  tag
    .replace(/^v/, "")
    .split("-")[0]
    ?.split(".")
    .map((x) => Number(x) || 0) ?? [0, 0, 0];

/** a 比 b 新为正；只比 主.次.修订（预发布后缀不参与，标签本身仍会保留）。 */
export function compareVersions(a: string, b: string): number {
  const x = numeric(a);
  const y = numeric(b);
  for (let i = 0; i < 3; i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * 按 npm 的版本封顶：v 开头的发布若比 npm 上的版本新就去掉（其他标签的发布，例如只发资产的内部构建，不受影响）。
 * npm 版本未知（接口限流、包还不存在）时原样返回，不封顶。
 */
export function capReleases(list: Release[], npmVersion: string | undefined): Release[] {
  if (!npmVersion) return list;
  return list.filter((r) => {
    const tag = String(r.tag_name ?? "");
    return !TAG_RE.test(tag) || compareVersions(tag, npmVersion) <= 0;
  });
}

/** 本产品品牌的发布：至少一个资产名以 `quetzalcoatl-` 开头。 */
export function isBrandRelease(release: Release): boolean {
  return assetsOf(release).some((asset) => String(asset.name ?? "").startsWith("quetzalcoatl-"));
}

/** 预发布：GitHub 标记为 prerelease，或标签带 `-suffix`。 */
export function isPrerelease(release: Release): boolean {
  if (release.prerelease === true) return true;
  return /^v?\d+\.\d+\.\d+-/.test(String(release.tag_name ?? ""));
}

/** 下载页 / 安装器可用的发布：本产品品牌 + 带完整签名清单。 */
export function isInstallableRelease(release: Release): boolean {
  return isBrandRelease(release) && isSignedRelease(release);
}

const newestFirst = (a: Release, b: Release): number => {
  const d = compareVersions(String(b.tag_name ?? ""), String(a.tag_name ?? ""));
  if (d !== 0) return d;
  const aPre = isPrerelease(a);
  const bPre = isPrerelease(b);
  if (aPre !== bPre) return aPre ? 1 : -1;
  const x = String(a.tag_name ?? "");
  const y = String(b.tag_name ?? "");
  return x < y ? 1 : x > y ? -1 : 0;
};

/** 按版本从新到旧排序（预发布与正式版混排时只比较主.次.修订，后缀作为同版本内的次序）。 */
export function sortReleases(list: Release[]): Release[] {
  return [...list].sort(newestFirst);
}

/**
 * 选「最新可安装版本」：优先最新的正式版；若没有任何正式版，回退到最新预发布版
 * （这样 `v2.0.0-alpha.1` 在首个稳定版之前仍可安装，下载页会标注 pre-release）。
 * 只考虑非草稿、标签形如 vX.Y.Z[-suffix] 的发布；品牌/签名过滤由调用方（isInstallableRelease）负责。
 */
export function pickLatest(list: Release[]): Release | undefined {
  const known = list.filter((r) => TAG_RE.test(String(r.tag_name ?? "")) && !r.draft);
  const stable = known.filter((r) => !isPrerelease(r)).sort(newestFirst)[0];
  return stable ?? known.filter(isPrerelease).sort(newestFirst)[0];
}

/** 已签名：资产里同时有 SHA256SUMS 与 SHA256SUMS.sig。下载页只展示这类发布。 */
export function isSignedRelease(release: Release): boolean {
  const names = new Set(assetsOf(release).map((a) => String(a.name ?? "")));
  return names.has("SHA256SUMS") && names.has("SHA256SUMS.sig");
}

export function assetsOf(release: Release): ReleaseAsset[] {
  return Array.isArray(release.assets) ? (release.assets as ReleaseAsset[]) : [];
}

/** 把允许的资产地址改写到本站 /dl/<tag>/<asset>，原 GitHub 地址保留在 github_download_url。 */
export function rewriteAssets(origin: string, release: Release): Release {
  const tag = String(release.tag_name ?? "");
  const assets = assetsOf(release).map((asset) => {
    const name = String(asset.name ?? "");
    if (!TAG_RE.test(tag) || !isAllowedAsset(name)) return asset;
    return {
      ...asset,
      github_download_url: asset.browser_download_url,
      browser_download_url: `${origin}/dl/${tag}/${name}`,
    };
  });
  return { ...release, prerelease: isPrerelease(release), assets };
}

export const PLATFORMS = ["linux-x64", "linux-arm64", "macos-x64", "macos-arm64", "windows-x64", "windows-arm64"] as const;
export type PlatformId = (typeof PLATFORMS)[number];

export function assetNameFor(version: string, platform: PlatformId): string {
  return platform.startsWith("windows")
    ? `quetzalcoatl-${version}-${platform}.zip`
    : `quetzalcoatl-${version}-${platform}.tar.gz`;
}

export function findPlatformAsset(release: Release, platform: PlatformId): ReleaseAsset | undefined {
  const version = String(release.tag_name ?? "").replace(/^v/, "");
  if (!version) return undefined;
  const wanted = assetNameFor(version, platform);
  return assetsOf(release).find((a) => String(a.name ?? "") === wanted);
}
