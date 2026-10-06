// 发布版本的比较与「按 npm 封顶」：官网 Worker 的发布接口与网页直连 GitHub 的退路共用。
// 资源分两处发布：GitHub Release（App、桌面控制台）与 npm（运行基座 @plutokeating/quetzal）。两边上线有先后，
// 「最新」取两者中较老的一个，免得用户拿到了新的 App / 控制台，电脑上装到的却还是旧的运行基座。

export const NPM_PKG = "@plutokeating/quetzal";
export const NPM_LATEST_API = "https://registry.npmjs.org/@plutokeating%2Fquetzal/latest";

const semver = (v: string) => v.replace(/^v/, "").split("-")[0].split(".").map((x) => Number(x) || 0);
/** a 比 b 新为正。只比 主.次.修订。 */
export function compareVersions(a: string, b: string): number {
  const x = semver(a), y = semver(b);
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}
/**
 * 按 npm 的版本封顶：v 开头、比 npm 新的发布去掉（其他标签的发布，如 App 内置运行环境的预发布，不受影响）；
 * latest 为剩下的里面不是草稿、不是预发布、版本最高的那个。npm 为 undefined 时不封顶。
 */
export function capReleases(list: Record<string, unknown>[], npm: string | undefined): Record<string, unknown>[] {
  if (!npm) return list;
  return list.filter((r) => { const tag = String(r.tag_name ?? ""); return !/^v\d/.test(tag) || compareVersions(tag, npm) <= 0; });
}
export function pickLatest(list: Record<string, unknown>[]): Record<string, unknown> | undefined {
  return list.filter((r) => /^v\d/.test(String(r.tag_name ?? "")) && !r.draft && !r.prerelease)
    .sort((a, b) => compareVersions(String(b.tag_name), String(a.tag_name)))[0];
}

