// 预渲染清单：语言 × 静态页面 + 文档页。react-router.config.ts 在构建时（Node）调用，因此文档页用 fs 读取清单与文件存在性。
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { LANGS } from "../i18n/core";

export const STATIC_PAGES = ["/", "/features", "/download", "/about", "/terms", "/privacy", "/docs"] as const;

const contentDir = fileURLToPath(new URL("../../content/docs/", import.meta.url));

function docPaths(): string[] {
  const manifestFile = `${contentDir}manifest.json`;
  if (!existsSync(manifestFile)) return [];
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8")) as { sections: { id: string; pages: string[] }[] };
  const out: string[] = [];
  const missing: string[] = [];
  for (const lang of LANGS) {
    for (const s of manifest.sections) {
      for (const slug of s.pages) {
        const file = `${contentDir}${lang}/${s.id}/${slug}.md`;
        if (existsSync(file)) out.push(`/${lang}/docs/${s.id}/${slug}`);
        else missing.push(`${lang}/${s.id}/${slug}.md`);
      }
    }
  }
  if (missing.length) console.warn(`[prerender] 文档清单里有 ${missing.length} 页还没有文件，跳过：${missing.join(", ")}`);
  return out;
}

export async function prerenderPaths(): Promise<string[]> {
  const paths = ["/", "/404"];
  for (const lang of LANGS) {
    for (const p of STATIC_PAGES) paths.push(p === "/" ? `/${lang}` : `/${lang}${p}`);
  }
  paths.push(...docPaths());
  return paths;
}
