import { isRouteErrorResponse, Links, Meta, Outlet, Scripts, ScrollRestoration, useParams } from "react-router";
import type { Route } from "./+types/root";
import "./app.css";
import { HTML_LANG, isLang, LangContext, DEFAULT_LANG } from "./i18n/core";
import { THEME_SCRIPT } from "./components/ThemeToggle";

export const links: Route.LinksFunction = () => [{ rel: "icon", href: "/favicon.svg", type: "image/svg+xml" }];

export function Layout({ children }: { children: React.ReactNode }) {
  const params = useParams();
  const lang = isLang(params.lang) ? params.lang : DEFAULT_LANG;
  return (
    <html lang={HTML_LANG[lang]}>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
        <Meta />
        <Links />
        <link rel="preload" href="/fonts/InterVariable.woff2" as="font" type="font/woff2" crossOrigin="anonymous" />
        <meta property="og:type" content="website" />
        <meta property="og:site_name" content="Windler" />
        <meta property="og:image" content="https://windler.plutokeating.beer/og.png" />
        <meta property="og:image:width" content="1200" />
        <meta property="og:image:height" content="630" />
        <meta name="twitter:card" content="summary_large_image" />
      </head>
      <body className="min-h-dvh bg-bg text-fg antialiased">
        <LangContext.Provider value={lang}>{children}</LangContext.Provider>
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  const status = isRouteErrorResponse(error) ? error.status : 500;
  const message = isRouteErrorResponse(error) ? error.statusText : error instanceof Error ? error.message : "Unknown error";
  return (
    <main className="mx-auto flex min-h-dvh max-w-prose flex-col items-center justify-center gap-4 p-6 text-center">
      <h1 className="text-5xl font-semibold tracking-tight">{status}</h1>
      <p className="text-fg-muted">{message}</p>
      <a href="/" className="text-accent underline-offset-4 hover:underline">Windler</a>
    </main>
  );
}
