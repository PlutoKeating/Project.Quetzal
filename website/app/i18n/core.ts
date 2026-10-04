/**
 * 全站 i18n 内核。
 *
 * 约定：
 * - 语言在 URL 前缀里：/zh/…、/en/…。根路径 / 只负责把访客送到合适的语言。
 * - 每个路由目录自带 i18n.ts：`export const messages = defineMessages({ zh: {...}, en: {...} })`，
 *   zh 与 en 的键必须完全一致（由类型保证），页面用 `useMessages(messages)` 取当前语言的文案。
 * - 访客的选择记在 localStorage（键 quetzal.lang），只在根路径跳转与语言切换时读写；没有 Cookie，没有服务端。
 */
import { createContext, useContext } from "react";

export const LANGS = ["zh", "en"] as const;
export type Lang = (typeof LANGS)[number];
export const DEFAULT_LANG: Lang = "en";
export const STORAGE_KEY = "quetzal.lang";

export const LANG_LABEL: Record<Lang, string> = { zh: "中文", en: "English" };
export const HTML_LANG: Record<Lang, string> = { zh: "zh-CN", en: "en" };

export const isLang = (v: unknown): v is Lang => typeof v === "string" && (LANGS as readonly string[]).includes(v);

/** 让两种语言拥有完全相同的键结构：形状由 zh 推断，en 必须与之一致（NoInfer）。值可以是字符串、数字、嵌套对象或它们的数组。 */
export type MessageValue = string | number | MessageTree | readonly MessageValue[];
export type MessageTree = { [key: string]: MessageValue };
export function defineMessages<T extends object>(m: { zh: T; en: NoInfer<T> }): Record<Lang, T> {
  return m;
}

export const LangContext = createContext<Lang>(DEFAULT_LANG);
export const useLang = (): Lang => useContext(LangContext);
export function useMessages<T extends object>(messages: Record<Lang, T>): T {
  return messages[useLang()];
}

/** 把一个不带语言前缀的站内路径变成当前语言的路径。 */
export function localized(lang: Lang, path: string): string {
  const clean = path.startsWith("/") ? path : `/${path}`;
  return clean === "/" ? `/${lang}` : `/${lang}${clean}`;
}
/** 把当前地址切换到另一种语言，保留后面的路径。 */
export function switchLangPath(pathname: string, to: Lang): string {
  const rest = pathname.replace(/^\/(zh|en)(?=\/|$)/, "");
  return localized(to, rest || "/");
}

/** 根据浏览器语言列表挑选站内语言。 */
export function detectLang(languages: readonly string[]): Lang {
  for (const l of languages) if (/^zh\b/i.test(l)) return "zh";
  return DEFAULT_LANG;
}

export function readStoredLang(): Lang | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return isLang(v) ? v : null;
  } catch {
    return null;
  }
}
export function storeLang(lang: Lang): void {
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    /* 私密模式等不可用时静默 */
  }
}

/** 根路径的跳转脚本（内联到预渲染 HTML，首屏即跳，不等 JS 包）。 */
export const REDIRECT_SCRIPT = `(function(){try{var k=${JSON.stringify(STORAGE_KEY)};var s=localStorage.getItem(k);var l=(s==="zh"||s==="en")?s:null;if(!l){var ls=navigator.languages||[navigator.language||""];l="en";for(var i=0;i<ls.length;i++){if(/^zh/i.test(ls[i])){l="zh";break}}}location.replace("/"+l+location.search+location.hash)}catch(e){location.replace("/en")}})();`;
