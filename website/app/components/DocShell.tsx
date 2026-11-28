import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useLocation } from "react-router";
import { type Lang, chrome, localized, useLang } from "~/i18n/core";
import type { Block, Doc, Messages } from "~/lib/content";
import { DOC_NAV, docIndex, navGroups } from "~/lib/pages";
import { Blocks } from "./Blocks";
import { ArrowLeft, ArrowRight, Chevron } from "./icons";

type Heading = { id: string; text: string };

function headingsOf(blocks: Block[]): Heading[] {
  return blocks.flatMap((block) => (block.kind === "h2" ? [{ id: block.id, text: block.text }] : []));
}

/** 目录里哪一节是「当前」：最后一个已经滚过视口上沿附近的标题。 */
function useActiveHeading(ids: string[]): string | undefined {
  const [active, setActive] = useState<string | undefined>(ids[0]);
  const key = ids.join("|");
  useEffect(() => {
    const targets = key.split("|").flatMap((id) => {
      const el = document.getElementById(id);
      return el ? [el] : [];
    });
    if (targets.length === 0) return;
    const update = () => {
      const line = window.innerHeight * 0.3;
      let current = targets[0]?.id;
      for (const el of targets) {
        if (el.getBoundingClientRect().top <= line) current = el.id;
      }
      setActive(current);
    };
    update();
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update, { passive: true });
    return () => {
      window.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [key]);
  return active;
}

/** 窄屏上代替侧栏的菜单：原生 <details>，不依赖脚本也能开合。 */
function DocsMenu({ lang, current }: { lang: Lang; current: string }) {
  const t = chrome[lang];
  const menu = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const close = (event: MouseEvent) => {
      const el = menu.current;
      if (el?.open && event.target instanceof Node && !el.contains(event.target)) el.open = false;
    };
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, []);
  useEffect(() => {
    if (menu.current) menu.current.open = false;
  }, [current]);
  return (
    <details className="qz-menu" ref={menu}>
      <summary className="qz-menu-trigger">
        <span>{t.docs.menu}</span>
        <Chevron />
      </summary>
      <div className="qz-menu-popover" role="menu">
        {DOC_NAV.map((item, i) => (
          <Link
            key={item.path}
            to={localized(lang, item.path)}
            role="menuitem"
            className={item.path === current ? "qz-menu-item is-current site-nowrap" : "qz-menu-item site-nowrap"}
            aria-current={item.path === current ? "page" : undefined}
          >
            <span>{item.label[lang]}</span>
            <span className="qz-menu-item-meta">{String(i + 1).padStart(2, "0")}</span>
          </Link>
        ))}
      </div>
    </details>
  );
}

/** 文档三栏：不透明的侧栏 / 正文（.qz-prose）/ 本页目录。 */
export function DocShell({ path, doc, children }: { path: string; doc: Doc; children?: ReactNode }) {
  const lang = useLang();
  const t = chrome[lang];
  const { pathname } = useLocation();
  const headings = headingsOf(doc.blocks);
  const active = useActiveHeading(headings.map((h) => h.id));
  const index = docIndex(path);
  const entry = DOC_NAV[index];
  const prev = index > 0 ? DOC_NAV[index - 1] : undefined;
  const next = index >= 0 ? DOC_NAV[index + 1] : undefined;
  return (
    <div className="site-docs">
      <aside className="qz-sidenav site-docs-side">
        <nav className="site-sticky" aria-label={t.docs.sideLabel}>
          {navGroups().map((group) => (
            <div key={group.section} className="qz-sidenav-group">
              <span className="qz-sidenav-label">{t.docs.sections[group.section]}</span>
              {group.items.map((item) => {
                const to = localized(lang, item.path);
                return (
                  <Link key={item.path} to={to} aria-current={pathname === to ? "page" : undefined}>
                    {item.label[lang]}
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>
      </aside>

      <article className="site-docs-main">
        <div className="site-docs-menu">
          <span className="qz-meta">{entry ? t.docs.sections[entry.section] : ""}</span>
          <DocsMenu lang={lang} current={path} />
        </div>
        <header className="qz-prose">
          <h1>{doc.title}</h1>
          <p className="qz-lead">{doc.lead}</p>
        </header>
        <hr className="qz-seam site-seam" />
        <Blocks blocks={doc.blocks} lang={lang} />
        {children}
        <nav className="site-pager" aria-label={t.docs.pagerLabel}>
          {prev ? (
            <Link to={localized(lang, prev.path)} className="qz-link-arrow" rel="prev">
              <ArrowLeft />
              <span>{prev.label[lang]}</span>
            </Link>
          ) : null}
          {next ? (
            <Link to={localized(lang, next.path)} className="qz-link-arrow site-pager-next" rel="next">
              <span>{next.label[lang]}</span>
              <ArrowRight />
            </Link>
          ) : null}
        </nav>
      </article>

      <aside className="site-docs-toc">
        {headings.length > 0 ? (
          <nav className="qz-toc site-sticky" aria-label={t.docs.tocLabel}>
            <span className="qz-sidenav-label">{t.docs.tocLabel}</span>
            {headings.map((h) => (
              <a key={h.id} href={`#${h.id}`} aria-current={active === h.id ? "true" : undefined}>
                {h.text}
              </a>
            ))}
          </nav>
        ) : (
          <nav className="qz-toc site-sticky" aria-label={t.docs.tocLabel} />
        )}
      </aside>
    </div>
  );
}

/** 文档页共用的外壳：语言由路径决定，正文来自本页的 i18n.ts。 */
export function DocPage({ path, messages, children }: { path: string; messages: Messages; children?: ReactNode }) {
  const lang = useLang();
  return (
    <DocShell path={path} doc={messages[lang].doc}>
      {children}
    </DocShell>
  );
}
