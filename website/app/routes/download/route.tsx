import { useCallback, useEffect, useState } from "react";
import type { Route } from "./+types/route";
import { DEFAULT_LANG, isLang, localized, useLang, useMessages } from "~/i18n/core";
import { Badge, ButtonAnchor, ButtonLink, Card, Container, Eyebrow, ExternalLink, Heading, Lead, Reveal, Section, cx } from "~/design-system/components";
import { GITHUB_RELEASES } from "~/components/i18n";
import { Markdown } from "~/components/markdown/Markdown";
import { ReleasesError, fetchReleases, findAsset, formatBytes, pickLatest, type FetchError, type Release, type ReleaseAsset } from "~/lib/github";
import { messages } from "./i18n";

export const meta: Route.MetaFunction = ({ params }) => {
  const m = messages[isLang(params.lang) ? params.lang : DEFAULT_LANG];
  return [{ title: m.title }, { name: "description", content: m.description }];
};

const TERMUX_LINKS = {
  termux: "https://f-droid.org/packages/com.termux/",
  api: "https://f-droid.org/packages/com.termux.api/",
  boot: "https://f-droid.org/packages/com.termux.boot/",
} as const;

type State =
  | { status: "loading" }
  | { status: "error"; error: FetchError }
  | { status: "ready"; releases: Release[] };

function useReleases(): [State, () => void] {
  const [state, setState] = useState<State>({ status: "loading" });
  const load = useCallback((force = false) => {
    setState({ status: "loading" });
    fetchReleases({ force })
      .then((releases) => setState({ status: "ready", releases }))
      .catch((e: unknown) => setState({ status: "error", error: e instanceof ReleasesError ? e.detail : { kind: "network" } }));
  }, []);
  useEffect(() => load(), [load]);
  return [state, () => load(true)];
}

