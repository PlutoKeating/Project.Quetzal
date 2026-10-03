import type { Route } from "./+types/route";
import { Link } from "react-router";
import { useMessages, isLang, DEFAULT_LANG, localized, useLang } from "~/i18n/core";
import { Badge, Breath, ButtonAnchor, ButtonLink, Container, Eyebrow, Heading, Lead, Reveal, Section, StatusDot, cx } from "~/design-system/components";
import { GITHUB_REPO } from "~/components/i18n";
import { messages } from "./i18n";
import { BodyClock } from "./BodyClock";

export const meta: Route.MetaFunction = ({ params }) => {
  const m = messages[isLang(params.lang) ? params.lang : DEFAULT_LANG];
  return [{ title: m.title }, { name: "description", content: m.description }, { property: "og:title", content: m.title }, { property: "og:description", content: m.description }];
};

export default function Home() {
  const t = useMessages(messages);
  const lang = useLang();
  const kindTone = { wake: "accent", think: "secondary", doze: "neutral", dream: "secondary", sleep: "neutral", chat: "neutral" } as const;

  return (
    <>
      {/* Hero：左对齐陈述，右侧一处呼吸光斑；横屏矮窗口时并排并压缩留白 */}
      <section className="relative overflow-hidden border-b border-border">
        <Breath className="-right-32 -top-24 sm:-right-16 sm:top-0 landscape:short:-top-40" />
        <Container className="relative grid min-h-[calc(100dvh-var(--ds-header-height))] items-center gap-10 py-16 sm:py-24 short:min-h-0 short:py-10 lg:grid-cols-[1.3fr_1fr]"> {/* ds-allow：高度表达式只引用变量 */}
          <div className="flex max-w-3xl flex-col gap-6">
            <Eyebrow>{t.hero.eyebrow}</Eyebrow>
            <h1 className="text-balance text-4xl font-semibold tracking-tight sm:text-5xl lg:text-6xl">{t.hero.title}</h1>
            <p className={cx("text-xl text-fg-muted", lang === "zh" ? "font-serif italic" : "")}>{t.hero.titleAlt}</p>
            <Lead className="max-w-prose">{t.hero.lead}</Lead>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <ButtonLink variant="accent" size="lg" to={localized(lang, "/download")}>{t.hero.download}</ButtonLink>
              <ButtonLink variant="secondary" size="lg" to={localized(lang, "/docs/start/install")}>{t.hero.docs}</ButtonLink>
            </div>
            <p className="flex items-center gap-2 text-sm text-fg-subtle"><StatusDot alive /> {t.hero.foot}</p>
          </div>
          <div className="hidden lg:block" aria-hidden />
        </Container>
      </section>

      {/* 生物钟 */}
      <Section>
        <Container className="grid gap-10 lg:grid-cols-[1fr_1.4fr] lg:items-start">
          <Reveal className="flex flex-col gap-4">
            <Eyebrow>{t.clock.eyebrow}</Eyebrow>
            <Heading>{t.clock.heading}</Heading>
            <Lead>{t.clock.lead}</Lead>
          </Reveal>
          <Reveal delay={1}><BodyClock t={t.clock.chart} /></Reveal>
        </Container>
      </Section>

      {/* 真实时间线 */}
      <Section tone="elevated">
        <Container className="grid gap-10 lg:grid-cols-[1fr_1.4fr]">
          <Reveal className="flex flex-col gap-4">
            <Eyebrow>{t.log.eyebrow}</Eyebrow>
            <Heading>{t.log.heading}</Heading>
            <Lead>{t.log.lead}</Lead>
          </Reveal>
          <Reveal delay={1} as="div">
            <ol className="divide-y divide-border rounded-xl border border-border bg-surface">
              {t.log.entries.map((e, i) => (
                <li key={i} className="grid grid-cols-[auto_auto_1fr] items-baseline gap-x-4 px-5 py-3 text-sm">
                  <time className="font-mono text-fg-subtle">{e.time}</time>
                  <Badge tone={kindTone[e.kind as keyof typeof kindTone]}>{t.log.kinds[e.kind as keyof typeof t.log.kinds]}</Badge>
                  <span className="text-fg-muted">{e.text}</span>
                </li>
              ))}
            </ol>
          </Reveal>
        </Container>
      </Section>

      {/* 构成 */}
      <Section>
        <Container className="flex flex-col gap-10">
          <Reveal className="flex max-w-prose flex-col gap-4">
            <Eyebrow>{t.how.eyebrow}</Eyebrow>
            <Heading>{t.how.heading}</Heading>
          </Reveal>
          <dl className="grid gap-x-10 gap-y-8 sm:grid-cols-2">
            {t.how.items.map((it, i) => (
              <Reveal key={it.name} delay={(i % 4) as 0 | 1 | 2 | 3} className="flex flex-col gap-2 border-t border-border pt-5">
                <dt className="text-lg font-medium text-fg">{it.name}</dt>
                <dd className="text-fg-muted text-pretty">{it.text}</dd>
              </Reveal>
            ))}
          </dl>
        </Container>
      </Section>

      {/* 旧手机 */}
      <Section tone="elevated">
        <Container className="grid gap-10 lg:grid-cols-[1fr_1.4fr]">
          <Reveal className="flex flex-col gap-4">
            <Eyebrow>{t.phone.eyebrow}</Eyebrow>
            <Heading>{t.phone.heading}</Heading>
            <Lead>{t.phone.lead}</Lead>
            <div><ButtonLink variant="secondary" to={localized(lang, "/docs/start/install")}>{t.phone.cta}</ButtonLink></div>
          </Reveal>
          <ol className="flex flex-col gap-4">
            {t.phone.steps.map((s, i) => (
              <Reveal key={s.title} as="li" delay={i as 0 | 1 | 2} className="grid grid-cols-[2.5rem_1fr] gap-4 rounded-xl border border-border bg-surface p-5">
                <span className="font-mono text-2xl text-secondary-fg">{String(i + 1).padStart(2, "0")}</span>
                <div className="flex flex-col gap-1">
                  <p className="font-medium text-fg">{s.title}</p>
                  <p className="text-sm text-fg-muted">{s.text}</p>
                </div>
              </Reveal>
            ))}
          </ol>
        </Container>
      </Section>

      {/* 可控 */}
      <Section>
        <Container className="flex flex-col gap-10">
          <Reveal className="flex max-w-prose flex-col gap-4">
            <Eyebrow>{t.control.eyebrow}</Eyebrow>
            <Heading>{t.control.heading}</Heading>
          </Reveal>
          <dl className="grid gap-x-10 gap-y-8 sm:grid-cols-2 lg:grid-cols-4">
            {t.control.items.map((it, i) => (
              <Reveal key={it.name} delay={(i % 4) as 0 | 1 | 2 | 3} className="flex flex-col gap-2 border-t border-border pt-5">
                <dt className="font-medium text-fg">{it.name}</dt>
                <dd className="text-sm text-fg-muted text-pretty">{it.text}</dd>
              </Reveal>
            ))}
          </dl>
        </Container>
      </Section>

      {/* 开源 */}
      <Section tone="elevated" tight>
        <Container className="flex flex-col items-start gap-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-col gap-2">
            <Eyebrow>{t.open.eyebrow}</Eyebrow>
            <Heading size="md">{t.open.heading}</Heading>
            <p className="max-w-prose text-fg-muted">{t.open.lead}</p>
          </div>
          <div className="flex shrink-0 gap-3">
            <ButtonAnchor variant="secondary" href={GITHUB_REPO} target="_blank" rel="noreferrer noopener">{t.open.source} ↗</ButtonAnchor>
            <Link to={localized(lang, "/features")} className="inline-flex h-10 items-center text-sm text-link underline-offset-4 hover:underline">{t.open.features} →</Link>
          </div>
        </Container>
      </Section>
    </>
  );
}
