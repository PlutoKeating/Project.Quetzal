/**
 * Termux 三件套的固定版本直链（F-Droid 仓库里的 APK，签名与 F-Droid 页面上的一致）。
 * 没有 F-Droid 客户端的用户可以一次下载完；升级版本时改这里，并同步 content/docs 的安装页。
 * 直链规则：https://f-droid.org/repo/<包名>_<versionCode>.apk。
 */
export type TermuxApp = { pkg: string; version: string; code: number; bytes: number };

export const TERMUX_APPS = {
  termux: { pkg: "com.termux", version: "0.119.0-beta.3", code: 1022, bytes: 114920926 },
  api: { pkg: "com.termux.api", version: "0.53.0", code: 1002, bytes: 3956196 },
  boot: { pkg: "com.termux.boot", version: "0.8.1", code: 1000, bytes: 26000 },
} as const satisfies Record<string, TermuxApp>;

export const termuxApkUrl = (a: TermuxApp) => `https://f-droid.org/repo/${a.pkg}_${a.code}.apk`;
export const termuxPageUrl = (a: TermuxApp) => `https://f-droid.org/packages/${a.pkg}/`;
