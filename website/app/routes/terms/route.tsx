import type { Route } from "./+types/route";
import { useMessages, isLang, DEFAULT_LANG } from "~/i18n/core";
import { Article } from "~/components/Article";
import { messages } from "./i18n";

export const meta: Route.MetaFunction = ({ params }) => {
  const m = messages[isLang(params.lang) ? params.lang : DEFAULT_LANG];
  return [{ title: m.title }, { name: "description", content: m.description }];
};

export default function Page() {
  const t = useMessages(messages);
  return <Article eyebrow={t.eyebrow} title={t.heading} lead={t.lead} updated={t.updated} sections={t.sections} />;
}
