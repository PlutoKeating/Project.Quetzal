// 预渲染清单：语言 × 静态页面 + 文档页。react-router.config.ts 在构建时调用。
import { LANGS } from "../i18n/core";

export const STATIC_PAGES = ["/", "/features", "/download", "/about", "/terms", "/privacy", "/docs"] as const;

export async function prerenderPaths(): Promise<string[]> {
  const paths = ["/", "/404"];
  for (const lang of LANGS) {
    for (const p of STATIC_PAGES) paths.push(p === "/" ? `/${lang}` : `/${lang}${p}`);
  }
  // 文档页在 content/docs 接入后由 docs 清单追加
  return paths;
}
