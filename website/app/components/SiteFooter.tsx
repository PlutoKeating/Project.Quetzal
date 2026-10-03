import { Link } from "react-router";
import { localized, useLang, useMessages } from "~/i18n/core";
import { Container } from "~/design-system/components";
import { Wordmark } from "./Wordmark";
import { GITHUB_ISSUES, GITHUB_RELEASES, GITHUB_REPO, HONOR9_REPO, shellMessages } from "./i18n";

export function SiteFooter() {
  const lang = useLang();
  const t = useMessages(shellMessages);
  const col = "flex flex-col gap-2.5 text-sm";
  const head = "text-xs font-medium uppercase tracking-wide text-fg-subtle";
  const link = "text-fg-muted transition-colors duration-(--ds-duration-fast) hover:text-fg";
  return (
    <footer className="border-t border-border bg-bg-elevated">
      <Container width="wide" className="grid gap-10 py-12 sm:grid-cols-2 lg:grid-cols-[1.6fr_1fr_1fr_1fr] short:py-8">
        <div className="flex flex-col gap-3">
          <Wordmark />
          <p className="max-w-xs text-sm text-fg-muted">{t.footer.tagline}</p>
          <p className="text-xs text-fg-subtle">© {new Date().getFullYear()} PlutoKeating · {t.footer.license}</p>
        </div>
        <nav aria-label={t.footer.sections} className={col}>
          <p className={head}>{t.footer.sections}</p>
          <Link className={link} to={localized(lang, "/features")}>{t.nav.features}</Link>
          <Link className={link} to={localized(lang, "/docs")}>{t.nav.docs}</Link>
          <Link className={link} to={localized(lang, "/download")}>{t.nav.download}</Link>
        </nav>
        <nav aria-label={t.footer.project} className={col}>
          <p className={head}>{t.footer.project}</p>
          <a className={link} href={GITHUB_REPO} target="_blank" rel="noreferrer noopener">{t.footer.source} ↗</a>
          <a className={link} href={GITHUB_RELEASES} target="_blank" rel="noreferrer noopener">{t.footer.changelog} ↗</a>
          <a className={link} href={GITHUB_ISSUES} target="_blank" rel="noreferrer noopener">{t.footer.issues} ↗</a>
          <a className={link} href={HONOR9_REPO} target="_blank" rel="noreferrer noopener">{t.footer.practice} ↗</a>
        </nav>
        <nav aria-label={t.footer.legal} className={col}>
          <p className={head}>{t.footer.legal}</p>
          <Link className={link} to={localized(lang, "/about")}>{t.footer.about}</Link>
          <Link className={link} to={localized(lang, "/terms")}>{t.footer.terms}</Link>
          <Link className={link} to={localized(lang, "/privacy")}>{t.footer.privacy}</Link>
        </nav>
      </Container>
    </footer>
  );
}
