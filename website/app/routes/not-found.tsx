import { Link } from "react-router";
import { ArrowRight } from "~/components/icons";
import { chrome, langFromPath, localized, useLang } from "~/i18n/core";

export function meta({ location }: { location: { pathname: string } }) {
  const t = chrome[langFromPath(location.pathname)];
  return [{ title: `${t.notFound.metaTitle} · Quetzalcoatl` }, { name: "robots", content: "noindex" }];
}

/** 这一页只有一件事可做：回到首页。所以白色主按钮在这里。 */
export default function NotFound() {
  const lang = useLang();
  const t = chrome[lang];
  return (
    <section className="qz-hero" data-qz-lit>
      <div className="qz-container qz-hero-inner">
        <p className="qz-meta" dir="ltr">
          404
        </p>
        <h1 className="qz-display">{t.notFound.title}</h1>
        <p className="qz-lead">{t.notFound.lead}</p>
        <div className="qz-action-stack">
          <div className="qz-action-row">
            <Link to={localized(lang, "/")} className="qz-btn-white">
              {t.notFound.home}
            </Link>
            <Link to={localized(lang, "/docs")} className="qz-link-arrow">
              <span>{t.notFound.docs}</span>
              <ArrowRight />
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}
