import { Link } from "react-router";
import { localized, useLang } from "~/i18n/core";
import { LangSwitch } from "./LangSwitch";

/** 顶栏骨架：后续补导航与移动端菜单。 */
export function SiteHeader() {
  const lang = useLang();
  return (
    <header className="sticky top-0 z-10 border-b border-border bg-surface-glass backdrop-blur-glass">
      <div className="mx-auto flex h-(--ds-header-height) max-w-content items-center justify-between px-4 sm:px-6">
        <Link to={localized(lang, "/")} className="text-lg font-semibold tracking-tight">Windler</Link>
        <LangSwitch />
      </div>
    </header>
  );
}
