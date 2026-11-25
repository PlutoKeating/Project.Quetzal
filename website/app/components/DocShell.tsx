import type { ReactNode } from "react";
import { Link, useLocation } from "react-router";
import { localized, useChrome } from "~/i18n/core";
import { DOC_NAV, docIndex, navGroups } from "~/lib/pages";
import { Blocks } from "./Blocks";
import type { Doc } from "~/lib/content";

const SECTION_LABEL = { start: "start", guide: "guide", advanced: "advanced", reference: "reference" } as const;

export function DocShell({ path, doc, children }: { path: string; doc: Doc; children?: ReactNode }) {
  const { t, lang } = useChrome();
  const { pathname } = useLocation();
  const groups = navGroups();
  const index = docIndex(path);
  const prev = index > 0 ? DOC_NAV[index - 1] : undefined;
  const next = index >= 0 && index < DOC_NAV.length - 1 ? DOC_NAV[index + 1] : undefined;
  return (
    <div className="wrap doc-shell">
      <aside className="doc-side" aria-label={lang === "zh" ? "文档目录" : "Documentation"}>
        {groups.map((group) => (
          <div key={group.section}>
            <h2>{t.docsSections[SECTION_LABEL[group.section]]}</h2>
            <ul>
              {group.items.map((item) => {
                const to = localized(lang, item.path);
                return (
                  <li key={item.path}>
                    <Link to={to} aria-current={pathname === to ? "page" : undefined}>
                      {item.label[lang]}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </aside>
      <article className="prose">
        <div className="doc-title">
          <h1>{doc.title}</h1>
          <p>{doc.description}</p>
        </div>
        <p className="lead">{doc.lead}</p>
        <Blocks blocks={doc.blocks} />
        {children}
        <nav className="doc-foot" aria-label={lang === "zh" ? "上一页与下一页" : "Previous and next"}>
          <span>
            {prev ? (
              <Link to={localized(lang, prev.path)}>
                ← {t.prev}: {prev.label[lang]}
              </Link>
            ) : null}
          </span>
          <span>
            {next ? (
              <Link to={localized(lang, next.path)}>
                {t.next}: {next.label[lang]} →
              </Link>
            ) : null}
          </span>
        </nav>
      </article>
    </div>
  );
}
