import type { Route } from "./+types/route";
import { useMessages, isLang, DEFAULT_LANG } from "~/i18n/core";
import { messages } from "./i18n";

export const meta: Route.MetaFunction = ({ params }) => [{ title: messages[isLang(params.lang) ? params.lang : DEFAULT_LANG].title }];

export default function Page() {
  const t = useMessages(messages);
  return <main className="mx-auto max-w-content px-4 py-16 sm:px-6"><p className="text-fg-muted">{t.building}</p></main>;
}
