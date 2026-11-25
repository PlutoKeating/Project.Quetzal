// 双语与全站通用文案。默认中文，英文在 /en 下。
import { useLocation } from "react-router";

export const LANGS = ["zh", "en"] as const;
export type Lang = (typeof LANGS)[number];
export const DEFAULT_LANG: Lang = "zh";
export const HTML_LANG: Record<Lang, string> = { zh: "zh-CN", en: "en" };

/** 把不带语言的站内路径加上语言前缀：/download → /download（zh）或 /en/download（en）。 */
export function localized(lang: Lang, path: string): string {
  if (path.startsWith("http") || path.startsWith("#")) return path;
  const clean = path.startsWith("/") ? path : `/${path}`;
  if (lang === DEFAULT_LANG) return clean;
  return clean === "/" ? "/en" : `/en${clean}`;
}

export function langFromPath(pathname: string): Lang {
  return pathname === "/en" || pathname.startsWith("/en/") ? "en" : DEFAULT_LANG;
}

export function useLang(): Lang {
  const { pathname } = useLocation();
  return langFromPath(pathname);
}

/** 当前页面的另一种语言地址。 */
export function alternatePath(pathname: string, lang: Lang): string {
  const bare = pathname === "/en" ? "/" : pathname.startsWith("/en/") ? pathname.slice(3) : pathname;
  return localized(lang, bare);
}

export function pick<T>(lang: Lang, messages: Record<Lang, T>): T {
  return messages[lang];
}

export const SITE_ORIGIN = "https://quetzal.plutokeating.beer";
export const GITHUB_URL = "https://github.com/PlutoKeating/Project.Quetzal";

type Chrome = {
  brandNote: string;
  skip: string;
  nav: { docs: string; download: string; source: string; home: string };
  langLabel: string;
  langSwitch: string;
  footer: {
    product: string;
    learn: string;
    reference: string;
    install: string;
    download: string;
    docs: string;
    trust: string;
    multiBody: string;
    signing: string;
    backup: string;
    license: string;
    source: string;
  };
  docsSections: { start: string; guide: string; advanced: string; reference: string };
  prev: string;
  next: string;
  download: {
    title: string;
    description: string;
    latest: string;
    noRelease: string;
    loadFailed: string;
    retry: string;
    platform: string;
    direct: string;
    guide: string;
    signed: string;
    unsignedHidden: string;
    assets: string;
    size: string;
    allAssets: string;
    installing: string;
    published: string;
    choose: string;
  };
};

const zhChrome: Chrome = {
  brandNote: "主权 Agent 操作系统",
  skip: "跳到主要内容",
  nav: { docs: "文档", download: "下载", source: "源码", home: "首页" },
  langLabel: "中文",
  langSwitch: "English",
  footer: {
    product: "产品",
    learn: "上手",
    reference: "参考",
    install: "安装 Linux / macOS",
    download: "下载",
    docs: "文档",
    trust: "良知与权限",
    multiBody: "多身体与群组",
    signing: "发布签名与校验",
    backup: "脊柱与备份",
    license: "Apache-2.0 · hub 为 AGPL-3.0",
    source: "GitHub 源码",
  },
  docsSections: { start: "开始", guide: "指南", advanced: "进阶", reference: "参考" },
  prev: "上一页",
  next: "下一页",
  download: {
    title: "下载 Quetzalcoatl",
    description: "下载经 Ed25519 签名校验的六种原生客户端与后台守护进程。",
    latest: "最新签名版本",
    noRelease: "暂时读不到发布信息。",
    loadFailed: "发布信息加载失败（可能是网络或 GitHub 限流）。你仍可直接使用安装命令。",
    retry: "重试",
    platform: "平台",
    direct: "下载压缩包",
    guide: "安装说明",
    signed: "SHA256SUMS 已签名",
    unsignedHidden: "只展示带 SHA256SUMS 与 SHA256SUMS.sig 的发布。",
    assets: "该版本的全部资产",
    size: "大小",
    allAssets: "全部资产",
    installing: "一行安装",
    published: "发布于",
    choose: "选择你的设备",
  },
};

const enChrome: Chrome = {
  brandNote: "A sovereign agent OS",
  skip: "Skip to content",
  nav: { docs: "Docs", download: "Download", source: "Source", home: "Home" },
  langLabel: "English",
  langSwitch: "中文",
  footer: {
    product: "Product",
    learn: "Get started",
    reference: "Reference",
    install: "Install on Linux / macOS",
    download: "Download",
    docs: "Documentation",
    trust: "Conscience & permissions",
    multiBody: "Multi-body & groups",
    signing: "Release signing",
    backup: "Spine & backups",
    license: "Apache-2.0 · hub is AGPL-3.0",
    source: "Source on GitHub",
  },
  docsSections: { start: "Start", guide: "Guides", advanced: "Advanced", reference: "Reference" },
  prev: "Previous",
  next: "Next",
  download: {
    title: "Download Quetzalcoatl",
    description: "Native clients for six surfaces and the background daemon, all Ed25519 signed.",
    latest: "Latest signed release",
    noRelease: "Release information is not available right now.",
    loadFailed: "Could not load releases (network or GitHub rate limit). The one-line install command still works.",
    retry: "Retry",
    platform: "Platform",
    direct: "Download archive",
    guide: "Install guide",
    signed: "SHA256SUMS is signed",
    unsignedHidden: "Only releases that ship SHA256SUMS and SHA256SUMS.sig are listed.",
    assets: "All assets in this release",
    size: "Size",
    allAssets: "All assets",
    installing: "One-line install",
    published: "Published",
    choose: "Choose your device",
  },
};

export const chrome: Record<Lang, Chrome> = { zh: zhChrome, en: enChrome };

export function useChrome(): { t: Chrome; lang: Lang } {
  const lang = useLang();
  return { t: chrome[lang], lang };
}

export function t(lang: Lang): Chrome {
  return chrome[lang];
}
