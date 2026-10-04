import type { Route } from "./+types/route";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { useMessages, isLang, DEFAULT_LANG, localized, useLang } from "~/i18n/core";
import { Badge, Breath, ButtonAnchor, ButtonLink, Card, Container, Eyebrow, Heading, Lead, OrbMark, Reveal, Section, StatusDot, cx } from "~/design-system/components";
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

/** 三条带子的小标记：你叫它（灰点）· heartbeat（刻度）· Quetzal（呼吸的状态灯）。定位行与邻居卡片共用。 */
function BandMark({ i }: { i: number }) {
  if (i === 0) return <span className="size-2.5 rounded-full bg-fg-subtle" />;
  if (i === 1) return <span className="flex gap-0.5">{[0, 1, 2].map((k) => <span key={k} className="h-3 w-0.5 bg-fg-subtle" />)}</span>;
  return <StatusDot alive />;
}

export default function Home() {
  const t = useMessages(messages);
  const lang = useLang();
  const kindTone = { wake: "accent", think: "secondary", doze: "neutral", dream: "secondary", sleep: "neutral", chat: "accent" } as const;
  const [stats, setStats] = useState<RepoStats | null>(null);
  useEffect(() => { fetchRepoStats().then(setStats); }, []);
  const chip = "inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1 text-xs text-fg-muted";

  return (
    <>
      {/* 1 · Hero：名字与一句类别、两行标语、一句定义、入口。只此四样。 */}
      <section className="relative overflow-hidden border-b border-border">
        <Breath className="-right-32 -top-24 sm:-right-16 sm:top-0 landscape:short:-top-40" />
        <Container className="relative flex min-h-[calc(100dvh-var(--ds-header-height))] flex-col justify-center gap-6 py-16 sm:py-24 short:min-h-0 short:py-10"> {/* ds-allow：高度表达式只引用变量 */}
          {/* 名片：光团 · 名字 · 细竖线 · 类别。与顶栏的标志同一颗球 */}
          <p className="flex items-center gap-3">
            <OrbMark size={14} />
            <span className="text-lg font-medium tracking-wide text-fg">Quetzal</span>
            <span aria-hidden className="h-4 w-px bg-border-strong" />
            <span className="text-xs font-medium uppercase tracking-wide text-secondary-fg">{t.hero.eyebrow}</span>
          </p>
          <h1 className="max-w-4xl whitespace-pre-line text-3xl font-semibold tracking-tight sm:text-5xl lg:text-6xl">{t.hero.title}</h1>
          <p className={cx("max-w-3xl whitespace-pre-line text-xl text-fg-muted", lang === "zh" ? "font-serif italic" : "")}>{t.hero.titleAlt}</p>
          <Lead className="max-w-prose">{t.hero.lead}</Lead>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <ButtonLink variant="accent" size="lg" to={localized(lang, "/download")}>{t.hero.download}</ButtonLink>
            <ButtonLink variant="ghost" size="lg" to={localized(lang, "/features")}>{t.hero.features} →</ButtonLink>
          </div>
        </Container>
      </section>

      {/* 2 · 定位：它和 Codex / Hermes / OpenClaw 什么关系 + 三条带子 */}
      <Section>
        <Container className="grid items-center gap-10 lg:grid-cols-[1.15fr_1fr] lg:gap-14"> {/* ds-allow：栅格比例 */}
          <Reveal className="flex flex-col gap-6">
            <Eyebrow>{t.position.eyebrow}</Eyebrow>
            <Heading as="h2" size="lg" className="whitespace-pre-line">{t.position.title}</Heading>
            <dl className="flex flex-col divide-y divide-border border-y border-border">
              {t.position.rows.map((r, i) => (
                <div key={r.name} className="grid grid-cols-[1.5rem_1fr] gap-x-3 py-4">
                  <span aria-hidden className="mt-1.5 flex items-center"><BandMark i={i} /></span>
                  <div className="flex flex-col gap-1">
                    <dt className="flex flex-wrap items-baseline gap-x-2"><span className={cx("font-medium", i === 2 ? "text-fg" : "text-fg-muted")}>{r.name}</span><span className="text-xs text-fg-subtle">{r.kind}</span></dt>
                    <dd className={cx("text-pretty", i === 2 ? "text-fg" : "text-fg-muted")}>{r.text}</dd>
                  </div>
                </div>
              ))}
            </dl>
            <p className="text-fg-muted">{t.position.summary}</p>
            <a href="#why" className="text-sm text-link underline-offset-4 hover:underline">{t.position.why} ↓</a>
            <ul className="flex flex-wrap gap-2">
              <li><a className={cx(chip, "transition-colors duration-(--ds-duration-fast) hover:text-fg")} href={GITHUB_REPO} target="_blank" rel="noreferrer noopener">{stats && stats.stars >= 10 ? t.position.chips.stars.replace("{n}", String(stats.stars)) : "GitHub ↗"}</a></li>
              {stats?.latestTag && <li><Link className={cx(chip, "transition-colors duration-(--ds-duration-fast) hover:text-fg")} to={localized(lang, "/download")}>{t.position.chips.release.replace("{v}", stats.latestTag)}</Link></li>}
              <li><span className={chip}>{t.position.chips.license}</span></li>
            </ul>
          </Reveal>
          <Reveal delay={1}><WakeCompare t={t.position.compare} /></Reveal>
        </Container>
      </Section>

      {/* 3 · 为什么不是 Hermes / OpenClaw：三张卡，同样三个问题，标记与三条带子一致 */}
      <Section id="why" tone="elevated" className="scroll-mt-(--ds-header-height)">
        <Container className="flex flex-col gap-10">
          <Reveal className="flex max-w-prose flex-col gap-4">
            <Eyebrow>{t.why.eyebrow}</Eyebrow>
            <Heading>{t.why.heading}</Heading>
            <Lead>{t.why.lead}</Lead>
          </Reveal>
          <ul className="grid gap-4 md:grid-cols-3">
            {t.why.cards.map((c, i) => {
              const mine = i === 2;
              return (
                <Reveal as="li" key={c.name} delay={i as 0 | 1 | 2} className="flex">
                  <Card className={cx("flex w-full flex-col gap-5", mine ? "border-border-strong shadow-md" : "bg-bg-elevated")}>
                    <div className="flex items-center gap-3">
                      <span aria-hidden className="flex size-9 shrink-0 items-center justify-center rounded-full border border-border bg-surface"><BandMark i={i} /></span>
                      <div className="flex min-w-0 flex-col">
                        <span className={cx("font-medium", mine ? "text-fg" : "text-fg-muted")}>{c.name}</span>
                        <span className="text-xs text-fg-subtle">{c.kind}</span>
                      </div>
                    </div>
                    <dl className="flex flex-col divide-y divide-border border-t border-border">
                      {t.why.keys.map((k, j) => (
                        <div key={k} className="flex flex-col gap-1 py-3">
                          <dt className="text-xs font-medium uppercase tracking-wide text-fg-subtle">{k}</dt>
                          <dd className="text-sm text-pretty">
                            <span className={cx("font-medium", mine ? "text-fg" : "text-fg")}>{c.cells[j].k}</span>{" "}
                            <span className="text-fg-muted">{c.cells[j].t}</span>
                          </dd>
                        </div>
                      ))}
                    </dl>
                  </Card>
                </Reveal>
              );
            })}
          </ul>
          <div className="grid gap-8 md:grid-cols-2">
            <Reveal className="flex flex-col gap-3 border-t border-border pt-5">
              <p className="font-medium text-fg">{t.why.bridge.title}</p>
              <p className="text-sm text-fg-muted text-pretty"><span className="font-medium text-fg">{t.why.bridge.k}</span> {t.why.bridge.text}</p>
              <Link to={localized(lang, t.why.link)} className="text-sm text-link underline-offset-4 hover:underline">{t.why.learnMore} →</Link>
            </Reveal>
            <Reveal delay={1} className="flex flex-col gap-3 border-t border-border pt-5">
              <p className="font-medium text-fg">{t.why.notFor.title}</p>
              <ul className="flex flex-col gap-2 text-sm text-fg-muted">
                {t.why.notFor.items.map((it) => <li key={it.k} className="grid grid-cols-[0.75rem_1fr] gap-2"><span aria-hidden className="mt-2 inline-block size-1.5 rounded-full bg-fg-subtle" /><span><span className="font-medium text-fg">{it.k}</span> {it.t}</span></li>)}
              </ul>
            </Reveal>
          </div>
        </Container>
      </Section>

      {/* 4 · 它此刻（示例身体） */}
      <Section>
        <Container className="grid gap-10 lg:grid-cols-[1fr_1.1fr] lg:items-center"> {/* ds-allow：栅格比例 */}
          <Reveal className="flex flex-col gap-4">
            <Eyebrow>{t.now.eyebrow}</Eyebrow>
            <Heading>{t.now.heading}</Heading>
            <Lead>{t.now.lead}</Lead>
          </Reveal>
          <Reveal delay={1}><ExampleBody t={t.now} events={t.day.entries.map((e) => e.time)} /></Reveal>
        </Container>
      </Section>

      {/* 5 · 一天 */}
      <Section tone="elevated">
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

      {/* 6 · 它有时候不动（暗着的一节） */}
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

      {/* 7 · 开始 */}
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
