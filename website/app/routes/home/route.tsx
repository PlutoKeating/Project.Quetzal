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

/** 三条带子的小标记：你叫它（灰点）· heartbeat（刻度）· Quetzal（呼吸的状态灯）。用在「没有定时器」一节的三行对照里。 */
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

      {/* 2 · ta 是你的：最重要的一句话，单独一节 */}
      <Section tone="elevated">
        <Container className="flex flex-col gap-6">
          <Reveal className="flex max-w-4xl flex-col gap-6">
            <Eyebrow>{t.own.eyebrow}</Eyebrow>
            <Heading size="lg" className="whitespace-pre-line">{t.own.heading}</Heading>
            <Lead className="max-w-prose">{t.own.lead}</Lead>
            <Link to={`${localized(lang, "/features")}#soul`} className="text-sm text-link underline-offset-4 hover:underline">{t.own.more} →</Link>
          </Reveal>
        </Container>
      </Section>

      {/* 3 · 没有定时器：它和 Codex / Hermes / OpenClaw 的差别只讲一件事 + 三条带子 */}
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
            <ul className="flex flex-wrap gap-2">
              <li><a className={cx(chip, "transition-colors duration-(--ds-duration-fast) hover:text-fg")} href={GITHUB_REPO} target="_blank" rel="noreferrer noopener">{stats && stats.stars >= 10 ? t.position.chips.stars.replace("{n}", String(stats.stars)) : "GitHub ↗"}</a></li>
              {stats?.latestTag && <li><Link className={cx(chip, "transition-colors duration-(--ds-duration-fast) hover:text-fg")} to={localized(lang, "/download")}>{t.position.chips.release.replace("{v}", stats.latestTag)}</Link></li>}
              <li><span className={chip}>{t.position.chips.license}</span></li>
            </ul>
          </Reveal>
          <Reveal delay={1}><WakeCompare t={t.position.compare} /></Reveal>
        </Container>
      </Section>

      {/* 4 · 别处没有的：身体 · 许多身体 · 会长大，各链到亮点页对应的一节 */}
      <Section tone="elevated">
        <Container className="flex flex-col gap-10">
          <Reveal className="flex max-w-prose flex-col gap-4">
            <Eyebrow>{t.pillars.eyebrow}</Eyebrow>
            <Heading size="lg" className="whitespace-pre-line">{t.pillars.heading}</Heading>
            <Lead>{t.pillars.lead}</Lead>
          </Reveal>
          <ul className="grid gap-4 md:grid-cols-3">
            {t.pillars.items.map((it, i) => (
              <Reveal as="li" key={it.id} delay={i as 0 | 1 | 2} className="flex">
                <Link to={`${localized(lang, "/features")}#${it.id}`} className="group flex w-full">
                  <Card interactive className="flex w-full flex-col gap-4 p-7 sm:p-8">
                    <span className="flex items-center gap-3 text-xs font-medium uppercase tracking-wide text-secondary-fg">
                      <span className="font-mono text-fg-subtle">{String(i + 1).padStart(2, "0")}</span>{it.tag}
                    </span>
                    <Heading as="h3" size="md">{it.title}</Heading>
                    <p className="text-fg-muted text-pretty">{it.text}</p>
                    <span className="mt-auto text-sm text-link underline-offset-4 group-hover:underline">{t.pillars.more} →</span>
                  </Card>
                </Link>
              </Reveal>
            ))}
          </ul>
        </Container>
      </Section>

      {/* 5 · 几个瞬间（示例） */}
      <Section>
        <Container className="flex flex-col gap-10">
          <Reveal className="flex max-w-prose flex-col gap-4">
            <Eyebrow>{t.moments.eyebrow}</Eyebrow>
            <Heading>{t.moments.heading}</Heading>
          </Reveal>
          <ul className="grid gap-x-10 gap-y-8 md:grid-cols-3">
            {t.moments.items.map((it, i) => (
              <Reveal as="li" key={it.when} delay={i as 0 | 1 | 2} className="flex flex-col gap-2 border-t border-border pt-5">
                <span className="text-xs font-medium uppercase tracking-wide text-secondary-fg">{it.when}</span>
                <p className="text-lg text-fg text-pretty">{it.text}</p>
              </Reveal>
            ))}
          </ul>
          <p className="text-xs text-fg-subtle">{t.moments.note}</p>
        </Container>
      </Section>

      {/* 6 · 它此刻（示例身体） */}
      <Section tone="elevated">
        <Container className="grid gap-10 lg:grid-cols-[1fr_1.1fr] lg:items-center"> {/* ds-allow：栅格比例 */}
          <Reveal className="flex flex-col gap-4">
            <Eyebrow>{t.now.eyebrow}</Eyebrow>
            <Heading>{t.now.heading}</Heading>
            <Lead>{t.now.lead}</Lead>
          </Reveal>
          <Reveal delay={1}><ExampleBody t={t.now} events={t.day.entries.map((e) => e.time)} /></Reveal>
        </Container>
      </Section>

      {/* 7 · 一天 */}
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

      {/* 8 · 它有时候不动（暗着的一节） */}
      <Section className="border-t border-border bg-bg">
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

      {/* 9 · 你说了算 */}
      <Section tone="elevated">
        <Container className="flex flex-col gap-10">
          <Reveal className="flex max-w-prose flex-col gap-4">
            <Eyebrow>{t.trust.eyebrow}</Eyebrow>
            <Heading>{t.trust.heading}</Heading>
          </Reveal>
          <dl className="grid gap-x-10 gap-y-8 md:grid-cols-3">
            {t.trust.items.map((it, i) => (
              <Reveal key={it.title} delay={i as 0 | 1 | 2} className="flex flex-col gap-2 border-t border-border pt-5">
                <dt className="font-medium text-fg">{it.title}</dt>
                <dd className="text-sm text-fg-muted text-pretty">{it.text}</dd>
              </Reveal>
            ))}
          </dl>
        </Container>
      </Section>

      {/* 10 · 开始 */}
      <Section>
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
