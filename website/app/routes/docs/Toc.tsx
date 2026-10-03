import { useEffect, useState } from "react";
import { useMessages } from "~/i18n/core";
import { cx } from "~/design-system/components";
import type { HeadingItem } from "~/components/markdown/Markdown";
import { messages } from "./i18n";

/** 本页目录：h2 / h3，随滚动高亮当前所在小节。 */
export function DocsToc({ headings }: { headings: HeadingItem[] }) {
  const t = useMessages(messages);
  const [active, setActive] = useState<string>("");

  useEffect(() => {
    if (!headings.length || typeof IntersectionObserver === "undefined") return;
    const els = headings.map((h) => document.getElementById(h.id)).filter((e): e is HTMLElement => !!e);
    const visible = new Map<string, number>();
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) visible.set(e.target.id, e.boundingClientRect.top);
        else visible.delete(e.target.id);
      }
      if (visible.size) setActive([...visible.entries()].sort((a, b) => a[1] - b[1])[0][0]);
    }, { rootMargin: "-20% 0px -65% 0px" });
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [headings]);

  if (!headings.length) return null;
  return (
    <nav aria-label={t.onThisPage} className="text-sm">
      <p className="mb-2 text-xs font-medium uppercase tracking-wide text-fg-subtle">{t.onThisPage}</p>
      <ul className="flex flex-col gap-1 border-l border-border">
        {headings.map((h) => (
          <li key={h.id}>
            <a
              href={`#${h.id}`}
              className={cx(
                "-ml-px block border-l py-1 pr-2 transition-colors duration-(--ds-duration-fast)",
                h.depth === 3 ? "pl-6" : "pl-3",
                active === h.id ? "border-fg text-fg" : "border-transparent text-fg-muted hover:text-fg",
              )}
            >
              {h.text}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
