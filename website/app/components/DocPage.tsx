import type { Messages } from "~/lib/content";
import { langFromPath, useLang } from "~/i18n/core";
import { DocShell } from "./DocShell";

/** 文档页共用的外壳：语言由路径决定，正文来自本页的 i18n.ts。 */
export function DocPage({ path, messages }: { path: string; messages: Messages }) {
  const lang = useLang();
  return <DocShell path={path} doc={messages[lang].doc} />;
}

/** 每页的 title / description / OpenGraph；location 由 react-router 注入。 */
export function docMeta(messages: Messages, location: { pathname: string }) {
  const m = messages[langFromPath(location.pathname)];
  return [
    { title: `${m.metaTitle} · Quetzalcoatl` },
    { name: "description", content: m.doc.description },
    { property: "og:title", content: m.metaTitle },
    { property: "og:description", content: m.doc.description },
  ];
}
