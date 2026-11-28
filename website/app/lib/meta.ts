import { langFromPath } from "~/i18n/core";
import type { Messages } from "~/lib/content";

type MetaTag = { title: string } | { name: string; content: string } | { property: string; content: string };

export function pageMeta(title: string, description: string): MetaTag[] {
  return [
    { title },
    { name: "description", content: description },
    { property: "og:title", content: title },
    { property: "og:description", content: description },
  ];
}

/** 文档页的 title / description / OpenGraph；location 由 react-router 注入。 */
export function docMeta(messages: Messages, location: { pathname: string }): MetaTag[] {
  const m = messages[langFromPath(location.pathname)];
  return pageMeta(`${m.metaTitle} · Quetzalcoatl`, m.doc.lead);
}
