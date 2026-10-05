import { useCallback, useState } from "react";
import type { Route } from "./+types/route";
import { DEFAULT_LANG, isLang, useMessages } from "~/i18n/core";
import { Badge, Button, Card } from "~/design-system/components";
import { sync, SyncError } from "~/lib/sync";
import { AccountShell, ErrorNote, ago, errorText, useLoad } from "../shell";
import { accountMessages } from "../i18n";
import { messages } from "./i18n";

export const meta: Route.MetaFunction = ({ params }) => {
  const m = accountMessages[isLang(params.lang) ? params.lang : DEFAULT_LANG];
  return [{ title: m.title }, { name: "description", content: m.description }, { name: "robots", content: "noindex" }];
};

export default function ConsoleSignIns() {
  const t = useMessages(messages);
  return <AccountShell heading={t.heading} lead={t.lead}>{() => <List />}</AccountShell>;
}

function List() {
  const t = useMessages(messages);
  const s = useMessages(accountMessages);
  const load = useCallback(() => sync.account(), []);
  const [state, reload] = useLoad(load);
  const [error, setError] = useState<SyncError | null>(null);
  if (state.status === "loading") return <p className="text-fg-muted">{s.state.loading}</p>;
  if (state.status === "error") return <ErrorNote error={state.error} onRetry={reload} />;
  const list = state.data.consoles;
  if (!list.length) return <Card><p className="text-fg-muted">{t.empty}</p></Card>;
  return (
    <Card className="flex flex-col gap-2">
      {error && <p className="text-danger">{errorText(s, error)}</p>}
      <ul className="flex flex-col divide-y divide-border">
        {list.map((c) => (
          <li key={c.id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-2"><span className="text-sm text-fg-muted">{t.from}</span><span className="font-medium text-fg">{c.body}</span>{c.current && <Badge tone="accent">{t.current}</Badge>}</div>
              <p className="text-sm text-fg-subtle">{t.since} {ago(s.time, c.created)} · {t.used} {ago(s.time, c.lastUsed)}</p>
            </div>
            <Button variant="ghost" size="sm" className="text-danger"
              onClick={async () => { setError(null); try { await sync.revokeConsole(c.id); reload(); } catch (e) { setError(e instanceof SyncError ? e : new SyncError("network")); } }}>
              {t.revoke}
            </Button>
          </li>
        ))}
      </ul>
    </Card>
  );
}
