import { NavLink } from "react-router";
import { useMessages } from "~/i18n/core";
import { cx } from "~/design-system/components";
import type { NavSection } from "~/lib/docs";
import { DocsSearch } from "./Search";
import { messages } from "./i18n";

export function DocsSidebar({ nav, currentPath, onNavigate }: { nav: NavSection[]; currentPath: string; onNavigate?: () => void }) {
  const t = useMessages(messages);
  return (
    <nav aria-label={t.navLabel} className="flex flex-col gap-6">
      <DocsSearch onNavigate={onNavigate} />
      {nav.map((s) => (
        <div key={s.id}>
          <p className="mb-2 px-2 text-xs font-medium uppercase tracking-wide text-fg-subtle">{s.title}</p>
          <ul className="flex flex-col gap-0.5 border-l border-border">
            {s.pages.map((p) => {
              const active = p.path === currentPath;
              return (
                <li key={p.slug}>
                  <NavLink
                    to={p.path}
                    onClick={onNavigate}
                    aria-current={active ? "page" : undefined}
                    className={cx(
                      "-ml-px block border-l py-1.5 pl-4 pr-2 text-sm transition-colors duration-(--ds-duration-fast)",
                      active ? "border-fg text-fg" : "border-transparent text-fg-muted hover:border-border-strong hover:text-fg",
                    )}
                  >
                    {p.title}
                  </NavLink>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}
