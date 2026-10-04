import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router";
import type { Route } from "./+types/route";
import { DEFAULT_LANG, isLang, localized, useLang, useMessages } from "~/i18n/core";
import { Badge, ButtonAnchor, ButtonLink, Card, Container, Eyebrow, ExternalLink, Heading, Lead, Reveal, Section, TextLink, cx } from "~/design-system/components";
import { GITHUB_RELEASES } from "~/components/i18n";
import { Markdown } from "~/components/markdown/Markdown";
import { ReleasesError, fetchReleases, findAsset, formatBytes, pickLatest, type FetchError, type Release, type ReleaseAsset } from "~/lib/github";
import { TERMUX_APPS, termuxApkUrl, termuxPageUrl } from "~/lib/termux";
import { messages } from "./i18n";

export const meta: Route.MetaFunction = ({ params }) => {
  const m = messages[isLang(params.lang) ? params.lang : DEFAULT_LANG];
  return [{ title: m.title }, { name: "description", content: m.description }];
};

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
  const navigate = useNavigate();
  // 点了下载之后带用户去完整安装步骤：浏览器已经开始下载，页面本身留在原地
  const afterDownload = () => { setTimeout(() => navigate(localized(lang, "/docs/start/install")), 800); };
  const fmtDate = (iso: string) => new Intl.DateTimeFormat(lang === "zh" ? "zh-CN" : "en", { dateStyle: "long" }).format(new Date(iso));
  const fmtNum = (n: number) => new Intl.NumberFormat(lang === "zh" ? "zh-CN" : "en").format(n);

  return (
    <>
      {/* 标题与最新版本放在同一节：手机上不留大段空白 */}
      <Section tight>
        <Container className="flex flex-col gap-3">
          <Eyebrow>{t.eyebrow}</Eyebrow>
          <Heading as="h1" size="lg">{t.heading}</Heading>
          <Lead className="max-w-prose">{t.lead}</Lead>
          <Eyebrow className="mt-6 mb-1">{t.latest.eyebrow}</Eyebrow>
          {state.status === "loading" && <LatestSkeleton label={t.state.loading} />}
          {state.status === "error" && <ErrorBlock error={state.error} t={t.state} onRetry={retry} fmtTime={(d) => new Intl.DateTimeFormat(lang === "zh" ? "zh-CN" : "en", { timeStyle: "short" }).format(d)} />}
          {state.status === "ready" && (() => {
            const latest = pickLatest(state.releases);
            if (!latest) return <EmptyBlock label={t.state.empty} go={t.state.goToReleases} />;
            const apk = findAsset(latest, "apk");
            const totalDownloads = latest.assets.reduce((s, a) => s + a.downloadCount, 0);
            return (
              <Card className="grid gap-5 p-5 sm:p-8 lg:grid-cols-[1fr_auto] lg:items-center lg:gap-12"> {/* ds-allow：栅格比例 */}
                <div className="flex min-w-0 flex-col gap-2">
                  <div className="flex flex-wrap items-baseline gap-3">
                    <span className="font-mono text-3xl font-semibold tracking-tight text-fg sm:text-5xl">{latest.version}</span>
                    <Badge tone={latest.prerelease ? "warning" : "secondary"}>{latest.prerelease ? t.latest.prerelease : t.latest.stable}</Badge>
                  </div>
                  <p className="text-sm text-fg-muted">
                    {t.latest.publishedOn} <time dateTime={latest.publishedAt}>{fmtDate(latest.publishedAt)}</time>
                    {totalDownloads > 0 && <span className="text-fg-subtle"> · {fmtNum(totalDownloads)} {t.latest.downloads}</span>}
                  </p>
                </div>
                <div className="flex w-full min-w-0 flex-col items-stretch gap-3 lg:w-auto lg:min-w-[22rem] lg:items-end"> {/* ds-allow：宽度不是视觉参数 */}
                  {apk ? (
                    <AssetButton asset={apk} label={t.latest.downloadApk} variant="accent" lang={lang} onClick={afterDownload} />
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
          {/* 每张卡：名字、作用、固定版本的直链（没有 F-Droid 客户端也能一次下完）、F-Droid 页面 */}
          <ul className="grid gap-4 sm:grid-cols-3">
            {([["termux", t.prereq.termux, t.prereq.termuxDesc], ["api", t.prereq.api, t.prereq.apiDesc], ["boot", t.prereq.boot, t.prereq.bootDesc]] as const).map(([k, name, desc], i) => {
              const a = TERMUX_APPS[k];
              return (
                <Reveal as="li" key={k} delay={i as 0 | 1 | 2} className="min-w-0">
                  <Card className="flex h-full min-w-0 flex-col gap-2">
                    <span className="font-medium text-fg">{name}</span>
                    <span className="text-sm text-fg-muted">{desc}</span>
                    <ButtonAnchor href={termuxApkUrl(a)} variant="secondary" size="md" className="mt-3 w-full">{t.prereq.apk} ↓</ButtonAnchor>
                    <span className="flex flex-wrap items-center gap-x-2 text-xs text-fg-subtle">
                      <span className="font-mono">{a.version} · {formatBytes(a.bytes, lang)}</span>
                      <span aria-hidden>·</span>
                      <ExternalLink href={termuxPageUrl(a)} className="no-underline hover:underline">{t.prereq.page} ↗</ExternalLink>
                    </span>
                  </Card>
                </Reveal>
              );
            })}
          </ul>
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-fg-muted">{t.prereq.requirements}</p>
            <ButtonLink to={localized(lang, "/docs/start/install")} variant="primary" size="lg" className="w-full sm:w-auto">{t.prereq.guide} →</ButtonLink>
          </div>
        </Container>
      </Section>

      {/* 发布说明：默认折叠的抽屉，只显示当前语言的条目（CHANGELOG 中英各写一条） */}
      {state.status === "ready" && (() => {
        const latest = pickLatest(state.releases);
        if (!latest) return null;
        const notes = notesForLang(latest.body, lang);
        return (
          <Section tight>
            <Container width="prose">
              <details className="group rounded-xl border border-border bg-surface">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-5 py-4 [&::-webkit-details-marker]:hidden">
                  <span className="text-sm font-medium text-fg">{t.notes.eyebrow} <span className="font-mono text-fg-subtle">· {latest.version}</span></span>
                  <span aria-hidden className="text-fg-subtle transition-transform duration-(--ds-duration-fast) group-open:rotate-180">⌄</span>
                </summary>
                <div className="border-t border-border px-5 py-4">
                  {notes.trim() ? <Markdown source={notes} /> : <p className="text-fg-muted">{t.notes.empty}</p>}
                </div>
              </details>
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

      {/* 其他机器：命令本身是视觉锚点 */}
      <Section>
        <Container className="grid gap-6 lg:grid-cols-[1fr_1.4fr] lg:gap-12"> {/* ds-allow：栅格比例 */}
          <div className="flex flex-col gap-2">
            <Eyebrow>{t.other.eyebrow}</Eyebrow>
            <Heading size="md">{t.other.heading}</Heading>
          </div>
          <div className="flex flex-col gap-4">
            <pre className="overflow-x-auto rounded-lg border border-border bg-surface px-4 py-3 font-mono text-sm text-fg"><code>{t.other.command}</code></pre>
            <p className="text-fg-muted text-pretty">{t.other.body}</p>
            <TextLink to={localized(lang, "/docs/advanced/other-machines")} className="self-start text-sm">{t.other.link} →</TextLink>
          </div>
        </Container>
      </Section>
    </>
  );
}

/** 发布说明里中英文各写一条（CHANGELOG 的约定）：按当前语言只留一种。含汉字的条目算中文。 */
function notesForLang(body: string, lang: "zh" | "en"): string {
  const cjk = /[\u3400-\u9fff]/;
  return body.split("\n").filter((line) => !/^\s*[-*]\s/.test(line) || cjk.test(line) === (lang === "zh")).join("\n");
}

function AssetButton({ asset, label, variant, lang, onClick }: { asset: ReleaseAsset; label: string; variant: "accent" | "secondary"; lang: "zh" | "en"; onClick?: () => void }) {
  return (
    <ButtonAnchor href={asset.url} onClick={onClick} variant={variant} size="lg" className="h-auto w-full min-w-0 max-w-full flex-col items-start gap-1 px-5 py-4 text-left">
      {/* 按钮基类是 nowrap，换行只能写在子元素上，否则同属性类的先后顺序决定谁生效 */}
      <span className="whitespace-normal text-lg">{label}</span>
      {/* 手机上只写类型与大小，完整文件名留给宽屏 */}
      <span className={cx("block w-full whitespace-normal font-mono text-xs font-normal", variant === "accent" ? "opacity-(--ds-opacity-muted)" : "text-fg-muted")}>
        <span className="sm:hidden">APK · {formatBytes(asset.size, lang)}</span>
        <span className="hidden break-all sm:inline">{asset.name} · {formatBytes(asset.size, lang)}</span>
      </span>
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
