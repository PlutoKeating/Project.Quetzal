import type { Route } from "./+types/route";
import { useMessages, isLang, DEFAULT_LANG } from "~/i18n/core";
import { ExternalLink } from "~/design-system/components";
import { Article } from "~/components/Article";
import { GITHUB_ISSUES, GITHUB_REPO, HONOR9_REPO } from "~/components/i18n";
import { messages } from "./i18n";

export const meta: Route.MetaFunction = ({ params }) => {
  const m = messages[isLang(params.lang) ? params.lang : DEFAULT_LANG];
  return [{ title: m.title }, { name: "description", content: m.description }];
};

export default function About() {
  const t = useMessages(messages);
  return (
    <Article eyebrow={t.eyebrow} title={t.heading} lead={t.lead} sections={t.sections}>
      <ul className="flex flex-col gap-2 border-t border-border pt-6 text-sm">
        <li><ExternalLink href={GITHUB_REPO}>{t.links.source} ↗</ExternalLink></li>
        <li><ExternalLink href={HONOR9_REPO}>{t.links.practice} ↗</ExternalLink></li>
        <li><ExternalLink href={GITHUB_ISSUES}>{t.links.issues} ↗</ExternalLink></li>
      </ul>
    </Article>
  );
}
