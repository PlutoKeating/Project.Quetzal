// 双语与全站通用文案。默认中文，英文在 /en 下。
import { useLocation } from "react-router";

export const LANGS = ["zh", "en"] as const;
export type Lang = (typeof LANGS)[number];
export const DEFAULT_LANG: Lang = "zh";
export const HTML_LANG: Record<Lang, string> = { zh: "zh-CN", en: "en" };

export const SITE_ORIGIN = "https://quetzal.plutokeating.beer";
export const GITHUB_URL = "https://github.com/PlutoKeating/Project.Quetzal";
export const INSTALL_COMMAND = `curl -fsSL ${SITE_ORIGIN}/install | bash`;
export const SOURCE_BUILD_COMMAND = `git clone ${GITHUB_URL} && cd Project.Quetzal && cargo build -p quetzalcoatl-daemon --release`;

/** 把不带语言的站内路径加上语言前缀：/download → /download（zh）或 /en/download（en）。 */
export function localized(lang: Lang, path: string): string {
  if (path.startsWith("http") || path.startsWith("#")) return path;
  const [bare = "/", hash] = path.split("#");
  const clean = bare.startsWith("/") ? bare : `/${bare}`;
  const target = lang === DEFAULT_LANG ? clean : clean === "/" ? "/en" : `/en${clean}`;
  return hash ? `${target}#${hash}` : target;
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

type Chrome = {
  skip: string;
  nav: { label: string; docs: string; download: string; language: string };
  langName: Record<Lang, string>;
  /** 导航栏触发器上的短名：窄屏放不下全称 */
  langShort: string;
  footer: { license: string; label: string; signing: string; source: string };
  copy: { idle: string; done: string };
  docs: {
    sections: { start: string; guide: string; advanced: string; reference: string };
    sideLabel: string;
    tocLabel: string;
    menu: string;
    pagerLabel: string;
    prev: string;
    next: string;
  };
  notFound: { metaTitle: string; title: string; lead: string; home: string; docs: string };
  error: { title: string; lead: string };
};

const zh: Chrome = {
  skip: "跳到正文",
  nav: { label: "主导航", docs: "文档", download: "下载", language: "语言" },
  langName: { zh: "中文", en: "English" },
  langShort: "中文",
  footer: { license: "Apache-2.0 · Hub 为 AGPL-3.0-only", label: "页脚", signing: "发布签名", source: "GitHub" },
  copy: { idle: "复制", done: "已复制" },
  docs: {
    sections: { start: "开始", guide: "使用", advanced: "进阶", reference: "参考" },
    sideLabel: "文档导航",
    tocLabel: "本页内容",
    menu: "全部文档",
    pagerLabel: "上一页与下一页",
    prev: "上一页",
    next: "下一页",
  },
  notFound: {
    metaTitle: "页面不存在",
    title: "这里什么也没有",
    lead: "这个地址上没有页面。它可能已经搬走，或者从未存在。",
    home: "回到首页",
    docs: "阅读文档",
  },
  error: { title: "页面出了点问题", lead: "刷新一次，或者回到首页。" },
};

const en: Chrome = {
  skip: "Skip to content",
  nav: { label: "Main navigation", docs: "Docs", download: "Download", language: "Language" },
  langName: { zh: "中文", en: "English" },
  langShort: "EN",
  footer: { license: "Apache-2.0 · the Hub is AGPL-3.0-only", label: "Footer", signing: "Release signing", source: "GitHub" },
  copy: { idle: "Copy", done: "Copied" },
  docs: {
    sections: { start: "Start", guide: "Use", advanced: "Advanced", reference: "Reference" },
    sideLabel: "Documentation",
    tocLabel: "On this page",
    menu: "All docs",
    pagerLabel: "Previous and next",
    prev: "Previous",
    next: "Next",
  },
  notFound: {
    metaTitle: "Not found",
    title: "Nothing here",
    lead: "There is no page at this address. It may have moved, or it never existed.",
    home: "Back to home",
    docs: "Read the docs",
  },
  error: { title: "Something went wrong", lead: "Reload once, or go back to the home page." },
};

export const chrome: Record<Lang, Chrome> = { zh, en };

export function useChrome(): { t: Chrome; lang: Lang } {
  const lang = useLang();
  return { t: chrome[lang], lang };
}
