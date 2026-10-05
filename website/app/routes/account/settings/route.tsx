import { useState } from "react";
import type { Route } from "./+types/route";
import { DEFAULT_LANG, isLang, useMessages } from "~/i18n/core";
import { Button, Card, Heading } from "~/design-system/components";
import { sync, SyncError } from "~/lib/sync";
import { AccountShell, errorText } from "../shell";
import { accountMessages } from "../i18n";
import { messages } from "./i18n";

export const meta: Route.MetaFunction = ({ params }) => {
  const m = accountMessages[isLang(params.lang) ? params.lang : DEFAULT_LANG];
  return [{ title: m.title }, { name: "description", content: m.description }, { name: "robots", content: "noindex" }];
};

export default function AccountSettings() {
  const t = useMessages(messages);
  const [done, setDone] = useState<string | null>(null);
  if (done) return <AccountShell heading={t.heading}>{() => <Card><p className="text-fg">{done}</p></Card>}</AccountShell>;
  return <AccountShell heading={t.heading}>{(session) => <Settings login={session.user.login} onDone={setDone} />}</AccountShell>;
}

function Settings({ login, onDone }: { login: string; onDone: (msg: string) => void }) {
  const t = useMessages(messages);
  const s = useMessages(accountMessages);
  const [sure, setSure] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<SyncError | null>(null);
  const run = async (f: () => Promise<unknown>, msg: string) => {
    setBusy(true); setError(null);
    try { await f(); onDone(msg); window.location.reload(); }
    catch (e) { setError(e instanceof SyncError ? e : new SyncError("network")); setBusy(false); }
  };
  return (
    <div className="flex max-w-prose flex-col gap-6">
      {error && <p className="text-danger">{errorText(s, error)}</p>}
      <Card className="flex flex-col gap-2">
        <Heading as="h2" size="sm">{t.profileHeading}</Heading>
        <p className="font-mono text-sm text-fg">{login}</p>
        <p className="text-sm text-fg-muted">{t.profile}</p>
      </Card>
      <Card className="flex flex-col items-start gap-3">
        <Heading as="h2" size="sm">{t.logoutHeading}</Heading>
        <Button variant="secondary" disabled={busy} onClick={() => void run(sync.logout, t.logoutDone)}>{t.logout}</Button>
      </Card>
      <Card className="flex flex-col items-start gap-3">
        <Heading as="h2" size="sm">{t.revokeAllHeading}</Heading>
        <p className="text-sm text-fg-muted">{t.revokeAllText}</p>
        <Button variant="secondary" disabled={busy} onClick={() => void run(sync.revokeAllSessions, t.revokeAllDone)}>{t.revokeAll}</Button>
      </Card>
      <Card className="flex flex-col items-start gap-3">
        <Heading as="h2" size="sm">{t.deleteHeading}</Heading>
        <p className="text-sm text-fg-muted">{t.deleteText}</p>
        <label className="flex items-center gap-2 text-sm text-fg"><input type="checkbox" checked={sure} onChange={(e) => setSure(e.target.checked)} />{t.deleteConfirm}</label>
        <Button variant="secondary" className="text-danger" disabled={!sure || busy} onClick={() => void run(sync.deleteAccount, t.deleted)}>{t.delete}</Button>
      </Card>
    </div>
  );
}
