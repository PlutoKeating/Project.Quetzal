import { useCallback, useEffect, useState } from "react";
import { data, isRouteErrorResponse, Link, useLocation } from "react-router";
import type { Route } from "./+types/route";
import { DEFAULT_LANG, isLang, localized, useLang, useMessages, type Lang } from "~/i18n/core";
import { Container, cx, Heading, Lead, ButtonLink } from "~/design-system/components";
import { Markdown, type HeadingItem } from "~/components/markdown/Markdown";
import { editUrl, getDoc, getDocsNav, getFirstDocRef, getFlatPages } from "~/lib/docs";
import { DocsSidebar } from "./Sidebar";
import { DocsToc } from "./Toc";
import { messages } from "./i18n";

/** 构建时执行（ssr:false + prerender）：每个文档页写成自己的 .data，客户端包不含全文。 */
export async function loader({ params }: Route.LoaderArgs) {
  const lang: Lang = isLang(params.lang) ? params.lang : DEFAULT_LANG;
  const splat = (params["*"] ?? "").replace(/^\/+|\/+$/g, "");
  const [section, slug] = splat ? splat.split("/") : (() => { const f = getFirstDocRef(); return [f.section, f.slug]; })();
  const doc = section && slug ? getDoc(lang, section, slug) : null;
  if (!doc) throw data(null, { status: 404 });
  const flat = getFlatPages(lang);
  const i = flat.findIndex((p) => p.section === section && p.slug === slug);
  return {
    nav: getDocsNav(lang),
    /** /:lang/docs 首页与第一页内容相同，只让正式路径进搜索索引 */
    indexable: Boolean(splat),
    doc,
    prev: i > 0 ? flat[i - 1] : null,
    next: i >= 0 && i < flat.length - 1 ? flat[i + 1] : null,
    edit: editUrl(lang, section, slug),
  };
}

export const meta: Route.MetaFunction = ({ loaderData, params }) => {
  const lang = isLang(params.lang) ? params.lang : DEFAULT_LANG;
  const base = messages[lang].title;
  if (!loaderData) return [{ title: base }];
  return [
    { title: `${loaderData.doc.title} · ${base}` },
    { name: "description", content: loaderData.doc.description },
  ];
};

export default function DocsPage({ loaderData }: Route.ComponentProps) {
  const { nav, doc, prev, next, edit, indexable } = loaderData;
  const t = useMessages(messages);
  const lang = useLang();
  const { pathname } = useLocation();
  const [headings, setHeadings] = useState<HeadingItem[]>([]);
  const [navOpen, setNavOpen] = useState(false);
  useEffect(() => setNavOpen(false), [pathname]);

  const onHeadings = useCallback((h: HeadingItem[]) => setHeadings(h), []);
  const linkBase = useCallback((href: string) => (href.startsWith("/") ? localized(lang, href) : href), [lang]);
  const linkCls = "group flex flex-col gap-1 rounded-lg border border-border p-4 transition-colors duration-(--ds-duration-base) hover:border-border-strong hover:bg-surface-hover";

  return (
    <Container width="wide" className="py-8 sm:py-10 short:py-5">
      {/* 移动端：导航抽屉开关 */}
      <div className="mb-4 lg:hidden">
        <button type="button" onClick={() => setNavOpen((v) => !v)} aria-expanded={navOpen} aria-controls="docs-nav"
          className="flex h-10 w-full items-center justify-between rounded-md border border-border bg-surface px-3 text-sm text-fg-muted hover:text-fg">
          <span>{navOpen ? t.closeNav : t.openNav}</span>
          <span aria-hidden>{navOpen ? "×" : "≡"}</span>
        </button>
        {navOpen && <div id="docs-nav" className="mt-2 rounded-lg border border-border bg-bg-elevated p-4"><DocsSidebar nav={nav} currentPath={doc.path} onNavigate={() => setNavOpen(false)} /></div>}
      </div>

      <div className="grid gap-10 lg:grid-cols-[14rem_minmax(0,1fr)] xl:grid-cols-[14rem_minmax(0,1fr)_13rem]">
        <aside className="hidden lg:block">
          <div className="sticky top-[calc(var(--ds-header-height)+1.5rem)] max-h-[calc(100dvh-var(--ds-header-height)-3rem)] overflow-y-auto pr-2">
            <DocsSidebar nav={nav} currentPath={doc.path} />
          </div>
        </aside>

        <article className="min-w-0" data-pagefind-body={indexable ? "" : undefined}>
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-fg-subtle">{nav.find((s) => s.id === doc.section)?.title}</p>
          <Heading as="h1" size="lg" data-pagefind-meta="title">{doc.title}</Heading>
          {doc.description && <Lead className="mt-3">{doc.description}</Lead>}
          <div className="mt-8">
            <Markdown key={doc.path} source={doc.body} onHeadings={onHeadings} linkBase={linkBase} />
          </div>

          <div className="mt-12 flex flex-col gap-4 border-t border-border pt-6">
            <a href={edit} target="_blank" rel="noreferrer noopener" className="text-sm text-fg-muted hover:text-fg">{t.edit} ↗</a>
            <nav aria-label={`${t.prev} / ${t.next}`} className="grid gap-3 sm:grid-cols-2">
              {prev ? (
                <Link to={prev.path} className={linkCls}>
                  <span className="text-xs text-fg-subtle">← {t.prev}</span>
                  <span className="text-sm text-fg">{prev.title}</span>
                </Link>
              ) : <span />}
              {next && (
                <Link to={next.path} className={cx(linkCls, "text-right")}>
                  <span className="text-xs text-fg-subtle">{t.next} →</span>
                  <span className="text-sm text-fg">{next.title}</span>
                </Link>
              )}
            </nav>
          </div>
        </article>

        <aside className="hidden xl:block">
          <div className="sticky top-[calc(var(--ds-header-height)+1.5rem)] max-h-[calc(100dvh-var(--ds-header-height)-3rem)] overflow-y-auto">
            <DocsToc headings={headings} />
          </div>
        </aside>
      </div>
    </Container>
  );
}

/** 不存在的文档路径（404 .data 或 loader 抛出）。 */
export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  const t = useMessages(messages);
  const lang = useLang();
  const status = isRouteErrorResponse(error) ? error.status : 500;
  return (
    <Container width="prose" className="flex flex-col items-start gap-4 py-24 short:py-10">
      <p className="text-5xl font-semibold tracking-tight">{status}</p>
      <Heading as="h1" size="md">{t.notFoundTitle}</Heading>
      <Lead>{t.notFoundLead}</Lead>
      <ButtonLink to={localized(lang, "/docs")} variant="secondary">{t.backToDocs}</ButtonLink>
    </Container>
  );
}
