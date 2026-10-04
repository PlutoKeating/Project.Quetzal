/**
 * 文档内容加载：content/docs/manifest.json（分区与页面顺序，两种语言共用）+ content/docs/<lang>/<section>/<slug>.md。
 * 只在构建时由路由 loader 调用（ssr:false + prerender），Markdown 正文写进各页的 .data，客户端包不含文档全文。
 */
import type { Lang } from "../i18n/core";
import manifest from "../../content/docs/manifest.json";

export interface DocsSection { id: string; title: Record<Lang, string>; pages: string[] }
export interface NavPage { section: string; slug: string; title: string; path: string }
export interface NavSection { id: string; title: string; pages: NavPage[] }
export interface Doc { section: string; slug: string; title: string; description: string; body: string; path: string }

const files = import.meta.glob("../../content/docs/**/*.md", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

const sections = (manifest as { sections: DocsSection[] }).sections;

const fileKey = (lang: Lang, section: string, slug: string) => `../../content/docs/${lang}/${section}/${slug}.md`;

/** 十几行的 frontmatter 解析：只认 `key: value` 一层，值可带引号。 */
function parseFrontmatter(raw: string): { data: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!m) return { data: {}, body: raw };
  const data: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    let v = kv[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    data[kv[1]] = v;
  }
  return { data, body: raw.slice(m[0].length) };
}

const docPath = (lang: Lang, section: string, slug: string) => `/${lang}/docs/${section}/${slug}`;

export function getDocsNav(lang: Lang): NavSection[] {
  return sections.map((s) => ({
    id: s.id,
    title: s.title[lang],
    pages: s.pages
      .filter((slug) => fileKey(lang, s.id, slug) in files)
      .map((slug) => {
        const { data } = parseFrontmatter(files[fileKey(lang, s.id, slug)]);
        return { section: s.id, slug, title: data.title || slug, path: docPath(lang, s.id, slug) };
      }),
  }));
}

export function getDoc(lang: Lang, section: string, slug: string): Doc | null {
  const raw = files[fileKey(lang, section, slug)];
  if (raw == null) return null;
  const { data, body } = parseFrontmatter(raw);
  return { section, slug, title: data.title || slug, description: data.description || "", body, path: docPath(lang, section, slug) };
}

/** 文档首页展示的第一页（清单里第一个分区的第一页）。 */
export function getFirstDocRef(): { section: string; slug: string } {
  const s = sections[0];
  return { section: s.id, slug: s.pages[0] };
}

/** 全部页面的扁平顺序（上一页 / 下一页用）。 */
export function getFlatPages(lang: Lang): NavPage[] {
  return getDocsNav(lang).flatMap((s) => s.pages);
}

export const editUrl = (lang: Lang, section: string, slug: string) =>
  `https://github.com/PlutoKeating/Project.Quetzal/edit/main/website/content/docs/${lang}/${section}/${slug}.md`;
