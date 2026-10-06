import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import type { Route } from "./+types/route";
import { DEFAULT_LANG, HTML_LANG, isLang, useLang, useMessages } from "~/i18n/core";
import { Badge, Button, Card, Heading } from "~/design-system/components";
import { formatCode, sync, SyncError, type PendingCode } from "~/lib/sync";
import { AccountShell, ago, errorText } from "../shell";
import { accountMessages } from "../i18n";
import { messages } from "./i18n";

export const meta: Route.MetaFunction = ({ params }) => {
  const m = accountMessages[isLang(params.lang) ? params.lang : DEFAULT_LANG];
  return [{ title: m.title }, { name: "description", content: m.description }, { name: "robots", content: "noindex" }];
};

export default function ApproveDevice() {
  const t = useMessages(messages);
  return (
    <AccountShell heading={t.heading} lead={t.lead}>
      {() => <Flow />}
    </AccountShell>
  );
}

type Step =
  | { s: "enter"; error?: SyncError }
  | { s: "checking" }
  | { s: "confirm"; p: PendingCode; error?: SyncError; busy?: boolean }
  | { s: "done"; p: PendingCode; approved: boolean }
  | { s: "redirecting" }
  | { s: "soul"; result: string; repo?: string; reason?: string };

function Flow() {
  const t = useMessages(messages);
  const a = useMessages(accountMessages);
  const lang = useLang();
  const [params] = useSearchParams();
  const [code, setCode] = useState(formatCode(params.get("code") ?? ""));
  // 从 GitHub 回来（同步服务把人送回 /device?soul=…）：直接显示结果
  const soul = params.get("soul");
  const [step, setStep] = useState<Step>(soul ? { s: "soul", result: soul, repo: params.get("repo") ?? undefined, reason: params.get("reason") ?? undefined } : { s: "enter" });
  const [agent, setAgent] = useState<string>("");

  const lookup = async (c: string) => {
    setStep({ s: "checking" });
    try { setStep({ s: "confirm", p: await sync.lookup(c) }); }
    catch (e) { setStep({ s: "enter", error: e instanceof SyncError ? e : new SyncError("network") }); }
  };
  // 从身体给的链接进来（带 code）：直接核对
  useEffect(() => { if (code.length === 9 && !soul) void lookup(code); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const decide = async (p: PendingCode, approve: boolean) => {
    setStep({ s: "confirm", p, busy: true });
    const pick = p.choose ? (p.choose.length ? agent || p.choose[0].id : "new") : undefined;
    try {
      const r = await sync.decide(p.code, approve, pick);
      if (r.next) { setStep({ s: "redirecting" }); window.location.assign(r.next); return; } // 同一个标签页经 GitHub 跳一次，加完部署密钥回到这里
      setStep({ s: "done", p, approved: approve });
    }
    catch (e) { setStep({ s: "confirm", p, error: e instanceof SyncError ? e : new SyncError("network") }); }
  };

  if (step.s === "redirecting") return <Card className="max-w-prose"><p className="text-fg-muted">{t.redirecting}</p></Card>;
  if (step.s === "soul") {
    const text = step.result === "linked" ? t.linked.replace("{repo}", step.repo ?? "") : step.result === "failed" ? t.linkFailed.replace("{reason}", step.reason ?? "") : step.result === "unavailable" ? t.linkUnavailable : t.linkExpired;
    return <Card className="max-w-prose"><p className={step.result === "linked" ? "text-fg" : "text-danger"}>{text}</p></Card>;
  }
  if (step.s === "enter" || step.s === "checking") {
    return (
      <Card className="max-w-prose">
        <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); if (code.length === 9) void lookup(code); }}>
          <label className="flex flex-col gap-2">
            <span className="text-sm text-fg-muted">{t.code}</span>
            <input value={code} onChange={(e) => setCode(formatCode(e.target.value))} placeholder={t.placeholder} autoComplete="off" autoCapitalize="characters" spellCheck={false} inputMode="text" autoFocus
              className="h-12 rounded-md border border-border-strong bg-bg px-4 font-mono text-xl tracking-widest text-fg placeholder:text-fg-subtle focus-visible:shadow-ring focus-visible:outline-none" />
          </label>
          {step.s === "enter" && step.error && <p className="text-danger">{errorText(a, step.error)}</p>}
          <div><Button type="submit" variant="primary" disabled={code.length !== 9 || step.s === "checking"}>{step.s === "checking" ? t.checking : t.next}</Button></div>
        </form>
      </Card>
    );
  }

  const p = step.p;
  if (step.s === "done") {
    return (
      <Card className="flex max-w-prose flex-col items-start gap-4">
        <p className={step.approved ? "text-fg" : "text-fg-muted"}>{step.approved ? (p.kind === "console" ? t.approvedConsole : t.approved).replace("{body}", p.body) : t.denied}</p>
        <Button variant="secondary" size="sm" onClick={() => { setCode(""); setStep({ s: "enter" }); }}>{t.another}</Button>
      </Card>
    );
  }
  // 时间：同步服务给毫秒；万一是秒（小于 1e12）也认
  const when = (v: number) => { const ms = v < 1e12 ? v * 1000 : v; return <>{new Date(ms).toLocaleString(HTML_LANG[lang])} <span className="text-sm text-fg-subtle">{ago(a.time, ms)}</span></>; };
  const row = (k: string, v: React.ReactNode) => (<><dt className="text-sm text-fg-muted">{k}</dt><dd className="text-fg">{v}</dd></>);
  return (
    <Card className="flex max-w-prose flex-col gap-5">
      <Heading as="h2" size="sm">{t.confirmHeading}</Heading>
      {p.check && (
        <div className="flex flex-col gap-1">
          <span className="text-sm text-fg-muted">{t.check}</span>
          <span className="text-4xl tracking-widest" aria-label={t.check}>{p.check}</span>
          <span className="text-sm text-fg-muted">{t.checkHint}</span>
        </div>
      )}
      <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-6 gap-y-2"> {/* ds-allow：两列布局，不是视觉参数 */}
        {!p.choose && row(t.agent, <>{p.agent.name} <span className="font-mono text-xs text-fg-subtle">{p.agent.id.slice(0, 8)}</span></>)}
        {row(t.body, p.body)}
        {row(t.kind, <Badge tone={p.kind === "console" ? "warning" : p.kind === "bridge" ? "secondary" : "neutral"}>{a.kind[p.kind] ?? p.kind}</Badge>)}
        {p.version && row(t.version, p.version)}
        {p.kind !== "console" && row(t.key, <span className="font-mono text-lg tracking-wide">{p.fingerprint}</span>)}
        {p.kind === "console" && p.bodyFingerprint && row(t.bodyKey, <span className="font-mono text-lg tracking-wide">{p.bodyFingerprint}</span>)}
        {p.kind === "console" && typeof p.bodyBoundAt === "number" && row(t.bodyBound, when(p.bodyBoundAt))}
        {p.soulKey && row(t.soulKey, <span className="break-all font-mono text-sm">{p.soulKey}</span>)}
        {typeof p.createdAt === "number" && row(t.created, when(p.createdAt))}
      </dl>
      {p.choose && p.choose.length > 0 && (
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm text-fg-muted">{t.chooseLabel}</legend>
          {[...p.choose.map((x) => ({ id: x.id, label: x.repo ? `${x.name} · ${x.repo}` : x.name })), { id: "new", label: `${t.chooseNew}（${p.agent.name}）` }].map((x) => (
            <label key={x.id} className="flex items-center gap-2 text-fg">
              <input type="radio" name="agent" value={x.id} checked={(agent || p.choose![0].id) === x.id} onChange={() => setAgent(x.id)} />
              {x.label}
            </label>
          ))}
        </fieldset>
      )}
      {p.soulKey && p.soulLink && <p className="text-sm text-fg-muted">{t.soulHint}</p>}
      {p.kind === "console" && p.bodyFingerprint && <p className="text-sm text-fg-muted">{t.bodyKeyHint}</p>}
      {p.kind !== "console" && !p.check && <p className="text-sm text-fg-muted">{t.keyHint}</p>}
      {p.kind === "console" && <p className="rounded-md border border-border p-3 text-sm text-warning">{t.consoleWarn.replace("{body}", p.body)}</p>}
      {p.newAgent && <p className="text-sm text-fg-muted">{t.newAgent}</p>}
      {p.replaces && <p className="text-sm text-warning">{t.replaces}</p>}
      {step.error && <p className="text-danger">{errorText(a, step.error)}</p>}
      <div className="flex gap-3">
        <Button variant="primary" disabled={step.busy} onClick={() => void decide(p, true)}>{t.approve}</Button>
        <Button variant="secondary" className="text-danger" disabled={step.busy} onClick={() => void decide(p, false)}>{t.deny}</Button>
      </div>
    </Card>
  );
}
