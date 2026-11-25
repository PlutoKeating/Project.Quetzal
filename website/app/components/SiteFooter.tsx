import { Link } from "react-router";
import { GITHUB_URL, localized, useChrome } from "~/i18n/core";
import { Orb } from "./SiteHeader";

export function SiteFooter() {
  const { t, lang } = useChrome();
  const link = (path: string) => localized(lang, path);
  return (
    <footer className="site-foot">
      <div className="wrap">
        <div className="foot-grid">
          <div>
            <Link to={link("/")} className="brand">
              <Orb size={18} />
              <span>Quetzalcoatl</span>
            </Link>
            <p style={{ color: "inherit", maxWidth: "34ch" }}>{t.brandNote}</p>
          </div>
          <div>
            <h2>{t.footer.product}</h2>
            <ul>
              <li>
                <Link to={link("/download")}>{t.footer.download}</Link>
              </li>
              <li>
                <Link to={link("/docs/start/install")}>{t.footer.install}</Link>
              </li>
              <li>
                <Link to={link("/docs")}>{t.footer.docs}</Link>
              </li>
            </ul>
          </div>
          <div>
            <h2>{t.footer.learn}</h2>
            <ul>
              <li>
                <Link to={link("/docs/guide/trust")}>{t.footer.trust}</Link>
              </li>
              <li>
                <Link to={link("/docs/guide/multi-body")}>{t.footer.multiBody}</Link>
              </li>
            </ul>
          </div>
          <div>
            <h2>{t.footer.reference}</h2>
            <ul>
              <li>
                <Link to={link("/docs/reference/release-signing")}>{t.footer.signing}</Link>
              </li>
              <li>
                <Link to={link("/docs/reference/spine-backup")}>{t.footer.backup}</Link>
              </li>
              <li>
                <a href={GITHUB_URL} rel="noreferrer noopener">
                  {t.footer.source}
                </a>
              </li>
            </ul>
          </div>
        </div>
        <div className="foot-bottom">
          <span>© {new Date().getFullYear()} Project Quetzalcoatl · {t.footer.license}</span>
          <span>{t.footer.signing}: Ed25519</span>
        </div>
      </div>
    </footer>
  );
}
