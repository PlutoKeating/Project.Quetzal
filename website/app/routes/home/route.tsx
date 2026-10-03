import type { Route } from "./+types/route";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { useMessages, isLang, DEFAULT_LANG, localized, useLang } from "~/i18n/core";
import { Badge, Breath, ButtonAnchor, ButtonLink, Container, Eyebrow, Heading, Lead, Reveal, Section, cx } from "~/design-system/components";
import { GITHUB_REPO } from "~/components/i18n";
import { WakeCompare } from "~/components/figure";
import { fetchRepoStats, type RepoStats } from "~/lib/github";
import { messages } from "./i18n";
import { ExampleBody } from "./ExampleBody";
import { DayStrip } from "./DayStrip";

export const meta: Route.MetaFunction = ({ params }) => {
  const m = messages[isLang(params.lang) ? params.lang : DEFAULT_LANG];
  return [{ title: m.title }, { name: "description", content: m.description }, { property: "og:title", content: m.title }, { property: "og:description", content: m.description }];
};

export default function Home() {
  const t = useMessages(messages);
  const lang = useLang();
  const kindTone = { wake: "accent", think: "secondary", doze: "neutral", dream: "secondary", sleep: "neutral", chat: "accent" } as const;
  const [stats, setStats] = useState<RepoStats | null>(null);
  useEffect(() => { fetchRepoStats().then(setStats); }, []);
  const chip = "inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1 text-xs text-fg-muted";

  return (
    <>
      {/* 1 · Hero：左边是定位，右边是三条带子 */}
      <section className="relative overflow-hidden border-b border-border">
        <Breath className="-right-40 -top-32 opacity-(--ds-opacity-halo-light)" size="md" />
        <Container className="relative grid min-h-[calc(100dvh-var(--ds-header-height))] items-center gap-10 py-14 sm:py-20 short:min-h-0 short:py-10 lg:grid-cols-[1.15fr_1fr] lg:gap-14"> {/* ds-allow：高度表达式与栅格比例 */}
          <div className="flex flex-col gap-5">
            <Eyebrow>{t.hero.eyebrow}</Eyebrow>
            <h1 className="max-w-3xl text-balance text-4xl font-semibold tracking-tight sm:text-5xl lg:text-6xl">{t.hero.title}</h1>
            <p className="font-serif text-lg italic text-fg-subtle">{t.hero.slogan}</p>
            <Lead className="max-w-2xl">{t.hero.lead}</Lead>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <ButtonLink variant="accent" size="lg" to={localized(lang, "/download")}>{t.hero.download}</ButtonLink>
              <a href="#why" className="inline-flex h-12 items-center px-2 text-sm text-link underline-offset-4 hover:underline">{t.hero.why} ↓</a>
            </div>
            <ul className="flex flex-wrap gap-2">
              <li><a className={cx(chip, "transition-colors duration-(--ds-duration-fast) hover:text-fg")} href={GITHUB_REPO} target="_blank" rel="noreferrer noopener">{stats && stats.stars >= 10 ? t.hero.chips.stars.replace("{n}", String(stats.stars)) : "GitHub ↗"}</a></li>
              {stats?.latestTag && <li><Link className={cx(chip, "transition-colors duration-(--ds-duration-fast) hover:text-fg")} to={localized(lang, "/download")}>{t.hero.chips.release.replace("{v}", stats.latestTag)}</Link></li>}
              <li><span className={chip}>{t.hero.chips.license}</span></li>
              <li><span className={chip}>{t.hero.chips.phone}</span></li>
            </ul>
          </div>
          <Reveal delay={1}><WakeCompare t={t.hero.compare} /></Reveal>
        </Container>
      </section>

      {/* 2 · 为什么不是 Hermes / OpenClaw */}
      <Section id="why" className="scroll-mt-(--ds-header-height)">
        <Container className="flex flex-col gap-10">
          <Reveal className="flex max-w-prose flex-col gap-4">
            <Eyebrow>{t.why.eyebrow}</Eyebrow>
            <Heading>{t.why.heading}</Heading>
            <Lead>{t.why.lead}</Lead>
          </Reveal>
          <Reveal as="div" className="overflow-x-auto rounded-xl border border-border bg-surface">
            <table className="w-full min-w-[40rem] border-collapse text-sm"> {/* ds-allow：表格最小宽度 */}
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-fg-subtle">
                  {t.why.cols.map((c, i) => <th key={i} scope="col" className={cx("px-4 py-3 font-medium", i === 3 && "text-fg")}>{c}</th>)}
                </tr>
              </thead>
              <tbody>
                {t.why.rows.map((r) => (
                  <tr key={r[0]} className="border-b border-border last:border-0 align-top">
                    <th scope="row" className="px-4 py-3 text-left font-medium text-fg-muted">{r[0]}</th>
                    <td className="px-4 py-3 text-fg-subtle">{r[1]}</td>
                    <td className="px-4 py-3 text-fg-subtle">{r[2]}</td>
                    <td className="px-4 py-3 text-fg">{r[3]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Reveal>
          <div className="grid gap-8 md:grid-cols-2">
            <Reveal className="flex flex-col gap-3 border-t border-border pt-5">
              <p className="font-medium text-fg">{t.why.notFor.title}</p>
              <ul className="flex flex-col gap-2 text-sm text-fg-muted">
                {t.why.notFor.items.map((it) => <li key={it} className="grid grid-cols-[0.75rem_1fr] gap-2"><span aria-hidden className="mt-2 inline-block size-1.5 rounded-full bg-fg-subtle" /><span>{it}</span></li>)}
              </ul>
            </Reveal>
            <Reveal delay={1} className="flex flex-col gap-3 border-t border-border pt-5">
              <p className="font-medium text-fg">{t.why.bridge.title}</p>
              <p className="text-sm text-fg-muted text-pretty">{t.why.bridge.text}</p>
              <Link to={localized(lang, t.why.link)} className="text-sm text-link underline-offset-4 hover:underline">{t.why.learnMore} →</Link>
            </Reveal>
          </div>
        </Container>
      </Section>

      {/* 3 · 它此刻（示例身体） */}
      <Section tone="elevated">
        <Container className="grid gap-10 lg:grid-cols-[1fr_1.1fr] lg:items-center"> {/* ds-allow：栅格比例 */}
          <Reveal className="flex flex-col gap-4">
            <Eyebrow>{t.now.eyebrow}</Eyebrow>
            <Heading>{t.now.heading}</Heading>
            <Lead>{t.now.lead}</Lead>
          </Reveal>
          <Reveal delay={1}><ExampleBody t={t.now} /></Reveal>
        </Container>
      </Section>

      {/* 4 · 一天 */}
      <Section>
        <Container className="grid gap-10 lg:grid-cols-[1fr_1.4fr]"> {/* ds-allow：栅格比例 */}
          <Reveal className="flex flex-col gap-4">
            <Eyebrow>{t.day.eyebrow}</Eyebrow>
            <Heading>{t.day.heading}</Heading>
            <Lead>{t.day.lead}</Lead>
          </Reveal>
          <Reveal delay={1} as="div" className="overflow-hidden rounded-xl border border-border bg-surface">
            <div className="border-b border-border px-5 pt-4 pb-2"><DayStrip times={t.day.entries.map((e) => e.time)} label={t.day.bg} /></div>
            <ol className="divide-y divide-border">
              {t.day.entries.map((e) => (
                <li key={e.time} className="grid grid-cols-[auto_auto_1fr] items-baseline gap-x-4 px-5 py-3 text-sm">
                  <time className="font-mono text-fg-subtle">{e.time}</time>
                  <Badge tone={kindTone[e.kind as keyof typeof kindTone]}>{t.day.kinds[e.kind as keyof typeof t.day.kinds]}</Badge>
                  <span className="text-fg-muted">
                    {e.text}
                    {e.note && <span className="ml-2 text-xs text-accent">— {e.note}</span>}
                  </span>
                </li>
              ))}
            </ol>
          </Reveal>
        </Container>
      </Section>

      {/* 5 · 它有时候不动（暗着的一节） */}
      <Section className="bg-bg">
        <Container className="flex flex-col gap-10">
          <Reveal className="flex max-w-prose flex-col gap-4">
            <Eyebrow className="text-fg-subtle">{t.still.eyebrow}</Eyebrow>
            <Heading className="text-fg-muted">{t.still.heading}</Heading>
            <p className="text-fg-subtle text-pretty">{t.still.lead}</p>
          </Reveal>
          <dl className="grid gap-x-10 gap-y-8 md:grid-cols-3">
            {t.still.items.map((it, i) => (
              <Reveal key={it.title} delay={i as 0 | 1 | 2} className="flex flex-col gap-2 border-t border-border pt-5">
                <dt className="font-medium text-fg-muted">{it.title}</dt>
                <dd className="text-sm text-fg-subtle text-pretty">{it.text}</dd>
              </Reveal>
            ))}
          </dl>
          <Reveal as="div" className="max-w-prose">
            <blockquote className="border-l border-border-strong pl-5 text-lg text-fg-muted text-pretty">{t.still.quote}</blockquote>
            <p className="mt-3 pl-5 text-sm text-fg-subtle">— {t.still.by}</p>
          </Reveal>
        </Container>
      </Section>

      {/* 6 · 开始 */}
      <Section tone="elevated">
        <Container className="flex flex-col items-start gap-6">
          <Eyebrow>{t.start.eyebrow}</Eyebrow>
          <Heading size="lg" className="max-w-3xl">{t.start.heading}</Heading>
          <p className="max-w-prose text-fg-muted">{t.start.lead}</p>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <ButtonLink variant="accent" size="lg" to={localized(lang, "/download")}>{t.start.download}</ButtonLink>
            <ButtonLink variant="secondary" size="lg" to={localized(lang, "/features")}>{t.start.features}</ButtonLink>
          </div>
          <p className="text-sm text-fg-subtle">{t.start.foot} · <ButtonAnchor variant="ghost" size="sm" href={GITHUB_REPO} target="_blank" rel="noreferrer noopener" className="h-auto px-1 py-0">GitHub ↗</ButtonAnchor></p>
        </Container>
      </Section>
    </>
  );
}
