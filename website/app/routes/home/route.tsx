import { Link, useLocation } from "react-router";
import { GITHUB_URL, localized, useChrome, useLang } from "~/i18n/core";
import { messages } from "./i18n";

export function meta({ location }: { location: { pathname: string } }) {
  const lang = location.pathname === "/en" || location.pathname.startsWith("/en/") ? "en" : "zh";
  const m = messages[lang];
  return [
    { title: m.metaTitle },
    { name: "description", content: m.metaDescription },
    { property: "og:title", content: m.metaTitle },
    { property: "og:description", content: m.metaDescription },
  ];
}

export default function Home() {
  const { pathname } = useLocation();
  const lang = useLang();
  const t = useChrome().t;
  const m = messages[lang];
  const link = (path: string) => localized(lang, path);
  return (
    <>
      <section className="hero">
        <div className="wrap hero-grid">
          <div>
            <p className="eyebrow">{m.eyebrow}</p>
            <h1>{m.title}</h1>
            <p className="lead">{m.lead}</p>
            <div className="hero-actions">
              <Link to={link("/docs/start/install")} className="btn">
                {m.primaryCta}
              </Link>
              <Link to={link("/download")} className="btn ghost">
                {m.secondaryCta}
              </Link>
            </div>
          </div>
          <aside className="hero-aside">
            <h2>{m.factsTitle}</h2>
            <ul>
              {m.facts.map((fact) => (
                <li key={fact.label}>
                  <span>{fact.label}</span>
                  <code className="ok">{fact.value}</code>
                </li>
              ))}
            </ul>
          </aside>
        </div>
      </section>

      <section className="section">
        <div className="wrap">
          <div className="section-head">
            <h2>{m.pillarsTitle}</h2>
            <p>{m.pillarsLead}</p>
          </div>
          <div className="grid">
            {m.pillars.map((pillar) => (
              <div className="card" key={pillar.title}>
                <span className="kicker">{pillar.kicker}</span>
                <h3>{pillar.title}</h3>
                <p>{pillar.text}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="section">
        <div className="wrap">
          <div className="section-head">
            <h2>{m.surfacesTitle}</h2>
            <p>{m.surfacesLead}</p>
          </div>
          <div className="grid two">
            {m.surfaces.map((surface) => (
              <div className="card" key={surface.name}>
                <span className="kicker">{surface.stack}</span>
                <h3>{surface.name}</h3>
                <p>{surface.text}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="section">
        <div className="wrap">
          <div className="section-head">
            <h2>{m.installTitle}</h2>
            <p>{m.installLead}</p>
          </div>
          <div className="codeblock">
            <div className="codeblock-head">
              <span>shell</span>
              <span>{pathname.startsWith("/en") ? "Linux / macOS" : "Linux / macOS"}</span>
            </div>
            <pre>
              <code>{m.installCode}</code>
            </pre>
          </div>
          <div className="hero-actions">
            <Link to={link("/docs/start/install")} className="btn">
              {t.download.guide}
            </Link>
            <a href={`${GITHUB_URL}#readme`} className="btn ghost" rel="noreferrer noopener">
              {t.nav.source}
            </a>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="wrap">
          <div className="section-head">
            <h2>{m.trustTitle}</h2>
            <p>{m.trustText}</p>
          </div>
          <p>
            <Link to={link("/docs/reference/release-signing")}>{m.trustCta} →</Link>
          </p>
        </div>
      </section>

      <section className="section">
        <div className="wrap">
          <h2>{m.ctaTitle}</h2>
          <p style={{ color: "inherit", maxWidth: "60ch" }}>{m.ctaText}</p>
          <p>
            <Link to={link("/docs/start/install")} className="btn">
              {m.ctaButton}
            </Link>
          </p>
        </div>
      </section>
    </>
  );
}
