import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { useLang, useMessages } from "~/i18n/core";
import { cx } from "~/design-system/components";
import { messages } from "./i18n";

interface PagefindResult { data: () => Promise<{ url: string; excerpt: string; meta: { title?: string } }> }
interface Pagefind { init?: () => Promise<void>; search: (q: string) => Promise<{ results: PagefindResult[] }> }
type Hit = { url: string; excerpt: string; title: string };

let pagefindPromise: Promise<Pagefind | null> | null = null;
/** 构建后 /pagefind/pagefind.js 才存在（npx pagefind --site build/client）；dev 下 import 失败则返回 null。 */
function loadPagefind(): Promise<Pagefind | null> {
  pagefindPromise ??= import(/* @vite-ignore */ `${""}/pagefind/pagefind.js`)
    .then(async (pf: Pagefind) => { await pf.init?.(); return pf; })
    .catch(() => null);
  return pagefindPromise;
}

export function DocsSearch({ onNavigate }: { onNavigate?: () => void }) {
  const t = useMessages(messages);
  const lang = useLang();
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const query = q.trim();
    if (!query) { setHits(null); return; }
    let alive = true;
    const timer = setTimeout(async () => {
      const pf = await loadPagefind();
      if (!alive) return;
      if (!pf) { setUnavailable(true); setHits([]); return; }
      const res = await pf.search(query);
      const data = await Promise.all(res.results.slice(0, 12).map((r) => r.data()));
      if (!alive) return;
      const prefix = `/${lang}/`;
      setHits(data.filter((d) => d.url.startsWith(prefix)).slice(0, 8).map((d) => ({ url: d.url.replace(/\/$/, ""), excerpt: d.excerpt, title: d.meta.title ?? d.url })));
    }, 160);
    return () => { alive = false; clearTimeout(timer); };
  }, [q, lang]);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  return (
    <div ref={box} className="relative">
      <input
        type="search"
        value={q}
        onChange={(e) => { setQ(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        placeholder={t.searchPlaceholder}
        aria-label={t.searchLabel}
        className="h-9 w-full rounded-md border border-border bg-bg px-3 text-sm text-fg placeholder:text-fg-subtle transition-colors duration-(--ds-duration-fast) hover:border-border-strong focus:border-border-strong focus:outline-none focus-visible:shadow-ring"
      />
      {open && hits && (
        <div className={cx("absolute inset-x-0 top-full z-10 mt-1 max-h-96 overflow-y-auto rounded-md border border-border bg-bg-elevated p-1")}>
          {unavailable ? (
            <p className="px-3 py-2 text-xs text-fg-subtle">{t.searchHint}</p>
          ) : hits.length === 0 ? (
            <p className="px-3 py-2 text-xs text-fg-subtle">{t.searchEmpty}</p>
          ) : (
            <ul>
              {hits.map((h) => (
                <li key={h.url}>
                  <Link to={h.url} onClick={() => { setOpen(false); onNavigate?.(); }} className="block rounded-sm px-3 py-2 transition-colors duration-(--ds-duration-fast) hover:bg-surface-hover">
                    <span className="block text-sm text-fg">{h.title}</span>
                    <span className="md-excerpt block text-xs text-fg-muted [&_mark]:bg-accent-soft [&_mark]:text-fg" dangerouslySetInnerHTML={{ __html: h.excerpt }} />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
