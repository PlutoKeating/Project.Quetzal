import type { Route } from "./+types/route";
import { useMessages, isLang, DEFAULT_LANG } from "~/i18n/core";
import { messages } from "./i18n";

export const meta: Route.MetaFunction = ({ params }) => {
  const m = messages[isLang(params.lang) ? params.lang : DEFAULT_LANG];
  return [{ title: m.title }, { name: "description", content: m.description }];
};

export default function Home() {
  const t = useMessages(messages);
  return (
    <main className="mx-auto flex max-w-content flex-col items-center justify-center gap-6 px-4 py-24 text-center sm:px-6 landscape:short:py-10">
      <h1 className="max-w-3xl text-4xl font-semibold tracking-tight sm:text-5xl lg:text-6xl">{t.heroTitle}</h1>
      <p className="max-w-prose text-lg text-fg-muted">{t.heroLead}</p>
      <p className="rounded-full bg-accent-soft px-4 py-1 text-sm text-accent">{t.building}</p>
    </main>
  );
}
