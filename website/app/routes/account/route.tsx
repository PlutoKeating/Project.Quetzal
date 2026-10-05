import { useCallback, useState } from "react";
import type { Route } from "./+types/route";
import { DEFAULT_LANG, isLang, useMessages } from "~/i18n/core";
import { Badge, Button, Card, Heading, StatusDot } from "~/design-system/components";
import { sync, SyncError, type AccountAgent, type AccountBody } from "~/lib/sync";
import { AccountShell, ErrorNote, ago, errorText, useLoad } from "./shell";
import { accountMessages, messages } from "./i18n";

export const meta: Route.MetaFunction = ({ params }) => {
  const m = accountMessages[isLang(params.lang) ? params.lang : DEFAULT_LANG];
  return [{ title: m.title }, { name: "description", content: m.description }, { name: "robots", content: "noindex" }];
};

export default function AccountOverview() {
  const t = useMessages(messages);
  return (
    <AccountShell heading={t.heading} lead={t.lead}>
      {() => <Agents />}
    </AccountShell>
  );
}

function Agents() {
  const t = useMessages(messages);
  const s = useMessages(accountMessages);
  const load = useCallback(() => sync.account(), []);
  const [state, reload] = useLoad(load);
  if (state.status === "loading") return <p className="text-fg-muted">{s.state.loading}</p>;
  if (state.status === "error") return <ErrorNote error={state.error} onRetry={reload} />;
  const { agents, limits } = state.data;
  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-fg-subtle">{t.count.replace("{agents}", String(agents.length)).replace("{maxAgents}", String(limits.agents)).replace("{maxBodies}", String(limits.bodies))}</p>
      {!agents.length && <Card><p className="text-fg-muted">{t.empty}</p></Card>}
      {agents.map((a) => <AgentCard key={a.id} agent={a} onChanged={reload} />)}
    </div>
  );
}

/** 两步确认：先点按钮，再在同一处确认或取消。 */
function Confirmable({ label, prompt, onConfirm }: { label: string; prompt: string; onConfirm: () => Promise<void> }) {
  const t = useMessages(messages);
  const s = useMessages(accountMessages);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<SyncError | null>(null);
  if (!open) return <Button variant="ghost" size="sm" className="text-danger" onClick={() => setOpen(true)}>{label}</Button>;
  return (
    <div className="flex flex-col items-start gap-2 rounded-md border border-border p-3">
      <p className="text-sm text-fg">{prompt}</p>
      {error && <p className="text-sm text-danger">{errorText(s, error)}</p>}
      <div className="flex gap-2">
        <Button variant="secondary" size="sm" className="text-danger" disabled={busy}
          onClick={async () => { setBusy(true); setError(null); try { await onConfirm(); } catch (e) { setError(e instanceof SyncError ? e : new SyncError("network")); setBusy(false); } }}>
          {t.confirm}
        </Button>
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => { setOpen(false); setError(null); }}>{t.cancel}</Button>
      </div>
    </div>
  );
}

function AgentCard({ agent, onChanged }: { agent: AccountAgent; onChanged: () => void }) {
  const t = useMessages(messages);
  return (
    <Card className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <Heading as="h2" size="sm">{agent.name}</Heading>
        <span className="font-mono text-xs text-fg-subtle">{agent.id}</span>
      </div>
      {agent.bodies.length ? (
        <ul className="flex flex-col divide-y divide-border">
          {agent.bodies.map((b) => <BodyRow key={b.body} agent={agent} body={b} onChanged={onChanged} />)}
        </ul>
      ) : <p className="text-sm text-fg-muted">{t.noBodies}</p>}
      <div>
        <Confirmable label={t.removeAgent} prompt={t.confirmRemoveAgent.replace("{name}", agent.name)}
          onConfirm={async () => { await sync.removeAgent(agent.id); onChanged(); }} />
      </div>
    </Card>
  );
}

function BodyRow({ agent, body: b, onChanged }: { agent: AccountAgent; body: AccountBody; onChanged: () => void }) {
  const t = useMessages(messages);
  const s = useMessages(accountMessages);
  return (
    <li className="flex flex-col gap-2 py-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <StatusDot alive={b.online} />
          <span className="font-medium text-fg">{b.body}</span>
          <Badge tone={b.kind === "bridge" ? "secondary" : "neutral"}>{s.kind[b.kind] ?? b.kind}</Badge>
          {b.version && <span className="text-xs text-fg-subtle">{b.version}</span>}
        </div>
        <p className="text-sm text-fg-muted">{b.online ? t.online : `${t.lastSeen} ${ago(s.time, b.lastSeen)}`}</p>
        <p className="font-mono text-xs text-fg-subtle">{t.key} {b.fingerprint}</p>
      </div>
      <Confirmable label={t.removeBody} prompt={t.confirmRemoveBody.replace("{body}", b.body)}
        onConfirm={async () => { await sync.removeBody(agent.id, b.body); onChanged(); }} />
    </li>
  );
}
