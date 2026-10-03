import { Outlet, useParams } from "react-router";
import { isLang } from "~/i18n/core";
import { NotFound } from "~/components/NotFound";
import { SiteHeader } from "~/components/SiteHeader";
import { SiteFooter } from "~/components/SiteFooter";

/** /:lang 之下所有页面共用的壳：顶栏、页脚、语言校验。 */
export default function LangLayout() {
  const { lang } = useParams();
  if (!isLang(lang)) return <NotFound />;
  return (
    <div className="flex min-h-dvh flex-col">
      <SiteHeader />
      <div className="flex-1"><Outlet /></div>
      <SiteFooter />
    </div>
  );
}
