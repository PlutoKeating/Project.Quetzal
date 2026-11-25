import { Link, useLocation } from "react-router";
import { GITHUB_URL, alternatePath, localized, langFromPath, useChrome } from "~/i18n/core";

/** 站点标志：一颗用 currentColor 画的同心羽核，随字号缩放。 */
export function Orb({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" strokeWidth="1.2" opacity="0.35" />
      <path
        d="M12 3c3.6 2.4 5.6 5.4 5.6 9S15.6 18.6 12 21c-3.6-2.4-5.6-5.4-5.6-9S8.4 5.4 12 3Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <circle cx="12" cy="12" r="2.6" fill="currentColor" />
    </svg>
  );
}

export function SiteHeader() {
  const { pathname } = useLocation();
  const lang = langFromPath(pathname);
  const { t } = useChrome();
  const other = lang === "zh" ? "en" : "zh";
  const link = (path: string) => localized(lang, path);
  const current = (path: string) => (pathname === link(path) ? "page" : undefined);
  return (
    <header className="site-head">
      <div className="wrap head-inner">
        <Link to={link("/")} className="brand" aria-label="Quetzalcoatl">
          <Orb />
          <span>Quetzalcoatl</span>
          <span className="brand-sub">{t.brandNote}</span>
        </Link>
        <nav className="nav" aria-label={lang === "zh" ? "主导航" : "Main navigation"}>
          <Link to={link("/docs")} aria-current={current("/docs")}>
            {t.nav.docs}
          </Link>
          <Link to={link("/download")} aria-current={current("/download")}>
            {t.nav.download}
          </Link>
          <a href={GITHUB_URL} className="nav-hide" rel="noreferrer noopener">
            {t.nav.source}
          </a>
        </nav>
        <div className="head-tools">
          <Link to={alternatePath(pathname, other)} className="lang-switch" hrefLang={other === "zh" ? "zh-CN" : "en"}>
            {t.langSwitch}
          </Link>
        </div>
      </div>
    </header>
  );
}
