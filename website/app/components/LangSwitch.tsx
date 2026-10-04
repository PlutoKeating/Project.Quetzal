import { Link, useLocation } from "react-router";
import { LANGS, LANG_LABEL, storeLang, switchLangPath, useLang } from "~/i18n/core";

export function LangSwitch() {
  const lang = useLang();
  const { pathname } = useLocation();
  return (
    <nav aria-label="Language" className="flex items-center gap-1 rounded-full border border-border p-1 text-sm">
      {LANGS.map((l) => (
        <Link
          key={l}
          to={switchLangPath(pathname, l)}
          onClick={() => storeLang(l)}
          hrefLang={l}
          aria-current={l === lang ? "true" : undefined}
          className={`whitespace-nowrap rounded-full px-2.5 py-1 transition-colors duration-(--ds-duration-fast) sm:px-3 ${l === lang ? "bg-accent text-accent-fg" : "text-fg-muted hover:text-fg"}`}
        >
          {LANG_LABEL[l]}
        </Link>
      ))}
    </nav>
  );
}
