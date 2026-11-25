import { Link, useLocation } from "react-router";
import { localized, useChrome, useLang } from "~/i18n/core";

export function meta({ location }: { location: { pathname: string } }) {
  const lang = location.pathname === "/en" || location.pathname.startsWith("/en/") ? "en" : "zh";
  return [
    { title: lang === "zh" ? "页面不存在 · Quetzalcoatl" : "Not found · Quetzalcoatl" },
    { name: "robots", content: "noindex" },
  ];
}

export default function NotFound() {
  const lang = useLang();
  const { pathname } = useLocation();
  const { t } = useChrome();
  return (
    <div className="wrap not-found">
      <p className="eyebrow">Quetzalcoatl</p>
      <h1>404</h1>
      <p style={{ color: "inherit" }}>{lang === "zh" ? "这条路径上没有脊柱。" : "There is no spine on this path."}</p>
      <p>
        <Link to={localized(lang, "/")}>{t.nav.home}</Link>
        {" · "}
        <Link to={localized(lang, "/docs")}>{t.nav.docs}</Link>
        {" · "}
        <Link to={localized(lang, "/download")} aria-current={pathname === localized(lang, "/download") ? "page" : undefined}>
          {t.nav.download}
        </Link>
      </p>
    </div>
  );
}
