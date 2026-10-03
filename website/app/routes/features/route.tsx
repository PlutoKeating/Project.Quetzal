import type { Route } from "./+types/route";
import { Link } from "react-router";
import { useMessages, isLang, DEFAULT_LANG, localized, useLang } from "~/i18n/core";
import { ButtonLink, Container, Eyebrow, Heading, Lead, Reveal, Section, cx } from "~/design-system/components";
import { messages } from "./i18n";
import { BodySenses, ClockRing, ControlPanel, PhoneSteps, SecretVault, SoulGit, WakeTimeline } from "./illustrations";

export const meta: Route.MetaFunction = ({ params }) => {
  const m = messages[isLang(params.lang) ? params.lang : DEFAULT_LANG];
  return [{ title: m.title }, { name: "description", content: m.description }];
};

export default function Features() {
  const t = useMessages(messages);
  const lang = useLang();
  type Story = (typeof t.stories)[number];
  const art = (s: Story) => {
    switch (s.id) {
      case "waking": return <WakeTimeline t={s.art as never} />;
      case "clock": return <ClockRing t={s.art as never} />;
      case "body": return <BodySenses t={s.art as never} />;
      case "soul": return <SoulGit t={s.art as never} />;
      case "secret": return <SecretVault t={s.art as never} />;
      case "control": return <ControlPanel t={s.art as never} />;
      default: return <PhoneSteps t={s.art as never} />;
    }
  };

  return (
    <>
      <Section tight className="border-b border-border">
        <Container className="flex max-w-prose flex-col gap-4">
          <Eyebrow>{t.eyebrow}</Eyebrow>
          <Heading as="h1" size="xl">{t.heading}</Heading>
          <Lead>{t.lead}</Lead>
        </Container>
      </Section>

      {t.stories.map((s, i) => (
        <Section key={s.id} tone={i % 2 ? "elevated" : "plain"} className="scroll-mt-(--ds-header-height)" id={s.id}>
          <Container className={cx("grid items-center gap-10 lg:gap-16", i % 2 ? "lg:grid-cols-[1.1fr_1fr]" : "lg:grid-cols-[1fr_1.1fr]")}> {/* ds-allow：栅格比例 */}
            <Reveal className={cx("flex flex-col gap-5", i % 2 ? "lg:order-2" : "")}>
              <Eyebrow>{s.eyebrow}</Eyebrow>
              <Heading as="h2" size="lg">{s.heading}</Heading>
              <Lead>{s.lead}</Lead>
              <ul className="flex flex-col gap-2 text-fg-muted">
                {s.points.map((p) => (
                  <li key={p} className="grid grid-cols-[0.75rem_1fr] gap-2"><span aria-hidden className="mt-2.5 inline-block size-1.5 rounded-full bg-secondary" /><span>{p}</span></li>
                ))}
              </ul>
              <Link to={localized(lang, s.link)} className="text-sm text-link underline-offset-4 hover:underline">{t.learnMore} →</Link>
            </Reveal>
            <Reveal delay={1} className={i % 2 ? "lg:order-1" : ""}>{art(s)}</Reveal>
          </Container>
        </Section>
      ))}

      <Section>
        <Container className="flex flex-col gap-8">
          <Heading size="md">{t.more.heading}</Heading>
          <ul className="grid gap-x-10 gap-y-6 sm:grid-cols-2 lg:grid-cols-3">
            {t.more.items.map((it, i) => (
              <Reveal key={it.name} as="li" delay={(i % 3) as 0 | 1 | 2} className="flex flex-col gap-1.5 border-t border-border pt-4">
                <p className="font-medium text-fg">{it.name}</p>
                <p className="text-sm text-fg-muted">{it.text}</p>
              </Reveal>
            ))}
          </ul>
        </Container>
      </Section>

      <Section tone="elevated" tight>
        <Container className="flex flex-wrap gap-3">
          <ButtonLink variant="accent" to={localized(lang, "/download")}>{t.cta.download}</ButtonLink>
          <ButtonLink variant="secondary" to={localized(lang, "/docs")}>{t.cta.docs}</ButtonLink>
        </Container>
      </Section>
    </>
  );
}
