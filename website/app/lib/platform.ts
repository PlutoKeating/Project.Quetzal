// 下载页按访客的系统预选平台。纯函数，输入由调用方从浏览器取，便于核对。
//
// 依次看：
// 1. navigator.userAgentData.platform（Chromium 系，不受 User-Agent 精简影响）："Android" / "Windows" / "Linux" / "Chrome OS" / "macOS"
// 2. navigator.userAgent 与 navigator.platform
// 3. 安卓浏览器开了「桌面版网站」时会伪装成 Linux 桌面：Linux 标识 + 触屏 + 屏幕短边小于 800 时仍算安卓
// 苹果设备、鸿蒙与认不出的系统一律给安卓（Quetzal 没有 macOS / iOS 版）。

export const PLATFORMS = ["android", "windows", "linux"] as const;
export type Platform = (typeof PLATFORMS)[number];
export const isPlatform = (s: string): s is Platform => (PLATFORMS as readonly string[]).includes(s);

export interface BrowserInfo {
  uaPlatform?: string;     // navigator.userAgentData?.platform
  userAgent: string;       // navigator.userAgent
  platform?: string;       // navigator.platform
  maxTouchPoints?: number; // navigator.maxTouchPoints
  screenShort?: number;    // Math.min(screen.width, screen.height)，CSS 像素
}

export function detectPlatform(b: BrowserInfo): Platform {
  const hint = b.uaPlatform ?? "";
  if (/android/i.test(hint)) return "android";
  if (/windows/i.test(hint)) return "windows";
  if (/chrome ?os|chromium ?os/i.test(hint)) return "linux"; // Chromebook 的 Linux 开发环境能跑安装命令
  if (/mac|ios/i.test(hint)) return "android";
  if (/linux/i.test(hint)) return looksLikePhone(b) ? "android" : "linux";

  const ua = b.userAgent, plat = b.platform ?? "";
  if (/android|harmonyos|openharmony/i.test(ua)) return "android";
  if (/iphone|ipad|ipod|macintosh|mac os x/i.test(ua) || /^(mac|iphone|ipad|ipod)/i.test(plat)) return "android";
  if (/windows|win64|win32|wow64/i.test(ua) || /^win/i.test(plat)) return "windows";
  if (/cros/i.test(ua)) return "linux";
  if (/linux|x11|ubuntu|fedora|debian|freebsd|openbsd/i.test(ua) || /linux|bsd/i.test(plat)) return looksLikePhone(b) ? "android" : "linux";
  return "android";
}

function looksLikePhone(b: BrowserInfo): boolean {
  return (b.maxTouchPoints ?? 0) > 1 && (b.screenShort ?? Infinity) < 800;
}

/** 从当前浏览器取 BrowserInfo（只在水合后调用）。 */
export function browserInfo(): BrowserInfo {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  return {
    uaPlatform: nav.userAgentData?.platform || undefined,
    userAgent: nav.userAgent,
    platform: nav.platform,
    maxTouchPoints: nav.maxTouchPoints,
    screenShort: Math.min(screen.width, screen.height),
  };
}