export default function Download() {
  const t = useMessages(messages);
  const lang = useLang();
  const [state, retry] = useReleases();
  const fmtDate = (iso: string) => new Intl.DateTimeFormat(lang === "zh" ? "zh-CN" : "en", { dateStyle: "long" }).format(new Date(iso));
  const fmtNum = (n: number) => new Intl.NumberFormat(lang === "zh" ? "zh-CN" : "en").format(n);

  return (
    <>
      <Section tight>
        <Container className="flex flex-col gap-4">
          <Eyebrow>{t.eyebrow}</Eyebrow>
          <Heading as="h1" size="xl">{t.heading}</Heading>
          <Lead className="max-w-prose">{t.lead}</Lead>
        </Container>
      </Section>

      {/* 最新版本 */}
      <Section tight>
        <Container>
          <Eyebrow className="mb-4">{t.latest.eyebrow}</Eyebrow>
          {state.status === "loading" && <LatestSkeleton label={t.state.loading} />}
          {state.status === "error" && <ErrorBlock error={state.error} t={t.state} onRetry={retry} fmtTime={(d) => new Intl.DateTimeFormat(lang === "zh" ? "zh-CN" : "en", { timeStyle: "short" }).format(d)} />}
          {state.status === "ready" && (() => {
            const latest = pickLatest(state.releases);
            if (!latest) return <EmptyBlock label={t.state.empty} go={t.state.goToReleases} />;
            const apk = findAsset(latest, "apk");
            const totalDownloads = latest.assets.reduce((s, a) => s + a.downloadCount, 0);
            return (
              <Card className="grid gap-8 p-8 lg:grid-cols-[1fr_auto] lg:items-center lg:gap-12"> {/* ds-allow：栅格比例 */}
                <div className="flex min-w-0 flex-col gap-3">
                  <div className="flex flex-wrap items-baseline gap-3">
                    <span className="font-mono text-4xl font-semibold tracking-tight text-fg sm:text-5xl">{latest.version}</span>
                    <Badge tone={latest.prerelease ? "warning" : "secondary"}>{latest.prerelease ? t.latest.prerelease : t.latest.stable}</Badge>
                  </div>
                  <p className="text-sm text-fg-muted">
                    {t.latest.publishedOn} <time dateTime={latest.publishedAt}>{fmtDate(latest.publishedAt)}</time>
                    {totalDownloads > 0 && <span className="text-fg-subtle"> · {fmtNum(totalDownloads)} {t.latest.downloads}</span>}
                  </p>
                </div>
                <div className="flex w-full min-w-0 flex-col items-stretch gap-3 lg:w-auto lg:min-w-[22rem] lg:items-end"> {/* ds-allow：宽度不是视觉参数 */}
                  {apk ? (
                    <AssetButton asset={apk} label={t.latest.downloadApk} variant="accent" lang={lang} />
                  ) : (
                    <p className="text-sm text-fg-muted">{t.latest.noApk}</p>
                  )}
                  <ExternalLink href={latest.url} className="text-sm lg:self-end">{t.latest.viewOnGithub} ↗</ExternalLink>
                </div>
              </Card>
            );
          })()}
        </Container>
      </Section>

      {/* 安装前提 */}
      <Section tone="elevated">
        <Container className="flex flex-col gap-6">
          <div className="flex flex-col gap-3">
            <Eyebrow>{t.prereq.eyebrow}</Eyebrow>
            <Heading size="md">{t.prereq.heading}</Heading>
            <Lead className="max-w-prose text-base">{t.prereq.lead}</Lead>
          </div>
          <ul className="grid gap-4 sm:grid-cols-3">
            {([["termux", t.prereq.termux, t.prereq.termuxDesc], ["api", t.prereq.api, t.prereq.apiDesc], ["boot", t.prereq.boot, t.prereq.bootDesc]] as const).map(([k, name, desc], i) => (
              <Reveal as="li" key={k} delay={i as 0 | 1 | 2}>
                <a href={TERMUX_LINKS[k]} target="_blank" rel="noreferrer noopener" className="block h-full">
                  <Card interactive className="flex h-full flex-col gap-2">
                    <span className="font-medium text-fg">{name} <span aria-hidden className="text-fg-subtle">↗</span></span>
                    <span className="text-sm text-fg-muted">{desc}</span>
                    <span className="mt-auto pt-2 text-xs text-fg-subtle">F-Droid</span>
                  </Card>
                </a>
              </Reveal>
            ))}
          </ul>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-fg-muted">{t.prereq.requirements}</p>
            <ButtonLink to={localized(lang, "/docs/start/install")} variant="secondary" size="sm">{t.prereq.guide} →</ButtonLink>
          </div>
        </Container>
      </Section>

      {/* 发布说明 */}
      {state.status === "ready" && (() => {
        const latest = pickLatest(state.releases);
        if (!latest) return null;
        return (
          <Section>
            <Container width="prose" className="flex flex-col gap-4">
              <Eyebrow>{t.notes.eyebrow} · {latest.version}</Eyebrow>
              {latest.body.trim() ? <Markdown source={latest.body} /> : <p className="text-fg-muted">{t.notes.empty}</p>}
            </Container>
          </Section>
        );
      })()}

      {/* 历史版本 */}
      {state.status === "ready" && state.releases.length > 0 && (
        <Section tone="elevated">
          <Container className="flex flex-col gap-6">
            <div className="flex flex-col gap-2">
              <Eyebrow>{t.history.eyebrow}</Eyebrow>
              <Heading size="md">{t.history.heading} <span className="text-fg-subtle">· {state.releases.length} {t.history.count}</span></Heading>
            </div>
            <History releases={state.releases} t={t} fmtDate={fmtDate} lang={lang} />
          </Container>
        </Section>
      )}

      {/* 其他机器 */}
      <Section>
        <Container className="grid gap-6 lg:grid-cols-[1fr_1.4fr] lg:gap-12"> {/* ds-allow：栅格比例 */}
          <div className="flex flex-col gap-2">
            <Eyebrow>{t.other.eyebrow}</Eyebrow>
            <Heading size="md">{t.other.heading}</Heading>
          </div>
          <div className="flex flex-col gap-4">
            <p className="text-fg-muted text-pretty">{t.other.body[0]}<code className="whitespace-nowrap font-mono text-fg">{t.other.command}</code>{t.other.body[1]}</p>
            <ButtonLink to={localized(lang, "/docs/advanced/other-machines")} variant="secondary" size="sm" className="self-start">{t.other.link} →</ButtonLink>
          </div>
        </Container>
      </Section>
    </>
  );
}

