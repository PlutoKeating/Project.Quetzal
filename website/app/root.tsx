import { isRouteErrorResponse, Links, Meta, Outlet, Scripts, ScrollRestoration, useLocation, useRouteError } from "react-router";
import type { ReactNode } from "react";
import { SiteFooter } from "./components/SiteFooter";
import { SiteHeader } from "./components/SiteHeader";
import { globalCss } from "./design-system/designSystem";
import { HTML_LANG, SITE_ORIGIN, alternatePath, chrome, langFromPath, localized } from "./i18n/core";

export function Layout({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  const lang = langFromPath(pathname);
  const t = chrome[lang];
  const zhHref = `${SITE_ORIGIN}${alternatePath(pathname, "zh")}`;
  const enHref = `${SITE_ORIGIN}${alternatePath(pathname, "en")}`;
  return (
    <html lang={HTML_LANG[lang]}>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="color-scheme" content="light" />
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
        <link rel="alternate" hrefLang="zh-CN" href={zhHref} />
        <link rel="alternate" hrefLang="en" href={enHref} />
        <link rel="alternate" hrefLang="x-default" href={zhHref} />
        <meta property="og:type" content="website" />
        <meta property="og:site_name" content="Quetzalcoatl" />
        <Meta />
        <Links />
        <style dangerouslySetInnerHTML={{ __html: globalCss }} />
      </head>
      <body>
        <a className="skip" href="#main">
          {t.skip}
        </a>
        <SiteHeader />
        <main id="main">{children}</main>
        <SiteFooter />
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

export function ErrorBoundary() {
  const error = useRouteError();
  const status = isRouteErrorResponse(error) ? error.status : 500;
  const lang = langFromPath(typeof location === "undefined" ? "/" : location.pathname);
  const t = chrome[lang];
  return (
    <div className="wrap not-found">
      <p className="eyebrow">Quetzalcoatl</p>
      <h1>{status}</h1>
      <p style={{ color: "inherit" }}>{isRouteErrorResponse(error) ? error.statusText : lang === "zh" ? "页面出错了。" : "Something went wrong."}</p>
      <p>
        <a href={localized(lang, "/")}>{t.nav.home}</a>
      </p>
    </div>
  );
}
