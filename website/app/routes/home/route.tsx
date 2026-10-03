import type { Route } from "./+types/route";
import { useMessages, isLang, DEFAULT_LANG, localized, useLang } from "~/i18n/core";
import { Badge, Breath, ButtonAnchor, ButtonLink, Container, Eyebrow, Heading, Lead, Reveal, Section, cx } from "~/design-system/components";
import { GITHUB_REPO } from "~/components/i18n";
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

  return (
    <>
      {/* 1 · Hero */}
      <section className="relative overflow-hidden border-b border-border">
        <Breath className="-right-32 -top-24 sm:-right-16 sm:top-0 landscape:short:-top-40" />
        <Container className="relative flex min-h-[calc(100dvh-var(--ds-header-height))] flex-col justify-center gap-6 py-16 sm:py-24 short:min-h-0 short:py-10"> {/* ds-allow：高度表达式只引用变量 */}
          <Eyebrow>{t.hero.eyebrow}</Eyebrow>
          <h1 className="max-w-4xl text-balance text-4xl font-semibold tracking-tight sm:text-5xl lg:text-6xl">{t.hero.title}</h1>
          <p className={cx("max-w-3xl text-xl text-fg-muted", lang === "zh" ? "font-serif italic" : "")}>{t.hero.titleAlt}</p>
          <Lead className="max-w-prose">{t.hero.lead}</Lead>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <ButtonLink variant="accent" size="lg" to={localized(lang, "/download")}>{t.hero.download}</ButtonLink>
            <ButtonLink variant="ghost" size="lg" to={localized(lang, "/features")}>{t.hero.features} →</ButtonLink>
          </div>
        </Container>
      </section>

      {/* 2 · 它此刻（示例身体） */}
      <Section>
        <Container className="grid gap-10 lg:grid-cols-[1fr_1.1fr] lg:items-center"> {/* ds-allow：栅格比例 */}
          <Reveal className="flex flex-col gap-4">
            <Eyebrow>{t.now.eyebrow}</Eyebrow>
            <Heading>{t.now.heading}</Heading>
            <Lead>{t.now.lead}</Lead>
          </Reveal>
          <Reveal delay={1}><ExampleBody t={t.now} /></Reveal>
        </Container>
      </Section>

      {/* 3 · 一天 */}
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

      {/* 4 · 它有时候不动（暗着的一节：没有光斑，没有琥珀） */}
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

      {/* 5 · 开始 */}
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