function AssetButton({ asset, label, variant, lang }: { asset: ReleaseAsset; label: string; variant: "accent" | "secondary"; lang: "zh" | "en" }) {
  return (
    <ButtonAnchor href={asset.url} variant={variant} size="lg" className="h-auto w-full min-w-0 max-w-full flex-col items-start gap-1 px-6 py-4 text-left">
      {/* 按钮基类是 nowrap，换行只能写在子元素上，否则同属性类的先后顺序决定谁生效 */}
      <span className="whitespace-normal text-lg">{label}</span>
      <span className={cx("block w-full whitespace-normal break-all font-mono text-xs font-normal", variant === "accent" ? "opacity-(--ds-opacity-muted)" : "text-fg-muted")}>{asset.name} · {formatBytes(asset.size, lang)}</span>
    </ButtonAnchor>
  );
}

function History({ releases, t, fmtDate, lang }: { releases: Release[]; t: ReturnType<typeof useMessages<typeof messages.zh>>; fmtDate: (iso: string) => string; lang: "zh" | "en" }) {
  const [all, setAll] = useState(false);
  const shown = all ? releases : releases.slice(0, 5);
  return (
    <div className="flex flex-col gap-3">
      <ol className="divide-y divide-border rounded-xl border border-border bg-surface">
        {shown.map((r) => (
          <li key={r.tag} className="flex flex-col gap-2 p-4 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
            <div className="flex flex-col gap-1">
              <div className="flex flex-wrap items-center gap-2">
                <ExternalLink href={r.url} className="font-mono font-medium no-underline hover:underline">{r.version}</ExternalLink>
                {r.prerelease && <Badge tone="warning">{t.latest.prerelease}</Badge>}
              </div>
              <time dateTime={r.publishedAt} className="text-xs text-fg-subtle">{fmtDate(r.publishedAt)}</time>
            </div>
            <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm sm:justify-end">
              {r.assets.filter((a) => a.kind === "apk").map((a) => (
                <li key={a.name}><ExternalLink href={a.url} className="no-underline hover:underline">{a.name}</ExternalLink> <span className="text-fg-subtle">{formatBytes(a.size, lang)}</span></li>
              ))}
            </ul>
          </li>
        ))}
      </ol>
      {releases.length > 5 && (
        <button type="button" onClick={() => setAll((v) => !v)} className="self-start text-sm text-link underline-offset-4 hover:text-link-hover hover:underline">
          {all ? t.history.showLess : `${t.history.showAll} (${releases.length})`}
        </button>
      )}
    </div>
  );
}

function LatestSkeleton({ label }: { label: string }) {
  return (
    <Card className="flex flex-col gap-6 lg:flex-row lg:justify-between" aria-busy="true" aria-live="polite">
      <div className="flex flex-col gap-3">
        <div className="h-10 w-40 rounded-md bg-surface-hover" />
        <div className="h-4 w-56 rounded-sm bg-surface-hover" />
        <p className="text-sm text-fg-subtle">{label}</p>
      </div>
      <div className="flex w-full flex-col gap-3 lg:w-80">
        <div className="h-14 rounded-md bg-surface-hover" />
        <div className="h-14 rounded-md bg-surface-hover" />
      </div>
    </Card>
  );
}

function ErrorBlock({ error, t, onRetry, fmtTime }: { error: FetchError; t: typeof messages.zh.state; onRetry: () => void; fmtTime: (d: Date) => string }) {
  const text = error.kind === "rate-limit" ? t.rateLimit : error.kind === "network" ? t.network : `${t.http} (${error.status})`;
  return (
    <Card role="alert" className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex flex-col gap-1">
        <p className="text-fg">{text}</p>
        {error.kind === "rate-limit" && error.resetAt && <p className="text-sm text-fg-subtle">{t.rateLimitReset} {fmtTime(error.resetAt)}</p>}
      </div>
      <div className="flex flex-col gap-2 sm:flex-row">
        <ButtonAnchor href={GITHUB_RELEASES} target="_blank" rel="noreferrer noopener" variant="primary" size="sm">{t.goToReleases} ↗</ButtonAnchor>
        <button type="button" onClick={onRetry} className="text-sm text-link underline-offset-4 hover:underline">{t.retry}</button>
      </div>
    </Card>
  );
}

function EmptyBlock({ label, go }: { label: string; go: string }) {
  return (
    <Card className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-fg-muted">{label}</p>
      <ButtonAnchor href={GITHUB_RELEASES} target="_blank" rel="noreferrer noopener" variant="secondary" size="sm">{go} ↗</ButtonAnchor>
    </Card>
  );
}
