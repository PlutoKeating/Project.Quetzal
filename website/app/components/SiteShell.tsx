import { useEffect, useRef, type ReactNode } from "react";
import { Link, useLocation } from "react-router";
import { GITHUB_URL, HTML_LANG, LANGS, alternatePath, chrome, langFromPath, localized } from "~/i18n/core";
import { isKnownPath, isReadingPath } from "~/lib/pages";
import { Chevron } from "./icons";

/** 固定在视口里的两层：光学地平线与胶片颗粒。必须是 <body> 最前面的两个子元素。 */
export function OpticalLayers({ reading }: { reading: boolean }) {
  return (
    <>
      <div className={reading ? "qz-optical-horizon is-reading" : "qz-optical-horizon"} aria-hidden="true" />
      <div className="qz-grain" aria-hidden="true" />
    </>
  );
}

function LanguageMenu() {
  const { pathname } = useLocation();
  const lang = langFromPath(pathname);
  const t = chrome[lang];
  const menu = useRef<HTMLDetailsElement>(null);
  // 当前地址不是站内页面（比如 404）时，换语言就回到那种语言的首页。
  const known = isKnownPath(pathname);

  // 原生 <details> 自己能开合；这里只补「点外面关闭」与「跳转后关闭」。
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
  }, [pathname]);

  return (
    <details className="qz-menu" ref={menu}>
      <summary className="qz-menu-trigger" aria-label={t.nav.language}>
        <span>{t.langShort}</span>
        <Chevron />
      </summary>
      <div className="qz-menu-popover" role="menu">
        {LANGS.map((code) => (
          <Link
            key={code}
            to={known ? alternatePath(pathname, code) : localized(code, "/")}
            role="menuitem"
            hrefLang={HTML_LANG[code]}
            className={code === lang ? "qz-menu-item is-current" : "qz-menu-item"}
            aria-current={code === lang ? "page" : undefined}
          >
            <span lang={HTML_LANG[code]}>{t.langName[code]}</span>
            <span className="qz-menu-item-meta">{code}</span>
          </Link>
        ))}
      </div>
    </details>
  );
}

function SiteNav() {
  const { pathname } = useLocation();
  const lang = langFromPath(pathname);
  const t = chrome[lang];
  const docs = localized(lang, "/docs");
  const download = localized(lang, "/download");
  return (
    <header className="qz-nav">
      <div className="qz-nav-inner">
        <Link to={localized(lang, "/")} className="qz-brand" aria-label="Quetzalcoatl" dir="ltr">
          <span className="qz-wordmark">Quetzalcoatl</span>
        </Link>
        <nav className="qz-nav-links" aria-label={t.nav.label}>
          <Link to={docs} aria-current={pathname === docs || pathname.startsWith(`${docs}/`) ? "page" : undefined}>
            {t.nav.docs}
          </Link>
          <Link to={download} aria-current={pathname === download ? "page" : undefined}>
            {t.nav.download}
          </Link>
          <LanguageMenu />
        </nav>
      </div>
    </header>
  );
}

function SiteFooter() {
  const { pathname } = useLocation();
  const lang = langFromPath(pathname);
  const t = chrome[lang];
  return (
    <footer className="qz-footer">
      <div className="qz-container qz-footer-inner">
        <span>{t.footer.license}</span>
        <nav className="qz-footer-links" aria-label={t.footer.label}>
          <Link to={localized(lang, "/docs")}>{t.nav.docs}</Link>
          <Link to={localized(lang, "/download")}>{t.nav.download}</Link>
          <Link to={localized(lang, "/docs/reference/release-signing")}>{t.footer.signing}</Link>
          <a href={GITHUB_URL} rel="noreferrer noopener">
            {t.footer.source}
          </a>
        </nav>
      </div>
    </footer>
  );
}

/** 页面骨架：内容全部包在 .qz-page 里（透明、z-index 1），光学层从它后面透出来。 */
export function SiteShell({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  const t = chrome[langFromPath(pathname)];
  return (
    <div className={isReadingPath(pathname) ? "qz-page site-reading" : "qz-page"}>
      <a className="qz-btn-outline site-skip" href="#main">
        {t.skip}
      </a>
      <SiteNav />
      <main id="main" className="site-main">
        {children}
      </main>
      <SiteFooter />
    </div>
  );
}
