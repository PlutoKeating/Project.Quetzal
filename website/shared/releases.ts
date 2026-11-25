// 发布版本共用的纯函数：官网 Worker 的 /api/releases 镜像与下载页直连 GitHub 的退路共用同一份逻辑，
// 避免「Worker 封顶了、页面没封顶」这类两处不一致。
//
// 资产命名（发版工作流按此生成）：
//   quetzalcoatl-<版本>-<linux|macos>-<x64|arm64>.tar.gz    qz / quetzalcoatld / quetzalcoatl-sandbox-exec
//   quetzalcoatl-<版本>-windows-<x64|arm64>.zip             同上（.exe）
//   SHA256SUMS + SHA256SUMS.sig                            每个资产一行 sha256，外加一行 commit <sha> <tag>；Ed25519 签名
// 只有带齐 SHA256SUMS 与 SHA256SUMS.sig 的发布才算「已签名」，下载页只展示这类发布。

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

/** 正式发布的最高版本：不是草稿、不是预发布、标签形如 vX.Y.Z。 */
export function pickLatest(list: Release[]): Release | undefined {
  return list
    .filter((r) => TAG_RE.test(String(r.tag_name ?? "")) && !r.draft && !r.prerelease)
    .sort((a, b) => compareVersions(String(b.tag_name ?? ""), String(a.tag_name ?? "")))[0];
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
  return { ...release, assets };
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
