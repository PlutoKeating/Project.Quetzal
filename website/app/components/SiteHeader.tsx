import { useEffect, useState } from "react";
import { Link, NavLink, useLocation } from "react-router";
import { localized, useLang, useMessages } from "~/i18n/core";
import { cx } from "~/design-system/components";
import { LangSwitch } from "./LangSwitch";
import { ThemeToggle } from "./ThemeToggle";
import { Wordmark } from "./Wordmark";
import { GITHUB_REPO, shellMessages } from "./i18n";

const navItems = [
  { key: "features", path: "/features" },
  { key: "docs", path: "/docs" },
  { key: "download", path: "/download" },
] as const;

export function SiteHeader() {
  const lang = useLang();
  const t = useMessages(shellMessages);
  const [open, setOpen] = useState(false);
  const { pathname } = useLocation();
  useEffect(() => setOpen(false), [pathname]);

  const linkClass = ({ isActive }: { isActive: boolean }) =>
    cx("rounded-md px-3 py-1.5 text-sm transition-colors duration-(--ds-duration-fast)", isActive ? "text-fg" : "text-fg-muted hover:text-fg hover:bg-surface-hover");

  return (
    <header className="sticky top-0 z-20 border-b border-border bg-surface-glass backdrop-blur-glass">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-3 focus:z-30 focus:rounded-md focus:bg-fg focus:px-3 focus:py-1 focus:text-bg">{t.skip}</a>
      <div className="mx-auto flex h-(--ds-header-height) max-w-wide items-center justify-between gap-4 px-5 sm:px-8">
        <Link to={localized(lang, "/")} className="flex items-center gap-2.5 text-fg" aria-label="Quetzal">
          <Wordmark />
        </Link>
        <nav aria-label="Primary" className="hidden items-center gap-1 md:flex">
          {navItems.map((n) => (
            <NavLink key={n.key} to={localized(lang, n.path)} className={linkClass}>{t.nav[n.key]}</NavLink>
          ))}
          <a href={GITHUB_REPO} target="_blank" rel="noreferrer noopener" className={linkClass({ isActive: false })}>{t.nav.github} ↗</a>
        </nav>
        <div className="flex items-center gap-2">
          <LangSwitch />
          <ThemeToggle className="hidden sm:inline-flex" />
          <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-controls="mobile-nav" aria-label={open ? t.close : t.menu}
            className="inline-flex size-9 items-center justify-center rounded-full border border-border text-fg-muted hover:bg-surface-hover hover:text-fg md:hidden">
            <span aria-hidden className="text-lg leading-none">{open ? "×" : "≡"}</span>
          </button>
        </div>
      </div>
      {open && (
        <nav id="mobile-nav" aria-label="Primary" className="border-t border-border bg-bg-elevated md:hidden">
          <ul className="mx-auto flex max-w-wide flex-col px-5 py-3 sm:px-8">
            {navItems.map((n) => (
              <li key={n.key}><NavLink to={localized(lang, n.path)} className={({ isActive }) => cx("block rounded-md px-3 py-2.5 text-base", isActive ? "text-fg" : "text-fg-muted")}>{t.nav[n.key]}</NavLink></li>
            ))}
            <li><a href={GITHUB_REPO} target="_blank" rel="noreferrer noopener" className="block rounded-md px-3 py-2.5 text-base text-fg-muted">{t.nav.github} ↗</a></li>
            <li className="flex items-center justify-between px-3 py-2.5 sm:hidden"><span className="text-sm text-fg-subtle">{t.theme.label}</span><ThemeToggle /></li>
          </ul>
        </nav>
      )}
    </header>
  );
}
