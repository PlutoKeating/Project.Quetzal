import { useEffect, useRef, type ReactNode } from "react";
import { isRouteErrorResponse, Link, Links, Meta, Outlet, Scripts, ScrollRestoration, useLocation, useRouteError } from "react-router";
// 视觉语言只有一份：样式、字体与光学脚本都直接取自 packages/design-system，构建时进产物。
import sora400 from "@design/fonts/sora-latin-400-normal.woff2?url";
import sora500 from "@design/fonts/sora-latin-500-normal.woff2?url";
import opticsSrc from "@design/scripts/optics.js?url&no-inline";
import systemHref from "@design/styles.css?url";
import { OpticalLayers, SiteShell } from "./components/SiteShell";
import { HTML_LANG, SITE_ORIGIN, alternatePath, chrome, langFromPath, localized } from "./i18n/core";
import { isKnownPath, isReadingPath } from "./lib/pages";
import siteHref from "./site.css?url";

export function links() {
  return [
    { rel: "icon", href: "/favicon.svg", type: "image/svg+xml" },
    { rel: "preload", href: sora500, as: "font", type: "font/woff2", crossOrigin: "anonymous" as const },
    { rel: "preload", href: sora400, as: "font", type: "font/woff2", crossOrigin: "anonymous" as const },
    { rel: "stylesheet", href: systemHref },
    { rel: "stylesheet", href: siteHref },
  ];
}

type Optics = { init: (root?: ParentNode) => () => void };

/** 光学脚本首次加载时自己启动；站内跳转换了页面内容之后，按它的约定重新 init 一次。 */
function useOpticsOnNavigation(pathname: string) {
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const optics = (window as unknown as { QuetzalcoatlOptics?: Optics }).QuetzalcoatlOptics;
    return optics?.init();
  }, [pathname]);
}

export function Layout({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  const lang = langFromPath(pathname);
  const zhHref = `${SITE_ORIGIN}${alternatePath(pathname, "zh")}`;
  const enHref = `${SITE_ORIGIN}${alternatePath(pathname, "en")}`;
  useOpticsOnNavigation(pathname);
  return (
    <html lang={HTML_LANG[lang]} dir="ltr">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="color-scheme" content="dark" />
        {isKnownPath(pathname) ? (
          <>
            <link rel="alternate" hrefLang="zh-CN" href={zhHref} />
            <link rel="alternate" hrefLang="en" href={enHref} />
            <link rel="alternate" hrefLang="x-default" href={zhHref} />
          </>
        ) : null}
        <meta property="og:type" content="website" />
        <meta property="og:site_name" content="Quetzalcoatl" />
        <Meta />
        <Links />
      </head>
      <body>
        <OpticalLayers reading={isReadingPath(pathname)} />
        {/* 骨架放在 Layout 里而不是路由里：404.html 会在任意地址上水合，此时路由还没匹配上，
            如果 .qz-page 由路由渲染，React 会把预渲染的那一份当成外来节点留下，页面就成了两份。 */}
        <SiteShell>{children}</SiteShell>
        <ScrollRestoration />
        <Scripts />
        <script src={opticsSrc} defer />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

export function ErrorBoundary() {
  const error = useRouteError();
  const { pathname } = useLocation();
  const lang = langFromPath(pathname);
  const t = chrome[lang];
  const missing = isRouteErrorResponse(error) && error.status === 404;
  return (
    <section className="qz-hero">
      <div className="qz-container qz-hero-inner">
        <h1 className="qz-display">{missing ? t.notFound.title : t.error.title}</h1>
        <p className="qz-lead">{missing ? t.notFound.lead : t.error.lead}</p>
        <div className="qz-action-stack">
          <div className="qz-action-row">
            <Link to={localized(lang, "/")} className="qz-btn-outline">
              {t.notFound.home}
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}
