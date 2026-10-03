import { LANGS, LANG_LABEL } from "~/i18n/core";

export function NotFound() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-prose flex-col items-center justify-center gap-4 p-6 text-center">
      <p className="text-6xl font-semibold tracking-tight">404</p>
      <p className="text-fg-muted">页面不存在 · Page not found</p>
      <ul className="flex gap-6">
        {LANGS.map((l) => (
          <li key={l}><a className="text-accent underline-offset-4 hover:underline" href={`/${l}`}>{LANG_LABEL[l]}</a></li>
        ))}
      </ul>
    </main>
  );
}
